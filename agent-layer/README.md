# Agent layer - validation (Build Brief Step 3)

The gate between anything an AI provider says and the tool's deterministic rules engines. **Additive and inert:** it only defines
`window.AgentLayer`, references no existing function or element, does nothing until called, and the tool behaves identically with it
present (proved by the engine regression baselines). Remove it any time with `python agent-layer/embed.py --remove`.

| File | Purpose |
|---|---|
| `validation.js` | The module. Shared, identical in both repos, hash-locked (`LOCK.sha256`). |
| `embed.py` | Writes/refreshes the block in the tool's single HTML file (`--check`, `--remove`). Idempotent. |
| `config.json` | Per-tool: HTML path and the payment-flag wording (the regulatory basis differs by tool). |
| `lock.py` | Re-records `LOCK.sha256` after editing a shared file. |
| `tests/run.js` | Node test suite (`node agent-layer/tests/run.js`). |
| `tests/gen_diff_cases.py` | Generates differential cases: the JS schema validator must agree with Python `jsonschema` on every one. |

## What it provides
* **`AgentLayer.validate.draft(engine, draft, {agentSupplied})`** - agent draft -> `ready` (engine-ready input + caveats) /
  `cannot_be_determined` / `not_assessed` / `rejected`. Uses `schemas/unresolved-policy.json`; never coerces, and fills a gap only via a
  named, caveated, conservative fallback. Fields marked `agent_writable: no` (GO/NO-GO, severity tier) can never come from the agent.
* **`AgentLayer.prefilter.check(rawText)`** - ONE combined pass: (a) payment / regulatory-relevant terms -> **flag for mandatory human review,
  never classify**; (b) personal-data shapes (email, phone, National Insurance number, card (Luhn), IBAN, sort code / account number)
  with administrator policy Block / Warn / Off. Default is **fail-closed (Block)**. `Off` is accepted only with an attributable
  acknowledgement (`by`, `at`, `reason`); custom patterns / terms are additive only.
* **`AgentLayer.guard.assertCleared(text, clearance)`** - provider adapters must call this on every user-origin string before sending; it throws
  unless that exact text was cleared (and, for Warn, confirmed).
* **`AgentLayer.review`** - payment flags need a *named* human acknowledgement (records that someone looked; classifies nothing).
* **`AgentLayer.debug`** - persistent, toggleable named breakpoints at layer boundaries. **`AgentLayer.events`** - metadata-only event feed
  (counts and categories, never raw text) for the Step 4 audit trail.

## What it deliberately does not do (yet)
Call the rules engines (several are DOM-bound; invocation adapters come with Steps 5-6), render UI, persist anything, or talk to a network.
The AI toggle (`status().enabled`) stays `false`.
