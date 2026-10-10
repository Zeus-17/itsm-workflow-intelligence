#!/usr/bin/env node
/*
 * Agent-layer validation tests (Build Brief Step 3) - IDENTICAL COPY in both repos.
 *   node agent-layer/tests/run.js
 * Exit code 0 only if every assertion passes.
 *
 * Sections
 *   A. shared-file integrity (hash lock)
 *   B. schema validator: differential test vs Python jsonschema (tests/diff-cases.json), fail-closed on unknown keywords
 *   C. resolver: the SAME conformance cases the Python reference passes (schemas/fixtures/policy-cases.json)
 *   D. pre-filter: payment (red-team #6, false-positive control), personal data (P1-P5), policy modes, additive-only config
 *   E. guard + privacy properties: clearance tamper/expiry/warn-confirm, one scan per call, no raw text in events/findings
 *   F. non-answers can never be mistaken for answers; agent-writable restrictions
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const load = (...p) => JSON.parse(read(...p));

let pass = 0; const failures = [];
function ok(cond, msg) { if (cond) pass++; else { failures.push(msg); console.log('  FAIL:', msg); } }
function section(t) { console.log(t); }
function throwsMsg(fn, re) { try { fn(); return false; } catch (e) { return re.test(String(e.message)); } }

// ------------------------------------------------------------------ A. integrity
section('A. shared-file integrity');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f)).toString('utf8').replace(/\r\n/g, '\n')).digest('hex');
const lock = {}; read('LOCK.sha256').trim().split(/\r?\n/).forEach((l) => { const [h, n] = l.split(/\s+/); lock[n] = h; });
for (const f of ['validation.js', 'audit.js', 'failsafe.js', 'audit-schema.json', 'build_audit_schema.py', 'embed.py', 'check_size.py', 'evidence.py', 'tests/run.js', 'tests/audit_run.js', 'tests/failsafe_run.js', 'tests/artifact_run.js', 'tests/gen_diff_cases.py', 'tests/prefilter-cases.json']) {
  ok(lock[f] === sha(f), `${f} differs from LOCK.sha256 (the RM and ITSM copies must be identical; run agent-layer/lock.py)`);
}

const AL = require(path.join(ROOT, 'validation.js'));
const cfg = load('config.json');
const schemas = {
  inputs: load('..', 'schemas', 'engine-inputs.schema.json'), drafts: load('..', 'schemas', 'agent-drafts.schema.json'),
  outputs: load('..', 'schemas', 'engine-outputs.schema.json'), policy: load('..', 'schemas', 'unresolved-policy.json')
};
ok(AL.status().configured === false && AL.status().enabled === false, 'module is inert and unconfigured on load');
ok(throwsMsg(() => AL.validate.draft('readiness', {}), /not configured/), 'using the validator before configure() throws (fail closed)');
AL.configure({ tool: cfg.tool, paymentLabel: cfg.paymentLabel, schemas });
ok(AL.status().configured && AL.status().enabled === false, 'configured but still DISABLED (toggle belongs to a later step)');
ok(AL.prefilter.getPolicy().mode === 'block' && Object.keys(AL.prefilter.getPolicy().categories).length === 0, 'INITIAL personal-data policy is fail-closed (block) before any administrator choice');

// ------------------------------------------------------------------ B. validator differential
section('B. schema validator vs Python jsonschema');
const auditSchemaDoc = load('audit-schema.json');
const diff = load('tests', 'diff-cases.json').cases;
let diffBad = 0;
for (const c of diff) {
  let got;
  try { got = (c.doc === 'audit' ? AL.validate.instance(auditSchemaDoc, c.def, c.instance) : AL.validate.against(c.doc, c.def, c.instance)).length === 0; } catch (e) { got = 'threw:' + e.message; }
  if (got !== c.valid) { diffBad++; ok(false, `validator disagrees on ${c.doc}.${c.def} [${c.label}]: python=${c.valid} js=${got}`); }
}
ok(diffBad === 0, 'no disagreement');
pass += diff.length - diffBad;
console.log(`   ${diff.length} differential cases (${diff.filter((c) => c.valid).length} valid / ${diff.filter((c) => !c.valid).length} invalid)`);
ok(diff.filter((c) => c.valid).length > 20 && diff.filter((c) => !c.valid).length > 100, 'differential set has meaningful valid AND invalid coverage');
// fail-closed on keywords the validator does not implement: a schema can never "pass" because a constraint was ignored
ok(throwsMsg(() => AL._test.validateWith({ $defs: { T: { type: 'string', format: 'email' } } }, 'T', 'x'), /unsupported schema keyword "format"/), 'unsupported schema keyword throws instead of being ignored');
ok(throwsMsg(() => AL._test.validateWith({ $defs: { T: { $ref: '#/$defs/Missing' } } }, 'T', 'x'), /unresolvable \$ref/), 'dangling $ref throws');
ok(AL._test.validateWith({ $defs: { T: { type: 'integer', minimum: 1, maximum: 3 } } }, 'T', 2).length === 0 && AL._test.validateWith({ $defs: { T: { type: 'integer' } } }, 'T', 1.5).length === 1, 'integer vs number handled');

// unit tests for keyword semantics the generated schemas do not exercise on their own
const V = (schema, inst) => AL._test.validateWith({ $defs: { T: schema } }, 'T', inst).length;
ok(V({ oneOf: [{ type: 'integer' }, { type: 'number' }] }, 1) === 1, 'oneOf: matching MORE than one branch is invalid');
ok(V({ oneOf: [{ type: 'integer' }, { type: 'number' }] }, 1.5) === 0, 'oneOf: matching exactly one branch is valid');
ok(V({ oneOf: [{ type: 'string' }, { type: 'boolean' }] }, 3) === 1, 'oneOf: matching no branch is invalid');
ok(V({ type: 'array', uniqueItems: true }, [{ a: 1 }, { a: 1 }]) === 1 && V({ type: 'array', uniqueItems: true }, [{ a: 1 }, { a: 2 }]) === 0, 'uniqueItems compares structurally');
ok(V({ type: 'object', properties: { a: { type: 'integer' } }, additionalProperties: false }, { a: 1, b: 2 }) === 1, 'additionalProperties:false rejects unknown keys');
ok(V({ if: { required: ['k'], properties: { k: { minItems: 1 } } }, then: { properties: { o: { const: false } } } }, { k: [1], o: true }) === 1, 'if/then applies the then-schema when the condition holds');
ok(V({ if: { required: ['k'], properties: { k: { minItems: 1 } } }, then: { properties: { o: { const: false } } } }, { k: [], o: true }) === 0, 'if/then does nothing when the condition fails');
ok(V({ type: 'string', pattern: '^(\\d{4}-\\d{2}-\\d{2})?$' }, '2026-10-10') === 0 && V({ type: 'string', pattern: '^(\\d{4}-\\d{2}-\\d{2})?$' }, 'last year') === 1, 'pattern keyword');
ok(V({ type: 'integer', minimum: 1, maximum: 5 }, 0) === 1 && V({ type: 'integer', minimum: 1, maximum: 5 }, 6) === 1, 'minimum / maximum');
ok(V({ const: { a: [1, 2] } }, { a: [1, 2] }) === 0 && V({ enum: [null, 'x'] }, null) === 0, 'const / enum use structural equality (including null)');

// ------------------------------------------------------------------ C. resolver conformance
section('C. resolver conformance (same cases as the Python reference)');
const cases = load('..', 'schemas', 'fixtures', 'policy-cases.json').cases;
function getAt(obj, p) { let cur = obj; (p.match(/[A-Za-z_]+|\[\d+\]/g) || []).forEach((t) => { cur = t[0] === '[' ? cur[+t.slice(1, -1)] : cur[t]; }); return cur; }
for (const c of cases) {
  const got = AL.validate.draft(c.engine, c.draft, { agentSupplied: c.agent_supplied || [] });
  const e = c.expect; let good = got.status === e.status;
  if (good && e.missing) good = JSON.stringify(got.missing) === JSON.stringify(e.missing);
  if (good && e.caveats) good = JSON.stringify(got.caveats) === JSON.stringify(e.caveats);
  if (good && e.engine_input_contains) good = Object.entries(e.engine_input_contains).every(([p, v]) => getAt(got.engine_input, p) === v);
  if (good && e.reason) good = got.reason === e.reason;
  ok(good, `case ${c.id}: expected ${JSON.stringify(e)}, got ${JSON.stringify(got).slice(0, 260)}`);
}
console.log(`   ${cases.length} cases`);

// ------------------------------------------------------------------ D. pre-filter
section('D. pre-filter');
const pf = load('tests', 'prefilter-cases.json');
// Moving away from Block always needs an attributable acknowledgement of the CURRENT responsibility notice.
const NOTICE = AL.prefilter.responsibilityNotice();
const ACK = (over) => Object.assign({ by: 'it.admin', at: '2026-10-10T10:00:00Z', reason: 'Assessed under our DPIA ref 42', noticeVersion: NOTICE.version }, over || {});
const WARN = { mode: 'warn', acknowledgements: { '*': ACK() } };
ok(NOTICE.version === 'rn-1' && NOTICE.paragraphs.length >= 4 && /responsib/i.test(NOTICE.paragraphs.join(' ')) && /not legal advice/i.test(NOTICE.paragraphs.join(' ')), 'responsibility notice is versioned and states responsibility + not-legal-advice');
AL._test.reset();
for (const c of pf.payment_flagged) {
  const r = AL.prefilter.check(c.text);
  const terms = r.payment.matches.map((m) => m.term);
  ok(r.payment.flagged && r.payment.review_required, `payment flag expected: ${c.id}`);
  ok(c.expect_terms.every((t) => terms.includes(t)), `payment terms for ${c.id}: wanted ${c.expect_terms}, got ${terms}`);
  ok(r.payment.label === cfg.paymentLabel && /human review/i.test(r.payment.label), `payment label is the tool-specific, review-only wording: ${c.id}`);
}
for (const c of pf.payment_not_flagged) { ok(!AL.prefilter.check(c.text).payment.flagged, `payment must NOT flag: ${c.id}`); }
ok(AL.prefilter.setPolicy({ mode: 'warn' }).ok === false, 'NEW: Warn without an acknowledgement is rejected (any move away from Block needs one)');
ok(AL.prefilter.setPolicy(WARN).ok, 'Warn with acknowledgement accepted');
for (const c of pf.pii_flagged) {
  const r = AL.prefilter.check(c.text);
  ok(r.pii.findings.some((f) => f.category === c.category), `PII ${c.category} expected: ${c.id} (got ${r.pii.findings.map((f) => f.category)})`);
  ok(r.decision === 'warn', `warn mode gives 'warn' for ${c.id}`);
}
for (const c of pf.pii_not_flagged) {
  const r = AL.prefilter.check(c.text);
  ok(r.pii.findings.length === 0 && r.decision === 'allow', `no PII false positive: ${c.id} (got ${r.pii.findings.map((f) => f.category)})`);   // P5
}
// policy modes (P1-P3)
AL._test.reset();
ok(AL.prefilter.getPolicy().mode === 'block', 'default policy is fail-closed (block)');
let r = AL.prefilter.check('email me at a.b@example.org');
ok(r.decision === 'block' && r.clearance === null, 'P1 block: refused, no clearance issued, nothing can be sent');
ok(AL.prefilter.redact('email me at a.b@example.org', r.pii.findings) === 'email me at [REDACTED:email]', 'redaction replaces the value with a category token');
ok(!JSON.stringify(r.pii.findings).includes('example.org'), 'findings never contain the matched value');
ok(AL.prefilter.setPolicy(WARN).ok, 'switch to warn (acknowledged)');
r = AL.prefilter.check('Call 07911 123456 please');
ok(r.decision === 'warn' && r.clearance && r.clearance.decision === 'warn', 'P2 warn: flagged, clearance issued but unconfirmed');
ok(throwsMsg(() => AL.guard.assertCleared('Call 07911 123456 please', r.clearance), /not confirmed/), 'P2: sending before explicit confirmation throws');
ok(AL.prefilter.confirmWarn(r.clearance) === true, 'user confirms');
ok(AL.guard.assertCleared('Call 07911 123456 please', r.clearance) === true, 'P2: after confirmation the exact text may be sent');
// P3: Off only with an attributable acknowledgement
ok(AL.prefilter.setPolicy({ mode: 'off' }).ok === false, 'P3: Off without acknowledgement is rejected');
ok(AL.prefilter.getPolicy().mode === 'warn', 'rejected policy leaves the previous policy in force (no silent weakening)');
ok(AL.prefilter.setPolicy({ mode: 'off', acknowledgements: { '*': { by: 'it.admin', at: '2026-10-10T10:00:00Z', reason: 'handled by our DPA' } } }).ok === false, 'an acknowledgement WITHOUT the notice version is rejected');
ok(AL.prefilter.setPolicy({ mode: 'off', acknowledgements: { '*': ACK({ noticeVersion: 'rn-0-old' }) } }).ok === false, 'an acknowledgement of an OLD/unknown notice version is rejected');
ok(AL.prefilter.setPolicy({ mode: 'off', acknowledgements: { '*': ACK() } }).ok, 'P3: Off with by/at/reason + current notice version accepted');
ok(AL.events.recent().some((e) => e.type === 'pii_policy_set' && e.details.noticeVersion === 'rn-1' && e.details.acknowledgedBy === 'it.admin'), 'policy event carries the notice version and who acknowledged it');
r = AL.prefilter.check('account no: 12345678');
ok(r.decision === 'allow' && r.pii.findings.length === 1 && r.pii.findings[0].mode === 'off', 'P3: Off lets it through but still REPORTS the finding (for the audit trail)');
ok(AL.events.recent().some((e) => e.type === 'pii_policy_set'), 'policy change emits an event for Step 4 to log');
// per-category override + unknown category
ok(AL.prefilter.setPolicy({ mode: 'block', categories: { phone: 'warn' } }).ok === false, 'per-category Warn also needs the acknowledgement');
ok(AL.prefilter.setPolicy({ mode: 'block', categories: { phone: 'warn' }, acknowledgements: { phone: ACK() } }).ok, 'per-category override accepted with its acknowledgement');
ok(AL.prefilter.check('ring 07911 123456').decision === 'warn' && AL.prefilter.check('x@y.org').decision === 'block', 'phone=warn while email stays block');
ok(AL.prefilter.setPolicy({ mode: 'block', categories: { nonsense: 'off' } }).ok === false, 'unknown category rejected');
ok(AL.prefilter.setPolicy({ mode: 'block', categories: { email: 'off' } }).ok === false, 'per-category Off also needs acknowledgement');
// additive-only configuration
ok(AL.prefilter.addPiiPattern({ id: 'email', label: 'x', pattern: '.' }).ok === false, 'built-in detector cannot be replaced');
ok(AL.prefilter.addPiiPattern({ id: 'bad_regex', label: 'x', pattern: '([' }).ok === false, 'non-compiling custom pattern rejected');
ok(AL.prefilter.addPiiPattern({ id: 'empty_match', label: 'x', pattern: 'a*' }).ok === false, 'pattern matching the empty string rejected');
ok(AL.prefilter.addPiiPattern({ id: 'employee_id', label: 'employee ID', pattern: 'EMP-\\d{6}' }).ok, 'custom pattern added');
AL.prefilter.setPolicy({ mode: 'block' });
ok(AL.prefilter.check('assigned to EMP-123456').decision === 'block', 'custom pattern is enforced with the same rigour');
ok(AL.prefilter.check('x@y.org').decision === 'block', 'defaults still enforced after adding a custom pattern');
ok(AL.prefilter.addPaymentTerms([{ term: 'Acme Pay', category: 'vendor' }]).ok && AL.prefilter.check('Acme  Pay outage').payment.flagged, 'custom payment term is additive');
ok(AL.prefilter.check('stripe outage').payment.flagged, 'default payment terms still active after adding custom terms');
ok(AL.prefilter.addPaymentTerms([{ term: '' }]).ok === false, 'invalid custom payment term rejected');

// ------------------------------------------------------------------ E. guard + privacy properties
section('E. guard and privacy properties');
AL._test.reset(); AL.prefilter.setPolicy({ mode: 'block' });
const before = AL._test.scanCount();
r = AL.prefilter.check('Stripe webhook failing; ping jane@example.com or 07911 123456');
ok(AL._test.scanCount() - before === 1, 'payment + personal-data rules run in ONE combined scan per call');
ok(r.payment.flagged && r.pii.findings.length === 2 && r.decision === 'block', 'both rule sets report from that single call');
const evJson = JSON.stringify(AL.events.recent());
ok(!/jane@example|07911|webhook failing/.test(evJson), 'events contain counts/categories only - no raw text or matched values');
AL._test.reset();
r = AL.prefilter.check('plain release note');
ok(r.decision === 'allow' && r.clearance, 'clean text is allowed with a clearance');
ok(AL.guard.assertCleared('plain release note', r.clearance) === true, 'exact text passes the guard');
ok(throwsMsg(() => AL.guard.assertCleared('plain release note!', r.clearance), /changed after/), 'text modified after clearance is refused');
ok(throwsMsg(() => AL.guard.assertCleared('plain release note', { id: 'forged', decision: 'allow', textHash: 'x' }), /no valid/), 'forged clearance is refused');
ok(throwsMsg(() => AL.guard.assertCleared('plain release note', null), /no valid/), 'missing clearance is refused');
const realNow = Date.now; Date.now = () => realNow() + 11 * 60 * 1000;
ok(throwsMsg(() => AL.guard.assertCleared('plain release note', r.clearance), /expired/), 'expired clearance is refused');
Date.now = realNow;
ok(AL.prefilter.check(12345).decision === 'block', 'non-string input is blocked, not coerced');
// review flags need a NAMED human
AL._test.reset();
const pr = AL.prefilter.check('Adyen payout failing');
ok(AL.review.flags().length === 1 && AL.review.flags()[0].acknowledged === null, 'payment flag raised and unacknowledged');
ok(AL.review.acknowledge(pr.payment.flagId, '') === false, 'anonymous acknowledgement refused');
ok(AL.review.acknowledge(pr.payment.flagId, 'A. Reviewer') === true && AL.review.flags()[0].acknowledged.by === 'A. Reviewer', 'named acknowledgement recorded (no classification is made)');
// breakpoints
const logged = []; const origDebug = console.debug; console.debug = (...a) => logged.push(a[0]);
AL.debug.set('agent_output_received', true); AL.debug.set('validation_result', true);
{ const eng0 = AL.validate.engines()[0]; AL.validate.draft(eng0, Object.fromEntries(Object.keys(schemas.inputs.$defs[eng0].properties).map((k) => [k, { state: 'unresolved', reason: 'declined' }]))); }
console.debug = origDebug; AL.debug.set('agent_output_received', false); AL.debug.set('validation_result', false);
ok(logged.includes('[AgentLayer:agent_output_received]') && logged.includes('[AgentLayer:validation_result]'), 'named layer-boundary breakpoints fire when enabled');
ok(throwsMsg(() => AL.debug.set('nonsense', true), /unknown breakpoint/), 'unknown breakpoint name is rejected');
// module is frozen
try { AL.validate = null; } catch (e) { /* strict-mode throw is fine */ }
ok(typeof AL.validate === 'object' && AL.validate !== null, 'public API cannot be replaced at runtime');

// ------------------------------------------------------------------ F. non-answers and agent-writable restrictions
section('F. non-answers and restrictions');
const draftAll = (eng) => Object.fromEntries(Object.keys(schemas.inputs.$defs[eng].properties).map((k) => [k, { state: 'unresolved', reason: 'declined' }]));
const nonAnswers = AL.validate.engines().map((eng) => [eng, AL.validate.draft(eng, draftAll(eng))]);
for (const [eng, res] of nonAnswers) {
  ok(['cannot_be_determined', 'not_assessed', 'ready', 'rejected'].includes(res.status), `${eng}: all-unresolved draft yields a defined status`);
  ok(!('score' in res) && !('engine_input' in res && res.status !== 'ready'), `${eng}: a non-answer carries no score/verdict`);
}
const R_ = (v, p) => ({ state: 'resolved', value: v, provenance: p || 'form' });
if (cfg.tool === 'rm') {
  ok(AL.validate.draft('decision_record', { decision: R_('go'), decidedBy: R_('A'), rationale: R_(''), riskNotes: R_('') }, { agentSupplied: ['decision'] }).status === 'rejected', 'RM: the agent can never supply the GO/NO-GO');
  ok(AL.validate.draft('decision_record', { decision: R_('go'), decidedBy: R_('A'), rationale: R_(''), riskNotes: R_('') }).status === 'ready', 'RM: a decision that came from the user (not agent-supplied) is accepted');
} else {
  ok(AL.validate.draft('severity_record', { severity: R_('P1') }, { agentSupplied: ['severity'] }).status === 'rejected', 'ITSM: the agent can never choose the severity tier');
  ok(AL.validate.draft('severity_record', { severity: R_('P1') }).status === 'ready', 'ITSM: a tier picked by the user is accepted');
}

// ------------------------------------------------------------------ summary
console.log('');
if (failures.length) { console.log(`FAILED: ${failures.length} problem(s); ${pass} assertions passed`); process.exit(1); }
console.log(`ALL TESTS PASSED (${pass} assertions)`);
