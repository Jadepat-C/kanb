#!/usr/bin/env python3
"""Every API route in backend/src/main.rs must be in docs/api.md (hand-written docs go stale otherwise).

    python3 tests/api_docs.py
"""
import os
import re
import sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
routes = re.findall(r'\.route\(\s*"([^"]+)"', open(os.path.join(root, "backend/src/main.rs")).read())
docs = open(os.path.join(root, "docs/api.md")).read()
documented = set(re.findall(r"`(/[^`\s]*)`", docs))
missing = [r for r in routes if r not in documented]
if missing:
    print("routes missing from docs/api.md:")
    for r in missing:
        print("  ", r)
    sys.exit(1)
print(f"all {len(routes)} routes are documented")
