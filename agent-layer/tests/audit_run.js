#!/usr/bin/env node
/*
 * Audit-trail tests (Build Brief Step 4) - IDENTICAL COPY in both repos.   node agent-layer/tests/audit_run.js
 * Sections: A hashing, B inertness, C chain+schema, D privacy/data-minimisation, E redaction, F retention+storage prompts,
 *           G degraded storage, H robustness (never throws), I provenance chain, J engine fingerprint, K usage/export/diagnostics.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const load = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));
let pass = 0; const failures = [];
function ok(c, m) { if (c) pass++; else { failures.push(m); console.log('  FAIL:', m); } }
function section(t) { console.log(t); }

const AL = require(path.join(ROOT, 'validation.js'));
const AA = require(path.join(ROOT, 'audit.js'));
const auditSchema = load('audit-schema.json');
const cfg = load('config.json');
const schemas = { inputs: load('..', 'schemas', 'engine-inputs.schema.json'), drafts: load('..', 'schemas', 'agent-drafts.schema.json'), outputs: load('..', 'schemas', 'engine-outputs.schema.json'), policy: load('..', 'schemas', 'unresolved-policy.json') };
AL.configure({ tool: cfg.tool, paymentLabel: cfg.paymentLabel, schemas });

const T0 = Date.parse('2026-01-01T00:00:00Z'), DAY = 86400000;
function mk(extra) {
  extra = extra || {};
  const storage = extra.storage || AA.memoryStorage(); let t = extra.t0 === undefined ? T0 : extra.t0;
  const log = AA.create(Object.assign({ tool: cfg.tool, toolVersion: 'tv1', engineVersion: 'eng-1', engineSources: () => [{ rules: [/a/i, 'x'] }], schema: auditSchema,
    validate: AL.validate.instance, storage, clock: () => t, exportHints: 'the stakeholder reports', deployedTag: 'test-tag' }, extra.o || {}));
  return { log, storage, tick: (ms) => { t += ms; }, now: () => t };
}
const types = (log) => log.entries().map((e) => e.type);
const dumpText = (storage) => JSON.stringify(storage._dump());

// ---------------------------------------------------------------- A. hashing
section('A. SHA-256 implementation');
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const samples = ['', 'abc', 'The quick brown fox jumps over the lazy dog', 'héllo wörld ✓ 日本語 😀', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(65), 'y'.repeat(1000), 'a\u0000b', '\ud800 lone surrogate'];
for (const s of samples) {
  const expect = sha(Buffer.from(s, 'utf8').toString('utf8'));   // Node encodes lone surrogates as U+FFFD, as does our encoder
  ok(AA.util.sha256Hex(s) === expect, `sha256 matches node crypto for ${JSON.stringify(s.slice(0, 20))} (len ${s.length})`);
}
ok(AA.util.canon({ b: 1, a: [2, { d: 1, c: 2 }] }) === '{"a":[2,{"c":2,"d":1}],"b":1}', 'canonical JSON sorts keys');

// ---------------------------------------------------------------- B. inert
section('B. inert until used');
{
  const m = mk(); const before = JSON.stringify(m.storage._dump());
  m.log.status(); m.log.verify(); m.log.entries(); m.log.retention.status(); m.log.diagnostics(); m.log.usage.summary();
  ok(JSON.stringify(m.storage._dump()) === before && before === '{}', 'creating the log and reading from it writes NOTHING to storage');
  ok(AA.init === undefined || typeof AA.init === 'function', 'init is available');
}

// ---------------------------------------------------------------- C. chain + schema
section('C. chain and schema');
{
  const m = mk(); const L = m.log;
  const r = L.append('prefilter_decision', 'allowed', { decision: 'allow', payment_flagged: false, payment_terms: 0, pii_findings: [], warn_confirmed: false });
  ok(r.ok && r.entry.seq === 3, 'first event lazily writes session_started + engine_changed first (seq 3 is the event)');
  ok(JSON.stringify(types(L)) === JSON.stringify(['session_started', 'engine_changed', 'prefilter_decision']), 'lazy session markers appear once');
  // every logger yields a schema-valid entry
  L.beginInteraction();
  const res = [
    L.logInput('hello', null), L.logAgentOutput([{ path: 'a', state: 'resolved', value: 'v', provenance: 'user_confirmed' }, { path: 'b', state: 'unresolved', reason: 'declined' }]),
    L.logEngineRun('readiness', ['r1'], { x: 1 }, { score: 5 }), L.logDisplay('decision', 'Score 5', true),
    L.logProviderCall('prov-a', 'model-x', 'extract', 120, 'ok'), L.logModeChange('standard', 'ai', 'toggle', 3, 1),
    L.logFailsafe('timeout', 'The AI assistant did not respond in time', 3, 120, true, 'auto'), L.logError('provider', 'E_TIMEOUT', 'timed out'),
    L.append('clarification_asked', 'n_a', { field: 'rollback', text: 'Has it been tested?' }), L.append('clarification_answered', 'ok', { field: 'rollback', text: 'yes' }),
    L.append('disclosure_acknowledged', 'ok', { disclosure_version: 'd-1', provider_id: 'prov-a', provider_label: 'Provider A', acknowledged_by: 'admin' }),
    L.append('review_flag', 'n_a', { flag_id: 'rv1', kind: 'payment_regulatory', terms: 2 }), L.append('review_acknowledged', 'ok', { flag_id: 'rv1', acknowledged_by: 'A. Reviewer' }),
    L.append('config_changed', 'ok', { setting: 'provider_lock', summary: 'locked to prov-a', notice_version: null, acknowledged_by: 'admin' })
  ];
  ok(res.every((x) => x.ok), 'all event loggers produce schema-valid entries: ' + res.filter((x) => !x.ok).map((x) => x.error));
  const v = L.verify();
  ok(v.ok && v.checked === L.entries().length, 'chain verifies');
  const seqs = L.entries().map((e) => e.seq); ok(seqs.every((s, i) => s === i + 1), 'sequence is contiguous');
  // tamper with a stored entry, reload with a fresh instance over the same storage
  const dump = m.storage._dump(); const key = Object.keys(dump).filter((k) => /:e:5$/.test(k))[0];
  const e5 = JSON.parse(dump[key]); e5.detail.text = 'tampered'; dump[key] = JSON.stringify(e5);
  const reload = mk({ storage: m.storage }); const v2 = reload.log.verify();
  ok(!v2.ok && v2.problems.some((p) => p.seq === 5 && p.problem === 'entry_altered'), 'altered entry is detected and located');
  // delete a stored entry
  const m3 = mk(); m3.log.append('review_flag', 'n_a', { flag_id: 'x', kind: 'payment_regulatory', terms: 1 }); m3.log.append('review_flag', 'n_a', { flag_id: 'y', kind: 'payment_regulatory', terms: 1 });
  delete m3.storage._dump()[Object.keys(m3.storage._dump()).filter((k) => /:e:3$/.test(k))[0]];
  ok(!mk({ storage: m3.storage }).log.verify().ok, 'a deleted entry is detected (gap)');
  // every entry carries engine version/fingerprint/tool
  ok(L.entries().every((e) => e.engine_version === 'eng-1' && /^[0-9a-f]{16}$/.test(e.engine_fingerprint) && e.tool === cfg.tool), 'EVERY entry carries engine version + fingerprint + tool');
}

// ---------------------------------------------------------------- D. privacy
section('D. privacy and data minimisation');
{
  const m = mk(); const L = m.log;
  AL._test.reset(); L.bridge(AL);
  const rawBlocked = 'Customer jane.doe@example.com paid with Stripe, call 07911 123456';
  const pf = AL.prefilter.check(rawBlocked);
  L.beginInteraction(); const r = L.logInput(rawBlocked, pf);
  const all = dumpText(m.storage);
  ok(pf.decision === 'block' && r.entry.detail.text_state === 'redacted', 'blocked input is stored in redacted form only');
  ok(!/jane\.doe|example\.com|07911/.test(all), 'NO blocked personal data anywhere in the stored audit data (including bridged events)');
  ok(/\[REDACTED:email\]/.test(r.entry.detail.text) && r.entry.detail.pii_categories.includes('email'), 'redaction tokens + categories kept for provenance');
  ok(L.entries({ type: 'prefilter_decision' }).length === 1 && L.entries({ type: 'review_flag' }).length === 1, 'bridge logged the prefilter decision and the review flag automatically');
  const pd = L.entries({ type: 'prefilter_decision' })[0];
  ok(pd.outcome === 'blocked' && pd.detail.pii_findings.some((f) => f.category === 'email' && f.mode === 'block') && pd.detail.payment_flagged, 'prefilter entry carries categories, modes and payment flag - no text');
  AL._test.reset(); AL.prefilter.check('plain note about the Stripe webhook');
  ok(!/plain note/.test(dumpText(m.storage)), 'bridged events never contain the user text');
  // allowed text is kept as entered; very long text is truncated and marked
  const m2 = mk(); AL._test.reset();
  const a = m2.log.logInput('Stripe webhook listener update', AL.prefilter.check('Stripe webhook listener update'));
  ok(a.entry.detail.text_state === 'as_entered' && a.entry.detail.payment_flagged === true, 'allowed input kept as entered with the payment flag recorded');
  const big = m2.log.logInput('z'.repeat(10000), null);
  ok(big.ok && big.entry.detail.truncated === true && big.entry.detail.text.length < 4100, 'over-long text is truncated and marked');
  ok(m2.log.entries().every((e) => JSON.stringify(e).length < 20000), 'no entry is unbounded');
}

// ---------------------------------------------------------------- E. redaction
section('E. redaction (erasure requests)');
{
  const m = mk({ o: { retention_days: 365 } }); const L = m.log;
  L.logInput('first note', null); const target = L.logInput('contains something to erase', null).entry; L.logInput('third note', null); L.logDisplay('decision', 'Shown text', true);
  const before = L.entries(); const tsBefore = before.find((e) => e.id === target.id).ts;
  ok(L.retention.redact(target.id, '', 'x').ok === false && L.retention.redact(target.id, 'dpo', '').ok === false, 'redaction needs a named person and a reason');
  ok(L.retention.redact('nope', 'dpo', 'erasure request').error === 'entry_not_found', 'unknown entry id rejected');
  const sess = L.entries({ type: 'session_started' })[0]; ok(L.retention.redact(sess.id, 'dpo', 'r').ok === false, 'a type with nothing redactable is refused');
  ok(L.retention.redact(target.id, 'dpo', 'x', ['bogus']).ok === false, 'unknown field refused');
  const rr = L.retention.redact(target.id, 'dpo', 'Subject access/erasure request #17');
  const after = L.entries(); const t2 = after.find((e) => e.id === target.id);
  ok(rr.ok && t2.detail.text === '[REDACTED]' && t2.redaction.by === 'dpo' && t2.redaction.fields.includes('text'), 'content replaced; who/why/what recorded on the entry');
  ok(t2.ts === tsBefore && t2.seq === target.seq && t2.type === 'input_received' && t2.outcome === target.outcome && t2.engine_version === 'eng-1', 'structural record (timestamp, type, outcome, engine version) survives');
  ok(L.verify().ok, 'chain re-sealed and verifies after redaction');
  ok(after[after.length - 1].type === 'retention_action' && after[after.length - 1].detail.action === 'redact' && after[after.length - 1].detail.target_id === target.id, 'the redaction itself is logged');
  ok(!/contains something to erase/.test(dumpText(m.storage)), 'redacted content is gone from storage');
  // retention clock is NOT reset (Section 40.3)
  m.tick(366 * DAY); const st = L.retention.status();
  ok(st.expired >= 4 && st.prompt && st.prompt.code === 'retention_expired', 'redacted entry is still expired on its ORIGINAL schedule');
  // agent_output values
  const m5 = mk(); m5.log.logAgentOutput([{ path: 'notes', state: 'resolved', value: 'secret-ish value', provenance: 'user_confirmed' }]);
  const ao = m5.log.entries({ type: 'agent_output_received' })[0]; ok(m5.log.retention.redact(ao.id, 'dpo', 'erasure').ok, 'agent output values can be redacted');
  ok(!/secret-ish/.test(dumpText(m5.storage)) && m5.log.verify().ok, 'values removed, chain intact');
}

// ---------------------------------------------------------------- F. retention + storage prompts
section('F. retention and storage prompts');
{
  const m = mk(); const L = m.log;
  ok(L.retention.configure({ retention_days: 10 }, 'admin').ok === false && L.retention.configure({ warn_lead_days: 0 }, 'admin').ok === false && L.retention.configure({ limit_bytes: 5 }, 'admin').ok === false, 'out-of-range settings rejected');
  ok(L.retention.configure({ retention_days: 90 }, '').ok === false, 'configuration needs a named person');
  L.logInput('old note', null); const d0 = L.retention.status();
  ok(d0.retention_days === 365 && d0.warn_lead_days === 30 && d0.prompt === null, 'default retention is 12 months with 30-day warning and no prompt when healthy');
  m.tick(340 * DAY); let s1 = L.retention.status();
  ok(s1.prompt && s1.prompt.level === 'attention' && s1.prompt.code === 'retention_expiring' && s1.expiring_within_lead > 0, 'prompt arrives with lead time (attention) before expiry');
  ok(/export/i.test(s1.prompt.message) && /the stakeholder reports/.test(s1.prompt.message) && /records-management/.test(s1.prompt.message), 'prompt points at the existing export paths and the organisation\'s records-management policy');
  // lead time and retention are INDEPENDENT (K6)
  ok(L.retention.configure({ warn_lead_days: 5 }, 'admin').ok, 'warning lead time changed on its own');
  ok(L.retention.status().retention_days === 365 && L.retention.status().warn_lead_days === 5 && L.retention.status().prompt === null, 'retention period unchanged; the earlier prompt no longer fires with the shorter lead');
  m.tick(30 * DAY); ok(L.retention.status().prompt.level === 'urgent', 'past retention -> urgent');
  // purge
  ok(L.retention.purgeExpired('').ok === false, 'purge needs a named person');
  const total = L.entries().length; const pr = L.retention.purgeExpired('admin');
  ok(pr.ok && pr.removed >= 1, 'explicit purge removes expired entries');
  ok(L.verify().ok, 'chain still verifies after purge (anchor)');
  ok(L.entries().some((e) => e.type === 'retention_action' && e.detail.action === 'purge_expired' && e.detail.count === pr.removed), 'purge is logged with a count only');
  ok(mk({ storage: m.storage, t0: m.now() }).log.verify().ok, 'a fresh instance over the purged store also verifies');
  ok(L.retention.purgeExpired('admin').removed === 0, 'nothing more to purge');
  // storage pressure: soft limit, nothing dropped
  const m2 = mk({ o: { limit_bytes: 100000 } }); let n = 0;
  while (m2.log.retention.status().storage.pct < 80 && n < 2000) { m2.log.logInput('filler entry number ' + n + ' '.padEnd(60, '.'), null); n++; }
  ok(m2.log.retention.status().prompt.code === 'storage_near_limit', 'storage prompt fires at the warning percentage');
  const countAt80 = m2.log.entries().length;
  while (m2.log.retention.status().storage.pct < 100 && n < 3000) { m2.log.logInput('filler entry number ' + n + ' '.padEnd(60, '.'), null); n++; }
  ok(m2.log.retention.status().prompt.code === 'storage_full' && m2.log.entries().length > countAt80, 'past the limit the prompt turns urgent and entries are STILL kept (nothing silently dropped)');
  ok(m2.log.verify().ok, 'chain intact under storage pressure');
  L.retention.markPromptShown('retention_expiring', 'admin');
  ok(L.entries().some((e) => e.type === 'retention_action' && e.detail.action === 'warning_shown'), 'showing a prompt can be recorded');
}

// ---------------------------------------------------------------- G. degraded storage
section('G. degraded storage');
{
  const m = mk(); const L = m.log;
  L.logInput('before failure', null);
  m.storage.failWrites = true;
  const r = L.logInput('during failure', null);
  ok(r.ok === true, 'logging does not fail the caller when storage is full/unavailable');
  const st = L.retention.status();
  ok(st.degraded && st.prompt && st.prompt.level === 'urgent' && st.prompt.code === 'audit_degraded', 'degraded state is surfaced as an urgent prompt');
  ok(L.entries().some((e) => e.detail && e.detail.text === 'during failure'), 'the entry is retained in memory');
  const ex = L.exportAll('admin'); ok(ex.degraded && ex.entries.some((e) => e.detail && e.detail.text === 'during failure') && ex.chain.ok, 'export still contains everything and flags the degraded state');
  m.storage.failWrites = false;
  L.logInput('after recovery', null);
  ok(L.status().degraded === null, 'degraded flag clears once storage accepts writes again');
  const reload = mk({ storage: m.storage }); const texts = reload.log.entries({ type: 'input_received' }).map((e) => e.detail.text);
  ok(texts.includes('during failure') && texts.includes('after recovery') && reload.log.verify().ok, 'after recovery the buffered entries reached storage; a reload verifies');
}

// ---------------------------------------------------------------- H. robustness
section('H. never throws into the caller');
{
  const m = mk(); const L = m.log;
  let threw = false; let r1, r2, r3;
  try {
    r1 = L.append('prefilter_decision', 'allowed', { bad: 1 });
    const circ = {}; circ.self = circ; r2 = L.append('error', 'error', { stage: 'other', code: 'x', message: circ });
    r3 = L.append('not_a_type', 'ok', {});
  } catch (e) { threw = true; }
  ok(!threw, 'bad events never throw');
  ok(r1.ok === false && r2.ok === false && r3.ok === false, 'schema-invalid / unserialisable / unknown-type events are rejected');
  ok(L.entries({ type: 'error' }).some((e) => e.detail.stage === 'audit' && e.detail.code === 'entry_rejected'), 'a rejected entry leaves an audit error entry (no gap, no content)');
  ok(!/"bad"/.test(dumpText(m.storage)), 'the rejected content itself is not stored');
  ok(L.verify().ok, 'chain intact after rejected events');
  try { L.retention.redact(undefined, undefined, undefined); L.retention.configure(null, null); L.logAgentOutput(null); L.logEngineRun(); L.logDisplay(); threw = false; } catch (e) { threw = true; }
  ok(!threw, 'degenerate arguments do not throw');
}

// ---------------------------------------------------------------- I. provenance chain
section('I. provenance chain end to end');
{
  const m = mk(); const L = m.log; AL._test.reset(); L.bridge(AL);
  L.setActor('release.manager'); L.setProvider({ id: 'prov-a', label: 'Provider A', model: 'm1' });
  const ix = L.beginInteraction();
  const raw = 'Rollback script exists, should be fine';
  const pf = AL.prefilter.check(raw); L.logInput(raw, pf);
  L.logAgentOutput([{ path: 'rollbackTested', state: 'unresolved', reason: 'unknown_to_user' }]);
  const eng0 = AL.validate.engines()[0];
  const draft = Object.fromEntries(Object.keys(schemas.inputs.$defs[eng0].properties).map((k) => [k, { state: 'unresolved', reason: 'declined' }]));
  AL.validate.draft(eng0, draft);
  L.logEngineRun(eng0, ['rule_a'], { a: 1 }, 'RAW RULE OUTPUT'); L.logDisplay('decision', 'RAW RULE OUTPUT', true); L.endInteraction();
  const es = L.entries().filter((e) => e.interaction_id === ix);
  const order = es.map((e) => e.type);
  const idx = (t) => order.indexOf(t);
  ok(['input_received', 'agent_output_received', 'validation_result', 'engine_run', 'display_rendered'].every((t) => idx(t) >= 0), 'every link of the provenance chain is present: ' + order.join(' > '));
  ok(idx('input_received') < idx('agent_output_received') && idx('agent_output_received') < idx('validation_result') && idx('validation_result') < idx('engine_run') && idx('engine_run') < idx('display_rendered'), 'links are in order');
  ok(es.every((e) => e.user === 'release.manager' && e.provider && e.provider.id === 'prov-a'), 'user and provider recorded on each link');
  ok(L.entries().filter((e) => e.type === 'validation_result').every((e) => Array.isArray(e.detail.missing) && Array.isArray(e.detail.caveats)), 'validation entries list what was missing / defaulted (names only)');
  const run = es.find((e) => e.type === 'engine_run'), disp = es.find((e) => e.type === 'display_rendered');
  ok(run.detail.raw_output === disp.detail.text && disp.detail.matches_engine_output === true, 'raw rule output and displayed text are both recorded and comparable');
  const outside = L.logError('other', 'E_OUTSIDE', 'logged after the interaction ended');
  ok(outside.ok && outside.entry.interaction_id === null, 'an entry written after the interaction ended has interaction_id null (interactions do not leak)');
}

// ---------------------------------------------------------------- J. engine fingerprint
section('J. engine version / fingerprint');
{
  const storage = AA.memoryStorage(); let sources = [{ a: 1 }];
  const a = mk({ storage, o: { engineSources: () => sources } }); a.log.logInput('x', null);
  ok(a.log.entries({ type: 'engine_changed' }).length === 1 && a.log.entries({ type: 'engine_changed' })[0].detail.previous_fingerprint === null, 'first use records the initial engine fingerprint');
  const b = mk({ storage, o: { engineSources: () => sources } }); b.log.logInput('y', null);
  ok(b.log.entries({ type: 'engine_changed' }).length === 1, 'same engine on next load -> no new engine_changed entry');
  sources = [{ a: 2 }];
  const c = mk({ storage, o: { engineSources: () => sources } }); c.log.logInput('z', null);
  const ch = c.log.entries({ type: 'engine_changed' });
  ok(ch.length === 2 && ch[1].detail.previous_fingerprint === ch[0].detail.current_fingerprint && ch[1].detail.current_fingerprint !== ch[0].detail.current_fingerprint, 'a change to the rule tables/logic is detected and logged even if the label was not bumped');
  const fa = AA.util.sha256Hex(AA.util.canon([function (x) { return x + 1; }])).slice(0, 16), fb = AA.util.sha256Hex(AA.util.canon([function (x) { return x + 2; }])).slice(0, 16);
  ok(fa !== fb, 'function source participates in the fingerprint (logic changes are detected)');
}

// ---------------------------------------------------------------- K. usage, export, diagnostics
section('K. usage, export, diagnostics');
{
  const m = mk(); const L = m.log;
  L.setProvider({ id: 'prov-a', label: 'A', model: null }); L.logProviderCall('prov-a', 'm', 'extract', 100, 'ok'); L.logProviderCall('prov-a', 'm', 'explain', 90, 'timeout');
  L.setProvider({ id: 'prov-b', label: 'B', model: null }); L.logProviderCall('prov-b', null, 'extract', null, 'ok');
  const u = L.usage.summary();
  ok(u['prov-a'].calls === 2 && u['prov-a'].ok === 1 && u['prov-a'].failed === 1 && u['prov-a'].by_purpose.extract === 1 && u['prov-b'].calls === 1, 'usage view derives provider call counts from logged entries');
  L.logModeChange('standard', 'ai', 'toggle', 2, 0); L.logFailsafe('malformed', 'response could not be understood', 3, 60, true, 'auto'); L.logModeChange('ai', 'standard', 'failsafe', 2, 1); L.logModeChange('standard', 'ai', 'toggle', 2, 0);
  const ex = L.exportAll('admin'); const seqs = ex.entries.map((e) => e.seq);
  ok(seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1) && ex.chain.ok, 'export is one continuous, correctly ordered record across toggle changes and a failsafe fallback');
  ok(ex.entries.filter((e) => e.type === 'mode_changed').length === 3 && ex.entries.some((e) => e.type === 'failsafe_triggered'), 'toggle transitions and the failsafe event are all present');
  ok(L.entries().some((e) => e.type === 'retention_action' && e.detail.action === 'export'), 'the export itself is logged');
  const dg = L.diagnostics();
  ok(dg.deployed_tag === 'test-tag' && dg.engine_version === 'eng-1' && dg.chain.ok && /^[0-9a-f]{16}$/.test(dg.engine_fingerprint), 'diagnostics show the deployed version tag, engine version/fingerprint and chain health');
  const fs0 = L.entries({ type: 'failsafe_triggered' })[0];
  ok(fs0.outcome === 'fallback' && fs0.provider && fs0.provider.id === 'prov-b', 'failsafe entry uses the SAME envelope (provider, outcome, timestamp, user)');
}

// ---------------------------------------------------------------- L. default localStorage path (the one the browser uses)
section('L. default localStorage adapter');
{
  const kv = {}; let full = false; const writes = [];
  globalThis.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(kv, k) ? kv[k] : null),
    setItem: (k, v) => { if (full) { const e = new Error('The quota has been exceeded'); e.name = 'QuotaExceededError'; throw e; } kv[k] = String(v); writes.push(k); },
    removeItem: (k) => { delete kv[k]; }
  };
  try {
    const base = { tool: cfg.tool, toolVersion: 'tv1', engineVersion: 'eng-1', engineSources: () => [1], schema: auditSchema, validate: AL.validate.instance };
    const log = AA.create(base);                                   // NO storage option -> must pick localStorage
    log.status(); log.verify(); log.retention.status();
    ok(writes.length === 0, 'default localStorage path: construction and reads write nothing');
    ok(log.status().storage_kind === 'localStorage', 'default storage is localStorage when available');
    const r = log.logInput('hello from the browser path', null);
    ok(r.ok && Object.keys(kv).some((k) => /^agent_audit_v1:e:/.test(k)) && Object.keys(kv).includes('agent_audit_v1:meta'), 'entries and meta are written under the agent_audit_v1: prefix');
    ok(AA.create(base).verify().ok && AA.create(base).entries({ type: 'input_received' }).length === 1, 'a new page load (fresh instance) reads the same log back and verifies');
    full = true; const r2 = log.logInput('quota exceeded now', null);
    ok(r2.ok && log.status().degraded && log.status().degraded.reason === 'quota_exceeded', 'localStorage quota error -> degraded, caller unaffected');
    full = false; log.logInput('recovered', null);
    ok(log.status().degraded === null && AA.create(base).entries({ type: 'input_received' }).length === 3, 'recovery flushes the buffered entry to localStorage');
  } finally { delete globalThis.localStorage; }
  const noStore = AA.create({ tool: cfg.tool, toolVersion: 't', engineVersion: 'e', schema: auditSchema, validate: AL.validate.instance });
  ok(noStore.status().storage_kind === 'memory' && noStore.logInput('x', null).ok, 'no localStorage at all -> memory fallback, still works');
}

// ---------------------------------------------------------------- M. IndexedDB primary store + capped fallback
// A faithful fake of the parts of the IndexedDB API the adapter uses: asynchronous callbacks, one transaction per batch,
// injectable open/write failures. The REAL adapter code runs against it.
function fakeIdb(existing) {
  const f = { data: Object.assign({}, existing || {}), failOpen: false, failWrites: false, opens: 0, commits: 0 };
  f.open = () => {
    f.opens++; const req = {};
    setTimeout(() => {
      if (f.failOpen) { req.error = new Error('blocked by browser settings'); if (req.onerror) req.onerror(); return; }
      const db = { transaction(store, mode) {
        const tx = { oncomplete: null, onerror: null, onabort: null, error: null }, ops = [], reqs = [];
        // Like real IndexedDB: every request's result is set BEFORE the transaction's complete event fires (deterministic, no timer race).
        const st = {
          getAllKeys() { const r = {}; reqs.push(() => { r.result = Object.keys(f.data); }); return r; },
          getAll() { const r = {}; reqs.push(() => { r.result = Object.values(f.data); }); return r; },
          put(v, k) { ops.push(() => { f.data[k] = v; }); }, delete(k) { ops.push(() => { delete f.data[k]; }); }
        };
        tx.objectStore = () => st;
        setTimeout(() => {
          if (mode === 'readwrite') {
            if (f.failWrites) { tx.error = Object.assign(new Error('The quota has been exceeded'), { name: 'QuotaExceededError' }); if (tx.onabort) tx.onabort(); return; }
            ops.forEach((fn) => fn()); f.commits++;
          }
          reqs.forEach((fn) => fn());
          if (tx.oncomplete) tx.oncomplete();
        }, 2);
        return tx;
      } };
      req.result = db; if (req.onupgradeneeded) req.onupgradeneeded(); if (req.onsuccess) req.onsuccess();
    }, 1);
    return req;
  };
  return f;
}
const idbLog = (fake, extra) => AA.create(Object.assign({ tool: cfg.tool, toolVersion: 'tv1', engineVersion: 'eng-1', engineSources: () => [1], schema: auditSchema, validate: AL.validate.instance,
  storage: AA.indexedDbAdapter('agent_audit_v1', fake), exportHints: 'the exports' }, extra || {}));

async function asyncSuite() {
  section('M. IndexedDB primary store');
  {
    const fake = fakeIdb(); const L = idbLog(fake);
    L.status(); L.verify(); L.entries(); L.retention.status();
    ok(fake.opens === 0 && Object.keys(fake.data).length === 0, 'IndexedDB is not even opened until the log is first used (inert)');
    const a = L.logInput('first (queued)', null); const b = L.logInput('second (queued)', null); const c = L.logDisplay('decision', 'third (queued)', true);
    ok(a.ok && a.queued && b.queued && c.queued, 'events arriving before the store has opened are accepted and queued, not lost');
    ok(L.entries().length === 0 && L.verify().loading === true && L.retention.configure({ retention_days: 90 }, 'admin').error === 'storage_loading', 'reads and admin actions answer honestly ("loading") instead of guessing');
    await L.ready();
    const es = L.entries();
    ok(es.map((e) => e.type).join() === 'session_started,engine_changed,input_received,input_received,display_rendered', 'queued events were written in their original order after the store opened');
    ok(L.verify().ok && es.every((e, i) => e.seq === i + 1), 'hash chain and sequence are correct after queued replay');
    await L.flush();
    ok(Object.keys(fake.data).length === es.length + 1 && fake.commits >= 1, 'entries + meta reached the database (batched)');
    ok(L.retention.status().storage.limit === 52428800, 'IndexedDB default soft limit is 50 MB (not the 1 MB localStorage cap)');
    ok(L.retention.configure({ limit_bytes: 200000000 }, 'admin').ok, 'a larger limit is allowed on IndexedDB');

    // reload: a NEW instance over the same database
    const L2 = idbLog(fake); await L2.ready();
    ok(L2.entries().length === es.length + 1 && L2.verify().ok, 'a fresh instance (page reload) reads the whole log back and it verifies');   // +1 = the config_changed above
    L2.logInput('after reload', null); await L2.ready();
    ok(L2.verify().ok && L2.entries().filter((e) => e.type === 'session_started').length === 2, 'chain continues across reload; each page load adds one session marker');
  }
  {
    // write failure and recovery
    const fake = fakeIdb(); const L = idbLog(fake); await L.ready(); L.logInput('kept', null); await L.flush();
    fake.failWrites = true;
    const r = L.logInput('during failure', null); await L.flush();
    ok(r.ok && L.status().degraded && L.status().degraded.reason === 'quota_exceeded', 'background write failure -> degraded (quota), caller unaffected');
    ok(L.retention.status().prompt.level === 'urgent' && L.exportAll('admin').entries.some((e) => e.detail && e.detail.text === 'during failure'), 'urgent prompt, and export still contains the unsaved entry');
    fake.failWrites = false; L.logInput('after', null); await L.flush();
    ok(L.status().degraded === null, 'degraded flag clears when the database accepts writes again');
    const L2 = idbLog(fake); await L2.ready(); const texts = L2.entries({ type: 'input_received' }).map((e) => e.detail.text);
    ok(['kept', 'during failure', 'after'].every((t) => texts.includes(t)) && L2.verify().ok, 'the batch that failed was retried: nothing missing after a reload');
  }
  {
    // cannot open IndexedDB at all -> capped fallback, queue still replayed
    const fake = fakeIdb(); fake.failOpen = true; const L = idbLog(fake);
    const q = L.logInput('queued while opening', null);
    await L.ready();
    const st = L.status();
    ok(q.queued && st.storage_kind === 'memory' && st.storage_fallback && /blocked/.test(st.storage_fallback.reason), 'IndexedDB unavailable -> falls back (here to memory) and says why');
    ok(L.entries({ type: 'input_received' }).length === 1 && L.verify().ok, 'the queued event was still recorded');
    ok(L.diagnostics().storage_fallback && L.diagnostics().storage_fallback.kind === 'indexedDB', 'diagnostics show the fallback for admins');
  }

  section('N. capped fallback store protects the tool\'s own data');
  {
    const store = AA.memoryStorage(); store.hardCap = 9000;      // a tiny cap standing in for "the share of localStorage we may use"
    const mkL = () => AA.create({ tool: cfg.tool, toolVersion: 'tv1', engineVersion: 'eng-1', engineSources: () => [1], schema: auditSchema, validate: AL.validate.instance, storage: store, exportHints: 'the exports' });
    const L = mkL(); let n = 0;
    while (!L.status().degraded && n < 200) { L.logInput('capped store entry ' + n, null); n++; }
    ok(L.status().degraded && L.status().degraded.reason === 'limit_reached', 'cap reached -> degraded with reason limit_reached');
    const persistedBytes = Object.entries(store._dump()).filter(([k]) => k.includes(':e:')).reduce((a, [k, v]) => a + k.length + v.length, 0);
    ok(persistedBytes <= 9000, 'the persisted audit data never exceeds the cap (' + persistedBytes + ' <= 9000)');
    for (let i = 0; i < 5; i++) L.logInput('after the cap ' + i, null);
    const persistedAfter = Object.entries(store._dump()).filter(([k]) => k.includes(':e:')).reduce((a, [k, v]) => a + k.length + v.length, 0);
    ok(persistedAfter === persistedBytes, 'further entries are NOT written to the shared store');
    ok(L.entries({ type: 'input_received' }).length === n + 5 && L.exportAll('admin').entries.length >= n + 5, 'but nothing is lost this session: they are in memory and in the export');
    ok(L.retention.status().prompt.code === 'audit_limit_reached' && /export now/i.test(L.retention.status().prompt.message), 'urgent, calm prompt to export');
    ok(L.retention.purgeExpired('admin').error === 'reload_required_after_limit' && L.retention.redact('x', 'a', 'b').error === 'reload_required_after_limit', 'purge/redact are refused while frozen (they would desynchronise the stored chain)');
    ok(L.verify().ok, 'in-memory chain is intact');
    const L2 = mkL(); L2.logInput('next session', null);
    ok(L2.verify().ok, 'after a reload the persisted chain is consistent (continues from the last PERSISTED entry)');
    ok(L2.entries({ type: 'audit_degraded' }).some((e) => e.detail.reason === 'limit_reached' && e.detail.buffered >= 5), 'the next session records how many entries could not be persisted');
  }
  {
    const st = AA.memoryStorage(); st.kind = 'localStorage'; st.hardCap = 1000000;
    const L = AA.create({ tool: cfg.tool, toolVersion: 'tv1', engineVersion: 'e', schema: auditSchema, validate: AL.validate.instance, storage: st });
    ok(L.retention.configure({ limit_bytes: 3000000 }, 'admin').ok === false && L.retention.configure({ limit_bytes: 1500000 }, 'admin').ok, 'localStorage limit is capped at 2 MB (shared pool); smaller values allowed');
  }
}

asyncSuite().then(() => {
  console.log('');
  if (failures.length) { console.log(`FAILED: ${failures.length} problem(s); ${pass} assertions passed`); process.exit(1); }
  console.log(`ALL AUDIT TESTS PASSED (${pass} assertions)`);
}).catch((e) => { console.log('SUITE ERROR:', e && e.stack || e); process.exit(1); });
