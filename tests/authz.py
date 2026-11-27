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

import base64
import hashlib
import http.client
import http.cookiejar
import http.server
import json
import os
import re
import secrets
import sys
import threading
import time
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
        self.bearer: Optional[str] = None  # an API token instead of the session cookie

    def call(self, method: str, path: str, body: Any = None, raw: Optional[bytes] = None, ctype: Optional[str] = None):
        data, headers = None, {"Origin": BASE}
        if self.bearer:
            headers["Authorization"] = "Bearer " + self.bearer
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

    def upload(self, path: str, filename: str, content: bytes, ctype: str = "text/plain", options: Any = None):
        boundary = "authz" + secrets.token_hex(8)
        raw = b""
        if options is not None:
            raw += (f'--{boundary}\r\nContent-Disposition: form-data; name="options"\r\n\r\n' + json.dumps(options) + "\r\n").encode()
        raw += (
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
            f"Content-Type: {ctype}\r\n\r\n"
        ).encode() + content + f"\r\n--{boundary}--\r\n".encode()
        return self.call("POST", path, raw=raw, ctype=f"multipart/form-data; boundary={boundary}")

    def hop(self, url: str):
        """GET without following redirects: (status, Location). `url` is an API path or a full URL; cookies kept."""
        class Stop(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *a, **kw):
                return None
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), Stop)
        full = url if url.startswith("http") else BASE + "/api" + url
        try:
            with opener.open(urllib.request.Request(full, headers={"Origin": BASE}), timeout=30) as r:
                return r.status, r.headers.get("Location")
        except urllib.error.HTTPError as e:
            return e.code, e.headers.get("Location")

    def download(self, path: str) -> bytes:
        req = urllib.request.Request(BASE + "/api" + path, headers={"Origin": BASE})
        with self.opener.open(req, timeout=60) as r:
            return r.read()

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
    if kind == "dept":
        return {"dept": w.admin.ok("POST", "/admin/departments", {"name": "authz dept " + RUN + secrets.token_hex(3)})["id"]}
    if kind == "time":  # the editor's own entry
        return {"time": w.people["editor"].ok("POST", f"/cards/{f['card']}/time", {"minutes": 5})["id"]}
    if kind == "token":  # someone else's API token
        return {"token": w.extra.ok("POST", "/me/tokens", {"name": "authz", "scope": "read", "expires_days": 1})["info"]["id"]}
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
    Case("GET", B + "/analytics", "owner", note="the Editor role doesn't have View analytics"),
    Case("GET", B + "/analytics?days=365", "owner"),
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
    Case("GET", "/admin/signups", "admin"),
    Case("POST", "/admin/signups/approve", "admin", {"ids": []}),
    Case("POST", "/admin/signups/reject", "admin", {"ids": []}),
    Case("GET", "/admin/announcement", "admin"),
    Case("PUT", "/admin/announcement", "admin", {"text": "", "level": "info"}),
    Case("GET", "/announcement", "outsider"),
    Case("GET", "/me/sessions", "outsider"),
    Case("DELETE", "/me/sessions", "outsider", note="sign out my other devices"),
    Case("DELETE", "/me/sessions/{session}", "none", fresh="session", note="someone else's device from my profile"),
    Case("PUT", "/admin/security", "admin", {"require_2fa": False}),
    Case("GET", "/admin/sso", "admin"),
    Case("POST", "/admin/sso/test", "admin", {"enabled": False, "issuer": "http://127.0.0.1:9", "client_id": "x"}),
    Case("PUT", "/admin/sso", "admin", {"enabled": False, "issuer": "", "client_id": ""}),
    Case("GET", "/me/sso", "outsider"),
    Case("PUT", "/cards/{card}/watch", "viewer", {"watching": True}),
    Case("GET", "/departments", "outsider"),
    Case("POST", "/admin/departments", "admin", {"name": "authz dept " + RUN}),
    Case("PATCH", "/admin/departments/{dept}", "admin", {"color": "#ff0000"}, fresh="dept"),
    Case("PUT", "/admin/departments/{dept}/members", "admin", {"add": [], "remove": []}, fresh="dept"),
    Case("DELETE", "/admin/departments/{dept}", "admin", fresh="dept"),
    Case("GET", "/cards/{card}/time", "viewer"),
    Case("POST", "/cards/{card}/time", "editor", {"minutes": 3, "note": "authz"}),
    Case("PATCH", "/time/{time}", "editor", {"note": "changed"}, fresh="time", note="the editor's own entry; owners manage the board"),
    Case("DELETE", "/time/{time}", "editor", fresh="time"),
    Case("GET", "/me/timer", "outsider"),
    Case("GET", "/me/tokens", "outsider"),
    Case("POST", "/me/tokens", "outsider", {"name": "authz", "scope": "read", "expires_days": 1}),
    Case("DELETE", "/me/tokens/{token}", "none", fresh="token", note="someone else's API token"),
    Case("POST", B + "/cards/bulk", "viewer", {"card_ids": ["{card}"], "action": "watch", "watching": False}),
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

        # 9. importing boards
        n, msgs = import_flow(w, f)
        checked += n
        problems.extend(msgs)

        # 10. self sign-up (only when the server runs with ALLOW_SIGNUP=true)
        n, msgs = signup_flow(w)
        checked += n
        problems.extend(msgs)

        # 11. several cards at once
        n, msgs = bulk_flow(w, f)
        checked += n
        problems.extend(msgs)

        # 12. departments, time tracking, API tokens
        for flow in (departments_flow, time_flow, tokens_flow):
            n, msgs = flow(w, f)
            checked += n
            problems.extend(msgs)

        # 13. single sign-on, against a fake OpenID Connect provider
        n, msgs = sso_flow(w)
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

    # watching a card: notified like its assignees, only while on the board
    c = w.people["commenter"]
    v.ok("POST", "/notifications/clear", {"all": True})
    v.ok("PATCH", "/me", {"notify_events": ["commented", "card_updated"]})
    v.ok("PUT", f"/cards/{f['card2']}/watch", {"watching": True})
    expect("the card says I'm watching", v.ok("GET", f"/cards/{f['card2']}").get("watching") is True)
    expect("so does the board", f["card2"] in v.ok("GET", f"/boards/{f['board']}").get("watching", []))
    expect("someone else isn't watching", o.ok("GET", f"/cards/{f['card2']}").get("watching") is False)
    c.ok("POST", f"/cards/{f['card2']}/comments", {"body": "a comment for the watchers"})
    mine = lambda kind: [n for n in v.ok("GET", "/notifications")["items"] if n["kind"] == kind and n["card_id"] == f["card2"]]
    expect("a watcher hears about comments", len(mine("commented")) == 1)
    e.ok("PATCH", f"/cards/{f['card2']}", {"title": "second (edited)"})
    deadline = time.time() + 25  # card activity is bundled for 8 s and sent every 5 s
    while time.time() < deadline and not mine("card_updated"):
        time.sleep(1)
    expect("a watcher hears about edits", len(mine("card_updated")) == 1)
    v.ok("PUT", f"/cards/{f['card2']}/watch", {"watching": False})
    c.ok("POST", f"/cards/{f['card2']}/comments", {"body": "after unwatching"})
    expect("not after unwatching", len(mine("commented")) == 1)
    # someone who leaves the board stops watching its cards
    x = w.extra
    o.call("POST", f"/boards/{f['board']}/members", {"user_id": x.id, "role_id": f["role_viewer"]})
    x.ok("PATCH", "/me", {"notify_events": ["commented"]})
    x.ok("PUT", f"/cards/{f['card2']}/watch", {"watching": True})
    o.ok("DELETE", f"/boards/{f['board']}/members/{x.id}")
    c.ok("POST", f"/cards/{f['card2']}/comments", {"body": "after leaving"})
    expect("a member who left gets nothing", not [n for n in x.ok("GET", "/notifications")["items"] if n["card_id"] == f["card2"]])
    o.ok("POST", f"/boards/{f['board']}/members", {"user_id": x.id, "role_id": f["role_viewer"]})
    expect("and isn't watching when added again", f["card2"] not in x.ok("GET", f"/boards/{f['board']}").get("watching", []))
    v.ok("PATCH", "/me", {"notify_events": ["assigned", "mentioned", "commented", "due_soon", "overdue"]})
    return checked, problems


TRELLO = {
    "id": "b1", "name": "From Trello", "desc": "trello board", "idOrganization": None, "shortLink": "abc", "prefs": {},
    "lists": [{"id": "l2", "name": "Doing", "closed": False, "pos": 2}, {"id": "l1", "name": "To do", "closed": False, "pos": 1},
              {"id": "l3", "name": "Old", "closed": True, "pos": 3}],
    "labels": [{"id": "g", "name": "Bug", "color": "red"}, {"id": "h", "name": "", "color": "green_dark"}, {"id": "x", "name": "Evil", "color": "url(https://evil)"}],
    "members": [{"id": "m1", "fullName": "Somebody Else", "username": "nobody_here_xyz"}],
    "cards": [
        {"id": "c1", "idShort": 7, "name": "First", "desc": "hello", "idList": "l1", "closed": False, "pos": 1, "due": "2030-02-01T10:00:00.000Z",
         "dueComplete": True, "dateLastActivity": "2024-05-01T10:00:00.000Z", "idLabels": ["g", "h", "x"], "idMembers": ["m1"],
         "attachments": [{"name": "spec.pdf", "url": "https://trello.com/1/cards/c1/attachments/spec.pdf"}]},
        {"id": "c2", "idShort": 8, "name": "Second", "desc": "", "idList": "l2", "closed": True, "pos": 1, "idLabels": [], "idMembers": []},
    ],
    "checklists": [{"id": "k1", "idCard": "c1", "name": "Steps", "pos": 1,
                    "checkItems": [{"name": "two", "state": "incomplete", "pos": 2}, {"name": "one", "state": "complete", "pos": 1}]}],
    "actions": [{"type": "commentCard", "date": "2024-04-01T09:00:00.000Z", "data": {"card": {"id": "c1"}, "text": "a trello comment @someone"},
                 "memberCreator": {"fullName": "Somebody Else"}}],
}

WEKAN = {
    "_format": "wekan-board-1.0.0", "title": "From Wekan", "labels": [{"_id": "L1", "name": "Ops", "color": "blue"}],
    "lists": [{"_id": "A", "title": "Backlog", "archived": False, "sort": 0}],
    "cards": [{"_id": "C1", "title": "Wekan card", "description": "w", "listId": "A", "archived": False, "sort": 0, "labelIds": ["L1"],
               "members": ["U1"], "dueAt": "2030-03-01T00:00:00.000Z", "cardNumber": 3}],
    "checklists": [{"_id": "K", "cardId": "C1", "title": "Todo", "sort": 0}],
    "checklistItems": [{"_id": "I", "checklistId": "K", "cardId": "C1", "title": "item", "isFinished": True, "sort": 0}],
    "comments": [{"_id": "M", "text": "wekan comment", "userId": "U1", "createdAt": "2024-01-01T00:00:00.000Z"}],
    "activities": [{"activityType": "addComment", "commentId": "M", "cardId": "C1"}],
    "users": [{"_id": "U1", "username": "wekan_person_xyz", "profile": {"fullname": "Wekan Person"}}],
}


def import_flow(w: World, f: dict):
    o, anon = w.people["owner"], Client("anon")
    problems, checked = [], 0

    def expect(label: str, ok: bool):
        nonlocal checked
        checked += 1
        if not ok:
            problems.append("import: " + label)

    def imp(who: Client, name: str, data: bytes, ctype: str = "application/json", options: Any = None, path: str = "/import"):
        return who.upload(path, name, data, ctype, options if options is not None else {"name": f"authz import {RUN} {name}"})

    def cards_of(board: str):
        b = o.ok("GET", f"/boards/{board}")
        return b, b["cards"]

    # who may import
    tj = json.dumps(TRELLO).encode()
    expect("anon is refused", imp(anon, "t.json", tj)[0] == 401)
    nob = make_user(w.admin, "noboards")
    w.admin.ok("PATCH", f"/admin/users/{nob.id}", {"can_create_boards": False})
    expect("someone who can't create boards is refused", imp(nob, "t.json", tj)[0] == 403)
    expect("an unknown file is refused", imp(o, "x.bin", b"\x00\x01garbage")[0] == 400)
    expect("a damaged ZIP is refused", imp(o, "x.zip", b"PK\x03\x04garbage", "application/zip")[0] == 400)
    expect("broken JSON is refused", imp(o, "x.json", b'{"format":"kanban-board-export", "cards": [')[0] == 400)

    # the viewer wants to hear about new cards on their boards; an import must not tell them
    v = w.people["viewer"]
    imported: list = []
    v.ok("PATCH", "/me", {"notify_events": ["assigned", "mentioned", "commented", "due_soon", "overdue", "card_created"]})

    # Trello
    st, r = imp(o, "trello.json", tj, options={})
    expect(f"Trello imports ({st} {r})", st == 200 and r.get("cards") == 2)
    if st == 200:
        b, cards = cards_of(r["board_id"])
        expect("Trello: columns in board order", [l["name"] for l in b["lists"]] == ["To do", "Doing"])
        expect("Trello: board name from the file", b["board"]["name"] == "From Trello")
        first = next((c for c in cards if c["title"] == "First"), None)
        expect("Trello: card number kept", first is not None and first["number"] == 7)
        expect("Trello: closed card archived", all(c["title"] != "Second" for c in cards))
        expect("Trello: colours are only hex", all(l["color"].startswith("#") and len(l["color"]) == 7 for l in b["labels"]))
        if first:
            d = o.ok("GET", f"/cards/{first['id']}")["card"]
            expect("Trello: checklist in order", "- [x] one\n- [ ] two" in d["description"])
            expect("Trello: attachment kept as a link", "spec.pdf" in d["description"])
            expect("Trello: unmatched assignee stays as text", "Somebody Else" in d["description"])
            expect("Trello: done with a done date", first["done"] and first["done_at"].startswith("2024-05-01"))
            tl = o.ok("GET", f"/cards/{first['id']}/timeline")
            cm = [i for i in tl if i["type"] == "comment"]
            expect("Trello: comment kept with its author as a name", len(cm) == 1 and cm[0]["imported"] and cm[0]["author_name"] == "Somebody Else" and cm[0]["author_id"] is None)
        new = o.ok("POST", f"/lists/{b['lists'][0]['id']}/cards", {"title": "after import", "description": ""})
        expect("a new card gets the next number", o.ok("GET", f"/cards/{new['id']}")["card"]["number"] == 9)

    # Wekan
    st, r = imp(o, "wekan.json", json.dumps(WEKAN).encode(), options={})
    expect(f"Wekan imports ({st} {r})", st == 200 and r.get("cards") == 1)
    if st == 200:
        _, cards = cards_of(r["board_id"])
        d = o.ok("GET", f"/cards/{cards[0]['id']}")["card"]
        expect("Wekan: checklist, number and label", "- [x] item" in d["description"] and d["number"] == 3 and len(d["label_ids"]) == 1)
        tl = o.ok("GET", f"/cards/{cards[0]['id']}/timeline")
        expect("Wekan: comment found through its activity", any(i["type"] == "comment" and i["body"] == "wekan comment" for i in tl))

    # Kanb round trips: JSON, ZIP (with files) and CSV
    png = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                        "1f15c4890000000d49444154789c63000100000500010d0a2db40000000049454e44ae426082")
    st, pic = o.upload(f"/cards/{f['card']}/attachments?inline=1", "pic.png", png, "image/png")
    o.ok("PATCH", f"/cards/{f['card']}", {"description": f"top secret ![](/api/files/{pic['id']})"})
    src = o.ok("GET", f"/boards/{f['board']}")
    src_numbers = sorted(c["number"] for c in src["cards"])
    for fmt_, ctype in (("json", "application/json"), ("zip", "application/zip"), ("csv", "text/csv")):
        data = o.download(f"/boards/{f['board']}/export?format={fmt_}")
        st, prev = imp(o, f"board.{fmt_}", data, ctype, path="/import/preview")
        expect(f"{fmt_}: preview ({st})", st == 200 and prev.get("cards", 0) >= len(src["cards"]))
        if fmt_ != "csv":
            expect(f"{fmt_}: the board's people are matched", st == 200 and any(p["account"] and p["account"]["id"] == w.people["editor"].id for p in prev["people"]))
        st, r = imp(o, f"board.{fmt_}", data, ctype)
        expect(f"{fmt_}: imports ({st} {r})", st == 200)
        if st != 200:
            continue
        imported.append(r["board_id"])
        b, cards = cards_of(r["board_id"])
        # CSV doesn't say which columns were archived, so cards in an archived column come back in an open one
        same = len(cards) >= len(src["cards"]) if fmt_ == "csv" else len(cards) == len(src["cards"])
        expect(f"{fmt_}: same open cards ({len(cards)} vs {len(src['cards'])})", same)
        if fmt_ in ("json", "zip"):
            expect(f"{fmt_}: card numbers kept", sorted(c["number"] for c in cards) == src_numbers)
            card = next(c for c in cards if c["number"] == next(x["number"] for x in src["cards"] if x["id"] == f["card"]))
            card2 = next(c for c in cards if c["number"] == next(x["number"] for x in src["cards"] if x["id"] == f["card2"]))
            expect(f"{fmt_}: dependency kept", card["id"] in card2["depends_on"])
            expect(f"{fmt_}: editor added as a member", any(m["user_id"] == w.people["editor"].id for m in b["members"]))
            tl = o.ok("GET", f"/cards/{card['id']}/timeline")
            expect(f"{fmt_}: comments imported, not linked to accounts", any(i["type"] == "comment" and i["imported"] and i["author_id"] is None for i in tl))
            d = o.ok("GET", f"/cards/{card['id']}")
        if fmt_ == "zip":
            files = d["attachments"]
            expect("zip: attached file copied", any(a["filename"] == "secret.txt" for a in files))
            ok_file = all(o.call("GET", f"/files/{a['id']}")[0] == 200 for a in files)
            expect("zip: copied files download", ok_file)
            expect("zip: picture link points at the copy", f"/api/files/{pic['id']}" not in d["card"]["description"] and "/api/files/" in d["card"]["description"])
            m = re.search(r"/api/files/([0-9a-f-]{36})", d["card"]["description"])
            expect("zip: the copied picture loads", bool(m) and o.call("GET", f"/files/{m.group(1)}")[0] == 200)
        if fmt_ == "json":
            expect("json: picture link left as it was (no files in JSON)", f"/api/files/{pic['id']}" in d["card"]["description"])
    # CSV made by hand: semicolons, quotes, Thai text, month-first dates
    csv_text = "Name;List;Due date;Tags\r\n\"Write, test\";Backlog;03/04/2030;a, b\r\nงานภาษาไทย;Doing;12/31/2030;\r\n"
    st, prev = imp(o, "plan.csv", csv_text.encode(), "text/csv", options={"csv": {"title": 0, "column": 1, "due": 2, "labels": 3, "day_first": False}}, path="/import/preview")
    expect(f"csv: preview with a column choice ({st})", st == 200 and prev["cards"] == 2 and prev["csv"]["headers"][0] == "Name")
    st, r = imp(o, "plan.csv", csv_text.encode(), "text/csv", options={"name": "csv " + RUN, "csv": {"title": 0, "column": 1, "due": 2, "labels": 3, "day_first": False}})
    if st == 200:
        b, cards = cards_of(r["board_id"])
        c1 = next((c for c in cards if c["title"] == "Write, test"), None)
        expect("csv: month-first date read", c1 is not None and c1["due_at"] is not None and c1["due_at"][5:7] == "03")
        expect("csv: columns and labels made", [l["name"] for l in b["lists"]] == ["Backlog", "Doing"] and len(b["labels"]) == 2)
    else:
        expect(f"csv: imports ({st} {r})", False)
    expect("csv that isn't UTF-8 is refused", imp(o, "bad.csv", b"T\xe9st\r\nx\r\n", "text/csv")[0] == 400)
    # matching people by email is for super admins only (else it reveals who has an account)
    _, me_editor = w.people["editor"].call("GET", "/me")
    if me_editor.get("email") is None:
        w.admin.ok("PATCH", f"/admin/users/{w.people['editor'].id}", {"email": f"authz_{RUN}_editor@example.com"})
    who = f"Title,Assignee\r\nx,authz_{RUN}_editor@example.com\r\n".encode()
    st, as_owner = imp(o, "who.csv", who, "text/csv", path="/import/preview")
    st2, as_admin = imp(w.admin, "who.csv", who, "text/csv", path="/import/preview")
    expect("email matching hidden from non-admins", st == 200 and all(p["account"] is None for p in as_owner["people"]))
    expect("email matching works for super admins", st2 == 200 and any(p["account"] for p in as_admin["people"]))
    # a "Done" column means finished, without inventing a finish date
    st, r = imp(o, "done.csv", b"Title,List\r\nshipped it,Done\r\nnot yet,Doing\r\n", "text/csv", options={"name": "done " + RUN})
    if st == 200:
        _, cards = cards_of(r["board_id"])
        c = next(c for c in cards if c["title"] == "shipped it")
        expect("csv: a card in a Done column is finished, with no made-up date", c["done"] and c["done_at"] is None)
    # colours are only ever #hex (they end up in style attributes, also on public links)
    expect("a colour that isn't #hex is refused", o.call("PATCH", f"/boards/{f['board']}", {"color": "url(https://example.com/x)"})[0] == 400)
    expect("a label colour that isn't #hex is refused", o.call("POST", f"/boards/{f['board']}/labels", {"name": "x", "color": "red;background:url(x)"})[0] == 400)
    # nothing was sent about the imported cards (the activity job runs every 5 s, 8 s behind)
    import time
    time.sleep(16)
    about = [n["kind"] for n in v.ok("GET", "/notifications")["items"] if n["board_id"] in imported]
    expect(f"no notifications about imported cards ({about})", about == [])
    v.ok("PATCH", "/me", {"notify_events": ["assigned", "mentioned", "commented", "due_soon", "overdue"]})
    return checked, problems


MAILPIT = os.environ.get("MAILPIT_URL", "http://127.0.0.1:58025").rstrip("/")


def confirm_token(email: str) -> Optional[str]:
    """The token in the newest confirmation email to `email`, from Mailpit (None if Mailpit isn't reachable)."""
    try:
        q = urllib.parse.quote(f"to:{email}")
        with urllib.request.urlopen(f"{MAILPIT}/api/v1/search?query={q}", timeout=10) as r:
            msgs = json.load(r).get("messages") or []
        if not msgs:
            return None
        with urllib.request.urlopen(f"{MAILPIT}/api/v1/message/{msgs[0]['ID']}", timeout=10) as r:
            text = json.load(r).get("Text", "")
        import re
        m = re.search(r"confirm-email\?token=([0-9a-f]{64})", text)
        return m.group(1) if m else None
    except Exception:
        return None


def signup_flow(w: World):
    anon = Client("anon")
    problems, checked = [], 0

    def expect(label: str, ok: bool):
        nonlocal checked
        checked += 1
        if not ok:
            problems.append("sign-up: " + label)

    opts = anon.ok("GET", "/auth/options")
    body = lambda name, **kw: dict({"username": f"authz_{RUN}_{name}", "display_name": f"authz {name}", "email": f"authz_{RUN}_{name}@example.com", "password": "Signup-" + RUN + "-pw", "locale": "en"}, **kw)
    PASSWORDS.append("Signup-" + RUN + "-pw")
    if not opts.get("signup"):
        expect("register is closed when ALLOW_SIGNUP is off", anon.call("POST", "/auth/register", body("closed"))[0] == 404)
        expect("confirm is closed when ALLOW_SIGNUP is off", anon.call("POST", "/auth/confirm", {"token": "0" * 64})[0] == 404)
        return checked, problems
    prev = w.admin.ok("GET", "/admin/signups")
    w.admin.ok("PUT", "/admin/signups", {"approval": "review", "can_create_boards": True})
    try:
        b1 = body("su1")
        st, r = anon.call("POST", "/auth/register", b1)
        expect(f"sign-up accepted ({st} {r})", st == 200 and r.get("status") in ("confirm_email", "review"))
        if r.get("status") == "confirm_email":
            st, e = Client("su1").call("POST", "/auth/login", {"username": b1["username"], "password": b1["password"]})
            expect("an unconfirmed account can't sign in", st == 403 and e.get("error") == "email_not_confirmed")
            token = confirm_token(b1["email"])
            if token is None:
                problems.append("sign-up: no confirmation email found in Mailpit (set MAILPIT_URL)")
            else:
                expect("a confirm link can't reset a password", anon.call("POST", "/auth/reset", {"token": token, "password": "Hijack-12345678"})[0] == 400)
                st, r = anon.call("POST", "/auth/confirm", {"token": token})
                expect("the confirm link moves it to review", st == 200 and r.get("status") == "review")
                expect("a confirm link works once", anon.call("POST", "/auth/confirm", {"token": token})[0] == 400)
        st, e = Client("su1").call("POST", "/auth/login", {"username": b1["username"], "password": b1["password"]})
        expect("a waiting account can't sign in, and is told why", st == 403 and e.get("error") == "pending_approval")
        st, e = Client("su1").call("POST", "/auth/login", {"username": b1["username"], "password": "wrong-password"})
        expect("a wrong password on a waiting account says nothing more", st == 401 and e.get("error") == "invalid_credentials")
        waiting = {x["username"]: x["id"] for x in w.admin.ok("GET", "/admin/signups")["waiting"]}
        su1 = waiting.get(b1["username"])
        expect("the admin sees it waiting", su1 is not None)
        expect("it isn't in the normal user list", all(u["username"] != b1["username"] for u in w.admin.ok("GET", "/admin/users")))
        if su1:
            expect("it can't be edited (and so activated) like a normal user", w.admin.call("PATCH", f"/admin/users/{su1}", {"is_active": True})[0] == 404)
            expect("only an admin can approve", w.people["owner"].call("POST", "/admin/signups/approve", {"ids": [su1]})[0] == 403)
        b2 = body("su2")
        anon.call("POST", "/auth/register", b2)
        tok2 = confirm_token(b2["email"])
        if tok2:
            anon.call("POST", "/auth/confirm", {"token": tok2})
        bundles = [n for n in w.admin.ok("GET", "/notifications")["items"] if n["kind"] == "signup" and not n["read_at"]]
        expect(f"admins get one bundled notification ({len(bundles)})", len(bundles) == 1 and bundles[0]["data"].get("count", 0) >= 2 and bundles[0]["board_id"] is None)
        bot = body("bot", website="http://spam.example")
        st, _ = anon.call("POST", "/auth/register", bot)
        expect("the hidden field quietly drops bots", st == 200 and bot["username"] not in json.dumps(w.admin.ok("GET", "/admin/signups")))
        if su1:
            expect("approve", w.admin.ok("POST", "/admin/signups/approve", {"ids": [su1]})["approved"] == 1)
            expect("an approved account can sign in", Client("su1").call("POST", "/auth/login", {"username": b1["username"], "password": b1["password"]})[0] == 200)
            expect("reject can't delete a normal account", w.admin.ok("POST", "/admin/signups/reject", {"ids": [su1]})["rejected"] == 0)
        su2 = {x["username"]: x["id"] for x in w.admin.ok("GET", "/admin/signups")["waiting"]}.get(b2["username"])
        if su2:
            expect("reject", w.admin.ok("POST", "/admin/signups/reject", {"ids": [su2]})["rejected"] == 1)
            expect("a rejected account is gone", Client("su2").call("POST", "/auth/login", {"username": b2["username"], "password": b2["password"]})[0] == 401)
        left = [n for n in w.admin.ok("GET", "/notifications")["items"] if n["kind"] == "signup" and not n["read_at"]]
        if not w.admin.ok("GET", "/admin/signups")["waiting"]:
            expect("the bundle is marked read once nobody is waiting", left == [])
        # automatic approval
        w.admin.ok("PUT", "/admin/signups", {"approval": "auto", "can_create_boards": False})
        b3 = body("su3")
        me = Client("su3")
        st, r = me.call("POST", "/auth/register", b3)
        if r.get("status") == "confirm_email":
            tok3 = confirm_token(b3["email"])
            st, r = me.call("POST", "/auth/confirm", {"token": tok3 or ""})
        expect(f"automatic approval signs them in ({r})", st == 200 and r.get("status") == "active")
        st, u = me.call("GET", "/me")
        expect("…with the admin's board setting", st == 200 and u.get("can_create_boards") is False)
    finally:
        w.admin.ok("PUT", "/admin/signups", {"approval": prev["approval"], "can_create_boards": prev["can_create_boards"]})
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

def checker(topic: str):
    problems, count = [], [0]

    def expect(label: str, ok: bool):
        count[0] += 1
        if not ok:
            problems.append(f"{topic}: {label}")
    return expect, problems, count


def departments_flow(w: World, f: dict):
    expect, problems, n = checker("departments")
    a, o, v = w.admin, w.people["owner"], w.people["viewer"]
    name = "authz Sales " + RUN
    d = a.ok("POST", "/admin/departments", {"name": name, "color": "#2f5bd3"})["id"]
    st, e = a.call("POST", "/admin/departments", {"name": name.upper()})
    expect(f"names are unique, ignoring case ({st} {e})", st == 409 and (e or {}).get("error") == "department_exists")
    expect("a colour must be a colour", a.call("PATCH", f"/admin/departments/{d}", {"color": "red; x"})[0] == 400)
    a.ok("PUT", f"/admin/departments/{d}/members", {"add": [v.id]})
    expect("the person is in it", next(u for u in a.ok("GET", "/admin/users") if u["id"] == v.id)["department_id"] == d)
    expect("the directory shows it", next(u for u in o.ok("GET", "/users") if u["id"] == v.id).get("department_id") == d)
    expect("board members show it", next(m for m in o.ok("GET", f"/boards/{f['board']}")["members"] if m["user_id"] == v.id).get("department_id") == d)
    expect("the list counts people", next(x for x in v.ok("GET", "/departments") if x["id"] == d)["members"] == 1)
    v.call("PATCH", "/me", {"department_id": None})
    expect("people can't change their own", v.ok("GET", "/me")["department_id"] == d)
    expect("an unknown department is refused", a.call("PATCH", f"/admin/users/{v.id}", {"department_id": "00000000-0000-0000-0000-000000000000"})[0] == 400)
    a.ok("PATCH", f"/admin/users/{v.id}", {"department_id": None})
    expect("an admin can take them out", v.ok("GET", "/me")["department_id"] is None)
    a.ok("PATCH", f"/admin/users/{v.id}", {"department_id": d})
    a.ok("DELETE", f"/admin/departments/{d}")
    expect("deleting it leaves people without one", v.ok("GET", "/me")["department_id"] is None)
    return n[0], problems


def time_flow(w: World, f: dict):
    expect, problems, n = checker("time")
    o, e, c, v = w.people["owner"], w.people["editor"], w.people["commenter"], w.people["viewer"]
    card, card2 = f["card"], f["card2"]
    e.call("POST", "/me/timer/stop", {})
    r = e.ok("POST", f"/cards/{card}/time/start")
    expect("a timer starts", e.ok("GET", "/me/timer")["running"]["card_id"] == card)
    r = e.ok("POST", f"/cards/{card2}/time/start")
    expect("starting another stops the first (one runs at a time)", r["stopped"] and r["stopped"]["card_id"] == card and e.ok("GET", "/me/timer")["running"]["card_id"] == card2)
    expect("its time was logged", any(x["ended_at"] and x["user_id"] == e.id for x in e.ok("GET", f"/cards/{card}/time")["entries"]))
    st, r = e.call("POST", "/me/timer/stop", {"minutes": 45, "note": "real time"})
    expect(f"stop, correcting the time ({st} {r})", st == 200 and r["minutes"] == 45)
    expect("nothing runs after stopping", e.ok("GET", "/me/timer")["running"] is None)
    expect("stopping twice is refused", e.call("POST", "/me/timer/stop", {})[0] == 400)
    expect("a commenter can't log time", c.call("POST", f"/cards/{card}/time", {"minutes": 5})[0] == 403)
    expect("nor start a timer", c.call("POST", f"/cards/{card}/time/start")[0] == 403)
    for bad in (0, -5, 7 * 24 * 60 + 1):
        expect(f"{bad} minutes is refused", e.call("POST", f"/cards/{card}/time", {"minutes": bad})[0] == 400)
    entry = e.ok("POST", f"/cards/{card2}/time", {"minutes": 30, "note": "mine"})["id"]
    expect("the card counts it", next(k for k in o.ok("GET", f"/boards/{f['board']}")["cards"] if k["id"] == card2)["time_minutes"] >= 75)
    expect("someone else's entry can't be changed", v.call("PATCH", f"/time/{entry}", {"note": "x"})[0] == 403)
    expect("its owner can change it", e.call("PATCH", f"/time/{entry}", {"minutes": 40})[0] == 200)
    expect("a board manager can fix it", o.call("PATCH", f"/time/{entry}", {"note": "fixed"})[0] == 200)
    expect("the estimate needs card editing", c.call("PATCH", f"/cards/{card2}", {"estimate_minutes": 60})[0] == 403)
    o.ok("PATCH", f"/cards/{card2}", {"estimate_minutes": 60})
    t = v.ok("GET", f"/cards/{card2}/time")
    expect("a viewer sees the total and estimate", t["estimate_minutes"] == 60 and t["total_minutes"] >= 85 and not t["can_log"])
    csv = o.download(f"/boards/{f['board']}/export?format=csv").decode("utf-8-sig")
    expect("the CSV export has the time columns", "Time logged (hours)" in csv.splitlines()[0])
    a = o.ok("GET", f"/boards/{f['board']}/analytics?days=30")
    expect("analytics shows logged time", a.get("time", {}).get("total_minutes", 0) >= 85)
    # a timer stops when its owner leaves the board
    x = w.extra
    if o.call("POST", f"/boards/{f['board']}/members", {"user_id": x.id, "role_id": f["role_editor"]})[0] == 409:
        o.ok("PATCH", f"/boards/{f['board']}/members/{x.id}", {"role_id": f["role_editor"]})
    x.call("POST", "/me/timer/stop", {})
    x.ok("POST", f"/cards/{card}/time/start")
    o.ok("DELETE", f"/boards/{f['board']}/members/{x.id}")
    expect("leaving the board stops your timer there", x.ok("GET", "/me/timer")["running"] is None)
    o.ok("POST", f"/boards/{f['board']}/members", {"user_id": x.id, "role_id": f["role_viewer"]})
    # public links don't show it
    token = o.ok("PUT", f"/boards/{f['board']}/share", {"enabled": True})["url"].rsplit("/p/", 1)[1]
    pub = Client("anon").ok("GET", f"/public/{token}")
    expect("a public link shows no time tracking", all(k.get("time_minutes", 0) == 0 and k.get("estimate_minutes") is None for k in pub["cards"]))
    o.ok("PUT", f"/boards/{f['board']}/share", {"enabled": False})
    e.ok("DELETE", f"/time/{entry}")
    return n[0], problems


def tokens_flow(w: World, f: dict):
    expect, problems, n = checker("API tokens")
    e, v = w.people["editor"], w.people["viewer"]
    r = e.ok("POST", "/me/tokens", {"name": "authz read", "scope": "read", "expires_days": 30})
    PASSWORDS.append(r["token"])
    expect("tokens look like kanb_…", r["token"].startswith("kanb_") and r["info"]["prefix"] in r["token"])
    expect("the token itself is never listed", r["token"] not in json.dumps(e.ok("GET", "/me/tokens")))
    read = Client("read token")
    read.bearer = r["token"]
    expect("a read token reads", read.call("GET", f"/boards/{f['board']}")[0] == 200 and read.ok("GET", "/me")["id"] == e.id)
    st, x = read.call("PATCH", f"/cards/{f['card']}", {"priority": 1})
    expect(f"a read token can't write ({st} {x})", st == 403 and (x or {}).get("error") == "token_read_only")
    wr = e.ok("POST", "/me/tokens", {"name": "authz write", "scope": "write"})
    PASSWORDS.append(wr["token"])
    write = Client("write token")
    write.bearer = wr["token"]
    expect("a write token writes", write.call("POST", f"/cards/{f['card']}/comments", {"body": "from a script"})[0] == 200)
    expect("with its owner's permissions only", write.call("DELETE", f"/boards/{f['board']}/permanent")[0] == 403)
    for method, path, body in [("GET", "/me/tokens", None), ("POST", "/me/tokens", {"name": "x", "scope": "write"}), ("POST", "/me/password", {"current_password": "x", "new_password": "Hijack-12345678"}),
                               ("POST", "/me/2fa/setup", {}), ("GET", "/me/sessions", None), ("DELETE", "/me/sessions", None), ("GET", "/me/sso", None),
                               ("PATCH", "/me", {"email": "attacker@example.com"})]:
        st, x = write.call(method, path, body)
        expect(f"a token can't {method} {path} ({st} {x})", st == 403 and (x or {}).get("error") == "token_not_allowed")
    expect("but may change harmless settings", write.call("PATCH", "/me", {"theme": "dark"})[0] == 200)
    # a reverse proxy's Basic auth in front of Kanb sends its own Authorization header: the session still counts
    req = urllib.request.Request(BASE + "/api/me", headers={"Origin": BASE, "Authorization": "Basic dXNlcjpwYXNz"})
    try:
        with v.opener.open(req, timeout=30) as resp:
            st = resp.status
    except urllib.error.HTTPError as err:
        st = err.code
    expect(f"a session with a proxy's Basic auth header still works ({st})", st == 200)
    write.call("POST", "/auth/logout", {})
    expect("signing out (a session thing) doesn't touch a token", write.call("GET", "/me")[0] == 200)
    expect("no live updates with a token", write.websocket(f"/boards/{f['board']}/ws") != 101)
    st, _ = Client("query").call("GET", "/me?access_token=" + wr["token"])
    expect("a token in the address is ignored", st == 401)
    bad = Client("bad")
    bad.bearer = "kanb_" + "0" * 64
    expect("an unknown token is refused", bad.call("GET", "/me")[0] == 401)
    junk = Client("junk")
    junk.bearer = "not-a-token"
    expect("a malformed one too", junk.call("GET", "/me")[0] == 401)
    rid = r["info"]["id"]
    expect("nobody else can revoke it", v.call("DELETE", f"/me/tokens/{rid}")[0] == 404)
    e.ok("DELETE", f"/me/tokens/{rid}")
    expect("a revoked token stops working", read.call("GET", "/me")[0] == 401)
    expect("a bad expiry is refused", e.call("POST", "/me/tokens", {"name": "x", "scope": "read", "expires_days": 0})[0] == 400)
    expect("a bad scope is refused", e.call("POST", "/me/tokens", {"name": "x", "scope": "admin"})[0] == 400)
    # the account's own state applies
    w.admin.ok("PATCH", f"/admin/users/{e.id}", {"is_active": False})
    expect("a deactivated account's token is refused", write.call("GET", "/me")[0] == 401)
    w.admin.ok("PATCH", f"/admin/users/{e.id}", {"is_active": True})
    expect("and works again when reactivated", write.call("GET", "/me")[0] == 200)
    # (deactivating also signed the editor out: nothing after this uses their session)
    w.admin.ok("DELETE", f"/admin/users/{e.id}/sessions")
    expect("signing someone out everywhere revokes their tokens", write.call("GET", "/me")[0] == 401)
    log = w.admin.ok("GET", f"/admin/audit?user={e.id}")
    expect("creating and revoking are in the activity log", {"token_created", "token_revoked"} <= {x["kind"] for x in log["entries"]})
    expect("the token never is", r["token"] not in json.dumps(log) and wr["token"] not in json.dumps(log))
    return n[0], problems


def bulk_flow(w: World, f: dict):
    o, v, e, x = w.people["owner"], w.people["viewer"], w.people["editor"], w.people["outsider"]
    problems, checked = [], 0

    def expect(label: str, ok: bool):
        nonlocal checked
        checked += 1
        if not ok:
            problems.append("bulk: " + label)

    url = f"/boards/{f['board']}/cards/bulk"
    a = o.ok("POST", f"/lists/{f['list']}/cards", {"title": "bulk a", "description": ""})["id"]
    c = o.ok("POST", f"/lists/{f['list']}/cards", {"title": "bulk b", "description": ""})["id"]
    cards = lambda: {k["id"]: k for k in o.ok("GET", f"/boards/{f['board']}")["cards"]}

    r = e.ok("POST", url, {"card_ids": [a, c], "action": "move", "list_id": f["list2"]})
    now = cards()
    expect(f"an editor moves both ({r})", r["done"] == 2 and now[a]["list_id"] == f["list2"] and now[c]["list_id"] == f["list2"])
    order = [k["id"] for k in sorted(now.values(), key=lambda k: k["position"]) if k["list_id"] == f["list2"]]
    expect("they keep their order", order.index(a) < order.index(c))
    r = e.ok("POST", url, {"card_ids": [a, c], "action": "update", "changes": {"priority": 2, "title": "renamed by bulk"}})
    now = cards()
    expect("an update changes them all", r["done"] == 2 and now[a]["priority"] == 2 and now[c]["priority"] == 2)
    expect("but never renames", now[a]["title"] == "bulk a")
    r = o.ok("POST", url, {"card_ids": [a, c], "action": "labels", "add": [f["label"]]})
    expect("labels are added", r["done"] == 2 and f["label"] in cards()[c]["label_ids"])
    o.ok("POST", url, {"card_ids": [a], "action": "labels", "remove": [f["label"]]})
    now = cards()
    expect("and removed, from those cards only", f["label"] not in now[a]["label_ids"] and f["label"] in now[c]["label_ids"])
    r = o.ok("POST", url, {"card_ids": [a], "action": "assignees", "add": [x.id]})
    expect(f"only board members can be assigned ({r})", x.id not in cards()[a]["assignee_ids"])

    r = v.ok("POST", url, {"card_ids": [a, c], "action": "update", "changes": {"priority": 0}})
    expect(f"a viewer changes nothing ({r})", r["done"] == 0 and len(r["failed"]) == 2 and cards()[a]["priority"] == 2)
    r = o.ok("POST", url, {"card_ids": [a, f["x_card"]], "action": "update", "changes": {"priority": 1}})
    expect(f"another board's card is refused ({r})", r["done"] == 1 and r["failed"] == [{"id": f["x_card"], "error": "not_found"}])
    xb = x.ok("GET", f"/boards/{f['x_board']}")
    expect("and left alone", next(k for k in xb["cards"] if k["id"] == f["x_card"])["priority"] == 0)
    st, _ = x.call("POST", url, {"card_ids": [a], "action": "watch"})
    expect("an outsider can't use it", st in (403, 404))
    expect("an unknown action is refused", o.call("POST", url, {"card_ids": [a], "action": "explode"})[0] == 400)
    expect("too many cards are refused", o.call("POST", url, {"card_ids": [f"00000000-0000-0000-0000-{i:012d}" for i in range(501)], "action": "watch"})[0] == 400)
    r = v.ok("POST", url, {"card_ids": [a, c], "action": "watch", "watching": True})
    expect("a viewer may watch them", r["done"] == 2 and {a, c} <= set(v.ok("GET", f"/boards/{f['board']}")["watching"]))
    v.ok("POST", url, {"card_ids": [a, c], "action": "watch", "watching": False})
    r = e.ok("POST", url, {"card_ids": [a, c], "action": "archive"})
    expect("archive takes them off the board", r["done"] == 2 and a not in cards() and c not in cards())
    return checked, problems


# ---------------------------------------------------------------- single sign-on

class FakeIdp:
    """A tiny OpenID Connect provider on 127.0.0.1: discovery, authorize (no login form: it signs in whoever
    `next` says), token (checks the client secret, the redirect URI and PKCE) and userinfo. `tamper` changes the
    next ID token, to check that the server refuses it."""

    def __init__(self, client_id: str, secret: str):
        self.client_id, self.secret = client_id, secret
        self.next: dict = {}
        self.tamper: dict = {}
        self.codes: dict = {}
        self.userinfo: dict = {}
        idp = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def send(self, status: int, body: Any = None, location: Optional[str] = None):
                self.send_response(status)
                if location:
                    self.send_header("Location", location)
                data = json.dumps(body).encode() if body is not None else b""
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                u = urllib.parse.urlparse(self.path)
                q = dict(urllib.parse.parse_qsl(u.query))
                if u.path == "/.well-known/openid-configuration":
                    return self.send(200, {"issuer": idp.url, "authorization_endpoint": idp.url + "/authorize", "token_endpoint": idp.url + "/token",
                                           "userinfo_endpoint": idp.url + "/userinfo", "token_endpoint_auth_methods_supported": ["client_secret_basic"]})
                if u.path == "/authorize":
                    if q.get("client_id") != idp.client_id or q.get("response_type") != "code" or q.get("code_challenge_method") != "S256":
                        return self.send(400, {"error": "invalid_request"})
                    code = secrets.token_hex(16)
                    idp.codes[code] = (dict(idp.next), q["nonce"], q["code_challenge"], q["redirect_uri"])
                    sep = "&" if "?" in q["redirect_uri"] else "?"
                    return self.send(302, location=f"{q['redirect_uri']}{sep}code={code}&state={urllib.parse.quote(q['state'])}")
                if u.path == "/userinfo":
                    token = self.headers.get("Authorization", "").removeprefix("Bearer ")
                    return self.send(200, idp.userinfo.get(token, {})) if token in idp.userinfo else self.send(401, {})
                self.send(404, {})

            def do_POST(self):
                if self.path != "/token":
                    return self.send(404, {})
                form = dict(urllib.parse.parse_qsl(self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()))
                basic = base64.b64encode(f"{idp.client_id}:{idp.secret}".encode()).decode()
                if self.headers.get("Authorization") != "Basic " + basic:
                    return self.send(401, {"error": "invalid_client"})
                got = idp.codes.pop(form.get("code", ""), None)
                if got is None:
                    return self.send(400, {"error": "invalid_grant"})
                claims, nonce, challenge, redirect = got
                verifier_hash = base64.urlsafe_b64encode(hashlib.sha256(form.get("code_verifier", "").encode()).digest()).decode().rstrip("=")
                if verifier_hash != challenge or form.get("redirect_uri") != redirect:
                    return self.send(400, {"error": "invalid_grant"})
                now = int(time.time())
                token = dict({"iss": idp.url, "aud": idp.client_id, "exp": now + 300, "iat": now, "nonce": nonce}, **claims)
                token.update(idp.tamper)
                token = {k: v for k, v in token.items() if v is not None}
                b64 = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")
                access = "at-" + secrets.token_hex(8)
                idp.userinfo[access] = {k: v for k, v in claims.items() if v is not None}
                id_token = b64({"alg": "RS256", "kid": "test"}) + "." + b64(token) + ".c2lnbmF0dXJl"
                self.send(200, {"access_token": access, "token_type": "Bearer", "expires_in": 300, "id_token": id_token})

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()


def sso_signin(c: Client, idp: FakeIdp, claims: dict, tamper: Optional[dict] = None, start: str = "/auth/sso/start", mangle=None):
    """The browser's trip: Kanb → provider → Kanb's callback. Returns (status, Location) of the callback."""
    idp.next, idp.tamper = claims, tamper or {}
    if start.startswith("POST "):
        st, r = c.call("POST", start[5:])
        if st != 200:
            return st, None
        to_idp = r["url"]
    else:
        st, to_idp = c.hop(start)
        if st not in (302, 303, 307) or not to_idp or not to_idp.startswith(idp.url):
            return st, to_idp
    st, back = Client("browser at the provider").hop(to_idp)
    if st != 302 or not back:
        return st, back
    # the redirect URI is on PUBLIC_ORIGIN's first address (maybe the dev frontend): call the same path here
    u = urllib.parse.urlparse(back)
    path = u.path.removeprefix("/api") + "?" + (mangle(u.query) if mangle else u.query)
    return c.hop(path)


def sso_flow(w: World):
    problems, checked = [], 0

    def expect(label: str, ok: bool):
        nonlocal checked
        checked += 1
        if not ok:
            problems.append("single sign-on: " + label)

    secret = "idp-secret-" + RUN
    PASSWORDS.append(secret)
    idp = FakeIdp("kanb-" + RUN, secret)
    prev = w.admin.ok("GET", "/admin/sso")
    prev_signup = w.admin.ok("GET", "/admin/signups")
    signup_on = bool(prev.get("signup"))
    conf = {"enabled": True, "issuer": idp.url, "client_id": idp.client_id, "client_secret": secret, "label": "TestIdP",
            "allowed_domains": ["allowed.example"], "trust_email": False, "require_sso": False}
    try:
        st, e = w.admin.call("PUT", "/admin/sso", dict(conf, issuer="http://idp.example.com"))
        expect(f"a plain-http provider (not this machine) is refused ({st} {e})", st == 400 and (e or {}).get("error") == "sso_issuer_https")
        st, e = w.admin.call("PUT", "/admin/sso", dict(conf, client_secret=None, client_id=""))
        expect("can't be switched on half filled in", st == 400)
        view = w.admin.ok("PUT", "/admin/sso", conf)
        expect("saved", view.get("enabled") is True and view.get("has_secret") is True)
        expect("the secret is never sent back", secret not in json.dumps(w.admin.ok("GET", "/admin/sso")))
        expect("the check finds the provider", w.admin.ok("POST", "/admin/sso/test", conf).get("ok") is True)
        expect("the sign-in page shows the button", Client("anon").ok("GET", "/auth/options").get("sso", {}).get("label") == "TestIdP")
        st, e = w.people["owner"].call("PUT", "/admin/sso", dict(conf, enabled=False))
        expect("only a super admin can change it", st == 403)

        # an existing account, matched by its verified email address
        uname = f"authz_{RUN}_sso1"
        email = f"{uname}@example.com"
        w.admin.ok("POST", "/admin/users", {"username": uname, "display_name": "authz sso1", "email": email, "password": "Sso1-" + RUN + "-pw",
                                            "is_super_admin": False, "can_create_boards": True, "locale": "en", "send_invite": False})
        PASSWORDS.append("Sso1-" + RUN + "-pw")
        sub1 = "sub-" + secrets.token_hex(4)
        c = Client("sso1")
        st, loc = sso_signin(c, idp, {"sub": sub1, "email": email, "email_verified": True, "name": "Somchai"})
        expect(f"signs in an existing account by verified email ({st} {loc})", st == 303 and loc == "/")
        me = c.call("GET", "/me")[1] or {}
        expect("as the right person", me.get("username") == uname)
        expect("an admin-set password doesn't block an SSO session", c.call("GET", "/boards")[0] == 200)
        c2 = Client("sso1 again")
        st, loc = sso_signin(c2, idp, {"sub": sub1, "email": "changed-" + email, "email_verified": True})
        expect("the provider account stays connected when its email changes", st == 303 and (c2.call("GET", "/me")[1] or {}).get("username") == uname)
        st, loc = sso_signin(Client("x"), idp, {"sub": "sub-" + secrets.token_hex(4), "email": email, "email_verified": False})
        expect(f"an unverified email never signs in as that account ({loc})", loc == "/login?sso_error=" + ("email_unverified" if signup_on else "no_account"))
        sign_ins = w.admin.ok("GET", "/admin/audit?topic=signin")
        expect("the sign-in is in the activity log as SSO", any(x.get("kind") == "sign_in" and (x.get("data") or {}).get("method") == "sso" for x in (sign_ins or {}).get("entries", [])))

        # forged or broken answers
        for label, tamper, code in [("another app's token", {"aud": "someone-else"}, "wrong_audience"),
                                    ("a token from another provider", {"iss": "https://evil.example.com"}, "wrong_issuer"),
                                    ("an expired token", {"exp": int(time.time()) - 3600}, "expired_token"),
                                    ("a token for another sign-in", {"nonce": "replayed"}, "bad_nonce")]:
            st, loc = sso_signin(Client("x"), idp, {"sub": sub1, "email": email, "email_verified": True}, tamper)
            expect(f"refuses {label} ({loc})", st == 303 and loc == f"/login?sso_error={code}")
        st, loc = sso_signin(Client("x"), idp, {"sub": sub1}, mangle=lambda q: re.sub(r"state=[^&]+", "state=forged", q))
        expect(f"refuses a forged state ({loc})", loc == "/login?sso_error=invalid_state")
        # the callback only works once, and only in the browser that started it
        c3 = Client("x")
        idp.next, idp.tamper = {"sub": sub1, "email": email, "email_verified": True}, {}
        _, to_idp = c3.hop("/auth/sso/start")
        _, back = Client("p").hop(to_idp)
        cb = urllib.parse.urlparse(back)
        cb_path = cb.path.removeprefix("/api") + "?" + cb.query
        st, loc = Client("another browser").hop(cb_path)
        expect(f"another browser can't use the callback ({loc})", loc == "/login?sso_error=expired")
        st, loc = c3.hop(cb_path)
        expect(f"the starting browser can ({loc})", loc == "/")
        st, loc = c3.hop(cb_path)
        expect(f"but only once ({loc})", loc == "/login?sso_error=expired")
        # a wrong client secret: the provider refuses the code
        w.admin.ok("PUT", "/admin/sso", dict(conf, client_secret="wrong-" + RUN))
        st, loc = sso_signin(Client("x"), idp, {"sub": sub1, "email": email, "email_verified": True})
        expect(f"a wrong client secret fails cleanly ({loc})", loc == "/login?sso_error=token_failed")
        w.admin.ok("PUT", "/admin/sso", conf)

        # a deactivated account
        uid1 = me.get("id")
        w.admin.ok("PATCH", f"/admin/users/{uid1}", {"is_active": False})
        st, loc = sso_signin(Client("x"), idp, {"sub": sub1, "email": email, "email_verified": True})
        expect(f"a deactivated account can't sign in ({loc})", loc == "/login?sso_error=account_disabled")
        w.admin.ok("PATCH", f"/admin/users/{uid1}", {"is_active": True})
        c = Client("sso1 after reactivation")  # deactivating signed it out everywhere
        sso_signin(c, idp, {"sub": sub1, "email": email, "email_verified": True})

        # connecting from Profile
        p = w.people["commenter"]
        sub2 = "sub-" + secrets.token_hex(4)
        st, loc = sso_signin(p, idp, {"sub": sub1}, start="POST /me/sso/link")
        expect(f"can't take over a provider account connected to someone else ({loc})", loc == "/profile?tab=security&sso_error=linked_elsewhere")
        st, loc = sso_signin(p, idp, {"sub": sub2, "email": "commenter@elsewhere.example"}, start="POST /me/sso/link")
        expect(f"connects ({loc})", loc == "/profile?tab=security&sso=linked")
        mine = p.ok("GET", "/me/sso")
        expect("Profile lists the connection", len(mine.get("identities", [])) == 1)
        other = Client("sso2")
        st, loc = sso_signin(other, idp, {"sub": sub2})
        expect("now signs in as that person", loc == "/" and (other.call("GET", "/me")[1] or {}).get("id") == p.id)
        if mine.get("identities"):
            ident = mine["identities"][0]["id"]
            expect("nobody else can disconnect it", w.people["viewer"].call("DELETE", f"/me/sso/{ident}")[0] == 404)
            expect("its owner can", p.call("DELETE", f"/me/sso/{ident}")[0] == 200)

        # new people
        if signup_on:
            w.admin.ok("PUT", "/admin/signups", {"approval": "review", "can_create_boards": True})
            st, loc = sso_signin(Client("x"), idp, {"sub": "sub-" + secrets.token_hex(4), "email": f"authz_{RUN}_far@other.example", "email_verified": True})
            expect(f"new accounts only from allowed domains ({loc})", loc == "/login?sso_error=domain_not_allowed")
            new_email = f"authz_{RUN}_new@allowed.example"
            sub3 = "sub-" + secrets.token_hex(4)
            st, loc = sso_signin(Client("x"), idp, {"sub": sub3, "email": new_email, "email_verified": True, "preferred_username": f"authz_{RUN}_new"})
            expect(f"a new account waits for approval ({loc})", loc == "/login?sso_error=pending_approval")
            waiting = {x["username"]: x["id"] for x in w.admin.ok("GET", "/admin/signups")["waiting"]}
            nid = waiting.get(f"authz_{RUN}_new")
            expect("the admin sees it waiting", nid is not None)
            if nid:
                w.admin.ok("POST", "/admin/signups/approve", {"ids": [nid]})
                n = Client("new")
                st, loc = sso_signin(n, idp, {"sub": sub3, "email": new_email, "email_verified": True})
                expect(f"after approval it signs in ({loc})", loc == "/")
                expect("it has no password", (n.call("GET", "/me")[1] or {}).get("has_password") is False)
                st, _ = n.call("POST", "/me/password", {"new_password": "First-" + RUN + "-pw"})
                PASSWORDS.append("First-" + RUN + "-pw")
                expect("and may set a first one without a current password", st == 200)
                expect("which then works", Client("new pw").call("POST", "/auth/login", {"username": f"authz_{RUN}_new", "password": "First-" + RUN + "-pw"})[0] == 200)
                st, _ = n.call("POST", "/me/password", {"new_password": "Second-" + RUN + "-pw"})
                expect("but changing it needs the current one", st == 400)
        else:
            st, loc = sso_signin(Client("x"), idp, {"sub": "sub-" + secrets.token_hex(4), "email": f"authz_{RUN}_nobody@allowed.example", "email_verified": True})
            expect(f"without ALLOW_SIGNUP, unknown people are refused ({loc})", loc == "/login?sso_error=no_account")

        # requiring single sign-on
        viewer = w.people["viewer"]
        w.admin.ok("PUT", "/admin/sso", dict(conf, require_sso=True))
        expect("password sessions of normal accounts end", viewer.call("GET", "/me")[0] == 401)
        st, e = Client("x").call("POST", "/auth/login", {"username": uname, "password": "Sso1-" + RUN + "-pw"})
        expect(f"password sign-in is refused for normal accounts ({st} {e})", st == 403 and (e or {}).get("error") == "sso_required")
        expect("super admins keep their password", Client("admin").call("POST", "/auth/login", {"username": ADMIN_USER, "password": ADMIN_PASSWORD})[0] == 200)
        expect("the admin's own session survives", w.admin.call("GET", "/admin/sso")[0] == 200)
        expect("SSO sessions survive", c.call("GET", "/boards")[0] == 200)
        expect("can't change a password", c.call("POST", "/me/password", {"current_password": "x", "new_password": "Nope-12345678"})[0] == 403)
        if signup_on:
            st, e = Client("x").call("POST", "/auth/register", {"username": f"authz_{RUN}_form", "display_name": "", "email": f"authz_{RUN}_form@allowed.example", "password": "Form-12345678", "locale": "en"})
            expect(f"the sign-up form is closed ({st})", st == 403 and (e or {}).get("error") == "sso_required")
        expect("the sign-in page says so", Client("anon").ok("GET", "/auth/options")["sso"].get("required") is True)
    finally:
        w.admin.call("PUT", "/admin/sso", {"enabled": False, "issuer": prev.get("issuer", ""), "client_id": prev.get("client_id", ""),
                                          "label": prev.get("label", ""), "allowed_domains": prev.get("allowed_domains", []),
                                          "trust_email": prev.get("trust_email", False), "require_sso": False})
        w.admin.call("PUT", "/admin/signups", {"approval": prev_signup.get("approval", "review"), "can_create_boards": prev_signup.get("can_create_boards", True)})
        idp.close()
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
    _, su = w.admin.call("GET", "/admin/signups")
    waiting = [x["id"] for x in (su or {}).get("waiting", []) if str(x.get("username", "")).startswith(prefix)] if isinstance(su, dict) else []
    if waiting:
        w.admin.call("POST", "/admin/signups/reject", {"ids": waiting})
    _, deps = w.admin.call("GET", "/departments")
    for d in deps if isinstance(deps, list) else []:
        if isinstance(d, dict) and str(d.get("name", "")).startswith("authz dept") and (prefix == "authz_" or RUN in str(d.get("name"))):
            w.admin.call("DELETE", f"/admin/departments/{d['id']}")
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
