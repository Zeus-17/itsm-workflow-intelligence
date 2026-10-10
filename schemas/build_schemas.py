#!/usr/bin/env python3
"""
Build the ITSM tool's constrained-agent schema package (Build Brief Step 2).

Reads enum values straight from ../itsm-workflow-tool-v25.html so the schemas cannot drift from what the tool accepts, and writes:
    engine-inputs.schema.json     strictly-typed inputs the deterministic engines consume (no 'unresolved' state)
    agent-drafts.schema.json      same shape, every leaf wrapped in a resolved/unresolved envelope
    engine-outputs.schema.json    three-state results: computed | cannot_be_determined | not_assessed
    unresolved-policy.json        PER FIELD: block, or a named conservative fallback + mandatory caveat
    fixtures/policy-cases.json    conformance cases the Step 3 validation layer (JS) must also pass

Nothing here changes the tool. The deterministic engines remain the only source of severity suggestions, scores and flags.
Run:  python schemas/build_schemas.py   then   python schemas/check_schemas.py
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import (COMMON_DEFS, SCHEMA_DIALECT, dump, policy_markdown, result_schema, sha256_file, to_agent_draft)

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "itsm-workflow-tool-v25.html")
TOOL = "itsm"


# ----------------------------------------------------------------------------- enums from source
def read_source():
    with open(SRC, encoding="utf-8", errors="ignore") as f:
        return f.read()


def select_values(html, element_id, keep_blank=False, drop=()):
    m = re.search(r'<select\b[^>]*\bid="%s"[^>]*>' % re.escape(element_id), html)
    if not m:
        raise SystemExit(f"select #{element_id} not found in source")
    seg = html[m.end(): m.end() + 4000]
    seg = seg[: seg.find("</select>")]
    vals = re.findall(r'<option value="([^"]*)"', seg)
    return [v for v in vals if (keep_blank or v != "") and v not in drop]


def int_options(html, element_id, drop=()):
    return [int(v) for v in select_values(html, element_id) if v not in drop]


def build_enums(html):
    sla = re.search(r"let slaMins=\{([^}]*)\}", html).group(1)
    sev_levels = re.findall(r"(P[1-4]):", sla)
    return {
        "SCORE_USERS": int_options(html, "t1_users", drop=("0",)),        # 0 = "Unknown / not assessed" is NOT an answer
        "SCORE_BUSINESS": int_options(html, "t1_business"),
        "SCORE_WORKAROUND": int_options(html, "t1_workaround"),
        "SCORE_DURATION": int_options(html, "t1_duration"),
        "SCORE_REGULATORY": int_options(html, "t1_regulatory"),
        "SCORE_RECURRING": int_options(html, "t1_recurring"),
        "SEVERITY": sev_levels,
        "INCIDENT_TYPE": select_values(html, "t1_inctype", keep_blank=True),   # '' = "Not classified" (a legitimate state)
        "RF_BLAST": int_options(html, "rf_blast", drop=("0",)),             # 0 = "Select..." (unset)
        "RF_COMPLEXITY": int_options(html, "rf_complexity", drop=("0",)),
        "RF_ROLLBACK": int_options(html, "rf_rollback", drop=("0",)),
        "RF_TESTING": int_options(html, "rf_testing", drop=("0",)),
        "RF_HISTORY": int_options(html, "rf_history", drop=("0",)),
        "RF_TIMING": int_options(html, "rf_timing", drop=("0",)),
        "SUPPORT_STATUS": select_values(html, "sc_support_status", keep_blank=True),
        # certificate status is derived by updateCertField(); vulnerability severities come from addVulnEntry(...)
        "CERT_STATUS": ["unknown", "expired", "critical", "warn", "ok"],
        "VULN_SEVERITY": ["critical", "high", "medium", "advisory"],
    }


# ----------------------------------------------------------------------------- engine definitions
def engines(E):
    s_any = {"type": "string"}
    s_ne = {"type": "string", "minLength": 1}
    count = {"type": "integer", "minimum": 0}
    date_or_blank = {"type": "string", "pattern": r"^(\d{4}-\d{2}-\d{2})?$"}

    incident_score = {
        "input": {"type": "object", "additionalProperties": False,
                  "required": ["users", "business", "workaround", "duration", "regulatory", "recurring"],
                  "properties": {
                      "users": {"enum": E["SCORE_USERS"], "description": "Affected users band 1-5. The form's 0 ('Unknown / not assessed') is deliberately NOT valid here: it scores 0 and silently lowers the suggested tier."},
                      "business": {"enum": E["SCORE_BUSINESS"]},
                      "workaround": {"enum": E["SCORE_WORKAROUND"]},
                      "duration": {"enum": E["SCORE_DURATION"], "description": "Option 4 ('Recurring / seen before') overlaps the separate 'recurring' factor; both are counted by the engine."},
                      "regulatory": {"enum": E["SCORE_REGULATORY"]},
                      "recurring": {"enum": E["SCORE_RECURRING"]}}},
        "output": {"type": "object", "additionalProperties": False, "required": ["total", "suggested_tier", "is_major", "verdict"],
                   "properties": {"total": {"type": "integer", "minimum": 0, "maximum": 25,
                                            "description": "Maximum is 25 although the tool displays 'x / 24'."},
                                  "suggested_tier": {"enum": E["SEVERITY"]},
                                  "is_major": {"type": "boolean"},
                                  "verdict": s_ne}},
        "doc": "updateScore()/calcScore() - six factors summed; P4 0-5, P3 6-10, P2 11-16, P1/Major 17+. A SUGGESTION: the tier is chosen by the user, and a score of 17+ also sets the major-incident flag regardless of the chosen tier.",
    }

    severity_record = {
        "input": {"type": "object", "additionalProperties": False, "required": ["severity"], "properties": {"severity": {"enum": E["SEVERITY"]}}},
        "output": {"type": "object", "additionalProperties": False, "required": ["recorded", "severity"],
                   "properties": {"recorded": {"const": True}, "severity": {"enum": E["SEVERITY"]}}},
        "doc": "setSev() - RECORDS the tier the user picked. The agent layer may present the engine's suggestion but may never choose or set the tier.",
    }

    intel_hint = {
        "input": {"type": "object", "additionalProperties": False, "required": ["incidentType"],
                  "properties": {"incidentType": {"enum": E["INCIDENT_TYPE"]}}},
        "output": {"type": "object", "additionalProperties": False, "required": ["matched"],
                   "properties": {"matched": {"type": "boolean"}, "hint_html": s_any}},
        "completeness": True,
        "doc": "showIntelHint() - one hint per incident type (7 of the 8 types; 'other' and '' show nothing).",
    }

    text_fields = ["shortDescription", "observation", "service", "startedAt", "diagnosis", "assignmentGroup", "ci",
                   "resolvedAt", "resolution", "rootCause", "permanentFix"]
    preflight = {
        "input": {"type": "object", "additionalProperties": False,
                  "required": text_fields + ["severity", "triageScore", "timelineCount", "decisionCount", "regulatoryFlagChecked"],
                  "properties": {**{f: s_any for f in text_fields},
                                 "severity": {"enum": [""] + E["SEVERITY"]},
                                 "triageScore": {"type": "integer", "minimum": 0, "maximum": 25},
                                 "timelineCount": count, "decisionCount": count,
                                 "regulatoryFlagChecked": {"type": "boolean"}}},
        "output": {"type": "object", "additionalProperties": False, "required": ["findings"],
                   "properties": {"findings": {"type": "array", "items": {
                       "type": "object", "additionalProperties": False, "required": ["type", "title"],
                       "properties": {"type": {"enum": ["pf-block", "pf-warn", "pf-info", "pf-good"]}, "title": s_ne}}}}},
        "completeness": True,
        "doc": "generatePreflightFindings() - completeness checks, severity-override warning, and payment / personal-data keyword scans over short description + service. Substring keyword matching: 'Refund' and 'Discard' trigger the payment warning.",
    }

    change_risk = {
        "input": {"type": "object", "additionalProperties": False,
                  "required": ["blast", "complexity", "rollback", "testing", "history", "timing"],
                  "properties": {"blast": {"enum": E["RF_BLAST"]}, "complexity": {"enum": E["RF_COMPLEXITY"]},
                                 "rollback": {"enum": E["RF_ROLLBACK"]}, "testing": {"enum": E["RF_TESTING"]},
                                 "history": {"enum": E["RF_HISTORY"]}, "timing": {"enum": E["RF_TIMING"]}}},
        "output": {"type": "object", "additionalProperties": False, "required": ["total", "level"],
                   "properties": {"total": {"type": "integer", "minimum": 18, "maximum": 120,
                                            "description": "Real range is 18-120 (the tool displays 'x/100'). A total of 0 can only arise from unset factors and is not a valid computed result."},
                                  "level": {"enum": ["low", "medium", "high"]}}},
        "doc": "calcRiskScore() - six factors summed; low <= 30, medium <= 60, high above. With every factor left at 'Select...' the tool shows 'Low Risk - expedited review path'.",
    }

    routing = {
        "input": {"type": "object", "additionalProperties": False, "required": ["observation", "service"],
                  "properties": {"observation": s_any, "service": s_any}},
        "output": {"type": "object", "additionalProperties": False, "required": ["matched"],
                   "properties": {"matched": {"type": "boolean"}, "group": s_ne, "rationale": s_ne}},
        "completeness": True,
        "doc": "suggestRoutingGroup() - 10 keyword rules (custom rules take priority). Highest keyword count wins, ties go to the earlier rule. The two text fields are joined WITHOUT a space before matching.",
    }

    currency = {
        "input": {"type": "object", "additionalProperties": False,
                  "required": ["certificates", "vulnerabilities", "supportStatus", "lastPentest", "lastPatched"],
                  "properties": {
                      "certificates": {"type": "array", "items": {
                          "type": "object", "additionalProperties": False, "required": ["name", "status", "daysLeft"],
                          "properties": {"name": s_any, "status": {"enum": E["CERT_STATUS"]}, "daysLeft": {"type": "integer"}}}},
                      "vulnerabilities": {"type": "array", "items": {
                          "type": "object", "additionalProperties": False, "required": ["severity"],
                          "properties": {"severity": {"enum": E["VULN_SEVERITY"]}}}},
                      "supportStatus": {"enum": E["SUPPORT_STATUS"], "description": "'' = Not checked. 'unknown' raises no risk (current behaviour)."},
                      "lastPentest": date_or_blank, "lastPatched": date_or_blank}},
        "output": {"type": "object", "additionalProperties": False, "required": ["risks"],
                   "properties": {"risks": {"type": "array", "items": s_ne}}},
        "completeness": True,
        "doc": "assessCurrencyRisk() - certificate, vulnerability, support-status, penetration-test and patching signals. An empty list is NOT an all-clear when any input was skipped.",
    }

    sla = {
        "input": {"type": "object", "additionalProperties": False, "required": ["severity", "startedAt", "pausedMinutes"],
                  "properties": {"severity": {"enum": E["SEVERITY"]},
                                 "startedAt": {"type": "string", "minLength": 1, "description": "Incident start time (local date-time)."},
                                 "pausedMinutes": count}},
        "output": {"type": "object", "additionalProperties": False, "required": ["limit_minutes"],
                   "properties": {"limit_minutes": {"type": "integer", "minimum": 1,
                                                    "description": "From slaMins (default P1 60, P2 240, P3 1440, P4 4320); editable in settings."}}},
        "doc": "startSLAClock()/slaMins - the SLA limit for the chosen tier. The running clock itself is display-only.",
    }

    return {"incident_score": incident_score, "severity_record": severity_record, "intel_hint": intel_hint,
            "preflight": preflight, "change_risk": change_risk, "routing_suggestion": routing,
            "currency_risk": currency, "sla_clock": sla}


# ----------------------------------------------------------------------------- unresolved-input policy
def B(reason_code, why, status="cannot_be_determined", agent_writable="yes", on_invalid="reject", invalid_reason_code=None):
    """Hard block. on_invalid: what to do when a RESOLVED value fails the engine-input schema:
         'reject'           -> malformed input, hard-rejected (default)
         'block_as_missing' -> treated exactly like unresolved
         'not_assessed'     -> engine would silently show nothing, so say 'not assessed' instead"""
    d = {"on_unresolved": "block", "reason_code": reason_code, "block_status": status,
         "agent_writable": agent_writable, "on_invalid": on_invalid, "rationale": why}
    if invalid_reason_code:
        d["invalid_reason_code"] = invalid_reason_code
    return d


def F(value, caveat, why, agent_writable="yes", on_invalid="reject"):
    return {"on_unresolved": "fallback", "fallback_value": value, "caveat_code": caveat,
            "agent_writable": agent_writable, "on_invalid": on_invalid, "rationale": why}


def policy():
    P = {}
    NO_NEUTRAL = "No neutral value exists: the form's 0 / 'Unknown' scores as 'no impact', which silently LOWERS the suggested tier."
    P["incident_score"] = {
        "users": B("score_users_unknown", NO_NEUTRAL + " (The form's 'Unknown / not assessed' = 0 is exactly the unresolved state, so it is treated as unresolved, not as an answer.)"),
        "business": B("score_business_unknown", NO_NEUTRAL),
        "workaround": B("score_workaround_unknown", NO_NEUTRAL + " (0 means 'a workaround fully resolves impact' - a real answer, not 'don't know'.)"),
        "duration": B("score_duration_unknown", NO_NEUTRAL),
        "regulatory": B("score_regulatory_unknown", NO_NEUTRAL + " (0 = 'None identified' is a claim about the world, not an absence of information.)"),
        "recurring": B("score_recurring_unknown", NO_NEUTRAL),
    }
    P["severity_record"] = {
        "severity": B("severity_not_chosen", "The tier is the user's decision. The agent may show the engine's suggestion but can never choose it.", agent_writable="no"),
    }
    P["intel_hint"] = {
        "incidentType": F("", "incident_type_not_classified", "'Not classified' is a real state in the form and shows no hint; the caveat stops that being read as 'checked, nothing to flag'."),
    }
    blank = lambda why="": F("", "preflight_field_treated_as_blank", "A blank field is exactly what the pre-flight review exists to report, so treating unresolved as blank is conservative (it raises a finding)." + why)
    scan = lambda: F("", "payment_pii_scan_incomplete", "Blank text means the payment / personal-data keyword scan has nothing to scan: the absence of a warning would be silent, so the caveat is mandatory.")
    P["preflight"] = {
        "shortDescription": scan(), "observation": scan(), "service": scan(),
        "startedAt": blank(), "diagnosis": blank(), "assignmentGroup": blank(), "ci": blank(),
        "resolvedAt": blank(), "resolution": blank(), "rootCause": blank(), "permanentFix": blank(),
        "severity": F("", "severity_override_check_skipped", "No tier means the override warning cannot fire; caveat required."),
        "triageScore": F(0, "severity_override_check_skipped", "A score of 0 makes the engine skip the override comparison; caveat required."),
        "timelineCount": F(0, "timeline_treated_as_empty", "Conservative: raises the 'timeline is empty' prompt."),
        "decisionCount": F(0, "decision_log_treated_as_empty", "Conservative: raises the 'no decisions logged' prompt for P1/P2."),
        "regulatoryFlagChecked": F(False, "regulatory_flag_treated_as_unset", "Conservative: an unset flag makes the payment / personal-data warnings fire."),
    }
    P["change_risk"] = {
        k: B(f"change_risk_{k}_unset", "The form's 'Select...' (0) adds nothing to the total, so an unset factor LOWERS the risk. With all six unset the tool shows 'Low Risk - expedited review path'. No default is safe.")
        for k in ["blast", "complexity", "rollback", "testing", "history", "timing"]
    }
    P["routing_suggestion"] = {
        "observation": F("", "routing_text_partial", "The engine routes on whatever text exists; the caveat says the other field was not considered."),
        "service": F("", "routing_text_partial", "As above."),
    }
    P["currency_risk"] = {
        "certificates": F([], "certificates_not_assessed", "No certificate list means no certificate risk can be raised - an all-clear by omission. Allowed only with the mandatory caveat (output forced to complete=false)."),
        "certificates[].name": F("", "certificate_unnamed", "The engine prints 'unnamed' for a blank name."),
        "certificates[].status": F("unknown", "certificate_status_not_assessed", "'unknown' raises no risk; caveat forces complete=false."),
        "certificates[].daysLeft": B("certificate_days_left_unknown", "The 'expiring in N days' text needs a real number."),
        "vulnerabilities": F([], "vulnerabilities_not_assessed", "As for certificates: omission is not clearance."),
        "vulnerabilities[].severity": B("vulnerability_severity_unknown", "NOT conservative to default: only critical/high are counted, so a defaulted low severity could hide one."),
        "supportStatus": F("", "support_status_not_checked", "'Not checked' is a real form state; caveat required."),
        "lastPentest": F("", "pentest_date_not_assessed", "Blank date skips the staleness check; caveat required."),
        "lastPatched": F("", "patch_date_not_assessed", "Blank date skips the staleness check; caveat required."),
    }
    P["sla_clock"] = {
        "severity": B("sla_severity_missing", "Without a tier there is no SLA limit.", agent_writable="no"),
        "startedAt": B("sla_start_missing", "The tool itself warns that SLA and MTTR are incorrect without a start time; the agent path refuses to produce a limit without one."),
        "pausedMinutes": F(0, "sla_pause_not_applied", "Pauses are an adjustment on top of a valid clock; caveat tells the user none were applied."),
    }
    return P


def engine_rules():
    return {
        "routing_suggestion": {"requires_any_of": [
            {"fields": ["observation", "service"], "status": "not_assessed", "reason_code": "routing_text_missing"}]},
    }


def relaxed_paths(pol_engine):
    return frozenset(p for p, e in pol_engine.items() if e.get("on_invalid") in ("block_as_missing", "not_assessed"))


# ----------------------------------------------------------------------------- conformance cases
def R(v, prov="user_confirmed"):
    return {"state": "resolved", "value": v, "provenance": prov}


def U(reason="declined"):
    return {"state": "unresolved", "reason": reason}


def cases():
    score_ok = {"users": R(3), "business": R(3), "workaround": R(2), "duration": R(2), "regulatory": R(0), "recurring": R(0)}
    pf_ok = {f: R("x") for f in ["shortDescription", "observation", "service", "startedAt", "diagnosis", "assignmentGroup", "ci", "resolvedAt", "resolution", "rootCause", "permanentFix"]}
    pf_ok.update({"severity": R("P2"), "triageScore": R(12), "timelineCount": R(2), "decisionCount": R(1), "regulatoryFlagChecked": R(False)})
    rf_ok = {"blast": R(10), "complexity": R(10), "rollback": R(8), "testing": R(8), "history": R(5), "timing": R(5)}
    return [
        {"id": "score-all-resolved", "engine": "incident_score", "draft": score_ok, "expect": {"status": "ready", "caveats": []}},
        {"id": "score-users-unknown-blocks", "engine": "incident_score", "draft": {**score_ok, "users": U("unknown_to_user")},
         "expect": {"status": "cannot_be_determined", "missing": [{"field": "users", "reason_code": "score_users_unknown"}]}},
        {"id": "score-form-unknown-zero-is-not-an-answer", "engine": "incident_score", "draft": {**score_ok, "users": R(0)},
         "expect": {"status": "rejected"}},
        {"id": "score-regulatory-none-is-a-real-answer", "engine": "incident_score", "draft": {**score_ok, "regulatory": R(0)},
         "expect": {"status": "ready", "caveats": []}},
        {"id": "score-several-missing-all-reported", "engine": "incident_score",
         "draft": {**score_ok, "business": U("not_yet_asked"), "recurring": U("declined")},
         "expect": {"status": "cannot_be_determined", "missing": [{"field": "business", "reason_code": "score_business_unknown"}, {"field": "recurring", "reason_code": "score_recurring_unknown"}]}},
        {"id": "score-model-inferred-rejected", "engine": "incident_score", "draft": {**score_ok, "business": R(4, "model_inferred")},
         "expect": {"status": "rejected"}},
        {"id": "score-value-out-of-range-rejected", "engine": "incident_score", "draft": {**score_ok, "business": R(9)},
         "expect": {"status": "rejected"}},
        {"id": "severity-agent-may-not-choose", "engine": "severity_record", "agent_supplied": ["severity"],
         "draft": {"severity": R("P1", "form")}, "expect": {"status": "rejected", "reason": "agent_may_not_write:severity"}},
        {"id": "severity-unresolved-blocks", "engine": "severity_record", "draft": {"severity": U("not_yet_asked")},
         "expect": {"status": "cannot_be_determined", "missing": [{"field": "severity", "reason_code": "severity_not_chosen"}]}},
        {"id": "intel-type-unresolved-caveat", "engine": "intel_hint", "draft": {"incidentType": U("unknown_to_user")},
         "expect": {"status": "ready", "caveats": [{"code": "incident_type_not_classified", "field": "incidentType"}], "engine_input_contains": {"incidentType": ""}}},
        {"id": "preflight-service-unresolved-scan-caveat", "engine": "preflight", "draft": {**pf_ok, "service": U("declined")},
         "expect": {"status": "ready", "caveats": [{"code": "payment_pii_scan_incomplete", "field": "service"}]}},
        {"id": "preflight-unresolved-regulatory-flag-conservative", "engine": "preflight", "draft": {**pf_ok, "regulatoryFlagChecked": U("not_yet_asked")},
         "expect": {"status": "ready", "caveats": [{"code": "regulatory_flag_treated_as_unset", "field": "regulatoryFlagChecked"}], "engine_input_contains": {"regulatoryFlagChecked": False}}},
        {"id": "change-risk-factor-unset-blocks", "engine": "change_risk", "draft": {**rf_ok, "rollback": U("unknown_to_user")},
         "expect": {"status": "cannot_be_determined", "missing": [{"field": "rollback", "reason_code": "change_risk_rollback_unset"}]}},
        {"id": "change-risk-form-select-zero-rejected", "engine": "change_risk", "draft": {**rf_ok, "blast": R(0)},
         "expect": {"status": "rejected"}},
        {"id": "change-risk-all-resolved", "engine": "change_risk", "draft": rf_ok, "expect": {"status": "ready", "caveats": []}},
        {"id": "routing-both-text-fields-missing-not-assessed", "engine": "routing_suggestion",
         "draft": {"observation": U("not_yet_asked"), "service": U("not_yet_asked")},
         "expect": {"status": "not_assessed", "missing": [{"field": "observation+service", "reason_code": "routing_text_missing"}]}},
        {"id": "routing-one-field-caveat", "engine": "routing_suggestion",
         "draft": {"observation": R("Card declined at checkout"), "service": U("declined")},
         "expect": {"status": "ready", "caveats": [{"code": "routing_text_partial", "field": "service"}]}},
        {"id": "currency-vuln-severity-unresolved-blocks", "engine": "currency_risk",
         "draft": {"certificates": [], "vulnerabilities": [{"severity": U("unknown_to_user")}], "supportStatus": R("active"), "lastPentest": R(""), "lastPatched": R("")},
         "expect": {"status": "cannot_be_determined", "missing": [{"field": "vulnerabilities[0].severity", "reason_code": "vulnerability_severity_unknown"}]}},
        {"id": "currency-cert-list-unresolved-caveats", "engine": "currency_risk",
         "draft": {"certificates": U("not_yet_asked"), "vulnerabilities": [], "supportStatus": U("declined"), "lastPentest": R("2025-01-01"), "lastPatched": R("2025-06-01")},
         "expect": {"status": "ready", "caveats": [{"code": "certificates_not_assessed", "field": "certificates"}, {"code": "support_status_not_checked", "field": "supportStatus"}]}},
        {"id": "currency-bad-date-rejected", "engine": "currency_risk",
         "draft": {"certificates": [], "vulnerabilities": [], "supportStatus": R("active"), "lastPentest": R("last year"), "lastPatched": R("")},
         "expect": {"status": "rejected"}},
        {"id": "sla-start-missing-blocks", "engine": "sla_clock",
         "draft": {"severity": R("P1", "form"), "startedAt": U("unknown_to_user"), "pausedMinutes": R(0)},
         "expect": {"status": "cannot_be_determined", "missing": [{"field": "startedAt", "reason_code": "sla_start_missing"}]}},
        {"id": "sla-pause-unresolved-caveat", "engine": "sla_clock",
         "draft": {"severity": R("P2", "form"), "startedAt": R("2026-10-10T09:00"), "pausedMinutes": U("not_yet_asked")},
         "expect": {"status": "ready", "caveats": [{"code": "sla_pause_not_applied", "field": "pausedMinutes"}]}},
    ]


# ----------------------------------------------------------------------------- generate / main
def generate():
    html = read_source()
    E = build_enums(html)
    eng = engines(E)
    pol = policy()
    rules = engine_rules()
    inputs = {"$schema": SCHEMA_DIALECT, "$id": f"urn:zeus17:{TOOL}:engine-inputs:v1",
              "title": "ITSM engine inputs (strictly typed; no unresolved state)",
              "x-enums-source": "../itsm-workflow-tool-v25.html (regenerated by build_schemas.py; verified by check_schemas.py)",
              "$defs": {k: v["input"] for k, v in eng.items()}}
    drafts = {"$schema": SCHEMA_DIALECT, "$id": f"urn:zeus17:{TOOL}:agent-drafts:v1",
              "title": "ITSM agent drafts (every leaf explicitly resolved or unresolved)",
              "$defs": {**COMMON_DEFS, **{k: to_agent_draft(v["input"], relaxed_paths(pol[k])) for k, v in eng.items()}}}
    outputs = {"$schema": SCHEMA_DIALECT, "$id": f"urn:zeus17:{TOOL}:engine-outputs:v1",
               "title": "ITSM engine results (computed | cannot_be_determined | not_assessed)",
               "$defs": {**COMMON_DEFS, **{k: result_schema(v["output"], k, v.get("completeness", False)) for k, v in eng.items()}}}
    policy_doc = {"$id": f"urn:zeus17:{TOOL}:unresolved-policy:v1",
                  "description": "For every leaf input of every engine: what happens when the input arrives as 'unresolved'. 'block' = no verdict can be produced (UI shows the distinct 'cannot be determined' state). 'fallback' = a named, conservative value is substituted AND a caveat is attached to the result. Model-inferred values are never an allowed provenance.",
                  "engines": {k: {"doc": eng[k]["doc"], **({"_engine": rules[k]} if k in rules else {}), "inputs": pol[k]} for k in eng}}
    return {
        "engine-inputs.schema.json": inputs,
        "agent-drafts.schema.json": drafts,
        "engine-outputs.schema.json": outputs,
        "unresolved-policy.json": policy_doc,
        os.path.join("fixtures", "policy-cases.json"): {"cases": cases(), "enums": E},
    }


def main():
    os.makedirs(os.path.join(HERE, "fixtures"), exist_ok=True)
    out = generate()
    for name, obj in out.items():
        dump(os.path.join(HERE, name), obj)
    with open(os.path.join(HERE, "POLICY.md"), "w", encoding="utf-8", newline=chr(10)) as f:
        f.write(policy_markdown(out["unresolved-policy.json"], "ITSM Workflow Intelligence tool") + chr(10))
    nl = chr(10)
    with open(os.path.join(HERE, "COMMON.sha256"), "w", encoding="utf-8", newline=nl) as f:
        for mod in ("_common.py", "_check_lib.py"):
            f.write(sha256_file(os.path.join(HERE, mod)) + "  " + mod + nl)
    print("wrote", len(out), "files; engines:", ", ".join(out["engine-inputs.schema.json"]["$defs"]))


if __name__ == "__main__":
    main()
