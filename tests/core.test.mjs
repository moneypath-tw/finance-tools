import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = { console, structuredClone };
vm.createContext(ctx);
for (const rel of ['shared/reference-data.js','shared/config.js','shared/validation.js','shared/planning.js','shared/money.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, rel), 'utf8'), ctx, { filename: rel });
}
const api = vm.runInContext('({REFERENCE_DATA,DEFAULT_CONFIG,SCENARIO_FIRE,PLANNING_RULES,Validation,Planning,Money,DEFAULT_LEDGER,DEFAULT_SCENARIOS,ALLOCATION_PURPOSES})', ctx);

// 外部數字只能來自官方機關網域，且要記錄取得日期，過期時才知道該重查
const OFFICIAL_HOSTS = /^https:\/\/(www\.)?(cbc\.gov\.tw|boj\.or\.jp|ecb\.europa\.eu|bli\.gov\.tw|nhi\.gov\.tw|law\.moj\.gov\.tw|edu\.law\.moe\.gov\.tw|bot\.com\.tw|mol\.gov\.tw|ey\.gov\.tw)\//;
test('外部參考數字皆有官方來源網址與取得日期', () => {
  const entries = [...Object.entries(api.REFERENCE_DATA.inflation).map(([k, v]) => [`inflation.${k}`, v]),
    ...Object.entries(api.REFERENCE_DATA).filter(([k]) => k !== 'inflation')];
  assert.ok(entries.length >= 7);
  for (const [key, ref] of entries) {
    assert.match(ref.sourceUrl, OFFICIAL_HOSTS, key);
    assert.match(ref.retrievedAt, /^\d{4}-\d{2}-\d{2}$/, key);
    if (ref.lawUrl) assert.match(ref.lawUrl, OFFICIAL_HOSTS, key);
  }
  for (const [key, ref] of Object.entries(api.REFERENCE_DATA.inflation)) {
    assert.ok(Number.isFinite(ref.annualRate) && ref.annualRate > -0.05 && ref.annualRate < 0.2, key);
    assert.equal(api.DEFAULT_CONFIG.inflationRates[key], ref.annualRate, key);
  }
});

test('預設勞保費率含就業保險，且直接取自參考資料', () => {
  const ref = api.REFERENCE_DATA.twLaborInsurance;
  assert.equal(api.DEFAULT_CONFIG.insuranceRates.laborInsuranceRate, ref.ordinaryRate + ref.employmentRate);
  assert.equal(api.DEFAULT_CONFIG.insuranceRates.healthInsuranceRate, api.REFERENCE_DATA.twHealthInsurance.rate);
});

test('成本試算通膨依目標月數複利換算，與健檢同一公式', () => {
  const c = structuredClone(api.DEFAULT_CONFIG);
  c.inflationRates.JP = 0.02;
  const s = { schemaVersion: 2, scenarioId: 'trip', calcType: 'items', applyInflation: true, inflationKey: 'JP', currentSavedCents: 0, items: [{ label: '機票', kind: 'cost', amountCents: 1000000 }] };
  assert.equal(api.Money.calcScenario(s, c, { horizonMonths: 0 }).inflated, 1000000);
  assert.equal(api.Money.calcScenario(s, c, { horizonMonths: 24 }).inflated, 1040400);
  assert.equal(api.Money.calcScenario(s, c, { horizonMonths: 12 }).inflated, api.Planning.futureValue(1000000, 0.02, 12));
});

test('今日金額以複利換算未來名目金額', () => {
  assert.equal(api.Planning.futureValue(10000, 0.02, 12), 10200);
  assert.ok(Math.abs(api.Planning.realRate(0.05, 0.02) - 0.0294117647) < 1e-9);
});

test('快速健檢可用少量資料產生三情境', () => {
  const p = structuredClone(api.DEFAULT_CONFIG.quickPlan);
  const r = api.Planning.assess(p, new Date('2026-08-07T00:00:00Z'));
  assert.equal(r.ok, true);
  assert.equal(r.scenarios.length, 3);
  assert.equal(r.monthlySurplus, 800000);
  assert.ok(r.futureGoal >= p.goalAmountTodayCents);
});

test('目標期限採完整月份無條件進位', () => {
  const p = structuredClone(api.DEFAULT_CONFIG.quickPlan);
  p.goalAmountTodayCents = 1001;
  p.liquidAssetsCents = 0;
  p.goalTargetMonth = '2026-10';
  p.inflationAnnualRate = 0;
  p.nominalReturnAnnualRate = 0;
  const r = api.Planning.assess(p, new Date('2026-08-07T00:00:00Z'));
  assert.equal(r.monthsToGoal, 2);
  assert.equal(r.monthlyGoalContribution, 501);
});

test('緊急預備金不重複當作目標本金', () => {
  const p = structuredClone(api.DEFAULT_CONFIG.quickPlan);
  p.monthlyEssentialExpenseCents = 1000;
  p.liquidAssetsCents = 6000;
  p.goalAmountTodayCents = 12000;
  p.goalTargetMonth = '2027-08';
  p.inflationAnnualRate = 0;
  p.nominalReturnAnnualRate = 0;
  const r = api.Planning.assess(p, new Date('2026-08-07T00:00:00Z'));
  assert.equal(r.goalStartingAssets, 0);
  assert.equal(r.monthlyGoalContribution, 1000);
});

test("指定預備金帳戶與總流動資產採分離口徑", () => {
  const p = structuredClone(api.DEFAULT_CONFIG.quickPlan);
  p.emergencyTargetMonths = 6;
  p.monthlyEssentialExpenseCents = 1000;
  p.liquidAssetsCents = 100000;
  p.emergencyReserveCents = 0;
  const r = api.Planning.assess(p, new Date("2026-08-07T00:00:00Z"));
  assert.equal(r.emergencyMonths, 0);
  assert.equal(r.emergencyGap, 6000);
  assert.equal(r.goalStartingAssets, 94000);
});

test("自訂緊急預備金月數會影響目標與風險", () => {
  const p = structuredClone(api.DEFAULT_CONFIG.quickPlan);
  p.emergencyTargetMonths = 12;
  p.monthlyEssentialExpenseCents = 1000;
  p.liquidAssetsCents = 6000;
  const r = api.Planning.assess(p, new Date("2026-08-07T00:00:00Z"));
  assert.equal(r.emergencyTarget, 12000);
  assert.equal(r.emergencyGap, 6000);
  assert.ok(r.risks.some(x => x.code === "EMERGENCY_BELOW_TARGET"));
});

test("工作區拒絕不存在的首頁帳戶", () => {
  const workspace = { config: structuredClone(api.DEFAULT_CONFIG), ledger: structuredClone(api.DEFAULT_LEDGER), scenarios: structuredClone(api.DEFAULT_SCENARIOS) };
  workspace.config.dashboard.emergencyAccountId = "missing-account";
  const r = api.Validation.validateWorkspace(workspace);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.code === "MISSING_ACCOUNT"));
});

test('無效快速設定被拒絕，不產生 Infinity', () => {
  const p = structuredClone(api.DEFAULT_CONFIG.quickPlan);
  p.inflationAnnualRate = Infinity;
  const r = api.Planning.assess(p);
  assert.equal(r.ok, false);
});

test('帳本拒絕重複 ID、錯誤日期與無效匯率', () => {
  const d = { schemaVersion: 2, entries: [
    { id:'x', date:'2026-02-30', type:'expense', amountCents:-100, currency:'USD', rateToTWD:0 },
    { id:'x', date:'2026-02-01', type:'expense', amountCents:-100, currency:'TWD', rateToTWD:1 }
  ]};
  const r = api.Validation.validateLedger(d);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.code === 'DUPLICATE_ID'));
  assert.ok(r.errors.some(e => e.code === 'INVALID_DATE'));
  assert.ok(r.errors.some(e => e.code === 'INVALID_RATE'));
});

test('外幣匯率必須大於零', () => {
  assert.throws(() => api.Money.toTWDCents(100, 'USD', 0));
  assert.equal(api.Money.toTWDCents(100, 'USD', 32), 3200);
});

test('工時設定拒絕零時薪', () => {
  const s = { schemaVersion:1, targetAmountCents:100, baseRateCentsPerHour:0, currency:'TWD', rateToTWD:1, conversionChain:[] };
  assert.equal(api.Validation.validateWage(s).valid, false);
});

test('月總工資可一次回算時薪、勞健保與實領', () => {
  const rates = api.DEFAULT_CONFIG.insuranceRates;
  const result = api.Money.calcPayroll(3300000, 160, 3300000, rates);
  assert.equal(result.hourlyRateCents, 20600); // 33,000 ÷ 160 = 206.25 → 四捨五入 206 元
  assert.equal(result.laborFee % 100, 0);
  assert.equal(result.healthFee % 100, 0);
  assert.equal(result.net, result.gross - result.laborFee - result.healthFee);
  assert.ok(result.laborFee > 0);
  assert.ok(result.healthFee > 0);
});

test('薪資回算拒絕零工時', () => {
  assert.throws(() => api.Money.calcPayroll(3300000, 0, 3300000, api.DEFAULT_CONFIG.insuranceRates), /月工時/);
});

test('帳戶轉帳必須指定兩個不同帳戶', () => {
  const ledger = { schemaVersion: 2, entries: [{ id: 't1', date: '2026-08-07', type: 'transfer', amountCents: 10000, currency: 'TWD', rateToTWD: 1, account: 'a', fromAccount: 'a', toAccount: 'a' }] };
  assert.equal(api.Validation.validateLedger(ledger).valid, false);
  ledger.entries[0].toAccount = 'b';
  assert.equal(api.Validation.validateLedger(ledger).valid, true);
});

test('正職、兼職與接案可分別決定是否扣勞健保', () => {
  const flows = [
    { id: 'job', name: '正職', type: 'income', kind: 'salary', amountCents: 4000000, monthlyWorkHours: 160, applyInsurance: true, insuredSalaryFollowsGross: true, dayOfMonth: 5, accountId: 'bank' },
    { id: 'side', name: '接案', type: 'income', kind: 'freelance', amountCents: 1000000, monthlyWorkHours: 20, applyInsurance: false, dayOfMonth: 15, accountId: 'bank' },
    { id: 'rent', name: '房租', type: 'expense', kind: 'fixed_expense', amountCents: 1200000, essential: true, dayOfMonth: 1, accountId: 'bank' }
  ];
  const result = api.Money.calcRecurringMonthly(flows, api.DEFAULT_CONFIG.insuranceRates);
  assert.equal(result.items[1].netCents, 1000000);
  assert.ok(result.items[0].netCents < 4000000);
  assert.equal(result.essentialExpenseCents, 1200000);
  assert.equal(result.essentialExpenseGrossCents, 1200000);
  assert.equal(api.Validation.validateRecurringFlows(flows).valid, true);
});

test('工時反推可直接沿用固定收入的工資、工時與保險設定', () => {
  const linked = api.Money.wageSettingsFromIncome({ type: 'income', amountCents: 4800000, monthlyWorkHours: 120, applyInsurance: false, insuredSalaryFollowsGross: true });
  assert.equal(linked.grossMonthlySalaryCents, 4800000);
  assert.equal(linked.baseRateCentsPerHour, 40000);
  assert.equal(linked.applyInsurance, false);
  assert.equal(linked.insuredSalaryCents, 4800000);
});

test('時薪兼職：月總收入 = 時薪 × 工時，勞健保依固定投保級距', () => {
  const rates = api.DEFAULT_CONFIG.insuranceRates;
  const flow = { id: 'pt', type: 'income', payBasis: 'hourly', hourlyRateCents: 19600, monthlyWorkHours: 80, amountCents: 1568000, applyInsurance: true, insuredSalaryFollowsGross: false, insuredSalaryCents: 1110000, dayOfMonth: 5, accountId: 'bank' };
  const income = api.Money.deriveIncome(flow);
  assert.equal(income.grossCents, 1568000);
  assert.equal(income.hourlyRateCents, 19600);
  const item = api.Money.calcRecurringMonthly([flow], rates).items[0];
  const fees = api.Money.grossToNet(1568000, 1110000, rates);
  assert.equal(item.netCents, fees.net);
  // 工時加倍，保費不變（級距固定）
  const doubled = api.Money.calcRecurringMonthly([{ ...flow, monthlyWorkHours: 160 }], rates).items[0];
  assert.equal(doubled.payroll.laborFee, item.payroll.laborFee);
  assert.equal(doubled.grossCents, 3136000);
  assert.equal(api.Validation.validateRecurringFlows([flow]).valid, true);
  assert.equal(api.Validation.validateRecurringFlows([{ ...flow, monthlyWorkHours: 0 }]).valid, true);
});

test('接案：月總收入 = 案件數 × 每件報酬，可按案件時薪或固定每件價', () => {
  const byHour = { id: 'fl', type: 'income', payBasis: 'per_case', caseCount: 4, hoursPerCase: 3, caseFeeMode: 'hourly', hourlyRateCents: 100000, monthlyWorkHours: 0, amountCents: 0, applyInsurance: false, dayOfMonth: 15, accountId: 'bank' };
  const a = api.Money.deriveIncome(byHour);
  assert.equal(a.caseFeeCents, 300000);
  assert.equal(a.grossCents, 1200000);
  assert.equal(a.monthlyWorkHours, 12);
  const fixed = { ...byHour, caseFeeMode: 'fixed', caseFeeCents: 500000, hourlyRateCents: undefined };
  const b = api.Money.deriveIncome(fixed);
  assert.equal(b.grossCents, 2000000);
  assert.equal(b.hourlyRateCents, 166700); // 5,000 ÷ 3 = 1,666.67 → 1,667 元
  assert.equal(api.Money.calcRecurringMonthly([fixed], api.DEFAULT_CONFIG.insuranceRates).incomeCents, 2000000);
  assert.equal(api.Validation.validateRecurringFlows([byHour]).valid, true);
  assert.equal(api.Validation.validateRecurringFlows([fixed]).valid, true);
  assert.equal(api.Validation.validateRecurringFlows([{ ...byHour, hoursPerCase: 0 }]).valid, false);
  // 當月沒接案時工時反推仍有正工時與時薪
  const wage = api.Money.wageSettingsFromIncome({ ...byHour, caseCount: 0 });
  assert.equal(wage.baseRateCentsPerHour, 100000);
  assert.ok(wage.monthlyWorkHours > 0 && wage.grossMonthlySalaryCents > 0);
});

test('未設定計薪方式的舊資料仍視為固定月薪', () => {
  const legacy = { type: 'income', amountCents: 4800000, monthlyWorkHours: 120 };
  assert.deepEqual({ ...api.Money.deriveIncome(legacy) }, { payBasis: 'monthly', grossCents: 4800000, monthlyWorkHours: 120, hourlyRateCents: 40000 });
  assert.equal(api.Validation.validateRecurringFlows([{ ...legacy, id: 'x', dayOfMonth: 5, accountId: 'bank', monthlyWorkHours: 0 }]).valid, false);
});

const sampleHousing = () => ({
  rentCents: 800000, payCycleMonths: 6, contractStart: '2026-01-31', contractEnd: '2027-08-01', occupants: 2,
  fees: [{ name: '管理費', amountCents: 50000, perPerson: false }, { name: '網路費', amountCents: 20000, perPerson: true }],
  electricity: { enabled: true, rateCentsPerKwh: 500, lastReading: 1000, lastReadingDate: '2026-09-01', currentReading: 1150, currentReadingDate: '2026-10-01' }
});
const PER_PAYMENT = (800000 + 50000 + 40000) * 6; // 網路費每人一份 × 2 人
const BILL_TO_JAN = 5 * 152 * 500; // 每天 5 度，2026-09-01 → 2027-01-31 共 152 天

test('租屋：半年繳房租、按人數費用與電表推估合成每月平均', () => {
  const r = api.Money.calcHousing(sampleHousing());
  assert.equal(r.feesCents, 90000);
  assert.equal(r.perPaymentCents, PER_PAYMENT);
  assert.equal(r.electricity.days, 30);
  assert.equal(r.electricity.usedKwh, 150);
  assert.equal(r.electricity.usedSoFarCents, 75000);
  // 電費跟房租同一天結清：上次抄表後的第一個繳租日
  assert.equal(r.electricity.nextSettleDate, '2027-01-31');
  assert.equal(r.electricity.projectedBillCents, BILL_TO_JAN);
  assert.equal(r.electricity.monthlyCents, Math.round(5 * 365 / 12 * 5) * 100); // 760.42 元 → 760 元
  assert.equal(r.monthlyCents, 800000 + 90000 + r.electricity.monthlyCents);
});

test('租屋：房租、費用、電費同一天繳；簽約日推出繳款日（月底夾日、到期日後停止）', () => {
  const h = sampleHousing();
  const elecMonthly = api.Money.calcHousing(h).electricity.monthlyCents;
  const schedule = api.Money.housingPaymentSchedule(h, '2026-02-01', 6);
  assert.deepEqual(Array.from(schedule, p => p.date), ['2026-07-31', '2027-01-31', '2027-07-31']);
  assert.deepEqual(Array.from(schedule, p => p.cents), [PER_PAYMENT + elecMonthly * 6, PER_PAYMENT + BILL_TO_JAN, PER_PAYMENT + elecMonthly * 6]);
  assert.deepEqual(Array.from(api.Money.housingPaymentSchedule({ ...h, payCycleMonths: 1 }, '2026-02-01', 2), p => p.date), ['2026-02-28', '2026-03-31']);
  const due = (ym) => api.Money.housingDueInMonth(h, ym).totalCents;
  assert.equal(due('2025-12'), 0);
  assert.equal(due('2026-07'), PER_PAYMENT + elecMonthly * 6);
  assert.equal(due('2026-08'), 0); // 非繳款月什麼都不用付
  assert.equal(due('2027-01'), PER_PAYMENT + BILL_TO_JAN);
  assert.equal(due('2028-01'), 0); // 租約到期
  const flows = [{ id: 'home', name: '租屋', type: 'expense', kind: 'rent', amountCents: 0, dayOfMonth: 31, accountId: 'bank', housing: h }];
  assert.equal(api.Validation.validateRecurringFlows(flows).valid, true);
  assert.equal(api.Money.calcRecurringMonthly(flows, api.DEFAULT_CONFIG.insuranceRates).essentialExpenseCents, api.Money.calcHousing(h).monthlyCents);
  assert.equal(api.Validation.validateRecurringFlows([{ ...flows[0], housing: { ...h, payCycleMonths: 4 } }]).valid, false);
});

test('租屋補助：核定期間內每月撥款，每月平均扣掉補助，不影響繳租金額', () => {
  const h = { ...sampleHousing(), subsidy: { enabled: true, amountCents: 300000, startMonth: '2026-03', endMonth: '2027-02', dayOfMonth: 10 } };
  const r = api.Money.calcHousing(h, '2026-10');
  assert.equal(r.subsidyCents, 300000);
  assert.equal(r.monthlyCents, r.grossMonthlyCents - 300000);
  assert.equal(api.Money.calcHousing(h, '2027-03').subsidyCents, 0); // 核定期滿
  assert.equal(api.Money.calcHousing(h, '2026-02').monthlyCents, r.grossMonthlyCents);
  assert.equal(api.Money.housingSubsidyInMonth(h, '2026-03'), 300000);
  assert.equal(api.Money.housingSubsidyInMonth(h, '2027-03'), 0);
  assert.equal(api.Money.housingSubsidyInMonth({ ...h, subsidy: { ...h.subsidy, enabled: false } }, '2026-10'), 0);
  assert.equal(api.Money.housingDueInMonth(h, '2026-07').totalCents, api.Money.housingDueInMonth(sampleHousing(), '2026-07').totalCents);
  const flow = { id: 'home', name: '租屋', type: 'expense', kind: 'rent', amountCents: 0, dayOfMonth: 31, accountId: 'bank', housing: h };
  assert.equal(api.Validation.validateRecurringFlows([flow]).valid, true);
  assert.equal(api.Validation.validateRecurringFlows([{ ...flow, housing: { ...h, subsidy: { ...h.subsidy, endMonth: '2026-01' } } }]).valid, false);
});

test('台幣金額一律四捨五入到整數元顯示，外幣保留小數', () => {
  assert.equal(api.Money.formatTWD(3172917), '31,729元');
  assert.equal(api.Money.formatTWD(3172950), '31,730元');
  assert.ok(api.Money.formatMoney(1250, 'EUR').includes('12.5'));
});

test('租屋補助可保留資料但不納入計算', () => {
  const h = { ...sampleHousing(), subsidy: { enabled: true, includeInCalc: false, amountCents: 300000, startMonth: '2026-01' } };
  assert.equal(api.Money.housingSubsidyInMonth(h, '2026-10'), 0);
  assert.equal(api.Money.calcHousing(h, '2026-10').monthlyCents, api.Money.calcHousing(sampleHousing(), '2026-10').monthlyCents);
});

test('多帳戶分配先付固定支出，再滿足生活與緊急預備金', () => {
  const result = api.Planning.allocateMonthly({
    incomeCents: 5000000, livingCents: 1800000, fixedExpenseCents: 1200000, emergencyMonthlyCents: 100000,
    savingCents: 300000, livingAccountId: 'living', fixedExpenseAccountId: 'fixed', emergencyAccountId: 'emergency', savingsAccountId: 'saving',
    goals: [{ key: 'trip', label: '旅行', gapCents: 2400000, months: 12, accountId: 'trip' }]
  });
  assert.deepEqual(Array.from(result.rows, r => r.accountId), ['fixed', 'living', 'emergency', 'saving', 'trip']);
  assert.deepEqual(Array.from(result.rows, r => r.allocatedCents), [1200000, 1800000, 100000, 300000, 200000]);
  assert.equal(result.unallocatedCents, 1400000);
});

test('收入不足時可選成本目標不會排擠必備分配', () => {
  const result = api.Planning.allocateMonthly({ incomeCents: 2000000, livingCents: 1500000, fixedExpenseCents: 1000000, emergencyMonthlyCents: 100000, goals: [{ key: 'goal', label: '目標', gapCents: 1200000, months: 12 }] });
  assert.equal(result.rows[0].key, 'fixed');
  assert.equal(result.rows[0].allocatedCents, 1000000); // 已約定的固定支出先付足
  assert.equal(result.rows[1].allocatedCents, 1000000);
  assert.equal(result.rows[3].allocatedCents, 0);
});

test('成本目標已存金額：同帳戶先保留緊急預備金，再依期限分給各目標，不重複計算', () => {
  const goals = [
    { key: 'late', label: '晚', accountId: 'bank', months: 24, targetCents: 5000000 },
    { key: 'soon', label: '早', accountId: 'bank', months: 6, targetCents: 3000000 },
    { key: 'other', label: '別帳戶', accountId: 'trip', months: 12, targetCents: 1200000 },
    { key: 'bad', label: '錯誤', accountId: 'trip', months: 12, targetCents: 999, invalid: true }
  ];
  const pooled = Object.fromEntries(Array.from(api.Planning.poolGoalSavings(goals, { bank: 10000000, trip: 0 }, { bank: 6000000 }), g => [g.key, g]));
  assert.equal(pooled.soon.savedCents, 3000000); // 1,000 萬－緊急預備金 600 萬＝400 萬可用，先給期限近的
  assert.equal(pooled.late.savedCents, 1000000);
  assert.equal(pooled.late.gapCents, 4000000);
  assert.equal(pooled.late.monthlyRequiredCents, Math.ceil(4000000 / 24));
  assert.equal(pooled.other.monthlyRequiredCents, 100000);
  assert.equal(pooled.bad.monthlyRequiredCents, 0);
});

test('本月儲蓄評估用呼叫端給的應儲蓄，問題點與每日生活費跟摘要卡一致', () => {
  const base = { incomeCents: 4000000, fixedExpenseCents: 1500000, fixedSavingCents: 0, actualIncomeCents: 4000000, actualExpenseCents: 3000000, daysInMonth: 30 };
  const planned = api.Planning.assessMonthlySavings({ ...base, recommendedSavingCents: 2000000 });
  assert.equal(planned.recommendedSavingCents, 2000000);
  assert.equal(planned.dailyLivingCents, Math.floor((4000000 - 1500000 - 2000000) / 30));
  assert.ok(planned.issues.includes('本月儲蓄尚未達成建議金額')); // 實存 1 萬 < 應存 2 萬
  assert.equal(api.Planning.assessMonthlySavings(base).recommendedSavingCents, 800000); // 沒給時仍是收入 20%
});

test('固定儲蓄不列為支出並驗證不同轉出入帳戶', () => {
  const flows = [{ id: 'save', name: '儲蓄', type: 'saving', amountCents: 500000, dayOfMonth: 6, fromAccountId: 'checking', accountId: 'saving' }];
  const result = api.Money.calcRecurringMonthly(flows, api.DEFAULT_CONFIG.insuranceRates);
  assert.equal(result.fixedSavingCents, 500000);
  assert.equal(result.essentialExpenseCents + result.otherExpenseCents, 0);
  assert.equal(api.Validation.validateRecurringFlows(flows).valid, true);
  flows[0].accountId = 'checking';
  assert.equal(api.Validation.validateRecurringFlows(flows).valid, false);
});

test('每月儲蓄健康度、每日生活費與達成率可自動計算', () => {
  const result = api.Planning.assessMonthlySavings({ incomeCents: 4000000, fixedExpenseCents: 1500000, fixedSavingCents: 500000, actualIncomeCents: 4000000, actualExpenseCents: 3000000, daysInMonth: 31 });
  assert.equal(result.recommendedSavingCents, 800000);
  assert.equal(result.actualSavingsCents, 1000000);
  assert.equal(result.actualSavingsRate, 0.25);
  assert.equal(result.attainmentRate, 1.25);
  assert.equal(result.health.label, '健康');
  assert.equal(result.dailyLivingCents, Math.floor(1700000 / 31));
  assert.ok(result.strengths.some(text => text.includes('已達 20%')));
  assert.ok(result.strengths.some(text => text.includes('已達成建議金額')));
  assert.ok(result.strengths.some(text => text.includes('固定儲蓄')));
});

test('分類花費可計算跨月平均與占比，包含中間空白月份', () => {
  const entries = [
    { type: 'expense', date: '2026-01-05', category: '食', amountCents: -30000, currency: 'TWD', rateToTWD: 1 },
    { type: 'expense', date: '2026-03-08', category: '食', amountCents: -60000, currency: 'TWD', rateToTWD: 1 },
    { type: 'expense', date: '2026-03-09', category: '行', amountCents: -10000, currency: 'TWD', rateToTWD: 1 }
  ];
  const result = api.Money.calcExpenseAverages(entries);
  assert.equal(result.monthCount, 3);
  assert.equal(result.totalCents, 100000);
  assert.equal(result.rows.find(r => r.label === '食').monthlyAverageCents, 30000);
  assert.equal(result.rows.find(r => r.label === '食').share, 0.9);
});

test('學貸依現行年金法估算月繳、年限與年齡啟用狀態', () => {
  const repayment = { graduationAge: 22, graceYears: 2, annualRate: 0.00775, termPlan: 'standard' };
  const waiting = api.Money.calcStudentLoanRepayment(10000000, 8, repayment, 23);
  assert.equal(waiting.termMonths, 96);
  assert.equal(waiting.termYears, 8);
  assert.equal(waiting.repaymentStartAge, 24);
  assert.equal(waiting.status, 'waiting');
  assert.ok(waiting.monthlyPaymentCents > Math.ceil(10000000 / 96));
  assert.equal(api.Money.calcStudentLoanRepayment(10000000, 8, repayment, 25).status, 'repaying');
  assert.equal(api.Money.calcStudentLoanRepayment(10000000, 8, { ...repayment, termPlan: 'low_income' }, 25).termYears, 16);
});

test('房貸可計算寬限期、正常月繳、總利息與升息壓力', () => {
  const mortgage = { purchaseAge: 30, annualRate: 0.03, termYears: 30, graceYears: 2 };
  const plan = api.Money.calcMortgageRepayment(1000000000, mortgage, 30);
  assert.equal(plan.status, 'grace');
  assert.equal(plan.graceMonths, 24);
  assert.equal(plan.termMonths, 360);
  assert.equal(plan.currentPaymentCents, plan.interestOnlyPaymentCents);
  assert.ok(plan.monthlyPaymentCents > plan.interestOnlyPaymentCents);
  assert.ok(plan.totalInterestCents > 0);
  const stressed = api.Money.calcMortgageRepayment(1000000000, { ...mortgage, annualRate: 0.05 }, 32);
  assert.ok(stressed.monthlyPaymentCents > plan.monthlyPaymentCents);
});

test('FIRE反推納入其他目標：提高其他目標不得提早退休', () => {
  const c = structuredClone(api.DEFAULT_CONFIG);
  const base = structuredClone(api.SCENARIO_FIRE);
  base.retireAgeSolveMode = 'given_growth_rate';
  base.assumedSalaryGrowthRate = 0.03;
  const age1 = api.Money.calcScenario(base, c).solvedRetireAge;
  const larger = structuredClone(base);
  larger.otherGoalsCents = 300000000;
  const age2 = api.Money.calcScenario(larger, c).solvedRetireAge;
  assert.ok(age2 === null || age1 === null || age2 >= age1);
});

test('FIRE總需求＝退休資產＋其他目標＋緊急預備金；連動帶入的緊急預備金優先於月數', () => {
  const c = structuredClone(api.DEFAULT_CONFIG);
  const s = structuredClone(api.SCENARIO_FIRE);
  s.otherGoalsCents = 500000;
  const manual = api.Money.calcScenario(s, c);
  assert.equal(manual.totalNeededBeforeRetire, manual.retirementAssetTarget + 500000 + s.currentMonthlyExpenseCents * s.emergencyFundMonths);
  s.emergencyFundCents = 123400;
  const linked = api.Money.calcScenario(s, c);
  assert.equal(linked.totalNeededBeforeRetire, linked.retirementAssetTarget + 500000 + 123400);
  // 舊存檔沒有 otherGoalsCents 時沿用買房＋留學
  const legacy = structuredClone(api.SCENARIO_FIRE);
  delete legacy.otherGoalsCents;
  legacy.buyHouseGoalCents = 100; legacy.studyAbroadFundCents = 200;
  const r = api.Money.calcScenario(legacy, c);
  assert.equal(r.totalNeededBeforeRetire, r.retirementAssetTarget + 300 + legacy.currentMonthlyExpenseCents * legacy.emergencyFundMonths);
});

test('FIRE拒絕零除與錯誤年齡順序', () => {
  const c = structuredClone(api.DEFAULT_CONFIG);
  const s = structuredClone(api.SCENARIO_FIRE);
  s.retireAge = s.startAge;
  assert.throws(() => api.Money.calcScenario(s, c), /年齡/);
});

test("FIRE 拒絕負數財務欄位", () => {
  const c = structuredClone(api.DEFAULT_CONFIG);
  for (const key of ['retirementMonthlyExpenseCents', 'otherGoalsCents', 'emergencyFundCents']) {
    const s = structuredClone(api.SCENARIO_FIRE);
    s[key] = -1;
    assert.throws(() => api.Money.calcScenario(s, c), /非負有限金額/, key);
  }
});

test('緊急預備金以未扣補助的必要支出計算，缺口文字以元顯示', () => {
  const flows = [{ id: 'rent', name: '房租', type: 'expense', kind: 'fixed_expense', amountCents: 1200000, essential: true, dayOfMonth: 1, accountId: 'bank',
    housing: { ...sampleHousing(), subsidy: { enabled: true, amountCents: 300000, dayOfMonth: 10 } } }];
  const monthly = api.Money.calcRecurringMonthly(flows, api.DEFAULT_CONFIG.insuranceRates);
  // 補助只降低每月實付，不降低緊急預備金基數
  assert.equal(monthly.essentialExpenseGrossCents - monthly.essentialExpenseCents, 300000);
  const fund = api.Planning.emergencyFund({ baseMonthlyCents: 2000000, months: 6, balanceCents: 5000000 });
  assert.deepEqual([fund.targetCents, fund.gapCents, fund.monthlyCents], [12000000, 7000000, Math.ceil(7000000 / api.PLANNING_RULES.emergencyFillMonths)]);
  assert.equal(api.Planning.emergencyFund({ baseMonthlyCents: 100, months: 99, balanceCents: 0 }).targetMonths, api.PLANNING_RULES.emergencyMonths.max);
  const p = structuredClone(api.DEFAULT_CONFIG.quickPlan);
  Object.assign(p, { monthlyEssentialExpenseCents: 1000000, emergencyBaseCents: 2000000, emergencyReserveCents: 9000000, emergencyTargetMonths: 6 });
  const r = api.Planning.assess(p, new Date('2026-08-07T00:00:00Z'));
  assert.equal(r.emergencyGap, 3000000);
  const risk = r.risks.find(x => x.code === 'EMERGENCY_BELOW_TARGET');
  assert.ok(risk && risk.text.includes('30,000元') && !risk.text.includes('分'), risk?.text);
});

test('FIRE零報酬率在永續模型中被拒絕，有限模型可計算', () => {
  const c = structuredClone(api.DEFAULT_CONFIG);
  const s = structuredClone(api.SCENARIO_FIRE);
  s.postRetirementAnnualReturnRate = 0;
  s.retirementInflationAnnualRate = 0;
  assert.throws(() => api.Money.calcScenario(s, c), /永續模型要求/);
  s.retirementFundingModel = 'finite';
  const r = api.Money.calcScenario(s, c);
  assert.ok(Number.isFinite(r.retirementAssetTarget));
  assert.equal(r.retirementAssetTarget, s.retirementMonthlyExpenseCents * 12 * (s.deathAge - s.retireAge));
});

test('省略退休後通膨率（等同於0）在永續模型中仍須被拒絕，不能只在明確填0才檔', () => {
  // 2026-09-11全倉庫稽核發現：validation.js原本只在retirementInflationAnnualRate
  // 「有明確填值」時才做永續可行性檢查，但money.js一律用 ?? 0 補完再計算——
  // 單純省略此欄位（前端表單未觸碰過的預設狀態）就會繞過這條防呆，得到一個
  // 數學上不可能永續、卻沒有任何錯誤訊息的結果。
  const c = structuredClone(api.DEFAULT_CONFIG);
  const s = structuredClone(api.SCENARIO_FIRE);
  s.postRetirementAnnualReturnRate = 0;
  delete s.retirementInflationAnnualRate;
  assert.equal(api.Validation.validateScenario(s).valid, false);
  assert.throws(() => api.Money.calcScenario(s, c), /永續模型要求/);
});
test("自訂情境以折扣類型扣除成本", () => {
  const c = structuredClone(api.DEFAULT_CONFIG);
  const s = { schemaVersion: 2, scenarioId: "custom-discount", calcType: "items", currency: "TWD", rateToTWD: 1, applyInflation: false, items: [
    { label: "裝修", kind: "cost", amountCents: 100000 },
    { label: "補助", kind: "discount", amountCents: 20000 }
  ] };
  const r = api.Money.calcScenario(s, c);
  assert.equal(r.total, 80000);
  assert.equal(api.Validation.validateScenario(s).valid, true);
});
test("舊格式減免會正規化為折扣並保留期別類型", () => {
  const c = structuredClone(api.DEFAULT_CONFIG);
  const s = { schemaVersion: 1, scenarioId: "legacy-period", calcType: "periods", itemTemplate: [
    { label: "學費", amountCents: 100000 },
    { label: "減免", amountCents: -20000 }
  ], periods: [{ label: "第一期", overrides: { "學費": 100000, "減免": -20000 } }] };
  const normalized = api.Validation.normalizeScenario(s);
  assert.equal(normalized.itemTemplate[1].kind, "discount");
  assert.equal(normalized.itemTemplate[1].amountCents, 20000);
  const result = api.Money.calcScenario(normalized, c);
  assert.equal(result.periods[0].items[1].kind, "discount");
  assert.equal(result.periods[0].total, 80000);
});

test("折扣超過成本時總額不會變成負數", () => {
  assert.equal(api.Money.sumItems([
    { label: "成本", kind: "cost", amountCents: 1000 },
    { label: "減免", kind: "discount", amountCents: 1500 }
  ]), 0);
});
test("情境摘要統一提供首頁所需的總額與缺口", () => {
  const c = structuredClone(api.DEFAULT_CONFIG);
  const s = { schemaVersion: 2, scenarioId: "summary-items", calcType: "items", applyInflation: false, currentSavedCents: 20000, items: [
    { label: "成本", kind: "cost", amountCents: 100000 }
  ] };
  const result = api.Money.calcScenario(s, c);
  const summary = api.Money.toScenarioSummary(s, result);
  assert.equal(summary.type, "items");
  assert.equal(summary.totalCents, 100000);
  assert.equal(summary.targetCents, 80000);
  assert.equal(summary.gapCents, 80000);
  assert.equal(summary.status, "planned");
});

test("情境類型可從舊格式期別資料正確推導", () => {
  assert.equal(api.Money.getScenarioType({ periods: [] }), "periods");
  assert.equal(api.Money.getScenarioType({ calcType: "fire", periods: [] }), "fire");
});
test("情境摘要保留已超額資金，不把錯誤混同為零", () => {
  const c = structuredClone(api.DEFAULT_CONFIG);
  const s = { schemaVersion: 2, scenarioId: "surplus-items", calcType: "items", applyInflation: false, currentSavedCents: 120000, items: [
    { label: "成本", kind: "cost", amountCents: 100000 }
  ] };
  const summary = api.Money.toScenarioSummary(s, api.Money.calcScenario(s, c));
  assert.equal(summary.rawGapCents, -20000);
  assert.equal(summary.gapCents, 0);
  assert.equal(summary.surplusCents, 20000);
  assert.equal(summary.status, "funded");
});

test("工作區拒絕不同 ID 的重複自動固定支出來源", () => {
  const config = structuredClone(api.DEFAULT_CONFIG);
  const ledger = structuredClone(api.DEFAULT_LEDGER);
  const scenarios = structuredClone(api.DEFAULT_SCENARIOS);
  const accountId = config.accountProfiles[0].id;
  config.recurringCashFlows = [
    { id: "system-student-loan-repayment", type: "expense", kind: "fixed_expense", amountCents: 1, dayOfMonth: 1, accountId, source: "scenario:student_loan" },
    { id: "legacy-student-loan-copy", type: "expense", kind: "fixed_expense", amountCents: 1, dayOfMonth: 1, accountId, source: "scenario:student_loan" }
  ];
  const result = api.Validation.validateWorkspace({ config, ledger, scenarios });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === "DUPLICATE_SOURCE"));
});
// ---------- 帳戶核對模式（shared/snapshots.js） ----------
vm.runInContext(fs.readFileSync(path.join(root, 'shared/snapshots.js'), 'utf8'), ctx, { filename: 'shared/snapshots.js' });
const Snap = vm.runInContext('Snapshots', ctx);

test('核對：期間內每月入帳日只算 (起, 迄] 的次數，月底較短算當月最後一天', () => {
  assert.equal(Snap.occurrences(1, '2026-01-01', '2026-02-01'), 1);
  assert.equal(Snap.occurrences(1, '2026-01-02', '2026-03-15'), 2);
  assert.equal(Snap.occurrences(31, '2026-02-01', '2026-02-28'), 1);
  assert.equal(Snap.occurrences(5, '2026-03-06', '2026-03-31'), 0);
});

test('核對：推算流出 = 期初 + 應存入 − 期末；互轉不記錄時總額仍正確', () => {
  const flows = [
    { type: 'income', accountId: 'main', netCents: 5000000, dayOfMonth: 1 },
    { type: 'saving', fromAccountId: 'main', accountId: 'save', grossCents: 1000000, dayOfMonth: 1 },
    { type: 'expense', accountId: 'main', grossCents: 800000, dayOfMonth: 5 }
  ];
  const snaps = [
    { id: 'a', date: '2026-01-01', balances: { main: 100000, save: 2000000 } },
    { id: 'b', date: '2026-02-01', balances: { main: 2900000, save: 3000000 }, note: '月初' }
  ];
  const [p] = Snap.periods(snaps, flows);
  assert.equal(p.days, 31);
  const main = p.accounts.find(a => a.id === 'main'), save = p.accounts.find(a => a.id === 'save');
  assert.equal(main.inCents, 4000000);           // 收入 50,000 − 轉出儲蓄 10,000
  assert.equal(main.outflowCents, 100000 + 4000000 - 2900000);
  assert.equal(save.outflowCents, 0);
  assert.equal(p.total.fixedOutCents, 800000);
  assert.equal(p.total.livingCents, p.total.outflowCents - 800000);
  // 沒記錄的互轉 5,000：main 看起來多花、save 看起來多存，加總不變
  const moved = [snaps[0], { ...snaps[1], balances: { main: 2400000, save: 3500000 } }];
  assert.equal(Snap.periods(moved, flows)[0].total.outflowCents, p.total.outflowCents);
});

test('核對：最新期間在前，負值代表多出，每 30 天換算', () => {
  const snaps = [
    { id: 'a', date: '2026-01-01', balances: { x: 0 } },
    { id: 'b', date: '2026-01-16', balances: { x: 50000 } },
    { id: 'c', date: '2026-01-31', balances: { x: 20000 } }
  ];
  const ps = Snap.periods(snaps, []);
  assert.deepEqual([...ps.map(p => p.to)], ['2026-01-31', '2026-01-16']);
  assert.equal(ps[1].total.outflowCents, -50000);
  assert.equal(ps[0].total.outflowPer30Cents, 60000);
});

test('核對：只計入兩次都有填的帳戶；格式檢查擋下重複日期與非整數', () => {
  const ps = Snap.periods([{ id: 'a', date: '2026-01-01', balances: { x: 1 } }, { id: 'b', date: '2026-01-02', balances: { x: 1, y: 5 } }], []);
  assert.deepEqual([...ps[0].accounts.map(a => a.id)], ['x']);
  assert.equal(Snap.validate(undefined).length, 0);
  assert.ok(Snap.validate([{ id: 'a', date: '2026-01-01', balances: { x: 1.5 } }]).length);
  assert.ok(Snap.validate([{ id: 'a', date: '2026-01-01', balances: {} }, { id: 'b', date: '2026-01-01', balances: {} }]).length);
});

test('自訂情境編輯到一半仍可在重新載入時保留，不會讓整份工作區退回預設模板', () => {
  const V = api.Validation;
  const config = structuredClone(api.DEFAULT_CONFIG);
  const custom = { schemaVersion: 2, scenarioId: 'custom-1', label: '留學基金', custom: true, calcType: 'items', currentSavedCents: 0, loanAmountCents: 0, items: [{ label: '  ', kind: 'cost', amountCents: 100 }] };
  const retire = structuredClone(api.DEFAULT_SCENARIOS.find(s => s.calcType === 'retirement_fund'));
  Object.assign(retire, { scenarioId: 'custom-2', custom: true, retireAge: 1 });
  config.dashboard.scenarioSelections = { 'custom-1': true, 'deleted-x': true };
  config.dashboard.scenarioTargetMonths = { 'custom-1': '', 'deleted-x': '2030-01' };
  config.quickPlan.goalTargetMonth = '';
  const scenarios = [...structuredClone(api.DEFAULT_SCENARIOS), custom, retire].map(V.normalizeScenario);
  const workspace = { config, ledger: structuredClone(api.DEFAULT_LEDGER), scenarios };
  assert.equal(V.validateWorkspace(workspace).valid, false);
  V.repairWorkspace(workspace, api.DEFAULT_CONFIG);
  assert.equal(V.validateWorkspace(workspace, { scenarioContentChecks: false }).valid, true);
  assert.equal(scenarios.find(s => s.scenarioId === 'custom-1').items[0].label, '未命名項目');
  assert.equal(scenarios.find(s => s.scenarioId === 'custom-2').retireAge, 1);
  assert.deepEqual(Object.keys(config.dashboard.scenarioSelections), ['custom-1']);
  assert.deepEqual(Object.keys(config.dashboard.scenarioTargetMonths), []);
  assert.equal(config.quickPlan.goalTargetMonth, api.DEFAULT_CONFIG.quickPlan.goalTargetMonth);
  // 結構錯誤仍要擋：ID 重複的情境不可載入
  scenarios.push({ ...custom });
  assert.equal(V.validateWorkspace(workspace, { scenarioContentChecks: false }).valid, false);
});

test('首頁指定帳戶被刪除時載入會改回第一個帳戶，不讓整份工作區被拒絕', () => {
  const V = api.Validation;
  const config = structuredClone(api.DEFAULT_CONFIG);
  config.accountProfiles = [{ id: 'a1', name: '活存', nature: 'checking', initialBalanceCents: 0 }];
  config.dashboard.livingAccountId = 'deleted';
  const workspace = { config, ledger: structuredClone(api.DEFAULT_LEDGER), scenarios: structuredClone(api.DEFAULT_SCENARIOS) };
  assert.equal(V.validateWorkspace(workspace).valid, false);
  V.repairWorkspace(workspace, api.DEFAULT_CONFIG);
  assert.equal(config.dashboard.livingAccountId, 'a1');
  assert.equal(V.validateWorkspace(workspace).valid, true);
});

test('預設情境全部通過內容驗證（首頁摘要會把不合法情境標為無法計算）', () => {
  for (const s of api.DEFAULT_SCENARIOS) assert.equal(api.Validation.validateScenario(s).errors.length, 0, s.scenarioId);
});

test('趨勢圖 SVG 會跳脫月份字串', () => {
  const svg = api.Money.buildTrendChartSVG({ '2026-<img>': 100 }, {});
  assert.ok(!svg.includes('<img>'));
  assert.ok(svg.includes('&lt;img&gt;'));
});

test('線上版離線快取清單與 index.html 載入的檔案一致', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const loaded = [...html.matchAll(/(?:src|href)="(shared\/[^"]+)"/g)].map((m) => `./${m[1]}`).sort();
  const precached = [...sw.matchAll(/'(\.\/shared\/[^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(precached, loaded);
  for (const rel of loaded) assert.ok(fs.existsSync(path.join(root, rel)), rel);
});

test('防嵌入保護是 <head> 第一支腳本，CSP 禁止對外連線', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  assert.equal([...head.matchAll(/<script src="([^"]+)"/g)][0]?.[1], 'shared/frame-guard.js');
  assert.match(head, /connect-src 'none'/);
});

// ---- 攻擊者視角的回歸測試（線上版上線前逐項檢討後機械化；新增攻擊面時在這裡補） ----

const loadIoWithStubs = () => {
  const listeners = {};
  const store = new Map();
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const doc = { visibilityState: 'visible', addEventListener: (t, f) => { (listeners[t] ||= []).push(f); } };
  const win = { addEventListener: (t, f) => { (listeners[t] ||= []).push(f); } };
  const reloads = [];
  const ioCtx = { console, structuredClone, setTimeout: () => 0, clearTimeout: () => {}, localStorage, document: doc, window: win, location: { reload: () => reloads.push(1) }, Blob, URL };
  vm.createContext(ioCtx);
  vm.runInContext(fs.readFileSync(path.join(root, 'shared/io.js'), 'utf8') + '\n;globalThis.IO = IO;', ioCtx, { filename: 'shared/io.js' });
  const fire = (t, e = {}) => (listeners[t] || []).forEach((f) => f({ preventDefault() {}, ...e }));
  return { IO: ioCtx.IO, store, doc, fire, reloads, localStorage };
};

test('其他分頁更新資料後，這個分頁不再保存，避免舊資料覆蓋新資料', () => {
  const { IO, store, fire, localStorage } = loadIoWithStubs();
  IO.configurePersistence(() => ({ ledger: { entries: ['this-tab'] } }));
  IO.markDirty();
  store.set('finance-tools.workspace.v1', '{"ledger":{"entries":["other-tab"]}}');
  fire('storage', { key: 'finance-tools.workspace.v1', newValue: 'x', storageArea: localStorage });
  IO.markDirty();
  fire('pagehide');
  assert.match(store.get('finance-tools.workspace.v1'), /other-tab/);
});

test('背景分頁收到其他分頁的更新會直接重新載入；切換分頁本身不寫入（不觸發對方失效）', () => {
  const { IO, store, doc, fire, reloads, localStorage } = loadIoWithStubs();
  IO.configurePersistence(() => ({ ledger: { entries: [] } }));
  IO.markDirty();
  const before = store.get('finance-tools.workspace.v1');
  doc.visibilityState = 'hidden';
  fire('visibilitychange');
  assert.equal(store.get('finance-tools.workspace.v1'), before);
  fire('storage', { key: 'finance-tools.workspace.v1', newValue: 'x', storageArea: localStorage });
  assert.equal(reloads.length, 1);
});

test('超過大小上限的匯入檔被拒絕，且不讀取內容', async () => {
  const { IO } = loadIoWithStubs();
  await assert.rejects(IO.importJsonFile({ size: 6 * 1024 * 1024 }), /未匯入/);
});

test('惡意匯入資料：所有字串欄位塞入 HTML 仍不會產生標籤', () => {
  const payload = '"><img src=x onerror=alert(1)><svg onload=alert(1)>';
  const ledger = { schemaVersion: 2, entries: [{ id: payload, date: `2026-${payload}`, type: 'expense', category: payload, account: payload, amountCents: -100, note: payload }] };
  const svg = api.Money.buildTrendChartSVG(api.Money.groupSum(ledger.entries, (e) => e.date.slice(0, 7), (e) => e.type === 'expense'), {});
  assert.ok(!/<img|<svg[^>]*onload|onerror=/i.test(svg.replace(/^<svg viewBox="[^"]*"[^>]*>/, '')));
  const bad = { ...ledger, entries: [{ ...ledger.entries[0], amountCents: '1" onload="alert(1)' }] };
  assert.ok(api.Validation.validateLedger(bad).errors.some((e) => e.code === 'INVALID_MONEY' || /amountCents/.test(e.path)));
});

test('innerHTML 只能清空或放入已跳脫的趨勢圖，其餘一律用 textContent／createElement', () => {
  for (const rel of ['shared/app.js', 'shared/io.js', 'shared/money.js', 'shared/planning.js', 'shared/validation.js', 'shared/snapshots.js', 'shared/config.js']) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const m of src.matchAll(/\.(innerHTML|outerHTML)\s*=\s*([^;]+);/g)) assert.ok(["''", 'trendSVG'].includes(m[2].trim()), `${rel}: ${m[0]}`);
    assert.ok(!/insertAdjacentHTML|document\.write|\beval\(|new Function\(/.test(src), `${rel} 含危險 API`);
  }
});

test('CSP 封住資料外流管道；新分頁連結都帶 noopener', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  for (const d of ["default-src 'self'", "script-src 'self'", "connect-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(csp.includes(d), d);
  assert.ok(!/script-src[^;]*unsafe/.test(csp));
  const app = fs.readFileSync(path.join(root, 'shared/app.js'), 'utf8');
  for (const m of app.matchAll(/target: '_blank'[^}]*/g)) assert.match(m[0], /rel: 'noopener/);
});

test('離線快取只處理本站 GET，不快取跨站或錯誤回應', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.match(sw, /request\.method !== 'GET' \|\| new URL\(request\.url\)\.origin !== self\.location\.origin/);
  assert.match(sw, /response\.ok && response\.type === 'basic'/);
  // 部署後立即生效：網路請求與預快取都不能拿瀏覽器 HTTP 快取（瀏覽器實測另有實際部署檢查）
  assert.match(sw, /fetch\(request\.url, \{ cache: 'no-cache' \}\)/);
  assert.match(sw, /new Request\(url, \{ cache: 'reload' \}\)/);
  assert.ok(!/localStorage|indexedDB/.test(sw.replace(/^\/\/.*$/gm, '')));
});

test('補預設值不可換掉已綁定在畫面上的物件（改用 fillDefaults 就地補值）', () => {
  // 2026-10-20：ensureMortgageSettings 等每次呼叫都用 { ...預設, ...(舊 || {}) } 換成新物件，
  // 輸入框仍綁著舊物件，修改寫進沒人讀的物件，房貸／學貸欄位改了立刻跳回預設值
  const src = fs.readFileSync(path.join(root, 'shared/app.js'), 'utf8');
  const offenders = [...src.matchAll(/^\s*((?:scenario|config|settings|s)\.[\w.]+)\s*=\s*\{[\s\S]{0,400}?\.\.\.\(\1 \|\| \{\}\)/gm)].map((m) => m[1]);
  assert.deepEqual(offenders, []);
  const ctx2 = { console };
  vm.createContext(ctx2);
  const fill = vm.runInContext(`(${src.match(/const fillDefaults = (\(target, defaults\) => \{[\s\S]*?\n  \});/)[1]})`, ctx2);
  const bound = { paymentDay: 9 };
  assert.equal(fill(bound, { paymentDay: 5, reserveMonths: 6 }), bound);
  assert.equal(bound.paymentDay, 9);
  assert.equal(bound.reserveMonths, 6);
});

test('commit 前隱私掃描確實會被 git 執行（hook 檔名必須是 pre-commit）', () => {
  // 2026-10-20：hook 原名 check-no-real-data.sh，git 從不執行，只剩 CI 一道防線
  const hook = path.join(root, 'hooks', 'pre-commit');
  assert.ok(fs.existsSync(hook));
  assert.match(fs.readFileSync(hook, 'utf8'), /bash scripts\/check-no-real-data\.sh --staged/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'hooks')), ['pre-commit']);
});

test('固定支出：可跟房租一樣選繳款週期，只在繳款月付每月金額 × 週期', () => {
  const flow = { id: 'ins', name: '保險', type: 'expense', kind: 'fixed_expense', amountCents: 100000, dayOfMonth: 5, accountId: 'bank', payCycleMonths: 3, payStartMonth: '2026-02' };
  const due = (ym, f = flow) => api.Money.flowDueInMonth(f, ym);
  assert.equal(due('2026-01'), 0); // 首次繳款月之前不付
  assert.equal(due('2026-02'), 300000);
  assert.equal(due('2026-03'), 0);
  assert.equal(due('2026-05'), 300000);
  assert.equal(due('2027-02'), 300000);
  assert.equal(due('2026-03', { ...flow, payCycleMonths: undefined }), 100000); // 舊資料沒有週期＝每月繳
  assert.equal(due('2026-03', { ...flow, payStartMonth: undefined }), 0);
  // 每月平均不受週期影響
  assert.equal(api.Money.calcRecurringMonthly([flow], api.DEFAULT_CONFIG.insuranceRates).essentialExpenseCents, 100000);
  assert.equal(api.Validation.validateRecurringFlows([flow]).valid, true);
  assert.equal(api.Validation.validateRecurringFlows([{ ...flow, payCycleMonths: 1, payStartMonth: undefined }]).valid, true);
  assert.equal(api.Validation.validateRecurringFlows([{ ...flow, payCycleMonths: 4 }]).valid, false);
  assert.equal(api.Validation.validateRecurringFlows([{ ...flow, payStartMonth: '' }]).valid, false);
});

test('分配用途集中登記：每個必備用途都有搭配帳戶欄位，帳戶不存在時驗證會擋、修復會改回', () => {
  const P = Array.from(api.ALLOCATION_PURPOSES);
  assert.deepEqual(P.map(p => p.key), ['fixed', 'living', 'emergency', 'saving']);
  assert.equal(new Set(P.map(p => p.field)).size, P.length);
  const result = api.Planning.allocateMonthly({ incomeCents: 9000000, livingCents: 1, fixedExpenseCents: 1, emergencyMonthlyCents: 1, savingCents: 1, savingsAccountId: 'save' });
  for (const row of result.rows.filter(r => r.required)) assert.equal(row.label, P.find(p => p.key === row.key).label);
  assert.equal(result.rows.find(r => r.key === 'saving').accountId, 'save');
  const config = structuredClone(api.DEFAULT_CONFIG);
  config.dashboard.savingAccountId = 'gone';
  const workspace = { config, ledger: structuredClone(api.DEFAULT_LEDGER), scenarios: structuredClone(api.DEFAULT_SCENARIOS) };
  assert.ok(api.Validation.validateWorkspace(workspace).errors.some(e => e.path === 'config.dashboard.savingAccountId'));
  api.Validation.repairWorkspace(workspace, api.DEFAULT_CONFIG);
  assert.equal(workspace.config.dashboard.savingAccountId, config.accountProfiles[0].id);
});

test('發薪週期：從最近一次發薪日起算，跨年與小月月底都正確', () => {
  const c = api.Planning.payCycle(new Date(2026, 9, 21), 5);
  assert.deepEqual([c.start, c.next, c.totalDays, c.elapsedDays, c.daysLeft], ['2026-10-05', '2026-11-05', 31, 17, 15]);
  const early = api.Planning.payCycle(new Date(2026, 0, 3), 5);
  assert.deepEqual([early.start, early.next], ['2025-12-05', '2026-01-05']);
  const payday = api.Planning.payCycle(new Date(2026, 9, 5), 5);
  assert.deepEqual([payday.start, payday.elapsedDays], ['2026-10-05', 1]);
  const eom = api.Planning.payCycle(new Date(2026, 1, 28), 31);
  assert.deepEqual([eom.start, eom.next], ['2026-02-28', '2026-03-31']);
});

test('分配狀態：依已過天數與實際帳務判斷並給建議', () => {
  const cycle = { elapsedDays: 15, totalDays: 30, daysLeft: 16, ratio: 0.5 };
  const row = (key, allocated, shortfall = 0) => ({ key, allocatedCents: allocated, requestedCents: allocated + shortfall, shortfallCents: shortfall });
  const S = (r, f, c = cycle) => api.Planning.allocationStatus(r, c, { accountName: '主要銀行', ...f });
  // 生活費：1 萬預算過半月，花 5,000 正常、6,000 超前、1.2 萬超支
  assert.equal(S(row('living', 1000000), { spentCents: 500000 }).level, 'ok');
  assert.match(S(row('living', 1000000), { spentCents: 500000 }).text, /剩 16 天，每日可花 312元/);
  assert.equal(S(row('living', 1000000), { spentCents: 600000 }).level, 'watch');
  assert.equal(S(row('living', 1000000), { spentCents: 1200000 }).level, 'short');
  assert.equal(S(row('living', 1000000), { spentCents: 100000, balanceCents: 200000 }).level, 'watch'); // 帳戶不夠剩下的生活費
  // 固定支出：還沒扣的要由帳戶餘額撐住
  assert.equal(S(row('fixed', 900000), { dueTotalCents: 900000, paidCents: 300000, balanceCents: 700000 }).level, 'ok');
  assert.match(S(row('fixed', 900000), { dueTotalCents: 900000, paidCents: 300000, balanceCents: 100000 }).text, /餘額不足 5,000元/);
  assert.equal(S(row('fixed', 900000), { dueTotalCents: 900000, paidCents: 900000, balanceCents: 0 }).level, 'ok');
  // 儲蓄類：發薪後 3 天內提醒先轉，過了仍未轉就不足；跟薪資同帳戶分不出來
  assert.equal(S(row('saving', 300000), { movedInCents: 300000 }).level, 'ok');
  assert.equal(S(row('saving', 300000), { movedInCents: 0 }, { ...cycle, elapsedDays: 2 }).level, 'watch');
  assert.match(S(row('saving', 300000), { movedInCents: 100000 }).text, /^先轉 2,000元 到主要銀行；因為第 15 天了，本期還差 2,000元/);
  assert.match(S(row('emergency', 300000), { sharedWithIncome: true }).text, /薪資入帳/);
  assert.match(S(row('saving', 100000, 200000), { movedInCents: 100000 }).lines.at(-1), /^收入只夠分配 1,000元（需要 3,000元）/);
});

test('分配狀態文字：沒有應扣款與只因餘額不足時不出現 0 元的誤導說法', () => {
  const cycle = { elapsedDays: 15, totalDays: 30, daysLeft: 16, ratio: 0.5 };
  const S = (key, f) => api.Planning.allocationStatus({ key, allocatedCents: 1000000, requestedCents: 1000000, shortfallCents: 0 }, cycle, { accountName: '主要銀行', ...f }).text;
  assert.equal(S('fixed', { dueTotalCents: 0, paidCents: 0, balanceCents: 0 }), '本期沒有要扣的固定支出');
  const low = S('living', { spentCents: 0, balanceCents: 0 });
  assert.ok(!low.includes('多花') && low.startsWith('先轉 10,000元 到主要銀行；因為主要銀行只有 0元'), low);
});

// 2026-10-23 使用者回報「第 14／31 天，已花 0元（進度 2,258元）…不夠剩下的生活費」難懂：結論先行、缺多少直接寫
test('分配狀態：生活費帳戶餘額不夠時先講要轉多少，再講每日可花', () => {
  const cycle = { elapsedDays: 14, totalDays: 31, daysLeft: 18, ratio: 14 / 31 };
  const living = { key: 'living', allocatedCents: 500000, requestedCents: 500000, shortfallCents: 0 };
  const s = api.Planning.allocationStatus(living, cycle, { accountName: '台新', spentCents: 0, spareCents: 74200, balanceCents: 100000 });
  assert.deepEqual([...s.lines], ['先轉 4,000元 到台新', '因為台新只有 1,000元，這期生活費還有 5,000元沒花', '轉完後剩 18 天，每日可花 319元（已花 0元，照天數平均到今天約 2,258元）']);
  assert.equal(s.text, s.lines.join('；'));
  assert.equal(s.action, '轉 4,000元 到台新當生活費');
  // 每種狀況第一行都是結論、第二行以「因為」講原因（正常時第二行只是參考數字）
  const L = (f) => api.Planning.allocationStatus(living, cycle, { accountName: '台新', spareCents: 74200, ...f }).lines;
  assert.match(L({ spentCents: 550000 })[0], /^已超出生活費預算 500元；/);
  assert.match(L({ spentCents: 300000 })[0], /^花得比平均快；/);
  assert.match(L({ spentCents: 300000 })[1], /^因為已花 3,000元/);
  assert.match(L({ spentCents: 700000 })[0], /^已超支 /);
  assert.match(L({ spentCents: 300000, balanceCents: 0 })[2], /^另外台新只有 0元.*要轉入 2,000元$/);
  assert.match(L({ spentCents: 100000 })[0], /^生活費正常；/);
});

// 取代 package.json 逐檔 node --check：index.html 載入的每支腳本與 sw.js 都要能編譯
test('index.html 載入的腳本與 sw.js 皆可編譯', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]).concat('sw.js');
  assert.ok(scripts.length >= 10);
  for (const rel of scripts) assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(root, rel), 'utf8'), { filename: rel }), rel);
});

// CSP 已拿掉 style-src 'unsafe-inline'：HTML 字串裡的 style 屬性與 <style> 會被瀏覽器擋下（element.style 不受影響）
test('不使用會被 CSP 擋下的行內樣式', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /style-src 'self';/);
  for (const rel of ['index.html', ...fs.readdirSync(path.join(root, 'shared')).filter((f) => f.endsWith('.js')).map((f) => `shared/${f}`)]) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.doesNotMatch(src, /\sstyle=["'\]|<style[\s>]/, rel);
  }
});

// 2026-10-22 首頁審查：同一頁的數字要出自同一套分配，不能把範例值或沒資料的狀態當成使用者的結論
test('分配狀態：沒有任何帳務資料時不判斷進度；固定儲蓄的預測轉帳只提醒確認', () => {
  const cycle = { elapsedDays: 18, totalDays: 31, daysLeft: 14, ratio: 18 / 31 };
  const row = (key, allocated) => ({ key, allocatedCents: allocated, requestedCents: allocated, shortfallCents: 0 });
  const S = (r, f) => api.Planning.allocationStatus(r, cycle, { accountName: '儲蓄帳戶', ...f });
  assert.equal(S(row('emergency', 700000), { noData: true }).level, 'none');
  assert.equal(S(row('living', 1200000), { noData: true, spentCents: 0 }).level, 'none');
  assert.equal(S(row('saving', 500000), { movedInCents: 0, projectedInCents: 500000 }).level, 'watch');
  const partial = S(row('emergency', 700000), { movedInCents: 0, projectedInCents: 500000 });
  assert.equal(partial.level, 'short');
  assert.match(partial.text, /^先轉 7,000元 到儲蓄帳戶；.*還差 7,000元.*預計轉入 5,000元/);
});

test('分配狀態：生活費的每日可花把未分配的錢算進來，超出預算但沒超過可花用只算留意', () => {
  const cycle = { elapsedDays: 18, totalDays: 31, daysLeft: 14, ratio: 18 / 31 };
  const living = { key: 'living', allocatedCents: 1200000, requestedCents: 1200000, shortfallCents: 0 };
  const S = (f) => api.Planning.allocationStatus(living, cycle, { accountName: '薪轉帳戶', ...f });
  assert.match(S({ spentCents: 850000, spareCents: 994300 }).text, /每日可花 960元/); // (12,000+9,943−8,500)/14
  assert.equal(S({ spentCents: 1500000, spareCents: 994300 }).level, 'watch');
  assert.equal(S({ spentCents: 2300000, spareCents: 994300 }).level, 'short');
});

test('每日生活費有給可花用金額時跟分配表同一個數字', () => {
  const r = api.Planning.assessMonthlySavings({ incomeCents: 3300000, fixedExpenseCents: 0, fixedSavingCents: 0, actualIncomeCents: 0, actualExpenseCents: 0, daysInMonth: 31, recommendedSavingCents: 900000, spendableCents: 2500000 });
  assert.equal(r.dailyLivingCents, Math.floor(2500000 / 31));
});

test('健檢沒設主要目標時不出現目標相關風險', () => {
  const plan = { ...structuredClone(api.DEFAULT_CONFIG.quickPlan), goalAmountTodayCents: 0, monthlyNetIncomeCents: 2000000 };
  const codes = api.Planning.assess(plan).risks.map(r => r.code);
  assert.ok(!codes.includes('GOAL_INFEASIBLE') && !codes.includes('INCOME_STRESS') && !codes.includes('GOAL_TIGHT'), codes.join());
  assert.ok(codes.includes('NEGATIVE_CASHFLOW'));
  assert.equal(api.DEFAULT_CONFIG.quickPlan.goalScenarioId, 'none');
});

test('月薪收入缺月工時時載入前補 160 小時，不讓整份工作區被拒', () => {
  const config = structuredClone(api.DEFAULT_CONFIG);
  config.recurringCashFlows = [{ id: 'sal', name: '薪資', type: 'income', kind: 'salary', amountCents: 4500000, dayOfMonth: 5, accountId: 'bank' }];
  const workspace = { config, ledger: structuredClone(api.DEFAULT_LEDGER), scenarios: structuredClone(api.DEFAULT_SCENARIOS) };
  assert.equal(api.Validation.validateWorkspace(workspace).valid, false);
  api.Validation.repairWorkspace(workspace, api.DEFAULT_CONFIG);
  assert.equal(config.recurringCashFlows[0].monthlyWorkHours, 160);
  assert.equal(api.Validation.validateWorkspace(workspace, { scenarioContentChecks: false }).valid, true);
});

test('分配狀態：收入付完前面用途後沒剩時直接說無法提撥，不出現「本期不需提撥」', () => {
  const cycle = { elapsedDays: 10, totalDays: 30, daysLeft: 21, ratio: 1 / 3 };
  const s = api.Planning.allocationStatus({ key: 'emergency', allocatedCents: 0, requestedCents: 700000, shortfallCents: 700000 }, cycle, { accountName: '儲蓄帳戶' });
  assert.equal(s.level, 'short');
  assert.ok(!s.text.includes('不需提撥') && s.text.includes('無法提撥'), s.text);
});

test('分配狀態：扣款日已過但帳本仍是預測的固定支出 → 留意並提示確認入帳；原因標籤分開「收入不夠」與「尚未轉入」', () => {
  const cycle = { elapsedDays: 10, totalDays: 30, daysLeft: 21, ratio: 1 / 3 };
  const fixed = api.Planning.allocationStatus({ key: 'fixed', allocatedCents: 1200000, shortfallCents: 0 }, cycle, { dueTotalCents: 1200000, paidCents: 0, unconfirmedCents: 1200000, balanceCents: 5000000, accountName: '主要銀行' });
  assert.equal(fixed.level, 'watch');
  assert.equal(fixed.tag, '待確認入帳');
  assert.ok(fixed.text.includes('確認入帳'), fixed.text);
  const notMoved = api.Planning.allocationStatus({ key: 'emergency', allocatedCents: 500000, shortfallCents: 0 }, cycle, { movedInCents: 0, accountName: '儲蓄' });
  assert.deepEqual([notMoved.level, notMoved.tag], ['short', '尚未轉入']);
  const noIncome = api.Planning.allocationStatus({ key: 'emergency', allocatedCents: 0, requestedCents: 500000, shortfallCents: 500000 }, cycle, {});
  assert.deepEqual([noIncome.level, noIncome.tag], ['short', '收入不夠分配']);
  const ok = api.Planning.allocationStatus({ key: 'emergency', allocatedCents: 500000, shortfallCents: 0 }, cycle, { movedInCents: 500000 });
  assert.equal(ok.tag, undefined);
});

test('舊存檔的固定儲蓄轉出、轉入同一帳戶：載入前改成另一個帳戶並暫停，整份工作區不再被拒', () => {
  const config = structuredClone(api.DEFAULT_CONFIG);
  config.recurringCashFlows = [{ id: 's1', type: 'saving', kind: 'saving', name: '存錢', amountCents: 500000, dayOfMonth: 5, accountId: 'bank', fromAccountId: 'bank', active: true }];
  const workspace = { config, ledger: structuredClone(api.DEFAULT_LEDGER), scenarios: structuredClone(api.DEFAULT_SCENARIOS) };
  assert.ok(api.Validation.validateWorkspace(workspace).errors.some(e => e.code === 'INVALID_SAVING_TRANSFER'));
  api.Validation.repairWorkspace(workspace, api.DEFAULT_CONFIG);
  const flow = workspace.config.recurringCashFlows[0];
  assert.notEqual(flow.fromAccountId, flow.accountId);
  assert.equal(flow.active, false);
  assert.ok(flow.repairNote);
  assert.ok(!api.Validation.validateWorkspace(workspace).errors.some(e => e.code === 'INVALID_SAVING_TRANSFER'));
});

test('分配狀態：生活費只是比進度多花時，標籤不能寫成超出預算', () => {
  const cycle = { elapsedDays: 18, totalDays: 31, daysLeft: 14, ratio: 18 / 31 };
  const ahead = api.Planning.allocationStatus({ key: 'living', allocatedCents: 1200000, shortfallCents: 0 }, cycle, { spentCents: 850000, spareCents: 0, balanceCents: 9000000 });
  assert.deepEqual([ahead.level, ahead.tag], ['watch', '花得比進度快']);
  const over = api.Planning.allocationStatus({ key: 'living', allocatedCents: 1200000, shortfallCents: 0 }, cycle, { spentCents: 1300000, spareCents: 500000, balanceCents: 9000000 });
  assert.deepEqual([over.level, over.tag], ['watch', '超出預算']);
});

test('首頁結論：同一份分配算出一句結論、長條與解方；差額不超過生活費時給出生活費要降到多少', () => {
  const emergency = { coverageMonths: 1, targetMonths: 6, gapCents: 0 };
  const verdict = (living, income) => api.Planning.homeVerdict({ emergency, allocation: api.Planning.allocateMonthly({ incomeCents: income, fixedExpenseCents: 1000000, livingCents: living, emergencyMonthlyCents: 300000, savingCents: 300000 }) });
  const ok = verdict(1500000, 3500000);
  assert.equal(ok.level, 'ok');
  assert.equal(ok.headline, '本月可存 6,000元');
  assert.equal(ok.fixes.length, 0);
  assert.deepEqual([...ok.segments.map(s => s.key)], ['fixed', 'living', 'saving', 'spare']);
  assert.equal(ok.segments.reduce((s, x) => s + x.cents, 0), 3500000); // 長條加總就是收入
  const tight = verdict(2000000, 3500000);
  assert.equal(tight.level, 'watch');
  assert.equal(tight.headline, '本月可存 5,000元，離建議還差 1,000元');
  assert.deepEqual([...tight.fixes], ['生活費預算降到 19,000元，就能存滿建議金額']);
  const broke = verdict(2000000, 2500000);
  assert.equal(broke.level, 'short');
  assert.equal(broke.headline, '收入不夠付支出，每月差 5,000元');
  assert.deepEqual([...broke.fixes], ['每月多 11,000元 收入，或減少固定支出']);
});

test('分配狀態：要處理的狀態附一句可直接照做的解方；正常或收入不夠分配時沒有', () => {
  const cycle = { elapsedDays: 20, totalDays: 30, daysLeft: 11, ratio: 2 / 3 };
  const S = (r, f) => api.Planning.allocationStatus({ requestedCents: r.allocatedCents + (r.shortfallCents || 0), shortfallCents: 0, label: '緊急預備金', ...r }, cycle, { accountName: '儲蓄帳戶', ...f });
  assert.equal(S({ key: 'emergency', allocatedCents: 500000 }, { movedInCents: 200000 }).action, '轉 3,000元 到儲蓄帳戶（緊急預備金）');
  assert.equal(S({ key: 'emergency', allocatedCents: 500000 }, { movedInCents: 500000 }).action, undefined);
  assert.equal(S({ key: 'emergency', allocatedCents: 500000, shortfallCents: 100000 }, { movedInCents: 0 }).action, undefined);
  assert.equal(S({ key: 'fixed', allocatedCents: 500000 }, { dueTotalCents: 500000, paidCents: 0, balanceCents: 100000 }).action, '扣款日前轉 4,000元 到儲蓄帳戶');
  assert.equal(S({ key: 'living', allocatedCents: 1000000 }, { spentCents: 1200000 }).action, '生活費已超支 2,000元，剩 11 天只花必要開銷');
});

test('單一權威來源：日期字串、匯率換算、預設月工時、固定項目陣列只在各自的唯一位置處理', () => {
  const src = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const others = ['shared/app.js', 'shared/planning.js', 'shared/validation.js'];
  for (const rel of others) {
    // 年月／年月日用 Money.ym／Money.ymd；`${ym}-日` 這種由既有年月接日的組法不算
    assert.doesNotMatch(src(rel), /getMonth\(\) \+ 1\)\.padStart/, `${rel}: 用 Money.ym／Money.ymd`);
    assert.doesNotMatch(src(rel), /try \{[^}]*toTWDCents/, `${rel}: 用 Money.entryTWDCents`);
    assert.doesNotMatch(src(rel), /monthlyWorkHours[^;\n]*\b160\b/, `${rel}: 用 PLANNING_RULES.defaultMonthlyWorkHours`);
  }
  // migrateConfig 載入時已補成陣列，其他地方不再各自防呆
  assert.doesNotMatch(src('shared/app.js'), /recurringCashFlows \|\| \[\]|!Array\.isArray\(config\.recurringCashFlows\)/);
});

test('生活花費帳戶：自動判斷涵蓋常見帳戶組合，自選優先、無效帳戶忽略', () => {
  const P = api.Planning;
  const acc = (id, nature, liquid) => ({ id, nature, liquid });
  const ids = (r) => [...r.ids].sort().join(',');
  // 單一銀行帳戶包辦一切（預設設定）：銀行與現金都算
  const single = P.livingSpendAccounts({ accounts: [acc('cash', 'cash', true), acc('bank', 'checking', true)], spendIds: ['bank', 'bank'], savingIds: ['bank'] });
  assert.equal(ids(single), 'bank,cash');
  assert.equal(single.auto, true);
  // 薪轉＋信用卡＋儲蓄帳戶（緊急預備金、旅遊目標）＋投資：只算薪轉、信用卡、現金
  const split = [acc('salary', 'checking', true), acc('card', 'credit', false), acc('save', 'savings', true), acc('trip', 'earmarked', true), acc('etf', 'investment', false), acc('cash', 'cash', true)];
  assert.equal(ids(P.livingSpendAccounts({ accounts: split, spendIds: ['salary', 'salary', 'salary'], savingIds: ['save', 'save', 'trip'] })), 'card,cash,salary');
  // 生活費帳戶同時是緊急預備金帳戶：仍算（支出用途優先）
  assert.equal(ids(P.livingSpendAccounts({ accounts: split, spendIds: ['save', 'salary'], savingIds: ['save'] })), 'card,cash,salary,save,trip');
  // 自選優先；不存在的帳戶忽略；全部無效＝回到自動
  const chosen = P.livingSpendAccounts({ accounts: split, chosenIds: ['card', 'gone'], spendIds: ['salary'] });
  assert.equal(ids(chosen), 'card');
  assert.equal(chosen.auto, false);
  assert.equal(P.livingSpendAccounts({ accounts: split, chosenIds: ['gone'], spendIds: ['salary'] }).auto, true);
});

test('生活花費：刷卡算、卡費轉帳不重複、固定項目與預測與儲蓄帳戶不算；建議值取完整週期中位數', () => {
  const P = api.Planning;
  const ids = new Set(['salary', 'card']);
  const exp = (date, yuan, account, extra = {}) => ({ type: 'expense', date, amountCents: -yuan * 100, currency: 'TWD', rateToTWD: 1, account, status: 'realized', ...extra });
  const entries = [
    exp('2026-07-20', 999, 'salary'), // 記帳開始在週期中間：07-05 起那期不完整，不算
    exp('2026-08-10', 9000, 'card'), exp('2026-08-20', 1000, 'salary'),
    { type: 'transfer', date: '2026-08-25', amountCents: 9000 * 100, currency: 'TWD', rateToTWD: 1, fromAccount: 'salary', toAccount: 'card', status: 'realized' },
    exp('2026-08-26', 8000, 'salary', { recurringFlowId: 'rent' }), // 固定支出
    exp('2026-09-10', 12000, 'salary'), exp('2026-09-12', 5000, 'save'), // 動用儲蓄帳戶不算
    exp('2026-09-15', 10, undefined, { currency: 'USD', rateToTWD: 32 }), // 沒帳戶的舊帳目算，外幣換台幣
    exp('2026-09-30', 30000, 'card', { status: 'projected' }),
    exp('2026-10-01', 40000, 'card') // 單次大額：中位數不受影響
  ];
  assert.equal(P.livingSpendCents(entries, ids, '2026-08-05', '2026-09-05'), 1000000);
  const h = P.livingSpendHistory({ entries, accountIds: ids, payday: 5, today: new Date(2026, 9, 22) });
  assert.deepEqual(Array.from(h.cycles, c => [c.start, c.spentCents]), [['2026-09-05', 4000000 + 1232000], ['2026-08-05', 1000000]]);
  assert.equal(h.medianCents, Math.round((1000000 + 5232000) / 2));
  assert.equal(h.suggestedCents, 3120000); // 31,160 進位到 31,200
  assert.equal(P.livingSpendHistory({ entries: [exp('2026-10-10', 100, 'card')], accountIds: ids, payday: 5, today: new Date(2026, 9, 22) }).suggestedCents, null);
});

test('轉帳指示：依帳戶合併、加總等於已分配收入；同帳戶轉入先算支出、存入的錢不算可用餘額', () => {
  const P = api.Planning;
  const rows = [
    { key: 'fixed', label: '固定支出', allocatedCents: 1000000, accountId: 'salary' },
    { key: 'living', label: '生活費', allocatedCents: 1200000, accountId: 'spend' },
    { key: 'emergency', label: '緊急預備金', allocatedCents: 300000, accountId: 'save' },
    { key: 'saving', label: '一般儲蓄', allocatedCents: 200000, accountId: 'save' },
    { key: 'trip', label: '旅遊', allocatedCents: 0, accountId: 'save' }
  ];
  const plan = P.transferPlan({ rows, stayAccountIds: ['salary'], accounts: { spend: { balanceCents: 200000 }, save: { balanceCents: 900000, movedInCents: 100000, projectedInCents: 150000 } }, spendingNeed: { salary: 600000, spend: 1200000 } });
  const save = plan.transfers.find(t => t.accountId === 'save');
  assert.deepEqual(Array.from(save.purposes), ['緊急預備金', '一般儲蓄']);
  assert.equal(plan.transfers.filter(t => !t.stay).reduce((s, t) => s + t.plannedCents, 0) + plan.stayCents, 2700000);
  // 已轉入 1,000 先給緊急預備金，固定儲蓄預計 1,500 再補：3,000+2,000－1,000－1,500＝2,500
  assert.equal(save.remainingCents, 250000);
  assert.deepEqual({ ...plan.rowFacts.emergency }, { movedInCents: 100000, projectedInCents: 150000 });
  assert.equal(plan.transfers.find(t => t.accountId === 'spend').remainingCents, 1000000);
  // 薪資帳戶餘額不足只回報缺額（stay），不叫你從自己轉給自己
  const short = P.transferPlan({ rows, stayAccountIds: ['salary'], accounts: { salary: { balanceCents: 400000 } }, spendingNeed: { salary: 600000 } }).transfers.find(t => t.accountId === 'salary');
  assert.deepEqual([short.stay, short.remainingCents], [true, 200000]);
  // 生活費與緊急預備金同帳戶：本期轉入 15,000 先抵生活費 12,000，剩 3,000 才算存入；存入的錢不能拿來付生活費
  const shared = rows.map(r => r.key === 'living' ? { ...r, accountId: 'save' } : r);
  const s2 = P.transferPlan({ rows: shared, stayAccountIds: ['salary'], accounts: { save: { balanceCents: 1500000, movedInCents: 1500000 } }, spendingNeed: { save: 1200000 } });
  assert.deepEqual({ ...s2.rowFacts.emergency }, { movedInCents: 300000, projectedInCents: 0 });
  assert.equal(s2.transfers.find(t => t.accountId === 'save').spendLackCents, 0);
  assert.equal(s2.transfers.find(t => t.accountId === 'save').remainingCents, 200000); // 只差一般儲蓄 2,000
});

test('轉帳指示與分配狀態同一數字：固定支出與生活費同帳戶時，兩列缺額加總＝轉帳指示', () => {
  const P = api.Planning;
  const cycle = P.payCycle(new Date(2026, 9, 22), 5);
  const fixed = { key: 'fixed', label: '固定支出', allocatedCents: 1000000, requestedCents: 1000000, shortfallCents: 0, accountId: 'spend' };
  const living = { key: 'living', label: '生活費', allocatedCents: 1200000, requestedCents: 1200000, shortfallCents: 0, accountId: 'spend' };
  const yuan = (s) => Number(s.match(/轉 ([\d,]+)元/)?.[1].replace(/,/g, '') || 0) * 100;
  for (const balance of [300000, 900000, 1500000]) {
    const need = P.spendingNeedByAccount({ fixedAccountId: 'spend', livingAccountId: 'spend', fixedDueRemainingCents: 800000, livingBudgetCents: 1200000, livingSpentCents: 500000 });
    const plan = P.transferPlan({ rows: [fixed, living], accounts: { spend: { balanceCents: balance } }, spendingNeed: need });
    const f = P.allocationStatus(fixed, cycle, { accountName: 'A', balanceCents: balance, dueTotalCents: 800000, paidCents: 0 });
    const l = P.allocationStatus(living, cycle, { accountName: 'A', balanceCents: balance - 800000, spentCents: 500000 });
    const statusLack = (f.transfer ? yuan(f.action) : 0) + (l.transfer ? yuan(l.action) : 0);
    assert.equal(statusLack, plan.transfers[0].remainingCents, `balance ${balance}`);
  }
});

test('每期收支報告：帳戶間轉帳不算收支；轉進儲蓄、轉回動用、從儲蓄帳戶直接付款分開算', () => {
  const P = api.Planning;
  const e = (type, date, yuan, extra) => ({ type, date, amountCents: (type === 'expense' ? -yuan : yuan) * 100, currency: 'TWD', rateToTWD: 1, status: 'realized', ...extra });
  const entries = [
    e('income', '2026-09-05', 40000, { account: 'bank' }),
    e('expense', '2026-09-08', 3000, { account: 'card', category: '食' }),
    e('transfer', '2026-09-06', 10000, { fromAccount: 'bank', toAccount: 'save' }),
    e('transfer', '2026-09-20', 2000, { fromAccount: 'save', toAccount: 'bank' }),
    e('transfer', '2026-09-25', 3000, { fromAccount: 'bank', toAccount: 'card' }), // 卡費：不是儲蓄
    e('expense', '2026-09-22', 1500, { account: 'save', category: '旅遊' }),
    e('expense', '2026-09-26', 8000, { account: 'bank', recurringFlowId: 'rent' })
  ];
  const [r] = P.cycleReports({ entries, cycles: [{ start: '2026-09-05', next: '2026-10-05' }], livingIds: new Set(['bank', 'card']), savingIds: ['save'], openingCents: 500000 });
  assert.equal(r.savedCents, (40000 - 3000 - 1500 - 8000) * 100);
  assert.equal(r.toSavingsCents, 800000);
  assert.equal(r.withdrawnCents, 200000);
  assert.equal(r.spentFromSavingsCents, 150000);
  assert.equal(r.livingCents, 300000);
  assert.equal(r.netWorthEndCents, 500000 + r.savedCents);
});

test('存花習慣：上期多花最多的分類、本期已超過平常、動用存款與存了沒轉進儲蓄都提醒；連續達標期數', () => {
  const P = api.Planning;
  const rep = (food, drink, saved, extra = {}) => ({ byCategory: { 食: food * 100, 飲料: drink * 100 }, savedCents: saved * 100, toSavingsCents: saved * 100, withdrawnCents: 0, spentFromSavingsCents: 0, ...extra });
  const reports = [rep(9000, 1000, 9000, { withdrawnCents: 300000 }), rep(6000, 1000, 9000), rep(6200, 1100, 9000), rep(5800, 900, 5000)];
  const h = P.habitInsights({ reports, current: { byCategory: { 飲料: 150000 } }, recommendedSavingCents: 800000 });
  assert.equal(h.topIncrease.category, '食');
  assert.equal(h.topIncrease.extraCents, 300000);
  assert.equal(h.overNow[0].category, '飲料');
  assert.equal(h.streak, 3);
  assert.ok(h.lines.some(l => l.includes('動用存款 3,000元')));
  // 小波動不提醒（少於 500 元或 20%）
  assert.equal(P.habitInsights({ reports: [rep(6300, 1000, 1), rep(6000, 1000, 1)], recommendedSavingCents: 0 }).topIncrease, null);
  const kept = P.habitInsights({ reports: [rep(6000, 1000, 9000, { toSavingsCents: 200000 })], recommendedSavingCents: 0 });
  assert.ok(kept.lines.some(l => l.includes('只有 2,000元 轉進儲蓄帳戶')));
});

test('達成預測：實際速度依計畫比例分給各項，晚於目標月份要標示', () => {
  const P = api.Planning;
  const f = P.goalForecast({ items: [{ label: '緊急預備金', gapCents: 1200000, plannedMonthlyCents: 200000 }, { label: '旅遊', gapCents: 600000, plannedMonthlyCents: 200000, targetMonth: '2026-12' }, { label: '已達成', gapCents: 0, plannedMonthlyCents: 0 }],
    plannedSavingCents: 400000, actualMonthlyCents: 200000, today: new Date(2026, 9, 22) });
  assert.deepEqual(Array.from(f, i => [i.label, i.paceCents, i.months, i.doneMonth, i.late]), [['緊急預備金', 100000, 12, '2027-10', false], ['旅遊', 100000, 6, '2027-04', true]]);
  assert.equal(P.goalForecast({ items: [{ label: 'x', gapCents: 1, plannedMonthlyCents: 1, targetMonth: '2027-01' }], plannedSavingCents: 1, actualMonthlyCents: -5, today: new Date(2026, 9, 22) })[0].late, true);
});

test('收入目標：建議收入恰好付得起支出加應儲蓄（與分配同一規則）；工時、時薪、上限與基本工資', () => {
  const P = api.Planning;
  const rate = api.PLANNING_RULES.savingsRateTarget;
  for (const [spend, floor] of [[2500000, 300000], [2500000, 1000000], [0, 0]]) {
    const r = P.requiredIncome({ spendCents: spend, savingFloorCents: floor });
    const saving = Math.max(floor, Math.ceil(r.recommendedCents * rate));
    assert.ok(r.recommendedCents - spend >= saving, `${spend}/${floor}`);
    assert.ok(r.recommendedCents - 1 - spend < Math.max(floor, Math.ceil((r.recommendedCents - 1) * rate)), `minimal ${spend}/${floor}`);
  }
  // 時薪 200、淨額為稅前 90%，另有 5,000 其他收入：要淨 23,000 → 這份要淨 18,000 → 稅前 20,000 → 100 小時
  const flow = { netCents: 1440000, grossCents: 1600000, hourlyRateCents: 20000, monthlyWorkHours: 80 };
  const t = P.workTarget({ needNetCents: 2300000, otherNetCents: 500000, flow, maxMonthlyHours: 40 * 52 / 12, minimumHourlyCents: 19600 });
  assert.deepEqual([t.grossNeededCents, t.hoursAtRate, t.wageAtHoursCents, t.overMax, t.belowMinimum], [2000000, 100, 25000, false, false]);
  const over = P.workTarget({ needNetCents: 9000000, flow, maxMonthlyHours: 40 * 52 / 12, minimumHourlyCents: 19600 });
  assert.equal(over.overMax, true);
  assert.equal(over.wageAtMaxCents, Math.ceil(10000000 / (40 * 52 / 12) / 100) * 100);
  assert.equal(P.workTarget({ needNetCents: 1, flow: { ...flow, hourlyRateCents: 19000 }, maxMonthlyHours: 100, minimumHourlyCents: 19600 }).belowMinimum, true);
  // 基本工資依日期取用，下一筆已公告的另外列出
  const w = P.minimumWageOn('2026-10-22');
  assert.deepEqual([w.current.hourlyCents, w.next.hourlyCents, w.next.effectiveFrom], [19600, 20500, '2027-01-01']);
  assert.equal(P.minimumWageOn('2027-01-01').current.hourlyCents, 20500);
});

test('旅費：數量依天數與人數（晚數＝天數－1），預設範例 1 人 10 天總額與改版前相同', () => {
  const trip = { days: 10, people: 3 };
  const q = Object.fromEntries(['trip', 'person', 'day', 'person_day', 'night', 'person_night'].map(b => [b, api.Money.tripQuantity(b, trip)]));
  assert.deepEqual(q, { trip: 1, person: 3, day: 10, person_day: 30, night: 9, person_night: 27 });
  const s = structuredClone(api.DEFAULT_SCENARIOS.find(x => x.scenarioId === 'trip_budget'));
  const legacyTotal = 1000000 + 1800000 + 210000 + 420000 + 2100000;
  assert.equal(api.Money.calcScenario(s, api.DEFAULT_CONFIG).total, legacyTotal);
  s.trip.people = 2;
  // 機票與每人每天加倍，整間房的住宿不變
  assert.equal(api.Money.calcScenario(s, api.DEFAULT_CONFIG).total, 2000000 + 1800000 + 2 * (210000 + 420000 + 2100000));
});

test('旅費：目的地貨幣的項目乘匯率換成台幣，缺匯率時驗證擋下而不是算成 0', () => {
  const s = structuredClone(api.DEFAULT_SCENARIOS.find(x => x.scenarioId === 'trip_budget'));
  s.items = [{ label: '住宿', kind: 'cost', basis: 'night', currency: 'JPY', amountCents: 2000000 }, { label: '折價券', kind: 'discount', basis: 'trip', currency: 'TWD', amountCents: 100000 }];
  assert.equal(api.Validation.validateScenario(s).errors.map(e => e.code).join(), 'INVALID_RATE');
  s.rateToTWD = 0.2;
  assert.equal(api.Validation.validateScenario(s).valid, true);
  const r = api.Money.calcScenario(s, api.DEFAULT_CONFIG);
  assert.equal(r.lines[0].twdCents, 3600000); // ¥20,000 × 9 晚 × 0.2
  assert.equal(r.total, 3500000);
  assert.match(r.formulaText, /住宿：.*× 9 晚/);
  s.items[0].currency = 'EUR';
  s.trip.days = 0;
  assert.deepEqual(Array.from(api.Validation.validateScenario(s).errors, e => e.code).sort(), ['INVALID_CURRENCY', 'INVALID_DAYS']);
});

test('旅費：舊存檔沒改過的內建項目換成新範例、改過的保留為整趟台幣，總額都不變', () => {
  const legacy = { schemaVersion: 2, currency: 'TWD', rateToTWD: 1, calcType: 'items', scenarioId: 'trip_budget', label: '旅費預算試算', applyInflation: true, inflationKey: 'JP',
    items: [['機票', 1000000], ['民宿', 1800000], ['交通費用（10日）', 210000], ['伙食費（10日）', 420000], ['娛樂費（10日）', 2100000]].map(([label, amountCents]) => ({ label, amountCents })) };
  const fresh = api.Validation.normalizeScenario(legacy);
  assert.equal(fresh.trip.days, 10);
  assert.equal(fresh.items[1].basis, 'night');
  assert.equal(api.Money.calcScenario(fresh, api.DEFAULT_CONFIG).total, 5530000);
  const edited = structuredClone(legacy);
  edited.items[0].amountCents = 1500000;
  const kept = api.Validation.normalizeScenario(edited);
  assert.deepEqual([kept.trip.destination, kept.currency, kept.rateToTWD], ['JP', 'JPY', 0]);
  assert.ok(kept.items.every(i => i.basis === 'trip' && i.currency === 'TWD'));
  assert.equal(api.Validation.validateScenario(kept).valid, true);
  assert.equal(api.Money.calcScenario(kept, api.DEFAULT_CONFIG).total, 6030000);
});
