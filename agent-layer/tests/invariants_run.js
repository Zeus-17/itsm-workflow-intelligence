#!/usr/bin/env node
/*
 * INVARIANTS / PROPERTY TESTS (Master Plan workstream Q4a) - ITSM repo.  PER-TOOL; not in the shared hash-lock.
 *
 *   node agent-layer/tests/invariants_run.js [--report]
 *
 * Runs thousands of seeded random inputs through the read-only engine exports and checks properties that SHOULD always hold.
 *   MUST-HOLD   properties of the export and of the documented design (bounds, determinism, no mutation, band edges, monotonicity of the
 *               scores, "adding information never adds a missing-information finding"...). A violation FAILS this test.
 *   FINDING     expectations a user would reasonably have that the current engine does not guarantee. Reported with a counterexample; does
 *               not fail the test; a candidate for the signed-off engine-fix workstream (or, where noted, a design requirement for Step 6).
 * Nothing here changes any engine.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { makeContext, rng } = require('./parity_run.js');

const WRITE = process.argv.includes('--report');
const M = makeContext();
const E = M.E, b = M.b;
const J = (v) => JSON.stringify(v);
const pick = (r, a) => a[Math.floor(r() * a.length)];
const clone = (v) => JSON.parse(JSON.stringify(v));
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

let mustPass = 0; const mustFail = []; const findings = [];
function must(c, m) { if (c) mustPass++; else { mustFail.push(m); if (mustFail.length <= 20) console.log('  MUST-HOLD VIOLATED:', m); } }
function finding(id, title, note, ok, ctx) { const f = findings.find((x) => x.id === id) || (findings[findings.push({ id, title, note, checked: 0, violations: 0, examples: [] }) - 1]); f.checked++; if (!ok) { f.violations++; if (f.examples.length < 3) f.examples.push(ctx); } }

const rd = rng(4321);
const USERS = [1, 2, 3, 4, 5], BUSINESS = [0, 1, 2, 3, 4, 5], WORKAROUND = [0, 1, 2], DURATION = [0, 1, 2, 3, 4], REGULATORY = [0, 2, 4, 5], RECURRING = [0, 2, 4];
const BLAST = [5, 10, 20, 30], COMPLEXITY = [5, 10, 20, 25], ROLLBACK = [2, 8, 15, 20], TESTING = [2, 8, 15, 20], HISTORY = [2, 5, 10, 15], TIMING = [2, 5, 8, 10];
const TIERS = ['P4', 'P3', 'P2', 'P1'];

console.log('incident_score');
const scoreOf = (f) => E.run('incident_score', f).output;
const SCALES = { users: USERS, business: BUSINESS, workaround: WORKAROUND, duration: DURATION, regulatory: REGULATORY, recurring: RECURRING };
for (let k = 0; k < 4000; k++) {
  const f = Object.fromEntries(Object.keys(SCALES).map((n) => [n, pick(rd, SCALES[n])])), before = J(f), o = scoreOf(f);
  must(J(f) === before, 'score does not mutate input');
  must(o.total >= 1 && o.total <= 25, 'score total is within 1..25: ' + J(o));
  must(o.is_major === (o.total >= 17), 'major flag is exactly total >= 17');
  must(o.suggested_tier === (o.total >= 17 ? 'P1' : o.total >= 11 ? 'P2' : o.total >= 6 ? 'P3' : 'P4'), 'tier follows the documented bands');
  Object.keys(SCALES).forEach((n) => {
    const i = SCALES[n].indexOf(f[n]);
    if (i < SCALES[n].length - 1) { const up = Object.assign({}, f, { [n]: SCALES[n][i + 1] }), u = scoreOf(up); must(u.total > o.total && TIERS.indexOf(u.suggested_tier) >= TIERS.indexOf(o.suggested_tier), 'raising ' + n + ' raises the score and never lowers the tier'); }
  });
}
// the form's "duration = recurring/seen before" option and the separate "recurring" factor both count (documented overlap)
finding('F-ITSM-1', 'A recurring problem is not counted twice in the triage score', 'duration option 4 ("Recurring / seen before") and the separate "recurring" factor are BOTH added (documented in the schema notes); a recurring incident can score up to 8 points from the same fact.',
  scoreOf({ users: 1, business: 0, workaround: 0, duration: 4, regulatory: 0, recurring: 4 }).total === scoreOf({ users: 1, business: 0, workaround: 0, duration: 4, regulatory: 0, recurring: 0 }).total, { with: scoreOf({ users: 1, business: 0, workaround: 0, duration: 4, regulatory: 0, recurring: 4 }).total, without: scoreOf({ users: 1, business: 0, workaround: 0, duration: 4, regulatory: 0, recurring: 0 }).total });

console.log('change_risk');
const FACT = { blast: BLAST, complexity: COMPLEXITY, rollback: ROLLBACK, testing: TESTING, history: HISTORY, timing: TIMING };
const LV = { low: 0, medium: 1, high: 2 };
for (let k = 0; k < 4000; k++) {
  const f = Object.fromEntries(Object.keys(FACT).map((n) => [n, pick(rd, FACT[n])])), o = E.run('change_risk', f).output;
  must(o.total >= 18 && o.total <= 120, 'change-risk total within 18..120: ' + J(o));
  must(o.level === (o.total <= 30 ? 'low' : o.total <= 60 ? 'medium' : 'high'), 'level follows the documented bands');
  Object.keys(FACT).forEach((n) => { const i = FACT[n].indexOf(f[n]); if (i < FACT[n].length - 1) { const u = E.run('change_risk', Object.assign({}, f, { [n]: FACT[n][i + 1] })).output; must(u.total > o.total && LV[u.level] >= LV[o.level], 'raising ' + n + ' raises the score and never lowers the level'); } });
}

console.log('routing_suggestion');
const WORDS = ['payment', 'login', 'database', 'network', 'kubernetes', 'batch', 'phishing', 'certificate', 'deploy', 'api', 'dns', 'okta', 'sql', 'timeout', 'slow', 'failed', 'billing', 'bug', 'the', 'users', 'cannot', 'error', 'bad', 'dashboard', 'download', 'data'];
let joinViolations = 0, joinChecked = 0; const joinExamples = [];
for (let k = 0; k < 6000; k++) {
  const obs = Array.from({ length: 1 + Math.floor(rd() * 4) }, () => pick(rd, WORDS)).join(' '), svc = Array.from({ length: Math.floor(rd() * 3) }, () => pick(rd, WORDS)).join(' ');
  const r1 = E.run('routing_suggestion', { observation: obs, service: svc }), r2 = E.run('routing_suggestion', { observation: obs, service: svc });
  must(J(r1) === J(r2), 'routing is deterministic');
  must(J(E.run('routing_suggestion', { observation: obs.toUpperCase(), service: svc.toUpperCase() })) === J(r1), 'routing is case-insensitive');
  // the two fields are joined WITHOUT a space, so words can fuse across the boundary ("failed" + "Billing" -> "failedbilling" contains "db")
  const spaced = E.run('routing_suggestion', { observation: obs + ' ', service: svc });
  if (svc) { joinChecked++; if (J(spaced.output) !== J(r1.output) || spaced.status !== r1.status) { joinViolations++; if (joinExamples.length < 3) joinExamples.push({ observation: obs, service: svc, without_space: r1.output && r1.output.group, with_space: spaced.output && spaced.output.group }); } }
}
findings.push({ id: 'F-ITSM-2', title: 'The suggested team does not depend on whether a space separates the observation from the service name', note: 'Known legacy quirk (Step 0): the fields are joined without a space.', checked: joinChecked, violations: joinViolations, examples: joinExamples });

console.log('preflight');
const BLANKABLE = [['startedAt', '2026-10-10T09:00'], ['ci', 'CI-1'], ['assignmentGroup', 'Ops'], ['service', 'Payment API'], ['shortDescription', 'A reasonably long incident description here'], ['diagnosis', 'A properly detailed diagnosis text'], ['rootCause', 'Connection pool exhausted'], ['permanentFix', 'Raise pool size and alert']];
const warnTypes = (o) => o.findings.filter((f) => f.type === 'pf-block' || f.type === 'pf-warn').map((f) => f.title);
for (let k = 0; k < 3000; k++) {
  const base = { shortDescription: pick(rd, ['', 'short', 'A reasonably long incident description here']), observation: '', service: pick(rd, ['', 'Payment API', 'Intranet']), startedAt: pick(rd, ['', '2026-10-10T09:00']),
    diagnosis: pick(rd, ['', 'short', 'A properly detailed diagnosis text']), assignmentGroup: pick(rd, ['', 'Ops']), ci: pick(rd, ['', 'CI-1']), resolvedAt: '', resolution: '', rootCause: pick(rd, ['', 'Connection pool exhausted']),
    permanentFix: pick(rd, ['', 'Raise pool size and alert']), severity: pick(rd, ['', 'P1', 'P2', 'P3', 'P4']), triageScore: pick(rd, [0, 4, 8, 12, 18]), timelineCount: pick(rd, [0, 2, 5]), decisionCount: pick(rd, [0, 2]), regulatoryFlagChecked: rd() < 0.5 };
  const o = E.run('preflight', base).output, w0 = warnTypes(o);
  must(J(E.run('preflight', base).output) === J(o), 'preflight is deterministic');
  const order = o.findings.map((f) => f.type).map((t) => ({ 'pf-block': 0, 'pf-warn': 1, 'pf-info': 2, 'pf-good': 3 })[t]);
  must(order.every((v, i, a) => !i || a[i - 1] <= v), 'findings are ordered blocking, warning, information, positive');
  BLANKABLE.forEach(([field, value]) => {
    if (!String(base[field] || '').trim()) {
      const filled = Object.assign({}, base, { [field]: value }), w1 = warnTypes(E.run('preflight', filled).output);
      const added = w1.filter((t) => !w0.includes(t));
      // filling a blank may legitimately ADD the payment/personal-data keyword warning when the new text contains such a word; exclude that
      must(added.filter((t) => !/keyword|data incident/.test(t)).length === 0, 'filling in "' + field + '" never ADDS a missing-information warning: ' + J(added));
    }
  });
  const sev = base.severity, sc = base.triageScore;
  const suggested = sc >= 17 ? 'P1' : sc >= 11 ? 'P2' : sc >= 6 ? 'P3' : 'P4';
  must(o.findings.some((f) => /^Severity override/.test(f.title)) === !!(sev && sc > 0 && sev !== suggested), 'the severity-override warning appears exactly when a tier is chosen, the score is above 0 and they differ');
}

console.log('currency_risk');
const cr = (inp) => E.run('currency_risk', inp, [], { now: NOW });
for (let k = 0; k < 3000; k++) {
  const d1 = Math.floor(rd() * 900), d2 = d1 + 1 + Math.floor(rd() * 400);
  const iso = (d) => new Date(NOW - d * 86400000).toISOString().slice(0, 10);
  const mk = (pen, pat) => ({ certificates: [], vulnerabilities: [], supportStatus: '', lastPentest: pen, lastPatched: pat });
  const young = cr(mk(iso(d1), iso(d1))).output.risks.length, old = cr(mk(iso(d2), iso(d2))).output.risks.length;
  must(old >= young, 'an older pen-test / patch date never removes a risk');
  const certs = Array.from({ length: Math.floor(rd() * 4) }, () => ({ name: 'c', status: pick(rd, ['unknown', 'expired', 'critical', 'warn', 'ok']), daysLeft: Math.floor(rd() * 90) }));
  const base = cr({ certificates: certs, vulnerabilities: [], supportStatus: '', lastPentest: '', lastPatched: '' }).output.risks.length;
  const worse = cr({ certificates: certs.concat([{ name: 'x', status: 'expired', daysLeft: 0 }]), vulnerabilities: [], supportStatus: '', lastPentest: '', lastPatched: '' }).output.risks.length;
  must(worse === base + 1, 'adding an expired certificate adds exactly one risk');
}
// status and days-left are two independent inputs; the FORM derives status from the expiry date, but an assistant-supplied pair could disagree
{
  let bad = 0, n = 0; const ex = [];
  for (const status of ['ok', 'warn', 'unknown']) for (const daysLeft of [-30, -1, 0]) { n++; const r = cr({ certificates: [{ name: 'api', status, daysLeft }], vulnerabilities: [], supportStatus: '', lastPentest: '', lastPatched: '' }).output.risks.length; if (r === 0) { bad++; if (ex.length < 3) ex.push({ status, daysLeft }); } }
  findings.push({ id: 'F-ITSM-3', title: 'A certificate with zero or negative days left is flagged, whatever its status field says', note: 'DESIGN REQUIREMENT FOR STEP 6: the form derives status from the expiry date, so this cannot happen in the form; an assistant-supplied (status, daysLeft) pair could disagree. The assistant path must supply an expiry date and derive both, or reject inconsistent pairs.', checked: n, violations: bad, examples: ex });
}
{
  const unk = cr({ certificates: [], vulnerabilities: [], supportStatus: 'unknown', lastPentest: '', lastPatched: '' }).output.risks.length;
  findings.push({ id: 'F-ITSM-4', title: 'An "unknown" support status raises a risk or a prompt', note: 'Known legacy behaviour (Step 0): "unknown" raises nothing, so not knowing the support status reads the same as being supported.', checked: 1, violations: unk === 0 ? 1 : 0, examples: unk === 0 ? [{ supportStatus: 'unknown', risks: 0 }] : [] });
}

console.log(`\nmust-hold: ${mustPass} passed, ${mustFail.length} violated`);
console.log('findings (expectations the current engine does not guarantee):');
findings.forEach((f) => console.log(`  ${f.id} ${f.violations ? 'VIOLATED' : 'holds'}  ${f.violations}/${f.checked}  ${f.title}` + (f.violations ? '\n      e.g. ' + J(f.examples[0]).slice(0, 300) : '')));

if (WRITE) {
  const L = ['# Invariants / property-test findings - ITSM Workflow Intelligence tool', '', '*Generated by `agent-layer/tests/invariants_run.js` (seeded, reproducible). Nothing in the tool has been changed.*', '',
    '**Must-hold properties** (bounds, determinism, no mutation, documented band edges, monotonic scores, ordering of pre-flight findings, "adding information never adds a missing-information warning", severity-override rule): **' + mustPass + ' checks passed, ' + mustFail.length + ' violated.**', '',
    '**Findings** - expectations a user would reasonably have that the current engine does not guarantee. Candidates for the signed-off engine-fix workstream (or Step 6 design requirements); none applied:', '',
    '| ID | Expectation | Violations / cases | Note | Example |', '|---|---|---|---|---|'];
  findings.forEach((f) => L.push(`| ${f.id} | ${f.title} | ${f.violations} / ${f.checked} | ${f.note || ''} | ${f.violations ? '`' + J(f.examples[0]).slice(0, 200).replace(/\|/g, '/') + '`' : '-'} |`));
  L.push('');
  fs.writeFileSync(path.join(__dirname, '..', '..', 'INVARIANT-FINDINGS.md'), L.join('\n'), 'utf8');
  console.log('wrote INVARIANT-FINDINGS.md');
}
process.exit(mustFail.length ? 1 : 0);
