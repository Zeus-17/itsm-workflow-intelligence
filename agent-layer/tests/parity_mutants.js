#!/usr/bin/env node
/*
 * Mutation check for the engine parity test (ITSM repo; per-tool file).
 *   node agent-layer/tests/parity_mutants.js
 * Applies small deliberate faults to a COPY of engine-exports.js (one at a time) and requires tests/parity_run.js to FAIL for each.
 * A surviving mutant means the parity test has a blind spot. Run after any change to engine-exports.js or the parity test.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'engine-exports.js');
const TEST = path.join(__dirname, 'parity_run.js');
const original = fs.readFileSync(SRC, 'utf8');

// [name, exact text to find, replacement]  (the first occurrence is replaced)
const MUTANTS = [
  ['score: P1 threshold 17 -> 18', "total >= 17 ? 'P1'", "total >= 18 ? 'P1'"],
  ['score: P2 threshold 11 -> 12', "total >= 11 ? 'P2'", "total >= 12 ? 'P2'"],
  ['score: P3 threshold 6 -> 7', "total >= 6 ? 'P3'", "total >= 7 ? 'P3'"],
  ['score: major flag 17 -> 18', 'is_major: total >= 17', 'is_major: total >= 18'],
  ['score: verdict wording changed', 'High impact — P2 recommended', 'High impact — P2 likely'],
  ['score: factor left out of the total', 'input.users + input.business + input.workaround + input.duration + input.regulatory + input.recurring', 'input.users + input.business + input.workaround + input.duration + input.regulatory'],
  ['change risk: low band <= 30 -> < 30', 'total <= 30 ?', 'total < 30 ?'],
  ['change risk: medium band <= 60 -> <= 61', 'total <= 60 ?', 'total <= 61 ?'],
  ['intel: links dropped', "(rule.links ? '<br><br>' + rule.links : '')", "''"],
  ['preflight: short description minimum 10 -> 9', 'obs.trim().length < 10', 'obs.trim().length < 9'],
  ['preflight: brief diagnosis 20 -> 21', 'diag.trim().length < 20', 'diag.trim().length < 21'],
  ['preflight: override warning ignores score > 0', 'if (sev && score > 0) {', 'if (sev) {'],
  ['preflight: payment keyword "funds" dropped', '|purchases?|funds?|refunds?|', '|purchases?|refunds?|'],
  ['preflight: personal-data keyword dropped', '|email addresses?|account numbers?|', '|email addresses?|'],
  ['preflight: strong timeline > 3 -> >= 3', 'tlCount > 3', 'tlCount >= 3'],
  ['preflight: decision log prompt for every severity', "decCount === 0 && (sev === 'P1' || sev === 'P2')", 'decCount === 0'],
  ['preflight: findings reordered (second blocker first)', "f('pf-block', 'Short description is missing or too brief');\n    if (!svc) f('pf-block', 'No service name entered');", "f('pf-block', 'Short description is missing or too brief'); if (false) f('x', 'y');\n    if (!svc) f('pf-block', 'No service name entered'); findings.reverse();"],
  ['routing: matched keywords dropped', 'if (rule.matched && rule.matched.length) out.matched_keywords = rule.matched.slice();', ''],
  ['routing: the tool\'s own routing function bypassed', "var rule = table('suggestRoutingGroup')(input.observation, input.service);", 'var rule = null;'],
  ['currency: unknown-support prompt dropped', "else if (input.supportStatus === 'unknown') risks.push('Vendor support status is unknown — confirm whether this component is still supported');", ''],
  ['currency: pen-test staleness 365 -> 364', 'daysSince > 365', 'daysSince > 364'],
  ['currency: patch staleness 180 -> 179', 'daysSinceP > 180', 'daysSinceP > 179'],
  ['currency: months divisor 30 -> 31', 'Math.floor(daysSince / 30)', 'Math.floor(daysSince / 31)'],
  ['currency: only critical vulnerabilities counted', "e.severity === 'critical' || e.severity === 'high'", "e.severity === 'critical'"],
  ['currency: unreadable-date prompt dropped', "risks.push('The last penetration test date could not be read — check it'); ", ''],
  ['currency: clock parameter ignored', 'var n = opts && opts.now !== undefined ? new Date(opts.now) : new Date();', 'var n = new Date(2000, 0, 1);'],
  ['sla: fallback 240 -> 241', "table('slaMins')[input.severity] || 240", "table('slaMins')[input.severity] || 241"],
  ['envelope: complete always true', 'function complete(caveats) { return !(caveats && caveats.length); }', 'function complete(caveats) { return true; }'],
  ['envelope: output schema check skipped', "errs = al.validate.against('outputs', engine, envelope);", 'errs = null;'],
  ['safety: severity_record no longer refused in run()', "if (engine === 'severity_record') return unavailable(engine, 'human_decision_only');\n    if (!Object", 'if (!Object'],
  ['safety: input schema check skipped', "errs = al.validate.against('inputs', engine, input);", 'errs = [];'],
  ['safety: empty routing text answered instead of not_assessed', "if (!text.trim()) return nonAnswer('routing_suggestion', 'not_assessed', [{ field: 'observation+service', reason_code: 'routing_text_missing' }]);", '']
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-mut-'));
let killed = 0; const survivors = [];
for (const [name, from, to] of MUTANTS) {
  const idx = original.indexOf(from);
  if (idx === -1) { console.log('  ?? mutant target not found: ' + name); survivors.push(name + ' (target missing)'); continue; }
  const mutated = original.slice(0, idx) + to + original.slice(idx + from.length);
  const file = path.join(tmp, 'engine-exports.mut.js');
  fs.writeFileSync(file, mutated);
  const r = spawnSync(process.execPath, [TEST, '--quiet'], { env: Object.assign({}, process.env, { PARITY_EXPORTS_SRC: file }), encoding: 'utf8' });
  if (r.status !== 0) { killed++; console.log('  killed   ' + name); }
  else { survivors.push(name); console.log('  SURVIVED ' + name); }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nmutants: ' + killed + '/' + MUTANTS.length + ' killed' + (survivors.length ? '; SURVIVORS: ' + survivors.join(' | ') : ''));
process.exit(survivors.length ? 1 : 0);
