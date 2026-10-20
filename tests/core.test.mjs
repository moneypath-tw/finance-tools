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
const api = vm.runInContext('({REFERENCE_DATA,DEFAULT_CONFIG,SCENARIO_FIRE,Validation,Planning,Money,DEFAULT_LEDGER,DEFAULT_SCENARIOS})', ctx);

test('官方通膨快照包含來源與日期', () => {
  assert.ok(api.REFERENCE_DATA.twInflation.sourceUrl.startsWith('https://'));
  assert.match(api.REFERENCE_DATA.twInflation.observedThrough, /^\d{4}-\d{2}-\d{2}$/);
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
  assert.equal(result.hourlyRateCents, 20625);
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
  assert.equal(result.monthlySavingsCents, result.incomeCents - 1200000);
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
  assert.equal(b.hourlyRateCents, 166667);
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
  assert.equal(r.electricity.monthlyCents, Math.round(5 * 365 / 12 * 500));
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

test('多帳戶分配先滿足生活、固定支出與緊急預備金', () => {
  const result = api.Planning.allocateMonthly({
    incomeCents: 5000000, livingCents: 1800000, fixedExpenseCents: 1200000, emergencyGapCents: 1200000,
    savingCents: 300000, livingAccountId: 'living', fixedExpenseAccountId: 'fixed', emergencyAccountId: 'emergency', savingsAccountId: 'saving',
    goals: [{ key: 'trip', label: '旅行', gapCents: 2400000, months: 12, accountId: 'trip' }]
  });
  assert.deepEqual(Array.from(result.rows, r => r.accountId), ['living', 'fixed', 'emergency', 'saving', 'trip']);
  assert.deepEqual(Array.from(result.rows, r => r.allocatedCents), [1800000, 1200000, 100000, 300000, 200000]);
  assert.equal(result.unallocatedCents, 1400000);
});

test('收入不足時可選成本目標不會排擠必備分配', () => {
  const result = api.Planning.allocateMonthly({ incomeCents: 2000000, livingCents: 1500000, fixedExpenseCents: 1000000, emergencyGapCents: 1200000, goals: [{ key: 'goal', label: '目標', gapCents: 1200000, months: 12 }] });
  assert.equal(result.rows[0].allocatedCents, 1500000);
  assert.equal(result.rows[1].allocatedCents, 500000);
  assert.equal(result.rows[3].allocatedCents, 0);
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

test('FIRE反推納入其他目標：提高買房目標不得提早退休', () => {
  const c = structuredClone(api.DEFAULT_CONFIG);
  const base = structuredClone(api.SCENARIO_FIRE);
  base.retireAgeSolveMode = 'given_growth_rate';
  base.assumedSalaryGrowthRate = 0.03;
  const age1 = api.Money.calcScenario(base, c).solvedRetireAge;
  const larger = structuredClone(base);
  larger.buyHouseGoalCents *= 2;
  const age2 = api.Money.calcScenario(larger, c).solvedRetireAge;
  assert.ok(age2 === null || age1 === null || age2 >= age1);
});

test('FIRE拒絕零除與錯誤年齡順序', () => {
  const c = structuredClone(api.DEFAULT_CONFIG);
  const s = structuredClone(api.SCENARIO_FIRE);
  s.retireAge = s.startAge;
  assert.throws(() => api.Money.calcScenario(s, c), /年齡/);
});

test("FIRE 拒絕負數財務欄位與超過 100% 分配", () => {
  const c = structuredClone(api.DEFAULT_CONFIG);
  const s = structuredClone(api.SCENARIO_FIRE);
  s.retirementMonthlyExpenseCents = -1;
  s.allocationPercents["投資提撥（FIRE 基金）"] = 1.1;
  assert.throws(() => api.Money.calcScenario(s, c), /非負有限金額|100%/);
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
