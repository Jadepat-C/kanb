#!/usr/bin/env python3
"""
Permission tests for the Kanb API: every endpoint, called by people with different access to one board.

    KANB_URL=http://localhost:8080 ADMIN_USER=admin ADMIN_PASSWORD=... python3 tests/authz.py

Needs a running server and a super admin. It creates its own users (authz_<random>_…) and boards, and deletes
all of them at the end. Standard library only, so it runs anywhere Python 3.9+ does.

    KEEP=1 …        keep the test users and boards afterwards (e.g. while a scanner replays the recorded traffic)
    … --cleanup     only delete every leftover authz_ user, their boards and test board templates

For each endpoint the people are, from least to most access:
    anon (not signed in) < outsider (signed in, not on the board) < viewer < commenter < editor < owner
The test expects every person below the endpoint's minimum to be refused (401/403/404) and everyone from the
minimum up to succeed (2xx). The second half is the control: if test data were broken, refusals would pass for the
wrong reason. Destructive calls get a fresh throwaway item each time. Afterwards it also checks a set of
cross-board tricks (using one board's IDs from another board), and that refused calls changed nothing.
"""

import http.client
import http.cookiejar
import json
import os
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

BASE = os.environ.get("KANB_URL", "http://localhost:8080").rstrip("/")
ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
ROLES = ["anon", "outsider", "viewer", "commenter", "editor", "owner"]
RUN = secrets.token_hex(3)
PASSWORDS: list = []  # every password the test sets, to check none ends up in the activity log
VERBOSE = os.environ.get("VERBOSE") == "1"


# ---------------------------------------------------------------- HTTP

class Client:
    def __init__(self, name: str):
        self.name = name
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.id: Optional[str] = None

    def call(self, method: str, path: str, body: Any = None, raw: Optional[bytes] = None, ctype: Optional[str] = None):
        data, headers = None, {"Origin": BASE}
        if raw is not None:
            data, headers["Content-Type"] = raw, ctype or "application/octet-stream"
        elif body is not None or method not in ("GET", "DELETE"):
            data, headers["Content-Type"] = json.dumps(body if body is not None else {}).encode(), "application/json"
        req = urllib.request.Request(BASE + "/api" + path, data=data, method=method, headers=headers)
        try:
            with self.opener.open(req, timeout=30) as r:
                return r.status, parse(r.read())
        except urllib.error.HTTPError as e:
            return e.code, parse(e.read())

    def ok(self, method: str, path: str, body: Any = None, **kw):
        status, data = self.call(method, path, body, **kw)
        if not 200 <= status < 300:
            raise SystemExit(f"setup failed: {self.name} {method} {path} -> {status} {data}")
        return data

    def upload(self, path: str, filename: str, content: bytes, ctype: str = "text/plain"):
        boundary = "authz" + secrets.token_hex(8)
        raw = (
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
            f"Content-Type: {ctype}\r\n\r\n"
        ).encode() + content + f"\r\n--{boundary}--\r\n".encode()
        return self.call("POST", path, raw=raw, ctype=f"multipart/form-data; boundary={boundary}")

    def websocket(self, path: str) -> int:
        """Status of a WebSocket upgrade (101 = connected)."""
        u = urllib.parse.urlparse(BASE)
        conn = (http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection)(u.hostname, u.port, timeout=10)
        cookies = "; ".join(f"{c.name}={c.value}" for c in self.jar)
        headers = {"Origin": BASE, "Connection": "Upgrade", "Upgrade": "websocket", "Sec-WebSocket-Version": "13",
                   "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ=="}
        if cookies:
            headers["Cookie"] = cookies
        conn.request("GET", "/api" + path, headers=headers)
        status = conn.getresponse().status
        conn.close()
        return status


def parse(b: bytes):
    try:
        return json.loads(b) if b else None
    except ValueError:
        return b[:200]


# ---------------------------------------------------------------- fixtures

def login(name: str, password: str) -> Client:
    c = Client(name)
    c.ok("POST", "/auth/login", {"username": name, "password": password})
    c.id = c.ok("GET", "/me")["id"]
    return c


def make_user(admin: Client, role: str) -> Client:
    username = f"authz_{RUN}_{role}"
    first = "Temp" + secrets.token_hex(6)
    admin.ok("POST", "/admin/users", {"username": username, "display_name": f"authz {role}", "email": None, "password": first,
                                      "is_super_admin": False, "can_create_boards": True, "locale": "en", "send_invite": False})
    c = Client(username)
    c.ok("POST", "/auth/login", {"username": username, "password": first})
    final = "Authz-" + secrets.token_hex(8)
    PASSWORDS.extend([first, final])
    c.ok("POST", "/me/password", {"current_password": first, "new_password": final})  # admin-set passwords must be changed first
    return login(username, final)


@dataclass
class World:
    admin: Client
    people: dict  # role name -> Client (anon has no session)
    extra: Client  # a sixth person, used for adding/removing members
    f: dict = field(default_factory=dict)  # fixture ids


def build_world() -> World:
    if not ADMIN_PASSWORD:
        raise SystemExit("set ADMIN_PASSWORD (and ADMIN_USER) for a super admin")
    admin = login(ADMIN_USER, ADMIN_PASSWORD)
    people = {"anon": Client("anon")}
    for r in ROLES[1:]:
        people[r] = make_user(admin, r)
    w = World(admin, people, make_user(admin, "extra"))
    o, f = people["owner"], w.f

    f["board"] = o.ok("POST", "/boards", {"name": f"authz {RUN}", "description": "", "lists": ["One", "Two"]})["id"]
    b = o.ok("GET", f"/boards/{f['board']}")
    f["list"], f["list2"] = b["lists"][0]["id"], b["lists"][1]["id"]
    f["status"] = b["statuses"][0]["id"]
    roles = {r["name"]: r["id"] for r in b["roles"]}
    f["role_viewer"], f["role_editor"] = roles["Viewer"], roles["Editor"]
    for person, role in (("viewer", "Viewer"), ("commenter", "Commenter"), ("editor", "Editor")):
        o.ok("POST", f"/boards/{f['board']}/members", {"user_id": people[person].id, "role_id": roles[role]})
    f["label"] = o.ok("POST", f"/boards/{f['board']}/labels", {"name": "authz", "color": "#ff0000"})["id"]
    f["secret_title"] = f"authz secret {RUN}"
    f["card"] = o.ok("POST", f"/lists/{f['list']}/cards", {"title": f["secret_title"], "description": "top secret"})["id"]
    f["card2"] = o.ok("POST", f"/lists/{f['list']}/cards", {"title": "second", "description": ""})["id"]
    o.ok("PUT", f"/cards/{f['card']}/labels", {"ids": [f["label"]]})
    o.ok("PATCH", f"/cards/{f['card']}", {"due_at": "2030-01-15T09:00:00Z"})
    o.ok("PUT", f"/cards/{f['card2']}/dependencies", {"ids": [f["card"]]})
    f["comment"] = o.ok("POST", f"/cards/{f['card']}/comments", {"body": "owner's comment"})["id"]
    status, att = o.upload(f"/cards/{f['card']}/attachments", "secret.txt", b"secret file")
    assert status == 200, att
    f["file"] = att["id"]
    f["template"] = o.ok("POST", f"/boards/{f['board']}/templates", {"name": "tpl", "title": "From template", "description": ""})["id"]
    f["recurrence"] = o.ok("POST", f"/boards/{f['board']}/recurrences",
                           {"template_id": f["template"], "list_id": f["list"], "freq": "weekly", "every": 1, "weekdays": [1], "at_time": "09:00", "enabled": False})["id"]
    f["board_contact"] = o.ok("POST", f"/boards/{f['board']}/contact-points",
                              {"kind": "webhook", "name": "team", "config": {"url": "https://example.com/authz"}, "enabled": False})["id"]
    f["my_contact"] = o.ok("POST", "/me/contact-points", {"kind": "webhook", "name": "mine", "config": {"url": "https://example.com/mine"}, "enabled": False})["id"]
    f["board_template"] = o.ok("POST", "/board-templates", {"name": f"authz bt {RUN}", "data": {"lists": [{"name": "A"}], "statuses": [], "labels": [], "card_templates": [], "cards": []}})["id"]

    # the outsider's own board, to try mixing its ids with the owner's
    x = people["outsider"]
    f["x_board"] = x.ok("POST", "/boards", {"name": f"authz outsider {RUN}", "description": "", "lists": ["Mine"]})["id"]
    xb = x.ok("GET", f"/boards/{f['x_board']}")
    f["x_list"], f["x_status"] = xb["lists"][0]["id"], xb["statuses"][0]["id"]
    f["x_card"] = x.ok("POST", f"/lists/{f['x_list']}/cards", {"title": "outsider card", "description": ""})["id"]
    return w


# fresh throwaway items for destructive calls (made by the owner)
def fresh(w: World, kind: str) -> dict:
    o, f = w.people["owner"], w.f
    if kind == "card":
        return {"card": o.ok("POST", f"/lists/{f['list']}/cards", {"title": "throwaway", "description": ""})["id"]}
    if kind == "archived_card":
        c = fresh(w, "card")["card"]
        o.ok("DELETE", f"/cards/{c}")
        return {"card": c}
    if kind == "list":
        return {"list": o.ok("POST", f"/boards/{f['board']}/lists", {"name": "throwaway"})["id"]}
    if kind == "archived_list":
        lst = fresh(w, "list")["list"]
        o.ok("POST", f"/lists/{lst}/archive")
        return {"list": lst}
    if kind == "label":
        return {"label": o.ok("POST", f"/boards/{f['board']}/labels", {"name": "throwaway", "color": "#00ff00"})["id"]}
    if kind == "status":
        return {"status": o.ok("POST", f"/boards/{f['board']}/statuses", {"name": "throwaway", "color": "#0000ff"})["id"]}
    if kind == "role":
        return {"role": o.ok("POST", f"/boards/{f['board']}/roles", {"name": "throwaway" + secrets.token_hex(2), "permissions": []})["id"]}
    if kind == "comment":
        return {"comment": o.ok("POST", f"/cards/{f['card']}/comments", {"body": "throwaway"})["id"]}
    if kind == "file":
        status, a = o.upload(f"/cards/{f['card']}/attachments", "throwaway.txt", b"x")
        return {"file": a["id"]}
    if kind == "template":
        return {"template": o.ok("POST", f"/boards/{f['board']}/templates", {"name": "throwaway", "title": "t", "description": ""})["id"]}
    if kind == "recurrence":
        return {"recurrence": o.ok("POST", f"/boards/{f['board']}/recurrences", {"template_id": f["template"], "list_id": f["list"], "freq": "daily", "every": 1, "at_time": "09:00", "enabled": False})["id"]}
    if kind == "board_contact":
        return {"board_contact": o.ok("POST", f"/boards/{f['board']}/contact-points", {"kind": "webhook", "name": "t", "config": {"url": "https://example.com/t"}, "enabled": False})["id"]}
    if kind in ("tuser", "session"):  # a throwaway signed-in account (signing it out must not touch the test's people)
        u = make_user(w.admin, "t" + secrets.token_hex(2))
        if kind == "tuser":
            return {"tuser": u.id}
        return {"session": w.admin.ok("GET", f"/admin/users/{u.id}/sessions")[0]["id"]}
    if kind == "member":  # the extra person on the board, to be changed or removed
        o.call("DELETE", f"/boards/{f['board']}/members/{w.extra.id}")
        o.ok("POST", f"/boards/{f['board']}/members", {"user_id": w.extra.id, "role_id": f["role_viewer"]})
        return {"member": w.extra.id}
    if kind == "board":  # a whole board with the same people on it
        bid = o.ok("POST", "/boards", {"name": "authz throwaway", "description": ""})["id"]
        roles = {r["name"]: r["id"] for r in o.ok("GET", f"/boards/{bid}")["roles"]}
        for person, role in (("viewer", "Viewer"), ("commenter", "Commenter"), ("editor", "Editor")):
            o.ok("POST", f"/boards/{bid}/members", {"user_id": w.people[person].id, "role_id": roles[role]})
        return {"board": bid}
    if kind == "archived_board":
        bid = fresh(w, "board")["board"]
        o.ok("DELETE", f"/boards/{bid}")
        return {"board": bid}
    raise ValueError(kind)


# ---------------------------------------------------------------- cases

@dataclass
class Case:
    method: str
    path: str  # with {name} placeholders filled from fixtures
    min_role: str  # first role that is allowed; "admin" = super admins only; "none" = nobody (cross-board tricks)
    body: Any = None
    fresh: Optional[str] = None
    upload: bool = False
    note: str = ""


B = "/boards/{board}"
CASES = [
    # boards
    Case("GET", B, "viewer"),
    Case("PATCH", B, "owner", {"description": "changed"}),
    Case("DELETE", B, "owner", fresh="board", note="archive board"),
    Case("POST", B + "/restore", "owner", fresh="archived_board"),
    Case("DELETE", B + "/permanent", "owner", fresh="board"),
    Case("GET", B + "/archived-cards", "viewer"),
    Case("GET", B + "/archived-lists", "viewer"),
    Case("GET", B + "/export?format=json", "viewer"),
    Case("GET", B + "/export?format=zip", "viewer"),
    Case("POST", B + "/save-as-template", "viewer", {"name": "authz copy " + RUN, "include_cards": False}, note="any board member may copy a board's setup into a new template"),
    # lists
    Case("POST", B + "/lists", "owner", {"name": "new"}),
    Case("PATCH", "/lists/{list}", "owner", {"name": "renamed"}),
    Case("DELETE", "/lists/{list}", "owner", fresh="list"),
    Case("POST", "/lists/{list}/archive", "owner", fresh="list"),
    Case("POST", "/lists/{list}/restore", "owner", fresh="archived_list"),
    Case("POST", "/lists/{list}/sort", "editor", {"by": "title", "desc": False}),
    # labels, statuses, roles, members
    Case("POST", B + "/labels", "editor", {"name": "l", "color": "#123456"}),
    Case("PATCH", "/labels/{label}", "editor", {"name": "l2"}, fresh="label"),
    Case("DELETE", "/labels/{label}", "editor", fresh="label"),
    Case("POST", B + "/statuses", "owner", {"name": "s", "color": "#123456"}),
    Case("PATCH", "/statuses/{status}", "owner", {"name": "s2"}, fresh="status"),
    Case("DELETE", "/statuses/{status}", "owner", fresh="status"),
    Case("POST", B + "/roles", "owner", {"name": "r", "permissions": []}),
    Case("PATCH", "/roles/{role}", "owner", {"name": "r2"}, fresh="role"),
    Case("DELETE", "/roles/{role}", "owner", fresh="role"),
    Case("POST", B + "/members", "owner", {"user_id": "{extra_id}", "role_id": "{role_viewer}"}, fresh="member", note="re-adding is a conflict for allowed roles; the deny half is what matters"),
    Case("PATCH", B + "/members/{member}", "owner", {"role_id": "{role_editor}"}, fresh="member"),
    Case("DELETE", B + "/members/{member}", "owner", fresh="member"),
    # cards
    Case("POST", "/lists/{list}/cards", "editor", {"title": "made", "description": ""}),
    Case("GET", "/cards/{card}", "viewer"),
    Case("PATCH", "/cards/{card}", "editor", {"title": "{secret_title}"}),
    Case("PATCH", "/cards/{card}", "editor", {"due_at": "2030-01-16T09:00:00Z"}, note="dates"),
    Case("PATCH", "/cards/{card}", "editor", {"status_id": "{status}"}, note="status"),
    Case("PATCH", "/cards/{card}", "editor", {"remind_minutes": 60}, note="due reminder"),
    Case("POST", "/cards/{card}/move", "editor", {"list_id": "{list}", "index": 0}),
    Case("POST", "/cards/{card}/duplicate", "editor"),
    Case("DELETE", "/cards/{card}", "editor", fresh="card", note="archive card"),
    Case("POST", "/cards/{card}/restore", "editor", fresh="archived_card"),
    Case("DELETE", "/cards/{card}/permanent", "editor", fresh="card"),
    Case("PUT", "/cards/{card}/labels", "editor", {"ids": ["{label}"]}),
    Case("PUT", "/cards/{card}/assignees", "editor", {"ids": []}),
    Case("PUT", "/cards/{card2}/dependencies", "editor", {"ids": ["{card}"]}),
    Case("GET", "/cards/{card}/timeline", "viewer"),
    Case("PUT", "/cards/{card}/calendar", "viewer", {"on": False}, note="add to my own calendar feed"),
    Case("POST", "/cards/{card}/save-template", "editor", {"name": "saved"}),
    # comments and files
    Case("POST", "/cards/{card}/comments", "commenter", {"body": "hi"}),
    Case("PATCH", "/comments/{comment}", "owner", {"body": "edited"}, note="only the author may edit; the owner wrote it"),
    Case("DELETE", "/comments/{comment}", "owner", fresh="comment", note="moderators, or the author"),
    Case("POST", "/cards/{card}/attachments", "editor", upload=True),
    Case("GET", "/files/{file}", "viewer"),
    Case("DELETE", "/attachments/{file}", "editor", fresh="file"),
    # templates, recurring, channels
    Case("POST", B + "/templates", "editor", {"name": "t", "title": "t", "description": ""}),
    Case("PATCH", "/templates/{template}", "editor", {"name": "t2"}, fresh="template"),
    Case("DELETE", "/templates/{template}", "editor", fresh="template"),
    Case("GET", B + "/recurrences", "viewer"),
    Case("POST", B + "/recurrences", "editor", {"template_id": "{template}", "list_id": "{list}", "freq": "daily", "every": 1, "at_time": "08:00", "enabled": False}),
    Case("PATCH", "/recurrences/{recurrence}", "editor", {"every": 2}, fresh="recurrence"),
    Case("DELETE", "/recurrences/{recurrence}", "editor", fresh="recurrence"),
    Case("GET", B + "/contact-points", "owner"),
    Case("POST", B + "/contact-points", "owner", {"kind": "webhook", "name": "x", "config": {"url": "https://example.com/x"}, "enabled": False}),
    Case("PATCH", "/board-contact-points/{board_contact}", "owner", {"name": "y"}, fresh="board_contact"),
    Case("DELETE", "/board-contact-points/{board_contact}", "owner", fresh="board_contact"),
    # public link settings
    Case("GET", B + "/share", "owner"),
    Case("PUT", B + "/share", "owner", {"enabled": False}),
    # my own notifications
    Case("POST", "/notifications/clear", "outsider", {"ids": []}),
    Case("PATCH", "/me", "outsider", {"notify_email": True}),
    # board templates: anyone who can create boards may add one; only the author (or a super admin) may change it
    Case("PATCH", "/board-templates/{board_template}", "owner", {"name": "authz bt renamed " + RUN}),
    # super admin only
    Case("GET", "/admin/users", "admin"),
    Case("GET", "/admin/email", "admin"),
    Case("GET", "/admin/notifications", "admin"),
    Case("GET", "/admin/storage", "admin"),
    Case("GET", "/admin/security", "admin"),
    Case("GET", "/admin/audit", "admin"),
    Case("GET", "/admin/audit?topic=failed", "admin"),
    Case("GET", "/admin/users/{extra_id}/sessions", "admin"),
    Case("DELETE", "/admin/users/{tuser}/sessions", "admin", fresh="tuser"),
    Case("DELETE", "/admin/sessions/{session}", "admin", fresh="session"),
    Case("GET", "/admin/boards", "admin"),
    Case("POST", "/admin/boards/{board}/owners", "admin", {"user_id": "{extra_id}"}, fresh="board"),
    Case("GET", "/admin/system", "admin"),
    Case("GET", "/admin/announcement", "admin"),
    Case("PUT", "/admin/announcement", "admin", {"text": "", "level": "info"}),
    Case("GET", "/announcement", "outsider"),
    Case("GET", "/me/sessions", "outsider"),
    Case("DELETE", "/me/sessions", "outsider", note="sign out my other devices"),
    Case("DELETE", "/me/sessions/{session}", "none", fresh="session", note="someone else's device from my profile"),
    Case("PUT", "/admin/security", "admin", {"require_2fa": False}),
    Case("GET", "/admin/users/{extra_id}/delete-preview", "admin"),
    Case("PATCH", "/admin/users/{extra_id}", "admin", {"display_name": "authz extra"}),
    Case("POST", "/admin/users", "admin", {"username": "authz_" + RUN + "_nope", "display_name": "", "password": "Nope-12345678", "is_super_admin": True, "can_create_boards": True, "send_invite": False}),
    Case("DELETE", "/admin/users/{extra_id}/2fa", "admin"),
    # cross-board tricks: nobody may do these
    Case("POST", "/cards/{x_card}/move", "none", {"list_id": "{list}", "index": 0}, note="move your card into a board you can't see"),
    Case("PUT", "/cards/{x_card}/dependencies", "none", {"ids": ["{card}"]}, note="depend on a card you can't see"),
    Case("POST", "/templates/{template}/copy", "none", {"board_id": "{x_board}"}, note="copy a template out of a board you can't see"),
    Case("POST", "/boards/{x_board}/recurrences", "none", {"template_id": "{template}", "list_id": "{x_list}", "freq": "daily", "every": 1, "at_time": "09:00"}, note="schedule from someone else's template"),
    Case("PATCH", "/me/contact-points/{my_contact}", "none", {"name": "hijacked"}, note="edit someone else's personal channel"),
    Case("PATCH", "/cards/{card}", "none", {"status_id": "{x_status}"}, note="give a card a status from another board"),
]


def fill(v: Any, f: dict) -> Any:
    if isinstance(v, str):
        for k, val in f.items():
            if isinstance(val, str):
                v = v.replace("{" + k + "}", val)
        return v
    if isinstance(v, list):
        return [fill(x, f) for x in v]
    if isinstance(v, dict):
        return {k: fill(x, f) for k, x in v.items()}
    return v


def attempt(w: World, who: str, case: Case, f: dict):
    c = w.admin if who == "admin" else w.people[who]
    path = fill(case.path, f)
    if case.upload:
        return c.upload(path, "upload.txt", b"hello")
    return c.call(case.method, path, fill(case.body, f))


def allowed(role: str, case: Case) -> bool:
    if case.min_role in ("admin", "none"):
        return False
    return ROLES.index(role) >= ROLES.index(case.min_role)


def denied(status: int, case: Case) -> bool:
    # cross-board tricks may also be refused as invalid input (400): the other board's id is simply not accepted
    return status in (401, 403, 404) or (case.min_role == "none" and status == 400)


# ---------------------------------------------------------------- run

def board_snapshot(w: World) -> str:
    o, f = w.people["owner"], w.f
    b = o.ok("GET", f"/boards/{f['board']}")
    keep = {
        "board": {k: b["board"].get(k) for k in ("name", "description", "color")},
        # the throwaway items the test itself makes are left out
        "lists": sorted((l["id"], l["name"]) for l in b["lists"] if l["name"] != "throwaway"),
        "labels": sorted((l["id"], l["name"]) for l in b["labels"] if l["name"] != "throwaway"),
        "members": sorted((m["user_id"], m.get("role_id")) for m in b["members"] if m["user_id"] != w.extra.id),
        "card": {k: next(c for c in b["cards"] if c["id"] == f["card"]).get(k) for k in ("title", "list_id", "status_id", "label_ids", "due_at")},
    }
    return json.dumps(keep, sort_keys=True)


def main() -> int:
    print(f"Kanb permission tests against {BASE} (run {RUN})")
    w = build_world()
    f = dict(w.f, extra_id=w.extra.id, secret_title=w.f["secret_title"])
    problems, notes, checked = [], [], 0

    try:
        before = board_snapshot(w)
        # 1. refusals: everyone below the minimum, on shared or one-per-case throwaway items
        for case in CASES:
            ff = dict(f, **fresh(w, case.fresh)) if case.fresh else f
            who_list = ["outsider"] if case.min_role == "none" else ROLES
            for who in who_list:
                if allowed(who, case):
                    continue
                status, data = attempt(w, who, case, ff)
                checked += 1
                label = f"{case.method} {case.path}{' (' + case.note + ')' if case.note else ''} as {who}"
                if who == "anon" and status != 401:
                    problems.append(f"{label}: expected 401, got {status} {data}")
                elif not denied(status, case):
                    (notes if 400 <= status < 500 else problems).append(f"{label}: expected refusal, got {status} {data}")
                elif VERBOSE:
                    print(f"  ok  {label} -> {status}")
        after = board_snapshot(w)
        if before != after:
            problems.append(f"refused calls changed the board:\n    before {before}\n    after  {after}")

        # 2. controls: the minimum role and above must succeed (fresh throwaway item for every call)
        for case in CASES:
            roles = ["admin"] if case.min_role == "admin" else [r for r in ROLES if allowed(r, case)]
            for who in roles:
                ff = dict(f, **fresh(w, case.fresh)) if case.fresh else f
                status, data = attempt(w, who, case, ff)
                checked += 1
                label = f"{case.method} {case.path}{' (' + case.note + ')' if case.note else ''} as {who}"
                if not 200 <= status < 300:
                    if case.path.endswith("/members") and status == 409:
                        continue  # already a member: fine for the control
                    problems.append(f"{label}: expected success (control), got {status} {data}")

        # 3. leaks through lists and search
        x = w.people["outsider"]
        _, res = x.call("GET", "/search?q=" + urllib.parse.quote(f["secret_title"]))
        if f["secret_title"] in json.dumps(res):
            problems.append("search shows the outsider a card from a board they can't see")
        _, cal = x.call("GET", "/calendar?from=2030-01-01T00:00:00Z&to=2030-02-01T00:00:00Z")
        if f["secret_title"] in json.dumps(cal):
            problems.append("the global calendar shows the outsider a card from a board they can't see")
        _, boards = x.call("GET", "/boards")
        if any(b["id"] == f["board"] for b in boards or []):
            problems.append("the outsider's board list includes a board they're not on")
        _, tpls = x.call("GET", "/card-templates")
        if f["template"] in json.dumps(tpls):
            problems.append("the outsider's card-template list includes another board's template")
        _, xb = x.call("GET", f"/boards/{f['x_board']}")
        if any(c["id"] == f["card"] for c in (xb or {}).get("cards", [])):
            problems.append("a card from another board shows up on the outsider's board")
        checked += 5

        # 4. live updates (WebSocket) are only for board members
        for who, expect in (("anon", False), ("outsider", False), ("viewer", True)):
            st = w.people[who].websocket(f"/boards/{f['board']}/ws")
            checked += 1
            if (st == 101) != expect:
                problems.append(f"board WebSocket as {who}: got {st}, expected {'101' if expect else 'refusal'}")
        # 5. the activity log: sign-ins and failed sign-ins are recorded, passwords never are
        n, msgs = activity_log(w)
        checked += n
        problems.extend(msgs)

        # 6. role limits: "only their own cards" and "columns for new cards"
        n, msgs = role_limits(w, f)
        checked += n
        problems.extend(msgs)

        # 7. the public link: read-only, only what the owner allows, only that board
        n, msgs = public_link(w, f)
        checked += n
        problems.extend(msgs)

        # 8. notification choices and "clear"
        n, msgs = notification_choices(w, f)
        checked += n
        problems.extend(msgs)
    finally:
        if os.environ.get("KEEP") == "1":
            print(f"KEEP=1: left the test users authz_{RUN}_* and their boards in place")
        else:
            cleanup(w)

    print(f"{checked} checks")
    for n in notes:
        print("  note:", n)
    if problems:
        print(f"\n{len(problems)} PROBLEM(S):")
        for p in problems:
            print("  ✗", p)
        return 1
    print("all permission checks passed")
    return 0


def activity_log(w: World):
    problems = []
    victim = w.people["viewer"]
    Client("anon").call("POST", "/auth/login", {"username": victim.name, "password": "wrong-" + secrets.token_hex(4)})
    Client("anon").call("POST", "/auth/login", {"username": f"nobody_{RUN}", "password": "wrong"})
    entries, before = [], None
    for _ in range(20):  # newest first, 100 per page
        page = w.admin.ok("GET", "/admin/audit" + (f"?before={before}" if before else ""))
        entries += page["entries"]
        if not page["more"]:
            break
        before = page["entries"][-1]["id"]
    if not any(e["kind"] == "sign_in" and e["actor_id"] == victim.id for e in entries):
        problems.append("activity log: no sign-in entry for a test user")
    if not any(e["kind"] == "sign_in_failed" and e["target_id"] == victim.id for e in entries):
        problems.append("activity log: a failed sign-in on a known account wasn't recorded")
    if not any(e["kind"] == "sign_in_failed" and e["data"].get("typed") == f"nobody_{RUN}" for e in entries):
        problems.append("activity log: a failed sign-in with an unknown name wasn't recorded")
    dump = json.dumps(entries)
    if any(p in dump for p in PASSWORDS):
        problems.append("activity log: an entry contains a password")
    return 4, problems


def public_link(w: World, f: dict):
    o, anon, x = w.people["owner"], Client("anon"), w.people["outsider"]
    problems, checked = [], 0

    def expect(label: str, ok: bool):
        nonlocal checked
        checked += 1
        if not ok:
            problems.append("public link: " + label)

    share = o.ok("PUT", f"/boards/{f['board']}/share", {"enabled": True, "comments": False, "files": False})
    token = share["url"].rsplit("/p/", 1)[1]
    st, b = anon.call("GET", f"/public/{token}")
    expect("the board opens without an account", st == 200 and any(c["id"] == f["card"] for c in b["cards"]))
    dump = json.dumps(b)
    expect("no usernames, emails, roles or templates in the board", all(k not in dump for k in ('"username"', '"email"', '"roles"', '"templates"', '"my_permissions"')))
    expect("who created a card is hidden", all(c.get("created_by") is None for c in b["cards"]))
    expect("comment and file counts hidden while off", all(c["comment_count"] == 0 and c["attachment_count"] == 0 for c in b["cards"]))
    st, c = anon.call("GET", f"/public/{token}/cards/{f['card']}")
    expect("a card opens", st == 200 and c["card"]["description"] == "top secret")
    expect("comments hidden while off", st == 200 and c["comments"] == [] and c["attachments"] == [])
    expect("files refused while off", anon.call("GET", f"/public/{token}/files/{f['file']}")[0] == 404)
    png = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                        "1f15c4890000000d49444154789c63000100000500010d0a2db40000000049454e44ae426082")
    st, pic = o.upload(f"/cards/{f['card2']}/attachments?inline=1", "pic.png", png, "image/png")
    expect("pictures in descriptions load while downloads are off", st == 200 and anon.call("GET", f"/public/{token}/files/{pic['id']}")[0] == 200)
    hidden = fresh(w, "list")["list"]
    hc = o.ok("POST", f"/lists/{hidden}/cards", {"title": "in an archived column", "description": ""})["id"]
    o.ok("POST", f"/lists/{hidden}/archive")
    expect("cards in archived columns aren't in the board", hc not in json.dumps(anon.call("GET", f"/public/{token}")[1]))
    o.ok("PUT", f"/boards/{f['board']}/share", {"comments": True, "files": True})
    st, c = anon.call("GET", f"/public/{token}/cards/{f['card']}")
    expect("comments shown when allowed", st == 200 and any(m["id"] == f["comment"] for m in c["comments"]))
    expect("attachments listed when allowed", st == 200 and any(a["id"] == f["file"] for a in c["attachments"]))
    expect("files download when allowed", anon.call("GET", f"/public/{token}/files/{f['file']}")[0] == 200)
    expect("a card from another board is refused", anon.call("GET", f"/public/{token}/cards/{f['x_card']}")[0] == 404)
    gone = fresh(w, "archived_card")["card"]
    expect("an archived card is refused", anon.call("GET", f"/public/{token}/cards/{gone}")[0] == 404)
    expect("a wrong token is refused", anon.call("GET", f"/public/{'0' * 64}")[0] == 404)
    expect("a malformed token is refused", anon.call("GET", "/public/abc")[0] == 404)
    expect("nothing can be written through the link", anon.call("POST", f"/public/{token}")[0] in (404, 405))
    expect("an outsider can't read the share settings", x.call("GET", f"/boards/{f['board']}/share")[0] in (403, 404))
    # admin switch
    sec = w.admin.ok("GET", "/admin/security")
    w.admin.ok("PUT", "/admin/security", {"require_2fa": sec["require_2fa"], "public_links": False})
    try:
        expect("links stop while an admin has them off", anon.call("GET", f"/public/{token}")[0] == 404)
        expect("no new links while off", o.call("PUT", f"/boards/{f['board']}/share", {"reset": True})[0] == 400)
        w.admin.ok("PUT", "/admin/security", {"require_2fa": sec["require_2fa"]})
        expect("saving another security setting keeps links off", anon.call("GET", f"/public/{token}")[0] == 404)
    finally:
        w.admin.ok("PUT", "/admin/security", {"require_2fa": sec["require_2fa"], "public_links": sec["public_links"]})
    expect("links work again when allowed", anon.call("GET", f"/public/{token}")[0] == 200)
    new = o.ok("PUT", f"/boards/{f['board']}/share", {"reset": True})["url"].rsplit("/p/", 1)[1]
    expect("a new link replaces the old one", new != token and anon.call("GET", f"/public/{token}")[0] == 404 and anon.call("GET", f"/public/{new}")[0] == 200)
    o.ok("PUT", f"/boards/{f['board']}/share", {"enabled": False})
    expect("turning it off stops the link", anon.call("GET", f"/public/{new}")[0] == 404)
    return checked, problems


def notification_choices(w: World, f: dict):
    o, v, e = w.people["owner"], w.people["viewer"], w.people["editor"]
    problems, checked = [], 0

    def expect(label: str, ok: bool):
        nonlocal checked
        checked += 1
        if not ok:
            problems.append("notifications: " + label)

    def assigned_to_viewer():
        o.ok("PUT", f"/cards/{f['card2']}/assignees", {"ids": []})
        o.ok("PUT", f"/cards/{f['card2']}/assignees", {"ids": [v.id]})
        return [n for n in v.ok("GET", "/notifications")["items"] if n["kind"] == "assigned" and n["card_id"] == f["card2"]]

    me = v.ok("PATCH", "/me", {"notify_events": ["mentioned", "nonsense"]})
    expect("unknown kinds are dropped", me["notify_events"] == ["mentioned"])
    expect("an unticked kind isn't sent", assigned_to_viewer() == [])
    v.ok("PATCH", "/me", {"notify_events": ["assigned", "mentioned", "commented", "due_soon", "overdue"]})
    got = assigned_to_viewer()
    expect("a ticked kind is sent", len(got) >= 1)
    if got:
        st, r = e.call("POST", "/notifications/clear", {"ids": [got[0]["id"]]})
        expect("someone else can't clear my notification", st == 200 and r["cleared"] == 0)
        v.ok("POST", "/notifications/clear", {"all": True})
        left = v.ok("GET", "/notifications")
        expect("clear all empties the list", left["items"] == [] and left["unread"] == 0)
    o.ok("PUT", f"/cards/{f['card2']}/assignees", {"ids": []})
    expect("a reminder outside the list is refused", o.call("PATCH", f"/cards/{f['card']}", {"remind_minutes": 99999})[0] == 400)
    return checked, problems


def role_limits(w: World, f: dict):
    """The extra person gets an Editor-like role limited to their own cards and to the first column."""
    o, me = w.people["owner"], w.extra
    problems, checked = [], 0

    def expect(label: str, status: int, ok: bool, data: Any = None):
        nonlocal checked
        checked += 1
        if ok and not 200 <= status < 300:
            problems.append(f"role limits: {label}: expected success, got {status} {data}")
        elif not ok and status not in (403, 404):
            problems.append(f"role limits: {label}: expected refusal, got {status} {data}")
        elif VERBOSE:
            print(f"  ok  role limits: {label} -> {status}")

    editor = next(r for r in o.ok("GET", f"/boards/{f['board']}")["roles"] if r["name"] == "Editor")
    role = o.ok("POST", f"/boards/{f['board']}/roles", {"name": "Limited " + RUN, "permissions": editor["permissions"],
                                                         "own_cards_only": True, "card_list_ids": [f["list"]]})
    o.call("DELETE", f"/boards/{f['board']}/members/{me.id}")
    o.ok("POST", f"/boards/{f['board']}/members", {"user_id": me.id, "role_id": role["id"]})

    # bad role settings
    st, d = o.call("PATCH", f"/roles/{role['id']}", {"card_list_ids": [f["x_list"]]})
    expect("limit a role to another board's column", 403 if st == 400 else st, False, d)
    owner_role = next(r for r in o.ok("GET", f"/boards/{f['board']}")["roles"] if r["is_owner"])
    st, d = o.call("PATCH", f"/roles/{owner_role['id']}", {"own_cards_only": True})
    expect("limit the Owner role", 403 if st == 400 else st, False, d)

    b = me.ok("GET", f"/boards/{f['board']}")
    checked += 1
    if not (b.get("my_own_cards_only") is True and b.get("my_card_list_ids") == [f["list"]]):
        problems.append(f"role limits: board detail doesn't report my limits: {b.get('my_own_cards_only')} {b.get('my_card_list_ids')}")

    # new cards: only in the allowed column
    st, mine = me.call("POST", f"/lists/{f['list']}/cards", {"title": "mine", "description": ""})
    expect("create a card in the allowed column", st, True, mine)
    st, d = me.call("POST", f"/lists/{f['list2']}/cards", {"title": "nope", "description": ""})
    expect("create a card in another column", st, False, d)
    st, d = me.call("POST", f"/lists/{f['list2']}/cards", {"title": "", "description": "", "template_id": f["template"]})
    expect("create from a template in another column", st, False, d)
    theirs2 = o.ok("POST", f"/lists/{f['list2']}/cards", {"title": "owner's, column two", "description": ""})["id"]
    st, d = me.call("POST", f"/cards/{theirs2}/duplicate")
    expect("duplicate a card into another column", st, False, d)
    st, d = me.call("POST", f"/boards/{f['board']}/recurrences", {"template_id": f["template"], "list_id": f["list2"], "freq": "daily", "every": 1, "at_time": "09:00", "enabled": False})
    expect("repeat cards into another column", st, False, d)
    st, d = me.call("POST", f"/boards/{f['board']}/recurrences", {"template_id": f["template"], "list_id": f["list"], "freq": "daily", "every": 1, "at_time": "09:00", "enabled": False})
    expect("repeat cards into the allowed column", st, True, d)
    mine = mine["id"]

    # someone else's card: no changes, but comments are fine
    theirs = o.ok("POST", f"/lists/{f['list']}/cards", {"title": "owner's", "description": ""})["id"]
    status, att = o.upload(f"/cards/{theirs}/attachments", "theirs.txt", b"x")
    def card_calls(c: str):
        return [
            ("rename", "PATCH", f"/cards/{c}", {"title": "changed"}),
            ("set the status", "PATCH", f"/cards/{c}", {"status_id": f["status"]}),
            ("set the due date", "PATCH", f"/cards/{c}", {"due_at": "2031-01-01T09:00:00Z"}),
            ("move", "POST", f"/cards/{c}/move", {"list_id": f["list2"], "index": 0}),
            ("set labels", "PUT", f"/cards/{c}/labels", {"ids": [f["label"]]}),
            ("assign", "PUT", f"/cards/{c}/assignees", {"ids": [me.id]}),
            ("set dependencies", "PUT", f"/cards/{c}/dependencies", {"ids": [f["card"]]}),
        ]
    for label, m, path, body in card_calls(theirs):
        st, d = me.call(m, path, body)
        expect(f"{label} someone else's card", st, False, d)
    st, d = me.upload(f"/cards/{theirs}/attachments", "x.txt", b"x")
    expect("attach a file to someone else's card", st, False, d)
    st, d = me.call("DELETE", f"/attachments/{att['id']}")
    expect("delete a file on someone else's card", st, False, d)
    st, d = me.call("POST", f"/cards/{theirs}/comments", {"body": "a comment"})
    expect("comment on someone else's card", st, True, d)
    st, d = me.call("DELETE", f"/cards/{theirs}")
    expect("archive someone else's card", st, False, d)
    o.ok("DELETE", f"/cards/{theirs}")
    st, d = me.call("POST", f"/cards/{theirs}/restore")
    expect("restore someone else's card", st, False, d)
    st, d = me.call("DELETE", f"/cards/{theirs}/permanent")
    expect("delete someone else's card", st, False, d)
    st, d = me.call("POST", f"/lists/{f['list']}/sort", {"by": "title"})
    expect("sort a whole column", st, False, d)

    # their own card: everything
    for label, m, path, body in card_calls(mine):
        st, d = me.call(m, path, body)
        expect(f"{label} their own card", st, True, d)
    st, d = me.upload(f"/cards/{mine}/attachments", "mine.txt", b"x")
    expect("attach a file to their own card", st, True, d)
    for label, m, path in (("archive", "DELETE", f"/cards/{mine}"), ("restore", "POST", f"/cards/{mine}/restore"),
                           ("archive again", "DELETE", f"/cards/{mine}"), ("delete", "DELETE", f"/cards/{mine}/permanent")):
        st, d = me.call(m, path)
        expect(f"{label} their own card", st, True, d)

    # taking the limits off restores the role's full rights
    o.ok("PATCH", f"/roles/{role['id']}", {"own_cards_only": False, "card_list_ids": None})
    st, d = me.call("POST", f"/lists/{f['list2']}/cards", {"title": "now allowed", "description": ""})
    expect("create in another column after the limit is lifted", st, True, d)
    st, d = me.call("PATCH", f"/cards/{theirs2}", {"title": "now allowed"})
    expect("edit someone else's card after the limit is lifted", st, True, d)
    return checked, problems


def cleanup(w: World, prefix: str = ""):
    """Deleting a user also deletes the boards only they own, with their files."""
    prefix = prefix or f"authz_{RUN}"
    for c in list(w.people.values()) + [w.extra]:
        if c.id:
            w.admin.call("DELETE", f"/admin/users/{c.id}")
    _, users = w.admin.call("GET", "/admin/users")
    for u in users if isinstance(users, list) else []:
        if isinstance(u, dict) and str(u.get("username", "")).startswith(prefix) and not u.get("deleted_at"):
            w.admin.call("DELETE", f"/admin/users/{u['id']}")
    _, bts = w.admin.call("GET", "/board-templates")
    for t in bts if isinstance(bts, list) else []:
        if isinstance(t, dict) and str(t.get("name", "")).startswith("authz") and (prefix == "authz_" or RUN in str(t.get("name"))):
            w.admin.call("DELETE", f"/board-templates/{t['id']}")


if __name__ == "__main__":
    if "--cleanup" in sys.argv:
        cleanup(World(login(ADMIN_USER, ADMIN_PASSWORD), {}, Client("none")), prefix="authz_")
        print("deleted leftover authz_ users, their boards and test board templates")
        sys.exit(0)
    sys.exit(main())
