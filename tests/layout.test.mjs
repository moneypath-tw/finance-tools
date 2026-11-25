// Layout guards for phone width: a wide table must never push a grid column past the screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root } from './text-scan.mjs';

test('首頁版面是 minmax(0, 1fr) 單欄：寬表格不會把整欄撐出畫面（390px 實測 504px→320px）', () => {
  const css = fs.readFileSync(path.join(root, 'shared/style.css'), 'utf8');
  const rule = css.match(/^\.home-overview \{[^}]*\}/m)?.[0] || '';
  assert.match(rule, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test('style.css 的字級全部落在字級階梯（12/14/16/18/20/24/30/36/48…px）', () => {
  const css = fs.readFileSync(path.join(root, 'shared/style.css'), 'utf8');
  const sizes = [...css.matchAll(/font-size:\s*([0-9.]+)(rem|em|px)/g)];
  assert.ok(sizes.length > 30, '找不到字級宣告，正規式失效');
  const scale = [12, 14, 16, 18, 20, 24, 30, 36, 48, 60, 72];
  const off = sizes.filter((m) => !scale.includes(Math.round(Number(m[1]) * (m[2] === 'px' ? 1 : 16) * 1000) / 1000)).map((m) => m[0]);
  assert.deepEqual(off, []);
});

test('摺疊卡片（.card.compact-settings）左右內距不為 0；深色主題覆寫淺色主題的每個顏色變數', () => {
  const css = fs.readFileSync(path.join(root, 'shared/style.css'), 'utf8');
  assert.match(css, /details\.card\.compact-settings\s*\{\s*padding:\s*12px 20px/);
  const colorVars = [...css.match(/:root \{[^}]*\}/)[0].matchAll(/(--[a-z-]+):\s*#/g)].map((m) => m[1]);
  const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
  assert.ok(dark.length > 100 && colorVars.length >= 8, '深色區塊或色彩變數找不到');
  for (const v of colorVars) assert.ok(dark.includes(`${v}:`), `深色主題沒有覆寫 ${v}`);
});

test('手機寬度分頁按鈕折成 2 欄（4 個分頁 2×2），不橫向捲動', () => {
  const css = fs.readFileSync(path.join(root, 'shared/style.css'), 'utf8');
  const mobile = css.slice(css.indexOf('@media (max-width: 720px)'));
  const rule = mobile.match(/nav\.tabs \{[^}]*\}/)[0];
  assert.match(rule, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.doesNotMatch(rule, /overflow-x/);
});

test('多欄寬表（逐期明細、收入目標）必須包在 .table-scroll：html 設了 overflow-x:hidden，沒包會在 390px 被靜默截掉右側欄位', () => {
  const app = fs.readFileSync(path.join(root, 'shared/app.js'), 'utf8');
  for (const cls of ['habit-table', 'income-target-table']) {
    const uses = app.split(`el('table', { class: '${cls}' }`).length - 1;
    const wrapped = app.split(`el('div', { class: 'table-scroll' }, [el('table', { class: '${cls}' }`).length - 1;
    assert.ok(uses > 0, `找不到 ${cls}`);
    assert.equal(wrapped, uses, `${cls} 有未包 .table-scroll 的用法`);
  }
});

test('style.css has a prefers-reduced-motion rule that turns off transitions and animations', () => {
  const css = fs.readFileSync(path.join(root, 'shared/style.css'), 'utf8');
  const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(block, /transition:\s*none/);
  assert.match(block, /animation:\s*none/);
});

test('style.css uses only two font weights (regular and bold)', () => {
  const css = fs.readFileSync(path.join(root, 'shared/style.css'), 'utf8');
  const norm = (w) => (w === 'bold' ? '700' : w === 'normal' ? '400' : w);
  const weights = new Set([...css.matchAll(/font-weight:\s*([0-9a-z]+)/g)].map((m) => norm(m[1])));
  assert.ok(weights.size > 0, 'no font-weight declarations found');
  assert.deepEqual([...weights].sort(), ['400', '700']);
});
