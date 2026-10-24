#!/usr/bin/env node
/*
 * REAL-BROWSER TESTS (Master Plan phase K) - the same file lives in both repos (it reads agent-layer/config.json to know which tool it is in).
 *
 *   cd ci && npm ci
 *   node browser-tests.js --browser chromium            # also: firefox | webkit | msedge | chrome (system browsers, no download)
 *   node browser-tests.js --browser msedge --only file  # only the downloaded-file (file://) smoke test
 *
 * 1. HTTP mode: serves the repository over a local web server and opens each in-repo runner page in a fresh browser context. Each runner
 *    drives the REAL tool in an iframe (engine regression against the baseline, engine parity, markup safety, escaping snapshot) and prints a
 *    result line in #status. This script waits for it and requires it to start with PASS.
 * 2. FILE mode: opens the tool straight from disk (file://), the way a downloaded copy is used, and checks that it loads without errors, that the
 *    agent layer and engine exports are present, that saved data (localStorage) and the audit store (IndexedDB) work, and records every network request
 *    the page makes (evidence for the "no network" work: nothing is claimed here, the list is simply reported).
 * Exit code 0 only if every test passes.
 */
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');
const pw = require('playwright-core');

const REPO = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const BROWSER = opt('browser', 'chromium'), ONLY = opt('only', 'all'), QUICK = args.includes('--quick');
const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'agent-layer', 'config.json'), 'utf8'));
const TOOL_HTML = path.basename(cfg.html), TOOL = cfg.tool;

const PAGES = TOOL === 'rm'
  ? [['engine regression baseline', 'tests/rm-regression-runner.html'], ['engine parity (export vs real engines)', 'tests/rm-parity-runner.html'],
     ['markup safety probe', 'tests/rm-markup-runner.html?mode=probe'], ['escaping snapshot', 'tests/rm-markup-runner.html?mode=snapshot']]
  : [['engine regression baseline', 'tests/itsm-regression-runner.html'], ['engine parity (export vs real engines)', 'tests/itsm-parity-runner.html'],
     ['markup safety probe', 'tests/itsm-markup-runner.html?mode=probe'], ['escaping snapshot', 'tests/itsm-markup-runner.html?mode=snapshot']];
const DONE = /^(PASS|PARITY PASS|DIFF|PARITY FAILED|SNAPSHOT DIFFERS|MARKUP RAN|Runner error|Recorded)/;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.resolve(REPO, rel);
      if (!file.startsWith(REPO + path.sep) || rel.split('/').includes('node_modules') || rel.split('/').includes('.git')) { res.writeHead(403); return res.end('forbidden'); }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(buf);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function launch() {
  const sys = { msedge: 'msedge', chrome: 'chrome' };
  if (sys[BROWSER]) return pw.chromium.launch({ channel: sys[BROWSER], headless: true });
  if (!pw[BROWSER]) throw new Error('unknown browser ' + BROWSER);
  return pw[BROWSER].launch({ headless: true });
}

const results = [];
// In GitHub Actions a failure also becomes an ANNOTATION on the run (readable without logging in), so the reason is visible from the run summary.
const CR = String.fromCharCode(13), LF = String.fromCharCode(10);
const annotate = (name, detail) => {
  if (!process.env.GITHUB_ACTIONS) return;
  const title = String(name).split(':').join(' ').split(',').join(' ').split(CR).join(' ').split(LF).join(' ');
  const body = String(detail || 'failed').slice(0, 900).split('%').join('%25').split(CR).join('%0D').split(LF).join('%0A');
  console.log('::error title=' + title + '::' + body);
};
const note = (ok, name, detail, secs) => { results.push({ ok, name }); if (!ok) annotate(name, detail); console.log((ok ? 'PASS ' : 'FAIL ') + name + (secs !== undefined ? '  (' + secs.toFixed(1) + 's)' : '') + (detail ? '\n      ' + String(detail).replace(/\n/g, '\n      ').slice(0, 1500) : '')); };

async function httpTests(browser, base) {
  for (const [name, rel] of PAGES) {
    if (QUICK && /snapshot|probe/.test(rel)) continue;
    // Deterministic runs: no service worker (RM's registers one that force-reloads every open page once it activates, which restarted the runner
    // page in Firefox/WebKit) and no outside network (the tools fetch fonts and a GitHub-hosted content file whose arrival time changed what was on screen).
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    await ctx.route((u) => !u.href.startsWith(base + '/'), (r) => r.abort());
    const page = await ctx.newPage();
    const t0 = Date.now(), seen = [];
    page.on('pageerror', (e) => seen.push('pageerror: ' + String(e.message).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') seen.push(m.type() + ': ' + m.text().slice(0, 200)); });
    page.on('requestfailed', (r) => seen.push('request failed: ' + r.url().replace(/\?.*$/, '') + ' ' + ((r.failure() || {}).errorText || '')));
    try {
      await page.goto(base + '/' + rel, { waitUntil: 'load' });
      await page.waitForFunction((re) => { const el = document.getElementById('status'); return !!el && new RegExp(re).test(el.textContent); }, DONE.source, { timeout: 120000, polling: 500 });
      const text = (await page.textContent('#status')).trim();
      const ok = /^(PASS|PARITY PASS)/.test(text);
      note(ok, BROWSER + ' / ' + name, ok ? text.slice(0, 160) : text + '\n' + ((await page.textContent('#out').catch(() => '')) || '').slice(0, 900), (Date.now() - t0) / 1000);
    } catch (e) {
      // Diagnostics for a hang: what the runner page said, whether the tool frame loaded, and any errors / failed requests the browser reported.
      const diag = await page.evaluate(() => { const f = document.getElementById('tool'); let st = ''; try { st = f && f.contentDocument ? f.contentDocument.readyState : 'no frame doc'; } catch (x) { st = 'frame access: ' + x.message; } return 'status="' + ((document.getElementById('status') || {}).textContent || '') + '" frame.readyState=' + st + ' out="' + ((document.getElementById('out') || {}).textContent || '').slice(0, 200) + '"'; }).catch((x) => 'page unreadable: ' + x.message);
      note(false, BROWSER + ' / ' + name, String(e.message).slice(0, 120) + ' | ' + diag + ' | browser said: ' + (seen.slice(0, 6).join(' ;; ') || 'nothing'), (Date.now() - t0) / 1000);
    }
    await ctx.close();
  }
}

/* Workspace backup and restore points (W6) in a real browser: a real download, a real file upload, a real reload and real IndexedDB. */
async function backupTests(browser, base) {
  const NAME = BROWSER + ' / workspace backup and restore (download, import, restore point, hostile file, unescaped text)';
  const ctx = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
  await ctx.route((u) => !u.href.startsWith(base + '/'), (r) => r.abort());
  const page = await ctx.newPage(), t0 = Date.now(), bad = [], errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wb-'));
  const settle = () => page.waitForTimeout(700);
  try {
    const seed = TOOL === 'rm'
      ? { rm_state_v1: JSON.stringify({ releases: [{ id: 'e2e1', name: 'E2E release', type: 'minor', gates: [], rag: 'green', status: 'planning', environments: {}, envPath: ['DEV'] }], defects: [], dora: {}, settings: {} }), rm_theme: 'dark' }
      : { itsm_session_E2E: JSON.stringify({ sev: 'P2', savedAt: Date.now() }), itsm_timeline: JSON.stringify([{ t: 'x' }]), itsm_theme: 'dark' };
    await page.goto(base + '/' + TOOL_HTML, { waitUntil: 'load' });
    await page.evaluate((entries) => { localStorage.clear(); Object.keys(entries).forEach((k) => localStorage.setItem(k, entries[k])); }, seed);
    await page.reload({ waitUntil: 'load' }); await settle();
    const collect = () => page.evaluate(() => WorkspaceBackup.collect());
    const original = await collect();
    // the tool itself may add its own saved items while loading (for example empty lists): the seeded items must all be there, and are compared by value below
    Object.keys(seed).forEach((k) => { if (original[k] !== seed[k] && !(k === 'rm_state_v1')) bad.push('seeded item missing or changed: ' + k); });
    const differing = (a, b) => Array.from(new Set(Object.keys(a).concat(Object.keys(b)))).filter((k) => a[k] !== b[k]).map((k) => k + ' (' + String(a[k]).slice(0, 40) + ' -> ' + String(b[k]).slice(0, 40) + ')').join('; ');

    // 1. a real download of the backup file, and the reminder bookkeeping
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.evaluate(() => document.getElementById('wb-export').click())]);
    const file = path.join(tmp, dl.suggestedFilename()); await dl.saveAs(file);
    const text = fs.readFileSync(file, 'utf8');
    const parsed = await page.evaluate((t) => { const r = WorkspaceBackup.parse(t); return { ok: r.ok, errors: r.errors, n: r.entries && Object.keys(r.entries).length }; }, text);
    if (!parsed.ok || parsed.n !== Object.keys(original).length) bad.push('the downloaded file is not a valid backup: ' + JSON.stringify(parsed));
    if (!/-workspace-backup-\d{4}-\d\d-\d\d\.json$/.test(dl.suggestedFilename())) bad.push('unexpected file name ' + dl.suggestedFilename());
    if (!(await page.evaluate((t) => !!localStorage.getItem('wb_' + t + '_last_export'), TOOL))) bad.push('the export time was not recorded');

    // 2. wipe the workspace, import the file through the real file input, confirm in the real dialog
    await page.evaluate(() => { Object.keys(WorkspaceBackup.collect()).forEach((k) => localStorage.removeItem(k)); });
    if (Object.keys(await collect()).length) bad.push('the test could not empty the workspace');
    await page.setInputFiles('#wb-file', file);
    await page.waitForSelector('#wb-dialog[open] #wb-confirm', { timeout: 8000 });
    const dlgText = await page.textContent('#wb-dialog');
    if (!/Replace your data with this backup/.test(dlgText) || !/In the file/.test(dlgText)) bad.push('the import preview did not show: ' + dlgText.slice(0, 120));
    await Promise.all([page.waitForEvent('load', { timeout: 20000 }), page.click('#wb-confirm')]);
    await settle();
    const restored = await collect();
    if (differing(original, restored)) bad.push('after the import the workspace is not what was exported: ' + differing(original, restored));
    if (await page.evaluate((t) => sessionStorage.getItem('wb_pending_' + t), TOOL)) bad.push('the parked safety copy was not consumed');
    const points = await page.evaluate(() => WorkspaceBackup.listRestorePoints().then((a) => a.map((p) => p.reason + '|' + p.auto)));
    if (!points.some((p) => /^Before importing .*\|true$/.test(p))) bad.push('no automatic restore point was saved before the import: ' + points.join(' ; '));

    // 3. a file that names a key outside the tool is refused and nothing changes
    const hostile = JSON.parse(text); hostile.entries.agent_revoked_v1 = '0'; hostile.keyCount += 1;
    const hf = path.join(tmp, 'hostile.json'); fs.writeFileSync(hf, JSON.stringify(hostile));
    await page.setInputFiles('#wb-file', hf);
    await page.waitForSelector('#wb-dialog[open]', { timeout: 8000 });
    const ht = await page.textContent('#wb-dialog');
    if (!/cannot be loaded/.test(ht) || !/does not belong/.test(ht)) bad.push('the hostile file was not refused: ' + ht.slice(0, 140));
    await page.evaluate(() => document.getElementById('wb-dialog').close());
    { const now = await collect(); if (differing(original, now) || (await page.evaluate(() => localStorage.getItem('agent_revoked_v1'))) !== null) bad.push('the hostile file changed something: ' + differing(original, now)); }

    // 4. restore points survive a reload (real IndexedDB) and a restore brings the data back; text typed into a label stays text
    const PAYLOAD = '<img src=x onerror="window.__xss=1">';
    await page.evaluate((p) => WorkspaceBackup.createRestorePoint(p, false), PAYLOAD);
    await page.evaluate(() => { Object.keys(WorkspaceBackup.collect()).forEach((k) => localStorage.removeItem(k)); });
    await page.reload({ waitUntil: 'load' }); await settle();
    const panel = await page.evaluate(() => ({ imgs: document.querySelectorAll('#wb-panel img').length, xss: window.__xss || 0, text: document.getElementById('wb-panel').textContent }));
    if (panel.imgs || panel.xss) bad.push('a restore point label was treated as markup');
    if (!panel.text.includes(PAYLOAD)) bad.push('the label was not shown as plain text');
    const rows = await page.evaluate(() => [...document.querySelectorAll('#wb-panel .wb-pt')].map((r) => r.firstElementChild.firstElementChild.textContent));
    const idx = rows.findIndex((r) => r.includes('onerror'));
    if (idx < 0) bad.push('the restore point is not listed after a reload');
    else {
      await page.evaluate((i) => document.querySelectorAll('#wb-panel .wb-pt')[i].querySelector('button').click(), idx);
      await page.waitForSelector('#wb-dialog[open] #wb-confirm', { timeout: 8000 });
      await Promise.all([page.waitForEvent('load', { timeout: 20000 }), page.click('#wb-confirm')]);
      await settle();
      { const now = await collect(); if (differing(original, now)) bad.push('restoring the restore point did not bring the data back: ' + differing(original, now)); }
    }
    // 5. a restore point can be downloaded as an ordinary backup file (for filing in a wiki or record); the readable summary can be copied; the settings stick
    const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.evaluate(() => { const b = [...document.querySelectorAll('#wb-panel .wb-pt button')].find((x) => x.textContent === 'Download'); if (b) b.click(); else throw new Error('no Download button on a restore point'); })]);
    const f2 = path.join(tmp, dl2.suggestedFilename()); await dl2.saveAs(f2);
    if (!/-restore-point-\d{4}-\d\d-\d\d\.json$/.test(dl2.suggestedFilename())) bad.push('unexpected restore point file name ' + dl2.suggestedFilename());
    const ok2 = await page.evaluate((t) => WorkspaceBackup.parse(t).ok, fs.readFileSync(f2, 'utf8'));
    if (!ok2) bad.push('a downloaded restore point is not a valid backup file');
    await page.evaluate(() => document.getElementById('wb-copy').click());
    await page.waitForFunction(() => !!document.getElementById('wb-summary') || /Summary copied/.test(document.body.textContent), null, { timeout: 8000 }).catch(() => bad.push('copying the summary neither copied nor showed the text to copy'));
    const sumText = await page.evaluate(() => { const t = document.getElementById('wb-summary'); return t ? t.value : null; });
    if (sumText !== null && (!/workspace summary/.test(sumText) || /undefined/.test(sumText))) bad.push('the summary text is wrong: ' + sumText.slice(0, 100));
    await page.evaluate(() => { const d = document.getElementById('wb-dialog'); if (d && d.open) d.close(); });
    await page.evaluate(() => { const s = document.getElementById('wb-keep-days'); s.value = '0'; s.dispatchEvent(new Event('change')); });
    if ((await page.evaluate(() => WorkspaceBackup.settings().keepDays)) !== 0) bad.push('the retention setting did not stick');
    await page.reload({ waitUntil: 'load' }); await settle();
    if ((await page.evaluate(() => WorkspaceBackup.settings().keepDays)) !== 0) bad.push('the retention setting did not survive a reload');
    await page.evaluate(() => WorkspaceBackup.setSettings({ keepDays: 365 }));

    // 6. close to the browser's storage limit: an import that cannot fit is refused cleanly and the data is exactly as it was
    const before6 = await collect();
    // fill the origin's storage EXACTLY (large pieces first, then smaller ones), then free 30,000 characters: far less than the 60,000 the import needs
    const headroom = await page.evaluate(() => {
      const fill = (size, prefix) => { const c = 'x'.repeat(size); let n = 0; try { for (;; n++) localStorage.setItem(prefix + n, c); } catch (e) { /* full at this size */ } return n; };
      fill(100000, 'zz_a_'); fill(10000, 'zz_b_'); fill(1000, 'zz_c_'); fill(100, 'zz_d_'); fill(1, 'zz_e_');
      localStorage.removeItem('zz_a_0'); localStorage.setItem('zz_tail', 'x'.repeat(70000));
      let can = 0; try { localStorage.setItem('zz_probe', 'y'.repeat(60000)); can = 1; localStorage.removeItem('zz_probe'); } catch (e) { /* expected */ }
      return can;
    });
    if (headroom) bad.push('test set-up: the storage was not full enough to prove the point');
    const big = JSON.parse(text); const pre = TOOL === 'rm' ? 'rm_' : 'itsm_'; big.entries[pre + 'zz_big'] = 'y'.repeat(60000); big.keyCount += 1;
    const bf = path.join(tmp, 'big.json'); fs.writeFileSync(bf, JSON.stringify(big));
    await page.setInputFiles('#wb-file', bf);
    await page.waitForSelector('#wb-dialog[open] #wb-confirm', { timeout: 8000 });
    await page.click('#wb-confirm');
    await page.waitForFunction(() => { const e = document.getElementById('wb-err'); return e && e.style.display === 'block'; }, null, { timeout: 15000 }).catch(() => bad.push('no message when the data would not fit'));
    const errText = await page.evaluate(() => (document.getElementById('wb-err') || {}).textContent || '');
    if (!/would not store|Nothing was changed/.test(errText)) bad.push('unclear message when the data would not fit: ' + errText.slice(0, 120));
    await page.evaluate(() => { const d = document.getElementById('wb-dialog'); if (d && d.open) d.close(); Object.keys(localStorage).filter((k) => k.indexOf('zz_') === 0).forEach((k) => localStorage.removeItem(k)); });
    { const now = await collect(); if (differing(before6, now)) bad.push('a refused import changed the data: ' + differing(before6, now)); }
    if (errors.length) bad.push('page errors: ' + errors.slice(0, 3).join(' | '));
  } catch (e) { bad.push('error: ' + String(e.message).slice(0, 300)); }
  await ctx.close(); fs.rmSync(tmp, { recursive: true, force: true });
  note(bad.length === 0, NAME, bad.join('\n') || 'export, import, restore points (download, keep, settings), the copyable summary, refusal of a file naming a foreign key, an import that cannot fit a full browser store, and plain-text labels all behave', (Date.now() - t0) / 1000);
}

async function changeStateTests(browser, base) {
  // ITSM only: the change form's six risk factors (Stage 5 and the standalone form) and the lifecycle step must survive
  // autosave + restore, named sessions, "restore last", session export -> reset -> import; bad values are refused; old saves still load.
  if (TOOL !== 'itsm') return;
  const NAME = BROWSER + ' / change form persists (risk factors, standalone factors, lifecycle step)';
  const ctx = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
  await ctx.route((u) => !u.href.startsWith(base + '/'), (r) => r.abort());
  const page = await ctx.newPage(), t0 = Date.now(), bad = [], errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('dialog', (d) => d.type() === 'prompt' ? d.accept('E2E change session') : d.dismiss());
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cs-'));
  const state = () => page.evaluate(() => ({ cs: getChangeState(), active: CHANGE_STATE_SCR.map((id) => Array.from(document.querySelectorAll('.rf-btn.active')).filter((b) => (b.getAttribute('onclick') || '').indexOf("'" + id + "'") >= 0).map((b) => b.getAttribute('onclick').split(',')[1]).join('/')), dot: (document.getElementById('cl_approve') || {}).className, num: (document.getElementById('riskScoreNum') || {}).textContent }));
  try {
    await page.goto(base + '/' + TOOL_HTML, { waitUntil: 'load' });
    await page.evaluate(() => localStorage.clear()); await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(500);
    // answer the six Stage 5 factors with the second real option of each, two standalone factors, and advance the lifecycle to "Approved"
    const want = await page.evaluate(() => {
      const rf = {}; let total = 0;
      CHANGE_STATE_RF.forEach((id) => { const el = document.getElementById(id); el.value = el.options[2].value; el.dispatchEvent(new Event('change')); rf[id] = el.value; total += parseInt(el.value, 10); });
      const click = (id, v) => Array.from(document.querySelectorAll('.rf-btn')).find((b) => b.getAttribute('onclick') === "setRiskFactor('" + id + "'," + v + ",this)").click();
      click('scr_rf_testing', 15); click('scr_rf_timing', 5);
      resetChangeLifecycle(); advanceChangeLifecycle(); advanceChangeLifecycle(); advanceChangeLifecycle();
      return { rf, total, step: changeLifecycleStep };
    });
    if (want.step !== 3) bad.push('could not advance the lifecycle to Approved (step ' + want.step + ')');
    const check = async (label) => {
      const s = await state();
      Object.keys(want.rf).forEach((id) => { if (s.cs.rf[id] !== want.rf[id]) bad.push(label + ': ' + id + ' is ' + s.cs.rf[id] + ', expected ' + want.rf[id]); });
      if (s.cs.scr.scr_rf_testing !== '15' || s.cs.scr.scr_rf_timing !== '5' || s.cs.scr.scr_rf_blast !== '0') bad.push(label + ': standalone factors wrong ' + JSON.stringify(s.cs.scr));
      if (s.active.join(' ') !== '0 0 0 15 0 5') bad.push(label + ': highlighted standalone buttons wrong (' + s.active.join(' ') + ')');
      if (s.cs.lifecycleStep !== 3 || !/current/.test(s.dot || '')) bad.push(label + ': lifecycle not at Approved (step ' + s.cs.lifecycleStep + ', dot "' + s.dot + '")');
      if (String(want.total) !== String(s.num)) bad.push(label + ': risk score shows ' + s.num + ', expected ' + want.total);
    };
    // 1. autosave writes it; a fresh page restores it
    await page.waitForTimeout(2200);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('itsm_session') || '{}').changeState || null);
    if (!saved || saved.lifecycleStep !== 3) bad.push('autosave did not store the change state: ' + JSON.stringify(saved));
    await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(500);
    await page.evaluate(() => restoreSession()); await page.waitForTimeout(300); await check('restore session');
    // 2. restore last
    await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(500);
    await page.evaluate(() => restoreLastSession()); await page.waitForTimeout(300); await check('restore last');
    // 3. named session: save, reset everything, load it back
    await page.evaluate(() => saveNamedSession()); await page.waitForTimeout(300);
    await page.evaluate(() => executeResetAll()); await page.waitForTimeout(300);
    const cleared = await state();
    if (cleared.cs.lifecycleStep !== 0 || Object.values(cleared.cs.scr).some((v) => v !== '0') || cleared.active.join(' ') !== '0 0 0 0 0 0') bad.push('reset did not clear the change form: ' + JSON.stringify(cleared));
    await page.evaluate(() => { const key = getAllSessions()[0]; loadSessionByKey(typeof key === 'string' ? key : key.key); }); await page.waitForTimeout(400); await check('named session');
    // 4. session file: export, reset, import through the real file picker
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.evaluate(() => exportSessionJSON())]);
    const file = path.join(tmp, dl.suggestedFilename()); await dl.saveAs(file);
    if (!JSON.parse(fs.readFileSync(file, 'utf8')).changeState) bad.push('the exported session file has no changeState');
    await page.evaluate(() => executeResetAll()); await page.waitForTimeout(300);
    const [fc] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), page.evaluate(() => importSessionJSON())]);
    await fc.setFiles(file); await page.waitForTimeout(800); await check('session file import');
    // 5. bad values are refused and change nothing
    const before = await state();
    const refused = await page.evaluate(() => applyChangeState({ rf: { rf_blast: '999', rf_timing: '<img src=x onerror=alert(1)>' }, scr: { scr_rf_blast: '7', scr_rf_history: 'javascript:1' }, lifecycleStep: 42 }));
    const after = await state();
    if (refused !== false || JSON.stringify(after) !== JSON.stringify(before)) bad.push('bad values were not refused cleanly: ' + JSON.stringify({ refused, before, after }));
    // 6. a save made before this feature (no changeState) still restores, without inventing a change state
    await page.evaluate(() => { executeResetAll(); localStorage.setItem('itsm_session', JSON.stringify({ sev: 'P3', i_shortdesc: 'Old save' })); }); await page.waitForTimeout(1800);
    await page.evaluate(() => localStorage.setItem('itsm_session', JSON.stringify({ sev: 'P3', i_shortdesc: 'Old save' })));
    await page.evaluate(() => restoreSession()); await page.waitForTimeout(300);
    const old = await page.evaluate(() => ({ step: changeLifecycleStep, desc: document.getElementById('i_shortdesc').value }));
    if (old.step !== 0 || old.desc !== 'Old save') bad.push('an old save did not restore cleanly: ' + JSON.stringify(old));
    if (errors.length) bad.push('page errors: ' + errors.slice(0, 5).join(' | '));
    note(bad.length === 0, NAME, bad.join('\n'), (Date.now() - t0) / 1000);
  } catch (e) { note(false, NAME, String(e.message).slice(0, 800), (Date.now() - t0) / 1000); }
  await ctx.close();
}

async function fileTests(browser) {
  const ctx = await browser.newContext(), page = await ctx.newPage();
  const errors = [], requests = new Set(), failed = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text() + ' [' + String((m.location() || {}).url || '').replace(/\?.*$/, '').slice(0, 120) + ']'); });
  page.on('requestfailed', (r) => failed.push(r.url().replace(/\?.*$/, '').slice(0, 120) + ' ' + ((r.failure() || {}).errorText || '')));
  page.on('request', (r) => { const u = r.url(); if (!u.startsWith('file:') && !u.startsWith('data:') && !u.startsWith('blob:') && !u.startsWith('about:')) requests.add(r.method() + ' ' + u.replace(/\?.*$/, '')); });
  const t0 = Date.now();
  try {
    await page.goto(pathToFileURL(path.join(REPO, TOOL_HTML)).href, { waitUntil: 'load' });
    await page.waitForTimeout(2500);
    const info = await page.evaluate(async (tool) => {
      const out = {};
      out.title = document.title;
      out.layers = ['AgentLayer', 'AgentAudit', 'AgentFailsafe', 'AgentEngine'].map((n) => n + ':' + (typeof window[n]));
      out.engineReady = window.AgentEngine ? window.AgentEngine.ready() : null;
      const probe = tool === 'rm' ? window.AgentEngine.run('risk_score', { likelihood: 3, impact: 4 }) : window.AgentEngine.run('change_risk', { blast: 5, complexity: 5, rollback: 2, testing: 2, history: 2, timing: 2 });
      out.engineProbe = probe.status === 'computed' ? JSON.stringify(probe.output) : probe.status + ':' + probe.reason;
      try { localStorage.setItem('__k_probe', 'ok'); out.localStorage = localStorage.getItem('__k_probe'); localStorage.removeItem('__k_probe'); } catch (e) { out.localStorage = 'ERR ' + e.message; }
      out.indexedDB = await new Promise((resolve) => {
        try {
          const rq = indexedDB.open('__k_probe_db', 1);
          rq.onupgradeneeded = () => rq.result.createObjectStore('s');
          rq.onsuccess = () => { const db = rq.result; const tx = db.transaction('s', 'readwrite'); tx.objectStore('s').put('ok', 'k'); tx.oncomplete = () => { const g = db.transaction('s').objectStore('s').get('k'); g.onsuccess = () => { db.close(); indexedDB.deleteDatabase('__k_probe_db'); resolve(g.result); }; }; tx.onerror = () => resolve('ERR tx'); };
          rq.onerror = () => resolve('ERR ' + (rq.error && rq.error.name));
          setTimeout(() => resolve('ERR timeout'), 5000);
        } catch (e) { resolve('ERR ' + e.message); }
      });
      out.auditStorage = window.AgentAudit && window.AgentAudit.log ? window.AgentAudit.log().status().storage_kind : null;
      return out;
    }, TOOL);
    const bad = [];
    // WebKit refuses the web-app manifest link when the page is opened from disk (origin 'null'): a browser rule about installable web apps, not a tool fault.
    if (failed.length && failed.every((f) => /manifest\.json/.test(f))) { for (let i = errors.length - 1; i >= 0; i--) if (/Access-Control-Allow-Origin/.test(errors[i])) errors.splice(i, 1); }
    if (!info.layers.every((l) => /:object$/.test(l))) bad.push('agent layer modules missing: ' + info.layers.join(' '));
    if (!info.engineReady || !info.engineReady.ok) bad.push('engine exports not ready: ' + JSON.stringify(info.engineReady));
    if (!/^\{/.test(info.engineProbe)) bad.push('engine probe failed: ' + info.engineProbe);
    if (info.localStorage !== 'ok') bad.push('localStorage: ' + info.localStorage);
    if (info.indexedDB !== 'ok') bad.push('indexedDB: ' + info.indexedDB);
    if (errors.length) bad.push('page errors: ' + errors.slice(0, 5).join(' | ') + (failed.length ? ' ;; failed requests: ' + failed.slice(0, 5).join(' | ') : ''));
    note(bad.length === 0, BROWSER + ' / downloaded file (file://) loads and works', bad.length ? bad.join('\n') : JSON.stringify({ title: info.title, engineProbe: info.engineProbe, audit_store: info.auditStorage }), (Date.now() - t0) / 1000);
    console.log('      network requests made by the page while loaded from disk (' + requests.size + '): ' + ([...requests].join('; ') || 'none'));
  } catch (e) { note(false, BROWSER + ' / downloaded file (file://) loads and works', String(e.message).slice(0, 500), (Date.now() - t0) / 1000); }
  await ctx.close();
}

(async () => {
  const browser = await launch();
  console.log('browser: ' + BROWSER + ' ' + browser.version() + '  tool: ' + TOOL + '  repo: ' + REPO);
  let srv = null;
  try {
    if (ONLY === 'all' || ONLY === 'http') { srv = await serve(); const origin = 'http://127.0.0.1:' + srv.address().port; await httpTests(browser, origin); await backupTests(browser, origin); await changeStateTests(browser, origin); }
    if (ONLY === 'all' || ONLY === 'file') await fileTests(browser);
  } finally { await browser.close(); if (srv) srv.close(); }
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' browser tests passed on ' + BROWSER + (failed.length ? '; FAILED: ' + failed.map((f) => f.name).join(' | ') : ''));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('browser-tests error:', e); process.exit(2); });
