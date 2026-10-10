#!/usr/bin/env python3
"""Record the SHA-256 of the files that must be identical in the RM and ITSM repos (LOCK.sha256). Run after editing any of them."""
import hashlib, io, os
HERE = os.path.dirname(os.path.abspath(__file__))
FILES = ["validation.js", "audit.js", "failsafe.js", "audit-schema.json", "build_audit_schema.py", "embed.py", "check_size.py", "evidence.py", "tests/run.js", "tests/audit_run.js", "tests/failsafe_run.js", "tests/artifact_run.js", "tests/gen_diff_cases.py", "tests/prefilter-cases.json"]
def sha(p):
    return hashlib.sha256(io.open(os.path.join(HERE, p), "rb").read().replace(b"\r\n", b"\n")).hexdigest()
with io.open(os.path.join(HERE, "LOCK.sha256"), "w", encoding="utf-8", newline="\n") as f:
    for p in FILES:
        f.write(sha(p) + "  " + p + "\n")
print("locked", len(FILES), "files")
