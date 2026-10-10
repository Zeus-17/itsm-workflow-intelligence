#!/usr/bin/env python3
"""
Build agent-layer/audit-schema.json - the ONE log schema shared by the interaction audit trail, the failsafe fallback log
and the personal-data pre-filter decision log (Build Brief Step 4 / Constraints Section 23.3).  IDENTICAL COPY in both repos.

Every entry has the same ENVELOPE (timestamp, event type, user, provider, outcome, engine version, hash chain ...) and a
strictly-typed `detail` that depends on the event type.  Each event type is its own definition `ev_<type>` with
additionalProperties:false at both levels, so an event can never smuggle in a field nobody designed (for example raw text
in an event that is meant to carry counts only).

Design rules encoded here
  * Provenance chain (Brief Step 4): input_received -> agent_output_received -> validation_result -> engine_run ->
    display_rendered, all linked by `interaction_id`; error paths have their own events so the chain is never silently broken.
  * `engine_version` + `engine_fingerprint` on EVERY entry (Brief Section 39 item 3).
  * Retention is computed from `ts` only (never stored), so redaction cannot reset the retention clock (Section 40.3).
  * Tamper-evidence: `prev_hash` / `hash` (SHA-256) chain. Redaction re-seals the chain and says so in a retention_action entry.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))

S = {"type": "string"}
SNE = {"type": "string", "minLength": 1}
SN = {"type": ["string", "null"]}
INT = {"type": "integer", "minimum": 0}
BOOL = {"type": "boolean"}


def obj(**props):
    """Strict object: every listed property required, nothing else allowed."""
    return {"type": "object", "additionalProperties": False, "required": list(props), "properties": props}


def arr(item):
    return {"type": "array", "items": item}


OUTCOMES = ["ok", "allowed", "warned", "blocked", "rejected", "cannot_be_determined", "not_assessed", "fallback", "error", "n_a"]

# --------------------------------------------------------------------------- per-event detail schemas
EVENTS = {
    "session_started": obj(reason={"enum": ["first_event_after_load", "reset"]}),
    "config_changed": obj(
        setting={"enum": ["pii_policy", "payment_terms", "pii_pattern", "provider_lock", "provider_config", "retention", "enhanced_access", "actor"]},
        summary=SNE, notice_version=SN, acknowledged_by=SN),
    "disclosure_acknowledged": obj(disclosure_version=SNE, provider_id=SNE, provider_label=SNE, acknowledged_by=SNE),
    "input_received": obj(
        text=S, text_hash=SNE, text_state={"enum": ["as_entered", "redacted"]},
        pii_categories=arr(SNE), payment_flagged=BOOL, truncated=BOOL),
    "prefilter_decision": obj(
        decision={"enum": ["allow", "warn", "block"]}, payment_flagged=BOOL, payment_terms=INT,
        pii_findings=arr(obj(category=SNE, count=INT, mode={"enum": ["block", "warn", "off"]})), warn_confirmed=BOOL),
    "clarification_asked": obj(field=SNE, text=S),
    "clarification_answered": obj(field=SNE, text=S),
    "agent_output_received": obj(
        fields=arr(obj(path=SNE, state={"enum": ["resolved", "unresolved"]}, value=SN, provenance=SN, reason=SN))),
    "validation_result": obj(
        engine=SNE, status={"enum": ["ready", "cannot_be_determined", "not_assessed", "rejected"]},
        missing=arr(obj(field=SNE, reason_code=SNE)), caveats=arr(obj(code=SNE, field=SNE)), reason=SN),
    "engine_run": obj(engine=SNE, rules_fired=arr(SNE), engine_input=S, raw_output=S),
    "display_rendered": obj(panel={"enum": ["decision", "assistant", "standard_form", "other"]}, text=S, matches_engine_output={"type": ["boolean", "null"]}),
    "provider_call": obj(
        provider_id=SNE, model=SN, purpose={"enum": ["extract", "explain", "narrate", "self_test", "other"]},
        duration_ms={"type": ["integer", "null"], "minimum": 0},
        result={"enum": ["ok", "timeout", "malformed", "error", "blocked_by_guard"]}),
    "failsafe_triggered": obj(
        trigger={"enum": ["timeout", "malformed", "validation_rejected", "soft_override", "provider_error", "connectivity", "emergency_revoke", "manual"]},
        reason_category=SNE, count=INT, window_seconds=INT, state_preserved=BOOL, source={"enum": ["auto", "manual"]}),
    "mode_changed": obj(
        from_mode={"enum": ["standard", "ai"]}, to_mode={"enum": ["standard", "ai"]},
        via={"enum": ["toggle", "standard_mode_button", "failsafe", "admin_revoke"]},
        carried_over_fields=INT, unresolved_candidates=INT),
    "review_flag": obj(flag_id=SNE, kind={"enum": ["payment_regulatory"]}, terms=INT),
    "review_acknowledged": obj(flag_id=SNE, acknowledged_by=SNE),
    "error": obj(
        stage={"enum": ["prefilter", "agent_output", "validation", "engine", "display", "storage", "provider", "audit", "other"]},
        code=SNE, message=S),
    "retention_action": obj(
        action={"enum": ["purge_expired", "redact", "warning_shown", "export", "configure"]},
        count=INT, by=SNE, reason=SN, target_id=SN),
    "engine_changed": obj(previous_fingerprint=SN, current_fingerprint=SNE, label=SNE),
    # one entry per provider failure signal (Step 4a): raw material for the admin diagnostic summary (Section 32.2)
    "provider_failure": obj(
        provider_id=SNE,
        kind={"enum": ["timeout", "malformed", "validation_rejected", "soft_override", "guardrail_violation", "provider_error", "provider_unreachable", "no_network"]},
        diagnosis={"enum": ["configuration", "provider_side", "guardrails_working", "network", "user_network"]},
        http_status={"type": ["integer", "null"], "minimum": 0}, message=S, counted=BOOL),
    "audit_degraded": obj(reason={"enum": ["quota_exceeded", "storage_unavailable", "serialisation_failed", "limit_reached"]}, buffered=INT),
}

ENVELOPE = {
    "schema": {"const": "audit/v1"},
    "id": SNE,
    "seq": {"type": "integer", "minimum": 1},
    "ts": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}"},
    "type": None,                     # filled per definition
    "tool": SNE,
    "tool_version": SNE,
    "engine_version": SNE,
    "engine_fingerprint": SN,
    "session_id": SNE,
    "interaction_id": SN,
    "user": SN,
    "provider": {"type": ["object", "null"], "additionalProperties": False, "required": ["id", "label", "model"],
                 "properties": {"id": SNE, "label": SNE, "model": SN}},
    "outcome": {"enum": OUTCOMES},
    "detail": None,                   # filled per definition
    "redaction": {"type": ["object", "null"], "additionalProperties": False, "required": ["at", "by", "reason", "fields"],
                  "properties": {"at": SNE, "by": SNE, "reason": SNE, "fields": arr(SNE)}},
    "prev_hash": SNE,
    "hash": SNE,
}


def event_def(name, detail):
    props = dict(ENVELOPE)
    props["type"] = {"const": name}
    props["detail"] = detail
    return {"type": "object", "additionalProperties": False, "required": list(props), "properties": props}


def build():
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "urn:zeus17:agent-layer:audit-event:v1",
        "title": "Agent-layer audit event (shared by audit trail, failsafe log and personal-data decision log)",
        "$defs": {f"ev_{name}": event_def(name, d) for name, d in EVENTS.items()},
    }


if __name__ == "__main__":
    doc = build()
    with open(os.path.join(HERE, "audit-schema.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print("wrote audit-schema.json:", len(EVENTS), "event types")
