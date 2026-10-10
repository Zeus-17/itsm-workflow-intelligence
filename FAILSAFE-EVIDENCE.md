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

