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
