#!/usr/bin/env node
/*
 * RULE QUALITY (Master Plan workstream Q) - ITSM repo.  PER-TOOL; not in the shared hash-lock.
 *
 *   node agent-layer/tests/rule_quality.js            print the summary
 *   node agent-layer/tests/rule_quality.js --report   also (re)write RULE-QUALITY-REPORT.md / .json at the repo root
 *
 * Measures how well the tool's keyword logic matches HUMAN INTENT, using labelled phrases (tests/rule-quality/corpus-*.json):
 *   - ROUTING (suggestRoutingGroup): does the suggested team match the team(s) a person would pick? (strict = best fit; lenient = any plausible team)
 *   - PRE-FLIGHT keyword scans: payment-related and personal-data wording that raises the "regulatory flag not set" warnings.
 * BEFORE = the original logic (tests/rule-quality/previous-rules.json, captured before the 2026-10-10 change set);
 * NOW    = what the tool does today, read through the real engine exports; A / B = the two proposal sets evaluated before adoption (B was adopted).
 * A MEASUREMENT, not a gate: it fails only if the harness or the corpus is broken. The corpus and the adopted rules share an author, so NOW is optimistic.
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
const proposals = load('proposed-rules.json'), previous = load('previous-rules.json');

/* ---------------------------------------------------------------------------------------------- routing */
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&').replace(/\s+/g, '\\s+'); }
function proposedPick(set, c) {
  const text = (set.joinWithSpace ? c.o + ' ' + c.s : c.o + c.s).toLowerCase();
  if (!text.trim()) return null;
  let best = null, bestScore = 0;
  previous.routing.forEach((rule, i) => {
    const kws = rule.keywords.concat((set.extraKeywords && set.extraKeywords[String(i)]) || []);
    const score = kws.filter((kw) => (set.wholeWord ? new RegExp('(^|[^a-z0-9])' + escapeRe(kw) + '(s|es)?($|[^a-z0-9])').test(text) : text.indexOf(kw) !== -1)).length;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return bestScore > 0 ? best : null;
}
/** The ORIGINAL algorithm: fields fused without a space, keywords matched as substrings, original keyword lists. */
function beforePick(c) {
  const text = (c.o + c.s).toLowerCase();
  if (!text.trim()) return null;
  let best = null, bestScore = 0;
  previous.routing.forEach((rule, i) => { const score = rule.keywords.filter((kw) => text.includes(kw)).length; if (score > bestScore) { bestScore = score; best = i; } });
  return bestScore > 0 ? best : null;
}
function nowPick(c) {
  const env = E.run('routing_suggestion', { observation: c.o, service: c.s });
  if (env.status !== 'computed' || !env.output.matched) return null;
  return routingRules.findIndex((r) => r.group === env.output.group);
}
function evalRouting(pickFn, corpus) {
  const r = { total: corpus.cases.length, strict: 0, lenient: 0, picks: [], wrong: [], missed: [], falseAlarm: [], teams: corpus.concepts.map((name, i) => ({ index: i, name, tp: 0, fp: 0, fn: 0, fpList: [], fnList: [] })) };
  corpus.cases.forEach((c) => {
    const got = pickFn(c), want = c.c.length ? c.c[0] : null;
    r.picks.push(got);
    if (got === want) r.strict++;
    const acceptable = (got === null && !c.c.length) || (got !== null && c.c.includes(got));
    if (acceptable) r.lenient++;
    if (!acceptable) {
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
function nowFlags(c) {
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
const R = { before: evalRouting(beforePick, routingCorpus), now: evalRouting(nowPick, routingCorpus), A: evalRouting((c) => proposedPick(proposals.routing_suggestion.A, c), routingCorpus), B: evalRouting((c) => proposedPick(proposals.routing_suggestion.B, c), routingCorpus) };
const re = (src) => new RegExp(src, 'i');
const S = {
  before: evalScan((c) => [re(previous.preflight_payment).test(c.t), re(previous.preflight_pii).test(c.t)], scanCorpus),
  now: evalScan(nowFlags, scanCorpus),
  A: evalScan((c) => [re(proposals.preflight_payment.A).test(c.t), re(proposals.preflight_pii.A).test(c.t)], scanCorpus),
  B: evalScan((c) => [re(proposals.preflight_payment.B).test(c.t), re(proposals.preflight_pii.B).test(c.t)], scanCorpus)
};

const rline = (n, r) => `  ${n.padEnd(13)} strict ${String(r.strict).padStart(3)}/${r.total} (${pct(r.strict, r.total)}%)  lenient ${String(r.lenient).padStart(3)}/${r.total} (${pct(r.lenient, r.total)}%)  | wrong team ${r.wrong.length}, suggested when no team fits ${r.falseAlarm.length}, no suggestion ${r.missed.length}`;
const sline = (n, r) => `  ${n.padEnd(13)} handled correctly ${String(r.correct).padStart(3)}/${r.total} (${pct(r.correct, r.total)}%)  | payment-scan FP ${r.concepts[0].fp} FN ${r.concepts[0].fn}; personal-data-scan FP ${r.concepts[1].fp} FN ${r.concepts[1].fn}`;
const routingSummary = `routing_suggestion (${routingCorpus.cases.length} labelled incidents)\n${rline('BEFORE', R.before)}\n${rline('NOW (adopted)', R.now)}\n${rline('ref: A', R.A)}\n${rline('ref: B', R.B)}`;
const scanSummary = `pre-flight keyword scans (${scanCorpus.cases.length} labelled phrases)\n${sline('BEFORE', S.before)}\n${sline('NOW (adopted)', S.now)}\n${sline('ref: A', S.A)}\n${sline('ref: B', S.B)}`;
console.log(routingSummary + '\n\n' + scanSummary);

if (WRITE_REPORT) {
  const lb = (x) => (x === null || x === undefined ? 'no team' : routingCorpus.concepts[x]);
  const L = ['# Rule quality report - ITSM Workflow Intelligence tool', '',
    '*Generated by `agent-layer/tests/rule_quality.js` - do not edit by hand.*', '',
    '**Status (2026-10-10): whole-word matching, joining the observation and service WITH a space, and the extra vocabulary (proposal B) were ADOPTED into the tool (decisions Q-1, Q-2, Q-4, approved by James). "BEFORE" is the original logic, "NOW" is what the tool does today.**', '',
    '**How to read this.** Each labelled phrase says which team(s) an incident should go to, or whether payment / personal-data wording is really present (labels were written by intent, without looking at the rules\' results, by Claude - they still need a practitioner\'s review). **Strict** = the suggestion is the best-fit team; **lenient** = any plausible team (or correctly no suggestion). The corpus and the adopted rules share an author, so NOW is optimistic, and the corpus deliberately over-represents hard cases.', '',
    '## Team routing (`ROUTING_RULES`)', '', '```', routingSummary, '```', '',
    '| # | Team | BEFORE precision / recall | NOW precision / recall |', '|---|---|---|---|'];
  R.before.teams.forEach((t, i) => L.push(`| ${i} | ${t.name} | ${t.precision}% / ${t.recall}% (FP ${t.fp}, FN ${t.fn}) | ${R.now.teams[i].precision}% / ${R.now.teams[i].recall}% (FP ${R.now.teams[i].fp}, FN ${R.now.teams[i].fn}) |`));
  L.push('', '### How the original routing went wrong', '');
  R.before.wrong.forEach((x) => L.push(`* WRONG TEAM - "${x.t}" -> ${lb(x.got)} (expected ${lb(x.want)})${x.note ? ' *(' + x.note + ')*' : ''}`));
  R.before.falseAlarm.forEach((x) => L.push(`* SUGGESTED WHEN NO LISTED TEAM FITS - "${x.t}" -> ${lb(x.got)}${x.note ? ' *(' + x.note + ')*' : ''}`));
  R.before.missed.forEach((x) => L.push(`* NO SUGGESTION - "${x.t}" (expected ${lb(x.want)})${x.note ? ' *(' + x.note + ')*' : ''}`));
  const acceptable = (c, got) => (got === null && !c.c.length) || (got !== null && c.c.includes(got));
  const worse = routingCorpus.cases.map((c, k) => ({ c, b: R.before.picks[k], n: R.now.picks[k] })).filter((x) => acceptable(x.c, x.b) && !acceptable(x.c, x.n));
  L.push('', '### What got worse (acceptable before, not now)', '', worse.length ? worse.map((x) => `* "${x.c.o} | ${x.c.s}" - now ${lb(x.n)}`).join('\n') : '* nothing that was acceptable before is unacceptable now.', '');
  const resid = routingCorpus.cases.map((c, k) => ({ c, n: R.now.picks[k] })).filter((x) => !acceptable(x.c, x.n));
  L.push('### Still wrong now (residual - known limits, not hidden)', '', resid.length ? resid.map((x) => `* "${x.c.o} | ${x.c.s}" -> ${lb(x.n)} (expected ${x.c.c.length ? x.c.c.map(lb).join(' / ') : 'no team'})${x.c.note ? ' *(' + x.c.note + ')*' : ''}`).join('\n') : '* none', '');
  L.push('## Pre-flight payment / personal-data keyword scans', '', '```', scanSummary, '```', '');
  [0, 1].forEach((i) => {
    const b = S.before.concepts[i], n = S.now.concepts[i];
    L.push(`**${scanCorpus.concepts[i]} scan** - BEFORE precision ${b.precision}% / recall ${b.recall}%; NOW ${n.precision}% / ${n.recall}%`);
    if (b.fpList.length) L.push('* *Fired when it should not (before):* ' + b.fpList.map((t) => '"' + t + '"').join('; '));
    if (b.fnList.length) L.push('* *Missed (before):* ' + b.fnList.map((t) => '"' + t + '"').join('; '));
    if (n.fpList.length || n.fnList.length) L.push('* *Still wrong now:* ' + n.fpList.concat(n.fnList).map((t) => '"' + t + '"').join('; '));
    L.push('');
  });
  L.push('## Limits of this measurement', '',
    '* Labels are one author\'s judgement; several phrases are marked with a note in the corpus.',
    '* The corpus is small and deliberately includes the known substring traps; NOW was tuned by the author who wrote the corpus.',
    '* Whole-word matching cannot stop a word that is simply ambiguous ("endpoint", "gateway", "release", "data", "version" mean different things in different incidents): the suggestion is a prompt, and the tool now shows the matched words and says so.',
    '* Routing here ignores a user\'s own custom routing rules (they take priority in the tool, and keep substring matching because they are the user\'s own words).', '');
  fs.writeFileSync(path.join(ROOT, 'RULE-QUALITY-REPORT.md'), L.join('\n'), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'RULE-QUALITY-REPORT.json'), JSON.stringify({ routing: routingCorpus.cases.map((c, k) => ({ o: c.o, s: c.s, expected: c.c, before: R.before.picks[k], now: R.now.picks[k] })) }, null, 1) + '\n', 'utf8');
  console.log('\nwrote RULE-QUALITY-REPORT.md and RULE-QUALITY-REPORT.json');
}
