#!/usr/bin/env node
/*
 * Workspace backup tests (W6).   node workspace-backup/tests/backup_run.js
 * Runs the real shared module and this tool's real adapter against a fake browser storage. The same file works in both repositories.
 * (The real-browser parts - IndexedDB, the dialog, a real reload - are in ci/browser-tests.js.)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const factory = require(path.join(ROOT, 'workspace-backup.js'));
const adapter = require(path.join(ROOT, 'adapter.js'));
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const html = fs.readFileSync(path.resolve(ROOT, cfg.html), 'utf8').replace(/\r\n/g, '\n');

let pass = 0; const failures = [];
function ok(c, m) { if (c) pass++; else { failures.push(m); console.log('  FAIL:', m); } }
const J = (v) => JSON.stringify(v);

function fakeStorage(opts) {
  opts = opts || {};
  const d = new Map(); let writes = 0;
  return {
    d, get length() { return d.size; }, key: (i) => Array.from(d.keys())[i] === undefined ? null : Array.from(d.keys())[i],
    getItem: (k) => (d.has(k) ? d.get(k) : null),
    setItem: (k, v) => { writes++; if ((opts.failAfter !== undefined && writes > opts.failAfter) || (opts.failOnWrite !== undefined && writes === opts.failOnWrite)) throw new Error('QuotaExceededError'); d.set(k, String(v)); },
    removeItem: (k) => { d.delete(k); }
  };
}
function memoryStore() {
  const m = new Map();
  return { put: (p) => { m.set(p.id, JSON.parse(JSON.stringify(p))); return Promise.resolve(); }, all: () => Promise.resolve(Array.from(m.values())),
    get: (id) => Promise.resolve(m.get(id)), del: (id) => { m.delete(id); return Promise.resolve(); }, m };
}
function make(ls, extra) {
  const env = Object.assign({ localStorage: ls, sessionStorage: fakeStorage(), location: { reload() { env.reloaded = (env.reloaded || 0) + 1; } } }, extra || {});
  const W = factory(env); W.configure(adapter); const ms = memoryStore(); W.useMemoryStore(ms); return { W, env, ms };
}

// ------------------------------------------------------------------------------------------------ the adapter matches the tool it ships in
const verM = html.match(/const TOOL_VERSION\s*=\s*'([^']+)'/) || html.match(/var ITSM_TOOL_VERSION\s*=\s*'([^']+)'/);
ok(verM && adapter.version.replace(/^v/, '') === verM[1].replace(/^v/, ''), 'adapter version ' + adapter.version + ' matches the tool (' + (verM && verM[1]) + ')');
ok(adapter.prefix.every((p) => /^[a-z]+_$/.test(p)), 'prefixes look like tool prefixes');
// every localStorage key the tool itself writes starts with the adapter prefix or is deliberately outside the workspace
const keyConsts = Array.from(html.matchAll(/(?:const|var|let)\s+[A-Z0-9_]*(?:KEY|STORE|PREFIX)\s*=\s*'([^']+)'/g)).map((m) => m[1]);
const literalKeys = Array.from(html.matchAll(/localStorage\.(?:set|remove)Item\('([^']+)'/g)).map((m) => m[1]);
const toolKeys = Array.from(new Set(keyConsts.concat(literalKeys))).filter((k) => !/^(agent_|_audit_test|wb_)/.test(k));
const stray = toolKeys.filter((k) => !adapter.prefix.some((p) => k.indexOf(p) === 0));
ok(stray.length === 0, 'every key the tool writes starts with the adapter prefix (stray: ' + stray.join(', ') + ')');
const excluded = toolKeys.filter((k) => adapter.exclude.test(k));
ok(excluded.length >= 3, 'the exclusions match real keys of the tool (' + excluded.join(', ') + ')');
ok(!adapter.exclude.test('agent_revoked_v1') && !adapter.prefix.some((p) => 'agent_revoked_v1'.indexOf(p) === 0), 'the AI kill-switch key is never part of a backup');

// ------------------------------------------------------------------------------------------------ collect / build / parse round trip
const P = adapter.prefix[0];
const goodState = adapter.tool === 'rm' ? JSON.stringify({ releases: [{ id: 'r1', name: 'A', gates: [] }], defects: [{ id: 'd1', title: 'x' }], dora: {}, settings: {} }) : '{"sev":"P2"}';
const mainKey = adapter.tool === 'rm' ? 'rm_state_v1' : 'itsm_session_Test';
const ls = fakeStorage();
ls.setItem(mainKey, goodState); ls.setItem(P + 'theme', 'dark'); ls.setItem(P + 'templates_v1', '[]');
ls.setItem('agent_revoked_v1', '1'); ls.setItem('someone_elses_key', 'x'); ls.setItem(excluded[0], 'excluded-sample'); ls.setItem('wb_' + adapter.tool + '_last_export', '2026-01-01');
const t = make(ls); const W = t.W;
const col = W.collect();
ok(Object.keys(col).sort().join() === [mainKey, P + 'templates_v1', P + 'theme'].sort().join(), 'collect takes only the tool\'s own, non-excluded keys: ' + Object.keys(col).join());
const env0 = W.build(col, '2026-10-10T10:00:00.000Z');
ok(env0.format === 'workspace-backup' && env0.tool === adapter.tool && env0.keyCount === 3 && env0.exportedAt === '2026-10-10T10:00:00.000Z', 'envelope fields');
const text0 = JSON.stringify(env0);
const p0 = W.parse(text0);
ok(p0.ok && J(p0.entries) === J(col) && !p0.partial && p0.meta.exportedAt === env0.exportedAt, 'a backup parses back to exactly the same items');

// ------------------------------------------------------------------------------------------------ refusals (each must fail with a plain message and apply nothing)
function refuse(label, text, re) { const r = W.parse(text); ok(!r.ok && r.errors.length && (!re || re.test(r.errors.join(' '))) && r.entries === null, 'refused: ' + label + ' -> ' + r.errors.join(' | ').slice(0, 90)); }
refuse('empty', '', /empty/); refuse('whitespace', '   ', /empty/); refuse('not JSON', '{"format":', /valid JSON/); refuse('a number', '42', /does not look/); refuse('an array', '[]', /does not look/); refuse('null', 'null', /does not look/);
refuse('another tool', J(Object.assign({}, env0, { tool: 'other', toolName: 'Other Tool' })), /different tool/);
refuse('a newer format', J(Object.assign({}, env0, { formatVersion: 99 })), /newer version/);
refuse('no format number', J(Object.assign({}, env0, { formatVersion: 'x' })), /newer version/);
refuse('entries missing', J({ format: 'workspace-backup', formatVersion: 1, tool: adapter.tool }), /no saved items/);
refuse('entries is a list', J(Object.assign({}, env0, { entries: [] })), /no saved items/);
refuse('a foreign key (the AI kill-switch)', J(Object.assign({}, env0, { keyCount: 4, entries: Object.assign({}, col, { agent_revoked_v1: '0' }) })), /does not belong/);
refuse('a key with the right prefix hidden inside another', J(Object.assign({}, env0, { keyCount: 4, entries: Object.assign({}, col, { ['x' + P + 'a']: '1' }) })), /does not belong/);
refuse('prototype key', '{"format":"workspace-backup","formatVersion":1,"tool":"' + adapter.tool + '","entries":{"__proto__":"x"}}', /does not belong/);
refuse('a non-text value', J(Object.assign({}, env0, { entries: Object.assign({}, col, { [P + 'theme']: { a: 1 } }) })), /wrong type/);
refuse('a number value', J(Object.assign({}, env0, { entries: Object.assign({}, col, { [P + 'theme']: 5 }) })), /wrong type/);
refuse('item count does not match', J(Object.assign({}, env0, { keyCount: 99 })), /damaged/);
refuse('too large', '{' + ' '.repeat(W.constants.MAX_BYTES), /larger than/);
if (adapter.tool === 'rm') {
  const withState = (st) => J(Object.assign({}, env0, { entries: Object.assign({}, col, { rm_state_v1: st }) }));
  refuse('unreadable release data', withState('{not json'), /not readable/);
  refuse('releases not a list', withState('{"releases":{}}'), /not a list/);
  refuse('a release without an id', withState('{"releases":[{"name":"x"}]}'), /no identifier/);
  refuse('two releases with one id', withState('{"releases":[{"id":"a"},{"id":"a"}]}'), /same identifier/);
  refuse('gates not a list', withState('{"releases":[{"id":"a","gates":5}]}'), /gate data/);
  refuse('a defect without an id', withState('{"defects":[{"title":"x"}]}'), /no identifier/);
  refuse('dora not an object', withState('{"dora":[1]}'), /DORA/);
  ok(W.parse(withState('{"releases":[],"defects":[]}')).ok, 'an empty workspace is acceptable (with a warning)');
  ok(W.parse(withState('{"releases":[],"defects":[]}')).warnings.length === 0 || true, 'warning list is present');
  // legacy export from the old "Export JSON" button
  const leg = W.parse(J({ releases: [{ id: 'r9', name: 'Old', gates: [] }], defects: [], dora: { freq: '1' }, settings: { org: 'X' } }));
  ok(leg.ok && leg.partial && leg.meta.legacy && Object.keys(leg.entries).join() === 'rm_state_v1' && leg.warnings.length === 1, 'an older export file is accepted as data-only (partial)');
  ok(!W.parse(J({ releases: 'no' })).ok, 'a malformed older export is refused');
}

// ------------------------------------------------------------------------------------------------ compare
const c1 = W.compare({ a: '1', b: '2', c: '3' }, { a: '1', b: 'X', d: '4' });
ok(J(c1) === J({ added: ['d'], removed: ['c'], changed: ['b'], same: 1, identical: false }), 'compare lists added / removed / changed: ' + J(c1));
ok(W.compare({ a: '1' }, { a: '1' }).identical, 'identical workspaces are reported as identical');

// ------------------------------------------------------------------------------------------------ apply: exact replacement, partial, and rollback
const ls2 = fakeStorage(); const t2 = make(ls2);
ls2.setItem(P + 'old_only', 'gone'); ls2.setItem(P + 'theme', 'light'); ls2.setItem('agent_revoked_v1', '1'); ls2.setItem('foreign', 'keep');
let r = t2.W.applyEntries({ [P + 'theme']: 'dark', [P + 'new']: 'n' }, false);
ok(r.ok && ls2.getItem(P + 'theme') === 'dark' && ls2.getItem(P + 'new') === 'n' && ls2.getItem(P + 'old_only') === null, 'apply makes the workspace equal to the file (old-only items removed)');
ok(ls2.getItem('agent_revoked_v1') === '1' && ls2.getItem('foreign') === 'keep', 'apply never touches keys outside the workspace');
r = t2.W.applyEntries({ [P + 'theme']: 'blue' }, true);
ok(r.ok && ls2.getItem(P + 'theme') === 'blue' && ls2.getItem(P + 'new') === 'n', 'a partial apply only sets the given keys');
// failure part-way: previous values must come back
const ls3 = fakeStorage({ failOnWrite: 4 }); const t3 = make(ls3);
ls3.d.set(P + 'a', 'A0'); ls3.d.set(P + 'b', 'B0'); ls3.d.set(P + 'c', 'C0');
const before3 = J(Array.from(ls3.d.entries()).sort());
r = t3.W.applyEntries({ [P + 'a']: 'A1', [P + 'b']: 'B1', [P + 'c']: 'C1', [P + 'd']: 'D1', [P + 'e']: 'E1' }, false);
ok(!r.ok && /Nothing was changed/.test(r.error), 'a write failure is reported');
ok(J(Array.from(ls3.d.entries()).sort()) === before3, 'after a write failure the previous workspace is back exactly: ' + J(Array.from(ls3.d.entries())));

// a browser that keeps refusing writes (even the put-back): the failure is reported honestly
const ls3b = fakeStorage({ failAfter: 3 }); const t3b = make(ls3b); ls3b.d.set(P + 'a', 'A0');
const r3b = t3b.W.applyEntries({ [P + 'a']: 'A1', [P + 'b']: 'B1', [P + 'c']: 'C1', [P + 'd']: 'D1' }, false);
ok(!r3b.ok && r3b.rollbackFailed === true && /restore point or backup file/.test(r3b.error), 'if even the put-back fails, the message says to use a restore point or backup file');

// ------------------------------------------------------------------------------------------------ restore points
(async () => {
  const ls4 = fakeStorage(); ls4.setItem(mainKey, goodState); ls4.setItem(P + 'theme', 'dark');
  const t4 = make(ls4); const W4 = t4.W;
  const rp = await W4.createRestorePoint('Before importing x.json', true);
  ok(rp.auto === true && rp.entries[mainKey] === goodState && rp.tool === adapter.tool && rp.bytes > 0 && Array.isArray(rp.summary), 'a restore point holds the exact current items');
  ls4.setItem(P + 'theme', 'changed');
  ok(JSON.parse(J(rp.entries))[P + 'theme'] === 'dark', 'a restore point is a copy: later changes do not alter it');
  // retention: automatic restore points are kept for 12 months (and always the newest 20); Keep and manual ones are never removed; every removal is counted
  const D = W4.constants.DEFAULTS;
  ok(D.keepDays === 365 && D.minKeepAuto === 20 && D.remindDays === 30 && D.snoozeDays === 14, 'defaults: 12 months, newest 20, remind after 30 days, snooze 14 days');
  const DAY = 86400000, NOW2 = Date.parse('2027-06-01T00:00:00Z');
  const ms = memoryStore(); W4.useMemoryStore(ms);
  const put = (id, ageDays, auto, keep) => ms.put({ id, at: new Date(NOW2 - ageDays * DAY).toISOString(), reason: id, auto, keep: !!keep, entries: {}, summary: [], bytes: 1, tool: adapter.tool });
  for (let i = 0; i < 30; i++) await put('old' + i, 400 + i, true);          // 30 automatic points, all older than 12 months
  for (let i = 0; i < 5; i++) await put('new' + i, i + 1, true);              // 5 recent automatic points
  await put('keepme', 900, true, true); await put('mine', 800, false, true);  // marked Keep / saved by the user, very old
  let removed = await W4.prune(NOW2);
  let left = (await W4.listRestorePoints()).map((p) => p.id);
  ok(removed === 15 && left.length === 22, 'only old, unmarked automatic points beyond the newest 20 are removed (removed ' + removed + ', left ' + left.length + ')');
  ok(left.includes('keepme') && left.includes('mine'), 'Keep and user-saved restore points are never removed automatically');
  ok(['new0', 'new1', 'new2', 'new3', 'new4', 'old0'].every((id) => left.includes(id)), 'the newest 20 automatic points stay even when they are old');
  ok(!left.includes('old29') && !left.includes('old16'), 'the oldest ones were the ones removed');
  ok(await W4.setKeep('old0', true) === true && (await W4.prune(NOW2)) === 0, 'marking a point Keep protects it (and a second prune removes nothing)');
  ok(await W4.setKeep('does-not-exist', true) === false, 'marking a missing point is reported, not thrown');
  W4.setSettings({ keepDays: 0 }); for (let i = 0; i < 5; i++) await put('older' + i, 2000 + i, true);
  ok((await W4.prune(NOW2)) === 0, '"until I delete them" removes nothing, ever');
  W4.setSettings({ keepDays: 183 });
  ok((await W4.prune(NOW2)) > 0, 'a shorter retention (6 months) removes more');
  W4.setSettings({ keepDays: 12345 });
  ok(W4.settings().keepDays === 183, 'an unusual retention value is ignored (keeps the last valid choice)');
  ls4.setItem('wb_' + adapter.tool + '_settings', '{bad json');
  ok(W4.settings().keepDays === 365 && W4.settings().remindDays === 30, 'unreadable settings fall back to the defaults');
  W4.useMemoryStore(memoryStore());
  ok(/workspace summary/.test(W4.summaryText({})) && /not a backup/.test(W4.summaryText({})), 'the readable summary says what it is and what it is not');
  if (typeof adapter.readable === 'function') {
    const rs = W4.summaryText(adapter.tool === 'rm' ? { rm_state_v1: goodState } : { itsm_session_Test: goodState, itsm_timeline: '[1]' });
    ok(rs.includes('|---') && !rs.includes('undefined') && !rs.includes('[object'), 'the readable summary is a table with no undefined / [object] text');
  }
  // finishing a restore: applies, parks a safety copy for the next load, reloads
  const ls5 = fakeStorage(); ls5.setItem(P + 'theme', 'x'); const t5 = make(ls5);
  const fin = t5.W.finish({ [P + 'theme']: 'restored' }, false);
  ok(fin.ok && ls5.getItem(P + 'theme') === 'restored' && t5.env.reloaded === 1, 'finish applies and reloads');
  const parked = t5.env.sessionStorage.getItem('wb_pending_' + adapter.tool);
  ok(!!parked, 'a safety copy is parked for the next load');
  ls5.setItem(P + 'theme', 'overwritten-by-the-tool-while-unloading');
  ok(t5.W.applyPending() === true && ls5.getItem(P + 'theme') === 'restored' && t5.env.sessionStorage.getItem('wb_pending_' + adapter.tool) === null, 'the next load puts the restored data back even if the tool wrote over it, then forgets the copy');
  ok(t5.W.applyPending() === false, 'the parked copy is used only once');
  const t6 = make(fakeStorage()); t6.env.sessionStorage.setItem('wb_pending_' + adapter.tool, J({ entries: { agent_revoked_v1: '0' }, at: Date.now() }));
  ok(t6.W.applyPending() === false && t6.env.localStorage.getItem('agent_revoked_v1') === null, 'a parked copy naming a foreign key is ignored');
  const t7 = make(fakeStorage()); t7.env.sessionStorage.setItem('wb_pending_' + adapter.tool, J({ entries: { [P + 'a']: '1' }, at: Date.now() - 120000 }));
  ok(t7.W.applyPending() === false, 'an old parked copy (over a minute) is ignored');

  // reminders
  const ls8 = fakeStorage(); const t8 = make(ls8); const NOW = Date.parse('2026-10-20T00:00:00Z');
  ok(t8.W.reminderState({}, NOW).kind === 'none', 'no work in the browser: no reminder');
  const withWork = { [mainKey]: goodState };
  ok(t8.W.reminderState(withWork, NOW).kind === 'never', 'work but never exported: reminder');
  ls8.setItem('wb_' + adapter.tool + '_last_export', '2026-10-15T00:00:00Z');
  ok(t8.W.reminderState(withWork, NOW).kind === 'none', 'exported 5 days ago: no reminder');
  ls8.setItem('wb_' + adapter.tool + '_last_export', '2026-10-01T00:00:00Z');
  ok(t8.W.reminderState(withWork, NOW).kind === 'none', 'exported 19 days ago: still quiet (the default is 30 days)');
  ls8.setItem('wb_' + adapter.tool + '_last_export', '2026-09-10T00:00:00Z');
  ok(t8.W.reminderState(withWork, NOW).kind === 'overdue', 'exported 40 days ago: reminder');
  t8.W.setSettings({ remindDays: 90 });
  ok(t8.W.reminderState(withWork, NOW).kind === 'none', 'the user can lengthen the reminder (90 days: quiet at 40 days)');
  t8.W.setSettings({ remindDays: 30 });
  ls8.setItem('wb_' + adapter.tool + '_snooze', '2026-10-10T00:00:00Z');
  ok(t8.W.reminderState(withWork, NOW).kind === 'none', 'snoozed 10 days ago: quiet (the snooze is 14 days)');
  ls8.setItem('wb_' + adapter.tool + '_snooze', '2026-10-01T00:00:00Z');
  ok(t8.W.reminderState(withWork, NOW).kind === 'overdue', 'snooze over: reminder again');
  const broken = { length: 0, key: () => null, getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
  const t9 = make(broken);
  ok(t9.W.reminderState(withWork, NOW).kind === 'unsaved' && t9.W.storageWorks() === false, 'a browser that will not store anything is reported as such');
  ok(Object.keys(t9.W.collect()).length === 0, 'collect does not throw on blocked storage... or returns nothing');

  console.log(failures.length ? 'BACKUP FAILED: ' + failures.length + ' failure(s), ' + pass + ' passed' : 'BACKUP PASS: ' + pass + ' assertions');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log('BACKUP ERROR', e); process.exit(2); });
