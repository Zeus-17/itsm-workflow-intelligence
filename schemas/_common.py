"""
Shared helpers for the constrained-agent-layer schema package (Build Brief Step 2).

IDENTICAL COPY lives in both repos (RM: schemas/_common.py, ITSM: schemas/_common.py).
`check_schemas.py` in each repo verifies the SHA-256 recorded in schemas/COMMON.sha256 so the
two copies cannot silently diverge.

What this module does
---------------------
1.  `to_agent_draft(input_schema)`  - derives the *agent draft* schema from a strictly-typed engine
    input schema.  In a draft, every leaf field must be an explicit envelope:
        {"state": "resolved",   "value": <leaf>, "provenance": "form" | "user_confirmed"}
        {"state": "unresolved", "reason": "declined" | "unknown_to_user" | "not_yet_asked"}
    A field that is simply ABSENT is invalid: the agent must either have a confirmed value or say
    explicitly that it does not.  Model-inferred values are not an allowed provenance - a value the
    model guessed can never become a rule input (Constraints doc Sections 2-3, 8).
2.  `leaf_paths(input_schema)`      - enumerates every leaf input path (e.g. "gates[].status"),
    used to prove that the unresolved-input policy covers every input of every rule.
3.  `result_schema(...)`            - builds the three-state engine result wrapper:
        computed | cannot_be_determined | not_assessed
    "cannot be determined" is deliberately a different shape from any computed verdict so the UI
    can never render it as a negative result (Constraints doc Sections 16.1, 21).
"""
import copy
import hashlib
import json

SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema"

PROVENANCE = {"enum": ["form", "user_confirmed"]}
UNRESOLVED_REASONS = {"enum": ["declined", "unknown_to_user", "not_yet_asked"]}

UNRESOLVED = {
    "type": "object",
    "required": ["state", "reason"],
    "properties": {
        "state": {"const": "unresolved"},
        "reason": {"$ref": "#/$defs/UnresolvedReason"},
    },
    "additionalProperties": False,
}


def resolved_envelope(value_schema):
    """Envelope for a value the agent holds with a trustworthy provenance."""
    return {
        "type": "object",
        "required": ["state", "value", "provenance"],
        "properties": {
            "state": {"const": "resolved"},
            "value": value_schema,
            "provenance": {"$ref": "#/$defs/Provenance"},
        },
        "additionalProperties": False,
    }


def _is_object(s):
    return isinstance(s, dict) and s.get("type") == "object" and "properties" in s


def _is_array_of_objects(s):
    return isinstance(s, dict) and s.get("type") == "array" and _is_object(s.get("items", {}))


SUFFICIENCY_KEYWORDS = ("minLength", "minItems")


def to_agent_draft(schema, relaxed=frozenset(), _path=""):
    """Recursively wrap every leaf of an engine-input schema in a resolved/unresolved envelope.

    `relaxed` = leaf paths whose *sufficiency* constraints (minLength / minItems) are NOT enforced at draft
    level, because the unresolved-policy decides what insufficiency means there (block / not assessed).
    Type, enum and numeric-range constraints are always enforced: a value of the wrong kind is malformed,
    never merely 'insufficient'."""
    s = copy.deepcopy(schema)
    if _is_object(s):
        props = {k: to_agent_draft(v, relaxed, f"{_path}.{k}" if _path else k) for k, v in s["properties"].items()}
        out = {"type": "object", "properties": props, "additionalProperties": False}
        # In a draft EVERY property is required: resolved, or explicitly unresolved.
        out["required"] = list(s["properties"].keys())
        if "description" in s:
            out["description"] = s["description"]
        return out
    if _is_array_of_objects(s):
        # The whole list may be unresolved ("I don't know the gates"), or a list of per-element drafts.
        # minItems is deliberately NOT carried into the draft: an empty list is a legitimate draft, and the
        # engine-input schema (not the draft) decides whether it is acceptable.
        arr = {"type": "array", "items": to_agent_draft(s["items"], relaxed, _path + "[]")}
        wrapped = {"oneOf": [arr, {"$ref": "#/$defs/Unresolved"}]}
        if "description" in s:
            wrapped["description"] = s["description"]
        return wrapped
    # leaf (including arrays of scalars): wrapped as a unit
    leaf = {k: v for k, v in s.items() if k != "description"}
    if _path in relaxed:
        leaf = {k: v for k, v in leaf.items() if k not in SUFFICIENCY_KEYWORDS}
    wrapped = {"oneOf": [resolved_envelope(leaf), {"$ref": "#/$defs/Unresolved"}]}
    if "description" in s:
        wrapped["description"] = s["description"]
    return wrapped


def leaf_paths(schema, prefix=""):
    """Every leaf input path of an engine-input schema, using [] for array elements."""
    s = schema
    if _is_object(s):
        out = []
        for k, v in s["properties"].items():
            out += leaf_paths(v, f"{prefix}.{k}" if prefix else k)
        return out
    if _is_array_of_objects(s):
        # the list itself can be unresolved, so it needs a policy entry as well as its elements
        return [prefix] + leaf_paths(s["items"], prefix + "[]")
    return [prefix]


def result_schema(computed_output_schema, engine_id, completeness=False):
    """Three-state result wrapper for a deterministic engine.

    completeness=True is used for engines whose "nothing found" output could be mistaken for an all-clear
    when a conservative fallback or skipped check was involved: the output then carries `complete`, and the
    schema FORCES complete=false whenever the result has any caveat."""
    out_schema = copy.deepcopy(computed_output_schema)
    computed = {
        "type": "object",
        "required": ["engine", "status", "output", "caveats"],
        "properties": {
            "engine": {"const": engine_id},
            "status": {"const": "computed"},
            "output": out_schema,
            # A computed result produced with a conservative fallback MUST say so.
            "caveats": {"type": "array", "items": {"$ref": "#/$defs/Caveat"}},
        },
        "additionalProperties": False,
    }
    if completeness:
        out_schema["properties"]["complete"] = {
            "type": "boolean",
            "description": "False whenever a fallback or skipped check means 'nothing found' must NOT be read as 'all clear'.",
        }
        out_schema["required"] = list(out_schema.get("required", [])) + ["complete"]
        computed["if"] = {"required": ["caveats"], "properties": {"caveats": {"minItems": 1}}}
        computed["then"] = {"properties": {"output": {"properties": {"complete": {"const": False}}}}}
    missing_branch = lambda status: {
        "type": "object",
        "required": ["engine", "status", "missing"],
        "properties": {
            "engine": {"const": engine_id},
            "status": {"const": status},
            "missing": {"type": "array", "minItems": 1, "items": {"$ref": "#/$defs/MissingInput"}},
        },
        "additionalProperties": False,
    }
    return {"oneOf": [computed, missing_branch("cannot_be_determined"), missing_branch("not_assessed")]}


COMMON_DEFS = {
    "Provenance": PROVENANCE,
    "UnresolvedReason": UNRESOLVED_REASONS,
    "Unresolved": UNRESOLVED,
    "Caveat": {
        "type": "object",
        "required": ["code", "field"],
        "properties": {"code": {"type": "string", "minLength": 1}, "field": {"type": "string", "minLength": 1}},
        "additionalProperties": False,
    },
    "MissingInput": {
        "type": "object",
        "required": ["field", "reason_code"],
        "properties": {"field": {"type": "string", "minLength": 1}, "reason_code": {"type": "string", "minLength": 1}},
        "additionalProperties": False,
    },
}


def dump(path, obj):
    """Deterministic JSON output (stable key order, LF line endings) so regenerated files diff cleanly."""
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, indent=1, ensure_ascii=False)
        f.write("\n")


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        # normalise CRLF so Windows checkouts compare equal to LF blobs
        h.update(f.read().replace(b"\r\n", b"\n"))
    return h.hexdigest()


def policy_markdown(policy_doc, tool_label):
    """Human-readable rendering of unresolved-policy.json (generated; never hand-edited)."""
    L = [f"# {tool_label} - what happens when an input is unresolved", "",
         "*Generated from `unresolved-policy.json` by `build_schemas.py`. Do not edit by hand.*", "",
         policy_doc["description"], "",
         "**Block** = no verdict can be produced; the UI shows the distinct 'cannot be determined' state (or 'not assessed' where the engine would otherwise show nothing).  ",
         "**Fallback** = a named, conservative value is used AND a caveat travels with the result.  ",
         "**Agent may write: no** = only an explicit human action may set the value; the agent can show evidence but never supply it.", ""]
    for eng, ent in policy_doc["engines"].items():
        L += [f"## `{eng}`", "", ent["doc"], ""]
        rules = ent.get("_engine", {}).get("requires_any_of", [])
        for r in rules:
            L.append(f"*Engine-level rule:* at least one of {', '.join('`'+f+'`' for f in r['fields'])} must carry real content, otherwise the result is **{r['status']}** (`{r['reason_code']}`).")
        if rules:
            L.append("")
        L += ["| Input | If unresolved | Result | Agent may write | Why |", "|---|---|---|---|---|"]
        for path, e in ent["inputs"].items():
            if e["on_unresolved"] == "block":
                what = f"**Block** (`{e['reason_code']}`)"
                res = e["block_status"].replace("_", " ")
            else:
                what = f"Fallback `{json.dumps(e['fallback_value'])}`"
                res = f"computed + caveat `{e['caveat_code']}`"
            L.append(f"| `{path}` | {what} | {res} | {e.get('agent_writable', 'yes')} | {e['rationale']} |")
        L.append("")
    return chr(10).join(L)
