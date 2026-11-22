#!/usr/bin/env python3
"""
Fills a Kanb server with a realistic large dataset for performance tests.

    KANB_URL=http://localhost:8080 ADMIN_USER=admin ADMIN_PASSWORD=... python3 tests/perf/seed.py

Creates 20 people (perf_1 … perf_20, password in PERF_PASSWORD, default "Perf-Password-1") and
  - "Big board": 6 columns, 2,000 cards with labels, people, dates, priorities, statuses and Markdown checklists,
    3 comments on every third card, and 50 small attachments
  - 10 more boards with 100 cards each (for search and the cross-board calendar)
Writes the ids the load test needs to tests/perf/seed.json. Use a throwaway server: nothing is cleaned up.
"""

import json
import os
import random
import secrets
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from authz import Client, login  # noqa: E402  (same small HTTP client)

ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
PASSWORD = os.environ.get("PERF_PASSWORD", "Perf-Password-1")
BIG_CARDS = int(os.environ.get("BIG_CARDS", "2000"))
random.seed(42)

WORDS = ("design review deploy fix login search calendar invoice report backup migrate test release notes "
         "customer onboarding marketing budget roadmap mobile layout api webhook import export meeting").split()
THAI = "ออกแบบ ทดสอบ รายงาน ประชุม ลูกค้า งบประมาณ สำรองข้อมูล ปรับปรุง ระบบ แก้ไข".split()


def title(i: int) -> str:
    words = random.sample(THAI if i % 5 == 0 else WORDS, 3)
    return f"{' '.join(words).capitalize()} {i}"


def description() -> str:
    items = "\n".join(f"- [{'x' if random.random() < 0.4 else ' '}] {' '.join(random.sample(WORDS, 4))}" for _ in range(random.randint(2, 6)))
    return f"## Notes\n{' '.join(random.choices(WORDS, k=40))}.\n\n{items}\n"


def make_user(admin: Client, n: int) -> Client:
    name = f"perf_{n}"
    first = "Temp" + secrets.token_hex(6)
    st, _ = admin.call("POST", "/admin/users", {"username": name, "display_name": f"Perf User {n}", "email": None, "password": first,
                                                 "is_super_admin": False, "can_create_boards": True, "locale": "en", "send_invite": False})
    if st == 200:
        c = Client(name)
        c.ok("POST", "/auth/login", {"username": name, "password": first})
        c.ok("POST", "/me/password", {"current_password": first, "new_password": PASSWORD})
    return login(name, PASSWORD)


def fill_board(owner: Client, board_id: str, cards: int, members: list, with_extras: bool) -> list:
    b = owner.ok("GET", f"/boards/{board_id}")
    lists = [l["id"] for l in b["lists"]]
    statuses = [s["id"] for s in b["statuses"]]
    labels = [owner.ok("POST", f"/boards/{board_id}/labels", {"name": n, "color": c})["id"]
              for n, c in zip(["Bug", "Feature", "Design", "Ops", "Docs", "Urgent", "Backend", "Frontend"],
                              ["#e5484d", "#3e63dd", "#8e4ec6", "#12a594", "#f5a524", "#e54666", "#0090ff", "#30a46c"])]
    ids, lock = [], threading.Lock()
    today = time.time()

    def one(i: int):
        lst = lists[i % len(lists)]
        c = owner.ok("POST", f"/lists/{lst}/cards", {"title": title(i), "description": description()})
        due = today + random.randint(-30, 60) * 86400
        patch = {"priority": random.randint(0, 3), "status_id": random.choice(statuses),
                 "due_at": time.strftime("%Y-%m-%dT%H:00:00Z", time.gmtime(due))}
        if random.random() < 0.3:
            patch["start_at"] = time.strftime("%Y-%m-%dT%H:00:00Z", time.gmtime(due - random.randint(1, 10) * 86400))
        owner.ok("PATCH", f"/cards/{c['id']}", patch)
        owner.ok("PUT", f"/cards/{c['id']}/labels", {"ids": random.sample(labels, random.randint(0, 3))})
        owner.ok("PUT", f"/cards/{c['id']}/assignees", {"ids": [m.id for m in random.sample(members, random.randint(0, 2))]})
        if with_extras and i % 3 == 0:
            for k in range(3):
                random.choice(members).ok("POST", f"/cards/{c['id']}/comments", {"body": f"Comment {k}: {' '.join(random.sample(WORDS, 8))}"})
        if with_extras and i % 40 == 0:
            owner.upload(f"/cards/{c['id']}/attachments", f"notes-{i}.txt", (" ".join(random.choices(WORDS, k=2000))).encode())
        with lock:
            ids.append(c["id"])
            if len(ids) % 250 == 0:
                print(f"  {len(ids)} cards", flush=True)

    with ThreadPoolExecutor(8) as pool:
        list(pool.map(one, range(cards)))
    return ids


def main():
    if not ADMIN_PASSWORD:
        raise SystemExit("set ADMIN_PASSWORD (and ADMIN_USER)")
    t0 = time.time()
    admin = login(ADMIN_USER, ADMIN_PASSWORD)
    people = [make_user(admin, n) for n in range(1, 21)]
    owner = people[0]
    print(f"{len(people)} people")

    big = owner.ok("POST", "/boards", {"name": "Big board", "description": "performance test",
                                        "lists": ["Backlog", "To Do", "In Progress", "Review", "Testing", "Done"]})["id"]
    roles = {r["name"]: r["id"] for r in owner.ok("GET", f"/boards/{big}")["roles"]}
    for p in people[1:]:
        owner.ok("POST", f"/boards/{big}/members", {"user_id": p.id, "role_id": roles["Editor"]})
    print("Big board:")
    cards = fill_board(owner, big, BIG_CARDS, people, with_extras=True)

    others = []
    for n in range(10):
        bid = owner.ok("POST", "/boards", {"name": f"Team board {n + 1}", "description": ""})["id"]
        r = {x["name"]: x["id"] for x in owner.ok("GET", f"/boards/{bid}")["roles"]}
        for p in people[1:]:
            owner.ok("POST", f"/boards/{bid}/members", {"user_id": p.id, "role_id": r["Editor"]})
        fill_board(owner, bid, 100, people, with_extras=False)
        others.append(bid)
    print(f"{len(others)} more boards of 100 cards")

    lists = [l["id"] for l in owner.ok("GET", f"/boards/{big}")["lists"]]
    out = {"users": [p.name for p in people], "password": PASSWORD, "big_board": big, "big_lists": lists,
           "big_cards": cards, "other_boards": others}
    Path(__file__).with_name("seed.json").write_text(json.dumps(out))
    print(f"done in {time.time() - t0:.0f}s; wrote tests/perf/seed.json")


if __name__ == "__main__":
    main()
