# Failsafe test evidence - ITSM tool

Append-only record. The failsafe is re-tested after every major build step (Build Brief checklist item 2; Constraints Sections 17, 32).
**Trip thresholds are PLACEHOLDERS** until tuned on real provider failure data (Constraints Section 11); every entry below was produced with the thresholds shown.

## 2026-10-10 10:34 UTC - Step 4a - failsafe core + IndexedDB audit store (simulated providers)

* Commit `dc3ca76` - overall: **PASS**
* Failsafe suite: **585 assertions passed, 0 failed**; thresholds: placeholder
* Validation + differential suite: PASS - `ALL TESTS PASSED (2232 assertions)`
* Audit-trail suite: PASS - `ALL AUDIT TESTS PASSED (124 assertions)`
* Embedded artifact (as shipped): PASS - `ALL ARTIFACT TESTS PASSED (41 assertions)`
* Schema package checks: PASS - `ALL CHECKS PASSED`
* Embedded block up to date: PASS - `agent-layer block is up to date`
* Size budget: PASS - `budget: 60 KB gzip  ->  OK (56% used)`

| Failure type \ Provider | claude | openai | gemini | custom |
|---|---|---|---|---|
| repeated timeouts | PASS | PASS | PASS | PASS |
| repeated malformed | PASS | PASS | PASS | PASS |
| repeated validation rejects | PASS | PASS | PASS | PASS |
| repeated soft override | PASS | PASS | PASS | PASS |
| provider unreachable | PASS | PASS | PASS | PASS |
| provider auth error | PASS | PASS | PASS | PASS |
| provider outage or rate | PASS | PASS | PASS | PASS |
| no network | PASS | PASS | PASS | PASS |
| emergency revoke | PASS | PASS | PASS | PASS |

Each cell asserts: breaker trips; correct plain-language reason; calm, accessible message; confirmed entries preserved; no unconfirmed value carried; audit entry names the provider; correct admin diagnosis and recommended action; PII-filtered diagnostics; audit chain intact. Provider ids are simulated until the real adapters exist (Step 5) - adapter-specific causes are tested then.

## 2026-10-10 15:40 UTC - Phase E - engine parity exports (read-only AgentEngine; parity vs the tool's real engines; no change to engine behaviour)

* Commit `6dff1bf` (+ uncommitted changes in tracked files) - overall: **PASS**
* Failsafe suite: **585 assertions passed, 0 failed**; thresholds: placeholder
* Validation + differential suite: PASS - `ALL TESTS PASSED (2232 assertions)`
* Audit-trail suite: PASS - `ALL AUDIT TESTS PASSED (124 assertions)`
* Embedded artifact (as shipped): PASS - `ALL ARTIFACT TESTS PASSED (45 assertions)`
* Schema package checks: PASS - `ALL CHECKS PASSED`
* Embedded block up to date: PASS - `agent-layer block is up to date`
* Size budget: PASS - `budget: 60 KB gzip  ->  OK (62% used)`
* Engine parity: exports vs the tool's real engines (source): PASS - `PARITY PASS: 19750 assertions`
* Engine parity: embedded block as shipped: PASS - `PARITY PASS: 19750 assertions`
* Engine parity: mutation check (the test can fail): PASS - `mutants: 32/32 killed`

| Failure type \ Provider | claude | openai | gemini | custom |
|---|---|---|---|---|
| repeated timeouts | PASS | PASS | PASS | PASS |
| repeated malformed | PASS | PASS | PASS | PASS |
| repeated validation rejects | PASS | PASS | PASS | PASS |
| repeated soft override | PASS | PASS | PASS | PASS |
| provider unreachable | PASS | PASS | PASS | PASS |
| provider auth error | PASS | PASS | PASS | PASS |
| provider outage or rate | PASS | PASS | PASS | PASS |
| no network | PASS | PASS | PASS | PASS |
| emergency revoke | PASS | PASS | PASS | PASS |

Each cell asserts: breaker trips; correct plain-language reason; calm, accessible message; confirmed entries preserved; no unconfirmed value carried; audit entry names the provider; correct admin diagnosis and recommended action; PII-filtered diagnostics; audit chain intact. Provider ids are simulated until the real adapters exist (Step 5) - adapter-specific causes are tested then.

## 2026-10-10 15:57 UTC - Workstream Q - rule quality, invariants and HTML-sink audit (measurement and proposals; no engine change)

* Commit `0c586bf` (+ uncommitted changes in tracked files) - overall: **PASS**
* Failsafe suite: **585 assertions passed, 0 failed**; thresholds: placeholder
* Validation + differential suite: PASS - `ALL TESTS PASSED (2232 assertions)`
* Audit-trail suite: PASS - `ALL AUDIT TESTS PASSED (124 assertions)`
* Embedded artifact (as shipped): PASS - `ALL ARTIFACT TESTS PASSED (45 assertions)`
* Schema package checks: PASS - `ALL CHECKS PASSED`
* Embedded block up to date: PASS - `agent-layer block is up to date`
* Size budget: PASS - `budget: 60 KB gzip  ->  OK (62% used)`
* Engine parity: exports vs the tool's real engines (source): PASS - `PARITY PASS: 19750 assertions`
* Engine parity: embedded block as shipped: PASS - `PARITY PASS: 19750 assertions`
* Engine parity: mutation check (the test can fail): PASS - `mutants: 32/32 killed`
* Invariants / property tests (must-hold properties): PASS - `e.g. {"supportStatus":"unknown","risks":0}`
* Rule-quality measurement runs (informational): PASS - `PROPOSED B phrases handled correctly  30/33 (91%)  | payment-scan FP 1 FN 0; personal-data-scan FP 0 FN 2`
* HTML-sink audit runs (informational): PASS - `escape helper present: true; dynamic-code sites: 4`

| Failure type \ Provider | claude | openai | gemini | custom |
|---|---|---|---|---|
| repeated timeouts | PASS | PASS | PASS | PASS |
| repeated malformed | PASS | PASS | PASS | PASS |
| repeated validation rejects | PASS | PASS | PASS | PASS |
| repeated soft override | PASS | PASS | PASS | PASS |
| provider unreachable | PASS | PASS | PASS | PASS |
| provider auth error | PASS | PASS | PASS | PASS |
| provider outage or rate | PASS | PASS | PASS | PASS |
| no network | PASS | PASS | PASS | PASS |
| emergency revoke | PASS | PASS | PASS | PASS |

Each cell asserts: breaker trips; correct plain-language reason; calm, accessible message; confirmed entries preserved; no unconfirmed value carried; audit entry names the provider; correct admin diagnosis and recommended action; PII-filtered diagnostics; audit chain intact. Provider ids are simulated until the real adapters exist (Step 5) - adapter-specific causes are tested then.

## 2026-10-10 16:47 UTC - Workstream Q engine-change set Q-1..Q-17 (routing, scans, currency prompts, escaping, API-test gate; engine q1)

* Commit `8df6215` (+ uncommitted changes in tracked files) - overall: **PASS**
* Failsafe suite: **585 assertions passed, 0 failed**; thresholds: placeholder
* Validation + differential suite: PASS - `ALL TESTS PASSED (2232 assertions)`
* Audit-trail suite: PASS - `ALL AUDIT TESTS PASSED (124 assertions)`
* Embedded artifact (as shipped): PASS - `ALL ARTIFACT TESTS PASSED (45 assertions)`
* Schema package checks: PASS - `ALL CHECKS PASSED`
* Embedded block up to date: PASS - `agent-layer block is up to date`
* Size budget: PASS - `budget: 60 KB gzip  ->  OK (62% used)`
* Engine parity: exports vs the tool's real engines (source): PASS - `PARITY PASS: 20110 assertions`
* Engine parity: embedded block as shipped: PASS - `PARITY PASS: 20110 assertions`
* Engine parity: mutation check (the test can fail): PASS - `mutants: 32/32 killed`
* Invariants / property tests (must-hold properties): PASS - `F-ITSM-4 holds  0/1  An "unknown" support status raises a risk or a prompt`
* Rule-quality measurement runs (informational): PASS - `ref: B        handled correctly  30/33 (91%)  | payment-scan FP 1 FN 0; personal-data-scan FP 0 FN 2`
* HTML-sink audit runs (informational): PASS - `escape helper present: true; dynamic-code sites: 4`

| Failure type \ Provider | claude | openai | gemini | custom |
|---|---|---|---|---|
| repeated timeouts | PASS | PASS | PASS | PASS |
| repeated malformed | PASS | PASS | PASS | PASS |
| repeated validation rejects | PASS | PASS | PASS | PASS |
| repeated soft override | PASS | PASS | PASS | PASS |
| provider unreachable | PASS | PASS | PASS | PASS |
| provider auth error | PASS | PASS | PASS | PASS |
| provider outage or rate | PASS | PASS | PASS | PASS |
| no network | PASS | PASS | PASS | PASS |
| emergency revoke | PASS | PASS | PASS | PASS |

Each cell asserts: breaker trips; correct plain-language reason; calm, accessible message; confirmed entries preserved; no unconfirmed value carried; audit entry names the provider; correct admin diagnosis and recommended action; PII-filtered diagnostics; audit chain intact. Provider ids are simulated until the real adapters exist (Step 5) - adapter-specific causes are tested then.

