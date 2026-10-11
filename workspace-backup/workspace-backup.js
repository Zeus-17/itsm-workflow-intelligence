/*!
 * WORKSPACE BACKUP AND RESTORE POINTS  (Master Plan item W6)   -   SHARED FILE: identical in the RM and ITSM repositories (hash-locked in LOCK.sha256).
 * The per-tool rules (which saved items belong to the workspace, how to summarise and validate them) live in adapter.js, which is NOT shared.
 *
 * WHAT IT DOES (standard mode: no AI, no network, nothing sent anywhere)
 *   - Export backup:   one plain JSON file holding everything this tool saves in this browser (your data and settings).
 *   - Import backup:   the file is checked first, a preview shows what would change, a restore point of the CURRENT data is saved, and only then is anything replaced.
 *   - Restore points:  copies of the workspace kept in this browser's IndexedDB (separate from the page's own storage). Made automatically before an import,
 *                      a restore or a destructive action, or on request. Restoring one also saves a restore point first, so a restore can be undone.
 *   - Reminders:       a calm banner when there is work in the browser and no recent export, or when this browser is not keeping anything at all.
 *
 * RULES (tested in workspace-backup/tests/backup_run.js and, in a real browser, ci/browser-tests.js)
 *   - Never silent: every replace is previewed and confirmed; every automatic restore point is listed.
 *   - Only the tool's own keys are ever read or written (the adapter's prefix). A backup file naming any other key is refused, so a crafted file cannot touch
 *     anything else in the browser (for example the AI kill-switch).
 *   - Failure never leaves a half-restored workspace: if writing fails part-way the previous values are put back.
 *   - The backup file is NOT encrypted: it contains whatever was typed. The panel says so.
 *
 * LIMITS (placeholders to be confirmed): keep the newest 6 AUTOMATIC restore points (manual ones are never removed automatically); remind after 14 days;
 *   "remind me later" lasts 7 days; a backup file larger than 4 MB is refused (browser storage is about 5 MB).
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) { module.exports = factory; }   // tests inject a fake environment
  else { root.WorkspaceBackup = factory(root); }
})(typeof self !== 'undefined' ? self : this, function (env) {
  'use strict';

  var FORMAT = 'workspace-backup', FORMAT_VERSION = 1;
  var MAX_BYTES = 4000000, KEEP_AUTO = 6, REMIND_DAYS = 14, SNOOZE_DAYS = 7;
  var A = null;                                   // adapter (per tool)
  var doc = env.document || null;
  var storage = function () { return env.localStorage; };

  /* ------------------------------------------------------------------------------------------------ small helpers */
  function configure(adapter) { A = adapter; return api; }
  function included(key) {
    if (typeof key !== 'string' || !A) return false;
    if (!A.prefix.some(function (p) { return key.indexOf(p) === 0; })) return false;
    return !(A.exclude && A.exclude.test(key));
  }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function bytesOf(entries) { var n = 0; Object.keys(entries).forEach(function (k) { n += k.length + entries[k].length; }); return n; }
  function nowIso() { return new Date().toISOString(); }
  function isoDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function ago(iso) {
    var t = Date.parse(iso); if (isNaN(t)) return '';
    var d = Math.floor((Date.now() - t) / 86400000);
    return d <= 0 ? 'today' : d === 1 ? '1 day ago' : d + ' days ago';
  }
  function fmt(iso) { var t = Date.parse(iso); return isNaN(t) ? '' : new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  function kb(n) { return n < 1024 ? n + ' B' : (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB'; }
  function metaKey(name) { return 'wb_' + A.tool + '_' + name; }
  function lsGet(k) { try { return storage().getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { storage().setItem(k, v); return true; } catch (e) { return false; } }

  /* ------------------------------------------------------------------------------------------------ the workspace = the tool's own saved items */
  /** Everything the tool has saved in this browser that belongs to the workspace: {key: stringValue}. */
  function collect(store) {
    var s = store || storage(), out = {};
    for (var i = 0; i < s.length; i++) { var k = s.key(i); if (included(k)) { var v = s.getItem(k); if (typeof v === 'string') out[k] = v; } }
    return out;
  }

  function build(entries, at) {
    var counts = {}; (A.summarise(entries) || []).forEach(function (p) { counts[p[0]] = p[1]; });
    return { format: FORMAT, formatVersion: FORMAT_VERSION, tool: A.tool, toolName: A.toolName, toolVersion: A.version, exportedAt: at || nowIso(),
      keyCount: Object.keys(entries).length, summary: counts, note: 'Plain, unencrypted JSON of everything this tool saved in the browser it was exported from.', entries: entries };
  }

  /** Check a backup file's text. Returns {ok, errors[], warnings[], entries, partial, meta}. Nothing is applied. */
  function parse(text) {
    var res = { ok: false, errors: [], warnings: [], entries: null, partial: false, meta: null };
    if (typeof text !== 'string' || !text.trim()) { res.errors.push('The file is empty.'); return res; }
    if (text.length > MAX_BYTES) { res.errors.push('The file is larger than ' + kb(MAX_BYTES) + ', which is more than this browser can hold for the tool.'); return res; }
    var o; try { o = JSON.parse(text); } catch (e) { res.errors.push('This is not a valid JSON file (it may be cut short or edited).'); return res; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) { res.errors.push('This file does not look like a backup of this tool.'); return res; }
    var entries;
    if (o.format === FORMAT) {
      if (o.tool !== A.tool) { res.errors.push('This backup was made by a different tool (' + String(o.toolName || o.tool || 'unknown').slice(0, 60) + ') and cannot be loaded here.'); return res; }
      if (typeof o.formatVersion !== 'number' || o.formatVersion > FORMAT_VERSION) { res.errors.push('This backup was made by a newer version of the tool. Update the tool, then try again.'); return res; }
      if (!o.entries || typeof o.entries !== 'object' || Array.isArray(o.entries)) { res.errors.push('The backup has no saved items in it.'); return res; }
      entries = {};
      var keys = Object.keys(o.entries);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i], v = o.entries[k];
        if (!included(k)) { res.errors.push('The file names a saved item that does not belong to this tool ("' + k.slice(0, 40) + '"). It was refused for safety.'); return res; }
        if (typeof v !== 'string') { res.errors.push('A saved item in the file has the wrong type ("' + k.slice(0, 40) + '").'); return res; }
        entries[k] = v;
      }
      if (typeof o.keyCount === 'number' && o.keyCount !== keys.length) { res.errors.push('The file says it holds ' + o.keyCount + ' saved items but contains ' + keys.length + ' - it may be damaged.'); return res; }
      res.meta = { exportedAt: typeof o.exportedAt === 'string' ? o.exportedAt : '', toolVersion: typeof o.toolVersion === 'string' ? o.toolVersion : '', legacy: false };
    } else if (typeof A.legacy === 'function' && (entries = safeLegacy(o))) {
      res.partial = true; res.meta = { exportedAt: '', toolVersion: '', legacy: true };
      res.warnings.push('This is an older export file. Only the data in it will be replaced; your settings and other saved items are left as they are.');
    } else { res.errors.push('This file does not look like a backup of this tool.'); return res; }
    var ks = Object.keys(entries);
    for (var j = 0; j < ks.length; j++) {
      var bad = typeof A.validateValue === 'function' ? A.validateValue(ks[j], entries[ks[j]]) : '';
      if (bad) { res.errors.push(bad); return res; }
    }
    if (!ks.length) res.warnings.push('The backup contains no saved items: restoring it would leave the tool empty.');
    res.entries = entries; res.ok = true; return res;
  }

  function safeLegacy(o) { try { return A.legacy(o) || null; } catch (e) { return null; } }

  /** What differs between two workspaces (by key). */
  function compare(current, incoming) {
    var added = [], removed = [], changed = [], same = 0;
    Object.keys(incoming).forEach(function (k) { if (!own(current, k)) added.push(k); else if (current[k] !== incoming[k]) changed.push(k); else same++; });
    Object.keys(current).forEach(function (k) { if (!own(incoming, k)) removed.push(k); });
    return { added: added, removed: removed, changed: changed, same: same, identical: !added.length && !removed.length && !changed.length };
  }

  /** Make the stored workspace equal to `entries` (or, for a partial file, set only those keys). Puts everything back if a write fails. */
  function applyEntries(entries, partial) {
    var s = storage(), before = collect(s);
    try {
      if (!partial) Object.keys(before).forEach(function (k) { if (!own(entries, k)) s.removeItem(k); });
      Object.keys(entries).forEach(function (k) { s.setItem(k, entries[k]); });
      return { ok: true };
    } catch (e) {
      try {
        Object.keys(collect(s)).forEach(function (k) { if (!own(before, k)) s.removeItem(k); });
        Object.keys(before).forEach(function (k) { s.setItem(k, before[k]); });
      } catch (e2) { return { ok: false, error: 'Could not write the data, and could not fully put the previous data back. Use your latest restore point or backup file.', rollbackFailed: true }; }
      return { ok: false, error: 'This browser would not store the data (it may be full or blocked). Nothing was changed.' };
    }
  }

  /* ------------------------------------------------------------------------------------------------ restore points (IndexedDB, with an injectable store for tests) */
  var memoryStore = null;
  function openIdb() {
    return new Promise(function (resolve, reject) {
      try {
        if (!env.indexedDB) return reject(new Error('IndexedDB is not available'));
        var rq = env.indexedDB.open('wb_' + A.tool, 1);
        rq.onupgradeneeded = function () { if (!rq.result.objectStoreNames.contains('points')) rq.result.createObjectStore('points', { keyPath: 'id' }); };
        rq.onsuccess = function () { resolve(rq.result); };
        rq.onerror = function () { reject(rq.error || new Error('IndexedDB error')); };
        rq.onblocked = function () { reject(new Error('IndexedDB blocked')); };
        setTimeout(function () { reject(new Error('IndexedDB timeout')); }, 4000);
      } catch (e) { reject(e); }
    });
  }
  function idbTx(mode, fn) {
    return openIdb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('points', mode), st = tx.objectStore('points'), out;
        try { out = fn(st); } catch (e) { db.close(); return reject(e); }
        tx.oncomplete = function () { db.close(); resolve(out && out.result !== undefined ? out.result : out); };
        tx.onerror = function () { db.close(); reject(tx.error || new Error('IndexedDB transaction failed')); };
        tx.onabort = function () { db.close(); reject(tx.error || new Error('IndexedDB transaction aborted')); };
      });
    });
  }
  var store = {
    put: function (p) { return memoryStore ? memoryStore.put(p) : idbTx('readwrite', function (st) { return st.put(p); }); },
    all: function () { return memoryStore ? memoryStore.all() : idbTx('readonly', function (st) { return st.getAll(); }).then(function (r) { return r || []; }); },
    get: function (id) { return memoryStore ? memoryStore.get(id) : idbTx('readonly', function (st) { return st.get(id); }); },
    del: function (id) { return memoryStore ? memoryStore.del(id) : idbTx('readwrite', function (st) { return st.delete(id); }); }
  };
  function useMemoryStore(m) { memoryStore = m; }

  function newId() { return 'rp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  /** Save a restore point of the CURRENT workspace. Resolves to the point, or rejects (then nothing was saved). */
  function createRestorePoint(reason, auto) {
    var entries = collect();
    var p = { id: newId(), at: nowIso(), reason: String(reason || 'Restore point').slice(0, 160), auto: !!auto, tool: A.tool, version: A.version,
      summary: A.summarise(entries) || [], bytes: bytesOf(entries), entries: entries };
    return store.put(p).then(function () { return prune().then(function (n) { p.pruned = n; return p; }); });
  }
  function listRestorePoints() { return store.all().then(function (a) { return a.sort(function (x, y) { return y.at < x.at ? -1 : y.at > x.at ? 1 : 0; }); }); }
  /** Keep only the newest KEEP_AUTO automatic points; manual points are never removed here. Resolves to how many were removed. */
  function prune() {
    return listRestorePoints().then(function (all) {
      var autos = all.filter(function (p) { return p.auto; }), drop = autos.slice(KEEP_AUTO);
      return Promise.all(drop.map(function (p) { return store.del(p.id); })).then(function () { return drop.length; });
    });
  }

  /* ------------------------------------------------------------------------------------------------ finishing a restore: reload with a safety net */
  var PENDING = function () { return 'wb_pending_' + A.tool; };
  /** The tool may still write its in-memory data while the page unloads, which could undo a restore. So the entries are also parked in sessionStorage and
   *  re-applied at the very start of the next load, before the tool reads anything. */
  function finish(entries, partial) {
    var r = applyEntries(entries, partial);
    if (!r.ok) return r;
    try { env.sessionStorage.setItem(PENDING(), JSON.stringify({ entries: entries, partial: !!partial, at: Date.now() })); } catch (e) { /* the plain reload still works */ }
    if (env.location && env.location.reload) env.location.reload();
    return r;
  }
  function applyPending() {
    if (!A) return false;
    try {
      var raw = env.sessionStorage.getItem(PENDING()); if (!raw) return false;
      env.sessionStorage.removeItem(PENDING());
      var p = JSON.parse(raw);
      if (!p || typeof p.entries !== 'object' || Date.now() - (p.at || 0) > 60000) return false;
      var ok = Object.keys(p.entries).every(function (k) { return included(k) && typeof p.entries[k] === 'string'; });
      if (!ok) return false;
      return applyEntries(p.entries, !!p.partial).ok;
    } catch (e) { return false; }
  }

  /* ------------------------------------------------------------------------------------------------ reminder state */
  function lastExport() { return lsGet(metaKey('last_export')) || ''; }
  function recordExport() { lsSet(metaKey('last_export'), nowIso()); }
  function reminderState(entries, nowMs) {
    var now = nowMs || Date.now();
    var probe = storageWorks();
    if (!probe) return { kind: 'unsaved' };
    var e = entries || collect();
    if (typeof A.hasWork === 'function' && !A.hasWork(e)) return { kind: 'none' };
    var le = lastExport(), t = Date.parse(le), snooze = Date.parse(lsGet(metaKey('snooze')) || '');
    if (!isNaN(snooze) && now - snooze < SNOOZE_DAYS * 86400000) return { kind: 'none' };
    if (isNaN(t)) return { kind: 'never' };
    return now - t > REMIND_DAYS * 86400000 ? { kind: 'overdue', last: le } : { kind: 'none' };
  }
  function storageWorks() {
    try { var k = 'wb_probe_' + A.tool; storage().setItem(k, '1'); var ok = storage().getItem(k) === '1'; storage().removeItem(k); return ok; } catch (e) { return false; }
  }

  /* ------------------------------------------------------------------------------------------------ interface (built with textContent only: no HTML strings, so nothing typed by a user can become markup) */
  function h(tag, props, kids) {
    var e = doc.createElement(tag), k;
    if (props) for (k in props) { if (!own(props, k)) continue; var v = props[k];
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
    (kids || []).forEach(function (c) { if (c == null) return; e.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c); });
    return e;
  }
  function toast(msg, type) { try { if (typeof env.showToast === 'function') env.showToast(msg, type || 'info', 4000); } catch (e) { /* the panel shows the message too */ } }

  var CSS = '.wb-box{font-size:12px;color:var(--text2,#9aa);line-height:1.6}.wb-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}' +
    '.wb-btn{padding:7px 13px;border-radius:7px;font-size:12px;font-weight:500;cursor:pointer;border:1px solid var(--border2,#456);background:var(--surface2,#223);color:var(--text,#eee);font-family:inherit}' +
    '.wb-btn:hover{border-color:var(--accent,#10b981)}.wb-btn.primary{background:var(--accent,#10b981);border-color:var(--accent,#10b981);color:#fff}.wb-btn.danger{border-color:var(--red,#f87171);color:var(--red,#f87171)}' +
    '.wb-pt{display:grid;grid-template-columns:1fr auto;gap:4px 10px;padding:8px 10px;border:1px solid var(--border2,#456);border-radius:7px;margin:6px 0;background:var(--surface,#112)}' +
    '.wb-muted{color:var(--text3,#789);font-size:11px}.wb-warn{color:var(--amber,#fbbf24)}.wb-bad{color:var(--red,#f87171)}' +
    '#wb-dialog{margin:auto;position:fixed;inset:0;height:fit-content;max-height:calc(100% - 32px);overflow:auto;max-width:560px;width:calc(100% - 32px);border:1px solid var(--border2,#456);border-radius:12px;background:var(--surface,#112);color:var(--text,#eee);padding:20px;font-family:inherit}' +
    '#wb-dialog::backdrop{background:rgba(0,0,0,.6)}#wb-dialog h3{margin:0 0 10px;font-size:15px}#wb-dialog table{width:100%;border-collapse:collapse;font-size:12px;margin:8px 0}' +
    '#wb-dialog td,#wb-dialog th{padding:4px 6px;border-bottom:1px solid var(--border,#345);text-align:left}' +
    '.wb-banner{display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding:8px 14px;font-size:12px;background:var(--surface2,#223);border-bottom:1px solid var(--amber,#fbbf24);color:var(--text,#eee)}';

  function ensureUi() {
    if (!doc || doc.getElementById('wb-dialog')) return;
    doc.head.appendChild(h('style', { id: 'wb-style', text: CSS }));
    doc.body.appendChild(h('dialog', { id: 'wb-dialog', 'aria-labelledby': 'wb-title' }));
    var fi = h('input', { type: 'file', id: 'wb-file', accept: '.json,application/json', style: 'display:none', onchange: function (ev) { var f = ev.target.files && ev.target.files[0]; ev.target.value = ''; if (f) importFile(f); } });
    doc.body.appendChild(fi);
  }
  function dialog(title, bodyNodes, buttons) {
    ensureUi();
    var d = doc.getElementById('wb-dialog');
    while (d.firstChild) d.removeChild(d.firstChild);
    d.appendChild(h('h3', { id: 'wb-title', text: title }));
    bodyNodes.forEach(function (n) { d.appendChild(n); });
    d.appendChild(h('div', { class: 'wb-row', style: 'justify-content:flex-end;margin-top:14px' }, buttons.map(function (b) {
      return h('button', { class: 'wb-btn' + (b.kind ? ' ' + b.kind : ''), id: b.id || '', type: 'button', onclick: function () { if (b.keepOpen) b.run(); else { closeDialog(); if (b.run) b.run(); } } , text: b.label });
    })));
    if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', '');
    return d;
  }
  function closeDialog() { var d = doc && doc.getElementById('wb-dialog'); if (d) { if (typeof d.close === 'function' && d.open) d.close(); else d.removeAttribute('open'); } }
  function para(text, cls) { return h('p', { class: 'wb-box' + (cls ? ' ' + cls : ''), text: text, style: 'margin:6px 0' }); }
  function summaryTable(current, incoming, incomingLabel) {
    var a = {}, b = {}; (A.summarise(current) || []).forEach(function (p) { a[p[0]] = p[1]; }); (A.summarise(incoming) || []).forEach(function (p) { b[p[0]] = p[1]; });
    var labels = Object.keys(a); Object.keys(b).forEach(function (l) { if (labels.indexOf(l) < 0) labels.push(l); });
    var rows = [h('tr', null, [h('th', { text: '' }), h('th', { text: 'Now' }), h('th', { text: incomingLabel })])];
    labels.forEach(function (l) { rows.push(h('tr', null, [h('td', { text: l }), h('td', { text: String(own(a, l) ? a[l] : 0) }), h('td', { text: String(own(b, l) ? b[l] : 0) })])); });
    rows.push(h('tr', null, [h('td', { text: 'Size' }), h('td', { text: kb(bytesOf(current)) }), h('td', { text: kb(bytesOf(incoming)) })]));
    return h('table', null, rows);
  }

  /** The common "replace the workspace" confirmation. `incoming` = entries; `partial` for legacy files; `label` names the source. */
  function confirmReplace(opts) {
    var current = collect(), cmp = compare(current, opts.entries);
    var body = [para(opts.intro)];
    body.push(summaryTable(current, opts.entries, opts.columnLabel));
    (opts.warnings || []).forEach(function (w) { body.push(para(w, 'wb-warn')); });
    if (cmp.identical) body.push(para('This is identical to what you have now: nothing would change.'));
    else if (!opts.partial) {
      var parts = [];
      if (cmp.removed.length) parts.push(cmp.removed.length + ' saved item(s) that exist now are not in this version and would be removed');
      if (cmp.changed.length) parts.push(cmp.changed.length + ' would be replaced');
      if (cmp.added.length) parts.push(cmp.added.length + ' would be added');
      body.push(para(parts.join('; ') + '.', 'wb-muted'));
    }
    body.push(para('Before anything is replaced, a restore point of your current data is saved, so you can undo this from the list of restore points.'));
    var noteBox = h('p', { class: 'wb-box wb-bad', style: 'margin:6px 0;display:none', id: 'wb-err' });
    body.push(noteBox);
    var needAck = null;
    dialog(opts.title, body, [
        { label: 'Cancel', run: function () { /* nothing changed */ } },
        { label: opts.confirmLabel, kind: 'primary', id: 'wb-confirm', keepOpen: true, run: function () {
          var show = function (t) { noteBox.textContent = t; noteBox.style.display = 'block'; };
          createRestorePoint(opts.reason, true).then(function () { go(); }, function () {
            if (!needAck) {   // no restore point could be saved: say so and ask once more
              needAck = true; show('A restore point could not be saved in this browser mode (private window or blocked storage). If you continue, this cannot be undone. Press the button again to continue anyway, or Cancel and export a backup first.');
              return;
            }
            go();
          });
          function go() {
            var r = finish(opts.entries, opts.partial);
            if (!r.ok) show(r.error);
          }
        } }
    ]);
  }

  function importFile(file) {
    if (!file) return;
    if (file.size > MAX_BYTES) { dialog('Cannot load this file', [para('The file is larger than ' + kb(MAX_BYTES) + ', which is more than this browser can hold for the tool.', 'wb-bad')], [{ label: 'Close' }]); return; }
    var rd = new FileReader();
    rd.onload = function () {
      var r = parse(String(rd.result));
      if (!r.ok) { dialog('This file cannot be loaded', r.errors.map(function (e) { return para(e, 'wb-bad'); }).concat([para('Nothing was changed.')]), [{ label: 'Close' }]); return; }
      var when = r.meta && r.meta.exportedAt ? ' It was exported ' + fmt(r.meta.exportedAt) + '.' : '';
      confirmReplace({ title: 'Replace your data with this backup?', intro: 'File: ' + String(file.name).slice(0, 80) + '.' + when, entries: r.entries, partial: r.partial, warnings: r.warnings, columnLabel: 'In the file',
        confirmLabel: 'Replace my data', reason: 'Before importing ' + String(file.name).slice(0, 80) });
    };
    rd.onerror = function () { dialog('Could not read the file', [para('The browser could not read that file. Nothing was changed.', 'wb-bad')], [{ label: 'Close' }]); };
    rd.readAsText(file);
  }

  function exportBackup() {
    var entries = collect(), b = build(entries);
    var blob = new Blob([JSON.stringify(b, null, 1)], { type: 'application/json' });
    var a = doc.createElement('a'); a.href = env.URL.createObjectURL(blob); a.download = A.fileStem + '-workspace-backup-' + isoDay(Date.now()) + '.json';
    doc.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { try { env.URL.revokeObjectURL(a.href); } catch (e) { /* ignore */ } }, 4000);
    recordExport(); toast('Backup file saved (' + Object.keys(entries).length + ' items). Keep it somewhere you keep other work data.', 'success'); refresh(); renderBanner();
  }

  function restoreFrom(point) {
    confirmReplace({ title: 'Restore this restore point?', intro: 'Restore point from ' + fmt(point.at) + ' (' + String(point.reason).slice(0, 100) + ').', entries: point.entries, partial: false, warnings: [],
      columnLabel: 'Restore point', confirmLabel: 'Restore it', reason: 'Before restoring the restore point from ' + fmt(point.at) });
  }

  function manualPoint() {
    var input = h('input', { type: 'text', id: 'wb-label', maxlength: '100', placeholder: 'Optional label, e.g. before the Friday release', style: 'width:100%;padding:8px;border-radius:6px;border:1px solid var(--border2,#456);background:var(--surface2,#223);color:var(--text,#eee)' });
    dialog('Save a restore point', [para('A copy of your current data is kept in this browser so you can come back to it. It is not a file: also export a backup if the data matters.'), input], [
      { label: 'Cancel' }, { label: 'Save restore point', kind: 'primary', id: 'wb-save-point', run: function () {
        createRestorePoint(input.value.trim() || 'Manual restore point', false).then(function () { toast('Restore point saved.', 'success'); refresh(); },
          function () { toast('A restore point could not be saved in this browser mode. Export a backup file instead.', 'warn'); });
      } }]);
  }

  /** For the tool's own destructive actions: save a restore point first, then run `proceed`. If none can be saved, ask once. */
  function protect(reason, proceed) {
    return createRestorePoint(reason, true).then(function () { proceed(); refresh(); }, function () {
      dialog('No restore point could be saved', [para('This browser is not letting the tool keep restore points (private window or blocked storage), so this action cannot be undone. Continue anyway?', 'wb-warn')],
        [{ label: 'Cancel' }, { label: 'Continue without a restore point', kind: 'danger', run: proceed }]);
    });
  }

  function renderPanel(points, problem) {
    var box = doc && doc.getElementById('wb-panel'); if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    var le = lastExport();
    box.appendChild(h('div', { class: 'wb-box' }, [
      h('div', { text: 'Everything this tool saves is kept only in this browser. Back it up as a file, and keep restore points in case something is overwritten or cleared.' }),
      h('div', { class: 'wb-row' }, [
        h('button', { class: 'wb-btn primary', type: 'button', id: 'wb-export', text: 'Export backup', onclick: exportBackup }),
        h('button', { class: 'wb-btn', type: 'button', id: 'wb-import', text: 'Import backup…', onclick: function () { ensureUi(); doc.getElementById('wb-file').click(); } }),
        h('button', { class: 'wb-btn', type: 'button', id: 'wb-new-point', text: 'Save a restore point', onclick: manualPoint })
      ]),
      h('div', { class: 'wb-muted', text: le ? 'Last exported: ' + fmt(le) + ' (' + ago(le) + ')' : 'Last exported from this browser: never' }),
      h('div', { class: 'wb-muted', text: 'Included: your data and settings. Not included: downloaded guidance cache, "what\'s new" flags' + (A.extraExcludedNote ? ', ' + A.extraExcludedNote : '') + '. The file is plain JSON and is not encrypted.' }),
      h('div', { style: 'margin-top:10px;font-weight:600;color:var(--text,#eee)', text: 'Restore points' + (points ? ' (' + points.length + ')' : '') })
    ]));
    if (problem) box.appendChild(h('div', { class: 'wb-box wb-warn', text: 'Restore points are not available in this browser mode (' + problem + '). Backup files still work.' }));
    else if (points && !points.length) box.appendChild(h('div', { class: 'wb-box wb-muted', text: 'None yet. One is saved automatically before an import, a restore or Clear, and you can save one yourself.' }));
    (points || []).forEach(function (p) {
      box.appendChild(h('div', { class: 'wb-pt' }, [
        h('div', null, [h('div', { text: fmt(p.at) + ' - ' + p.reason + (p.auto ? '' : '  (saved by you)') }),
          h('div', { class: 'wb-muted', text: (p.summary || []).map(function (s) { return s[0] + ': ' + s[1]; }).join('  |  ') + (p.summary && p.summary.length ? '  |  ' : '') + kb(p.bytes || 0) })]),
        h('div', { class: 'wb-row', style: 'margin:0' }, [
          h('button', { class: 'wb-btn', type: 'button', text: 'Restore', onclick: function () { restoreFrom(p); } }),
          h('button', { class: 'wb-btn danger', type: 'button', text: 'Delete', onclick: function () { store.del(p.id).then(refresh, refresh); } })
        ])
      ]));
    });
    if (points && points.some(function (p) { return p.auto; })) box.appendChild(h('div', { class: 'wb-muted', text: 'Automatic restore points: the newest ' + KEEP_AUTO + ' are kept. Ones you save yourself are kept until you delete them.' }));
  }
  function refresh() { if (!doc || !doc.getElementById('wb-panel')) return Promise.resolve(); return listRestorePoints().then(function (p) { renderPanel(p, ''); }, function (e) { renderPanel(null, String(e && e.message || 'unavailable')); }); }

  function renderBanner() {
    if (!doc) return;
    var old = doc.getElementById('wb-banner'); if (old) old.remove();
    var st = reminderState(); if (st.kind === 'none') return;
    var msg = st.kind === 'unsaved' ? 'This browser is not keeping anything this tool saves (private window, blocked or full storage). Work will be lost when the tab closes. Export a backup before you finish.'
      : st.kind === 'never' ? 'Your data is stored only in this browser, and has never been exported. A backup file protects it if the browser data is cleared.'
        : 'Your last backup was ' + ago(st.last) + '. Your data is stored only in this browser.';
    var b = h('div', { class: 'wb-banner', id: 'wb-banner', role: 'status' }, [h('span', { text: msg }),
      h('button', { class: 'wb-btn primary', type: 'button', text: 'Export a backup', onclick: exportBackup }),
      st.kind === 'unsaved' ? null : h('button', { class: 'wb-btn', type: 'button', text: 'Remind me later', onclick: function () { lsSet(metaKey('snooze'), nowIso()); b.remove(); } })]);
    doc.body.insertBefore(b, doc.body.firstChild);
  }

  var timer = null;
  function mount() {
    ensureUi(); refresh(); renderBanner();
    if (!timer && typeof env.setInterval === 'function') {   // work may be created after the page loaded: look again now and then, and when the tab comes back
      timer = env.setInterval(renderBanner, 120000);
      if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', function () { if (!doc.hidden) renderBanner(); });
    }
  }

  var api = { configure: configure, collect: collect, build: build, parse: parse, compare: compare, applyEntries: applyEntries, createRestorePoint: createRestorePoint,
    listRestorePoints: listRestorePoints, prune: prune, finish: finish, applyPending: applyPending, reminderState: reminderState, recordExport: recordExport, storageWorks: storageWorks,
    useMemoryStore: useMemoryStore, mount: mount, refresh: refresh, importFile: importFile, exportBackup: exportBackup, protect: protect, restoreFrom: restoreFrom,
    constants: { FORMAT: FORMAT, FORMAT_VERSION: FORMAT_VERSION, MAX_BYTES: MAX_BYTES, KEEP_AUTO: KEEP_AUTO, REMIND_DAYS: REMIND_DAYS, SNOOZE_DAYS: SNOOZE_DAYS }, _included: included };
  return api;
});
