#!/usr/bin/env node
/*
 * "Why this score, and what would change it" tests (W1) - ITSM repo, per-tool file.
 *   node agent-layer/tests/explain_run.js
 * Runs the tool's REAL source (extracted from itsm-workflow-tool-v25.html) in a VM, with the REAL answer options read from the page's own selects.
 * The explanation must never disagree with the score on screen:
 *   - the parts add up; a total that does not match is refused (fail closed);
 *   - the band comes from the same table the screen uses, checked here against thresholds written out independently;
 *   - every "what would change it" is re-computed independently, and the list is checked for completeness over EVERY combination of answers;
 *   - an unset change-risk factor never produces a level.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const html = fs.readFileSync(path.resolve(ROOT, cfg.html), 'utf8').replace(/\r\n/g, '\n');
const i0 = html.indexOf('<!-- AGENT-LAYER:BEGIN');
const src = i0 === -1 ? html : html.slice(0, i0);

function declaration(name) {
  const lines = src.split('\n');
  const declRe = new RegExp('^(const|let|var)\\s+' + name + '\\s*=');
  const starts = [];
  lines.forEach((l, i) => { if (l.startsWith('function ' + name + '(') || declRe.test(l)) starts.push(i); });
  if (starts.length !== 1) throw new Error('declaration "' + name + '" found ' + starts.length + ' times');
  const s = starts[0], fn = lines[s].startsWith('function ');
  if (fn) { const one = lines[s]; if (/\}\s*$/.test(one) && one.split('{').length === one.split('}').length) return one; }
  for (let j = s; j < lines.length; j++) { const l = lines[j]; if (fn ? l === '}' : (/^[\]}];?$/.test(l) || (j === s && /;\s*$/.test(l)))) return lines.slice(s, j + 1).join('\n'); }
  throw new Error('no end for ' + name);
}
const ctx = vm.createContext({ console });
vm.runInContext(['INCIDENT_BANDS', 'CHANGE_RISK_BANDS', 'incidentScoreBand', 'changeRiskLevel', 'explainFactors'].map(declaration).join('\n') +
  '\nvar __b = { INCIDENT_BANDS, CHANGE_RISK_BANDS, incidentScoreBand, changeRiskLevel, explainFactors };', ctx, { filename: 'tool-real-source' });
const T = ctx.__b;

let pass = 0; const failures = [];
function ok(c, m) { if (c) pass++; else { failures.push(m); if (failures.length <= 30) console.log('  FAIL:', m); } }
const J = (v) => JSON.stringify(v);

// the real answer options, read from the page's own HTML
function optionsOf(id) {
  const m = html.match(new RegExp('<select[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)</select>'));
  if (!m) throw new Error('select not found: ' + id);
  return Array.from(m[1].matchAll(/<option value="(\d+)"[^>]*>([^<]*)<\/option>/g)).map((o) => ({ value: parseInt(o[1], 10), text: o[2].trim() }));
}
const INCIDENT_IDS = ['t1_users', 't1_business', 't1_workaround', 't1_duration', 't1_regulatory', 't1_recurring'];
const CHANGE_IDS = ['rf_blast', 'rf_complexity', 'rf_rollback', 'rf_testing', 'rf_history', 'rf_timing'];
const inc = INCIDENT_IDS.map((id) => ({ id, label: id, options: optionsOf(id) }));
const chg = CHANGE_IDS.map((id) => ({ id, label: id, options: optionsOf(id) }));
ok(inc.every((f) => f.options.length >= 3) && chg.every((f) => f.options.length >= 4), 'the real options were read: ' + inc.map((f) => f.options.length).join('/') + ' and ' + chg.map((f) => f.options.length).join('/'));
ok(inc.reduce((s, f) => s + Math.max.apply(null, f.options.map((o) => o.value)), 0) === 25, 'the six incident factors can add up to 25 at most (as the screen says: "out of 25")');
ok(chg.reduce((s, f) => s + Math.max.apply(null, f.options.map((o) => o.value)), 0) === 120, 'the six change-risk factors can add up to 120 at most (as the screen says: "out of 120")');

// the band tables, against thresholds written out here independently
const indepIncident = (n) => (n <= 5 ? 'P4' : n <= 10 ? 'P3' : n <= 16 ? 'P2' : 'P1');
const indepChange = (n) => (n <= 30 ? 'low' : n <= 60 ? 'medium' : 'high');
for (let n = 0; n <= 25; n++) ok(T.incidentScoreBand(n).key === indepIncident(n), 'incident band for ' + n);
for (let n = 0; n <= 120; n++) ok(T.changeRiskLevel(n) === indepChange(n), 'change-risk level for ' + n);
const verdicts = { P4: 'Low impact — P4 or near miss likely', P3: 'Moderate impact — P3 likely', P2: 'High impact — P2 recommended', P1: 'Critical — P1 / Major Incident threshold reached' };
const classes = { P4: 'score-low', P3: 'score-low', P2: 'score-med', P1: 'score-high' };
['P4', 'P3', 'P2', 'P1'].forEach((k) => { const b = T.INCIDENT_BANDS.find((x) => x.key === k); ok(b.verdict === verdicts[k] && b.cls === classes[k], 'the screen text and colour for ' + k + ' are unchanged'); });
ok(T.INCIDENT_BANDS.map((b) => b.rank).join() === '0,1,2,3' && T.CHANGE_RISK_BANDS.map((b) => b.rank).join() === '0,1,2', 'ranks run low to high');

const bandOfIncident = (n) => { const b = T.incidentScoreBand(n); return { key: b.key, rank: b.rank, min: b.min }; };
const bandOfChange = (n) => { const b = T.CHANGE_RISK_BANDS.find((x) => x.key === T.changeRiskLevel(n)); return { key: b.key, rank: b.rank, min: b.min }; };
const factorsFor = (defs, picks, unsetText) => defs.map((f, i) => { const o = f.options[picks[i]]; return { id: f.id, label: f.label, value: o.value, chosen: o.text, options: f.options, unset: unsetText ? (o.value === 0 && unsetText.test(o.text)) : false }; });

// ------------------------------------------------------------------ incident score: EVERY combination of answers
function* combos(defs) { const idx = defs.map(() => 0); for (;;) { yield idx.slice(); let k = 0; for (; k < idx.length; k++) { idx[k]++; if (idx[k] < defs[k].options.length) break; idx[k] = 0; } if (k === idx.length) return; } }
let nCombos = 0, nChanges = 0;
for (const picks of combos(inc)) {
  nCombos++;
  const factors = factorsFor(inc, picks, null);
  const sum = factors.reduce((t, f) => t + f.value, 0);
  const ex = T.explainFactors({ total: sum, factors, bandOf: bandOfIncident, bands: T.INCIDENT_BANDS, incompleteWhenUnset: false });
  if (!(ex.ok && ex.total === sum && ex.band.key === indepIncident(sum) && !ex.incomplete)) { ok(false, 'combo ' + picks + ': total / band wrong ' + J(ex).slice(0, 120)); continue; }
  // independent enumeration of every single-answer change that would alter the band
  const expected = [];
  factors.forEach((f) => f.options.forEach((o) => { if (o.value === f.value) return; const t = sum - f.value + o.value; if (indepIncident(t) !== indepIncident(sum)) expected.push(f.id + '|' + o.text + '|' + t); }));
  const got = ex.changes.map((c) => c.id + '|' + c.to + '|' + c.newTotal);
  if (J(expected.slice().sort()) !== J(got.slice().sort())) ok(false, 'combo ' + picks + ': the list of band changes is not complete / correct');
  else pass++;
  ex.changes.forEach((c) => { nChanges++; if (!(c.delta === c.newTotal - sum && c.newBand === indepIncident(c.newTotal) && c.dir === (['P4', 'P3', 'P2', 'P1'].indexOf(c.newBand) > ['P4', 'P3', 'P2', 'P1'].indexOf(ex.band.key) ? 'up' : 'down'))) ok(false, 'combo ' + picks + ': a change is described wrongly: ' + J(c)); });
  ok(ex.changes.every((c, i, a) => i === 0 || Math.abs(a[i - 1].delta) <= Math.abs(c.delta)), 'combo ' + picks + ': smallest change first');
  const order = ['P4', 'P3', 'P2', 'P1'], mins = { P4: 0, P3: 6, P2: 11, P1: 17 }, k = order.indexOf(indepIncident(sum));
  ok(J(ex.toUp) === J(k < 3 ? { key: order[k + 1], points: mins[order[k + 1]] - sum } : null), 'combo ' + picks + ': points to the next band up');
  ok(J(ex.toDown) === J(k > 0 ? { key: order[k - 1], points: sum - mins[order[k]] + 1 } : null), 'combo ' + picks + ': points to drop a band');
}
ok(nCombos === inc.reduce((n, f) => n * f.options.length, 1) && nChanges > 1000, 'every combination was checked (' + nCombos + ' combinations, ' + nChanges + ' band changes)');

// a total that does not match what is on screen is refused
{
  const f = factorsFor(inc, [1, 1, 1, 1, 1, 1], null), sum = f.reduce((t, x) => t + x.value, 0);
  ok(T.explainFactors({ total: sum + 1, factors: f, bandOf: bandOfIncident, bands: T.INCIDENT_BANDS }).ok === false, 'a total that does not match the factors is refused, not explained');
  ok(T.explainFactors({ total: sum - 1, factors: f, bandOf: bandOfIncident, bands: T.INCIDENT_BANDS }).reason === 'total_mismatch', 'the refusal says why');
}

// ------------------------------------------------------------------ change risk: complete, and incomplete (unset factors never give a level)
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const rd = rng(7);
let nIncomplete = 0, nComplete = 0;
for (let k = 0; k < 3000; k++) {
  const picks = chg.map((f) => (rd() < 0.35 ? 0 : 1 + Math.floor(rd() * (f.options.length - 1))));
  const factors = factorsFor(chg, picks, /^select/i), sum = factors.reduce((t, f) => t + f.value, 0), unset = factors.filter((f) => f.unset);
  const ex = T.explainFactors({ total: sum, factors, bandOf: bandOfChange, bands: T.CHANGE_RISK_BANDS, incompleteWhenUnset: true });
  if (unset.length) {
    nIncomplete++;
    let lo = sum, hi = sum; unset.forEach((f) => { const nz = f.options.map((o) => o.value).filter((v) => v > 0); lo += Math.min.apply(null, nz); hi += Math.max.apply(null, nz); });
    ok(ex.incomplete === true && ex.band === null && ex.changes.length === 0 && ex.toUp === null && ex.range.min === lo && ex.range.max === hi, 'incomplete case ' + k + ': no level, correct range ' + lo + '-' + hi + ' got ' + J(ex.range));
    ok(J(ex.unset.sort()) === J(unset.map((f) => f.id).sort()), 'incomplete case ' + k + ': the unset factors are named');
  } else {
    nComplete++;
    ok(ex.ok && !ex.incomplete && ex.band.key === indepChange(sum), 'complete case ' + k + ': level');
    const expected = []; factors.forEach((f) => f.options.forEach((o) => { if (o.value === f.value) return; const t = sum - f.value + o.value; if (indepChange(t) !== indepChange(sum)) expected.push(f.id + '|' + o.text + '|' + t); }));
    ok(J(expected.sort()) === J(ex.changes.map((c) => c.id + '|' + c.to + '|' + c.newTotal).sort()), 'complete case ' + k + ': band changes complete and correct');
  }
}
ok(nIncomplete > 500 && nComplete > 100, 'both complete and incomplete change-risk cases were covered (' + nComplete + ' / ' + nIncomplete + ')');
// the "Select..." option really is the unset marker in the page
ok(chg.every((f) => f.options[0].value === 0 && /^select/i.test(f.options[0].text)), 'every change-risk factor starts at "Select..." with value 0');
// inputs are not changed
{
  const f = factorsFor(chg, [1, 1, 1, 1, 1, 1], /^select/i), copy = J(f);
  T.explainFactors({ total: f.reduce((t, x) => t + x.value, 0), factors: f, bandOf: bandOfChange, bands: T.CHANGE_RISK_BANDS, incompleteWhenUnset: true });
  ok(J(f) === copy, 'the explanation does not change its inputs');
}

console.log(failures.length ? 'EXPLAIN FAILED: ' + failures.length + ' failure(s), ' + pass + ' passed' : 'EXPLAIN PASS: ' + pass + ' assertions');
process.exit(failures.length ? 1 : 0);
