# Agent layer - validation, audit trail and failsafe (Build Brief Steps 3-4a)

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

## Audit trail (`audit.js`, `audit-schema.json`) - Step 4
ONE log, one envelope, for three purposes: the interaction audit trail, the failsafe fallback log (Step 4a) and the personal-data
pre-filter decision log. Every entry: timestamp, event type, user, provider, outcome, **engine version + fingerprint**, session and
interaction ids, SHA-256 hash chain. 20 strictly-typed event types (`audit-schema.json`; no event can carry a field nobody designed).

* **Inert until used** - creating it writes nothing; the first real event lazily writes a session marker.
* **Complete provenance** - `input_received -> agent_output_received -> validation_result -> engine_run -> display_rendered`, linked by
  `interaction_id`; errors and rejected entries have their own events, so the chain has no silent gaps.
* **Data minimisation** - input the personal-data filter *blocked* is stored only in redacted form (`[REDACTED:category]`).
  Bridged validation events carry field *names* and counts, never values or text. Nothing is transmitted anywhere.
* **Retention** (default 12 months, admin-configurable; warning lead time configurable *independently*, default 30 days):
  calm prompts with lead time that point to the existing export paths and the organisation's records-management policy. Purging is
  always an explicit, named action. Retention is computed from the original timestamp, so **redaction never resets the clock**.
* **Erasure requests** - `retention.redact(id, by, reason)` blanks the personal-data-bearing fields of one entry, keeps the structural
  record, re-seals the hash chain and logs that it did so.
* **Never breaks the caller** - storage full/blocked -> the log keeps entries in memory, flags itself `degraded` (urgent prompt, export
  still complete) and recovers when storage works again.
* **Tamper-evident, not tamper-proof** - detects accidental or casual alteration of data held in the user's own browser.
* **Engine fingerprint** - a hash of the deterministic rule tables and engine function source is recorded on every entry; a change
  produces an `engine_changed` entry even if nobody bumped the version label.
* `usage.summary()` (provider call counts derived from logged entries), `diagnostics()` (deployed version tag, engine version, chain health),
  `exportAll()` (one continuous, ordered record with chain verification).

Run `node agent-layer/tests/audit_run.js`.

## Responsibility acknowledgement
Any move away from the protective default (Block) - globally or per category - requires an attributable acknowledgement (`by`, `at`,
`reason`, `noticeVersion`) of the current, versioned responsibility notice (`AgentLayer.prefilter.responsibilityNotice()`); the version
travels with the logged configuration change. **The notice wording needs genuine legal review before use with personal data.**

## Audit storage - IndexedDB first (Step 4 hardening)
The log lives in **IndexedDB** (a separate, much larger quota), never in the small `localStorage` pool the tool uses for its own saved
data - a growing audit log cannot crowd out the user's releases/incidents. Reads are served from an in-memory mirror; writes are batched
("write-behind"); events logged before the database has opened are queued in order, so nothing is lost and the hash chain stays correct.
Fallbacks: a **capped** `localStorage` (hard cap 1 MB; once reached the log stops persisting, keeps entries in memory for the session,
prompts the user to export, and the next session records how many could not be saved), then memory. Measured in a real browser:
22,000 entries append in under a second, reload to ready in ~170 ms, verify in ~0.6 s.

## Failsafe / circuit breaker (`failsafe.js`) - Step 4a
Watches a **pattern** of provider unreliability per session and, past a threshold, disables the agent layer and routes the user back into
the proven-safe standard form - the same state as toggle-off.
* **Triggers** (all count the same): timeouts, malformed responses, validation rejections, provider/HTTP errors, provider unreachable,
  and **soft-override** (the assistant's narration contradicting the deterministic result - see `checkNarration`).
  *Placeholder thresholds: 2 consecutive, or 3 within 120 s.* **They are not tuned on real provider data** and every diagnostic says so until an
  administrator records a tuning source (`configureThresholds(..., {source, by})`).
* **Standard Mode** is one call, no confirmation, and yields an **identical** hand-off to an automatic fallback. Only values with provenance
  `form`/`user_confirmed` carry across; everything else is an *unconfirmed candidate*; the state is always `incomplete` - never a Go/No-Go.
* **Reasons shown to the user** (calm, plain language): didn't respond in time / response couldn't be understood / explanation didn't match the
  result / switched off by your administrator / no network connection / couldn't reach the service / isn't available right now. Network reasons link
  straight to the IT guidance. Messages are written to be announced to assistive technology (`aria_live`).
* **Admin diagnosis** separates *configuration* (fix the key/model/endpoint) from *provider-side* (outage, rate limit) from *guardrails working*
  (the model contradicted the tool) from *network*; repeated trips on one provider are flagged as a pattern. Diagnostic text is PII-filtered.
* **Connectivity**: "no network at all" and "network up but provider unreachable" are different reasons; the offline state appears only after a few
  seconds of confirmed disconnection (no flicker on a Wi-Fi blip).
* **Emergency revoke** is a separate admin control that **requires explicit confirmation** and a named admin, and survives a reload.
* `FAILSAFE-EVIDENCE.md` (repo root) is an append-only, commit-stamped record: run `python agent-layer/evidence.py --step "<what changed>"`
  after every major step. The provider x failure-type matrix is re-run each time.

## Staying lean
The embedded block is held to a **size budget** (`sizeBudgetKB` in `config.json`, gzipped, currently 60 KB; `python agent-layer/check_size.py`).
Source files stay fully documented; `embed.py` strips comments from the *embedded* copy only. `node agent-layer/tests/artifact_run.js` tests the
block exactly as shipped (compacted, with its bootstrap). Raising the budget is a deliberate decision, not a side-effect.
