// Long-term data volume: ledger lists show only the latest 3 months; older months fold by year-month.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { root } from './text-scan.mjs';

const ctx = { console, structuredClone };
vm.createContext(ctx);
for (const rel of ['shared/reference-data.js', 'shared/config.js', 'shared/validation.js', 'shared/planning.js', 'shared/money.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, rel), 'utf8'), ctx, { filename: rel });
}
const { Money } = vm.runInContext('({Money})', ctx);
const dateOf = (r) => r.date;

test('近 3 個月（含本月與未來）直接顯示，更舊的按年月新到舊分組', () => {
  const rows = ['2026-12-01', '2026-11-17', '2026-10-05', '2026-09-30', '2026-08-31', '2025-12-25', '2026-09-01'].map((date) => ({ date }));
  const r = Money.splitRecentMonths(rows, dateOf, '2026-11-17', 3);
  assert.deepEqual([...r.recent.map(dateOf)], ['2026-12-01', '2026-11-17', '2026-10-05', '2026-09-30', '2026-09-01']);
  assert.deepEqual([...r.older.map((g) => g.ym)], ['2026-08', '2025-12']);
});

test('跨年邊界：1 月時近 3 個月包含前年 11、12 月', () => {
  const rows = ['2026-01-02', '2025-12-31', '2025-11-01', '2025-10-31'].map((date) => ({ date }));
  const r = Money.splitRecentMonths(rows, dateOf, '2026-01-15', 3);
  assert.deepEqual([...r.recent.map(dateOf)], ['2026-01-02', '2025-12-31', '2025-11-01']);
  assert.deepEqual([...r.older.map((g) => g.ym)], ['2025-10']);
});

test('多年資料量下，直接顯示的筆數只取決於近 3 個月', () => {
  const rows = [];
  for (let y = 2020; y <= 2026; y++) for (let m = 1; m <= 12; m++) for (let d = 1; d <= 20; d++) rows.push({ date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` });
  const r = Money.splitRecentMonths(rows.filter((x) => x.date <= '2026-11-17'), dateOf, '2026-11-17', 3);
  assert.ok(r.recent.length <= 3 * 20);
  assert.equal(r.older.length, 6 * 12 + 8);
});

test('沒有日期的資料不丟失（留在直接顯示區）', () => {
  const r = Money.splitRecentMonths([{ date: '' }, { date: undefined }], dateOf, '2026-11-17', 3);
  assert.equal(r.recent.length, 2);
});

test('帳本明細與核對紀錄實際使用 splitRecentMonths（防止之後被改回全部列出）', () => {
  const app = fs.readFileSync(path.join(root, 'shared/app.js'), 'utf8');
  assert.ok((app.match(/Money\.splitRecentMonths\(/g) || []).length >= 3, '逐筆明細、各期比較、核對紀錄都要用');
});
