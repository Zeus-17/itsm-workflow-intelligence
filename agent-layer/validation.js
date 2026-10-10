/*!
 * Agent-layer VALIDATION LAYER  (Build Brief Step 3)
 *
 * IDENTICAL COPY in both tool repos (RM and ITSM); hash-locked by agent-layer/LOCK.sha256.
 * Embedded into each tool's single HTML file by agent-layer/embed.py, between a pair of HTML comment markers.
 * Also loadable in Node for tests.
 *
 * WHAT THIS IS
 *   The gate between anything an AI provider says and the deterministic rules engines.
 *     1. validate.draft()   - turns an agent DRAFT into either an engine-ready input or an explicit
 *                             non-answer (cannot_be_determined / not_assessed / rejected). Never coerces,
 *                             never fills a gap on the engine's behalf except via a NAMED, CAVEATED,
 *                             conservative fallback defined in unresolved-policy.json.
 *     2. prefilter.check()  - ONE combined pass over the user's RAW text with two rule sets:
 *                             (a) payment / regulatory-relevant terms -> flags for mandatory HUMAN review
 *                                 (never classifies, never decides);
 *                             (b) personal-data shapes (Block / Warn / Off, admin-configurable).
 *                             Runs BEFORE any text is placed in a context sent to a provider.
 *     3. guard.assertCleared() - any provider adapter MUST call this on every user-origin string it is about to
 *                             send; it throws unless the exact text was cleared (and, for Warn, confirmed).
 *
 * WHAT THIS IS NOT
 *   It does not call the rules engines, compute any verdict, score or classification, render UI, store data, or
 *   contact any network. It is INERT until something calls it: with the agent layer absent or toggled off the
 *   tool behaves exactly as before. Nothing in the existing tool code references it.
 *
 * Debug breakpoints (Brief "Process standard"): named, persistent, toggleable via AgentLayer.debug.set(name, true).
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.AgentLayer = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '0.3.0-step3';

  /* ======================================================================================
   * 0. DEBUG BREAKPOINTS + EVENTS
   * ==================================================================================== */

  /** The four layer boundaries named in the Brief. Wired incrementally as later steps arrive. */
  var BREAKPOINTS = {
    agent_output_received: false,   // agent output received  -> before validation
    validation_result: false,       // validation pass/reject -> before rules engine
    engine_output: false,           // rules engine output    -> before display   (wired in Step 6)
    panel_population: false         // Decision panel vs Assistant panel population (wired in Step 6)
  };
  var pauseOnBreak = false;

  /**
   * Fire a named breakpoint. Assumes `payload` is already free of raw user text (callers pass metadata only).
   * Logs when enabled; additionally hits a `debugger` statement when pause mode is on. No-op when disabled.
   * Returns nothing; never throws.
   */
  function bp(name, payload) {
    try {
      if (!BREAKPOINTS[name]) return;
      if (typeof console !== 'undefined' && console.debug) console.debug('[AgentLayer:' + name + ']', payload);
      if (pauseOnBreak) { debugger; } // eslint-disable-line no-debugger
    } catch (e) { /* breakpoints must never break the caller */ }
  }

  var listeners = [];
  var recent = [];
  var RECENT_MAX = 200;

  /**
   * Emit a metadata-only event (timestamp, type, tool, outcome, counts). NEVER includes raw user text or matched
   * personal data. Kept in a bounded in-memory ring only - this module stores and transmits nothing. Step 4 turns
   * these into the persistent audit log. A faulty listener cannot affect the caller.
   */
  function emit(type, details) {
    var ev = { t: new Date().toISOString(), type: type, tool: state.tool, details: details || {} };
    recent.push(ev);
    if (recent.length > RECENT_MAX) recent.shift();
    for (var i = 0; i < listeners.length; i++) { try { listeners[i](ev); } catch (e) { /* ignore */ } }
  }

  /* ======================================================================================
   * 1. CONFIGURATION STATE
   * ==================================================================================== */

  var state = {
    tool: 'unconfigured',
    enabled: false,           // the AI-layer toggle belongs to a later step; false means everything stays dormant
    inputs: null, drafts: null, outputs: null, policy: null,
    paymentLabel: '',
    scanCount: 0              // test hook: number of combined scans performed
  };

  /** Deep-freeze plain data so embedded schemas/policy cannot be mutated at runtime. */
  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
    }
    return o;
  }

  /**
   * Configure with the generated schema package and tool-specific labels.
   * cfg = { tool, schemas:{inputs, drafts, outputs, policy}, paymentLabel }.
   * Throws on a missing piece (fail closed: a half-configured gate must not be usable).
   */
  function configure(cfg) {
    if (!cfg || !cfg.schemas || !cfg.schemas.inputs || !cfg.schemas.drafts || !cfg.schemas.policy) {
      throw new Error('AgentLayer.configure: inputs, drafts and policy schemas are all required');
    }
    state.tool = String(cfg.tool || 'unknown');
    state.inputs = deepFreeze(cfg.schemas.inputs);
    state.drafts = deepFreeze(cfg.schemas.drafts);
    state.outputs = cfg.schemas.outputs ? deepFreeze(cfg.schemas.outputs) : null;
    state.policy = deepFreeze(cfg.schemas.policy);
    state.paymentLabel = String(cfg.paymentLabel || '');
    emit('configured', { engines: Object.keys(state.inputs.$defs || {}).length });
    return true;
  }

  /* ======================================================================================
   * 2. MINIMAL JSON-SCHEMA VALIDATOR (subset used by the generated schemas)
   *    Fail-closed: any keyword it does not implement throws, so a schema can never silently
   *    "pass" because a constraint was ignored. Differentially tested against Python jsonschema.
   * ==================================================================================== */

  var ANNOTATIONS = { '$schema': 1, '$id': 1, 'title': 1, 'description': 1, '$defs': 1 };
  var KEYWORDS = {
    'type': 1, 'enum': 1, 'const': 1, 'properties': 1, 'required': 1, 'additionalProperties': 1, 'items': 1,
    'minItems': 1, 'uniqueItems': 1, 'minLength': 1, 'minimum': 1, 'maximum': 1, 'pattern': 1,
    'oneOf': 1, 'if': 1, 'then': 1, '$ref': 1
  };

  /** Structural equality for JSON values (used by enum / const / uniqueItems). */
  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) { if (!deepEqual(a[ka[i]], b[ka[i]])) return false; }
    return true;
  }

  /** JSON type name of a value (JSON Schema 'integer' is handled separately). */
  function jsonType(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v; // string | number | boolean | object
  }

  /** True if `v` is a JSON integer (finite, no fractional part). */
  function isInteger(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }

  /** Resolve a local "#/$defs/Name" reference against the schema document root. Throws on anything else. */
  function resolveRef(ref, rootDoc) {
    var m = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(ref);
    if (!m || !rootDoc.$defs || !rootDoc.$defs[m[1]]) throw new Error('AgentLayer: unresolvable $ref ' + ref);
    return rootDoc.$defs[m[1]];
  }

  /** Does `inst` satisfy JSON-Schema 'type' keyword value `t` (string or array of strings)? */
  function typeMatches(t, inst) {
    var types = Array.isArray(t) ? t : [t];
    for (var i = 0; i < types.length; i++) {
      var x = types[i];
      if (x === 'integer' ? isInteger(inst) : x === 'number' ? (typeof inst === 'number' && isFinite(inst)) : jsonType(inst) === x) return true;
    }
    return false;
  }

  /**
   * Collect validation errors for `inst` against `schema` into `out` as {path:[...], keyword}.
   * `path` is the instance location (property names / array indexes) of the failing value, matching what
   * the reference (Python jsonschema) reports for the keyword types used here.
   */
  function check(schema, inst, rootDoc, path, out) {
    var k;
    for (k in schema) {
      if (!Object.prototype.hasOwnProperty.call(schema, k)) continue;
      if (!(ANNOTATIONS[k] || KEYWORDS[k] || k.indexOf('x-') === 0)) throw new Error('AgentLayer: unsupported schema keyword "' + k + '"');
    }
    if (schema.$ref) { check(resolveRef(schema.$ref, rootDoc), inst, rootDoc, path, out); }
    if ('type' in schema && !typeMatches(schema.type, inst)) { out.push({ path: path, keyword: 'type' }); return; }
    if ('const' in schema && !deepEqual(schema.const, inst)) out.push({ path: path, keyword: 'const' });
    if (schema.enum) {
      var hit = false;
      for (var i = 0; i < schema.enum.length; i++) { if (deepEqual(schema.enum[i], inst)) { hit = true; break; } }
      if (!hit) out.push({ path: path, keyword: 'enum' });
    }
    if (typeof inst === 'string') {
      if ('minLength' in schema && inst.length < schema.minLength) out.push({ path: path, keyword: 'minLength' });
      if ('pattern' in schema && !new RegExp(schema.pattern).test(inst)) out.push({ path: path, keyword: 'pattern' });
    }
    if (typeof inst === 'number') {
      if ('minimum' in schema && inst < schema.minimum) out.push({ path: path, keyword: 'minimum' });
      if ('maximum' in schema && inst > schema.maximum) out.push({ path: path, keyword: 'maximum' });
    }
    if (Array.isArray(inst)) {
      if ('minItems' in schema && inst.length < schema.minItems) out.push({ path: path, keyword: 'minItems' });
      if (schema.uniqueItems) {
        for (var a = 0; a < inst.length; a++) for (var b = a + 1; b < inst.length; b++) {
          if (deepEqual(inst[a], inst[b])) { out.push({ path: path, keyword: 'uniqueItems' }); a = inst.length; break; }
        }
      }
      if (schema.items) { for (var j = 0; j < inst.length; j++) check(schema.items, inst[j], rootDoc, path.concat(j), out); }
    }
    if (inst && typeof inst === 'object' && !Array.isArray(inst)) {
      var req = schema.required || [];
      for (var r = 0; r < req.length; r++) { if (!Object.prototype.hasOwnProperty.call(inst, req[r])) out.push({ path: path, keyword: 'required' }); }
      var props = schema.properties || {};
      for (var p in props) { if (Object.prototype.hasOwnProperty.call(props, p) && Object.prototype.hasOwnProperty.call(inst, p)) check(props[p], inst[p], rootDoc, path.concat(p), out); }
      if (schema.additionalProperties === false) {
        for (var ik in inst) { if (Object.prototype.hasOwnProperty.call(inst, ik) && !Object.prototype.hasOwnProperty.call(props, ik)) out.push({ path: path, keyword: 'additionalProperties' }); }
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        throw new Error('AgentLayer: additionalProperties as a schema is not supported');
      }
    }
    if (schema.oneOf) {
      var valid = 0;
      for (var o = 0; o < schema.oneOf.length; o++) {
        var sub = []; check(schema.oneOf[o], inst, rootDoc, path, sub);
        if (sub.length === 0) valid++;
      }
      if (valid !== 1) out.push({ path: path, keyword: 'oneOf' });
    }
    if (schema['if']) {
      var cond = []; check(schema['if'], inst, rootDoc, path, cond);
      if (cond.length === 0 && schema.then) check(schema.then, inst, rootDoc, path, out);
    }
  }

  /** Validate `inst` against the named definition in a schema document. Returns an array of errors (empty = valid). */
  function validateAgainst(doc, defName, inst) {
    var errs = [];
    check({ $ref: '#/$defs/' + defName }, inst, doc, [], errs);
    return errs;
  }

  /* ======================================================================================
   * 3. RESOLVER: agent DRAFT -> engine-ready input | explicit non-answer
   * ==================================================================================== */

  /** Convert an error/instance path to the display form used by the policy: gates[2].status */
  function displayPath(parts) {
    var s = '';
    for (var i = 0; i < parts.length; i++) s += (typeof parts[i] === 'number') ? '[' + parts[i] + ']' : (s ? '.' : '') + parts[i];
    return s;
  }

  /** gates[2].status -> gates[].status (the key form used by unresolved-policy.json). */
  function normPath(p) { return p.replace(/\[\d+\]/g, '[]'); }

  /** Find the policy entry for a path, walking up to parents (engine-input errors can occur on a parent). */
  function lookupPolicy(pol, path) {
    while (path) {
      if (Object.prototype.hasOwnProperty.call(pol, path)) return pol[path];
      var next = path.replace(/(\[\]|\.[A-Za-z_]+)$/, '');
      if (next === path) break;
      path = next;
    }
    return null;
  }

  function isObjSchema(s) { return s && s.type === 'object' && s.properties; }
  function isArrObjSchema(s) { return s && s.type === 'array' && s.items && s.items.type === 'object' && s.items.properties; }

  /** Is this value a non-blank string / non-empty collection? Used by engine-level "requires any of" rules. */
  function nonBlank(v) { return typeof v === 'string' ? v.trim().length > 0 : !!(v && (!Array.isArray(v) || v.length)); }

  /**
   * Substitute policy fallbacks / record blocks while walking a (valid) draft in step with the engine-input schema.
   * `node` is the draft node; `schema` the engine-input sub-schema. Pushes to `missing` and `caveats`.
   * Returns the plain engine-input value (blocked leaves become null and are never used because `missing` is non-empty).
   */
  function walk(node, schema, path, pol, missing, caveats) {
    var out, k, i;
    if (isObjSchema(schema)) {
      out = {};
      for (k in schema.properties) { if (Object.prototype.hasOwnProperty.call(schema.properties, k)) out[k] = walk(node[k], schema.properties[k], path ? path + '.' + k : k, pol, missing, caveats); }
      return out;
    }
    if (isArrObjSchema(schema)) {
      if (node && !Array.isArray(node) && node.state === 'unresolved') return applyPolicy(pol, path, missing, caveats);
      out = [];
      for (i = 0; i < node.length; i++) out.push(walk(node[i], schema.items, path + '[' + i + ']', pol, missing, caveats));
      return out;
    }
    if (node.state === 'resolved') return node.value;
    return applyPolicy(pol, path, missing, caveats);
  }

  /** Apply the policy for an unresolved leaf/array: block (record missing) or fallback (substitute + caveat). */
  function applyPolicy(pol, displayed, missing, caveats) {
    var entry = pol[normPath(displayed)];
    if (!entry) throw new Error('AgentLayer: no unresolved-policy entry for "' + normPath(displayed) + '" (schema package is inconsistent)');
    if (entry.on_unresolved === 'block') {
      missing.push({ field: displayed, reason_code: entry.reason_code, _status: entry.block_status });
      return null;
    }
    caveats.push({ code: entry.caveat_code, field: displayed });
    return JSON.parse(JSON.stringify(entry.fallback_value));
  }

  /** Build the final non-answer result from collected missing inputs (cannot_be_determined wins over not_assessed). */
  function missingResult(missing) {
    var cbd = false, i;
    for (i = 0; i < missing.length; i++) { if ((missing[i]._status || 'cannot_be_determined') === 'cannot_be_determined') cbd = true; }
    return { status: cbd ? 'cannot_be_determined' : 'not_assessed', missing: missing.map(function (m) { return { field: m.field, reason_code: m.reason_code }; }) };
  }

  /**
   * Validate an agent DRAFT for `engine`.
   *   engine        : engine id, e.g. 'readiness'
   *   draft         : object whose every leaf is {state:'resolved',value,provenance} or {state:'unresolved',reason}
   *   opts.agentSupplied : paths the model itself tried to set (rejected for fields the policy marks agent_writable:'no')
   * Returns one of
   *   {status:'ready', engine_input, caveats}            -> safe to hand to the deterministic engine
   *   {status:'cannot_be_determined', missing}           -> a required input is unresolved and no safe default exists
   *   {status:'not_assessed', missing}                   -> the engine would silently show nothing; say so instead
   *   {status:'rejected', reason}                        -> malformed / forbidden; nothing is coerced or repaired
   * Never throws for bad INPUT (that is a 'rejected' result); throws only for an inconsistent schema package or an
   * unknown engine (a programming error).
   */
  function validateDraft(engine, draft, opts) {
    requireConfigured();
    var engPol = state.policy.engines[engine];
    if (!engPol || !state.inputs.$defs[engine]) throw new Error('AgentLayer.validate: unknown engine "' + engine + '"');
    var pol = engPol.inputs, supplied = (opts && opts.agentSupplied) || [];
    bp('agent_output_received', { engine: engine });
    var result = resolveDraft(engine, draft, engPol, pol, supplied);
    bp('validation_result', { engine: engine, status: result.status });
    emit('validation_result', { engine: engine, status: result.status, missing: (result.missing || []).length, caveats: (result.caveats || []).length, reason: result.reason || null,
      // field NAMES and codes only (never values) so the audit trail can record exactly what was missing or defaulted
      missing_detail: (result.missing || []).map(function (m) { return { field: m.field, reason_code: m.reason_code }; }),
      caveat_detail: (result.caveats || []).map(function (c) { return { code: c.code, field: c.field }; }) });
    return result;
  }

  /** Core of validateDraft (separated so breakpoints/events wrap it exactly once). */
  function resolveDraft(engine, draft, engPol, pol, supplied) {
    var i;
    // 0. Fields the agent may never write (e.g. GO/NO-GO decision, severity tier).
    for (i = 0; i < supplied.length; i++) {
      var sp = pol[supplied[i]];
      if (sp && sp.agent_writable === 'no') return { status: 'rejected', reason: 'agent_may_not_write:' + supplied[i] };
    }
    // 1. Draft must be well-formed: explicit envelope on every field, trustworthy provenance, correct types/enums.
    if (validateAgainst(state.drafts, engine, draft).length) return { status: 'rejected', reason: 'malformed_draft' };
    // 2. Walk: substitute named fallbacks, collect blocks and caveats.
    var missing = [], caveats = [];
    var value = walk(draft, state.inputs.$defs[engine], '', pol, missing, caveats);
    if (missing.length) return missingResult(missing);
    // 3. The resulting engine input must satisfy the strict input schema.
    var errs = validateAgainst(state.inputs, engine, value);
    if (errs.length) {
      var miss = [];
      for (i = 0; i < errs.length; i++) {
        var p = normPath(displayPath(errs[i].path)), entry = lookupPolicy(pol, p);
        if (entry && entry.on_invalid === 'block_as_missing') miss.push({ field: p, reason_code: entry.reason_code, _status: entry.block_status });
        else if (entry && entry.on_invalid === 'not_assessed') miss.push({ field: p, reason_code: entry.invalid_reason_code || entry.reason_code, _status: 'not_assessed' });
        else return { status: 'rejected', reason: 'engine_input_invalid' };
      }
      return missingResult(miss);
    }
    // 4. Engine-level sufficiency ("at least one of these must carry real content").
    var rules = (engPol._engine && engPol._engine.requires_any_of) || [];
    for (i = 0; i < rules.length; i++) {
      var any = false;
      for (var f = 0; f < rules[i].fields.length; f++) { if (nonBlank(value[rules[i].fields[f]])) any = true; }
      if (!any) return { status: rules[i].status, missing: [{ field: rules[i].fields.join('+'), reason_code: rules[i].reason_code }] };
    }
    return { status: 'ready', engine_input: value, caveats: caveats };
  }

  /** Throw unless configure() has been called with a full schema package. */
  function requireConfigured() {
    if (!state.inputs || !state.drafts || !state.policy) throw new Error('AgentLayer: not configured');
  }

  /* ======================================================================================
   * 4. PRE-FILTERS (ONE combined pass over RAW text, before anything reaches a provider)
   * ==================================================================================== */

  /* ---- 4a. payment / regulatory-relevant terms ------------------------------------------------
   * Deliberately BROAD: this flags for human review, it never decides. A vendor name can appear for an unrelated
   * reason (e.g. removing an old test credential from docs) - the human makes that call. Matching is on whole words
   * (so 'refund'/'discard' are no longer caught by accident as 'fund'/'card' substrings), case-insensitive.
   * Organisations may ADD terms; the defaults can never be removed. */
  var PAYMENT_TERMS = [
    // payment providers / networks / schemes
    ['stripe', 'vendor'], ['paypal', 'vendor'], ['adyen', 'vendor'], ['worldpay', 'vendor'], ['braintree', 'vendor'],
    ['klarna', 'vendor'], ['sumup', 'vendor'], ['gocardless', 'vendor'], ['worldline', 'vendor'], ['fiserv', 'vendor'],
    ['elavon', 'vendor'], ['barclaycard', 'vendor'], ['paysafe', 'vendor'], ['alipay', 'vendor'], ['venmo', 'vendor'],
    ['truelayer', 'vendor'], ['checkout.com', 'vendor'], ['global payments', 'vendor'], ['apple pay', 'vendor'],
    ['google pay', 'vendor'], ['visa', 'vendor'], ['mastercard', 'vendor'], ['amex', 'vendor'], ['american express', 'vendor'],
    ['bacs', 'scheme'], ['chaps', 'scheme'], ['faster payments', 'scheme'], ['sepa', 'scheme'], ['swift', 'scheme'],
    ['open banking', 'scheme'], ['psd2', 'regulation'], ['pci', 'regulation'], ['pci-dss', 'regulation'], ['pci dss', 'regulation'],
    // payment-processing language
    ['payment', 'processing'], ['payments', 'processing'], ['payout', 'processing'], ['payouts', 'processing'],
    ['transaction', 'processing'], ['transactions', 'processing'], ['checkout', 'processing'], ['billing', 'processing'],
    ['invoice', 'processing'], ['invoices', 'processing'], ['card', 'processing'], ['cards', 'processing'],
    ['chargeback', 'processing'], ['chargebacks', 'processing'], ['settlement', 'processing'], ['settlements', 'processing'],
    ['acquirer', 'processing'], ['acquiring', 'processing'], ['merchant', 'processing'], ['merchants', 'processing'],
    ['refund', 'processing'], ['refunds', 'processing'], ['direct debit', 'processing'], ['standing order', 'processing'],
    ['payment gateway', 'processing'], ['payment service provider', 'processing'], ['psp', 'processing'],
    ['banking', 'processing'], ['sort code', 'processing'], ['iban', 'processing'], ['fraud', 'processing'], ['fx', 'processing']
  ];
  var customPaymentTerms = [];  // additive only

  /** Escape a literal term for use inside a RegExp; spaces match any whitespace run. */
  function termToPattern(term) {
    return term.trim().replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&').replace(/\s+/g, '\\s+');
  }

  /**
   * (Re)build the single alternation regex for all payment terms, longest term first so 'payment gateway' wins over
   * 'payment'. Whole-word boundaries are written with explicit character classes, not lookbehind, for older Safari.
   */
  function buildPaymentMatcher() {
    var all = PAYMENT_TERMS.concat(customPaymentTerms).slice().sort(function (a, b) { return b[0].length - a[0].length; });
    var map = {};
    all.forEach(function (t) { map[t[0].toLowerCase().replace(/\s+/g, ' ')] = t[1]; });
    var alt = all.map(function (t) { return termToPattern(t[0]); }).join('|');
    return { re: new RegExp('(^|[^A-Za-z0-9])(' + alt + ')(?![A-Za-z0-9])', 'gi'), category: map };
  }
  var paymentMatcher = buildPaymentMatcher();

  /**
   * Add organisation-specific payment terms (additive only: defaults can never be removed or narrowed).
   * terms = [{term, category}]. Invalid entries are rejected as a group, nothing partially applied.
   */
  function addPaymentTerms(terms) {
    var bad = [];
    (terms || []).forEach(function (t, i) { if (!t || typeof t.term !== 'string' || !t.term.trim() || t.term.length > 60) bad.push(i); });
    if (bad.length) return { ok: false, errors: bad.map(function (i) { return 'term #' + i + ' is invalid'; }) };
    terms.forEach(function (t) { customPaymentTerms.push([t.term.trim(), String(t.category || 'custom')]); });
    paymentMatcher = buildPaymentMatcher();
    emit('payment_terms_added', { count: terms.length });
    return { ok: true };
  }

  /** Scan text for payment terms. Returns [{term, category, start, end}] (terms only - never surrounding text). */
  function scanPayment(text) {
    var out = [], m, re = paymentMatcher.re;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      var start = m.index + m[1].length, term = m[2];
      out.push({ term: term.toLowerCase().replace(/\s+/g, ' '), category: paymentMatcher.category[term.toLowerCase().replace(/\s+/g, ' ')] || 'custom', start: start, end: start + term.length });
      if (re.lastIndex === m.index) re.lastIndex++;
    }
    return out;
  }

  /* ---- 4b. personal-data shapes ---------------------------------------------------------------- */

  /** Luhn checksum over a string of digits (payment-card sanity check; cuts false positives). */
  function luhn(d) {
    var sum = 0, alt = false;
    for (var i = d.length - 1; i >= 0; i--) { var n = d.charCodeAt(i) - 48; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; }
    return sum % 10 === 0;
  }

  /** ISO 7064 mod-97 check for an IBAN (rearranged, letters -> numbers). */
  function ibanOk(s) {
    var v = s.replace(/\s+/g, '').toUpperCase();
    if (v.length < 15 || v.length > 34) return false;
    var r = v.slice(4) + v.slice(0, 4), rem = 0;
    for (var i = 0; i < r.length; i++) {
      var c = r.charCodeAt(i), val = c >= 65 && c <= 90 ? String(c - 55) : String.fromCharCode(c);
      for (var j = 0; j < val.length; j++) rem = (rem * 10 + (val.charCodeAt(j) - 48)) % 97;
    }
    return rem === 1;
  }

  /** True if the character before index `i` would make a match part of a longer word/number/dotted token. */
  function wordBefore(text, i) { return i > 0 && /[\w.]/.test(text.charAt(i - 1)); }
  /** True if the character at index `i` continues a word/number. */
  function wordAfter(text, i) { return i < text.length && /[\w]/.test(text.charAt(i)); }

  var NI_BAD_PREFIX = { BG: 1, GB: 1, NK: 1, KN: 1, TN: 1, NT: 1, ZZ: 1 };

  /**
   * Built-in personal-data detectors, in PRIORITY order (an earlier match claims its span; overlapping later matches
   * are dropped). Each is {id, label, re, ok(matchText, text, start, end)}. `ok` removes false positives
   * (checksums, boundaries). Regexes use no lookbehind (older Safari). Findings never carry the matched value.
   */
  var PII_DETECTORS = [
    { id: 'email', label: 'email address',
      re: /[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}/g, ok: function () { return true; } },
    { id: 'national_insurance', label: 'National Insurance number',
      re: /\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z](?:\s?\d{2}){3}\s?[A-D]\b/gi,
      ok: function (m) { return !NI_BAD_PREFIX[m.slice(0, 2).toUpperCase()]; } },
    { id: 'iban', label: 'IBAN',
      re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,3})?\b/g, ok: function (m) { return ibanOk(m); } },
    { id: 'payment_card', label: 'payment card number',
      re: /\b(?:\d[ -]?){12,18}\d\b/g,
      ok: function (m) { var d = m.replace(/[ -]/g, ''); return d.length >= 13 && d.length <= 19 && !/^(\d)\1+$/.test(d) && luhn(d); } },
    { id: 'sort_code_account', label: 'bank sort code / account number',
      re: /\b\d{2}-\d{2}-\d{2}\b|\b(?:acc(?:oun)?t|a\/c)(?:\s*(?:no\.?|number|num|#))?\s*[:#\-]?\s*\d{8}\b/gi,
      // dd-mm-yy dates (e.g. 10-10-26) share the sort-code shape: skip values whose 1st group is a valid day and 2nd a valid month
      ok: function (m) {
        if (/^\d{2}-\d{2}-\d{2}$/.test(m)) { var d = parseInt(m.slice(0, 2), 10), mo = parseInt(m.slice(3, 5), 10); if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) return false; }
        return true;
      } },
    { id: 'phone', label: 'phone number',
      re: /(?:\+|\b00)\d[\d\s().\-]{8,16}\d|\b0\d{2,4}[\s\-]?\d{3,4}[\s\-]?\d{3,4}\b/g,
      ok: function (m, text, s, e) {
        var digits = m.replace(/\D/g, '');
        if (digits.length < 10 || digits.length > 15) return false;
        if (wordBefore(text, s) || wordAfter(text, e)) return false;
        if (/^\d{4}-\d{2}-\d{2}/.test(m.trim())) return false; // ISO date
        return true;
      } }
  ];
  var customPiiDetectors = []; // additive only: {id,label,re,ok}

  /**
   * Add an organisation-defined personal-data pattern (additive only; cannot replace or disable a built-in).
   * def = {id, label, pattern (string), flags (optional)}. Returns {ok} or {ok:false, errors}.
   */
  function addPiiPattern(def) {
    var errors = [];
    if (!def || typeof def.id !== 'string' || !/^[a-z0-9_]{2,40}$/.test(def.id)) errors.push('id must be 2-40 chars of a-z, 0-9, _');
    var existing = PII_DETECTORS.concat(customPiiDetectors).map(function (d) { return d.id; });
    if (def && existing.indexOf(def.id) >= 0) errors.push('id "' + def.id + '" already exists (built-in patterns cannot be replaced)');
    var re = null;
    try { re = new RegExp(def && def.pattern, ((def && def.flags) || '').replace(/[^gimsu]/g, '').replace('g', '') + 'g'); } catch (e) { errors.push('pattern does not compile'); }
    if (re && re.test('')) errors.push('pattern must not match the empty string');
    if (errors.length) return { ok: false, errors: errors };
    customPiiDetectors.push({ id: def.id, label: String(def.label || def.id), re: re, ok: function () { return true; } });
    emit('pii_pattern_added', { id: def.id });
    return { ok: true };
  }

  /**
   * The responsibility statement an administrator must acknowledge before moving ANY personal-data check away from the
   * protective default (Block). Versioned: the version id travels with every acknowledgement so a later wording change
   * is never confused with an earlier acceptance. WORDING NEEDS GENUINE LEGAL REVIEW before use with personal data.
   */
  var RESPONSIBILITY_NOTICE = deepFreeze({
    version: 'rn-1',
    title: "Your organisation's responsibility for these settings",
    paragraphs: [
      'This tool includes technical safeguards that run on your device before any text is sent to an AI provider: a personal-data filter and a flag for payment-related or regulatory-relevant terms. They are aids, not guarantees. They work by pattern matching, so they can miss information and can flag text that is harmless.',
      'The tool starts in its most protective setting (Block). Choosing a less protective setting, or turning a check off, is a decision of your organisation. By making that choice you confirm that your organisation has assessed it and remains responsible for ensuring that how this tool is configured and used - including your agreement with the AI provider you select - meets your data-protection obligations and your own policies.',
      'Rules you add are applied in addition to the defaults. This tool does not itself store, process or transmit your data to any service: text you choose to send goes directly from your browser to your chosen provider, under the terms agreed between your organisation and that provider.',
      'This statement describes how the tool works; it is not legal advice. It has been prepared with UK and EU requirements in mind - organisations elsewhere should obtain their own review.'
    ]
  });

  var MODES = { block: 1, warn: 1, off: 1 };
  /* Default policy is FAIL-CLOSED: until an administrator chooses otherwise, any personal-data match blocks. */
  var piiPolicy = { mode: 'block', categories: {}, acknowledgements: {} };

  /**
   * Set the administrator's personal-data policy.
   *   policy = { mode: 'block'|'warn'|'off', categories: {<id>: mode}, acknowledgements: {<id|'*'>: {by, at, reason}} }
   * 'off' (globally or per category) is accepted ONLY with a matching acknowledgement - the organisation's explicit,
   * attributable choice - otherwise the whole policy is rejected and the previous policy stays in force
   * (never a silent weakening). Returns {ok:true} or {ok:false, errors:[...]}.
   */
  function setPiiPolicy(policy) {
    var errors = [], known = PII_DETECTORS.concat(customPiiDetectors).map(function (d) { return d.id; });
    var p = policy || {};
    var mode = p.mode || 'block', cats = p.categories || {}, acks = p.acknowledgements || {};
    if (!MODES[mode]) errors.push('mode must be block, warn or off');
    Object.keys(cats).forEach(function (c) {
      if (known.indexOf(c) < 0) errors.push('unknown category "' + c + '"');
      if (!MODES[cats[c]]) errors.push('category "' + c + '" has an invalid mode');
    });
    // ANY move away from Block (warn OR off, globally or per category) needs an attributable acknowledgement of the CURRENT
    // responsibility notice: who, when, why, and the notice version they accepted. Block never needs one.
    function acked(key) { var a = acks[key]; return !!(a && a.by && a.at && a.reason && a.noticeVersion === RESPONSIBILITY_NOTICE.version); }
    if (mode !== 'block' && MODES[mode] && !acked('*')) errors.push('mode "' + mode + '" requires an acknowledgement (by, at, reason, noticeVersion "' + RESPONSIBILITY_NOTICE.version + '") under "*"');
    Object.keys(cats).forEach(function (c) { if (cats[c] !== 'block' && MODES[cats[c]] && !acked(c) && !acked('*')) errors.push('category "' + c + '" set to ' + cats[c] + ' requires an acknowledgement of the responsibility notice'); });
    if (errors.length) { emit('pii_policy_rejected', { errors: errors.length }); return { ok: false, errors: errors }; }
    piiPolicy = { mode: mode, categories: JSON.parse(JSON.stringify(cats)), acknowledgements: JSON.parse(JSON.stringify(acks)) };
    // Recorded so Step 4 can persist "the organisation's own logged choice" with its timestamp, author and notice version.
    var weakened = (mode !== 'block' ? 1 : 0) + Object.keys(cats).filter(function (c) { return cats[c] !== 'block'; }).length;
    var who = acks['*'] ? acks['*'].by : (Object.keys(acks).length ? acks[Object.keys(acks)[0]].by : null);
    emit('pii_policy_set', { mode: mode, categoryOverrides: Object.keys(cats).length, weakened: weakened, offChoices: (mode === 'off' ? 1 : 0) + Object.keys(cats).filter(function (c) { return cats[c] === 'off'; }).length, noticeVersion: weakened ? RESPONSIBILITY_NOTICE.version : null, acknowledgedBy: weakened ? (who || null) : null });
    return { ok: true };
  }

  /** Current policy (copy). */
  function getPiiPolicy() { return JSON.parse(JSON.stringify(piiPolicy)); }

  /** Effective mode for one category under the current policy. */
  function modeFor(cat) { return piiPolicy.categories[cat] || piiPolicy.mode; }

  /**
   * Scan for personal data. Returns [{category, label, start, end, length}] - NEVER the matched value.
   * Detectors run in priority order; a later match overlapping an earlier finding is dropped.
   */
  function scanPii(text) {
    var found = [], all = PII_DETECTORS.concat(customPiiDetectors);
    all.forEach(function (d) {
      var re = new RegExp(d.re.source, d.re.flags.indexOf('g') >= 0 ? d.re.flags : d.re.flags + 'g'), m;
      while ((m = re.exec(text)) !== null) {
        var s = m.index, e = s + m[0].length;
        if (m[0].length === 0) { re.lastIndex++; continue; }
        if (!d.ok(m[0], text, s, e)) continue;
        if (found.some(function (f) { return s < f.end && e > f.start; })) continue;
        found.push({ category: d.id, label: d.label, start: s, end: e, length: e - s });
      }
    });
    return found.sort(function (a, b) { return a.start - b.start; });
  }

  /** Replace each finding with [REDACTED:category] so the user can fix their input. Returns a new string. */
  function redact(text, findings) {
    var out = '', pos = 0;
    findings.slice().sort(function (a, b) { return a.start - b.start; }).forEach(function (f) {
      if (f.start < pos) return;
      out += text.slice(pos, f.start) + '[REDACTED:' + f.category + ']';
      pos = f.end;
    });
    return out + text.slice(pos);
  }

  /* ---- 4c. clearance guard ---------------------------------------------------------------------- */

  /** 53-bit string hash (cyrb53). Tamper DETECTION for "was this exact text cleared" - not a security boundary. */
  function hashText(str) {
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < str.length; i++) { var ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16) + ':' + str.length;
  }

  var clearances = {};            // id -> {hash, decision, confirmed, issuedAt}  (private to this module)
  var CLEARANCE_TTL_MS = 10 * 60 * 1000;
  var clearanceSeq = 0;
  var reviewFlags = [];           // payment/regulatory flags awaiting a named human's acknowledgement

  /**
   * THE PRE-FLIGHT CHECK. One combined pass over the user's RAW text, run before the text is placed in any context for a
   * provider. Returns
   *   { decision:'allow'|'warn'|'block', payment:{flagged, matches, label, review_required, flagId},
   *     pii:{findings, byCategory}, clearance }
   * `clearance` is issued only for 'allow' (immediately usable) and 'warn' (usable after confirmWarn()); never for 'block'.
   * Events/breakpoints carry counts and categories only - never the text or matched values.
   */
  function preflight(rawText) {
    if (typeof rawText !== 'string') return { decision: 'block', error: 'text must be a string', payment: { flagged: false, matches: [] }, pii: { findings: [], byCategory: {} }, clearance: null };
    state.scanCount++;                                 // exactly one combined scan per call (asserted by tests)
    var payment = scanPayment(rawText), findings = scanPii(rawText);
    var byCategory = {}, decision = 'allow';
    findings.forEach(function (f) {
      var mode = modeFor(f.category);
      byCategory[f.category] = (byCategory[f.category] || 0) + 1;
      f.mode = mode;
      if (mode === 'block') decision = 'block';
      else if (mode === 'warn' && decision !== 'block') decision = 'warn';
    });
    // 'off' categories are not actioned; they are still reported (with mode 'off') for the audit trail.
    var flagged = payment.length > 0, flagId = null;
    if (flagged) { flagId = 'rv' + (++clearanceSeq); reviewFlags.push({ id: flagId, at: new Date().toISOString(), tool: state.tool, terms: payment.length, acknowledged: null }); emit('review_flag', { flagId: flagId, terms: payment.length }); }
    var clearance = null;
    if (decision !== 'block') {
      var id = 'cl' + (++clearanceSeq) + '-' + Math.floor(Math.random() * 1e9).toString(36);
      clearances[id] = { hash: hashText(rawText), decision: decision, confirmed: decision === 'allow', issuedAt: Date.now() };
      clearance = Object.freeze({ id: id, decision: decision, textHash: clearances[id].hash });
    }
    var result = {
      decision: decision,
      payment: { flagged: flagged, matches: payment.map(function (p) { return { term: p.term, category: p.category, start: p.start, end: p.end }; }),
                 label: flagged ? state.paymentLabel : '', review_required: flagged, flagId: flagId },
      pii: { findings: findings, byCategory: byCategory },
      clearance: clearance
    };
    emit('prefilter_decision', { decision: decision, paymentFlagged: flagged, paymentTerms: payment.length, pii: byCategory,
      piiDetail: Object.keys(byCategory).map(function (c) { return { category: c, count: byCategory[c], mode: modeFor(c) }; }) });
    return result;
  }

  /** The user explicitly confirms sending text that triggered a 'warn'. Returns true if the clearance was a valid warn. */
  function confirmWarn(clearance) {
    var c = clearance && clearances[clearance.id];
    if (!c || c.decision !== 'warn') return false;
    c.confirmed = true;
    emit('warn_confirmed', {});
    return true;
  }

  /**
   * HARD GUARD for provider adapters. Call with every user-origin string about to be sent and the clearance obtained
   * for exactly that string. Throws unless: the clearance exists, is unexpired, was issued for these exact characters,
   * and (for 'warn') was confirmed by the user. Fail-closed: any doubt throws.
   */
  function assertCleared(text, clearance) {
    var c = clearance && clearances[clearance.id];
    if (!c) throw new Error('AgentLayer.guard: text has no valid pre-flight clearance');
    if (Date.now() - c.issuedAt > CLEARANCE_TTL_MS) throw new Error('AgentLayer.guard: clearance expired - run the pre-flight check again');
    if (c.hash !== hashText(String(text))) throw new Error('AgentLayer.guard: text changed after it was cleared');
    if (!c.confirmed) throw new Error('AgentLayer.guard: personal-data warning not confirmed by the user');
    return true;
  }

  /** Review flags raised so far (payment/regulatory terms), with acknowledgement status. Returns copies. */
  function listReviewFlags() { return JSON.parse(JSON.stringify(reviewFlags)); }

  /**
   * A named human acknowledges that they have reviewed a flag. `by` is required: an anonymous acknowledgement is
   * refused. Acknowledging does NOT classify anything; it only records that a person looked.
   */
  function acknowledgeReview(flagId, by) {
    var f = reviewFlags.filter(function (x) { return x.id === flagId; })[0];
    if (!f || !by || !String(by).trim()) return false;
    f.acknowledged = { by: String(by).trim(), at: new Date().toISOString() };
    emit('review_acknowledged', { flagId: flagId, by: String(by).trim() });
    return true;
  }

  /* ======================================================================================
   * 5. PUBLIC API
   * ==================================================================================== */

  /** Reset volatile state (tests and "start new session"). Does not touch configuration or built-in rules. */
  function resetSession() {
    clearances = {}; reviewFlags = []; recent.length = 0; state.scanCount = 0;
    piiPolicy = { mode: 'block', categories: {}, acknowledgements: {} };
  }

  var api = {
    version: VERSION,
    /** Lightweight status; safe to call at any time (including before configure). */
    status: function () { return { loaded: true, version: VERSION, tool: state.tool, configured: !!state.inputs, enabled: state.enabled }; },
    configure: configure,
    validate: {
      draft: validateDraft,
      engines: function () { requireConfigured(); return Object.keys(state.inputs.$defs); },
      /** Validate any instance against a definition of the configured schema documents (used by tests/adapters). */
      against: function (doc, def, inst) { requireConfigured(); return validateAgainst(state[doc], def, inst); },
      /** Validate `inst` against definition `def` of an explicitly supplied schema document (used by the audit log). Returns an error array. */
      instance: function (doc, def, inst) { return validateAgainst(doc, def, inst); }
    },
    prefilter: {
      check: preflight, confirmWarn: confirmWarn, redact: redact,
      setPolicy: setPiiPolicy, getPolicy: getPiiPolicy, addPiiPattern: addPiiPattern, addPaymentTerms: addPaymentTerms,
      /** The versioned responsibility statement an administrator must acknowledge before weakening any check. */
      responsibilityNotice: function () { return RESPONSIBILITY_NOTICE; },
      categories: function () { return PII_DETECTORS.concat(customPiiDetectors).map(function (d) { return { id: d.id, label: d.label }; }); }
    },
    guard: { assertCleared: assertCleared },
    review: { flags: listReviewFlags, acknowledge: acknowledgeReview },
    debug: {
      names: Object.keys(BREAKPOINTS),
      set: function (name, on) { if (!(name in BREAKPOINTS)) throw new Error('unknown breakpoint ' + name); BREAKPOINTS[name] = !!on; },
      isOn: function (name) { return !!BREAKPOINTS[name]; },
      pause: function (on) { pauseOnBreak = !!on; }
    },
    events: {
      on: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
      recent: function () { return JSON.parse(JSON.stringify(recent)); }
    },
    /** Test hooks. Harmless: counters and a session reset. */
    _test: { scanCount: function () { return state.scanCount; }, reset: resetSession, hashText: hashText, validateWith: validateAgainst }
  };
  return Object.freeze(api);
});
