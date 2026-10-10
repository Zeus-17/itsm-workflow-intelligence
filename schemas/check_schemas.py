#!/usr/bin/env python3
"""
ITSM schema package gate (Build Brief Step 2).  Exit code 0 only if every check passes.
Generic checks live in _check_lib.py (shared, hash-locked); this file adds the ITSM-specific output-fit check.

    python schemas/build_schemas.py     # regenerate from itsm-workflow-tool-v25.html
    python schemas/check_schemas.py     # verify
"""
import json
import os
import sys

from jsonschema import Draft202012Validator

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_schemas as B  # noqa: E402
from _check_lib import run_checks  # noqa: E402


def check_outputs(outputs, check):
    """Real engine outputs recorded in tests/itsm-baseline.json must fit the output schemas."""
    base_path = os.path.join(HERE, "..", "tests", "itsm-baseline.json")
    if not check(os.path.exists(base_path), "tests/itsm-baseline.json not found"):
        return
    base = json.load(open(base_path, encoding="utf-8"))

    def v(engine):
        return Draft202012Validator({"$schema": outputs["$schema"], "$defs": outputs["$defs"], "$ref": f"#/$defs/{engine}"})

    def computed(engine, out):
        return {"engine": engine, "status": "computed", "output": out, "caveats": []}

    n = 0
    verdicts = base["meta"]["verdicts"]
    for fid, row in base["score"].items():          # compact row: total|tier|major|numClass|alerts|Vn|detail
        total, tier, major, _cls, _alerts, vn, _detail = row.split("|")
        out = {"total": int(total), "suggested_tier": tier, "is_major": major == "1", "verdict": verdicts[int(vn[1:])]}
        check(v("incident_score").is_valid(computed("incident_score", out)), f"score output {fid} does not fit")
        n += 1
    for fid, row in base["changeRisk"].items():     # "total | level | verdict | label"
        total, level = [p.strip() for p in row.split("|")[:2]]
        valid = v("change_risk").is_valid(computed("change_risk", {"total": int(total), "level": level}))
        if fid == "risk-unset-all":
            check(not valid, "an all-unset change risk (total 0, 'Low Risk') must NOT validate as a computed result")
        elif fid == "risk-one-unset":
            pass  # a sum of 45 is indistinguishable from a real total; the INPUT schema rejects the unset factor instead
        else:
            check(valid, f"change risk output {fid} does not fit")
            n += 1
    for fid, hint in base["intel"].items():
        out = {"matched": hint is not None, "complete": True}
        if hint is not None:
            out["hint_html"] = hint
        check(v("intel_hint").is_valid(computed("intel_hint", out)), f"intel output {fid} does not fit")
        n += 1
    for fid, titles in base["preflight"].items():
        findings = [{"type": t.split(" | ", 1)[0], "title": t.split(" | ", 1)[1]} for t in titles]
        check(v("preflight").is_valid(computed("preflight", {"findings": findings, "complete": True})), f"preflight output {fid} does not fit")
        n += 1
    for fid, r in base["routing"].items():
        out = {"matched": r is not None, "complete": True}
        if r is not None:
            g, rat = r.split(" | ", 1)
            out.update({"group": g, "rationale": rat})
        check(v("routing_suggestion").is_valid(computed("routing_suggestion", out)), f"routing output {fid} does not fit")
        n += 1
    for fid, risks in base["currency"].items():
        check(v("currency_risk").is_valid(computed("currency_risk", {"risks": risks, "complete": True})), f"currency output {fid} does not fit")
        n += 1
    for tier, mins in base["sla"].items():
        check(v("sla_clock").is_valid(computed("sla_clock", {"limit_minutes": mins})), f"sla output {tier} does not fit")
        n += 1

    # tri-state discipline
    bad = {"engine": "incident_score", "status": "cannot_be_determined", "output": {"total": 0, "suggested_tier": "P4", "is_major": False, "verdict": "x"}}
    check(not v("incident_score").is_valid(bad), "a cannot_be_determined result must not be able to carry a suggested tier")
    # completeness discipline: a caveated empty result must not claim to be complete
    caveated = {"engine": "currency_risk", "status": "computed", "output": {"risks": [], "complete": True},
                "caveats": [{"code": "certificates_not_assessed", "field": "certificates"}]}
    check(not v("currency_risk").is_valid(caveated), "a caveated 'no risks' must not be allowed to claim complete=true")
    check(v("currency_risk").is_valid(dict(caveated, output={"risks": [], "complete": False})), "a caveated 'no risks' with complete=false must be valid")
    print(f"   {n} recorded outputs validated")


if __name__ == "__main__":
    sys.exit(run_checks(HERE, B, "itsm", check_outputs))
