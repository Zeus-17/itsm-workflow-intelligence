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
    const ctx = await browser.newContext(), page = await ctx.newPage();
    const t0 = Date.now();
    try {
      await page.goto(base + '/' + rel, { waitUntil: 'load' });
      await page.waitForFunction((re) => { const el = document.getElementById('status'); return !!el && new RegExp(re).test(el.textContent); }, DONE.source, { timeout: 300000, polling: 500 });
      const text = (await page.textContent('#status')).trim();
      const ok = /^(PASS|PARITY PASS)/.test(text);
      note(ok, BROWSER + ' / ' + name, ok ? text.slice(0, 160) : text + '\n' + ((await page.textContent('#out').catch(() => '')) || '').slice(0, 900), (Date.now() - t0) / 1000);
    } catch (e) { note(false, BROWSER + ' / ' + name, String(e.message).slice(0, 400), (Date.now() - t0) / 1000); }
    await ctx.close();
  }
}

async function fileTests(browser) {
  const ctx = await browser.newContext(), page = await ctx.newPage();
  const errors = [], requests = new Set();
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
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
    if (!info.layers.every((l) => /:object$/.test(l))) bad.push('agent layer modules missing: ' + info.layers.join(' '));
    if (!info.engineReady || !info.engineReady.ok) bad.push('engine exports not ready: ' + JSON.stringify(info.engineReady));
    if (!/^\{/.test(info.engineProbe)) bad.push('engine probe failed: ' + info.engineProbe);
    if (info.localStorage !== 'ok') bad.push('localStorage: ' + info.localStorage);
    if (info.indexedDB !== 'ok') bad.push('indexedDB: ' + info.indexedDB);
    if (errors.length) bad.push('page errors: ' + errors.slice(0, 5).join(' | '));
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
    if (ONLY === 'all' || ONLY === 'http') { srv = await serve(); await httpTests(browser, 'http://127.0.0.1:' + srv.address().port); }
    if (ONLY === 'all' || ONLY === 'file') await fileTests(browser);
  } finally { await browser.close(); if (srv) srv.close(); }
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' browser tests passed on ' + BROWSER + (failed.length ? '; FAILED: ' + failed.map((f) => f.name).join(' | ') : ''));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('browser-tests error:', e); process.exit(2); });
