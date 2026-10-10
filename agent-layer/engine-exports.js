/*!
 * Agent-layer ENGINE EXPORTS - ITSM Workflow Intelligence tool  (Build Brief: engine invocation; Master Plan Phase E)
 *
 * PER-TOOL file (the RM repo has its own engine-exports.js with the same API): NOT part of the hash-locked shared set.
 * Embedded by agent-layer/embed.py after the shared modules.
 *
 * WHAT IT IS
 *   Read-only, side-effect-free versions of the tool's deterministic engines, so the agent layer can ask "what would the
 *   rules engine say for THIS input?" without touching the user's form, the DOM, saved data or any global. The legacy
 *   engines read the DOM and several of them WRITE to it (updateScore sets the severity and the major-incident flag,
 *   calcRiskScore autosaves), so they cannot be called safely from an assistant. These exports are NOT a second rules engine:
 *     - the rule tables (intelRules, ROUTING_RULES, the user's customRoutingRules, slaMins) are read BY REFERENCE at call time,
 *       so a content update or a user's own setting is picked up automatically (engine fingerprint: config.json engineSources);
 *     - the formulas, thresholds and wording that live inside engine functions are mirrored here and PROVEN IDENTICAL by
 *       tests/parity_run.js (Node, runs the tool's real source) and tests/itsm-parity-runner.html (real browser, real DOM) on
 *       every fixture and thousands of fuzzed inputs. If the engine changes and a mirror drifts, the parity test fails.
 *
 * OUTPUT SHAPE
 *   Every call returns an envelope that conforms to schemas/engine-outputs.schema.json (verified before it is returned):
 *     {engine, status:'computed', output, caveats}  |  {engine, status:'cannot_be_determined'|'not_assessed', missing}
 *   A computed result is verbatim engine output; nothing is reworded and no verdict is invented.
 *   `severity_record` (the tier the HUMAN chooses) is deliberately NOT exportable: the engine only SUGGESTS a tier.
 *
 * KNOWN LEGACY QUIRKS (characterised, mirrored for parity, NOT fixed here - engine fixes are a separate signed-off workstream):
 *   - (Q-1/Q-4/Q-11/Q-14, adopted 2026-10-10: routing now joins with a space and matches whole words; an unknown support status and an unreadable
 *     date each raise a prompt. The export mirrors the tool exactly and ALSO marks an unreadable date as an incomplete result.)
 *
 * INERT UNTIL USED. No listeners, timers, storage or network. Never throws for bad input (returns a status instead).
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) { module.exports = factory; }   // tests inject a root that holds the tool's tables
  else { root.AgentEngine = factory(root); }
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var VERSION = 'ee-1.0-itsm';
  var TOOL = 'itsm';
  var DAY_MS = 1000 * 60 * 60 * 24;

  /** The tool's own tables, referenced BY NAME in the global scope at call time (never copied). */
  var REQUIRED = ['intelRules', 'ROUTING_RULES', 'slaMins', 'suggestRoutingGroup'];

  function table(name) {
    switch (name) {
      case 'intelRules': return typeof intelRules !== 'undefined' ? intelRules : null;          // eslint-disable-line no-undef
      case 'ROUTING_RULES': return typeof ROUTING_RULES !== 'undefined' ? ROUTING_RULES : null; // eslint-disable-line no-undef
      case 'slaMins': return typeof slaMins !== 'undefined' ? slaMins : null;                   // eslint-disable-line no-undef
      case 'suggestRoutingGroup': return typeof suggestRoutingGroup === 'function' ? suggestRoutingGroup : null; // eslint-disable-line no-undef
      default: return null;
    }
  }

  /** Are all the tool tables this module depends on present? Fail closed if the tool changed shape. */
  function ready() {
    var missing = REQUIRED.filter(function (n) { var t = table(n); return !t || (typeof t !== 'object' && typeof t !== 'function'); });
    return { ok: missing.length === 0, missing: missing };
  }

  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
  function AL() { return root && root.AgentLayer ? root.AgentLayer : null; }
  /** Mirror of the tool's g(): the field value, trimmed. */
  function T(v) { return String(v === undefined || v === null ? '' : v).trim(); }

  /* ---------------------------------------------------------------------------------------------- envelopes */

  function computed(engine, output, caveats) { return { engine: engine, status: 'computed', output: output, caveats: (caveats || []).map(clone) }; }
  function nonAnswer(engine, status, missing) { return { engine: engine, status: status, missing: missing.map(clone) }; }
  function unavailable(engine, why) { return { engine: engine, status: 'rejected', reason: why }; }

  /** Final safety net: the envelope must satisfy the output schema before it leaves this module (fail closed on drift). */
  function finish(engine, envelope) {
    var al = AL();
    if (al && al.validate && typeof al.validate.against === 'function') {
      var errs;
      try { errs = al.validate.against('outputs', engine, envelope); } catch (e) { errs = null; }
      if (errs && errs.length) return unavailable(engine, 'engine_output_invalid');
    }
    if (al && al.debug && al.debug.isOn && al.debug.isOn('engine_output') && typeof console !== 'undefined' && console.debug) {
      console.debug('[AgentLayer:engine_output]', { engine: engine, status: envelope.status });   // named debug breakpoint (Brief: layer boundaries)
    }
    return envelope;
  }

  function complete(caveats) { return !(caveats && caveats.length); }

  /* ---------------------------------------------------------------------------------------------- incident_score
   * Mirrors calcScore()/updateScore(): six factors summed (max 25). Bands P4 0-5, P3 6-10, P2 11-16, P1 17+. 17+ is also the
   * major-incident flag. The tier is only a SUGGESTION - the legacy code applies it only when the user has not chosen one. */

  function incidentScore(input, caveats) {
    var total = input.users + input.business + input.workaround + input.duration + input.regulatory + input.recurring;
    var verdict = total <= 5 ? 'Low impact — P4 or near miss likely'
      : total <= 10 ? 'Moderate impact — P3 likely'
      : total <= 16 ? 'High impact — P2 recommended'
      : 'Critical — P1 / Major Incident threshold reached';
    var tier = total >= 17 ? 'P1' : total >= 11 ? 'P2' : total >= 6 ? 'P3' : 'P4';
    return computed('incident_score', { total: total, suggested_tier: tier, is_major: total >= 17, verdict: verdict }, caveats);
  }

  /* ---------------------------------------------------------------------------------------------- intel_hint
   * Mirrors showIntelHint(): the hint for the chosen incident type, followed by its links when it has any. */

  function intelHint(input, caveats) {
    var rules = table('intelRules');
    var rule = rules[input.incidentType];
    if (rule && input.incidentType) {
      return computed('intel_hint', { matched: true, hint_html: rule.hint + (rule.links ? '<br><br>' + rule.links : ''), complete: complete(caveats) }, caveats);
    }
    return computed('intel_hint', { matched: false, complete: complete(caveats) }, caveats);
  }

  /* ---------------------------------------------------------------------------------------------- preflight
   * Mirrors generatePreflightFindings(): completeness checks, the severity-override warning and the payment / personal-data
   * keyword scans over short description + service (substring matching - the legacy behaviour). Findings keep the engine's order.
   * The output schema carries each finding's type and title (the longer description stays in the tool's own panel). */

  function preflight(input, caveats) {
    var findings = [];
    function f(type, title) { findings.push({ type: type, title: title }); }
    var obs = T(input.shortDescription) || T(input.observation);
    var svc = T(input.service), diag = T(input.diagnosis), ci = T(input.ci), assignGroup = T(input.assignmentGroup);
    var started = T(input.startedAt), resolvedAt = T(input.resolvedAt), resolution = T(input.resolution);
    var rcaRoot = T(input.rootCause), rcaFix = T(input.permanentFix);
    var sev = input.severity || '', tlCount = input.timelineCount, decCount = input.decisionCount, score = input.triageScore;

    // BLOCKING
    if (!obs || obs.trim().length < 10) f('pf-block', 'Short description is missing or too brief');
    if (!svc) f('pf-block', 'No service name entered');
    if (!started) f('pf-warn', 'Start time not set — SLA and MTTR will be incorrect');
    // WARNINGS
    if (diag && diag.trim().length < 20) f('pf-warn', 'Diagnosis is very brief (' + diag.trim().length + ' characters)');
    if (!ci) f('pf-warn', 'Configuration item (CI) not specified');
    if (!assignGroup) f('pf-warn', 'Assignment group not set');
    if (sev && score > 0) {
      var suggested = score >= 17 ? 'P1' : score >= 11 ? 'P2' : score >= 6 ? 'P3' : 'P4';
      if (sev !== suggested) f('pf-warn', 'Severity override: score suggests ' + suggested + ', you selected ' + sev);
    }
    var paymentKeywords = /\b(payments?|transactions?|banking|cards?|pci|checkouts?|purchases?|funds?|refunds?|payouts?|direct debits?|bacs|sepa|apple pay|google pay|merchants?|settlements?)\b/i;   // Q-1/Q-2 (mirrors generatePreflightFindings)
    var flagged = !!input.regulatoryFlagChecked;
    if (paymentKeywords.test(obs + ' ' + svc) && !flagged) f('pf-warn', 'Payment keyword detected — regulatory flag not set');
    var piiKeywords = /\b(personal data|personal information|pii|gdpr|customer data|data breach(es)?|email addresses?|account numbers?|passports?|home address(es)?|national insurance|date of birth|sort code)\b/i;   // Q-1/Q-2
    if (piiKeywords.test(obs + ' ' + svc) && !flagged) f('pf-warn', 'Possible data incident — regulatory flag not set');
    if ((sev === 'P1' || sev === 'P2') && (!rcaRoot || rcaRoot.trim().length < 10)) f('pf-warn', 'Root cause not completed for ' + sev + ' incident');
    if ((sev === 'P1' || sev === 'P2') && (!rcaFix || rcaFix.trim().length < 10)) f('pf-warn', 'Permanent fix not documented');
    // INFORMATIONAL
    if (tlCount === 0) f('pf-info', 'Incident timeline is empty');
    if (decCount === 0 && (sev === 'P1' || sev === 'P2')) f('pf-info', 'No decisions logged in the Decision Log');
    if (resolvedAt && !resolution) f('pf-info', 'Resolution time is set but resolution notes are empty');
    // POSITIVE
    if (tlCount > 3) f('pf-good', 'Strong incident timeline (' + tlCount + ' entries)');
    if (decCount > 0) f('pf-good', 'Decision log populated (' + decCount + ' entries)');
    if (obs && obs.trim().length > 30 && svc && started) f('pf-good', 'Core fields complete — outputs will be paste-ready');
    return computed('preflight', { findings: findings, complete: complete(caveats) }, caveats);
  }

  /* ---------------------------------------------------------------------------------------------- change_risk
   * Mirrors calcRiskScore(): six factors summed (18-120); low <= 30, medium <= 60, otherwise high. The legacy form shows
   * "Incomplete" while any factor is unset - here an unset factor is a missing input (the draft policy blocks it). */

  function changeRisk(input, caveats) {
    var total = input.blast + input.complexity + input.rollback + input.testing + input.history + input.timing;
    return computed('change_risk', { total: total, level: total <= 30 ? 'low' : total <= 60 ? 'medium' : 'high' }, caveats);
  }

  /* ---------------------------------------------------------------------------------------------- routing_suggestion
   * suggestRoutingGroup() is a PURE function of its two arguments (plus the user's own custom routing rules), so the export calls the tool's own
   * function rather than mirroring it: parity is then true by construction. Since Q-1/Q-4 it joins the two texts WITH a space and matches whole words.
   * No text at all is not an answer ("not assessed"), because silence must not read as "nothing to route". */

  function routing(input, caveats) {
    var text = ((input.observation || '') + ' ' + (input.service || '')).toLowerCase();
    if (!text.trim()) return nonAnswer('routing_suggestion', 'not_assessed', [{ field: 'observation+service', reason_code: 'routing_text_missing' }]);
    var rule = table('suggestRoutingGroup')(input.observation, input.service);
    if (!rule) return computed('routing_suggestion', { matched: false, complete: complete(caveats) }, caveats);
    var out = { matched: true, group: rule.group, rationale: rule.rationale, complete: complete(caveats) };
    if (rule.matched && rule.matched.length) out.matched_keywords = rule.matched.slice();   // Q-5: which words triggered it
    return computed('routing_suggestion', out, caveats);
  }

  /* ---------------------------------------------------------------------------------------------- currency_risk
   * Mirrors assessCurrencyRisk(). It depends on today's date (pen-test older than 365 days; patching older than 180 days), so
   * the clock is a parameter: opts.now (a Date or milliseconds), defaulting to the real current time.
   * An unparseable date makes the legacy check silently skip; here the result gets a caveat, so it is marked incomplete. */

  function currencyRisk(input, caveats, now) {
    var risks = [], extra = [];
    input.certificates.forEach(function (e) {
      if (e.status === 'expired') risks.push('EXPIRED certificate: ' + (e.name || 'unnamed'));
      else if (e.status === 'critical') risks.push('Certificate expiring in ' + e.daysLeft + ' days: ' + (e.name || 'unnamed'));
    });
    var critVulns = input.vulnerabilities.filter(function (e) { return e.severity === 'critical' || e.severity === 'high'; });
    if (critVulns.length) risks.push(critVulns.length + ' critical/high severity vulnerabilities unaddressed');
    if (input.supportStatus === 'eol') risks.push('Component is END OF LIFE — no security patches available');
    else if (input.supportStatus === 'eol_soon') risks.push('Component approaching end of support');
    else if (input.supportStatus === 'unknown') risks.push('Vendor support status is unknown — confirm whether this component is still supported');   // Q-11
    var lastPentest = T(input.lastPentest);
    if (lastPentest) {
      var daysSince = Math.floor((now - new Date(lastPentest)) / DAY_MS);
      if (daysSince > 365) risks.push('Last penetration test was ' + Math.floor(daysSince / 30) + ' months ago — consider scheduling review');
      if (isNaN(daysSince)) { risks.push('The last penetration test date could not be read — check it'); extra.push({ code: 'pentest_date_not_assessed', field: 'lastPentest' }); }   // Q-14
    }
    var lastPatched = T(input.lastPatched);
    if (lastPatched) {
      var daysSinceP = Math.floor((now - new Date(lastPatched)) / DAY_MS);
      if (daysSinceP > 180) risks.push('No patching activity in ' + Math.floor(daysSinceP / 30) + ' months');
      if (isNaN(daysSinceP)) { risks.push('The last patching date could not be read — check it'); extra.push({ code: 'patch_date_not_assessed', field: 'lastPatched' }); }   // Q-14
    }
    var all = (caveats || []).concat(extra);
    return computed('currency_risk', { risks: risks, complete: complete(all) }, all);
  }

  /* ---------------------------------------------------------------------------------------------- sla_clock
   * Mirrors startSLAClock(): the limit for the chosen tier is slaMins[tier] (editable in the tool's settings), falling back to
   * 240 minutes. The running clock itself is display-only and is not part of the export. */

  function slaClock(input, caveats) {
    return computed('sla_clock', { limit_minutes: table('slaMins')[input.severity] || 240 }, caveats);
  }

  /* ---------------------------------------------------------------------------------------------- public API */

  var IMPL = { incident_score: incidentScore, intel_hint: intelHint, preflight: preflight, change_risk: changeRisk, routing_suggestion: routing, currency_risk: null, sla_clock: slaClock };
  var DEPENDS = { incident_score: [], intel_hint: ['intelRules'], preflight: [], change_risk: [], routing_suggestion: ['suggestRoutingGroup'], currency_risk: [], sla_clock: ['slaMins'] };

  /**
   * Run engine `engine` on an already-resolved, schema-valid engine input. `caveats` are those produced by the unresolved-input
   * policy (AgentLayer.validate.draft -> {status:'ready', engine_input, caveats}); a caveat forces `complete:false` where the output has that flag.
   * `opts.now` (Date | ms) sets "today" for the date-based currency check. The input is re-validated against the strict input schema.
   */
  function run(engine, input, caveats, opts) {
    if (engine === 'severity_record') return unavailable(engine, 'human_decision_only');
    if (!Object.prototype.hasOwnProperty.call(IMPL, engine)) return unavailable(engine, 'unknown_engine');
    if (!input || typeof input !== 'object' || Array.isArray(input)) return unavailable(engine, 'engine_input_invalid');
    var rd = ready();
    var need = DEPENDS[engine].filter(function (n) { return rd.missing.indexOf(n) !== -1; });
    if (need.length) return unavailable(engine, 'engine_tables_unavailable');
    var al = AL();
    if (al && al.validate && typeof al.validate.against === 'function') {
      var errs;
      try { errs = al.validate.against('inputs', engine, input); } catch (e) { errs = [{ path: '', message: 'validator error' }]; }
      if (errs.length) return unavailable(engine, 'engine_input_invalid');
    }
    var copy = clone(input);
    var env;
    if (engine === 'currency_risk') {
      var n = opts && opts.now !== undefined ? new Date(opts.now) : new Date();
      env = currencyRisk(copy, caveats || [], n);
    } else {
      env = IMPL[engine](copy, caveats || []);
    }
    return finish(engine, env);
  }

  /**
   * Full path from an agent DRAFT: validate -> resolve unresolved inputs per the policy -> run the engine.
   *   returns the output envelope, or {engine, status:'rejected', reason} when the draft itself is malformed / forbidden.
   * `opts.agentSupplied` lists paths the model tried to set (rejected for fields the policy marks agent_writable:'no').
   */
  function evaluate(engine, draft, opts) {
    var al = AL();
    if (!al) return unavailable(engine, 'agent_layer_unavailable');
    if (engine === 'severity_record') return unavailable(engine, 'human_decision_only');
    var v = al.validate.draft(engine, draft, opts);
    if (v.status === 'ready') return run(engine, v.engine_input, v.caveats, opts);
    if (v.status === 'rejected') return unavailable(engine, v.reason);
    return finish(engine, nonAnswer(engine, v.status, v.missing));
  }

  return Object.freeze({
    version: VERSION, tool: TOOL,
    engines: function () { return Object.keys(IMPL); },
    ready: ready, run: run, evaluate: evaluate,
    _test: { table: table }
  });
});
