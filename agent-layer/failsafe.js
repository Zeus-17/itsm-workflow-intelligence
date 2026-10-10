/*!
 * Agent-layer FAILSAFE / CIRCUIT BREAKER  (Build Brief Step 4a; Constraints Sections 17, 32, 38, 40)
 *
 * IDENTICAL COPY in both tool repos; hash-locked by agent-layer/LOCK.sha256. Embedded after validation.js and audit.js.
 *
 * WHAT IT DOES
 *   Watches a PATTERN of unreliable behaviour from an AI provider within a session (not a single blip) and, when a threshold is
 *   crossed, disables the agent layer for that session and routes the user back into the proven-safe deterministic form -
 *   the same state the tool is in with the toggle off. The user gets a calm, plain-language REASON; the administrator gets a
 *   DIAGNOSIS that separates "fix your configuration" from "the provider has a problem" from "the guardrails did their job".
 *
 * KEY GUARANTEES (each covered by tests/failsafe_run.js)
 *   - Falling back is ONE call, no confirmation (Standard Mode), and produces an IDENTICAL hand-off whether automatic or manual.
 *   - No AI-derived value is carried into the standard form unless the user explicitly confirmed it: anything else is demoted to
 *     an UNCONFIRMED CANDIDATE. An interrupted session is "incomplete" - never a Go or a No-Go.
 *   - A soft-override (narration contradicting the deterministic result) counts exactly like a technical failure.
 *   - "No network at all" and "network up but provider unreachable" are distinct reasons with distinct guidance (Section 40.1),
 *     with a debounce so a Wi-Fi blip never flickers an offline banner (Section 40.5).
 *   - Emergency revoke is a separate admin control that REQUIRES an explicit confirmation (the deliberate asymmetry with Standard Mode).
 *
 * THRESHOLDS ARE PLACEHOLDERS (Constraints Section 11): they have NOT been tuned on real provider failure data. Every diagnostic
 * output carries `thresholds_status` saying so until an administrator records a tuning source.
 *
 * INERT UNTIL USED: no listeners, timers or storage writes exist until a caller invokes enable()/connectivity.start().
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.AgentFailsafe = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var root = (typeof self !== 'undefined') ? self : (typeof globalThis !== 'undefined' ? globalThis : {});
  var VERSION = '0.4.1-step4a';
  var DAY_MS = 86400000;

  /* ======================================================================================
   * 1. VOCABULARY: failure kinds, user-facing reasons, diagnoses
   * ==================================================================================== */

  /** Every tracked failure kind -> {reason shown to the user, default diagnosis for the admin, audit trigger}. */
  var KINDS = {
    timeout:              { reason: 'timeout',     diagnosis: 'provider_side',      trigger: 'timeout' },
    malformed:            { reason: 'malformed',   diagnosis: 'configuration',      trigger: 'malformed' },
    validation_rejected:  { reason: 'malformed',   diagnosis: 'configuration',      trigger: 'validation_rejected' },
    soft_override:        { reason: 'soft_override', diagnosis: 'guardrails_working', trigger: 'soft_override' },
    guardrail_violation:  { reason: 'soft_override', diagnosis: 'guardrails_working', trigger: 'soft_override' },
    provider_unreachable: { reason: 'unreachable', diagnosis: 'network',            trigger: 'connectivity' },
    provider_error:       { reason: 'unavailable', diagnosis: 'provider_side',      trigger: 'provider_error' },   // refined by HTTP status
    no_network:           { reason: 'no_network',  diagnosis: 'user_network',       trigger: 'connectivity' }
  };

  /** The plain-language reason for each category (Constraints Section 32.1). Calm, non-technical, no blame. */
  var REASONS = {
    timeout: "The AI assistant didn't respond in time.",
    malformed: "The AI assistant's response couldn't be understood.",
    soft_override: "The AI assistant's explanation didn't match the actual result.",
    emergency_revoke: 'This was switched off by your administrator.',
    no_network: "There's no network connection, and the AI assistant needs one.",
    unreachable: "Your connection is working, but we couldn't reach the AI assistant's service.",
    unavailable: "The AI assistant isn't available right now.",
    manual: ''
  };

  /** What the administrator should do about each diagnosis (Section 32.2/32.3). */
  var ACTIONS = {
    configuration: "Check the API key's permissions, the model name and the endpoint address in this provider's settings.",
    provider_side: "This looks like a problem on the provider's side (an outage or rate limiting). Check the provider's status page and try again later, or use another provider.",
    guardrails_working: "The safeguards caught this provider's model contradicting the tool's own results. That is the system working as designed - consider whether this provider or model is suited to this tool.",
    network: 'Requests could not reach the provider although the network is up. See the network guidance for IT teams: firewall/proxy allowlisting, proxy authentication, TLS-inspecting proxy / Root CA trust, VPN.',
    user_network: 'The device had no network connection at the time. Check the connection; if it recurs on a corporate network see the network guidance for IT teams.'
  };

  var HELP_NETWORK = { id: 'it-guidance-connectivity', label: 'Network guidance for IT teams' };

  /** Refine a provider_error diagnosis from the HTTP status (configuration vs provider-side). */
  function diagnoseProviderError(status) {
    if (status === 401 || status === 403 || status === 400 || status === 404 || status === 422) return 'configuration';
    return 'provider_side';   // 429 rate limit, 5xx outage, anything else unknown
  }

  /* ======================================================================================
   * 2. NARRATION CONSISTENCY CHECK (soft-override detection) - deterministic, lexical, conservative
   * ==================================================================================== */

  var PERMISSIVE = /\b(good to go|safe to (?:proceed|deploy|release|go|ship)|go(?:ing)? ahead|can (?:safely )?proceed|ready to (?:go|deploy|release|ship)|green[- ]?light|no (?:issues|concerns|problems)|close enough|nothing to worry|all clear|you(?:'re| are) (?:fine|good|clear)|recommend(?:ed|s)? (?:a )?(?:go|proceeding|deploying)|proceed(?:ing)? with)\b/gi;
  var NEGATOR = /(?:\bnot\b|n't\b|\bno longer\b|\bcannot\b|\bnever\b|\bunable\b|\bwithout\b|\bunless\b|\bonce\b|\buntil\b|\bbefore\b|\bif\b|\bwhether\b)\s*(?:\w+\s+){0,4}$/i;
  var THRESHOLD_TALK = /(threshold|or (?:more|above|higher|over)|at least|between|bands?|range|\+\s|means|indicates?|typically|usually|if the score)/i;

  /** Split into sentences (good enough for short assistant replies). */
  function sentences(t) {
    // no lookbehind (older Safari): mark each sentence end, then split on the marker or a line break
    return String(t).replace(/([.!?])\s+/g, '$1\u0001').split(/\u0001|\n+/).filter(function (x) { return x.trim(); });
  }

  /**
   * Check an assistant NARRATION against the deterministic FACTS. Returns {consistent, violations:[{rule, excerpt}]}.
   * facts = { status:'computed'|'cannot_be_determined'|'not_assessed', score?, band?:'red'|'amber'|'green', blockers?, tier?:'P1'..'P4', major?, ready?:boolean }
   * The check is deliberately conservative and LEXICAL: it can raise false alarms (the narration is then simply withheld and
   * the engine's own output shown) but must not miss the contradictions the red-team scenarios describe. It never rewrites text.
   */
  function checkNarration(facts, narration, redactFn) {
    var f = facts || {}, text = String(narration === null || narration === undefined ? '' : narration), v = [];
    var safe = typeof redactFn === 'function' ? redactFn : function (x) { return x; };
    function excerpt(s, i, len) { return safe(s.slice(Math.max(0, i - 25), Math.min(s.length, i + (len || 40) + 25)).replace(/\s+/g, ' ').trim()); }
    var computed = f.status === 'computed';
    var readyOk = computed && f.band === 'green' && !(f.blockers > 0) && f.ready !== false;
    sentences(text).forEach(function (sent) {
      var m, re;
      // R1: numeric score claims that differ from the computed score
      if (computed && typeof f.score === 'number' && !THRESHOLD_TALK.test(sent)) {
        re = /\b(?:score|rating|readiness)\s*(?:of|is|was|at|=|:|came out at)?\s*(\d{1,3})\b/gi;
        while ((m = re.exec(sent)) !== null) { if (parseInt(m[1], 10) !== f.score) v.push({ rule: 'score_mismatch', excerpt: excerpt(sent, m.index, m[0].length) }); }
        re = /\b(\d{1,3})\s*(?:\/|out of)\s*(?:100|120|25|24)\b/gi;
        while ((m = re.exec(sent)) !== null) { if (parseInt(m[1], 10) !== f.score) v.push({ rule: 'score_mismatch', excerpt: excerpt(sent, m.index, m[0].length) }); }
      }
      // R2: permissive language when the result does not support it
      if (!readyOk) {
        PERMISSIVE.lastIndex = 0;
        while ((m = PERMISSIVE.exec(sent)) !== null) {
          var before = sent.slice(Math.max(0, m.index - 40), m.index);
          if (!NEGATOR.test(before)) v.push({ rule: 'permissive_language_contradicts_result', excerpt: excerpt(sent, m.index, m[0].length) });
        }
      }
      // R3: blocker claims
      if (typeof f.blockers === 'number') {
        if (f.blockers > 0 && /\b(?:no|zero|0|without any)\s+(?:open\s+)?(?:release[- ]?)?(?:blockers?|blocking (?:defects?|issues?|bugs?))\b/i.test(sent) && !/\b(?:not|n't)\b/i.test(sent)) v.push({ rule: 'blocker_claim_mismatch', excerpt: excerpt(sent, 0, 60) });
        re = /\b(\d{1,3})\s+(?:open\s+)?(?:release[- ]?)?(?:blockers?|blocking (?:defects?|issues?|bugs?))\b/gi;
        while ((m = re.exec(sent)) !== null) { if (parseInt(m[1], 10) !== f.blockers) v.push({ rule: 'blocker_claim_mismatch', excerpt: excerpt(sent, m.index, m[0].length) }); }
      }
      // R4: a result is asserted although none could be determined
      if (!computed && /\b(?:the\s+)?(?:score|rating|readiness|verdict|result)\s*(?:of|is|was|at|=|:)\s*\d|\b(?:go|no-go|approved|recommended tier)\b.{0,12}\b(?:decision|recommended|verdict)|\bP[1-4]\b.{0,20}\b(?:is|are|will be|recommended)/i.test(sent)) {
        v.push({ rule: 'result_claimed_without_result', excerpt: excerpt(sent, 0, 60) });
      }
      // R5: re-grading the tier ("more like a P3")
      if (f.tier) {
        re = /\b(?:more like|actually|really|should (?:probably )?be|i(?:'d| would) (?:say|call)|treat (?:it )?as|downgrade[d]? to|upgrade[d]? to|reclassif\w+ (?:as|to)|probably)\s+(?:a\s+|an\s+)?(P[1-4])\b/gi;
        while ((m = re.exec(sent)) !== null) { if (m[1].toUpperCase() !== f.tier) v.push({ rule: 'tier_regraded', excerpt: excerpt(sent, m.index, m[0].length) }); }
      }
      // R6: major-incident flag contradicted
      if (typeof f.major === 'boolean') {
        if (f.major === true && /\b(?:not|isn't|is not|no longer)\b[^.]{0,20}\bmajor incident\b/i.test(sent)) v.push({ rule: 'major_flag_contradicted', excerpt: excerpt(sent, 0, 60) });
      }
    });
    return { consistent: v.length === 0, violations: v };
  }

  /* ======================================================================================
   * 3. THE FAILSAFE
   * ==================================================================================== */

  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function byPath(a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; }

  /**
   * Create a failsafe instance.
   * opts = { tool:'rm'|'itsm', audit (AgentAudit log or null), redact:(text)=>text, clock:()=>ms, setTimer, clearTimer,
   *          stateProvider:()=>{confirmed:[{path,value,provenance}], candidates:[{path,value,source}], required:[path]},
   *          thresholds:{consecutive,window_count,window_seconds}, debounce_ms, kv:{get,set} (revocations) }
   */
  function create(opts) {
    var o = opts || {};
    var clock = o.clock || function () { return Date.now(); };
    var setTimer = o.setTimer || function (f, ms) { return root.setTimeout(f, ms); };
    var clearTimer = o.clearTimer || function (h) { root.clearTimeout(h); };
    var redact = typeof o.redact === 'function' ? o.redact : function (x) { return x; };
    var audit = o.audit || null;
    var tool = o.tool || 'unknown';

    /* ---- thresholds (PLACEHOLDERS) ---- */
    var th = { consecutive: 2, window_count: 3, window_seconds: 120 };
    var thStatus = 'placeholder - NOT tuned on real provider failure data (Constraints Section 11)';
    Object.keys(o.thresholds || {}).forEach(function (k) { if (k in th) th[k] = o.thresholds[k]; });

    var mode = 'standard', tripped = null, lastHandoff = null;
    var providers = {};                                  // id -> {consecutive, recent:[{t,kind}], byKind:{}}
    var activeProvider = null;

    function safeAudit(fn) { try { if (audit) fn(audit); } catch (e) { /* the failsafe must never be defeated by a logging problem */ } }

    /* ---------------- thresholds ---------------- */
    /**
     * Change the trip thresholds. Ranges: consecutive 1-10, window_count 2-20, window_seconds 10-3600. `tuning` = {source, by}
     * records WHAT the values were tuned against; without it the thresholds stay labelled as untuned placeholders.
     */
    function configureThresholds(cfg, tuning) {
      var c = cfg || {}, errors = [];
      function int(n, lo, hi) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n && n >= lo && n <= hi; }
      if ('consecutive' in c && !int(c.consecutive, 1, 10)) errors.push('consecutive must be 1-10');
      if ('window_count' in c && !int(c.window_count, 2, 20)) errors.push('window_count must be 2-20');
      if ('window_seconds' in c && !int(c.window_seconds, 10, 3600)) errors.push('window_seconds must be 10-3600');
      if (errors.length) return { ok: false, errors: errors };
      Object.keys(c).forEach(function (k) { th[k] = c[k]; });
      if (tuning && tuning.source && tuning.by) thStatus = 'tuned: ' + String(tuning.source).slice(0, 120) + ' (by ' + String(tuning.by).slice(0, 60) + ')';
      safeAudit(function (a) { a.append('config_changed', 'ok', { setting: 'provider_config', summary: 'failsafe thresholds: consecutive=' + th.consecutive + ', window ' + th.window_count + ' in ' + th.window_seconds + 's; ' + (tuning ? 'tuned' : 'still placeholder'), notice_version: null, acknowledged_by: tuning && tuning.by ? String(tuning.by) : null }); });
      return { ok: true, thresholds: clone(th), thresholds_status: thStatus };
    }

    /* ---------------- hand-off to the standard form ---------------- */
    /**
     * Build the state handed to the deterministic form. DETERMINISTIC (sorted) so an automatic fallback and a manual one given the
     * same data are identical. Only values with provenance 'form' or 'user_confirmed' are carried; everything else becomes an
     * UNCONFIRMED CANDIDATE the user must see and confirm. The decision is never made on the user's behalf: state is 'incomplete'.
     */
    function buildHandoff() {
      var snap = {};
      try { snap = (typeof o.stateProvider === 'function' ? o.stateProvider() : null) || {}; } catch (e) { snap = {}; }
      var confirmed = [], candidates = [];
      (snap.confirmed || []).forEach(function (f) {
        if (f && (f.provenance === 'form' || f.provenance === 'user_confirmed')) confirmed.push({ path: String(f.path), value: f.value, provenance: f.provenance });
        else if (f) candidates.push({ path: String(f.path), value: f.value, source: 'demoted_unconfirmed', state: 'unconfirmed_candidate' });
      });
      (snap.candidates || []).forEach(function (c) { candidates.push({ path: String(c.path), value: c.value, source: c.source || 'agent_suggestion', state: 'unconfirmed_candidate' }); });
      confirmed.sort(byPath); candidates.sort(byPath);
      var have = {}; confirmed.forEach(function (f) { have[f.path] = true; });
      var remaining = (snap.required || []).map(String).filter(function (p) { return !have[p]; }).sort();
      return { mode: 'standard', decision_state: 'incomplete', carried: confirmed, unconfirmed_candidates: candidates, still_to_complete: remaining,
               note: 'Nothing here is a Go, a No-Go or a classification: it is a partly completed form. Unconfirmed suggestions are shown for you to check, never applied.' };
    }

    /* ---------------- user-facing message ---------------- */
    /** The calm message shown at the point of fallback (Sections 17.2, 32.1, 38.1, 40.4). */
    function messageFor(reason) {
      var isNet = reason === 'no_network' || reason === 'unreachable';
      var next = tool === 'rm'
        ? "This release hasn't been marked Go or No-Go. Please complete the remaining fields in the form."
        : 'The severity and the rest of the incident are still yours to set in the form.';
      var m = { headline: "We've switched to Standard Mode.", reason_category: reason, reason: REASONS[reason] || '',
                reassurance: 'Your entries are safe and nothing has been lost. Anything the assistant suggested but you had not confirmed is shown for you to check.',
                next_step: next, help: isNet ? clone(HELP_NETWORK) : null, aria_live: 'assertive' };
      m.announce = [m.headline, m.reason, m.reassurance, m.next_step].filter(Boolean).join(' ');
      return m;
    }

    /* ---------------- entering Standard Mode (the ONE path used by auto and manual) ---------------- */
    function enterStandard(how, reason, kind, providerId) {
      var hand = buildHandoff();
      var carried = hand.carried.length, unresolved = hand.unconfirmed_candidates.length;
      var wasAi = mode === 'ai';
      mode = 'standard'; lastHandoff = hand;
      // how: 'auto' (threshold crossed) | 'admin_revoke' (emergency revoke of the active provider) | 'manual' (Standard Mode button)
      if (how === 'auto' || how === 'admin_revoke') {
        var ps = providers[providerId] || { recent: [] };
        safeAudit(function (a) {
          if (providerId) a.setProvider({ id: providerId, label: providerId, model: null });
          a.logFailsafe(how === 'admin_revoke' ? 'emergency_revoke' : (KINDS[kind] ? KINDS[kind].trigger : 'provider_error'), reason,
                        how === 'admin_revoke' ? 1 : ps.recent.length, th.window_seconds, true, how === 'admin_revoke' ? 'manual' : 'auto');
          a.logModeChange('ai', 'standard', how === 'admin_revoke' ? 'admin_revoke' : 'failsafe', carried, unresolved);
        });
      } else if (wasAi) {
        safeAudit(function (a) { a.logModeChange('ai', 'standard', 'standard_mode_button', carried, unresolved); });
      }
      return hand;
    }

    /** Trip the breaker: disable AI for this session and fall back. Idempotent. */
    function trip(kind, providerId, via) {
      if (tripped) return { tripped: true, already: true, user_message: tripped.user_message, handoff: tripped.handoff, reason_category: tripped.reason_category };
      var reason = kind === 'emergency_revoke' ? 'emergency_revoke' : (KINDS[kind] ? KINDS[kind].reason : 'unavailable');
      var hand = enterStandard(via === 'admin_revoke' ? 'admin_revoke' : 'auto', reason, kind, providerId);
      var msg = messageFor(reason);
      tripped = { kind: kind, reason_category: reason, provider: providerId, at: new Date(clock()).toISOString(), user_message: msg, handoff: hand };
      return { tripped: true, reason_category: reason, user_message: msg, handoff: hand };
    }

    /* ---------------- recording signals ---------------- */
    function pstate(id) { return providers[id] || (providers[id] = { consecutive: 0, recent: [], byKind: {} }); }

    /**
     * Record one provider failure. sig = {providerId, kind, http_status?, message?}.
     * Returns {recorded, tripped, ...trip details}. Counts toward the threshold exactly the same for every kind (a soft-override
     * is not a lesser failure). A fresh failure after a trip is ignored for tripping but still logged for diagnostics.
     */
    function recordFailure(sig) {
      var s = sig || {}, kind = KINDS[s.kind] ? s.kind : 'provider_error', id = String(s.providerId || activeProvider || 'unknown');
      var diag = kind === 'provider_error' ? diagnoseProviderError(s.http_status) : KINDS[kind].diagnosis;
      var msg = redact(String(s.message === undefined || s.message === null ? '' : s.message)).slice(0, 300);   // diagnostic logs are not exempt from the PII filter
      var counted = mode === 'ai';
      safeAudit(function (a) {
        a.setProvider({ id: id, label: id, model: null });
        a.append('provider_failure', 'error', { provider_id: id, kind: kind, diagnosis: diag, http_status: typeof s.http_status === 'number' ? s.http_status : null, message: msg, counted: counted });
      });
      if (!counted) return { recorded: true, tripped: false, ignored: 'not_in_ai_mode' };
      var p = pstate(id), now = clock();
      p.consecutive++; p.byKind[kind] = (p.byKind[kind] || 0) + 1; p.recent.push({ t: now, kind: kind });
      p.recent = p.recent.filter(function (x) { return now - x.t <= th.window_seconds * 1000; });
      var shouldTrip = kind === 'no_network' || p.consecutive >= th.consecutive || p.recent.length >= th.window_count;
      if (!shouldTrip) return { recorded: true, tripped: false, consecutive: p.consecutive, in_window: p.recent.length };
      return Object.assign({ recorded: true }, trip(kind, id, 'auto'));
    }

    /** A provider call completed acceptably: resets the consecutive counter for that provider. */
    function recordSuccess(providerId) { var p = pstate(String(providerId || activeProvider || 'unknown')); p.consecutive = 0; return true; }

    /**
     * Check a narration against the deterministic facts. If inconsistent, the narration must be WITHHELD (show the engine's own
     * output) and the event counts as a soft-override failure. Returns {allowed, withheld, violations, failure?}.
     */
    function reviewNarration(providerId, facts, narration) {
      var r = checkNarration(facts, narration, redact);
      if (r.consistent) return { allowed: true, withheld: false, violations: [] };
      var f = recordFailure({ providerId: providerId, kind: 'soft_override', message: 'narration contradicted result: ' + r.violations.map(function (x) { return x.rule; }).join(',') + ' | ' + r.violations[0].excerpt });
      return { allowed: false, withheld: true, violations: r.violations, failure: f };
    }

    /* ---------------- the AI toggle, Standard Mode, revoke ---------------- */
    var kvGet = (o.kv && o.kv.get) || function (k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } };
    var kvSet = (o.kv && o.kv.set) || function (k, v) { try { root.localStorage.setItem(k, v); return true; } catch (e) { return false; } };
    var REVOKE_KEY = 'agent_revoked_v1';
    function revokedList() { try { var x = JSON.parse(kvGet(REVOKE_KEY) || '[]'); return Array.isArray(x) ? x : []; } catch (e) { return []; } }
    function isRevoked(providerId) { return revokedList().some(function (r) { return r.provider_id === providerId; }); }

    /**
     * Turn the agent layer ON for a provider. Refuses (with a reason) if the provider is revoked, if the device has been
     * offline long enough to be confirmed offline, or if the breaker has tripped this session (use reenableAfterTrip).
     */
    function enable(providerId) {
      var id = String(providerId || 'unknown');
      if (isRevoked(id)) return { ok: false, reason: 'revoked', message: messageFor('emergency_revoke') };
      if (tripped) return { ok: false, reason: 'tripped_this_session', message: tripped.user_message };
      if (net.state === 'offline') return { ok: false, reason: 'no_network', message: messageFor('no_network') };
      var hand = buildHandoff();
      mode = 'ai'; activeProvider = id; lastHandoff = null;
      safeAudit(function (a) { a.setProvider({ id: id, label: id, model: null }); a.logModeChange('standard', 'ai', 'toggle', hand.carried.length, hand.unconfirmed_candidates.length); });
      return { ok: true, mode: 'ai', provider: id };
    }

    /**
     * Standard Mode: ONE call, NO confirmation (the destination is the safe state and nothing is lost). Same hand-off as an
     * automatic fallback given the same data. Idempotent.
     */
    function standardMode() {
      if (mode === 'standard') return { ok: true, already: true, handoff: lastHandoff || buildHandoff(), message: { headline: "You're in Standard Mode.", reassurance: 'Everything you have entered is exactly as you left it.', announce: "You're in Standard Mode. Everything you have entered is exactly as you left it." } };
      var hand = enterStandard('manual', 'manual', 'manual', activeProvider);
      return { ok: true, handoff: hand, message: { headline: "You're in Standard Mode.", reassurance: 'Everything you have entered is exactly as you left it. Anything the assistant suggested but you had not confirmed is shown for you to check.', announce: "You're in Standard Mode. Everything you have entered is exactly as you left it." } };
    }

    /** After an automatic trip, an explicit named "try again" for this session (counters reset; trip history kept in the log). */
    function reenableAfterTrip(by) {
      if (!by || !String(by).trim()) return { ok: false, error: 'by_required' };
      var prov = tripped ? tripped.provider : activeProvider;
      if (prov && isRevoked(prov)) return { ok: false, reason: 'revoked' };
      tripped = null; providers = {};
      safeAudit(function (a) { a.append('config_changed', 'ok', { setting: 'provider_config', summary: 'failsafe cleared for this session by explicit request', notice_version: null, acknowledged_by: String(by) }); });
      return enable(prov || 'unknown');
    }

    /**
     * ADMIN: emergency revoke. Unlike Standard Mode this REQUIRES explicit confirmation (it interrupts active work), and is
     * recorded against a named admin. Persisted in this browser so it survives a reload; if the revoked provider is active the
     * session falls back immediately.
     */
    function emergencyRevoke(args) {
      var a = args || {}, id = String(a.providerId || '');
      if (!id) return { ok: false, error: 'provider_required' };
      if (!a.by || !String(a.by).trim()) return { ok: false, error: 'by_required' };
      if (a.confirmed !== true) return { ok: false, error: 'confirmation_required', warning: 'This will switch the AI assistant off immediately for every session using ' + id + ' on this device. Existing entries are kept.' };
      var list = revokedList().filter(function (r) { return r.provider_id !== id; });
      list.push({ provider_id: id, by: String(a.by), at: new Date(clock()).toISOString() });
      kvSet(REVOKE_KEY, JSON.stringify(list));
      safeAudit(function (au) { au.append('config_changed', 'ok', { setting: 'provider_lock', summary: 'EMERGENCY REVOKE of provider ' + id, notice_version: null, acknowledged_by: String(a.by) }); });
      var result = { ok: true, revoked: id };
      if (mode === 'ai' && activeProvider === id) result.fallback = trip('emergency_revoke', id, 'admin_revoke');
      return result;
    }
    function clearRevoke(args) {
      var a = args || {};
      if (!a.by || !String(a.by).trim() || !a.providerId) return { ok: false, error: 'by_and_provider_required' };
      kvSet(REVOKE_KEY, JSON.stringify(revokedList().filter(function (r) { return r.provider_id !== a.providerId; })));
      safeAudit(function (au) { au.append('config_changed', 'ok', { setting: 'provider_lock', summary: 'revoke cleared for provider ' + a.providerId, notice_version: null, acknowledged_by: String(a.by) }); });
      return { ok: true };
    }

    /** Call BEFORE every provider request. Returns {allow:true} or {allow:false, reason, ...}. */
    function beforeCall(providerId) {
      var id = String(providerId || activeProvider || 'unknown');
      if (isRevoked(id)) { return Object.assign({ allow: false, reason: 'revoked' }, mode === 'ai' ? { fallback: trip('emergency_revoke', id, 'admin_revoke') } : {}); }
      if (mode !== 'ai') return { allow: false, reason: 'standard_mode' };
      if (net.state === 'offline') { var r = recordFailure({ providerId: id, kind: 'no_network', message: 'device offline' }); return { allow: false, reason: 'no_network', fallback: r }; }
      return { allow: true };
    }

    /* ---------------- connectivity (local network state, with debounce) ---------------- */
    var net = { state: 'online', since: null, timer: null, listeners: [], started: false };
    var debounce = typeof o.debounce_ms === 'number' ? o.debounce_ms : 4000;
    function setNet(s) {
      if (net.state === s) return;
      net.state = s; net.since = new Date(clock()).toISOString();
      net.listeners.forEach(function (fn) { try { fn({ state: s, since: net.since, message: s === 'offline' ? OFFLINE_MESSAGE : null }); } catch (e) { /* ignore */ } });
    }
    var OFFLINE_MESSAGE = { headline: "You're offline.", body: 'Your entries are safe. Reconnect to continue using the AI assistant; the rest of the tool keeps working.', aria_live: 'polite' };
    /**
     * Feed browser online/offline signals. The "offline" state is only entered after the device has been OFFLINE FOR `debounce_ms`
     * without recovering (Section 40.5): a momentary blip changes nothing and shows nothing.
     */
    function reportOnline(isOnline) {
      if (isOnline) { if (net.timer !== null) { clearTimer(net.timer); net.timer = null; } setNet('online'); return; }
      if (net.state === 'offline' || net.timer !== null) return;
      net.timer = setTimer(function () { net.timer = null; setNet('offline'); }, debounce);
    }
    /** Attach the browser's own online/offline events (only when the AI layer is actually put to use). */
    function startConnectivity() {
      if (net.started || !root.addEventListener) return false;
      net.started = true;
      root.addEventListener('online', function () { reportOnline(true); });
      root.addEventListener('offline', function () { reportOnline(false); });
      if (root.navigator && root.navigator.onLine === false) reportOnline(false);
      return true;
    }

    /* ---------------- admin diagnostic summary (Section 32.2) ---------------- */
    /**
     * An actual admin-facing summary - not a raw log. Built from the audit trail: per provider, counts by failure kind and by
     * diagnosis (configuration / provider side / guardrails working / network), the number of automatic fallbacks, a PATTERN flag
     * when a provider keeps tripping, a recommended action, and the most recent (PII-redacted) messages. Always states whether
     * the thresholds are still untuned placeholders.
     */
    function diagnosticSummary(range) {
      var days = (range && range.days) || 7, since = clock() - days * DAY_MS;
      var base = { thresholds: clone(th), thresholds_status: thStatus, window_days: days, providers: {}, pattern_flags: [] };
      if (!audit || !audit.status || !audit.status().ready) return Object.assign({ loading: true }, base);
      var fails = audit.entries({ type: 'provider_failure' }), trips = audit.entries({ type: 'failsafe_triggered' });
      function inRange(e) { return Date.parse(e.ts) >= since; }
      function P(id) { return base.providers[id] || (base.providers[id] = { failures: 0, by_kind: {}, by_diagnosis: {}, fallbacks: 0, last_fallback_at: null, recent_messages: [] }); }
      fails.filter(inRange).forEach(function (e) {
        var d = e.detail, p = P(d.provider_id); p.failures++;
        p.by_kind[d.kind] = (p.by_kind[d.kind] || 0) + 1; p.by_diagnosis[d.diagnosis] = (p.by_diagnosis[d.diagnosis] || 0) + 1;
        if (d.message) { p.recent_messages.push({ at: e.ts, kind: d.kind, message: d.message }); if (p.recent_messages.length > 3) p.recent_messages.shift(); }
      });
      trips.filter(inRange).forEach(function (e) { var id = e.provider ? e.provider.id : 'unknown', p = P(id); p.fallbacks++; p.last_fallback_at = e.ts; });
      Object.keys(base.providers).forEach(function (id) {
        var p = base.providers[id], top = null, topN = 0;
        Object.keys(p.by_diagnosis).forEach(function (d) { if (p.by_diagnosis[d] > topN) { top = d; topN = p.by_diagnosis[d]; } });
        p.dominant_diagnosis = top; p.recommended_action = top ? ACTIONS[top] : null;
        p.pattern_flag = p.fallbacks >= 3 || (p.failures >= 6 && p.fallbacks >= 1);
        if (p.pattern_flag) base.pattern_flags.push({ provider_id: id, fallbacks: p.fallbacks, diagnosis: top, action: p.recommended_action });
      });
      return base;
    }

    return Object.freeze({
      version: VERSION, tool: tool,
      enable: enable, standardMode: standardMode, reenableAfterTrip: reenableAfterTrip, beforeCall: beforeCall,
      recordFailure: recordFailure, recordSuccess: recordSuccess, reviewNarration: reviewNarration, checkNarration: function (f, t) { return checkNarration(f, t, redact); },
      emergencyRevoke: emergencyRevoke, clearRevoke: clearRevoke, isRevoked: isRevoked,
      configureThresholds: configureThresholds, thresholds: function () { return { thresholds: clone(th), status: thStatus }; },
      connectivity: { report: reportOnline, start: startConnectivity, state: function () { return net.state; }, since: function () { return net.since; },
                      onChange: function (fn) { if (typeof fn === 'function') net.listeners.push(fn); }, offlineMessage: function () { return clone(OFFLINE_MESSAGE); } },
      diagnosticSummary: diagnosticSummary, messageFor: messageFor, handoffPreview: buildHandoff,
      /** The UI registers how to read the standard form's current state: () => {confirmed:[{path,value,provenance}], candidates:[...], required:[paths]}. */
      setStateProvider: function (fn) { if (typeof fn === 'function') o.stateProvider = fn; return true; },
      state: function () { return { mode: mode, tripped: tripped ? { kind: tripped.kind, reason_category: tripped.reason_category, provider: tripped.provider, at: tripped.at } : null, provider: activeProvider, network: net.state }; }
    });
  }

  var instance = null;
  /** Initialise the default instance (idempotent). Registers no listeners, timers or storage writes. */
  function init(opts) { if (!instance) instance = create(opts); return instance; }

  return Object.freeze({ version: VERSION, create: create, init: init, instance: function () { return instance; }, checkNarration: checkNarration,
                         REASONS: Object.freeze(clone(REASONS)), ACTIONS: Object.freeze(clone(ACTIONS)) });
});
