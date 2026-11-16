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
