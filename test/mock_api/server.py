#!/usr/bin/env python3
"""A strict, offline Vercel REST API replay server for the tests (stdlib only).

It serves the hand-built team in ``test/fixtures/vercel-account.json`` (documented
Vercel response shapes) and behaves like Vercel where the worker depends on it:

* **Auth.** Every request must send ``Authorization: Bearer test-token``; anything else
  gets Vercel's 403 ``{"error": {"code": "forbidden", ...}}``.
* **Team scope.** Team-scoped routes accept ``teamId=team_acme`` or ``slug=acme``. With
  neither, the request reads the (empty) personal account; any other team is a 403.
* **Strict parameters.** Each route accepts only its documented query parameters;
  anything else is a 400 ``bad_request``. ``decrypt`` is deliberately NOT accepted on
  the env route, so a worker that ever asked for values would fail loudly. The events
  route rejects ``follow=1`` (it would stream forever).
* **Paging.** Lists with a ``pagination`` object sort newest first, honour ``since`` /
  ``until`` (epoch ms, ``until`` exclusive) and cap every page at ``PAGE_CAP`` (3) items
  so paging always runs; ``pagination.next`` is the timestamp to send back as ``until``.
  ``/v3/events`` pages by ISO ``until`` and honours ``limit`` exactly.
* **Rate limits.** ``X-RateLimit-Limit/-Remaining/-Reset`` on every response; the first
  ``/v10/projects`` request answers 429 (``Retry-After: 1``) and the first ``/v4/aliases``
  request answers 503, so the retry paths always run.
* **Introspection.** ``GET /__requests?path=/v6/deployments`` returns every recorded
  request to that path (``seq``, ``path``, ``query`` as a JSON object string), so SQL
  tests can assert exactly what was pushed down. ``/__requests?prefix=/v9/projects/``
  matches by prefix.

Usage::

    python3 test/mock_api/server.py            # prints PORT:<n> once listening
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import json
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

HERE = Path(__file__).resolve().parent
DATA = json.loads((HERE.parent / "fixtures" / "vercel-account.json").read_text())
TOKEN = "test-token"
TEAM_ID, TEAM_SLUG = "team_acme", "acme"
PAGE_CAP = 3
TEAM = {"teamId", "slug"}

LOCK = threading.Lock()
REQUESTS: list[dict] = []
ONCE: set[str] = set()


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, headers: dict | None = None):
        super().__init__(message)
        self.status, self.code, self.message, self.headers = status, code, message, headers or {}


def bad(msg: str) -> ApiError:
    return ApiError(400, "bad_request", msg)


def not_found(what: str) -> ApiError:
    return ApiError(404, "not_found", f"{what} not found")


def check_params(q: dict[str, str], allowed: set[str], team: bool = True) -> None:
    ok = allowed | (TEAM if team else set())
    for k in q:
        if k not in ok:
            raise bad(f"Invalid query parameter: {k}")


def in_team(q: dict[str, str]) -> bool:
    """True when the request is scoped to the fixture team; False = personal account."""
    tid, slug = q.get("teamId"), q.get("slug")
    if tid is None and slug is None:
        return False
    if (tid is not None and tid != TEAM_ID) or (slug is not None and slug != TEAM_SLUG):
        raise ApiError(403, "forbidden", "Not authorized: you are not a member of this team")
    return True


def int_param(q: dict[str, str], key: str, lo: int | None = None, hi: int | None = None) -> int | None:
    if key not in q:
        return None
    if not re.fullmatch(r"-?\d+", q[key]):
        raise bad(f"Invalid query parameter {key}: must be an integer")
    v = int(q[key])
    if (lo is not None and v < lo) or (hi is not None and v > hi):
        raise bad(f"Invalid query parameter {key}: out of range")
    return v


def paged(items: list[dict], key: str, q: dict[str, str], ts) -> dict:
    """Vercel `pagination` paging: newest first, since < t < until, capped pages."""
    limit = int_param(q, "limit", 1, 100) or 20
    since, until = int_param(q, "since"), int_param(q, "until")
    rows = sorted(items, key=ts, reverse=True)
    rows = [r for r in rows if (since is None or ts(r) > since) and (until is None or ts(r) < until)]
    n = min(limit, PAGE_CAP)
    page, rest = rows[:n], rows[n:]
    nxt = ts(page[-1]) if rest and page else None
    prev = ts(page[0]) if page else None
    return {key: page, "pagination": {"count": len(page), "next": nxt, "prev": prev}}


def project_by(id_or_name: str) -> dict:
    for p in DATA["projects"]:
        if id_or_name in (p["id"], p["name"]):
            return p
    raise not_found("Project")


def deployment_by(id_or_url: str) -> dict:
    for d in DATA["deployments"]:
        if id_or_url in (d["uid"], d["url"]):
            return d
    raise not_found("Deployment")


# --------------------------------------------------------------------------- routes


def r_teams(q, _m):
    check_params(q, {"limit", "since", "until"}, team=False)
    return paged(DATA["teams"], "teams", q, lambda t: t["createdAt"])


def r_projects(q, _m):
    check_params(q, {"limit", "until", "since", "search", "repo", "repoId", "repoUrl", "gitForkProtection"})
    if "429" not in ONCE:
        ONCE.add("429")
        raise ApiError(429, "rate_limited", "Rate limit exceeded", {
            "Retry-After": "1",
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": str(int(time.time()) + 1),
        })
    items = DATA["projects"] if in_team(q) else []
    if "search" in q:
        items = [p for p in items if q["search"].lower() in p["name"].lower()]
    return paged(items, "projects", q, lambda p: p["updatedAt"])


def r_project(q, m):
    check_params(q, set())
    if not in_team(q):
        raise not_found("Project")
    return project_by(unquote(m[1]))


STATES = {"BUILDING", "ERROR", "INITIALIZING", "QUEUED", "READY", "CANCELED"}


def r_deployments(q, _m):
    check_params(
        q, {"limit", "projectId", "app", "target", "state", "branch", "sha", "users", "since", "until", "rollbackCandidate"}
    )
    items = DATA["deployments"] if in_team(q) else []
    if "projectId" in q:
        items = [d for d in items if d["projectId"] == q["projectId"]]
    if "app" in q:
        items = [d for d in items if d["name"] == q["app"]]
    if "target" in q:
        if q["target"] not in ("production", "preview"):
            raise bad("Invalid query parameter target: must be production or preview")
        items = [d for d in items if (d["target"] == "production") == (q["target"] == "production")]
    if "state" in q:
        want = set(q["state"].split(","))
        if not want <= STATES:
            raise bad(f"Invalid query parameter state: {q['state']}")
        items = [d for d in items if d["readyState"] in want]
    meta = lambda d, k: next((v for p, v in d["meta"].items() if p.endswith(k)), None)  # noqa: E731
    if "branch" in q:
        items = [d for d in items if meta(d, "CommitRef") == q["branch"]]
    if "sha" in q:
        items = [d for d in items if meta(d, "CommitSha") == q["sha"]]
    if "users" in q:
        users = set(q["users"].split(","))
        items = [d for d in items if d["creator"]["uid"] in users]
    return paged(items, "deployments", q, lambda d: d["createdAt"])


def r_deployment(q, m):
    check_params(q, {"withGitRepoInfo"})
    if not in_team(q):
        raise not_found("Deployment")
    d = deployment_by(unquote(m[1]))
    out = {**d, "id": d["uid"], **DATA["deployment_details"].get(d["uid"], {})}
    out.pop("uid", None)
    return out


def r_events(q, m):
    check_params(q, {"builds", "direction", "follow", "limit", "name", "since", "until", "statusCode", "delimiter"})
    if q.get("follow", "1") != "0":
        raise bad("follow=1 streams; the replay server only serves follow=0")
    if not in_team(q):
        raise not_found("Deployment")
    d = deployment_by(unquote(m[1]))
    evs = DATA["events"].get(d["uid"], [])
    limit = int_param(q, "limit")
    return evs if limit in (None, -1) else evs[:limit]


def r_checks(q, m):
    check_params(q, set())
    if not in_team(q):
        raise not_found("Deployment")
    d = deployment_by(unquote(m[1]))
    return {"checks": DATA["checks"].get(d["uid"], [])}


def r_aliases(q, _m):
    check_params(q, {"limit", "projectId", "since", "until", "domain", "from", "rollbackDeploymentId"})
    if "503" not in ONCE:
        ONCE.add("503")
        raise ApiError(503, "internal_server_error", "Service temporarily unavailable")
    items = DATA["aliases"] if in_team(q) else []
    if "projectId" in q:
        items = [a for a in items if a["projectId"] == q["projectId"]]
    return paged(items, "aliases", q, lambda a: a["createdAt"])


def r_project_domains(q, m):
    check_params(q, {"limit", "since", "until", "production", "target", "gitBranch", "redirects", "redirect", "verified", "order"})
    if not in_team(q):
        raise not_found("Project")
    p = project_by(unquote(m[1]))
    return paged(DATA["project_domains"].get(p["id"], []), "domains", q, lambda d: d["createdAt"])


def r_domains(q, _m):
    check_params(q, {"limit", "since", "until"})
    items = DATA["account_domains"] if in_team(q) else []
    return paged(items, "domains", q, lambda d: d["createdAt"])


def r_domain(q, m):
    check_params(q, set())
    name = unquote(m[1])
    for d in DATA["account_domains"] if in_team(q) else []:
        if d["name"] == name:
            return {"domain": d}
    raise not_found("Domain")


def r_records(q, m):
    check_params(q, {"limit", "since", "until"})
    name = unquote(m[1])
    if not in_team(q) or name not in DATA["dns_records"]:
        raise not_found("Domain")
    return paged(DATA["dns_records"][name], "records", q, lambda r: r["createdAt"])


def r_domain_config(q, m):
    check_params(q, {"strict", "projectIdOrName"})
    name = unquote(m[1])
    if not in_team(q) or name not in DATA["domain_config"]:
        raise not_found("Domain")
    return DATA["domain_config"][name]


def r_env(q, m):
    # `decrypt` is documented upstream but intentionally rejected here: the worker must never ask for values.
    check_params(q, {"gitBranch", "source", "customEnvironmentId", "customEnvironmentSlug"})
    if not in_team(q):
        raise not_found("Project")
    p = project_by(unquote(m[1]))
    return {"envs": DATA["envs"].get(p["id"], [])}


def r_edge(q, _m):
    check_params(q, set())
    return DATA["edge_configs"] if in_team(q) else []


def r_integrations(q, _m):
    check_params(q, {"view", "installationType", "integrationIdOrSlug"})
    if q.get("view") not in ("account", "project"):
        raise bad("Invalid query parameter view: must be account or project")
    return DATA["integrations"] if in_team(q) else []


def r_members(q, m):
    check_params(q, {"limit", "since", "until", "search", "role", "excludeProject", "eligibleMembersForProjectId"}, team=False)
    if unquote(m[1]) != TEAM_ID:
        raise ApiError(403, "forbidden", "Not authorized: you are not a member of this team")
    items = DATA["members"]
    if "role" in q:
        if q["role"] not in {"OWNER", "MEMBER", "DEVELOPER", "SECURITY", "BILLING", "VIEWER", "VIEWER_FOR_PLUS", "CONTRIBUTOR"}:
            raise bad(f"Invalid query parameter role: {q['role']}")
        items = [x for x in items if x["role"] == q["role"]]
    out = paged(items, "members", q, lambda x: x["createdAt"])
    out["pagination"]["hasNext"] = out["pagination"]["next"] is not None
    return out


def iso_ms(v: str, key: str) -> int:
    try:
        return int(dt.datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        raise bad(f"Invalid query parameter {key}: must be an ISO 8601 date") from None


def r_events_v3(q, _m):
    check_params(q, {"limit", "since", "until", "types", "userId", "principalId", "projectIds", "withPayload"})
    items = DATA["activity"] if in_team(q) else []
    limit = int_param(q, "limit", 1, 100) or 20
    since = iso_ms(q["since"], "since") if "since" in q else None
    until = iso_ms(q["until"], "until") if "until" in q else None
    if "types" in q:
        items = [e for e in items if e["type"] in set(q["types"].split(","))]
    if "userId" in q:
        items = [e for e in items if e["userId"] == q["userId"]]
    items = sorted(items, key=lambda e: e["createdAt"], reverse=True)
    items = [e for e in items if (since is None or e["createdAt"] >= since) and (until is None or e["createdAt"] < until)]
    return {"events": items[:limit]}


def r_firewall(q, _m):
    check_params(q, {"projectId"})
    if "projectId" not in q:
        raise bad("Missing required query parameter projectId")
    if not in_team(q) or q["projectId"] not in DATA["firewall"]:
        raise not_found("Firewall config")
    return DATA["firewall"][q["projectId"]]


ROUTES = [
    (r"/v2/teams", r_teams),
    (r"/v2/teams/([^/]+)/members", r_members),
    (r"/v10/projects", r_projects),
    (r"/v9/projects/([^/]+)", r_project),
    (r"/v9/projects/([^/]+)/domains", r_project_domains),
    (r"/v10/projects/([^/]+)/env", r_env),
    (r"/v6/deployments", r_deployments),
    (r"/v13/deployments/([^/]+)", r_deployment),
    (r"/v3/deployments/([^/]+)/events", r_events),
    (r"/v1/deployments/([^/]+)/checks", r_checks),
    (r"/v4/aliases", r_aliases),
    (r"/v5/domains", r_domains),
    (r"/v5/domains/([^/]+)", r_domain),
    (r"/v4/domains/([^/]+)/records", r_records),
    (r"/v6/domains/([^/]+)/config", r_domain_config),
    (r"/v1/edge-config", r_edge),
    (r"/v1/integrations/configurations", r_integrations),
    (r"/v3/events", r_events_v3),
    (r"/v1/security/firewall/config/active", r_firewall),
]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: object) -> None:
        sys.stderr.write("mock: " + fmt % args + "\n")

    def send(self, status: int, body: object, headers: dict | None = None) -> None:
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        hdrs = {"X-RateLimit-Limit": "100", "X-RateLimit-Remaining": "99", "X-RateLimit-Reset": str(int(time.time()) + 60)}
        hdrs.update(headers or {})
        for k, v in hdrs.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        u = urlparse(self.path)
        multi = parse_qs(u.query, keep_blank_values=True)
        q = {k: v[-1] for k, v in multi.items()}
        if u.path == "/health":
            return self.send(200, {"status": "ok"})
        if u.path == "/__requests":
            with LOCK:
                rows = [
                    r
                    for r in REQUESTS
                    if ("path" in q and r["path"] == q["path"]) or ("prefix" in q and r["path"].startswith(q["prefix"]))
                ]
            return self.send(200, rows or [{"seq": 0, "path": "", "query": "{}"}])
        with LOCK:
            REQUESTS.append({"seq": len(REQUESTS) + 1, "path": u.path, "query": json.dumps(q, sort_keys=True)})
        try:
            if any(len(v) > 1 for v in multi.values()):
                raise bad("Duplicate query parameter")
            if self.headers.get("Authorization") != f"Bearer {TOKEN}":
                raise ApiError(403, "forbidden", "Not authorized: invalid token")
            for pattern, fn in ROUTES:
                m = re.fullmatch(pattern, u.path)
                if m:
                    return self.send(200, fn(q, m))
            raise not_found("Route")
        except ApiError as e:
            self.send(e.status, {"error": {"code": e.code, "message": e.message}}, e.headers)

    def do_POST(self) -> None:  # noqa: N802
        self.send(405, {"error": {"code": "method_not_allowed", "message": "the replay server is read-only"}})

    do_PUT = do_PATCH = do_DELETE = do_POST  # noqa: N815


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--port", type=int, default=0)
    args = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"PORT:{srv.server_address[1]}", flush=True)
    with contextlib.suppress(KeyboardInterrupt):
        srv.serve_forever()


if __name__ == "__main__":
    main()
