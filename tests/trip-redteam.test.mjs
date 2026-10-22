// 旅費試算的機械化紅隊：扮演幾種真實使用者（答案手算）、亂填輸入、舊存檔，加上固定種子的隨機不變式檢查。
// 離線、零 AI：取代每次派代理手動操作頁面；新增情境或規則時在這裡加一個角色。
// Usage: node --test tests/trip-redteam.test.mjs
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
const { Money, Validation, DEFAULT_CONFIG, DEFAULT_SCENARIOS, TRIP_BASES, TRIP_DESTINATIONS } = vm.runInContext('({ Money, Validation, DEFAULT_CONFIG, DEFAULT_SCENARIOS, TRIP_BASES, TRIP_DESTINATIONS })', ctx);

const NT = 100; // 1 元＝100 分
const item = (label, basis, currency, yuan, kind = 'cost') => ({ label, kind, basis, currency, amountCents: Math.round(yuan * NT) });
const trip = (destination, days, people, rateToTWD, items) => {
  const s = structuredClone(DEFAULT_SCENARIOS.find(x => x.scenarioId === 'trip_budget'));
  const d = TRIP_DESTINATIONS[destination];
  Object.assign(s, { currency: d.currency, rateToTWD, applyInflation: Boolean(d.inflationKey), inflationKey: d.inflationKey || 'TW', trip: { destination, days, people }, items });
  return s;
};
const totalYuan = (s, horizonMonths = 0) => {
  assert.deepEqual(Array.from(Validation.validateScenario(s).errors, e => e.message), []);
  return Money.calcScenario(s, DEFAULT_CONFIG, { horizonMonths }).total / NT;
};
const codes = (s) => Array.from(Validation.validateScenario(s).errors, e => e.code).sort();

test('角色 1：大學生一人日本 7 天，青旅每人每晚、交通卡日圓、機票台幣', () => {
  const s = trip('JP', 7, 1, 0.21, [item('機票', 'person', 'TWD', 12000), item('青旅', 'person_night', 'JPY', 3000), item('交通卡', 'person_day', 'JPY', 1500)]);
  // 12,000 ＋ ¥3,000×6 晚×0.21＝3,780 ＋ ¥1,500×7 天×0.21＝2,205
  assert.equal(totalYuan(s), 17985);
});

test('角色 2：一家四口歐洲 12 天兩間房，歐元台幣混用、有折扣；中途改 3 人', () => {
  const s = trip('EU', 12, 4, 35, [item('兩間房', 'night', 'EUR', 240), item('機票', 'person', 'TWD', 30000), item('餐', 'person_day', 'EUR', 40), item('保險', 'person', 'TWD', 1500), item('早鳥折扣', 'trip', 'TWD', 2000, 'discount')]);
  // €240×11×35＝92,400；30,000×4；€40×48×35＝67,200；1,500×4；－2,000
  assert.equal(totalYuan(s), 283600);
  s.trip.people = 3; // 房間是整間計，不隨人數變
  assert.equal(totalYuan(s), 92400 + 90000 + 50400 + 4500 - 2000);
});

test('角色 3：五人先填日圓才改去美國——沒匯率擋下不動，有匯率換成台幣且總額不變', () => {
  const s = trip('JP', 6, 5, 0, [item('民宿', 'night', 'JPY', 10000), item('機票', 'person', 'TWD', 20000)]);
  const before = structuredClone(s);
  const blocked = Money.switchTripDestination(s, 'US');
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /匯率/);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), JSON.parse(JSON.stringify(before)));
  s.rateToTWD = 0.2;
  const totalJP = totalYuan(s);
  assert.equal(Money.switchTripDestination(s, 'US').ok, true);
  assert.deepEqual([s.currency, s.rateToTWD, s.applyInflation, s.items[0].currency, s.items[0].amountCents], ['USD', 0, false, 'TWD', 2000 * NT]);
  assert.equal(totalYuan(s), totalJP); // 全是台幣項目，不需要美元匯率
  assert.equal(Money.switchTripDestination(s, 'XX').ok, false);
});

test('角色 4：國內一日遊 0 晚，住宿算 0；沒官方通膨的目的地不套用通膨', () => {
  const s = trip('TW', 1, 2, 1, [item('住宿', 'night', 'TWD', 3000), item('高鐵', 'person', 'TWD', 1500), item('午餐', 'person_day', 'TWD', 300)]);
  assert.equal(totalYuan(s), 3600);
  const other = trip('OTHER', 3, 1, 1, [item('全部', 'trip', 'TWD', 10000)]);
  assert.equal(Money.calcScenario(other, DEFAULT_CONFIG, { horizonMonths: 24 }).inflated, 10000 * NT);
});

test('角色 5：亂填天數、人數、匯率、計算方式與幣別都被驗證擋下，不會默默算成 0', () => {
  const base = () => trip('JP', 5, 2, 0.2, [item('餐', 'person_day', 'JPY', 1000)]);
  const bad = [
    [s => { s.trip.days = 0; }, 'INVALID_DAYS'], [s => { s.trip.days = -3; }, 'INVALID_DAYS'], [s => { s.trip.days = 1.5; }, 'INVALID_DAYS'], [s => { s.trip.days = 366; }, 'INVALID_DAYS'],
    [s => { s.trip.people = 0; }, 'INVALID_PEOPLE'], [s => { s.trip.people = 999; }, 'INVALID_PEOPLE'], [s => { s.trip.people = NaN; }, 'INVALID_PEOPLE'],
    [s => { s.rateToTWD = 0; }, 'INVALID_RATE'], [s => { s.rateToTWD = -1; }, 'INVALID_RATE'], [s => { s.rateToTWD = ''; }, 'INVALID_RATE'],
    [s => { s.items[0].basis = 'per_week'; }, 'INVALID_BASIS'], [s => { s.items[0].currency = 'EUR'; }, 'INVALID_CURRENCY'], [s => { s.trip.destination = 'MARS'; }, 'INVALID_DESTINATION'],
    [s => { s.items[0].amountCents = -100; }, 'INVALID_ITEM']
  ];
  for (const [mutate, code] of bad) {
    const s = base(); mutate(s);
    assert.ok(codes(s).includes(code), `${mutate} → ${codes(s)}`);
  }
  const noRate = base(); noRate.rateToTWD = 0;
  assert.throws(() => Money.calcScenario(noRate, DEFAULT_CONFIG), /匯率/);
  // 全部改回台幣就不需要匯率
  noRate.items[0].currency = 'TWD';
  assert.deepEqual(codes(noRate), []);
});

test('角色 6：舊存檔遷移可重複執行（再載入一次結果相同）', () => {
  const legacy = { schemaVersion: 2, currency: 'TWD', rateToTWD: 1, calcType: 'items', scenarioId: 'trip_budget', label: '旅費預算試算', applyInflation: true, inflationKey: 'EU',
    items: [{ label: '機票', amountCents: 2500000 }, { label: '住宿', amountCents: 3000000 }] };
  const once = Validation.normalizeScenario(legacy);
  assert.equal(once.trip.destination, 'EU');
  assert.equal(JSON.stringify(Validation.normalizeScenario(once)), JSON.stringify(once));
  assert.equal(totalYuan(once), 55000);
  // 只有內建旅費情境會被遷移；自訂情境不會突然多出天數人數
  assert.equal(Validation.normalizeScenario({ ...legacy, scenarioId: 'custom-1' }).trip, undefined);
});

test('隨機不變式：總額＝各列小計、人數或天數變多總額不減、每列只四捨五入一次', () => {
  let seed = 20261022;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const bases = Object.keys(TRIP_BASES), dests = Object.keys(TRIP_DESTINATIONS);
  for (let k = 0; k < 300; k++) {
    const dest = dests[rand(dests.length)], local = TRIP_DESTINATIONS[dest].currency;
    const rate = local === 'TWD' ? 1 : (1 + rand(5000)) / 1000;
    const items = Array.from({ length: 1 + rand(6) }, (_, i) => item(`項${i}`, bases[rand(bases.length)], rand(2) ? local : 'TWD', rand(100000) / 10));
    const s = trip(dest, 1 + rand(30), 1 + rand(8), rate, items);
    const r = Money.calcScenario(s, DEFAULT_CONFIG);
    assert.equal(r.total, r.lines.reduce((a, l) => a + l.twdCents, 0));
    for (const l of r.lines) {
      const exact = l.unitCents * l.qty * (l.currency === 'TWD' ? 1 : rate);
      assert.ok(Math.abs(l.twdCents - exact) <= 0.5 + 1e-6, `${l.label} ${l.twdCents} vs ${exact}`);
    }
    const more = structuredClone(s); more.trip.people += 1; more.trip.days += 1;
    assert.ok(Money.calcScenario(more, DEFAULT_CONFIG).total >= r.total);
  }
});
