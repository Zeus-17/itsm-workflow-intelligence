#!/usr/bin/env python3
"""
Continuous failsafe-test evidence (Required Deliverable #2; Build Brief checklist).  IDENTICAL COPY in both repos; hash-locked.

The failsafe depends on things that change as the build progresses (more providers, more features that can fail), so it must be
re-tested after EVERY major step - not once at the end. This script re-runs the whole agent-layer gate and APPENDS a dated,
commit-stamped entry to FAILSAFE-EVIDENCE.md (repo root): suite results plus the provider x failure-type matrix.

    python agent-layer/evidence.py --step "Step 4a - failsafe core"
"""
import argparse
import datetime
import io
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
OUT = os.path.join(ROOT, "FAILSAFE-EVIDENCE.md")


def run(cmd, cwd=ROOT):
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd, encoding="utf-8", errors="replace")
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def last_line(out):
    lines = [l for l in out.strip().splitlines() if l.strip()]
    return lines[-1].strip() if lines else ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--step", required=True, help="which build step this evidence belongs to")
    args = ap.parse_args()
    cfg = json.load(io.open(os.path.join(HERE, "config.json"), encoding="utf-8"))
    py = sys.executable
    rc_fs, out_fs = run(["node", "agent-layer/tests/failsafe_run.js", "--json"])
    try:
        fs = json.loads(out_fs)
    except Exception:
        fs = {"pass": 0, "failed": -1, "failures": [out_fs[-300:]], "providers": [], "matrix": {}}
    checks = [
        ("Validation + differential suite", ["node", "agent-layer/tests/run.js"]),
        ("Audit-trail suite", ["node", "agent-layer/tests/audit_run.js"]),
        ("Embedded artifact (as shipped)", ["node", "agent-layer/tests/artifact_run.js"]),
        ("Schema package checks", [py, "schemas/check_schemas.py"]),
        ("Embedded block up to date", [py, "agent-layer/embed.py", "--check"]),
        ("Size budget", [py, "agent-layer/check_size.py"]),
    ]
    results = [(name,) + run(cmd) for name, cmd in checks]
    _, head = run(["git", "rev-parse", "--short", "HEAD"])
    _, dirty = run(["git", "status", "--porcelain", "--untracked-files=no"])
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    allpass = rc_fs == 0 and all(rc == 0 for _, rc, _ in results)

    L = []
    if not os.path.exists(OUT):
        L += ["# Failsafe test evidence - " + cfg["tool"].upper() + " tool", "",
              "Append-only record. The failsafe is re-tested after every major build step (Build Brief checklist item 2; Constraints Sections 17, 32).",
              "**Trip thresholds are PLACEHOLDERS** until tuned on real provider failure data (Constraints Section 11); every entry below was produced with the thresholds shown.", ""]
    L += [f"## {stamp} - {args.step}", "",
          f"* Commit `{head.strip()}`{' (+ uncommitted changes in tracked files)' if dirty.strip() else ''} - overall: **{'PASS' if allpass else 'FAIL'}**",
          f"* Failsafe suite: **{fs.get('pass', 0)} assertions passed, {fs.get('failed', '?')} failed**; thresholds: {fs.get('thresholds', '?')}"]
    for name, rc, out in results:
        L.append(f"* {name}: {'PASS' if rc == 0 else 'FAIL'} - `{last_line(out)[:110]}`")
    provs = fs.get("providers", [])
    if provs:
        L += ["", "| Failure type \\ Provider | " + " | ".join(provs) + " |", "|---|" + "---|" * len(provs)]
        for scen, row in fs.get("matrix", {}).items():
            L.append(f"| {scen.replace('_', ' ')} | " + " | ".join("PASS" if row.get(p) else "**FAIL**" for p in provs) + " |")
        L += ["", "Each cell asserts: breaker trips; correct plain-language reason; calm, accessible message; confirmed entries preserved; no unconfirmed value carried; "
                  "audit entry names the provider; correct admin diagnosis and recommended action; PII-filtered diagnostics; audit chain intact. "
                  "Provider ids are simulated until the real adapters exist (Step 5) - adapter-specific causes are tested then."]
    if fs.get("failures"):
        L += ["", "Failures:"] + ["* " + f for f in fs["failures"][:10]]
    L += [""]
    with io.open(OUT, "a", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(L) + "\n")
    print(("PASS" if allpass else "FAIL"), "- evidence appended to", os.path.relpath(OUT, ROOT))
    return 0 if allpass else 1


if __name__ == "__main__":
    sys.exit(main())
