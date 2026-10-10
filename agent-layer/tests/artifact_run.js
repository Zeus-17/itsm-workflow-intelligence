#!/usr/bin/env node
/*
 * ARTIFACT test (IDENTICAL COPY in both repos).   node agent-layer/tests/artifact_run.js
 *
 * Every other suite tests the readable SOURCE files. Users receive the EMBEDDED block inside the tool HTML - compacted, with its
 * bootstrap. This suite extracts that exact <script id="agent-layer"> from the tool HTML, runs it in an isolated VM context that
 * stands in for the browser page (with some, but not all, of the tool's global names defined), and checks that it works as shipped.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const load = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));
let pass = 0; const failures = [];
function ok(c, m) { if (c) pass++; else { failures.push(m); console.log('  FAIL:', m); } }

const cfg = load('config.json');
const html = fs.readFileSync(path.join(ROOT, cfg.html), 'utf8');
const m = html.match(/<script id="agent-layer">([\s\S]*?)<\/script>\s*<!-- AGENT-LAYER:END -->/);
ok(!!m, 'the tool HTML contains the embedded agent-layer script');
if (!m) { console.log('FAILED: no embedded block'); process.exit(1); }
const code = m[1];

// a page-like context: a localStorage mock, a few of the TOOL's own global names (some deliberately missing), no indexedDB
function pageContext(extra) {
  const store = {};
  const ctx = { console, setTimeout, clearTimeout, Promise, JSON, Math, Date, Object, Array, String, Number, RegExp, Error, Uint8Array, parseInt, isFinite,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } } };
  ctx.self = ctx; ctx.window = ctx; Object.assign(ctx, extra || {});
  vm.createContext(ctx); vm.runInContext(code, ctx, { filename: 'embedded-agent-layer.js' });
  return { ctx, store };
}

const { ctx, store } = pageContext(cfg.tool === 'rm'
  ? { RELEASE_AI_RULES: [{ pattern: /a/i, hint: 'x' }], calculateReadiness: function (r) { return r; } }                  // other engine names intentionally missing
  : { intelRules: { security: { hint: 'h' } }, calcScore: function () { return 0; } });
ok(Object.keys(store).length === 0, 'loading the page writes nothing to storage');
ok(ctx.AgentLayer && ctx.AgentAudit && ctx.AgentFailsafe, 'all three modules are present as shipped (compacted)');
ok(ctx.AgentLayer.status().configured === true && ctx.AgentLayer.status().enabled === false, 'validation layer configured but DISABLED');
if (cfg.engineExports) {
  // the per-tool engine exports, as shipped: present, inert, and fail closed when the tool's tables are missing or the input is junk
  const EE = ctx.AgentEngine;
  ok(EE && typeof EE.run === 'function' && typeof EE.evaluate === 'function' && EE.engines().length > 0, 'the shipped block exposes AgentEngine with engines');
  ok(EE.engines().every((e) => { const r = EE.run(e, {}); return r.status === 'rejected'; }), 'every shipped engine export rejects an empty input (never computes, never throws)');
  const humanOnly = cfg.tool === 'rm' ? 'decision_record' : 'severity_record';   // RM: the human GO / NO-GO; ITSM: the tier the human chooses
  ok(EE.run(humanOnly, {}).reason === 'human_decision_only', 'the human-only decision (' + humanOnly + ') can never be run by the assistant (as shipped)');
  ok(Object.keys(store).length === 0, 'running engine exports writes nothing to storage');
}
ok(ctx.AgentAudit.log() !== null && ctx.AgentFailsafe.instance() !== null, 'audit log and failsafe initialised by the bootstrap');
ok(ctx.AgentFailsafe.instance().state().mode === 'standard', 'failsafe starts in Standard Mode');
ok(code.length < fs.readFileSync(path.join(ROOT, 'validation.js'), 'utf8').length + fs.readFileSync(path.join(ROOT, 'audit.js'), 'utf8').length + fs.readFileSync(path.join(ROOT, 'failsafe.js'), 'utf8').length + 200000, 'embedded size is sane');

// the SAME conformance cases that the readable source passes
const AL = ctx.AgentLayer;
const cases = load('..', 'schemas', 'fixtures', 'policy-cases.json').cases;
let bad = 0;
for (const c of cases) {
  const got = AL.validate.draft(c.engine, c.draft, { agentSupplied: c.agent_supplied || [] }), e = c.expect;
  let good = got.status === e.status;
  if (good && e.missing) good = JSON.stringify(got.missing) === JSON.stringify(e.missing);
  if (good && e.caveats) good = JSON.stringify(got.caveats) === JSON.stringify(e.caveats);
  if (good && e.reason) good = got.reason === e.reason;
  if (!good) { bad++; ok(false, 'embedded resolver disagrees on ' + c.id); }
}
ok(bad === 0, `embedded resolver passes all ${cases.length} conformance cases`);
pass += cases.length - bad;

// pre-filter, as shipped
AL._test.reset();
ok(AL.prefilter.check('Stripe webhook listener update').payment.flagged, 'embedded pre-filter flags the red-team payment case');
ok(AL.prefilter.check('Please email jane@example.com').decision === 'block', 'embedded pre-filter blocks personal data by default');
ok(AL.prefilter.check('Refund email template; Discard button').payment.matches.map((x) => x.term).join() === 'refund', 'embedded pre-filter has no substring false positives');

// audit through the shipped bridge, over the page's localStorage (no indexedDB in this context => capped localStorage fallback)
const log = ctx.AgentAudit.log();
ok(log.status().storage_kind === 'localStorage', 'without IndexedDB the shipped log falls back to the capped localStorage store');
AL.prefilter.check('Stripe outage');                      // event -> bridge -> audit
const vr = AL.validate.draft(AL.validate.engines()[0], Object.fromEntries(Object.keys(JSON.parse(JSON.stringify(load('..', 'schemas', 'engine-inputs.schema.json').$defs[AL.validate.engines()[0]].properties)) ).map((k) => [k, { state: 'unresolved', reason: 'declined' }])));
ok(log.verify().ok && log.entries().some((e) => e.type === 'prefilter_decision') && log.entries().some((e) => e.type === 'validation_result') && log.entries().every((e) => e.engine_version === cfg.engineVersion), 'bridge wrote prefilter + validation entries; chain verifies; engine version stamped');
ok(log.entries().every((e) => e.engine_fingerprint === null || /^[0-9a-f]{16}$/.test(e.engine_fingerprint)), 'engine fingerprint tolerates tool globals that are missing in the page');
ok(Object.keys(store).every((k) => k.indexOf('agent_audit_v1') === 0), 'the only storage keys written are the audit log\'s own');

// failsafe, as shipped
const F = ctx.AgentFailsafe.instance();
F.setStateProvider(() => ({ confirmed: [{ path: 'a', value: 1, provenance: 'user_confirmed' }, { path: 'b', value: 2, provenance: 'model_inferred' }], candidates: [], required: ['a', 'b', 'c'] }));
ok(F.enable('claude').ok, 'failsafe enables for a provider');
F.recordFailure({ providerId: 'claude', kind: 'timeout' });
const trip = F.recordFailure({ providerId: 'claude', kind: 'timeout' });
ok(trip.tripped && trip.reason_category === 'timeout' && trip.handoff.carried.length === 1 && trip.handoff.unconfirmed_candidates.length === 1, 'shipped failsafe trips, preserves the confirmed value and demotes the unconfirmed one');
ok(log.entries().some((e) => e.type === 'failsafe_triggered') && log.verify().ok, 'the fallback appears in the same audit chain');
ok(F.checkNarration({ status: 'computed', score: 58, band: 'amber', blockers: 1 }, 'close enough to proceed').consistent === false, 'shipped narration check catches a contradiction');

console.log('');
if (failures.length) { console.log(`FAILED: ${failures.length} problem(s); ${pass} assertions passed`); process.exit(1); }
console.log(`ALL ARTIFACT TESTS PASSED (${pass} assertions)`);
