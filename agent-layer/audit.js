/*!
 * Agent-layer AUDIT TRAIL  (Build Brief Step 4)
 *
 * IDENTICAL COPY in both tool repos; hash-locked by agent-layer/LOCK.sha256. Embedded in the tool HTML after validation.js.
 *
 * ONE log, three purposes (Constraints Section 23.3): the interaction audit trail, the failsafe fallback log (Step 4a) and the
 * personal-data pre-filter decision log all share the envelope defined in audit-schema.json:
 *   timestamp, event type, user, provider, outcome, engine version + fingerprint, session/interaction ids, hash chain.
 *
 * PRINCIPLES
 *   - INERT UNTIL USED: creating/configuring this module writes nothing. The first real event lazily writes a session marker.
 *   - NEVER BREAKS THE CALLER: every public function returns a result object; storage or schema problems degrade the log
 *     (kept in memory and flagged) but never throw into the user's flow.
 *   - COMPLETE: each step of an interaction (input -> agent output -> validation -> engine run -> display) and each error has
 *     an event, linked by interaction_id.
 *   - DATA MINIMISATION: text the personal-data filter BLOCKED is stored only in redacted form. Nothing is transmitted anywhere.
 *   - TAMPER-EVIDENT, NOT TAMPER-PROOF: a SHA-256 chain detects accidental or casual alteration of data held in the user's own
 *     browser. Redaction (erasure requests) re-seals the chain and records that it did so.
 *   - RETENTION IS COMPUTED FROM THE ORIGINAL TIMESTAMP, so redaction can never reset the clock (Constraints Section 40.3).
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.AgentAudit = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The global object (window in the browser, globalThis in Node). Resolved here because the UMD wrapper's `root` is not in scope.
  var root = (typeof self !== 'undefined') ? self : (typeof globalThis !== 'undefined' ? globalThis : {});

  var VERSION = '0.4.0-step4';
  var SCHEMA_ID = 'audit/v1';
  var GENESIS = 'GENESIS';
  var DAY_MS = 86400000;

  /* ======================================================================================
   * 1. SMALL UTILITIES: SHA-256, canonical JSON, redaction of spans
   * ==================================================================================== */

  var K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  /** UTF-8 encode a JS string to a byte array (own implementation so no TextEncoder is required). Lone surrogates become U+FFFD. */
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length && (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { c = 0x10000 + ((c & 0x3ff) << 10) + (str.charCodeAt(++i) & 0x3ff); }
      else if (c >= 0xd800 && c <= 0xdfff) { c = 0xfffd; }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  /** SHA-256 of a string, returned as lowercase hex. Verified against Node's crypto in the test-suite. */
  function sha256Hex(str) {
    var bytes = utf8Bytes(String(str)), l = bytes.length, i, j;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var bitHi = Math.floor((l * 8) / 4294967296), bitLo = (l * 8) >>> 0;
    bytes.push((bitHi >>> 24) & 255, (bitHi >>> 16) & 255, (bitHi >>> 8) & 255, bitHi & 255, (bitLo >>> 24) & 255, (bitLo >>> 16) & 255, (bitLo >>> 8) & 255, bitLo & 255);
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19], w = new Array(64);
    function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
    for (i = 0; i < bytes.length; i += 64) {
      for (j = 0; j < 16; j++) w[j] = (bytes[i + 4 * j] << 24) | (bytes[i + 4 * j + 1] << 16) | (bytes[i + 4 * j + 2] << 8) | bytes[i + 4 * j + 3];
      for (j = 16; j < 64; j++) {
        var s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3), s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
        w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (j = 0; j < 64; j++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), ch = (e & f) ^ (~e & g), t1 = (h + S1 + ch + K256[j] + w[j]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22), maj = (a & b) ^ (a & c) ^ (b & c), t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map(function (x) { return ('00000000' + (x >>> 0).toString(16)).slice(-8); }).join('');
  }

  /** Canonical JSON: object keys sorted, RegExp/function rendered as strings, undefined dropped. Same input -> same bytes. */
  function canon(v) {
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'function' || v instanceof RegExp) return JSON.stringify(String(v));
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (typeof v === 'object') {
      return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; }).map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
    }
    return 'null';
  }

  /** Replace [start,end) spans of `text` with [REDACTED:category] tokens (spans carry no content of their own). */
  function redactSpans(text, spans) {
    var out = '', pos = 0;
    spans.slice().sort(function (a, b) { return a.start - b.start; }).forEach(function (s) {
      if (s.start < pos) return;
      out += text.slice(pos, s.start) + '[REDACTED:' + s.category + ']';
      pos = s.end;
    });
    return out + text.slice(pos);
  }

  function randomId(prefix) { return prefix + Math.floor(Math.random() * 0xffffffff).toString(36) + Math.floor(Math.random() * 0xffffffff).toString(36); }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  /* ======================================================================================
   * 2. STORAGE ADAPTERS (localStorage in the browser, memory in tests). No probing writes.
   * ==================================================================================== */

  /** In-memory adapter. `failWrites` lets tests simulate a full or unavailable store. */
  function memoryStorage() {
    var m = {};
    return {
      kind: 'memory', failWrites: false,
      get: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      set: function (k, v) { if (this.failWrites) { var e = new Error('simulated quota'); e.name = 'QuotaExceededError'; throw e; } m[k] = String(v); },
      remove: function (k) { delete m[k]; },
      _dump: function () { return m; }
    };
  }

  /** Is window.localStorage reachable? Merely touching it can throw when storage is blocked, so the check itself is guarded. */
  function hasLocalStorage() {
    try { return typeof root.localStorage !== 'undefined' && root.localStorage !== null; } catch (e) { return false; }
  }

  /**
   * localStorage adapter - the FALLBACK store. localStorage is a small (~5 MB) pool SHARED with the tool's own saved data, so
   * this adapter carries a HARD CAP (`hardCap` bytes, default 1 MB): the log never grows past it, protecting the tool's own
   * persistence. Every call is individually guarded; construction itself touches nothing.
   */
  function localStorageAdapter(hardCap) {
    function ls() { return root.localStorage; }
    return {
      kind: 'localStorage', hardCap: hardCap || 1000000,
      get: function (k) { return ls().getItem(k); },
      set: function (k, v) { ls().setItem(k, v); },
      remove: function (k) { ls().removeItem(k); }
    };
  }

  /** Is indexedDB reachable? Guarded because merely touching it can throw when storage is blocked. */
  function hasIndexedDb() {
    try { return typeof root.indexedDB !== 'undefined' && root.indexedDB !== null; } catch (e) { return false; }
  }

  /**
   * IndexedDB adapter - the PRIMARY store. Its quota is separate from (and far larger than) localStorage, so a growing audit
   * log can never crowd out the tool's own saved data.
   *
   * Because IndexedDB is asynchronous, the adapter keeps an in-memory MIRROR of every key: reads are synchronous against the
   * mirror, writes update the mirror immediately and are flushed to the database in batches ("write-behind"). `open()` loads the
   * mirror once (lazily - nothing is created or opened until the log is first used). A failed flush keeps the batch and reports
   * through `onError`; the next flush retries and reports `onRecovered`.
   * `factory` is an IDBFactory (window.indexedDB, or a test double).
   */
  function indexedDbAdapter(dbName, factory) {
    var db = null, mirror = {}, ops = [], scheduled = false, ready = false, inflight = Promise.resolve(), failing = false;
    var self = {
      kind: 'indexedDB', async: true, onError: null, onRecovered: null,
      isReady: function () { return ready; },
      get: function (k) { return Object.prototype.hasOwnProperty.call(mirror, k) ? mirror[k] : null; },
      set: function (k, v) { mirror[k] = String(v); ops.push(['put', k, String(v)]); schedule(); },
      remove: function (k) { delete mirror[k]; ops.push(['del', k]); schedule(); },
      /** Open (creating if needed) and load every key into the mirror. Rejects on any failure so the caller can fall back. */
      open: function () {
        return new Promise(function (resolve, reject) {
          var req;
          try { req = factory.open(dbName, 1); } catch (e) { reject(e); return; }
          req.onupgradeneeded = function () { try { req.result.createObjectStore('kv'); } catch (e) { /* exists */ } };
          req.onerror = function () { reject(req.error || new Error('indexedDB open failed')); };
          req.onblocked = function () { reject(new Error('indexedDB open blocked')); };
          req.onsuccess = function () {
            db = req.result;
            try {
              var tx = db.transaction('kv', 'readonly'), st = tx.objectStore('kv'), rk = st.getAllKeys(), rv = st.getAll();
              tx.oncomplete = function () { rk.result.forEach(function (k, i) { mirror[k] = rv.result[i]; }); ready = true; resolve(); };
              tx.onerror = tx.onabort = function () { reject(tx.error || new Error('indexedDB read failed')); };
            } catch (e) { reject(e); }
          };
        });
      },
      /** Resolve when every queued write has been attempted. Never rejects (failures go through onError). */
      flush: function () { schedule(); return inflight; }
    };
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      inflight = inflight.then(function () { scheduled = false; return runBatch(); });
    }
    /** Write the queued operations in ONE transaction. On failure the batch is put back and onError is called. */
    function runBatch() {
      if (!ops.length || !db) return Promise.resolve();
      var batch = ops.splice(0, ops.length);
      return new Promise(function (resolve) {
        function fail(err) {
          ops = batch.concat(ops); failing = true;
          if (self.onError) { try { self.onError(err); } catch (e) { /* ignore */ } }
          resolve();
        }
        try {
          var tx = db.transaction('kv', 'readwrite'), st = tx.objectStore('kv');
          batch.forEach(function (op) { if (op[0] === 'put') st.put(op[2], op[1]); else st.delete(op[1]); });
          tx.oncomplete = function () { if (failing) { failing = false; if (self.onRecovered) { try { self.onRecovered(); } catch (e) { /* ignore */ } } } resolve(); };
          tx.onerror = tx.onabort = function () { fail(tx.error || new Error('indexedDB write failed')); };
        } catch (e) { fail(e); }
      });
    }
    return self;
  }

  /* ======================================================================================
   * 3. THE LOG
   * ==================================================================================== */

  var REDACTABLE = {
    input_received: ['text'], clarification_asked: ['text'], clarification_answered: ['text'],
    agent_output_received: ['fields[].value'], engine_run: ['engine_input', 'raw_output'], display_rendered: ['text'], error: ['message']
  };

  /**
   * Create an audit log instance.
   * opts = { tool, toolVersion, engineVersion, engineSources:()=>any[], schema, validate(doc,def,inst)->errors[], storage,
   *          clock:()=>ms, prefix, exportHints, deployedTag, retention_days, warn_lead_days, limit_bytes, warn_pct, maxTextChars }
   * Returns the public API. Throws only for an unusable configuration (missing schema/validate) - a programming error.
   */
  function create(opts) {
    if (!opts || !opts.schema || typeof opts.validate !== 'function') throw new Error('AgentAudit.create: schema and validate are required');
    var o = opts, prefix = o.prefix || 'agent_audit_v1', clock = o.clock || function () { return Date.now(); };
    /* Storage choice: an explicit adapter wins; otherwise IndexedDB (primary, isolated from the tool's own data), then a CAPPED
       localStorage, then memory. Nothing is opened or written until the log is first used. */
    var store = (o.storage && typeof o.storage === 'object') ? o.storage
      : (hasIndexedDb() && o.storage !== 'localStorage' && o.storage !== 'memory') ? indexedDbAdapter(prefix, root.indexedDB)
      : (hasLocalStorage() && o.storage !== 'memory') ? localStorageAdapter(o.local_cap_bytes) : memoryStorage();
    var MAXTXT = o.maxTextChars || 4000;

    var sessionId = randomId('s'), interactionId = null, actor = null, provider = null;
    var started = false, loaded = false, degraded = null, pending = {};
    var cache = [];                       // all entries currently held (seq order)
    var meta = null;
    var storeReady = !store.async, openStarted = false, opQueue = [], fellBackFrom = null, readyResolvers = [];

    /* ---------------- persistence helpers ---------------- */
    function defaultLimit() { return store.kind === 'indexedDB' ? 52428800 : store.kind === 'localStorage' ? (store.hardCap || 1000000) : 5000000; }
    function defaultMeta() {
      return { store_version: 1, created: new Date(clock()).toISOString(), next_seq: 1, last_hash: GENESIS,
               anchor: { through_seq: 0, through_hash: GENESIS }, first_seq: 1, last_fingerprint: null,
               retention_days: o.retention_days || 365, warn_lead_days: o.warn_lead_days || 30,
               limit_bytes: o.limit_bytes || defaultLimit(), warn_pct: o.warn_pct || 80, bytes: 0, overflow: null };
    }

    /* ---------------- asynchronous store readiness ---------------- */
    /** Called by an async adapter when a background write fails: degrade (entries stay in memory) and keep going. */
    function onStoreError(e) {
      degraded = degraded || { reason: (e && /quota/i.test(String(e.name) + String(e.message))) ? 'quota_exceeded' : 'storage_unavailable', since: new Date(clock()).toISOString() };
    }
    /** Called when a previously failing async store accepts writes again. */
    function onStoreRecovered() { if (!Object.keys(pending).length && !(degraded && degraded.reason === 'limit_reached')) degraded = null; }
    /** Replay everything that was queued while the store was opening, in order, then release anyone awaiting ready(). */
    function finishOpen() {
      storeReady = true;
      var q = opQueue; opQueue = [];
      q.forEach(function (f) { try { f(); } catch (e) { /* a queued event must never break the others */ } });
      var r = readyResolvers; readyResolvers = [];
      r.forEach(function (res) { res(true); });
    }
    /**
     * Open an asynchronous store once (lazily). If it cannot be opened - private mode, blocked, or an error - fall back to a
     * CAPPED localStorage (then memory) and note why, so the log keeps working with a smaller footprint.
     */
    function openStore() {
      if (storeReady || openStarted) return;
      openStarted = true;
      store.onError = onStoreError; store.onRecovered = onStoreRecovered;
      store.open().then(finishOpen, function (err) {
        fellBackFrom = { kind: store.kind, reason: String(err && err.message ? err.message : err).slice(0, 120) };
        store = hasLocalStorage() ? localStorageAdapter(o.local_cap_bytes) : memoryStorage();
        finishOpen();
      });
    }
    /** Run `fn` now if the store is ready; otherwise queue it (in order) and open the store. Used for event logging. */
    function queued(fn) {
      return function () {
        if (storeReady) return fn.apply(null, arguments);
        var args = arguments; openStore();
        opQueue.push(function () { fn.apply(null, args); });
        return { ok: true, queued: true };
      };
    }
    /** For calls that must return a real answer (admin actions, reads): before the store is ready, say so instead of guessing. */
    function needsReady(fn, notReadyValue) {
      return function () {
        if (storeReady) return fn.apply(null, arguments);
        // Reading never opens (or creates) the database: only a real write, or an explicit ready(), does.
        return typeof notReadyValue === 'function' ? notReadyValue() : notReadyValue;
      };
    }
    /** Promise that resolves once the store is open and queued events have been written. Opens the store if needed. */
    function whenReady() {
      if (storeReady) return Promise.resolve(true);
      openStore();
      return new Promise(function (res) { readyResolvers.push(res); });
    }
    function ekey(seq) { return prefix + ':e:' + seq; }
    function mkey() { return prefix + ':meta'; }

    /** Write one key; on failure remember it for retry and mark the log degraded (never throws). */
    function persist(key, val) {
      try { store.set(key, val); delete pending[key]; return true; }
      catch (e) {
        pending[key] = val;
        degraded = degraded || { reason: (e && /quota/i.test(e.name + e.message)) ? 'quota_exceeded' : 'storage_unavailable', since: new Date(clock()).toISOString() };
        return false;
      }
    }
    /** Retry writes that previously failed. Clears the degraded flag when everything is stored. */
    function flushPending() {
      var keys = Object.keys(pending);
      for (var i = 0; i < keys.length; i++) { if (!persist(keys[i], pending[keys[i]])) return false; }
      if (!Object.keys(pending).length) degraded = null;
      return true;
    }
    /** Load meta + entries from storage once. A missing/corrupt meta starts a fresh store (and is reported by verify()). */
    function ensureLoaded() {
      if (loaded) return;
      loaded = true;
      var raw = null;
      try { raw = store.get(mkey()); } catch (e) { degraded = degraded || { reason: 'storage_unavailable', since: new Date(clock()).toISOString() }; }
      try { meta = raw ? JSON.parse(raw) : defaultMeta(); } catch (e) { meta = defaultMeta(); }
      if (!raw) return;
      for (var s = meta.first_seq; s < meta.next_seq; s++) {
        try { var r = store.get(ekey(s)); if (r) cache.push(JSON.parse(r)); } catch (e) { /* gap is reported by verify() */ }
      }
    }
    /* Hard-cap handling (fallback localStorage only). Once the cap is hit the log STOPS persisting entries - protecting the
       tool's own saved data - and keeps new entries in memory for this session. The persisted meta stays at the last
       persisted entry (so the chain is still consistent after a reload) plus an overflow count that the next session reports. */
    var persistFrozen = false, frozenSnapshot = null, overflowCount = 0;
    function saveMeta() {
      var m = meta;
      if (persistFrozen) {
        m = Object.assign({}, frozenSnapshot, { overflow: { count: overflowCount } });
        ['retention_days', 'warn_lead_days', 'limit_bytes', 'warn_pct', 'last_fingerprint'].forEach(function (k) { m[k] = meta[k]; });
      }
      persist(mkey(), JSON.stringify(m));
    }

    /* ---------------- hashing ---------------- */
    function entryHash(e) { var c = clone(e); delete c.hash; return sha256Hex(canon(c)); }

    /* ---------------- writing ---------------- */
    function sanitiseText(s) {
      s = (s === null || s === undefined) ? '' : String(s);
      return s.length > MAXTXT ? { v: s.slice(0, MAXTXT) + ' [TRUNCATED]', truncated: true } : { v: s, truncated: false };
    }

    /**
     * Core writer. Builds the envelope, validates against the schema, chains the hash, persists. Returns
     * {ok:true, entry} or {ok:false, error}. Never throws. `internal` skips lazy-start (used by the starter itself).
     */
    function write(type, outcome, detail, internal) {
      try {
        ensureLoaded();
        if (!internal && !started) startSession();
        var now = new Date(clock()).toISOString();
        var entry = {
          schema: SCHEMA_ID, id: randomId('a'), seq: meta.next_seq, ts: now, type: type,
          tool: String(o.tool || 'unknown'), tool_version: String(o.toolVersion || 'unknown'),
          engine_version: String(o.engineVersion || 'unknown'), engine_fingerprint: currentFingerprint(),
          session_id: sessionId, interaction_id: interactionId, user: actor, provider: provider ? clone(provider) : null,
          outcome: outcome, detail: detail, redaction: null, prev_hash: meta.last_hash, hash: ''
        };
        entry.hash = entryHash(entry);                       // hash first: the schema requires a non-empty hash
        var errs = o.validate(o.schema, 'ev_' + type, entry);
        if (errs.length) return { ok: false, error: 'schema_invalid:' + type };
        var json = JSON.stringify(entry), size = json.length + ekey(entry.seq).length;
        if (persistFrozen || (store.hardCap && meta.bytes + size > store.hardCap)) {
          // Cap reached: keep this entry in memory only (see "Hard-cap handling"), flag it, tell the user to export.
          if (!persistFrozen) { persistFrozen = true; frozenSnapshot = clone(meta); }
          overflowCount++;
          degraded = degraded && degraded.reason === 'limit_reached' ? degraded : { reason: 'limit_reached', since: new Date(clock()).toISOString() };
          cache.push(entry);
          meta.next_seq = entry.seq + 1; meta.last_hash = entry.hash; meta.bytes += size;
          saveMeta();
          return { ok: true, entry: clone(entry), persisted: false };
        }
        flushPending();
        persist(ekey(entry.seq), json);
        cache.push(entry);
        meta.next_seq = entry.seq + 1; meta.last_hash = entry.hash; meta.bytes += size;
        saveMeta();
        if (degraded) { /* surfaced through status(); one marker event is written once storage recovers */ }
        return { ok: true, entry: clone(entry) };
      } catch (e) {
        degraded = degraded || { reason: 'serialisation_failed', since: new Date(clock()).toISOString() };
        return { ok: false, error: 'exception:' + (e && e.message ? String(e.message).slice(0, 80) : 'unknown') };
      }
    }

    /** First event after load: session marker, and an engine_changed marker when the rule tables/logic differ from last use. */
    function startSession() {
      started = true;
      write('session_started', 'n_a', { reason: 'first_event_after_load' }, true);
      if (meta.overflow && meta.overflow.count) {   // a previous session hit the storage cap and could not persist some entries
        write('audit_degraded', 'error', { reason: 'limit_reached', buffered: meta.overflow.count }, true);
        meta.overflow = null; saveMeta();
      }
      var fp = currentFingerprint();
      if (fp && meta.last_fingerprint !== fp) {
        write('engine_changed', 'n_a', { previous_fingerprint: meta.last_fingerprint, current_fingerprint: fp, label: String(o.engineVersion || 'unknown') }, true);
        meta.last_fingerprint = fp; saveMeta();
      }
    }

    /** Fingerprint of the deterministic rule tables + logic (sha256 of canonical JSON / function source), first 16 hex chars. */
    var fpCache; var fpAt = 0;
    function currentFingerprint() {
      if (typeof o.engineSources !== 'function') return null;
      if (fpCache !== undefined && clock() - fpAt < 60000) return fpCache;
      try { fpCache = sha256Hex(canon(o.engineSources())).slice(0, 16); } catch (e) { fpCache = null; }
      fpAt = clock();
      return fpCache;
    }

    /** Public append for any event type. Returns {ok, entry|error}. */
    function append(type, outcome, detail) {
      var r = write(type, outcome, detail, false);
      if (!r.ok && type !== 'error') write('error', 'error', { stage: 'audit', code: 'entry_rejected', message: String(r.error).slice(0, 200) }, false);
      return r;
    }

    /* ---------------- convenience loggers for the chain ---------------- */

    /**
     * Log the user's raw input. Text the pre-filter BLOCKED is stored in redacted form only (data minimisation);
     * `pf` is the AgentLayer.prefilter.check() result. Over-long text is truncated and marked.
     */
    function logInput(rawText, pf) {
      var text = String(rawText === null || rawText === undefined ? '' : rawText), blocked = !!(pf && pf.decision === 'block');
      var cats = pf && pf.pii ? Object.keys(pf.pii.byCategory || {}) : [];
      var stored = blocked && pf.pii && pf.pii.findings ? redactSpans(text, pf.pii.findings) : text;
      var t = sanitiseText(stored);
      return append('input_received', blocked ? 'blocked' : 'ok', {
        text: t.v, text_hash: sha256Hex(text).slice(0, 16), text_state: blocked ? 'redacted' : 'as_entered',
        pii_categories: cats, payment_flagged: !!(pf && pf.payment && pf.payment.flagged), truncated: t.truncated });
    }
    function logAgentOutput(fields) {
      return append('agent_output_received', 'ok', { fields: (fields || []).map(function (f) {
        return { path: String(f.path), state: f.state === 'resolved' ? 'resolved' : 'unresolved',
                 value: f.value === undefined || f.value === null ? null : sanitiseText(typeof f.value === 'string' ? f.value : JSON.stringify(f.value)).v,
                 provenance: f.provenance || null, reason: f.reason || null }; }) });
    }
    function logEngineRun(engine, rulesFired, engineInput, rawOutput) {
      return append('engine_run', 'ok', { engine: String(engine), rules_fired: (rulesFired || []).map(String),
        engine_input: sanitiseText(typeof engineInput === 'string' ? engineInput : JSON.stringify(engineInput)).v,
        raw_output: sanitiseText(typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput)).v });
    }
    function logDisplay(panel, text, matchesEngineOutput) {
      return append('display_rendered', matchesEngineOutput === false ? 'error' : 'ok', { panel: panel, text: sanitiseText(text).v,
        matches_engine_output: matchesEngineOutput === undefined ? null : matchesEngineOutput });
    }
    function logProviderCall(providerId, model, purpose, durationMs, result) {
      return append('provider_call', result === 'ok' ? 'ok' : 'error', { provider_id: String(providerId), model: model || null, purpose: purpose,
        duration_ms: durationMs === undefined ? null : durationMs, result: result });
    }
    function logModeChange(from, to, via, carried, unresolved) {
      return append('mode_changed', via === 'failsafe' ? 'fallback' : 'ok', { from_mode: from, to_mode: to, via: via,
        carried_over_fields: carried || 0, unresolved_candidates: unresolved || 0 });
    }
    function logFailsafe(trigger, reasonCategory, count, windowSeconds, statePreserved, source) {
      return append('failsafe_triggered', 'fallback', { trigger: trigger, reason_category: reasonCategory, count: count, window_seconds: windowSeconds,
        state_preserved: !!statePreserved, source: source || 'auto' });
    }
    function logError(stage, code, message) {
      return append('error', 'error', { stage: stage, code: String(code), message: sanitiseText(message).v });
    }

    /* ---------------- sessions / context ---------------- */
    function beginInteraction() { interactionId = randomId('ix'); return interactionId; }
    function endInteraction() { interactionId = null; }
    function setActor(label) { actor = label ? String(label).slice(0, 80) : null; return true; }
    function setProvider(p) { provider = p ? { id: String(p.id), label: String(p.label || p.id), model: p.model ? String(p.model) : null } : null; return true; }

    /* ======================================================================================
     * 4. VERIFY / READ / EXPORT
     * ==================================================================================== */

    /** Recompute the whole chain. Returns {ok, checked, problems:[{seq,problem}]}. Never throws. */
    function verify() {
      ensureLoaded();
      var problems = [], prev = meta.anchor.through_hash, expectSeq = meta.first_seq;
      cache.forEach(function (e) {
        if (e.seq !== expectSeq) problems.push({ seq: e.seq, problem: 'sequence_gap_or_duplicate (expected ' + expectSeq + ')' });
        expectSeq = e.seq + 1;
        if (e.prev_hash !== prev) problems.push({ seq: e.seq, problem: 'chain_link_broken' });
        if (entryHash(e) !== e.hash) problems.push({ seq: e.seq, problem: 'entry_altered' });
        var errs = o.validate(o.schema, 'ev_' + e.type, e);
        if (errs.length) problems.push({ seq: e.seq, problem: 'schema_invalid' });
        prev = e.hash;
      });
      if (cache.length && prev !== meta.last_hash) problems.push({ seq: null, problem: 'tail_hash_mismatch' });
      if (!cache.length && meta.next_seq !== meta.first_seq) problems.push({ seq: null, problem: 'entries_missing' });
      return { ok: problems.length === 0, checked: cache.length, problems: problems };
    }

    /** Read-only copies of entries, optionally filtered by {type, from_seq}. */
    function entries(filter) {
      ensureLoaded();
      return clone(cache.filter(function (e) { return (!filter || ((!filter.type || e.type === filter.type) && (!filter.from_seq || e.seq >= filter.from_seq))); }));
    }

    /**
     * Export everything as ONE continuous, correctly ordered record (never fragmented by toggle state - Section 28.2),
     * with chain verification and a degraded-state flag. Records the export itself as a retention_action.
     */
    function exportAll(by) {
      ensureLoaded();
      var v = verify(), snapshot = clone(cache);
      var out = { format: 'agent-audit-export/v1', exported_at: new Date(clock()).toISOString(), tool: o.tool, tool_version: o.toolVersion,
                  engine_version: o.engineVersion, anchor: clone(meta.anchor), chain: v, degraded: degraded ? clone(degraded) : null, entries: snapshot };
      append('retention_action', 'ok', { action: 'export', count: snapshot.length, by: String(by || 'unknown'), reason: null, target_id: null });
      return out;
    }

    /* ======================================================================================
     * 5. RETENTION, STORAGE PROMPTS, REDACTION
     * ==================================================================================== */

    function expiresAt(e) { return Date.parse(e.ts) + meta.retention_days * DAY_MS; }  // computed from ts ONLY

    /**
     * Configure retention. retention_days 30..3650, warn_lead_days 1..365 (independent of retention - Section 40.6),
     * limit_bytes 100k..4.5M. Returns {ok} or {ok:false, errors}. Logged as config.
     */
    function configureRetention(cfg, by) {
      ensureLoaded();
      var errors = [], c = cfg || {};
      if (c.retention_days !== undefined && !(isInt(c.retention_days) && c.retention_days >= 30 && c.retention_days <= 3650)) errors.push('retention_days must be 30-3650');
      if (c.warn_lead_days !== undefined && !(isInt(c.warn_lead_days) && c.warn_lead_days >= 1 && c.warn_lead_days <= 365)) errors.push('warn_lead_days must be 1-365');
      var maxLimit = store.kind === 'localStorage' ? 2000000 : 2000000000;   // localStorage is shared with the tool's own data: keep it small
      if (c.limit_bytes !== undefined && !(isInt(c.limit_bytes) && c.limit_bytes >= 100000 && c.limit_bytes <= maxLimit)) errors.push('limit_bytes must be 100000-' + maxLimit + ' for ' + store.kind + ' storage');
      if (!by || !String(by).trim()) errors.push('"by" (who is changing this) is required');
      if (errors.length) return { ok: false, errors: errors };
      ['retention_days', 'warn_lead_days', 'limit_bytes'].forEach(function (k) { if (c[k] !== undefined) meta[k] = c[k]; });
      saveMeta();
      append('config_changed', 'ok', { setting: 'retention', summary: 'retention ' + meta.retention_days + 'd; warn ' + meta.warn_lead_days + 'd; limit ' + meta.limit_bytes + 'B', notice_version: null, acknowledged_by: String(by) });
      return { ok: true };
    }
    function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }

    /**
     * Retention + storage status and (at most one) calm prompt for the user/admin, with enough lead time to act.
     * Pure read: it does not log. Prompt levels: info < attention < urgent. Messages point at the existing export paths and
     * remind that retention should follow the organisation's own records-management policy.
     */
    function retentionStatus() {
      ensureLoaded();
      var now = clock(), expired = 0, soon = 0, oldest = null;
      cache.forEach(function (e) {
        var x = expiresAt(e);
        if (oldest === null || x < oldest) oldest = x;
        if (x <= now) expired++; else if (x - now <= meta.warn_lead_days * DAY_MS) soon++;
      });
      var pct = Math.round((meta.bytes / meta.limit_bytes) * 100);
      var hint = o.exportHints ? ' You can export first (' + o.exportHints + ', or the audit export).' : ' You can export first using the audit export.';
      var tail = " Please keep your organisation's own records-management policy in mind when deciding what to keep.";
      var prompt = null;
      if (degraded && degraded.reason === 'limit_reached') prompt = { level: 'urgent', code: 'audit_limit_reached', message: "The audit log has reached the size this browser can safely hold alongside your saved tool data, so new entries are being kept for this session only. Please export now so nothing is lost, then clear out old entries." + hint + tail };
      else if (degraded) prompt = { level: 'urgent', code: 'audit_degraded', message: "The audit log couldn't be saved to this browser (" + degraded.reason.replace(/_/g, ' ') + "). Entries are being kept for this session only - export now so nothing is lost." + hint };
      else if (expired > 0) prompt = { level: 'urgent', code: 'retention_expired', message: expired + ' audit ' + (expired === 1 ? 'entry is' : 'entries are') + ' past the ' + meta.retention_days + '-day retention period.' + hint + tail };
      else if (pct >= 100) prompt = { level: 'urgent', code: 'storage_full', message: 'The audit log has reached its storage limit (' + pct + '%). Nothing has been lost, but please export and clear out old entries soon.' + hint + tail };
      else if (soon > 0) prompt = { level: 'attention', code: 'retention_expiring', message: soon + ' audit ' + (soon === 1 ? 'entry reaches' : 'entries reach') + ' the ' + meta.retention_days + '-day retention period within ' + meta.warn_lead_days + ' days.' + hint + tail };
      else if (pct >= meta.warn_pct) prompt = { level: 'attention', code: 'storage_near_limit', message: 'The audit log is ' + pct + '% of its storage limit.' + hint + tail };
      return { retention_days: meta.retention_days, warn_lead_days: meta.warn_lead_days, entries: cache.length, expired: expired, expiring_within_lead: soon,
               oldest_expires_at: oldest === null ? null : new Date(oldest).toISOString(), storage: { bytes: meta.bytes, limit: meta.limit_bytes, pct: pct },
               degraded: degraded ? clone(degraded) : null, prompt: prompt };
    }

    /** Record that a prompt was shown to the user (so the trail shows the warning was given). */
    function markPromptShown(code, by) {
      return append('retention_action', 'ok', { action: 'warning_shown', count: 1, by: String(by || 'system'), reason: String(code), target_id: null });
    }

    /**
     * Explicitly remove entries past retention (oldest contiguous run only). Never automatic. Leaves a chain anchor so the
     * remaining entries still verify, and logs the purge (count only, no content). Returns {ok, removed}.
     */
    function purgeExpired(by) {
      ensureLoaded();
      if (!by || !String(by).trim()) return { ok: false, error: 'by_required' };
      if (persistFrozen) return { ok: false, error: 'reload_required_after_limit' };
      var now = clock(), n = 0;
      while (n < cache.length && expiresAt(cache[n]) <= now) n++;
      if (!n) return { ok: true, removed: 0 };
      var removed = cache.splice(0, n), last = removed[removed.length - 1];
      removed.forEach(function (e) { try { store.remove(ekey(e.seq)); } catch (er) { /* orphan key is harmless; first_seq excludes it */ } delete pending[ekey(e.seq)]; meta.bytes -= JSON.stringify(e).length + ekey(e.seq).length; });
      meta.anchor = { through_seq: last.seq, through_hash: last.hash }; meta.first_seq = last.seq + 1;
      saveMeta();
      append('retention_action', 'ok', { action: 'purge_expired', count: n, by: String(by), reason: null, target_id: null });
      return { ok: true, removed: n };
    }

    /** Which (flattened) fields of an entry are redactable for erasure requests. */
    function redactableFields(type) { return (REDACTABLE[type] || []).slice(); }

    /**
     * Erasure request: replace personal-data-bearing fields of ONE entry with [REDACTED], keep the structural record
     * (timestamp, type, outcome, engine version, ...). Retention is NOT reset (it derives from the original ts). The hash chain
     * is re-sealed from this entry forward and the action is logged. `by` and `reason` are mandatory.
     */
    function redactEntry(id, by, reason, fields) {
      ensureLoaded();
      if (!by || !String(by).trim() || !reason || !String(reason).trim()) return { ok: false, error: 'by_and_reason_required' };
      if (persistFrozen) return { ok: false, error: 'reload_required_after_limit' };
      var idx = -1; cache.forEach(function (e, i) { if (e.id === id) idx = i; });
      if (idx < 0) return { ok: false, error: 'entry_not_found' };
      var e = cache[idx], allowed = redactableFields(e.type), todo = (fields && fields.length) ? fields : allowed;
      if (!allowed.length) return { ok: false, error: 'nothing_redactable_for_type' };
      var bad = todo.filter(function (f) { return allowed.indexOf(f) < 0; });
      if (bad.length) return { ok: false, error: 'field_not_redactable:' + bad[0] };
      todo.forEach(function (f) {
        if (f === 'fields[].value') { e.detail.fields.forEach(function (x) { if (x.value !== null) x.value = '[REDACTED]'; }); }
        else { e.detail[f] = '[REDACTED]'; }
      });
      e.redaction = { at: new Date(clock()).toISOString(), by: String(by), reason: String(reason), fields: todo.slice() };
      // re-seal: this entry and everything after it (chain links change, content of later entries does not)
      var prev = idx === 0 ? meta.anchor.through_hash : cache[idx - 1].hash;
      for (var i = idx; i < cache.length; i++) {
        cache[i].prev_hash = prev; cache[i].hash = entryHash(cache[i]); prev = cache[i].hash;
        var js = JSON.stringify(cache[i]); persist(ekey(cache[i].seq), js);
      }
      meta.last_hash = prev; saveMeta();
      append('retention_action', 'ok', { action: 'redact', count: 1, by: String(by), reason: String(reason), target_id: id });
      return { ok: true, resealed_from_seq: e.seq };
    }

    /* ======================================================================================
     * 6. USAGE VIEW + DIAGNOSTICS (no new tracking: derived from logged provider_call events)
     * ==================================================================================== */

    /** Provider call counts from existing provider_call entries: {provider_id: {calls, ok, failed, by_purpose}}. */
    function usageSummary(range) {
      ensureLoaded();
      var out = {}, from = range && range.from ? Date.parse(range.from) : -Infinity, to = range && range.to ? Date.parse(range.to) : Infinity;
      cache.forEach(function (e) {
        if (e.type !== 'provider_call') return;
        var t = Date.parse(e.ts); if (t < from || t > to) return;
        var d = e.detail, u = out[d.provider_id] || (out[d.provider_id] = { calls: 0, ok: 0, failed: 0, by_purpose: {} });
        u.calls++; if (d.result === 'ok') u.ok++; else u.failed++;
        u.by_purpose[d.purpose] = (u.by_purpose[d.purpose] || 0) + 1;
      });
      return out;
    }

    /** Admin diagnostic snapshot: deployed version tag, engine version/fingerprint, chain health, storage state (Section 32.2). */
    function diagnostics() {
      ensureLoaded();
      return { audit_version: VERSION, tool: o.tool, tool_version: o.toolVersion, deployed_tag: o.deployedTag || null,
               engine_version: o.engineVersion, engine_fingerprint: currentFingerprint(), session_id: sessionId,
               storage_kind: store.kind, storage_fallback: fellBackFrom ? clone(fellBackFrom) : null, entries: cache.length, chain: verify(), retention: retentionStatus() };
    }

    /* ======================================================================================
     * 7. BRIDGE: turn AgentLayer's metadata-only events into audit entries (so nothing is missed)
     * ==================================================================================== */

    var OUTCOME_OF_DECISION = { allow: 'allowed', warn: 'warned', block: 'blocked' };
    var OUTCOME_OF_STATUS = { ready: 'ok', cannot_be_determined: 'cannot_be_determined', not_assessed: 'not_assessed', rejected: 'rejected' };

    /** Subscribe to an AgentLayer instance. Each AgentLayer event maps to one audit event. Errors in mapping are swallowed. */
    function bridge(AL) {
      if (!AL || !AL.events || typeof AL.events.on !== 'function') return false;
      AL.events.on(function (ev) {
        try {
          var d = ev.details || {};
          if (ev.type === 'prefilter_decision') {
            append('prefilter_decision', OUTCOME_OF_DECISION[d.decision] || 'n_a', { decision: d.decision, payment_flagged: !!d.paymentFlagged, payment_terms: d.paymentTerms || 0,
              pii_findings: (d.piiDetail || []).map(function (x) { return { category: x.category, count: x.count, mode: x.mode }; }), warn_confirmed: false });
          } else if (ev.type === 'warn_confirmed') {
            append('prefilter_decision', 'ok', { decision: 'warn', payment_flagged: false, payment_terms: 0, pii_findings: [], warn_confirmed: true });
          } else if (ev.type === 'validation_result') {
            append('validation_result', OUTCOME_OF_STATUS[d.status] || 'n_a', { engine: String(d.engine), status: d.status,
              missing: d.missing_detail || [], caveats: d.caveat_detail || [], reason: d.reason || null });
          } else if (ev.type === 'review_flag') {
            append('review_flag', 'n_a', { flag_id: String(d.flagId), kind: 'payment_regulatory', terms: d.terms || 0 });
          } else if (ev.type === 'review_acknowledged') {
            append('review_acknowledged', 'ok', { flag_id: String(d.flagId), acknowledged_by: String(d.by || 'unknown') });
          } else if (ev.type === 'pii_policy_set') {
            append('config_changed', 'ok', { setting: 'pii_policy', summary: 'mode=' + d.mode + '; category overrides=' + d.categoryOverrides + '; weakened=' + d.weakened, notice_version: d.noticeVersion || null, acknowledged_by: d.acknowledgedBy || null });
          } else if (ev.type === 'pii_policy_rejected') {
            append('config_changed', 'rejected', { setting: 'pii_policy', summary: 'policy change rejected (' + d.errors + ' problem(s)); previous policy unchanged', notice_version: null, acknowledged_by: null });
          } else if (ev.type === 'pii_pattern_added') {
            append('config_changed', 'ok', { setting: 'pii_pattern', summary: 'custom pattern added: ' + String(d.id), notice_version: null, acknowledged_by: null });
          } else if (ev.type === 'payment_terms_added') {
            append('config_changed', 'ok', { setting: 'payment_terms', summary: d.count + ' custom payment term(s) added', notice_version: null, acknowledged_by: null });
          }
        } catch (e) { /* the audit bridge must never disturb the validation layer */ }
      });
      return true;
    }

    var notReadyRead = function () { return { ok: false, loading: true }; };
    var Q = queued;   // event logging: never lost, never reordered, never blocks the caller
    var R = function (fn, v) { return needsReady(fn, v); };
    return Object.freeze({
      version: VERSION,
      append: Q(append), logInput: Q(logInput), logAgentOutput: Q(logAgentOutput), logEngineRun: Q(logEngineRun), logDisplay: Q(logDisplay),
      logProviderCall: Q(logProviderCall), logModeChange: Q(logModeChange), logFailsafe: Q(logFailsafe), logError: Q(logError),
      beginInteraction: beginInteraction, endInteraction: endInteraction, setActor: setActor, setProvider: setProvider,
      verify: R(verify, notReadyRead), entries: R(entries, function () { return []; }), exportAll: R(exportAll, notReadyRead),
      retention: {
        configure: R(configureRetention, function () { return { ok: false, error: 'storage_loading' }; }),
        status: R(retentionStatus, function () { return { loading: true, prompt: null }; }),
        markPromptShown: Q(markPromptShown),
        purgeExpired: R(purgeExpired, function () { return { ok: false, error: 'storage_loading' }; }),
        redact: R(redactEntry, function () { return { ok: false, error: 'storage_loading' }; }),
        redactableFields: redactableFields },
      usage: { summary: R(usageSummary, function () { return {}; }) },
      diagnostics: R(diagnostics, function () { return { loading: true }; }), bridge: bridge,
      /** Resolves when the store is open and every queued event has been written. */
      ready: whenReady,
      /** Resolves when pending background writes have been attempted (best effort before navigating away). */
      flush: function () { return (store.flush ? store.flush() : Promise.resolve()).then(function () { return true; }); },
      /** Browser storage quota/usage estimate (async; null where unsupported). */
      storageEstimate: function () {
        try { return (root.navigator && root.navigator.storage && root.navigator.storage.estimate) ? root.navigator.storage.estimate().then(function (x) { return { usage: x.usage, quota: x.quota }; }, function () { return null; }) : Promise.resolve(null); }
        catch (e) { return Promise.resolve(null); }
      },
      status: function () { return { version: VERSION, started: started, loaded: loaded, ready: storeReady, degraded: degraded ? clone(degraded) : null, storage_kind: store.kind, storage_fallback: fellBackFrom ? clone(fellBackFrom) : null }; }
    });
  }

  /* ======================================================================================
   * 8. MODULE-LEVEL API
   * ==================================================================================== */
  var instance = null;

  /**
   * Initialise the default (browser) instance. Writes NOTHING to storage. Returns the log, or null if already initialised
   * with the same instance (idempotent). Throws only on an unusable configuration.
   */
  function init(opts) { if (!instance) instance = create(opts); return instance; }

  return Object.freeze({
    version: VERSION, create: create, init: init, memoryStorage: memoryStorage, indexedDbAdapter: indexedDbAdapter,
    log: function () { return instance; },
    util: Object.freeze({ sha256Hex: sha256Hex, canon: canon, redactSpans: redactSpans })
  });
});
