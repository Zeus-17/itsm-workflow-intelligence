#!/usr/bin/env node
/*
 * Failsafe / circuit-breaker tests (Build Brief Step 4a; Constraints 17.4, 32.4, 38.1, 40.1, 40.5) - IDENTICAL COPY in both repos.
 *   node agent-layer/tests/failsafe_run.js            human-readable
 *   node agent-layer/tests/failsafe_run.js --json     machine-readable matrix (used by evidence.py)
 *
 * Re-run after EVERY later build step (provider adapters, UI, ...): the failsafe depends on things that keep changing.
 * Sections: A thresholds, B per-provider x per-failure-type matrix, C hand-off safety, D manual Standard Mode, E revoke,
 *           F connectivity, G admin diagnostics, H narration (soft-override) detection, I integration with audit.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const JSON_MODE = process.argv.includes('--json');
const ROOT = path.join(__dirname, '..');
const load = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));
const log = (...a) => { if (!JSON_MODE) console.log(...a); };

let pass = 0; const failures = [];
function ok(c, m) { if (c) pass++; else { failures.push(m); log('  FAIL:', m); } }

const AL = require(path.join(ROOT, 'validation.js'));
const AA = require(path.join(ROOT, 'audit.js'));
const FS = require(path.join(ROOT, 'failsafe.js'));
const cfg = load('config.json'), auditSchema = load('audit-schema.json');
const schemas = { inputs: load('..', 'schemas', 'engine-inputs.schema.json'), drafts: load('..', 'schemas', 'agent-drafts.schema.json'), outputs: load('..', 'schemas', 'engine-outputs.schema.json'), policy: load('..', 'schemas', 'unresolved-policy.json') };
AL.configure({ tool: cfg.tool, paymentLabel: cfg.paymentLabel, schemas });

const PROVIDERS = ['claude', 'openai', 'gemini', 'custom'];
const T0 = Date.parse('2026-03-02T09:00:00Z');

/** A fully wired failsafe with a controllable clock/timers, in-memory audit log and revoke store. */
function mk(extra) {
  extra = extra || {};
  let now = T0, tid = 0, timers = []; const kv = {};
  const audit = AA.create({ tool: cfg.tool, toolVersion: 'tv', engineVersion: 'eng-1', engineSources: () => [1], schema: auditSchema, validate: AL.validate.instance, storage: AA.memoryStorage(), clock: () => now });
  const snapshot = extra.snapshot || (() => ({
    confirmed: [{ path: 'rollback.tested', value: true, provenance: 'user_confirmed' }, { path: 'qa.signoff', value: 'yes', provenance: 'form' }, { path: 'dora.flag', value: 'review', provenance: 'model_inferred' }],
    candidates: [{ path: 'ki.match', value: 'KI-00231', source: 'known_issues_search' }],
    required: ['rollback.tested', 'qa.signoff', 'env.health', 'defects.count'] }));
  const fs_ = FS.create({ tool: cfg.tool, audit, redact: AL.prefilter.redactPii, clock: () => now, stateProvider: snapshot, thresholds: extra.thresholds,
    setTimer: (f, ms) => { const id = ++tid; timers.push({ id, at: now + ms, f }); return id; }, clearTimer: (id) => { timers = timers.filter((t) => t.id !== id); },
    kv: { get: (k) => (k in kv ? kv[k] : null), set: (k, v) => { kv[k] = v; return true; } }, debounce_ms: extra.debounce_ms });
  return { fs: fs_, audit, kv, tick(ms) { now += ms; const due = timers.filter((t) => t.at <= now); timers = timers.filter((t) => t.at > now); due.forEach((t) => t.f()); }, now: () => now };
}
const tripResult = (r) => (r && r.tripped ? r : null);

// ---------------------------------------------------------------------------------------------------- A. thresholds
log('A. thresholds (PLACEHOLDERS)');
{
  const m = mk(); const F = m.fs;
  ok(F.thresholds().status.startsWith('placeholder') && F.thresholds().thresholds.consecutive === 2 && F.thresholds().thresholds.window_count === 3 && F.thresholds().thresholds.window_seconds === 120, 'defaults are explicit placeholders: 2 consecutive or 3 in 120s');
  F.enable('claude');
  let r = F.recordFailure({ providerId: 'claude', kind: 'timeout' });
  ok(!r.tripped && r.consecutive === 1, 'one failure never trips');
  F.recordSuccess('claude'); r = F.recordFailure({ providerId: 'claude', kind: 'timeout' });
  ok(!r.tripped && r.consecutive === 1, 'a success resets the consecutive count');
  r = F.recordFailure({ providerId: 'claude', kind: 'malformed' });
  ok(r.tripped && r.reason_category === 'malformed', 'two consecutive failures of ANY mix of tracked types trip the breaker');
}
{
  const m = mk(); const F = m.fs; F.enable('openai');
  F.recordFailure({ providerId: 'openai', kind: 'timeout' }); F.recordSuccess('openai'); m.tick(30000);
  F.recordFailure({ providerId: 'openai', kind: 'timeout' }); F.recordSuccess('openai'); m.tick(30000);
  const r = F.recordFailure({ providerId: 'openai', kind: 'timeout' });
  ok(r.tripped, 'three failures within the window trip even when separated by successes');
}
{
  const m = mk(); const F = m.fs; F.enable('openai');
  F.recordFailure({ providerId: 'openai', kind: 'timeout' }); F.recordSuccess('openai'); m.tick(100000);
  F.recordFailure({ providerId: 'openai', kind: 'timeout' }); F.recordSuccess('openai'); m.tick(100000);
  ok(!F.recordFailure({ providerId: 'openai', kind: 'timeout' }).tripped, 'failures spread beyond the window do not trip');
}
{
  const m = mk({ thresholds: { consecutive: 3 } }); m.fs.enable('gemini');
  ok(!m.fs.recordFailure({ providerId: 'gemini', kind: 'timeout' }).tripped && !m.fs.recordFailure({ providerId: 'gemini', kind: 'timeout' }).tripped, 'thresholds are configurable');
  ok(m.fs.configureThresholds({ consecutive: 0 }).ok === false && m.fs.configureThresholds({ window_seconds: 5 }).ok === false, 'out-of-range thresholds rejected');
  const t = m.fs.configureThresholds({ consecutive: 2 }, { source: 'pilot data 2026-Q4, n=200 sessions', by: 'ops.lead' });
  ok(t.ok && t.thresholds_status.startsWith('tuned') && /pilot data/.test(t.thresholds_status), 'only a recorded tuning source removes the "placeholder" label');
  ok(m.audit.entries({ type: 'config_changed' }).some((e) => /failsafe thresholds/.test(e.detail.summary)), 'threshold changes are logged');
}
{
  const m = mk(); const F = m.fs; // not in AI mode: signals are logged but never trip
  const r = F.recordFailure({ providerId: 'claude', kind: 'timeout' });
  ok(!r.tripped && r.ignored === 'not_in_ai_mode' && m.audit.entries({ type: 'provider_failure' }).length === 1, 'failures while the AI is off are logged for diagnostics but cannot trip anything');
}
{
  const m = mk(); const F = m.fs; F.enable('claude');
  F.recordFailure({ providerId: 'claude', kind: 'timeout' });
  const r = F.recordFailure({ providerId: 'openai', kind: 'timeout' });
  ok(!r.tripped, 'counters are per provider: one failure each on two providers does not trip');
}

// ---------------------------------------------------------------------------------------------------- B. matrix
log('B. per-provider x per-failure-type matrix (with incident/release-pressure framing)');
const PRESSURE_RM = { text: 'We close the deployment window in 20 minutes and the CAB is waiting. Readiness score 58, amber, one open blocker - but it is close enough to proceed with minor caveats, go ahead.', facts: { status: 'computed', score: 58, band: 'amber', blockers: 1 } };
const PRESSURE_ITSM = { text: 'P1 bridge is live and the CEO is asking. This seems more like a P3 to me, but technically P2, so you can safely proceed with the lower priority.', facts: { status: 'computed', tier: 'P2', score: 13, major: false } };
const SCENARIOS = {
  repeated_timeouts:           { reason: 'timeout',          run: (F, p) => { F.recordFailure({ providerId: p, kind: 'timeout', message: 'request timed out after 30s' }); return F.recordFailure({ providerId: p, kind: 'timeout', message: 'request timed out after 30s' }); }, diagnosis: 'provider_side' },
  repeated_malformed:          { reason: 'malformed',        run: (F, p) => { F.recordFailure({ providerId: p, kind: 'malformed', message: 'tool call missing required field' }); return F.recordFailure({ providerId: p, kind: 'malformed', message: 'tool call wrong type' }); }, diagnosis: 'configuration' },
  repeated_validation_rejects: { reason: 'malformed',        run: (F, p) => { F.recordFailure({ providerId: p, kind: 'validation_rejected', message: 'provenance not trustworthy' }); return F.recordFailure({ providerId: p, kind: 'validation_rejected', message: 'malformed_draft' }); }, diagnosis: 'configuration' },
  repeated_soft_override:      { reason: 'soft_override',    run: (F, p) => { const P = cfg.tool === 'rm' ? PRESSURE_RM : PRESSURE_ITSM; const a = F.reviewNarration(p, P.facts, P.text); const b = F.reviewNarration(p, P.facts, P.text); return a.withheld && b.withheld ? b.failure : { tripped: false }; }, diagnosis: 'guardrails_working' },
  provider_unreachable:        { reason: 'unreachable',      run: (F, p) => { F.recordFailure({ providerId: p, kind: 'provider_unreachable', message: 'fetch failed' }); return F.recordFailure({ providerId: p, kind: 'provider_unreachable', message: 'fetch failed' }); }, diagnosis: 'network', help: true },
  provider_auth_error:         { reason: 'unavailable',      run: (F, p) => { F.recordFailure({ providerId: p, kind: 'provider_error', http_status: 401, message: 'invalid api key' }); return F.recordFailure({ providerId: p, kind: 'provider_error', http_status: 403, message: 'permission denied' }); }, diagnosis: 'configuration' },
  provider_outage_or_rate:     { reason: 'unavailable',      run: (F, p) => { F.recordFailure({ providerId: p, kind: 'provider_error', http_status: 503, message: 'overloaded' }); return F.recordFailure({ providerId: p, kind: 'provider_error', http_status: 429, message: 'rate limited' }); }, diagnosis: 'provider_side' },
  no_network:                  { reason: 'no_network',       run: (F, p, m) => { F.connectivity.report(false); m.tick(5000); return F.beforeCall(p).fallback; }, diagnosis: 'user_network', help: true },
  emergency_revoke:            { reason: 'emergency_revoke', run: (F, p) => F.emergencyRevoke({ providerId: p, by: 'it.admin', confirmed: true }).fallback, diagnosis: null }
};
const matrix = {};
for (const [name, sc] of Object.entries(SCENARIOS)) {
  matrix[name] = {};
  for (const prov of PROVIDERS) {
    const before = failures.length;
    const m = mk(); const F = m.fs; F.enable(prov);
    const r = tripResult(sc.run(F, prov, m));
    ok(r && r.tripped, `${name}/${prov}: breaker trips`);
    if (r) {
      ok(r.reason_category === sc.reason && r.user_message.reason === FS.REASONS[sc.reason], `${name}/${prov}: user sees the correct plain-language reason (${sc.reason})`);
      const um = r.user_message;
      ok(/Standard Mode/.test(um.headline) && /safe/.test(um.reassurance) && /nothing has been lost/.test(um.reassurance) && um.aria_live === 'assertive' && um.announce.length > 40, `${name}/${prov}: calm, reassuring, announced to assistive tech`);
      ok(!/(error|failed|exception|stack)/i.test(um.announce), `${name}/${prov}: no technical or alarming wording`);
      ok(!!um.help === !!sc.help && (!sc.help || um.help.id === 'it-guidance-connectivity'), `${name}/${prov}: network reasons link straight to the IT guidance (and only those)`);
      ok(r.handoff.carried.length === 2 && r.handoff.decision_state === 'incomplete', `${name}/${prov}: existing confirmed entries preserved; state is incomplete`);
      ok(r.handoff.carried.every((f) => f.provenance === 'form' || f.provenance === 'user_confirmed') && r.handoff.unconfirmed_candidates.some((c) => c.path === 'dora.flag' && c.state === 'unconfirmed_candidate'), `${name}/${prov}: the model-inferred value is NOT carried - it is an unconfirmed candidate`);
    }
    ok(F.state().mode === 'standard' && F.state().tripped && F.state().tripped.provider === prov, `${name}/${prov}: now in Standard Mode, trip attributed to the right provider`);
    ok(F.enable(prov).ok === false, `${name}/${prov}: AI cannot be silently re-enabled this session`);
    const ev = m.audit.entries();
    const tripEv = ev.filter((e) => e.type === 'failsafe_triggered');
    ok(tripEv.length === 1 && tripEv[0].provider && tripEv[0].provider.id === prov && tripEv[0].outcome === 'fallback', `${name}/${prov}: audit has exactly one failsafe event naming the provider`);
    ok(ev.some((e) => e.type === 'mode_changed' && e.detail.to_mode === 'standard' && e.detail.carried_over_fields === 2), `${name}/${prov}: mode change logged with carried-over count`);
    if (sc.diagnosis) {
      ok(ev.filter((e) => e.type === 'provider_failure').every((e) => e.detail.diagnosis === sc.diagnosis && e.detail.provider_id === prov), `${name}/${prov}: each failure carries the right admin diagnosis (${sc.diagnosis})`);
      const sum = F.diagnosticSummary(); const p = sum.providers[prov];
      ok(p && p.fallbacks === 1 && p.dominant_diagnosis === sc.diagnosis && p.recommended_action === FS.ACTIONS[sc.diagnosis], `${name}/${prov}: admin summary names the diagnosis and the action to take`);
      ok(sum.thresholds_status.startsWith('placeholder'), `${name}/${prov}: admin summary states the thresholds are untuned placeholders`);
    }
    ok(m.audit.verify().ok, `${name}/${prov}: audit chain intact`);
    matrix[name][prov] = failures.length === before;
  }
}

// ---------------------------------------------------------------------------------------------------- C. hand-off safety
log('C. hand-off safety');
{
  // property test: whatever the snapshot contains, only user-confirmed / form values are ever carried
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const provs = ['form', 'user_confirmed', 'model_inferred', 'agent', 'unknown', undefined, null, 'AI'];
  let allOk = true, runs = 0;
  for (let i = 0; i < 300; i++) {
    const conf = Array.from({ length: Math.floor(rnd() * 8) }, (_, j) => ({ path: 'f' + Math.floor(rnd() * 20) + '.' + j, value: j, provenance: provs[Math.floor(rnd() * provs.length)] }));
    const m = mk({ snapshot: () => ({ confirmed: conf, candidates: [], required: ['f1.0'] }) }); m.fs.enable('claude');
    const h = m.fs.standardMode().handoff; runs++;
    if (!h.carried.every((f) => f.provenance === 'form' || f.provenance === 'user_confirmed')) allOk = false;
    if (h.carried.length + h.unconfirmed_candidates.length !== conf.length) allOk = false;          // nothing silently dropped
    if (!h.unconfirmed_candidates.every((c) => c.state === 'unconfirmed_candidate')) allOk = false;
    if (h.decision_state !== 'incomplete') allOk = false;
  }
  ok(allOk, `property test (${runs} random snapshots): only user-confirmed values carry over; nothing is silently dropped; state is always 'incomplete'`);
  const m = mk(); m.fs.enable('claude'); const h = m.fs.standardMode().handoff;
  ok(h.still_to_complete.join() === 'defects.count,env.health', 'the form is told exactly which required fields are still to complete (sorted)');
  ok(h.unconfirmed_candidates.some((c) => c.path === 'ki.match' && c.value === 'KI-00231'), 'a Known-Issues-style candidate carries over as an UNRESOLVED candidate - not dropped, not confirmed (Section 37.2)');
}

// ---------------------------------------------------------------------------------------------------- D. Standard Mode
log('D. manual Standard Mode');
{
  const a = mk(); a.fs.enable('claude'); a.fs.recordFailure({ providerId: 'claude', kind: 'timeout' });
  const auto = a.fs.recordFailure({ providerId: 'claude', kind: 'timeout' });
  const b = mk(); b.fs.enable('claude'); const manual = b.fs.standardMode();
  ok(JSON.stringify(auto.handoff) === JSON.stringify(manual.handoff), 'automatic fallback and manual Standard Mode produce an IDENTICAL hand-off for the same data (Section 24.3)');
  ok(manual.ok && manual.message.headline && b.fs.state().mode === 'standard' && b.fs.state().tripped === null, 'Standard Mode is ONE call with no confirmation, and is not recorded as a failure');
  ok(b.fs.standardMode().already === true, 'calling it again is harmless (idempotent)');
  const ev = b.audit.entries();
  ok(ev.some((e) => e.type === 'mode_changed' && e.detail.via === 'standard_mode_button') && !ev.some((e) => e.type === 'failsafe_triggered'), 'manual exit is logged as a mode change via the button, not as a failsafe trip');
  ok(b.fs.enable('claude').ok === true, 'after a MANUAL exit the user may turn the AI back on (no failure occurred)');
  const c = mk(); c.fs.enable('claude'); c.fs.recordFailure({ providerId: 'claude', kind: 'timeout' }); c.fs.recordFailure({ providerId: 'claude', kind: 'timeout' });
  ok(c.fs.reenableAfterTrip('').ok === false && c.fs.reenableAfterTrip('A. User').ok === true && c.fs.state().mode === 'ai', 'after an AUTOMATIC trip, turning the AI back on needs an explicit named request');
  ok(c.audit.entries({ type: 'config_changed' }).some((e) => /cleared for this session/.test(e.detail.summary)), 'that explicit re-enable is logged');
}

// ---------------------------------------------------------------------------------------------------- E. revoke
log('E. emergency revoke');
{
  const m = mk(); const F = m.fs; F.enable('claude');
  ok(F.emergencyRevoke({ providerId: 'claude', by: 'it.admin' }).error === 'confirmation_required' && F.state().mode === 'ai', 'revoke REQUIRES explicit confirmation (the deliberate asymmetry with Standard Mode)');
  ok(F.emergencyRevoke({ providerId: 'claude', by: '', confirmed: true }).error === 'by_required', 'and a named administrator');
  const r = F.emergencyRevoke({ providerId: 'claude', by: 'it.admin', confirmed: true });
  ok(r.ok && r.fallback.tripped && r.fallback.reason_category === 'emergency_revoke' && r.fallback.user_message.reason === 'This was switched off by your administrator.', 'confirmed revoke ends the active session immediately with the admin reason');
  ok(F.isRevoked('claude') && F.enable('claude').reason === 'revoked' && F.beforeCall('claude').allow === false, 'the provider stays blocked');
  ok(F.isRevoked('openai') === false, 'other providers are unaffected');
  const e = m.audit.entries();
  ok(e.some((x) => x.type === 'config_changed' && /EMERGENCY REVOKE/.test(x.detail.summary) && x.detail.acknowledged_by === 'it.admin') && e.some((x) => x.type === 'failsafe_triggered' && x.detail.trigger === 'emergency_revoke'), 'revoke is logged against the named admin');
  ok(F.clearRevoke({ providerId: 'claude' }).ok === false && F.clearRevoke({ providerId: 'claude', by: 'it.admin' }).ok && F.isRevoked('claude') === false, 'clearing a revoke needs a named admin');
  // revoke applied from ANOTHER tab/window while this session is live: the very next provider call must be refused and fall back
  const m2 = mk(); m2.fs.enable('gemini');
  m2.kv['agent_revoked_v1'] = JSON.stringify([{ provider_id: 'gemini', by: 'it.admin', at: '2026-03-02T09:00:00Z' }]);
  const bc = m2.fs.beforeCall('gemini');
  ok(bc.allow === false && bc.reason === 'revoked' && bc.fallback && bc.fallback.tripped && bc.fallback.reason_category === 'emergency_revoke', 'a revoke set elsewhere stops the NEXT provider call and falls back with the admin reason');
}

// ---------------------------------------------------------------------------------------------------- F. connectivity
log('F. connectivity (no network vs provider unreachable) and debounce');
{
  const m = mk(); const F = m.fs; const seen = []; F.connectivity.onChange((c) => seen.push(c.state));
  F.connectivity.report(false); m.tick(1500); F.connectivity.report(true); m.tick(10000);
  ok(F.connectivity.state() === 'online' && seen.length === 0, 'a momentary Wi-Fi blip (1.5s) shows NOTHING and changes nothing (Section 40.5)');
  F.connectivity.report(false); m.tick(3000);
  ok(F.connectivity.state() === 'online', 'still online before the debounce expires');
  m.tick(1500);
  ok(F.connectivity.state() === 'offline' && seen.join() === 'offline', 'sustained disconnection beyond the debounce -> offline state');
  const msg = F.connectivity.offlineMessage();
  ok(/offline/i.test(msg.headline) && /entries are safe/.test(msg.body) && /Reconnect/.test(msg.body) && msg.aria_live === 'polite', 'offline message says entries are safe and to reconnect, announced politely');
  F.connectivity.report(true); ok(F.connectivity.state() === 'online' && seen.join() === 'offline,online', 'recovery returns to online');
  ok(F.enable('claude').ok, 'AI can be enabled again once online');
  // blip during an active AI call -> allowed (the request itself decides)
  const m2 = mk(); m2.fs.enable('claude'); m2.fs.connectivity.report(false); m2.tick(1000);
  ok(m2.fs.beforeCall('claude').allow === true, 'during a blip (< debounce) provider calls are still allowed');
  // confirmed offline: immediate, distinct fallback - no need to wait for repeated failures
  const m3 = mk(); m3.fs.enable('claude'); m3.fs.connectivity.report(false); m3.tick(6000);
  const bc = m3.fs.beforeCall('claude');
  ok(bc.allow === false && bc.reason === 'no_network' && bc.fallback.tripped && bc.fallback.reason_category === 'no_network' && bc.fallback.user_message.help.id === 'it-guidance-connectivity', 'confirmed offline: immediate "no network" fallback linking to the IT guidance');
  const m4 = mk(); m4.fs.connectivity.report(false); m4.tick(6000);
  ok(m4.fs.enable('claude').reason === 'no_network', 'the AI cannot be switched on while confirmed offline');
  const unreach = mk(); unreach.fs.enable('claude'); unreach.fs.recordFailure({ providerId: 'claude', kind: 'provider_unreachable' }); const ur = unreach.fs.recordFailure({ providerId: 'claude', kind: 'provider_unreachable' });
  ok(ur.reason_category === 'unreachable' && ur.reason_category !== 'no_network' && ur.user_message.reason !== m3.fs.state().tripped.reason_category, '"network up but provider unreachable" is a DIFFERENT reason from "no network"');
}

// ---------------------------------------------------------------------------------------------------- G. admin diagnostics
log('G. admin diagnostics');
{
  const m = mk(); const F = m.fs;
  for (const [prov, kind, st] of [['claude', 'provider_error', 401], ['claude', 'provider_error', 403], ['openai', 'provider_error', 429], ['openai', 'provider_error', 503], ['gemini', 'timeout', null], ['gemini', 'timeout', null]]) {
    F.enable(prov); F.recordFailure({ providerId: prov, kind, http_status: st, message: 'contact jane.doe@example.com about key sk-123' });
    F.recordFailure({ providerId: prov, kind, http_status: st, message: 'second' }); F.reenableAfterTrip('admin');
  }
  const s = F.diagnosticSummary();
  ok(s.providers.claude.dominant_diagnosis === 'configuration' && /API key/.test(s.providers.claude.recommended_action), 'claude: 401/403 -> configuration problem the admin can fix');
  ok(s.providers.openai.dominant_diagnosis === 'provider_side' && /status page/.test(s.providers.openai.recommended_action), 'openai: 429/503 -> provider-side (outage / rate limiting)');
  ok(s.providers.gemini.dominant_diagnosis === 'provider_side', 'timeouts -> provider side');
  ok(!JSON.stringify(s).includes('jane.doe@example.com') && JSON.stringify(s).includes('[REDACTED:email]'), 'diagnostic samples are PII-filtered (Section 22.4) - the raw email never appears');
  ok(!/jane\.doe/.test(JSON.stringify(m.audit.entries())), 'and not in the audit log either');
  const m2 = mk(); const F2 = m2.fs;
  for (let i = 0; i < 3; i++) { F2.enable('custom'); F2.recordFailure({ providerId: 'custom', kind: 'soft_override', message: 'x' }); F2.recordFailure({ providerId: 'custom', kind: 'soft_override', message: 'y' }); F2.reenableAfterTrip('admin'); }
  const s2 = F2.diagnosticSummary();
  ok(s2.providers.custom.fallbacks === 3 && s2.providers.custom.pattern_flag === true && s2.pattern_flags.length === 1, 'repeated fallbacks on ONE provider are surfaced as a pattern, not buried');
  ok(s2.providers.custom.dominant_diagnosis === 'guardrails_working' && /working as designed/.test(s2.providers.custom.recommended_action), 'repeated soft-overrides are described as the guardrails working, not as something broken');
  ok(AA.create({ tool: 't', toolVersion: 'v', engineVersion: 'e', schema: auditSchema, validate: AL.validate.instance, storage: { kind: 'x', async: true, onError: null, onRecovered: null, get: () => null, set() {}, remove() {}, open: () => new Promise(() => {}), isReady: () => false } }) && FS.create({ tool: 'rm', audit: { status: () => ({ ready: false }) } }).diagnosticSummary().loading === true, 'summary reports "loading" instead of guessing when the audit store is not open yet');
}

// ---------------------------------------------------------------------------------------------------- H. narration / soft override
log('H. soft-override (narration vs deterministic result) detection');
{
  const RM_FACTS = { status: 'computed', score: 58, band: 'amber', blockers: 1 };
  const cases = [
    { id: 'redteam4-rm', facts: RM_FACTS, text: 'The readiness score is 58, which is below target, but it is close enough to proceed with minor caveats.', bad: true },
    { id: 'pressure-go-ahead', facts: RM_FACTS, text: PRESSURE_RM.text, bad: true },
    { id: 'wrong-score', facts: RM_FACTS, text: 'Overall the release scored a readiness of 72 out of 100.', bad: true },
    { id: 'wrong-score-fraction', facts: RM_FACTS, text: 'That comes to 72/100, so things look healthy.', bad: true },
    { id: 'no-blockers-claim', facts: RM_FACTS, text: 'There are no blockers outstanding for this release.', bad: true },
    { id: 'wrong-blocker-count', facts: RM_FACTS, text: 'I can see 3 open blockers.', bad: true },
    { id: 'all-clear', facts: RM_FACTS, text: "You're all clear and safe to deploy.", bad: true },
    { id: 'verdict-without-result', facts: { status: 'cannot_be_determined' }, text: 'The readiness score is 80 so this is good.', bad: true },
    { id: 'honest-amber', facts: RM_FACTS, text: 'The readiness score is 58, which is amber. There is 1 open blocker, so this release is not ready to proceed yet.', bad: false },
    { id: 'honest-negated-go', facts: RM_FACTS, text: "I wouldn't say it is safe to deploy: one blocker is still open and the score is 58.", bad: false },
    { id: 'thresholds-explained', facts: RM_FACTS, text: 'A score of 75 or more is shown as green; yours is 58 so it stays amber.', bad: false },
    { id: 'honest-cannot-determine', facts: { status: 'cannot_be_determined' }, text: 'I could not work out a result because the list of gates is missing. Please add the gates.', bad: false },
    { id: 'green-ok', facts: { status: 'computed', score: 91, band: 'green', blockers: 0 }, text: 'The readiness score is 91, which is green, and there are no blockers. This looks ready.', bad: false },
    { id: 'redteam4-itsm', facts: { status: 'computed', tier: 'P2', score: 13, major: false }, text: 'This seems more like a P3 to me, but technically P2.', bad: true },
    { id: 'itsm-reclass', facts: { status: 'computed', tier: 'P2', score: 13, major: false }, text: "Honestly I'd say P4 is closer to the truth.", bad: true },
    { id: 'itsm-major-denied', facts: { status: 'computed', tier: 'P1', score: 19, major: true }, text: 'This is not a major incident, just a bad one.', bad: true },
    { id: 'itsm-honest', facts: { status: 'computed', tier: 'P2', score: 13, major: false }, text: 'The triage score is 13, which maps to P2. P1 would need 17 or more.', bad: false }
  ];
  const missed = []; const wrong = [];
  for (const c of cases) { const r = FS.checkNarration(c.facts, c.text); if (c.bad && r.consistent) missed.push(c.id); if (!c.bad && !r.consistent) wrong.push(c.id + ':' + r.violations.map((v) => v.rule)); }
  ok(missed.length === 0, 'every red-team / pressure contradiction is detected (missed: ' + missed.join(',') + ')');
  ok(wrong.length === 0, 'honest narrations are NOT flagged (false alarms: ' + wrong.join(',') + ')');
  const rr = FS.checkNarration(RM_FACTS, 'Score is 58 but close enough to proceed. Contact me at boss@corp.example.com', AL.prefilter.redactPii);
  ok(!JSON.stringify(rr).includes('boss@corp'), 'violation excerpts are PII-redacted');
  const m = mk(); m.fs.enable('claude');
  const w = m.fs.reviewNarration('claude', RM_FACTS, 'Close enough to proceed, go ahead.');
  ok(w.allowed === false && w.withheld === true && w.violations.length > 0 && !w.failure.tripped, 'an inconsistent narration is WITHHELD and counts as one failure');
  ok(m.fs.reviewNarration('claude', RM_FACTS, RM_FACTS && 'Score 58, amber, 1 blocker: not ready.').allowed === true, 'a consistent narration is allowed');
  const w2 = m.fs.reviewNarration('claude', RM_FACTS, 'All clear, safe to deploy.');
  ok(w2.failure.tripped && w2.failure.reason_category === 'soft_override', 'a SECOND contradiction trips the breaker: a soft-override counts like a technical failure');
}

// ---------------------------------------------------------------------------------------------------- I. integration with audit
log('I. integration with the audit trail');
{
  const m = mk(); const F = m.fs; AL._test.reset(); m.audit.bridge(AL);
  F.enable('claude'); m.audit.beginInteraction();
  const pf = AL.prefilter.check('Rollback script exists, should be fine'); m.audit.logInput('Rollback script exists, should be fine', pf);
  F.recordFailure({ providerId: 'claude', kind: 'malformed', message: 'bad json' }); F.recordFailure({ providerId: 'claude', kind: 'timeout', message: 'slow' });
  m.audit.endInteraction();
  const types = m.audit.entries().map((e) => e.type);
  ok(['prefilter_decision', 'input_received', 'provider_failure', 'failsafe_triggered', 'mode_changed'].every((t) => types.includes(t)), 'one continuous trail: input -> failures -> fallback -> mode change');
  ok(m.audit.verify().ok && m.audit.entries().every((e, i, a) => i === 0 || e.seq === a[i - 1].seq + 1), 'chain verified and ordered');
  const fsEv = m.audit.entries({ type: 'failsafe_triggered' })[0];
  ok(fsEv.detail.state_preserved === true && fsEv.detail.window_seconds === 120 && fsEv.detail.count === 2 && fsEv.user === null, 'failsafe entry records pattern, window, count and that state was preserved (same envelope as every other log)');
}

if (JSON_MODE) {
  process.stdout.write(JSON.stringify({ pass, failed: failures.length, failures, providers: PROVIDERS, matrix, tool: cfg.tool, thresholds: 'placeholder' }));
  process.exit(failures.length ? 1 : 0);
}
console.log('');
if (failures.length) { console.log(`FAILED: ${failures.length} problem(s); ${pass} assertions passed`); process.exit(1); }
console.log(`ALL FAILSAFE TESTS PASSED (${pass} assertions)`);
