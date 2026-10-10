#!/usr/bin/env python3
"""
Size-budget guard for the embedded agent layer (IDENTICAL COPY in both repos; hash-locked).

The agent layer must stay lean: the tools' selling points are that they are single-file, fast and work offline. This check
measures the embedded block, raw and gzipped (GitHub Pages serves gzip), against the budget in config.json
(`sizeBudgetKB`, gzipped). It FAILS when the budget is exceeded - raising the budget is a deliberate, reviewed decision, not
something that happens by accident as features are added.

    python agent-layer/check_size.py
"""
import io
import json
import os
import re
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    cfg = json.load(io.open(os.path.join(HERE, "config.json"), encoding="utf-8"))
    path = os.path.normpath(os.path.join(HERE, cfg["html"]))
    html = io.open(path, encoding="utf-8", newline=None).read()
    m = re.search(r"<!-- AGENT-LAYER:BEGIN[^>]*-->", html)
    if not m:
        print("no agent-layer block embedded")
        return 0
    end = html.rindex("<!-- AGENT-LAYER:END -->") + len("<!-- AGENT-LAYER:END -->")
    block, rest = html[m.start():end], html[:m.start()] + html[end:]
    gz = lambda s: len(zlib.compress(s.encode("utf-8"), 9))
    budget = cfg.get("sizeBudgetKB", 60)
    added = (gz(html) - gz(rest)) / 1024
    print(f"{cfg['tool'].upper()}: tool alone {len(rest)//1024} KB raw / {gz(rest)//1024} KB gzip; agent layer adds {len(block)//1024} KB raw / {added:.1f} KB gzip over the wire")
    print(f"      budget: {budget} KB gzip  ->  {'OK' if added <= budget else 'OVER BUDGET'} ({added/budget*100:.0f}% used)")
    return 0 if added <= budget else 1


if __name__ == "__main__":
    sys.exit(main())
