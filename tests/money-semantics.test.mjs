// 金額語意固定測資（使用者 2026-11-17 起連續指出同類邏輯錯誤：「押金不應與第一次繳交的租金合計…犯錯太多次了」）。
// 這裡只放「使用者定義的語意」與固定數字，改動任何金額公式前後都要全過；其他細節測試留在 core.test.mjs。
// 規則來源：C:\Users\User\.claude\projects\C--Users-User\memory\user_domain_profile_20261119.md「五、個人財務與中控台」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = { console, structuredClone };
vm.createContext(ctx);
for (const rel of ['shared/reference-data.js', 'shared/config.js', 'shared/validation.js', 'shared/planning.js', 'shared/money.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, rel), 'utf8'), ctx, { filename: rel });
}
const { Money, Planning } = vm.runInContext('({Money,Planning})', ctx);

// 半年繳、月租 10,000、押金 20,000、租約 2026-01-15～2026-11-20（最後一期不足半年）
const lease = { rentCents: 1000000, payCycleMonths: 6, contractStart: '2026-01-15', contractEnd: '2026-11-20', occupants: 1, fees: [], depositCents: 2000000 };

test('押金不與首次租金合計：首次繳 6 個月租金 60,000，押金另列 20,000 到退租日退回', () => {
  const r = Money.calcHousing(lease);
  assert.equal(r.paymentOn('2026-01-15').cents, 6000000);
  assert.deepEqual({ ...r.deposit }, { cents: 2000000, paidOn: '2026-01-15', refundOn: '2026-11-20' });
  assert.equal(r.monthlyCents, 1000000);
  assert.equal(Money.housingDueInMonth(lease, '2026-01').totalCents, 6000000);
});

test('半年租約：繳租日離到期不足半年，最後一期只收到期為止的月數（07-15 → 11-20 約 4 個月＝40,000）', () => {
  const r = Money.calcHousing(lease);
  assert.equal(r.paymentOn('2026-07-15').cents, 4000000);
  assert.equal(Money.housingDueInMonth(lease, '2026-07').totalCents, 4000000);
  assert.equal(Money.housingDueInMonth(lease, '2026-03').totalCents, 0);  // 兩次繳租日之間沒有應繳款
});

// 生活費＝一般支出；特別花費(floating)、固定項目產生的(recurringFlowId)、預測(projected)、其他帳戶、收入都不算
test('生活費扣除項：特別花費、固定項目、預測、其他帳戶、收入都不計入', () => {
  const e = (extra) => ({ type: 'expense', date: '2026-11-05', amountCents: 10000, currency: 'TWD', account: 'live', ...extra });
  const entries = [
    e({ id: 'a' }),                                  // 算：10,000
    e({ id: 'b', amountCents: 5000 }),               // 算：5,000
    e({ id: 'c', floating: true }),                  // 特別花費：不算
    e({ id: 'd', recurringFlowId: 'rent' }),         // 固定項目帶出的：不算
    e({ id: 'e', status: 'projected' }),             // 預測：不算
    e({ id: 'f', account: 'invest' }),               // 專用帳戶：不算
    { ...e({ id: 'g' }), type: 'income' },           // 收入：不算
    e({ id: 'h', date: '2026-12-01' }),              // 區間外：不算
  ];
  assert.equal(Planning.livingSpendCents(entries, new Set(['live']), '2026-11-01', '2026-12-01'), 15000);
});
