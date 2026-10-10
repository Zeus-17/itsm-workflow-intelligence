#!/usr/bin/env node
/*
 * RULE QUALITY (Master Plan workstream Q1/Q2) - ITSM repo.  PER-TOOL; not in the shared hash-lock.
 *
 *   node agent-layer/tests/rule_quality.js            print the summary
 *   node agent-layer/tests/rule_quality.js --report   also (re)write RULE-QUALITY-REPORT.md / .json at the repo root
 *
 * Measures how well the tool's keyword logic matches HUMAN INTENT, using labelled phrases (tests/rule-quality/corpus-*.json):
 *   - ROUTING (suggestRoutingGroup): does the suggested team match the team(s) a person would pick? (strict = the best fit; lenient = any plausible team)
 *   - PRE-FLIGHT keyword scans: payment-related and personal-data-related wording that raises the "regulatory flag not set" warnings.
 * for the CURRENT logic (through the real engine exports) and for the PROPOSED rule sets A and B (tests/rule-quality/proposed-rules.json - NOT applied).
 * A MEASUREMENT, not a gate: it fails only if the harness or corpus is broken. Nothing here changes any engine.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { makeContext } = require('./parity_run.js');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(__dirname, 'rule-quality');
const load = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
const WRITE_REPORT = process.argv.includes('--report');
const pct = (n, d) => (d ? Math.round((100 * n) / d) : 100);

const M = makeContext();
const E = M.E, routingRules = M.b.tables.ROUTING_RULES;
const proposals = load('proposed-rules.json');

/* ---------------------------------------------------------------------------------------------- routing */
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&').replace(/\s+/g, '\\s+'); }
function proposedPick(set, c) {
  const text = (set.joinWithSpace ? c.o + ' ' + c.s : c.o + c.s).toLowerCase();
  if (!text.trim()) return null;
  let best = null, bestScore = 0;
  routingRules.forEach((rule, i) => {
    const kws = rule.keywords.concat((set.extraKeywords && set.extraKeywords[String(i)]) || []);
    const score = kws.filter((kw) => (set.wholeWord ? new RegExp('(^|[^a-z0-9])' + escapeRe(kw) + '(s|es)?($|[^a-z0-9])').test(text) : text.indexOf(kw) !== -1)).length;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return bestScore > 0 ? best : null;
}
function currentPick(c) {
  const env = E.run('routing_suggestion', { observation: c.o, service: c.s });
  if (env.status !== 'computed' || !env.output.matched) return null;
  return routingRules.findIndex((r) => r.group === env.output.group);
}
function evalRouting(pickFn, corpus) {
  const r = { total: corpus.cases.length, strict: 0, lenient: 0, wrong: [], missed: [], falseAlarm: [], teams: corpus.concepts.map((name, i) => ({ index: i, name, tp: 0, fp: 0, fn: 0, fpList: [], fnList: [] })) };
  corpus.cases.forEach((c) => {
    const got = pickFn(c), want = c.c.length ? c.c[0] : null;
    if (got === want) r.strict++;
    if ((got === null && !c.c.length) || (got !== null && c.c.includes(got))) r.lenient++;
    if (got !== null && c.c.includes(got) && got !== want) { /* acceptable alternative */ }
    else if (got !== want) {
      if (got === null) r.missed.push({ t: c.o + ' | ' + c.s, want, note: c.note });
      else if (!c.c.length) r.falseAlarm.push({ t: c.o + ' | ' + c.s, got, note: c.note });
      else r.wrong.push({ t: c.o + ' | ' + c.s, want, got, note: c.note });
    }
    corpus.concepts.forEach((_, i) => {
      const t = r.teams[i], hit = got === i, should = c.c.includes(i);
      if (hit && should) t.tp++; else if (hit && !should) { t.fp++; t.fpList.push(c.o + ' | ' + c.s); } else if (!hit && should) { t.fn++; t.fnList.push(c.o + ' | ' + c.s); }
    });
  });
  r.teams.forEach((t) => { t.precision = pct(t.tp, t.tp + t.fp); t.recall = pct(t.tp, t.tp + t.fn); });
  return r;
}

/* ---------------------------------------------------------------------------------------------- pre-flight keyword scans */
function currentFlags(c) {
  const env = E.run('preflight', { shortDescription: c.t, observation: '', service: '', startedAt: '2026-10-10T09:00', diagnosis: 'A properly detailed diagnosis', assignmentGroup: 'Ops', ci: 'CI-1',
    resolvedAt: '', resolution: '', rootCause: '', permanentFix: '', severity: '', triageScore: 0, timelineCount: 1, decisionCount: 0, regulatoryFlagChecked: false });
  const titles = env.output.findings.map((f) => f.title);
  return [titles.includes('Payment keyword detected — regulatory flag not set'), titles.includes('Possible data incident — regulatory flag not set')];
}
function evalScan(flagsFn, corpus) {
  const r = { total: corpus.cases.length, correct: 0, concepts: [0, 1].map((i) => ({ name: corpus.concepts[i], tp: 0, fp: 0, fn: 0, fpList: [], fnList: [] })) };
  corpus.cases.forEach((c) => {
    const f = flagsFn(c); let allOk = true;
    [0, 1].forEach((i) => {
      const s = r.concepts[i], should = c.c.includes(i);
      if (f[i] && should) s.tp++; else if (f[i] && !should) { s.fp++; s.fpList.push(c.t); allOk = false; } else if (!f[i] && should) { s.fn++; s.fnList.push(c.t); allOk = false; }
    });
    if (allOk) r.correct++;
  });
  r.concepts.forEach((s) => { s.precision = pct(s.tp, s.tp + s.fp); s.recall = pct(s.tp, s.tp + s.fn); });
  return r;
}

/* ---------------------------------------------------------------------------------------------- run */
const routingCorpus = load('corpus-routing.json'), scanCorpus = load('corpus-preflight-keywords.json');
routingCorpus.cases.forEach((c) => { if (typeof c.o !== 'string' || typeof c.s !== 'string' || !Array.isArray(c.c)) throw new Error('bad routing case ' + JSON.stringify(c)); });
const R = { current: evalRouting(currentPick, routingCorpus), A: evalRouting((c) => proposedPick(proposals.routing_suggestion.A, c), routingCorpus), B: evalRouting((c) => proposedPick(proposals.routing_suggestion.B, c), routingCorpus) };
const reA = (k) => new RegExp(proposals[k].A, 'i'), reB = (k) => new RegExp(proposals[k].B, 'i');
const S = {
  current: evalScan(currentFlags, scanCorpus),
  A: evalScan((c) => [reA('preflight_payment').test(c.t), reA('preflight_pii').test(c.t)], scanCorpus),
  B: evalScan((c) => [reB('preflight_payment').test(c.t), reB('preflight_pii').test(c.t)], scanCorpus)
};

const rline = (n, r) => `  ${n.padEnd(10)} strict ${String(r.strict).padStart(3)}/${r.total} (${pct(r.strict, r.total)}%)  lenient ${String(r.lenient).padStart(3)}/${r.total} (${pct(r.lenient, r.total)}%)  | wrong team ${r.wrong.length}, suggested when no team fits ${r.falseAlarm.length}, no suggestion ${r.missed.length}`;
const sline = (n, r) => `  ${n.padEnd(10)} phrases handled correctly ${String(r.correct).padStart(3)}/${r.total} (${pct(r.correct, r.total)}%)  | payment-scan FP ${r.concepts[0].fp} FN ${r.concepts[0].fn}; personal-data-scan FP ${r.concepts[1].fp} FN ${r.concepts[1].fn}`;
const summary = `routing_suggestion (${routingCorpus.cases.length} labelled incidents)\n${rline('CURRENT', R.current)}\n${rline('PROPOSED A', R.A)}\n${rline('PROPOSED B', R.B)}\n\npre-flight keyword scans (${scanCorpus.cases.length} labelled phrases)\n${sline('CURRENT', S.current)}\n${sline('PROPOSED A', S.A)}\n${sline('PROPOSED B', S.B)}`;
console.log(summary);

if (WRITE_REPORT) {
  const L = ['# Rule quality report - ITSM Workflow Intelligence tool', '',
    '*Generated by `agent-layer/tests/rule_quality.js` - do not edit by hand. Measurement only: **no rule in the tool has been changed**.*', '',
    '**How to read this.** Each labelled phrase says which team(s) an incident should go to, or whether payment / personal-data wording is really present (labels were written by intent, without looking at the rules\' results, by Claude - they need your / a practitioner\'s review). **Strict** = the suggestion is the best-fit team; **lenient** = any plausible team (or correctly no suggestion). **Proposed A** = join the two fields with a space + whole-word matching, no new keywords. **Proposed B** = A + extra keywords. The proposals were written by the same author as the labels, so the improvement shown is optimistic.', '',
    '## Team routing (`ROUTING_RULES`)', '', '```', summary.split('\n\n')[0], '```', '',
    '| # | Team | Current precision / recall | A | B |', '|---|---|---|---|---|'];
  R.current.teams.forEach((t, i) => L.push(`| ${i} | ${t.name} | ${t.precision}% / ${t.recall}% (FP ${t.fp}, FN ${t.fn}) | ${R.A.teams[i].precision}% / ${R.A.teams[i].recall}% | ${R.B.teams[i].precision}% / ${R.B.teams[i].recall}% |`));
  L.push('', '### Current routing: where it goes wrong', '');
  const lb = (x) => (x === null || x === undefined ? 'no team' : routingCorpus.concepts[x]);
  R.current.wrong.forEach((x) => L.push(`* WRONG TEAM - "${x.t}" -> ${lb(x.got)} (expected ${lb(x.want)})${x.note ? ' *(' + x.note + ')*' : ''}`));
  R.current.falseAlarm.forEach((x) => L.push(`* SUGGESTED WHEN NO LISTED TEAM FITS - "${x.t}" -> ${lb(x.got)}${x.note ? ' *(' + x.note + ')*' : ''}`));
  R.current.missed.forEach((x) => L.push(`* NO SUGGESTION - "${x.t}" (expected ${lb(x.want)})${x.note ? ' *(' + x.note + ')*' : ''}`));
  const cur = new Map();
  routingCorpus.cases.forEach((c) => cur.set(c.o + ' | ' + c.s, { c, cur: currentPick(c), A: proposedPick(proposals.routing_suggestion.A, c), B: proposedPick(proposals.routing_suggestion.B, c) }));
  const good = (x, got) => (got === null && !x.c.c.length) || (got !== null && x.c.c.includes(got));
  const worseA = [...cur.values()].filter((x) => good(x, x.cur) && !good(x, x.A)), worseB = [...cur.values()].filter((x) => good(x, x.cur) && !good(x, x.B));
  L.push('', '### Proposed A and B: what gets worse (lenient view)', '', worseA.length ? '* Under A: ' + worseA.map((x) => `"${x.c.o} | ${x.c.s}" (A gives ${lb(x.A)})`).join('; ') : '* Under A: nothing that is acceptable today becomes unacceptable.',
    worseB.length ? '* Under B: ' + worseB.map((x) => `"${x.c.o} | ${x.c.s}" (B gives ${lb(x.B)})`).join('; ') : '* Under B: nothing that is acceptable today becomes unacceptable.', '');
  const residual = [...cur.values()].filter((x) => !good(x, x.B));
  L.push('### Still wrong even under Proposed B (residual)', '', residual.length ? residual.map((x) => `* "${x.c.o} | ${x.c.s}" -> ${lb(x.B)} (expected ${x.c.c.length ? x.c.c.map(lb).join(' / ') : 'no team'})${x.c.note ? ' *(' + x.c.note + ')*' : ''}`).join('\n') : '* none', '');
  L.push('## Pre-flight payment / personal-data keyword scans', '', '```', summary.split('\n\n')[1], '```', '');
  [0, 1].forEach((i) => {
    const c = S.current.concepts[i];
    L.push(`**${scanCorpus.concepts[i]} scan** - current precision ${c.precision}% / recall ${c.recall}%; A ${S.A.concepts[i].precision}% / ${S.A.concepts[i].recall}%; B ${S.B.concepts[i].precision}% / ${S.B.concepts[i].recall}%`);
    if (c.fpList.length) L.push('* *Fires when it should not:* ' + c.fpList.map((t) => '"' + t + '"').join('; '));
    if (c.fnList.length) L.push('* *Misses:* ' + c.fnList.map((t) => '"' + t + '"').join('; '));
    const rA = S.A.concepts[i], rB = S.B.concepts[i];
    if (rA.fnList.length) L.push('* *Still misses under A:* ' + rA.fnList.map((t) => '"' + t + '"').join('; '));
    if (rB.fpList.length || rB.fnList.length) L.push('* *Residual under B:* ' + rB.fpList.concat(rB.fnList).map((t) => '"' + t + '"').join('; '));
    L.push('');
  });
  L.push('## Limits of this measurement', '',
    '* Labels are one author\'s judgement; several phrases are marked with a note in the corpus.',
    '* The corpus is small and deliberately includes the known substring traps, so it over-represents the hard cases: do NOT read the percentages as production accuracy.',
    '* Routing here ignores a user\'s own custom routing rules (they take priority in the tool).',
    '* Proposals have not been reviewed by a practitioner and are NOT applied. Any change goes through the signed-off engine-change workstream (Master Plan 7h).', '');
  fs.writeFileSync(path.join(ROOT, 'RULE-QUALITY-REPORT.md'), L.join('\n'), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'RULE-QUALITY-REPORT.json'), JSON.stringify({ routing: [...cur.values()].map((x) => ({ o: x.c.o, s: x.c.s, expected: x.c.c, current: x.cur, A: x.A, B: x.B })) }, null, 1) + '\n', 'utf8');
  console.log('\nwrote RULE-QUALITY-REPORT.md and RULE-QUALITY-REPORT.json');
}
