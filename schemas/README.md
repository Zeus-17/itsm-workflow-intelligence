# Constrained-agent schema package - ITSM Workflow Intelligence (Build Brief Step 2)

Formal schemas for every deterministic engine in the ITSM Workflow Intelligence tool, including what each engine does when a required
input is **unresolved** (the new state the agent layer introduces). Nothing here changes the tool: the engines remain the
only source of verdicts, scores and flags (Constraints doc Sections 2-3, 8).

| File | What it is |
|---|---|
| `engine-inputs.schema.json` | Strictly typed inputs each engine consumes. No "unresolved" state - only these can reach an engine. The standard form is the first consumer of this model (Section 24.2). |
| `agent-drafts.schema.json` | Same shape, but every leaf must be an explicit envelope: `resolved` (provenance `form` or `user_confirmed` only - never model-inferred) or `unresolved` (`declined` / `unknown_to_user` / `not_yet_asked`). An absent field is invalid. |
| `engine-outputs.schema.json` | Three-state results: `computed` (+ caveats) / `cannot_be_determined` / `not_assessed`. A non-answer cannot carry a score, tier or verdict. Engines whose "nothing found" could read as an all-clear carry `complete`, forced `false` whenever a caveat exists. |
| `unresolved-policy.json` | **Per field:** hard block, or a named conservative fallback with a mandatory caveat; plus which fields the agent may never write. Rendered for humans in `POLICY.md`. |
| `fixtures/policy-cases.json` | Conformance cases. The reference resolver (`_check_lib.py`) passes them; the Step 3 JavaScript validation layer must pass the same cases. |
| `build_schemas.py` / `check_schemas.py` | Regenerate from the tool source / verify. Enum values are read from the live HTML, so the schemas cannot silently drift. |
| `_common.py`, `_check_lib.py` | Shared with the other tool's repo and hash-locked in `COMMON.sha256` - the two copies must be identical. |

## Run

```bash
python schemas/build_schemas.py   # regenerate (review the diff!)
python schemas/check_schemas.py   # must print ALL CHECKS PASSED
```

`check_schemas.py` verifies: schemas are valid JSON Schema 2020-12; shared modules unchanged; **no drift vs the tool source**;
**every input of every engine has an unresolved-policy entry**; fallbacks are valid; all conformance cases resolve as designed;
and **real recorded engine outputs** (`tests/*-baseline.json`) fit the output schemas. Requires Python 3 and `pip install jsonschema`.

## Design rules that must not be weakened
1. A value the model inferred is never a rule input.
2. A default is allowed only where it is **conservative** (can only raise a warning or lower a score) AND is reported as a caveat. Where a default could hide a problem it is a hard block.
3. "Cannot be determined" and "not assessed" are different shapes from any computed verdict, so the UI cannot render them as a negative result.
4. Decisions that belong to a person (GO / NO-GO, severity tier) are marked `agent_writable: no`.
