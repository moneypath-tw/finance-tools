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
// alert()/confirm() blocks every later CDP call; dismiss it and report it as a failure instead of hanging
const dialogs = [];
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {} }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); } else if (d.method) { events.push(d); if (d.method === 'Page.javascriptDialogOpening') { dialogs.push(d.params.message); send('Page.handleJavaScriptDialog', { accept: true }); } } });
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

  // 4. estimator: type into every number field like a person (real key events), press Enter, reload.
  //    2026-10-20: mortgage / student-loan fields snapped back to defaults because a helper replaced
  //    the settings object the inputs were bound to; a JS-only value change would not have caught it.
  // fields are found by their label: an edit can add or remove other fields and shift positions
  const labelOf = `(x) => (x.closest('.field')?.querySelector('label')?.textContent || x.closest('tr')?.querySelector('input[type=text]')?.value || '?').trim()`;
  const fields = `(() => { const seen = {}; return [...document.querySelectorAll('#estimator-body input[type=number]')].map(x => { const l = (${labelOf})(x); seen[l] = (seen[l] || 0) + 1; x.dataset.probeKey = l + '#' + seen[l]; return x; }); })()`;
  const byKey = (k) => `(${fields}).find(x => x.dataset.probeKey === ${JSON.stringify(k)})`;
  const pickScenario = (id) => evaluate(`(() => { const s = document.querySelector('#scenario-select'); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const typeInto = async (index, text, { enter = true } = {}) => {
    const ok = await evaluate(`(() => { const x = ${typeof index === 'string' ? byKey(index) : `${fields}[${index}]`}; if (!x || x.disabled || x.offsetParent === null) return false; x.closest('details')?.setAttribute('open', ''); x.focus(); x.select(); return document.activeElement === x; })()`);
    if (!ok) return false;
    await send('Input.insertText', { text });
    if (enter) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    }
    await sleep(60);
    return true;
  };
  // a plausible new value next to the current one, so validation keeps the scenario usable
  const nudge = (v) => { const n = Number(v); if (!Number.isFinite(n)) return '1'; if (n > 0 && n < 1) return String(Math.round((n + 0.001) * 100000) / 100000); return String(Math.trunc(n) + 1); };
  await go(`${base}/index.html`);
  await evaluate(`document.querySelector('[data-tab=estimator]').click(); document.querySelector('[data-view-mode=detailed]')?.click(); true`);
  const scenarioIds = await evaluate(`[...document.querySelector('#scenario-select').options].map(o => o.value)`);
  const expected = [];
  for (const id of scenarioIds) {
    await pickScenario(id); await sleep(80);
    const keys = await evaluate(`${fields}.map(x => x.dataset.probeKey)`);
    for (const i of keys) {
      const before = await evaluate(`${byKey(i)}?.value`);
      const want = nudge(before);
      if (!(await typeInto(i, want))) continue;
      const shown = await evaluate(`${byKey(i)}?.value`);
      expected.push({ id, i, want, shown });
    }
  }
  // the last edit is typed but never confirmed: leaving the page must still keep it
  await pickScenario(scenarioIds[0]); await sleep(80);
  const lastKey = await evaluate(`${fields}[0]?.dataset.probeKey`);
  const lastBefore = await evaluate(`${byKey(lastKey)}?.value`);
  const lastWant = String(Number(lastBefore) + 2);
  await typeInto(lastKey, lastWant, { enter: false });
  await go(`${base}/index.html`);
  await evaluate(`document.querySelector('[data-tab=estimator]').click(); true`);
  const lost = [];
  for (const id of scenarioIds) {
    await pickScenario(id); await sleep(80);
    const values = await evaluate(`Object.fromEntries(${fields}.map(x => [x.dataset.probeKey, x.value]))`);
    for (const e of expected.filter((x) => x.id === id && !(x.id === scenarioIds[0] && x.i === lastKey))) {
      if (e.shown !== e.want || values[e.i] !== e.want) lost.push(`${id}#${e.i} want ${e.want} shown ${e.shown} reload ${values[e.i]}`);
    }
    if (id === scenarioIds[0] && values[lastKey] !== lastWant) lost.push(`${id} ${lastKey} unconfirmed edit: want ${lastWant} reload ${values[lastKey]}`);
  }
  check(`estimator: ${expected.length} typed fields kept after Enter and reload`, expected.length > 20 && lost.length === 0, lost.slice(0, 6).join(' | '));

  // 4b. income cards: a saved monthly flow without payBasis (pre-2026-10-20 data) must keep its amount,
  //     and a new hourly / per-case income typed like a person must derive gross = rate × hours / cases × fee
  await go(`${base}/README.md`);
  const legacyFlow = { id: 'legacy-job', name: '正職', type: 'income', kind: 'salary', amountCents: 3300000, monthlyWorkHours: 160, dayOfMonth: 5, accountId: 'probe-0', applyInsurance: true, insuredSalaryFollowsGross: true, active: true };
  const withFlow = { ...envelope, config: { ...sampleConfig, accountProfiles: sampleConfig.accounts.map((name, i) => ({ id: `probe-${i}`, name, nature: 'checking', initialBalanceCents: 0 })), recurringCashFlows: [legacyFlow] } };
  await evaluate(`localStorage.setItem('finance-tools.workspace.v1', ${JSON.stringify(JSON.stringify(withFlow))}); true`);
  events.length = 0;
  await go(`${base}/index.html`);
  await evaluate(`document.querySelector('[data-tab=ledger]').click(); document.querySelector('[data-view-mode=detailed]')?.click(); document.querySelectorAll('#personal-settings details').forEach(d => d.open = true); true`);
  const savedFlows = () => evaluate(`JSON.parse(localStorage.getItem('finance-tools.workspace.v1')).config.recurringCashFlows`);
  const legacyText = await evaluate(`document.querySelector('#personal-settings .flow-card .income-formula')?.textContent || ''`);
  check('legacy monthly income still shown as monthly salary', legacyText.includes('33,000') && legacyText.includes('160'), legacyText);
  const incomeInput = (card, label) => `[...document.querySelectorAll('#personal-settings .flow-card')][${card}]?.querySelector('.field input[data-probe=${JSON.stringify(label)}]')`;
  const tagInputs = `document.querySelectorAll('#personal-settings details').forEach(d => d.open = true); document.querySelectorAll('#personal-settings .field').forEach(f => { const i = f.querySelector('input'); if (i) i.dataset.probe = f.querySelector('label').textContent.trim(); })`;
  const typeIncome = async (card, label, text) => {
    const ok = await evaluate(`(() => { ${tagInputs}; const x = ${incomeInput(card, label)}; if (!x) return false; x.closest('details')?.setAttribute('open', ''); x.focus(); x.select(); return document.activeElement === x; })()`);
    if (!ok) return false;
    await send('Input.insertText', { text });
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await evaluate(`document.activeElement?.blur(); true`);
    await sleep(80);
    return true;
  };
  await evaluate(`[...document.querySelectorAll('#personal-settings button')].find(b => b.textContent === '＋時薪兼職').click(); true`);
  const typedHourly = (await typeIncome(1, '時薪', '196')) && (await typeIncome(1, '這個月工作時數', '80'));
  let flows = await savedFlows();
  check('hourly income: 196 × 80 h = 15,680', typedHourly && flows[1]?.payBasis === 'hourly' && flows[1]?.amountCents === 1568000, JSON.stringify(flows[1]));
  check('legacy income untouched by edits to another card', flows[0]?.amountCents === 3300000 && flows[0]?.payBasis === undefined);
  await evaluate(`[...document.querySelectorAll('#personal-settings button')].find(b => b.textContent === '＋接案收入').click(); true`);
  const typedCase = (await typeIncome(2, '這個月接幾件', '4')) && (await typeIncome(2, '每件大約花幾小時', '3')) && (await typeIncome(2, '案件時薪', '1000'));
  flows = await savedFlows();
  check('per-case income: 4 cases × 3 h × 1,000 = 12,000', typedCase && flows[2]?.amountCents === 1200000 && flows[2]?.monthlyWorkHours === 12, JSON.stringify(flows[2]));
  await go(`${base}/index.html`);
  const shownAfterReload = await evaluate(`[...document.querySelectorAll('#personal-settings .income-formula')].map(p => p.textContent)`);
  check('income formulas survive reload', shownAfterReload.length === 3 && shownAfterReload[1].includes('15,680') && shownAfterReload[2].includes('12,000'), shownAfterReload.join(' | '));
  // rent paid every 6 months: lump sum on the contract date, monthly average shown in the one-line summary
  await evaluate(`[...document.querySelectorAll('#personal-settings button')].find(b => b.textContent.startsWith('＋租屋')).click(); true`);
  const typedRent = await typeIncome(3, '月租（元）', '8000');
  await evaluate(`(() => { const card = [...document.querySelectorAll('#personal-settings .flow-card')][3]; const s = [...card.querySelectorAll('.field')].find(f => f.querySelector('label').textContent === '繳租方式').querySelector('select'); s.value = '6'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await evaluate(`(() => { const card = [...document.querySelectorAll('#personal-settings .flow-card')][3]; const d = [...card.querySelectorAll('.field')].find(f => f.querySelector('label').textContent === '簽約起租日').querySelector('input'); d.value = '2026-01-15'; d.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  flows = await savedFlows();
  const rentSummary = await evaluate(`[...document.querySelectorAll('#personal-settings .flow-card')][3]?.querySelector('summary').textContent || ''`);
  check('semiannual rent: monthly 8,000, next payment 48,000 on the 15th', typedRent && flows[3]?.amountCents === 800000 && flows[3]?.dayOfMonth === 15 && rentSummary.includes('每半年繳') && rentSummary.includes('48,000'), rentSummary);
  const incomeErrs = events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails.exception?.description?.split('\n')[0]);
  check('no page exceptions or dialogs while editing income cards', incomeErrs.length === 0 && dialogs.length === 0, [...incomeErrs, ...dialogs].join(' | '));
  if (process.env.SHOT_DIR) {
    await evaluate(`document.querySelector('[data-tab=ledger]').click(); document.querySelectorAll('#personal-settings details').forEach(d => d.open = true); document.querySelectorAll('#personal-settings .income-card')[1]?.scrollIntoView(); true`);
    await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 2400, deviceScaleFactor: 1, mobile: false });
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(process.env.SHOT_DIR, 'income-cards.png'), Buffer.from(shot.data, 'base64'));
    await send('Emulation.clearDeviceMetricsOverride');
  }

  // 5. framing: a page that embeds the app gets replaced by the app itself
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
