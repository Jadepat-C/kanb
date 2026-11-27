#!/usr/bin/env python3
"""
Upgrade test: data written by an older Kanb must still work after the new version starts on the same database,
file store and SECRET_KEY.

    KANB_URL=http://localhost:8080 ADMIN_USER=… ADMIN_PASSWORD=… python3 tests/upgrade.py seed  STATE_FILE
    (stop the old server, start the new one on the same database)
    KANB_URL=http://localhost:8080 ADMIN_USER=… ADMIN_PASSWORD=… python3 tests/upgrade.py check STATE_FILE

`seed` only uses API calls that exist since 0.1.0. It creates a board with a label, a card with a comment and an
attached file, a second user with two-factor sign-in, and saved email settings with a password (stored encrypted).
`check` reads all of it back through the new server: the file's bytes, the encrypted SMTP password (decrypting it
needs the same SECRET_KEY), and a two-factor sign-in with a fresh code. Standard library only.
"""

import base64
import hashlib
import hmac
import json
import os
import secrets
import struct
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from authz import ADMIN_PASSWORD, ADMIN_USER, Client, login  # noqa: E402


def totp(secret_b32: str, step: int) -> str:
    key = base64.b32decode(secret_b32.replace(" ", "").upper() + "=" * (-len(secret_b32.replace(" ", "")) % 8))
    mac = hmac.new(key, struct.pack(">Q", step), hashlib.sha1).digest()
    o = mac[-1] & 0x0F
    return f"{(struct.unpack('>I', mac[o:o + 4])[0] & 0x7FFFFFFF) % 1_000_000:06d}"


def seed(path: str) -> None:
    admin = login(ADMIN_USER, ADMIN_PASSWORD)
    s = {"file_bytes": secrets.token_hex(64)}
    board = admin.ok("POST", "/boards", {"name": "Upgrade test"})
    s["board"] = board["id"]
    full = admin.ok("GET", f"/boards/{board['id']}")
    lst = full["lists"][0]["id"] if full.get("lists") else admin.ok("POST", f"/boards/{board['id']}/lists", {"name": "To do"})["id"]
    s["list"] = lst
    label = admin.ok("POST", f"/boards/{board['id']}/labels", {"name": "Upgrade", "color": "#3366cc"})
    card = admin.ok("POST", f"/lists/{lst}/cards", {"title": "Survives the upgrade"})
    s["card"] = card["id"]
    admin.ok("PATCH", f"/cards/{card['id']}", {"description": "Written by the old version"})
    admin.ok("PUT", f"/cards/{card['id']}/labels", {"ids": [label["id"]]})
    s["comment"] = admin.ok("POST", f"/cards/{card['id']}/comments", {"body": "a comment from before"})["id"]
    st, att = admin.upload(f"/cards/{card['id']}/attachments", "before.txt", s["file_bytes"].encode())
    assert 200 <= st < 300, (st, att)
    s["file"] = att["id"]

    # stored encrypted with SECRET_KEY
    s["smtp_password"] = "smtp-" + secrets.token_hex(8)
    admin.ok("PUT", "/admin/email", {"enabled": False, "host": "smtp.example.com", "port": 587, "security": "starttls",
                                     "username": "kanb", "password": s["smtp_password"], "from_email": "kanb@example.com",
                                     "from_name": "Kanb", "public_url": ""})

    # single sign-on as 0.4 stored it (one provider; versions before 0.4 have none)
    # (older versions answer unknown addresses with the web page, so look for a real answer)
    st, sso = admin.call("GET", "/admin/sso")
    if st == 200 and isinstance(sso, dict):
        s["sso_secret"] = "sso-" + secrets.token_hex(8)
        admin.ok("PUT", "/admin/sso", {"enabled": False, "issuer": "https://accounts.google.com", "client_id": "upgrade-client",
                                       "client_secret": s["sso_secret"], "label": "Google", "allowed_domains": [], "trust_email": False, "require_sso": False})

    # a second person with two-factor sign-in (its secret is stored encrypted too)
    s["user"], s["password"] = "upgrade_" + secrets.token_hex(3), "Upgrade-" + secrets.token_hex(8)
    first = "Temp-" + secrets.token_hex(8)
    admin.ok("POST", "/admin/users", {"username": s["user"], "display_name": "Upgrade person", "email": None, "password": first,
                                      "is_super_admin": False, "can_create_boards": True, "locale": "en", "send_invite": False})
    u = Client(s["user"])
    u.ok("POST", "/auth/login", {"username": s["user"], "password": first})
    u.ok("POST", "/me/password", {"current_password": first, "new_password": s["password"]})
    u = login(s["user"], s["password"])
    s["totp_secret"] = u.ok("POST", "/me/2fa/setup")["secret"]
    s["totp_step"] = int(time.time()) // 30
    u.ok("POST", "/me/2fa/enable", {"code": totp(s["totp_secret"], s["totp_step"])})
    with open(path, "w") as f:
        json.dump(s, f)
    print("seeded")


def check(path: str) -> int:
    with open(path) as f:
        s = json.load(f)
    fails = []

    def expect(name: str, ok: bool, detail="") -> None:
        print(("ok   " if ok else "FAIL ") + name + ("" if ok else f"  {detail}"))
        if not ok:
            fails.append(name)

    admin = login(ADMIN_USER, ADMIN_PASSWORD)
    st, board = admin.call("GET", f"/boards/{s['board']}")
    expect("board opens", st == 200, st)
    cards = [c for c in (board or {}).get("cards", [])] if isinstance(board, dict) else []
    expect("card is on the board", any(c.get("id") == s["card"] for c in cards))
    st, card = admin.call("GET", f"/cards/{s['card']}")
    expect("card opens", st == 200, st)
    card = card if isinstance(card, dict) else {}
    expect("description kept", "Written by the old version" in json.dumps(card))
    expect("label kept", any(lb.get("name") == "Upgrade" for lb in board.get("labels", [])) if isinstance(board, dict) else False)
    st, tl = admin.call("GET", f"/cards/{s['card']}/timeline")
    expect("comment kept", st == 200 and s["comment"] in json.dumps(tl), st)
    try:
        expect("attached file downloads unchanged", admin.download(f"/files/{s['file']}") == s["file_bytes"].encode())
    except Exception as e:  # noqa: BLE001
        expect("attached file downloads unchanged", False, e)
    st, mail = admin.call("GET", "/admin/email")
    expect("encrypted SMTP password still readable", st == 200 and isinstance(mail, dict) and mail.get("has_password") is True, (st, mail))

    if s.get("sso_secret"):
        st, sso = admin.call("GET", "/admin/sso")
        ps = (sso or {}).get("providers", []) if isinstance(sso, dict) else []
        expect("single sign-on settings carried over (secret kept)", st == 200 and len(ps) == 1 and ps[0].get("client_id") == "upgrade-client"
               and ps[0].get("has_secret") is True and ps[0].get("label") == "Google", (st, sso))

    # a fresh code: the one used to turn 2FA on can't be used again
    while int(time.time()) // 30 <= s["totp_step"]:
        time.sleep(1)
    u = Client(s["user"])
    st, r = u.call("POST", "/auth/login", {"username": s["user"], "password": s["password"]})
    expect("password sign-in asks for the code", st == 200 and isinstance(r, dict) and r.get("totp_required") is True, (st, r))
    if isinstance(r, dict) and r.get("ticket"):
        st, r2 = u.call("POST", "/auth/login/code", {"ticket": r["ticket"], "code": totp(s["totp_secret"], int(time.time()) // 30)})
        expect("two-factor sign-in works (encrypted secret readable)", st == 200, (st, r2))

    print(f"\n{len(fails)} failed" if fails else "\nupgrade check passed")
    return 1 if fails else 0


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in ("seed", "check"):
        raise SystemExit(__doc__)
    if sys.argv[1] == "seed":
        seed(sys.argv[2])
    else:
        sys.exit(check(sys.argv[2]))
