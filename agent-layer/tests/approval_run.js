#!/usr/bin/env node
/*
 * Change approval record and "may be out of date" tests (N1) - ITSM repo, per-tool file.
 *   node agent-layer/tests/approval_run.js
 * Runs the tool's REAL source (extracted from the tool HTML) in a VM. The drift check is a prompt to look again; these tests pin down that it:
 *   - says nothing when nothing changed;
 *   - names each kind of change, checked against an oracle written independently here over thousands of random before/after pairs;
 *   - counts an approval as out of date only when something got worse, or it has expired;
 *   - never changes its inputs or the recorded approval, and gives the same answer for the same input;
 *   - raises no false alarm for an approval with nothing to compare with;
 *   - can fail: deliberate faults in the real source must each be caught.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const html = fs.readFileSync(path.resolve(ROOT, cfg.html), 'utf8').replace(/\r\n/g, '\n');
const i0 = html.indexOf('<!-- AGENT-LAYER:BEGIN');
const SRC = i0 === -1 ? html : html.slice(0, i0);

function declaration(src, name) {
  const lines = src.split('\n');
  const re = new RegExp('^(function ' + name + '\\(|(const|let|var)\\s+' + name + '\\s*=)');
  const starts = []; lines.forEach((l, k) => { if (re.test(l)) starts.push(k); });
  if (starts.length !== 1) throw new Error('declaration "' + name + '" found ' + starts.length + ' times');
  const s = starts[0], one = lines[s];
  if (/\}\s*;?\s*$|;\s*$/.test(one) && one.split('{').length === one.split('}').length) return one;
  for (let j = s + 1; j < lines.length; j++) if (lines[j] === '}') return lines.slice(s, j + 1).join('\n');
  throw new Error('no end for ' + name);
}
const NAMES = ['CHANGE_RISK_BANDS', 'APPROVAL_LEVEL_RANK', 'APPROVAL_FREEZE_WORDS', 'APPROVAL_TYPE_WORDS', 'changeRiskLevel', 'approvalSnapshotFrom', 'approvalDrift'];
function load(src) {
  const ctx = vm.createContext({});
  vm.runInContext(NAMES.map((n) => declaration(src, n)).join('\n') + '\nvar __b = { changeRiskLevel, approvalSnapshotFrom, approvalDrift };', ctx, { filename: 'tool-real-source' });
  return ctx.__b;
}
const T = load(SRC);

let pass = 0; const failures = [];
function ok(c, m) { if (c) pass++; else { failures.push(m); if (failures.length <= 30) console.log('  FAIL:', m); } }
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const pick = (r, a) => a[Math.floor(r() * a.length)];
const clone = (o) => JSON.parse(JSON.stringify(o));
function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach((k) => deepFreeze(o[k])); } return o; }

// The real form's six factors and their option scores (0 = "Select..." = not answered).
const FACTORS = {
  rf_blast: [0, 5, 10, 20, 30], rf_complexity: [0, 5, 10, 15, 20], rf_rollback: [0, 5, 10, 15, 20],
  rf_testing: [0, 5, 10, 15, 20], rf_history: [0, 5, 10, 15, 20], rf_timing: [0, 5, 10, 15, 20],
};
const TYPES = ['normal', 'standard', 'emergency'], FREEZE = ['no', 'yes', 'exempt'], WINDOWS = ['Sat 01:00-05:00', 'Sun 02:00-04:00', ''];
function mkInput(r) {
  return {
    factors: Object.keys(FACTORS).map((id) => { const v = pick(r, FACTORS[id]); return { id, label: 'L-' + id, value: v, chosen: 'opt' + v, unset: v === 0 }; }),
    type: pick(r, TYPES), freeze: pick(r, FREEZE), window: pick(r, WINDOWS), rollbackPlan: r() < 0.6,
  };
}
function mutateInput(r, inp) {
  const o = clone(inp);
  const n = Math.floor(r() * 4);
  for (let k = 0; k < n; k++) {
    const which = Math.floor(r() * 5);
    if (which === 0) { const f = pick(r, o.factors), v = pick(r, FACTORS[f.id]); f.value = v; f.chosen = 'opt' + v; f.unset = v === 0; }
    else if (which === 1) o.type = pick(r, TYPES);
    else if (which === 2) o.freeze = pick(r, FREEZE);
    else if (which === 3) o.window = pick(r, WINDOWS);
    else o.rollbackPlan = !o.rollbackPlan;
  }
  return o;
}

// Independent oracle: written from the design note (Findings s20/s21), not from the tool's code.
const LEVEL = (t) => (t >= 61 ? 'high' : t >= 31 ? 'medium' : 'low');
const RANK = { low: 0, medium: 1, high: 2 };
function oracle(before, after, expiresAt, nowMs) {
  const kinds = []; let adverse = 0, improved = 0;
  const add = (k, e) => { kinds.push(k); if (e === 'a') adverse++; else if (e === 'i') improved++; };
  before.factors.forEach((a) => {
    const b = after.factors.find((x) => x.id === a.id);
    if (!a.unset && b.unset) return add('factor_cleared', 'a');
    if (a.unset && !b.unset) return add('factor_answered', 'n');
    if (b.value > a.value) add('factor_raised', 'a'); else if (b.value < a.value) add('factor_lowered', 'i');
  });
  const tb = before.factors.reduce((t, f) => t + f.value, 0), ta = after.factors.reduce((t, f) => t + f.value, 0);
  const ib = before.factors.some((f) => f.unset), ia = after.factors.some((f) => f.unset);
  if (!ib && ia) add('level_unknown', 'a');
  else if (ib && !ia) add('level_known', 'n');
  else if (!ib && LEVEL(tb) !== LEVEL(ta)) add('level', RANK[LEVEL(ta)] > RANK[LEVEL(tb)] ? 'a' : 'i');
  const fz = (x) => (x === 'yes' || x === 'exempt' ? 1 : 0);
  if (before.freeze !== after.freeze) add('freeze', fz(after.freeze) > fz(before.freeze) ? 'a' : fz(after.freeze) < fz(before.freeze) ? 'i' : 'n');
  if (before.rollbackPlan && !after.rollbackPlan) add('rollback_removed', 'a'); else if (!before.rollbackPlan && after.rollbackPlan) add('rollback_added', 'i');
  if (before.type !== after.type) add('type', 'a');
  if (before.window !== after.window) add('window', 'n');
  const t = Date.parse(expiresAt || ''), expired = !!expiresAt && !isNaN(t) && nowMs > t;
  return { kinds: kinds.sort(), adverse, improved, expired, outOfDate: expired || adverse > 0 };
}
const NOW = Date.parse('2026-10-24T12:00:00Z');
const rec = (inp, expiresAt) => ({ approvedBy: 'CAB chair', approvedAt: '2026-10-24T09:00', rationale: 'r', expiresAt: expiresAt || '', rollback: 'rb', snapshot: T.approvalSnapshotFrom(inp, 'v25', '2026-10-24T09:00:00Z'), reconfirmations: [] });

function runSuite(Tx, quiet) {
  let bad = 0; const note = (c, m) => { if (!c) { bad++; if (!quiet) ok(false, m); } else if (!quiet) ok(true, m); };
  const r = rng(20261024);
  for (let i = 0; i < 4000; i++) {
    const a = mkInput(r), b = r() < 0.15 ? clone(a) : mutateInput(r, a);
    const exp = pick(r, ['', '', '2026-10-24T11:00', '2026-10-25T09:00', 'not a date']);
    const R = Tx.approvalDrift(deepFreeze(rec(a, exp)), deepFreeze(clone(b)), NOW), O = oracle(a, b, exp, NOW);
    const kinds = R.changes.map((c) => c.kind).sort();
    note(JSON.stringify(kinds) === JSON.stringify(O.kinds), 'case ' + i + ' kinds ' + JSON.stringify(kinds) + ' vs oracle ' + JSON.stringify(O.kinds));
    note(R.adverse === O.adverse && R.improved === O.improved, 'case ' + i + ' worse/better counts ' + R.adverse + '/' + R.improved + ' vs ' + O.adverse + '/' + O.improved);
    note(R.expired === O.expired && R.outOfDate === O.outOfDate, 'case ' + i + ' expired/outOfDate ' + R.expired + '/' + R.outOfDate + ' vs ' + O.expired + '/' + O.outOfDate);
    if (JSON.stringify(a) === JSON.stringify(b)) note(R.changes.length === 0, 'case ' + i + ' no change but changes listed');
  }
  return bad;
}
console.log('approval drift vs independent oracle (4,000 random before/after pairs)');
runSuite(T, false);

console.log('named cases');
const base = { factors: Object.keys(FACTORS).map((id) => ({ id, label: 'L-' + id, value: 10, chosen: 'ten', unset: false })), type: 'normal', freeze: 'no', window: 'Sat', rollbackPlan: true };
const sb = T.approvalSnapshotFrom(base, 'v25', 'x');
ok(sb.total === 60 && sb.level === 'medium' && sb.incomplete === false, 'snapshot total/level for six tens: ' + JSON.stringify([sb.total, sb.level, sb.incomplete]));
ok(T.approvalSnapshotFrom({ factors: [] }, '', '').incomplete === true && T.approvalSnapshotFrom({ factors: [] }, '', '').level === null, 'no factors = incomplete, no level');
ok(T.approvalDrift(null, base, NOW).recorded === false, 'no approval = nothing recorded, no alarm');
const noSnap = T.approvalDrift({ approvedBy: 'x', snapshot: null }, base, NOW);
ok(noSnap.recorded && noSnap.noSnapshot && noSnap.changes.length === 0 && !noSnap.outOfDate, 'an approval with nothing to compare raises no false alarm');
const raised = clone(base); raised.factors[0].value = 20; raised.factors[0].chosen = 'twenty';
const dRaised = T.approvalDrift(rec(base), raised, NOW);
ok(dRaised.outOfDate && dRaised.changes.some((c) => c.kind === 'factor_raised' && /L-rf_blast raised from “ten” \(10\) to “twenty” \(20\)/.test(c.text)) && dRaised.changes.some((c) => c.kind === 'level' && /medium to high/.test(c.text)), 'raising a factor that crosses a band names both');
const lowered = clone(base); lowered.factors[0].value = 5; lowered.factors[0].chosen = 'five';
ok(!T.approvalDrift(rec(base), lowered, NOW).outOfDate, 'only improvements: not out of date');
ok(T.approvalDrift(rec(base, '2026-10-24T11:59'), base, NOW).outOfDate === true, 'expired with no other change: out of date');
ok(T.approvalDrift(rec(base, 'garbage'), base, NOW).expired === false, 'an unreadable expiry raises no alarm');
const frozen = clone(base); frozen.freeze = 'yes';
ok(T.approvalDrift(rec(base), frozen, NOW).changes.some((c) => c.kind === 'freeze' && c.effect === 'adverse'), 'a freeze being set is worse');
const noRb = clone(base); noRb.rollbackPlan = false;
ok(T.approvalDrift(rec(base), noRb, NOW).changes.some((c) => c.kind === 'rollback_removed'), 'an emptied rollback plan is named');
const emerg = clone(base); emerg.type = 'emergency';
ok(T.approvalDrift(rec(base), emerg, NOW).outOfDate, 'a change of type puts the approval out of date');

console.log('purity and determinism');
const rp = rng(7);
for (let i = 0; i < 300; i++) {
  const a = mkInput(rp), b = mutateInput(rp, a), R = rec(a, '2026-10-25T00:00');
  const r0 = JSON.stringify(R), b0 = JSON.stringify(b);
  const x = T.approvalDrift(R, b, NOW), y = T.approvalDrift(R, b, NOW);
  ok(JSON.stringify(R) === r0 && JSON.stringify(b) === b0, 'case ' + i + ' inputs unchanged');
  ok(JSON.stringify(x) === JSON.stringify(y), 'case ' + i + ' same input gives the same answer');
  let threw = false; try { T.approvalDrift(deepFreeze(clone(R)), deepFreeze(clone(b)), NOW); } catch (e) { threw = true; }
  ok(!threw, 'case ' + i + ' works on frozen inputs');
}

console.log('the test can fail: deliberate faults in the real source must be caught');
const MUTANTS = [
  ['adverse/improved swapped for raised factors', "name+' raised from “'+a.chosen+'” ('+a.value+') to “'+b.chosen+'” ('+b.value+')','adverse')", "name+' raised from “'+a.chosen+'” ('+a.value+') to “'+b.chosen+'” ('+b.value+')','improved')"],
  ['expiry ignored', 'out.outOfDate=out.expired||out.adverse>0;', 'out.outOfDate=out.adverse>0;'],
  ['an unreadable expiry raises an alarm', 'if(!isNaN(t)&&nowMs>t)out.expired=true;', 'if(isNaN(t)||nowMs>t)out.expired=true;'],
  ['cleared factor not noticed', "if(!a.unset&&b.unset){add('factor_cleared'", "if(false){add('factor_cleared'"],
  ['freeze direction reversed', "fr(now.freeze)>fr(was.freeze)?'adverse'", "fr(now.freeze)<fr(was.freeze)?'adverse'"],
  ['rollback removal not noticed', "if(was.rollbackPlan&&!now.rollbackPlan)", "if(false)"],
  ['type change ignored', 'if(was.type!==now.type)', 'if(false)'],
  ['window change ignored', 'if(was.window!==now.window)', 'if(false)'],
  ['level band compared by total, not band', '!was.incomplete&&now.level!==was.level', '!was.incomplete&&now.total!==was.total'],
  ['improvements also raise the alarm', 'out.outOfDate=out.expired||out.adverse>0;', 'out.outOfDate=out.expired||out.adverse>0||out.improved>0;'],
];
let killed = 0;
MUTANTS.forEach(([name, from, to]) => {
  if (SRC.split(from).length !== 2) { ok(false, 'mutant "' + name + '" could not be applied (source changed?)'); return; }
  const bad = runSuite(load(SRC.replace(from, to)), true);
  if (bad > 0) killed++; else ok(false, 'mutant survived: ' + name);
});
ok(killed === MUTANTS.length, 'mutants killed ' + killed + '/' + MUTANTS.length);
console.log('  mutants: ' + killed + '/' + MUTANTS.length + ' killed');

if (failures.length) { console.log('APPROVAL FAILED: ' + failures.length + ' failure(s), ' + pass + ' passed'); process.exit(1); }
console.log('APPROVAL PASS: ' + pass + ' assertions');
