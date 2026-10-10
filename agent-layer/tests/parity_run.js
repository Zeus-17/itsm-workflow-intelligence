#!/usr/bin/env node
/*
 * ENGINE PARITY (Master Plan Phase E) - ITSM repo.  PER-TOOL file (the RM repo has its own); not in the shared hash-lock.
 *
 *   node agent-layer/tests/parity_run.js            [--quiet] [--embedded]
 *
 * Proves that agent-layer/engine-exports.js (read-only, pure) returns EXACTLY what the tool's real, DOM-driven engines produce.
 * It extracts the tool's REAL source text (rule tables + engine functions, straight from the HTML) into an isolated VM context with a
 * tiny fake DOM, runs the real function and the pure export on the same input, and compares:
 *   incident_score     vs calcScore()/updateScore()   EXHAUSTIVE over every legal combination (5,400), total, tier, major flag, verdict text
 *   change_risk        vs calcRiskScore()             EXHAUSTIVE over every legal combination (4,096), total and level
 *   intel_hint         vs showIntelHint()             every incident type
 *   routing_suggestion vs suggestRoutingGroup()       every keyword of every rule, the no-space join quirk, ties, custom rules, fuzz
 *   currency_risk      vs assessCurrencyRisk()        fixed clock; thresholds at 364/365/366 and 179/180/181 days; fuzz
 *   preflight          vs generatePreflightFindings() every threshold, keyword scan, severity override; fuzz
 *   sla_clock          vs slaMins[sev]||240           (inline in startSLAClock: also asserted to still be in the tool's source)
 * Also proves: nothing is written (DOM untouched), severity_record is refused, drifted / missing tables fail closed, every output
 * validates against schemas/engine-outputs.schema.json, and the draft path (unresolved-input policy) behaves as designed.
 *
 * Env: PARITY_EXPORTS_SRC=<file>  run against a different engine-exports.js (used by the mutation check).
 * --embedded : test the compacted block exactly as shipped inside the tool HTML.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const HTML_PATH = path.resolve(ROOT, cfg.html);
const EXPORTS_PATH = process.env.PARITY_EXPORTS_SRC ? path.resolve(process.env.PARITY_EXPORTS_SRC) : path.join(ROOT, 'engine-exports.js');
const QUIET = process.argv.includes('--quiet');
const EMBEDDED = process.argv.includes('--embedded');

let pass = 0; const failures = [];
function ok(c, m) { if (c) pass++; else { failures.push(m); if (failures.length <= 40 && !QUIET) console.log('  FAIL:', m); } }
const log = (...a) => { if (!QUIET) console.log(...a); };
const J = (v) => JSON.stringify(v);

/* ---------------------------------------------------------------------------------------------- source extraction */

function toolSource() {
  const html = fs.readFileSync(HTML_PATH, 'utf8').replace(/\r\n/g, '\n');
  const i = html.indexOf('<!-- AGENT-LAYER:BEGIN');
  return i === -1 ? html : html.slice(0, i);
}

/** One top-level declaration (column 0): `function NAME(...) {...}` or `var|let|const NAME = [...]/{...};` (or a one-line value). */
function declaration(src, name) {
  const lines = src.split('\n');
  const declRe = new RegExp('^(const|let|var)\\s+' + name + '\\s*=');
  const starts = [];
  lines.forEach((l, i) => { if (l.startsWith('function ' + name + '(') || declRe.test(l)) starts.push(i); });
  if (starts.length !== 1) throw new Error('declaration "' + name + '" found ' + starts.length + ' times in the tool (expected exactly 1)');
  const s = starts[0], fn = lines[s].startsWith('function ');
  for (let j = s; j < lines.length; j++) {
    const l = lines[j];
    if (fn ? l === '}' : (/^[\]}];?$/.test(l) || (j === s && /;\s*$/.test(l)))) return lines.slice(s, j + 1).join('\n');
  }
  throw new Error('could not find the end of "' + name + '"');
}

/* ---------------------------------------------------------------------------------------------- fake DOM + VM context */

function makeDom() {
  const els = {};
  const dom = { guard: false, reads: 0, el, document: null };
  function el(id) {
    if (!els[id]) {
      let cn = '';
      const classList = {
        contains: (c) => cn.split(/\s+/).includes(c),
        add: (c) => { if (!cn.split(/\s+/).includes(c)) cn = (cn + ' ' + c).trim(); },
        remove: (c) => { cn = cn.split(/\s+/).filter((x) => x && x !== c).join(' '); }
      };
      els[id] = { id, value: '', innerHTML: '', textContent: '', checked: false, style: {}, get className() { return cn; }, set className(v) { cn = String(v); }, classList };
    }
    return els[id];
  }
  dom.document = { getElementById(id) { dom.reads++; if (dom.guard) throw new Error('pure export touched the DOM: ' + id); return el(id); } };
  return dom;
}

function freezeDeep(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach((k) => freezeDeep(o[k])); } return o; }

const FIXED_NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(FIXED_NOW); } static now() { return FIXED_NOW; } }

function makeContext(opts) {
  opts = opts || {};
  const dom = makeDom();
  const ctx = vm.createContext({ console, document: dom.document, Date: FakeDate });
  ctx.window = ctx;
  const src = toolSource();
  const tableNames = ['intelRules', 'ROUTING_RULES'];
  const fnNames = ['g', 'calcScore', 'updateScore', 'showIntelHint', 'calcRiskScore', 'suggestRoutingGroup', 'generatePreflightFindings', 'assessCurrencyRisk', 'updateCurrencyRiskSummary', 'startSLAClock'];
  const parts = [
    'var selectedSev = ""; var isMajorIncident = false; var __setSev = []; function setSev(s) { __setSev.push(s); } function autosave() {}',
    'var timelineEvents = []; var decisionLog = []; var certEntries = []; var vulnEntries = []; var customRoutingRules = [];',
    declaration(src, 'slaMins')
  ].concat(tableNames.filter((n) => !(opts.omit || []).includes(n)).map((n) => declaration(src, n))).concat(fnNames.map((n) => declaration(src, n)));
  parts.push('var __bridge = { tables: { ' + tableNames.filter((n) => !(opts.omit || []).includes(n)).map((n) => n + ': ' + n).join(', ') + ', slaMins: slaMins }, ' +
    'g: g, calcScore: calcScore, updateScore: updateScore, showIntelHint: showIntelHint, calcRiskScore: calcRiskScore, suggestRoutingGroup: suggestRoutingGroup, ' +
    'generatePreflightFindings: generatePreflightFindings, assessCurrencyRisk: assessCurrencyRisk, startSLASource: startSLAClock.toString(), ' +
    'setSelected: function (v) { selectedSev = v; }, setTimeline: function (n) { timelineEvents = new Array(n).fill(0); }, setDecisions: function (n) { decisionLog = new Array(n).fill(0); }, ' +
    'setCerts: function (a) { certEntries = a; }, setVulns: function (a) { vulnEntries = a; }, setCustom: function (a) { customRoutingRules = a; }, ' +
    'setSla: function (o) { slaMins = o; }, setCalls: function () { return __setSev.slice(); }, clearCalls: function () { __setSev.length = 0; }, ' +
    'major: function () { return isMajorIncident; }, currencyRisks: function () { return window._currencyRisks; } };');
  vm.runInContext(parts.join('\n'), ctx, { filename: 'tool-real-source' });
  if (opts.freezeTables !== false) Object.keys(ctx.__bridge.tables).filter((k) => k !== 'slaMins').forEach((k) => freezeDeep(ctx.__bridge.tables[k]));
  if (EMBEDDED) {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const m = html.match(/<script id="agent-layer">([\s\S]*?)<\/script>\s*<!-- AGENT-LAYER:END -->/);
    if (!m) throw new Error('no embedded agent-layer block in the tool HTML');
    const store = {};
    ctx.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
    ctx.self = ctx;
    vm.runInContext(m[1], ctx, { filename: 'embedded-agent-layer.js' });
    return { ctx, dom, b: ctx.__bridge, E: ctx.AgentEngine, AL: ctx.AgentLayer };
  }
  if (!opts.skipAgentLayer) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'validation.js'), 'utf8'), ctx, { filename: 'validation.js' });
    const sc = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'schemas', f), 'utf8'));
    vm.runInContext('AgentLayer.configure(' + J({ tool: cfg.tool, paymentLabel: cfg.paymentLabel, schemas: { inputs: sc('engine-inputs.schema.json'), drafts: sc('agent-drafts.schema.json'), outputs: sc('engine-outputs.schema.json'), policy: sc('unresolved-policy.json') } }) + ');', ctx);
  }
  vm.runInContext(fs.readFileSync(EXPORTS_PATH, 'utf8'), ctx, { filename: 'engine-exports.js' });
  return { ctx, dom, b: ctx.__bridge, E: ctx.AgentEngine, AL: ctx.AgentLayer };
}

/* ---------------------------------------------------------------------------------------------- randomness + corpora */

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (r, a) => a[Math.floor(r() * a.length)];
const FILLER = ['the', 'update', 'for', 'service', 'release', 'fix', 'a', 'tidy', 'incident', 'users', 'cannot', 'slow', 'error', 'team', 'queue', 'config'];

const USERS = [1, 2, 3, 4, 5], BUSINESS = [0, 1, 2, 3, 4, 5], WORKAROUND = [0, 1, 2], DURATION = [0, 1, 2, 3, 4], REGULATORY = [0, 2, 4, 5], RECURRING = [0, 2, 4];
const BLAST = [5, 10, 20, 30], COMPLEXITY = [5, 10, 20, 25], ROLLBACK = [2, 8, 15, 20], TESTING = [2, 8, 15, 20], HISTORY = [2, 5, 10, 15], TIMING = [2, 5, 8, 10];
const TYPES = ['', 'application', 'infrastructure', 'thirdparty', 'security', 'data', 'network', 'process', 'other'];
const SCORE_IDS = ['users', 'business', 'workaround', 'duration', 'regulatory', 'recurring'];

const msDays = (d) => FIXED_NOW - d * 86400000;
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/* ---------------------------------------------------------------------------------------------- the tests */

function runAll() {
  const T0 = Date.now();
  const M = makeContext();
  const { b, dom, E } = M;
  const routing = b.tables.ROUTING_RULES, intel = b.tables.intelRules;

  log('A. the module and the tool agree on shape');
  ok(E && E.tool === 'itsm', 'AgentEngine is loaded for the itsm tool');
  ok(E.ready().ok, 'every table the exports depend on is present: ' + J(E.ready()));
  ok(routing.length === 10, 'ROUTING_RULES has 10 rules (the policy documents 10) - got ' + routing.length);
  ok(J(E.engines().sort()) === J(['change_risk', 'currency_risk', 'incident_score', 'intel_hint', 'preflight', 'routing_suggestion', 'sla_clock']), 'exported engines: ' + J(E.engines()));
  ok(!E.engines().includes('severity_record'), 'severity_record (the human-chosen tier) is not an exported engine');

  // ------------------------------------------------------------------------------------------ B. incident_score (exhaustive)
  log('B. incident_score == calcScore()/updateScore()  (exhaustive)');
  let nScore = 0;
  function realScore(f, sel) {
    SCORE_IDS.forEach((k) => { dom.el('t1_' + k).value = String(f[k]); });
    b.setSelected(sel); b.clearCalls();
    b.updateScore();
    return { total: Number(dom.el('scoreNum').textContent), verdict: dom.el('scoreVerdict').textContent, major: b.major(), alert: dom.el('majorIncidentAlert').style.display, calls: b.setCalls() };
  }
  for (const users of USERS) for (const business of BUSINESS) for (const workaround of WORKAROUND) for (const duration of DURATION) for (const regulatory of REGULATORY) for (const recurring of RECURRING) {
    const f = { users, business, workaround, duration, regulatory, recurring };
    nScore++;
    const real = realScore(f, '');
    dom.guard = true; let env; try { env = E.run('incident_score', f); } finally { dom.guard = false; }
    const o = env.output;
    if (env.status !== 'computed') { ok(false, 'score not computed ' + J(f) + J(env)); continue; }
    ok(o.total === real.total && o.verdict === real.verdict && o.is_major === real.major && real.calls.length === 1 && real.calls[0] === o.suggested_tier && (real.alert === 'flex') === (o.total >= 17), 'score ' + J(f) + ' real=' + J(real) + ' export=' + J(o));
  }
  { // when the user has already chosen a tier the legacy code does not set one; the major flag still follows the score (or a chosen P1)
    const f = { users: 5, business: 5, workaround: 2, duration: 4, regulatory: 5, recurring: 4 };
    const real = realScore(f, 'P3');
    ok(real.calls.length === 0 && real.major === true, 'sanity: with a chosen tier the legacy code sets none; score 17+ is still major');
    const lowChosenP1 = realScore({ users: 1, business: 0, workaround: 0, duration: 0, regulatory: 0, recurring: 0 }, 'P1');
    ok(lowChosenP1.major === true && E.run('incident_score', { users: 1, business: 0, workaround: 0, duration: 0, regulatory: 0, recurring: 0 }).output.is_major === false,
      'a USER-chosen P1 makes the legacy flag major; the export reports only what the score says (the tier is the human\'s)');
  }
  ok(E.run('incident_score', { users: 0, business: 0, workaround: 0, duration: 0, regulatory: 0, recurring: 0 }).status === 'rejected', 'the form\'s 0 "Unknown" users value is not a legal answer (policy)');
  log('   ' + nScore + ' score combinations');

  // ------------------------------------------------------------------------------------------ C. change_risk (exhaustive)
  log('C. change_risk == calcRiskScore()  (exhaustive)');
  let nRisk = 0;
  const RF = ['blast', 'complexity', 'rollback', 'testing', 'history', 'timing'];
  for (const blast of BLAST) for (const complexity of COMPLEXITY) for (const rollback of ROLLBACK) for (const testing of TESTING) for (const history of HISTORY) for (const timing of TIMING) {
    const f = { blast, complexity, rollback, testing, history, timing };
    nRisk++;
    RF.forEach((k) => { dom.el('rf_' + k).value = String(f[k]); });
    b.calcRiskScore();
    const total = Number(dom.el('riskScoreNum').textContent), cn = dom.el('riskScoreNum').className, level = (cn.match(/risk-score-num (low|medium|high)/) || [])[1];
    dom.guard = true; let env; try { env = E.run('change_risk', f); } finally { dom.guard = false; }
    ok(env.status === 'computed' && env.output.total === total && env.output.level === level && dom.el('riskScoreDisplay').className === 'risk-score-display ' + level, 'risk ' + J(f) + ' real=' + total + '/' + level + ' export=' + J(env));
  }
  { // the legacy "Incomplete" state (any factor unset) is not a result: the export treats it as a missing input
    RF.forEach((k) => { dom.el('rf_' + k).value = '0'; }); b.calcRiskScore();
    ok(/Incomplete/.test(dom.el('riskScoreVerdict').textContent), 'sanity: the real form shows Incomplete while factors are unset');
    ok(E.run('change_risk', { blast: 0, complexity: 5, rollback: 2, testing: 2, history: 2, timing: 2 }).status === 'rejected', 'an unset (0) factor is not a legal engine input');
  }
  log('   ' + nRisk + ' change-risk combinations');

  // ------------------------------------------------------------------------------------------ D. intel_hint
  log('D. intel_hint == showIntelHint()');
  for (const t of TYPES) {
    dom.el('t1_inctype').value = t; const h = dom.el('intelHint'); h.className = ''; h.innerHTML = '';
    b.showIntelHint();
    const shown = h.classList.contains('show');
    dom.guard = true; let env; try { env = E.run('intel_hint', { incidentType: t }); } finally { dom.guard = false; }
    ok(env.status === 'computed' && env.output.matched === shown && (!shown || env.output.hint_html === h.innerHTML), 'intel ' + J(t));
  }
  ok(Object.keys(intel).length === 7, '7 incident types carry a hint (policy: "7 of the 8 types") - got ' + Object.keys(intel).length);

  // ------------------------------------------------------------------------------------------ E. routing_suggestion
  log('E. routing_suggestion == suggestRoutingGroup()');
  const rr = rng(20261010);
  function checkRoute(obs, svc, label) {
    const real = b.suggestRoutingGroup(obs, svc);
    dom.guard = true; let env; try { env = E.run('routing_suggestion', { observation: obs, service: svc }); } finally { dom.guard = false; }
    if (!((obs || '') + (svc || '')).toLowerCase().trim()) { ok(real === null && env.status === 'not_assessed', label + ' empty text'); return; }
    if (!real) { ok(env.status === 'computed' && !env.output.matched, label + ' no match: ' + J(env)); return; }
    ok(env.status === 'computed' && env.output.matched && env.output.group === real.group && env.output.rationale === real.rationale, label + ' real=' + real.group + ' export=' + J(env));
  }
  const kws = routing.map((r) => r.keywords);
  const routeCases = [];
  kws.forEach((ks) => ks.forEach((k) => {
    routeCases.push([k, ''], ['', k], [k.toUpperCase(), 'svc'], ['xx' + k + 'yy', ''], ['Issue with ' + k, 'Mobile App'], [k.slice(0, Math.ceil(k.length / 2)), k.slice(Math.ceil(k.length / 2))]); // split across fields: the no-space join quirk
  }));
  for (let i = 0; i < kws.length; i++) for (let j = 0; j < kws.length; j++) routeCases.push([pick(rr, kws[i]) + ' ' + pick(rr, kws[i]) + ' ' + pick(rr, kws[j]), ''], [pick(rr, kws[i]), pick(rr, kws[j])]);
  routeCases.push(['', ''], ['   ', ''], ['   ', '  '], ['nothing relevant here', 'Some Service']);
  for (let k = 0; k < 2500; k++) {
    const w = []; const len = 1 + Math.floor(rr() * 6); for (let q = 0; q < len; q++) w.push(rr() < 0.4 ? pick(rr, pick(rr, kws)) : pick(rr, FILLER));
    routeCases.push([w.slice(0, Math.ceil(len / 2)).join(' '), w.slice(Math.ceil(len / 2)).join(' ')]);
  }
  routeCases.forEach((c, i) => checkRoute(c[0], c[1], 'route#' + i + ' ' + J(c).slice(0, 70)));
  b.setCustom([{ id: 'c1', keywords: ['payment', 'zeta'], group: 'Custom Payments', rationale: 'Custom rule: payment, zeta' }, { id: 'c2', keywords: ['zeta'], group: 'Zeta Team', rationale: 'Custom rule: zeta' }]);
  const customCases = [['payment zeta outage', ''], ['zeta only', ''], ['payment only', ''], ['network issue', ''], ['pay', 'ment zeta']];
  customCases.forEach((c, i) => checkRoute(c[0], c[1], 'custom-route#' + i));
  for (let k = 0; k < 400; k++) { const w = []; for (let q = 0; q < 4; q++) w.push(rr() < 0.4 ? pick(rr, pick(rr, kws.concat([['zeta', 'payment']]))) : pick(rr, FILLER)); checkRoute(w.slice(0, 2).join(' '), w.slice(2).join(' '), 'custom-fuzz#' + k); }
  b.setCustom([]);
  log('   ' + (routeCases.length + customCases.length + 400) + ' routing cases');

  // ------------------------------------------------------------------------------------------ F. currency_risk
  log('F. currency_risk == assessCurrencyRisk()  (fixed clock)');
  const cr = rng(31337);
  const CERT_STATUS = ['unknown', 'expired', 'critical', 'warn', 'ok'], VULN = ['critical', 'high', 'medium', 'advisory'], SUPPORT = ['', 'active', 'lts', 'maintenance', 'eol_soon', 'eol', 'unknown'];
  function checkCurrency(inp, label) {
    b.setCerts(inp.certificates.map((c) => ({ name: c.name, status: c.status, daysLeft: c.daysLeft })));
    b.setVulns(inp.vulnerabilities.map((v) => ({ severity: v.severity })));
    dom.el('sc_support_status').value = inp.supportStatus; dom.el('sc_last_pentest').value = inp.lastPentest; dom.el('sc_last_patched').value = inp.lastPatched;
    b.assessCurrencyRisk();
    const real = b.currencyRisks();
    dom.guard = true; let env; try { env = E.run('currency_risk', inp, [], { now: FIXED_NOW }); } finally { dom.guard = false; }
    ok(env.status === 'computed' && J(env.output.risks) === J(real), label + ' real=' + J(real) + ' export=' + J(env));
  }
  const dayEdges = [0, 1, 179, 180, 181, 364, 365, 366, 400, 730];
  let nCur = 0;
  for (const dp of dayEdges) for (const dq of dayEdges) {
    nCur++;
    checkCurrency({ certificates: [], vulnerabilities: [], supportStatus: '', lastPentest: isoDate(msDays(dp)), lastPatched: isoDate(msDays(dq)) }, 'currency dates ' + dp + '/' + dq);
  }
  for (let k = 0; k < 2500; k++) {
    nCur++;
    const certs = Array.from({ length: Math.floor(cr() * 4) }, () => ({ name: pick(cr, ['', 'api.example.com', 'vpn gateway', 'sso']), status: pick(cr, CERT_STATUS), daysLeft: Math.floor(cr() * 120) - 10 }));
    const vulns = Array.from({ length: Math.floor(cr() * 5) }, () => ({ severity: pick(cr, VULN) }));
    checkCurrency({ certificates: certs, vulnerabilities: vulns, supportStatus: pick(cr, SUPPORT), lastPentest: cr() < 0.3 ? '' : isoDate(msDays(Math.floor(cr() * 800))), lastPatched: cr() < 0.3 ? '' : isoDate(msDays(Math.floor(cr() * 500))) }, 'currency-fuzz#' + k);
  }
  { // an unparseable date: the legacy check silently skips it; the export adds a caveat so the result is marked incomplete
    const inp = { certificates: [], vulnerabilities: [], supportStatus: 'active', lastPentest: '2026-13-45', lastPatched: '2026-00-10' };
    const env = E.run('currency_risk', inp, [], { now: FIXED_NOW });
    ok(env.status === 'computed' && env.output.complete === false && env.caveats.some((c) => c.code === 'pentest_date_not_assessed') && env.caveats.some((c) => c.code === 'patch_date_not_assessed'), 'unparseable dates are flagged incomplete, never an all-clear: ' + J(env));
  }
  { const env = E.run('currency_risk', { certificates: [], vulnerabilities: [], supportStatus: 'unknown', lastPentest: '', lastPatched: '' }, [], { now: FIXED_NOW });
    ok(env.output.risks.length === 0, 'sanity: an "unknown" support status raises no risk (characterised, not changed)'); }
  log('   ' + nCur + ' currency cases');

  // ------------------------------------------------------------------------------------------ G. preflight
  log('G. preflight == generatePreflightFindings()');
  const pr = rng(9001);
  const TEXTS = ['', ' ', 'x', 'short one', 'ten chars!', 'ten chars!!', 'A reasonably long description of the incident that is over thirty characters', 'Card payment failures on checkout', 'Customer data breach suspected', 'Refund email template', 'Discard button', 'PCI scope question', 'personal data export failed', 'Email address leaked in logs', '   padded text with spaces   ', 'Fund transfer slow'];
  let nPf = 0;
  function checkPreflight(c, label) {
    nPf++;
    const set = (id, v) => { dom.el(id).value = v; };
    set('i_shortdesc', c.shortDescription); set('t1_observation', c.observation); set('t1_service', c.service); set('i_diagnosis', c.diagnosis);
    set('i_ci', c.ci); set('i_assigngroup', c.assignmentGroup); set('i_started', c.startedAt); set('i_resolved', c.resolvedAt); set('i_resolution', c.resolution);
    set('rca_rootcause', c.rootCause); set('rca_fix', c.permanentFix);
    dom.el('sla_regulatory').checked = c.regulatoryFlagChecked;
    SCORE_IDS.forEach((k, i) => { set('t1_' + k, String(c.fields[i])); });
    b.setSelected(c.severity); b.setTimeline(c.timelineCount); b.setDecisions(c.decisionCount);
    const triage = b.calcScore();
    const real = b.generatePreflightFindings().map((f) => ({ type: f.type, title: f.title }));
    const inp = { shortDescription: c.shortDescription, observation: c.observation, service: c.service, startedAt: c.startedAt, diagnosis: c.diagnosis, assignmentGroup: c.assignmentGroup, ci: c.ci,
      resolvedAt: c.resolvedAt, resolution: c.resolution, rootCause: c.rootCause, permanentFix: c.permanentFix, severity: c.severity, triageScore: triage, timelineCount: c.timelineCount,
      decisionCount: c.decisionCount, regulatoryFlagChecked: c.regulatoryFlagChecked };
    dom.guard = true; let env; try { env = E.run('preflight', inp); } finally { dom.guard = false; }
    ok(env.status === 'computed' && J(env.output.findings) === J(real), label + '\n   real=' + J(real).slice(0, 300) + '\n   export=' + J(env).slice(0, 300));
  }
  const KEYWORDS = ['payment', 'transaction', 'banking', 'card', 'pci', 'checkout', 'purchase', 'fund', 'personal data', 'pii', 'gdpr', 'customer data', 'data breach', 'email address', 'account number', 'PAYMENT', 'Account Number'];
  const base = { shortDescription: 'A reasonably long description of the incident that is fine', observation: '', service: 'Intranet', startedAt: '2026-10-10T09:00', diagnosis: 'A properly detailed diagnosis of the problem',
    ci: 'CI-1', assignmentGroup: 'Ops', resolvedAt: '', resolution: '', rootCause: 'Connection pool exhausted after deploy', permanentFix: 'Raise pool size and add alerting', severity: '', timelineCount: 2, decisionCount: 0, regulatoryFlagChecked: false, fields: [3, 3, 1, 2, 2, 0] };
  KEYWORDS.forEach((kw) => [false, true].forEach((flag) => [['shortDescription', 'service'], ['service', 'shortDescription']].forEach((pair) => {
    checkPreflight(Object.assign({}, base, { [pair[0]]: 'issue with ' + kw + ' today', regulatoryFlagChecked: flag }), 'preflight keyword ' + kw + ' in ' + pair[0] + ' flag=' + flag);
  })));
  ['', 'P1', 'P2', 'P3', 'P4'].forEach((sev) => [[0, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0], [5, 5, 2, 4, 5, 4], [2, 2, 1, 1, 2, 0]].forEach((fl) => {
    checkPreflight(Object.assign({}, base, { severity: sev, fields: fl, timelineCount: 5, decisionCount: 2 }), 'preflight severity ' + sev + ' score-fields ' + fl);   // includes score 0 with a chosen tier
  }));
  for (let k = 0; k < 4000; k++) {
    checkPreflight({
      shortDescription: pick(pr, TEXTS), observation: pick(pr, TEXTS), service: pick(pr, ['', 'Mobile Banking', 'Payment Gateway', 'Intranet', 'card platform', 'x']),
      startedAt: pick(pr, ['', '2026-10-10T09:00']), diagnosis: pick(pr, ['', 'short', 'nineteen chars long', 'twenty characters!!!', 'A properly detailed diagnosis of the problem']),
      ci: pick(pr, ['', 'PAY-GW-01']), assignmentGroup: pick(pr, ['', 'Platform Ops']), resolvedAt: pick(pr, ['', '2026-10-10T11:00']), resolution: pick(pr, ['', 'Restarted the pool']),
      rootCause: pick(pr, ['', 'short', 'ten chars!!', 'Connection pool exhausted after deploy']), permanentFix: pick(pr, ['', 'short', 'ten chars!!', 'Raise pool size and add alerting']),
      severity: pick(pr, ['', 'P1', 'P2', 'P3', 'P4']), timelineCount: pick(pr, [0, 1, 3, 4, 5, 12]), decisionCount: pick(pr, [0, 1, 4]), regulatoryFlagChecked: pr() < 0.4,
      fields: [pick(pr, [0, 1, 2, 3, 4, 5]), pick(pr, BUSINESS), pick(pr, WORKAROUND), pick(pr, DURATION), pick(pr, REGULATORY), pick(pr, RECURRING)]
    }, 'preflight#' + k);
  }
  log('   ' + nPf + ' preflight cases');

  // ------------------------------------------------------------------------------------------ H. sla_clock
  log('H. sla_clock == slaMins[sev]||240');
  ok(/const limit=slaMins\[sev\]\|\|240;/.test(b.startSLASource), 'the tool still contains the inline SLA limit expression the export mirrors (slaMins[sev]||240)');
  for (const sev of ['P1', 'P2', 'P3', 'P4']) {
    const env = E.run('sla_clock', { severity: sev, startedAt: '2026-10-10T09:00', pausedMinutes: 0 });
    ok(env.status === 'computed' && env.output.limit_minutes === ({ P1: 60, P2: 240, P3: 1440, P4: 4320 })[sev], 'default SLA ' + sev + ': ' + J(env));
  }
  b.setSla({ P1: 30, P2: 0, P3: 999, P4: 1 });
  ok(E.run('sla_clock', { severity: 'P1', startedAt: 'x', pausedMinutes: 0 }).output.limit_minutes === 30 && E.run('sla_clock', { severity: 'P2', startedAt: 'x', pausedMinutes: 0 }).output.limit_minutes === 240 && E.run('sla_clock', { severity: 'P3', startedAt: 'x', pausedMinutes: 0 }).output.limit_minutes === 999, 'the user\'s edited SLA settings are used; a zero/blank falls back to 240 exactly like the tool');
  b.setSla({ P1: 60, P2: 240, P3: 1440, P4: 4320 });

  // ------------------------------------------------------------------------------------------ I. read-only, refusals, fail-closed
  log('I. read-only, refusals and fail-closed behaviour');
  {
    dom.reads = 0;
    for (let k = 0; k < 200; k++) { E.run('incident_score', { users: 3, business: 3, workaround: 1, duration: 2, regulatory: 2, recurring: 0 }); E.run('change_risk', { blast: 5, complexity: 5, rollback: 2, testing: 2, history: 2, timing: 2 }); E.run('routing_suggestion', { observation: 'database timeout', service: '' }); }
    ok(dom.reads === 0, 'the exports never read the DOM');
    const sv = E.run('severity_record', { severity: 'P1' });
    ok(sv.status === 'rejected' && sv.reason === 'human_decision_only', 'severity_record (the tier the human chooses) can never be run by the assistant: ' + J(sv));
    ok(E.evaluate('severity_record', {}).reason === 'human_decision_only', 'severity_record is refused on the draft path too');
    ok(E.run('nope', {}).reason === 'unknown_engine', 'unknown engine');
    ok(E.run('incident_score', null).status === 'rejected' && E.run('incident_score', []).status === 'rejected', 'non-object input is rejected');
    ok(E.run('incident_score', { users: 9, business: 0, workaround: 0, duration: 0, regulatory: 0, recurring: 0 }).status === 'rejected', 'out-of-range answer is rejected, not clamped');
    ok(E.run('intel_hint', { incidentType: 'application', extra: 1 }).status === 'rejected', 'unknown fields are rejected');
  }
  {
    const M2 = makeContext({ omit: ['intelRules'] });
    ok(!M2.E.ready().ok && M2.E.ready().missing.includes('intelRules'), 'a missing tool table is reported');
    ok(M2.E.run('intel_hint', { incidentType: 'security' }).reason === 'engine_tables_unavailable', 'engines whose table is missing fail closed');
    ok(M2.E.run('change_risk', { blast: 5, complexity: 5, rollback: 2, testing: 2, history: 2, timing: 2 }).status === 'computed', 'engines that do not need the missing table still work');
  }
  {
    const M3 = makeContext({ freezeTables: false });   // drift: a custom rule with no rationale produces an output the schema refuses
    M3.b.setCustom([{ id: 'x', keywords: ['zzzdrift'], group: 'Drift Team' }]);
    const r = M3.E.run('routing_suggestion', { observation: 'zzzdrift', service: '' });
    ok(r.status === 'rejected' && r.reason === 'engine_output_invalid', 'an output the schema cannot accept fails closed: ' + J(r));
  }

  // ------------------------------------------------------------------------------------------ J. draft path (unresolved-input policy)
  log('J. evaluate(): drafts -> policy -> engine');
  {
    const R = (v) => ({ state: 'resolved', value: v, provenance: 'form' });
    const U = (reason) => ({ state: 'unresolved', reason: reason || 'not_yet_asked' });
    let r = E.evaluate('incident_score', { users: R(5), business: R(5), workaround: R(2), duration: R(2), regulatory: R(4), recurring: R(0) });
    ok(r.status === 'computed' && r.output.total === 18 && r.output.suggested_tier === 'P1' && r.output.is_major === true, 'resolved score draft: ' + J(r));
    r = E.evaluate('incident_score', { users: U('unknown_to_user'), business: R(5), workaround: R(2), duration: R(2), regulatory: R(4), recurring: R(0) });
    ok(r.status === 'cannot_be_determined' && r.missing.some((m) => m.reason_code === 'score_users_unknown'), 'unknown users -> cannot_be_determined, never a lower score: ' + J(r));
    r = E.evaluate('change_risk', { blast: R(30), complexity: U(), rollback: R(2), testing: R(2), history: R(2), timing: R(2) });
    ok(r.status === 'cannot_be_determined', 'an unset change-risk factor -> cannot_be_determined (the form\'s old "Low Risk" artefact can never be produced): ' + J(r));
    r = E.evaluate('intel_hint', { incidentType: U() });
    ok(r.status === 'computed' && !r.output.matched && r.output.complete === false && r.caveats.some((c) => c.code === 'incident_type_not_classified'), 'unclassified incident type: no hint, but flagged incomplete: ' + J(r));
    r = E.evaluate('routing_suggestion', { observation: U(), service: U() });
    ok(r.status === 'not_assessed', 'no routing text at all -> not_assessed: ' + J(r));
    r = E.evaluate('routing_suggestion', { observation: R('database replication lag'), service: U() });
    ok(r.status === 'computed' && r.output.matched && r.output.complete === false && r.caveats.some((c) => c.code === 'routing_text_partial'), 'routing on partial text carries its caveat: ' + J(r));
    r = E.evaluate('currency_risk', { certificates: U(), vulnerabilities: U(), supportStatus: R('eol'), lastPentest: U(), lastPatched: U() }, { now: FIXED_NOW });
    ok(r.status === 'computed' && r.output.risks.length === 1 && r.output.complete === false && r.caveats.some((c) => c.code === 'certificates_not_assessed'), 'currency with skipped inputs finds what it can and is marked incomplete (an empty list is NOT an all-clear): ' + J(r));
    r = E.evaluate('sla_clock', { severity: R('P2'), startedAt: U(), pausedMinutes: R(0) });
    ok(r.status === 'cannot_be_determined', 'SLA without a start time -> cannot_be_determined: ' + J(r));
    r = E.evaluate('sla_clock', { severity: R('P2'), startedAt: R('2026-10-10T09:00'), pausedMinutes: U() });
    ok(r.status === 'computed' && r.caveats.some((c) => c.code === 'sla_pause_not_applied'), 'SLA with unresolved pause carries a caveat: ' + J(r));
    const blank = Object.fromEntries(['shortDescription', 'observation', 'service', 'startedAt', 'diagnosis', 'assignmentGroup', 'ci', 'resolvedAt', 'resolution', 'rootCause', 'permanentFix', 'severity', 'triageScore', 'timelineCount', 'decisionCount', 'regulatoryFlagChecked'].map((k) => [k, U()]));
    r = E.evaluate('preflight', blank);
    ok(r.status === 'computed' && r.output.complete === false && r.output.findings.some((f) => f.type === 'pf-block'), 'an all-unresolved preflight raises its blocking findings and is marked incomplete: ' + J(r).slice(0, 200));
  }

  const secs = ((Date.now() - T0) / 1000).toFixed(1);
  log('\nparity' + (EMBEDDED ? ' (EMBEDDED block as shipped)' : '') + ': ' + pass + ' assertions passed, ' + failures.length + ' failed in ' + secs + 's  (tool ' + path.basename(HTML_PATH) + ')');
  return { pass, failed: failures.length, failures };
}

if (require.main === module) {
  let res;
  try { res = runAll(); } catch (e) { console.error('PARITY HARNESS ERROR:', e && e.stack || e); process.exit(2); }
  if (res.failed) { console.log('PARITY FAILED'); process.exit(1); }
  console.log('PARITY PASS: ' + res.pass + ' assertions');
}
module.exports = { runAll, makeContext, rng };
