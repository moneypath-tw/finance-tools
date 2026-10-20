// 線上版瀏覽器實測（離線、無 npm 套件）：在 localhost 起靜態伺服器，用無頭 Chrome 的 DevTools 協定檢查
// 真實保存資料能還原、離線快取註冊、斷網仍可開啟、被 iframe 嵌入時會跳出。node --test 測不到這些瀏覽器行為。
// Usage: node scripts/online-browser-check.mjs        （CHROME 環境變數可改 Chrome 路徑）
// Exit 0 全部通過；1 任一項失敗或找不到 Chrome。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.md': 'text/plain; charset=utf-8' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
// localhost（不是 127.0.0.1）：sw-register.js 只在 https 或 localhost 註冊；iframe 測試另用同源頁面
const base = `http://localhost:${server.address().port}`;
const port = 9400 + Math.floor(Math.random() * 500);
const chrome = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => fs.existsSync(p));
if (!chrome) { console.error('找不到 Chrome；請設定 CHROME 環境變數'); process.exit(1); }
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-mp-'));
const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0; const pending = new Map(); const events = [];
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {} }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); } else if (d.method) events.push(d); });
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  const go = async (url) => { await send('Page.navigate', { url }); await sleep(2500); };

  // 1. real saved state: sample config + ledger put where the app keeps them, then a fresh load
  const sampleLedger = JSON.parse(fs.readFileSync(path.join(root, 'sample-data/ledger.sample.json'), 'utf8'));
  const sampleConfig = JSON.parse(fs.readFileSync(path.join(root, 'sample-data/config.sample.json'), 'utf8'));
  await go(`${base}/README.md`); // same origin, no app: nothing saves over the injected state on unload
  const envelope = { schemaVersion: 1, savedAt: '2026-10-01T00:00:00.000Z', config: sampleConfig, ledger: sampleLedger };
  await evaluate(`localStorage.setItem('finance-tools.workspace.v1', ${JSON.stringify(JSON.stringify(envelope))}); true`);
  events.length = 0;
  await go(`${base}/index.html`);
  const errs = events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails.exception?.description?.split('\n')[0]);
  check('no page exceptions after restoring saved state', errs.length === 0, errs.join(' | '));
  const rejected = await evaluate(`localStorage.getItem('finance-tools.workspace.rejected')`);
  check('saved sample workspace accepted (not moved to .rejected)', rejected === null);
  const firstId = sampleLedger.entries?.[0]?.id;
  const kept = await evaluate(`JSON.parse(localStorage.getItem('finance-tools.workspace.v1')).ledger.entries.some(e => e.id === ${JSON.stringify(firstId)})`);
  check('sample ledger entries still in storage after load', kept, `first id ${firstId}`);
  check('storage notice no longer says Edge only', !(await evaluate(`document.body.innerText.includes('Edge 本機')`)));

  // 2. service worker + cache
  const sw = await evaluate(`navigator.serviceWorker.ready.then(r => r.active && r.active.state)`);
  check('service worker active', sw === 'activated', sw);
  await go(`${base}/index.html`);
  const cached = await evaluate(`caches.open('moneypath-static-v1').then(c => c.keys()).then(k => k.length)`);
  check('precache holds all static files', cached >= 13, `${cached} entries`);

  // 3. offline reload still renders the app with the saved data
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await go(`${base}/index.html`);
  const offlineOk = await evaluate(`!!document.querySelector('#panel-health') && typeof App === 'object' && document.querySelector('#allocation-dashboard').children.length > 0`);
  check('offline reload renders the app', offlineOk);
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  // 4. framing: a page that embeds the app gets replaced by the app itself
  await go(`${base}/README.md`);
  await evaluate(`document.body.innerHTML = '<iframe src="index.html" width="400" height="300"></iframe>'; true`);
  await sleep(2500);
  const topUrl = await evaluate('location.href');
  check('embedding page busted to top-level app', topUrl.endsWith('/index.html'), topUrl);
} catch (err) { check('test harness', false, err.message); }
finally {
  try { ws?.close(); } catch {}
  // Windows 上 proc.kill() 只殺主行程，子行程會留著佔住除錯埠，下次執行就卡住
  if (process.platform === 'win32') spawn('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { stdio: 'ignore' }); else proc.kill();
  server.close();
  await sleep(1500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
