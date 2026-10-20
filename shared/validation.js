// validation.js — 所有畫面輸入、匯入資料與計算入口共用的資料驗證。
const Validation = (() => {
  const error = (path, code, message) => ({ path, code, message });
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  const integer = (v) => Number.isInteger(v);
  const datePattern = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
  const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
  const currencies = new Set(['TWD', 'EUR', 'JPY', 'USD']);

  const isValidDate = (value) => {
    if (typeof value !== 'string' || !datePattern.test(value)) return false;
    const d = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
  };
  const isValidMonth = (value) => typeof value === 'string' && monthPattern.test(value);

  const validateQuickPlan = (p) => {
    const errors = [];
    if (!integer(p.currentAge) || p.currentAge < 0 || p.currentAge > 120) errors.push(error('currentAge', 'OUT_OF_RANGE', '目前年齡須為 0–120 的整數'));
    for (const key of ['monthlyNetIncomeCents', 'monthlyEssentialExpenseCents', 'monthlyOtherExpenseCents', 'liquidAssetsCents', 'goalAmountTodayCents']) {
      if (!finite(p[key]) || p[key] < 0) errors.push(error(key, 'INVALID_MONEY', `${key} 必須是大於或等於 0 的有限金額`));
    }
    if (!isValidMonth(p.goalTargetMonth)) errors.push(error('goalTargetMonth', 'INVALID_MONTH', '目標月份必須是 YYYY-MM'));
    if (!finite(p.inflationAnnualRate) || p.inflationAnnualRate <= -1 || p.inflationAnnualRate > 0.20) errors.push(error('inflationAnnualRate', 'OUT_OF_RANGE', '年通膨率須大於 −100% 且不高於 20%'));
    if (p.emergencyTargetMonths !== undefined && (!finite(p.emergencyTargetMonths) || p.emergencyTargetMonths < 3 || p.emergencyTargetMonths > 18)) errors.push(error('emergencyTargetMonths', 'OUT_OF_RANGE', '緊急預備金目標須介於 3–18 個月'));
    if (p.emergencyReserveCents !== undefined && (!finite(p.emergencyReserveCents) || p.emergencyReserveCents < 0)) errors.push(error('emergencyReserveCents', 'INVALID_MONEY', '指定緊急預備金必須是非負有限金額'));
    if (!finite(p.nominalReturnAnnualRate) || p.nominalReturnAnnualRate <= -1 || p.nominalReturnAnnualRate > 0.50) errors.push(error('nominalReturnAnnualRate', 'OUT_OF_RANGE', '名目年報酬率須大於 −100% 且不高於 50%'));
    return { valid: errors.length === 0, errors, warnings: [] };
  };

  const validateLedger = (data) => {
    const errors = [];
    if (!data || typeof data !== 'object' || !Array.isArray(data.entries)) return { valid: false, errors: [error('', 'INVALID_LEDGER', '帳本必須包含 entries 陣列')], warnings: [] };
    const ids = new Set();
    data.entries.forEach((e, i) => {
      const p = `entries[${i}]`;
      if (!e || typeof e !== 'object') { errors.push(error(p, 'INVALID_ENTRY', '帳目必須是物件')); return; }
      if (typeof e.id !== 'string' || !e.id) errors.push(error(`${p}.id`, 'MISSING_ID', '帳目缺少 ID'));
      else if (ids.has(e.id)) errors.push(error(`${p}.id`, 'DUPLICATE_ID', `帳目 ID 重複：${e.id}`));
      else ids.add(e.id);
      if (!isValidDate(e.date)) errors.push(error(`${p}.date`, 'INVALID_DATE', '日期必須是有效的 YYYY-MM-DD'));
      if (!['expense', 'income', 'wishlist', 'transfer'].includes(e.type)) errors.push(error(`${p}.type`, 'INVALID_TYPE', '帳目類型不合法'));
      if (e.type === 'transfer' && (!e.fromAccount || !e.toAccount || e.fromAccount === e.toAccount)) errors.push(error(p, 'INVALID_TRANSFER', '轉帳必須指定兩個不同帳戶'));
      if (!finite(e.amountCents) || !integer(e.amountCents)) errors.push(error(`${p}.amountCents`, 'INVALID_MONEY', '金額必須是有限整數分'));
      if (!currencies.has(e.currency || 'TWD')) errors.push(error(`${p}.currency`, 'INVALID_CURRENCY', '不支援此幣別'));
      if ((e.currency || 'TWD') !== 'TWD' && (!finite(e.rateToTWD) || e.rateToTWD <= 0)) errors.push(error(`${p}.rateToTWD`, 'INVALID_RATE', '外幣匯率必須大於 0'));
    });
    // 帳戶核對紀錄（帳戶核對模式，可沒有）；規則只寫在 snapshots.js
    if (typeof Snapshots !== 'undefined') Snapshots.validate(data.snapshots).forEach((msg) => errors.push(error('snapshots', 'INVALID_SNAPSHOT', msg)));
    return { valid: errors.length === 0, errors, warnings: [] };
  };

  const normalizeScenario = (scenario) => {
    const s = structuredClone(scenario);
    const normalizeItems = (items) => Array.isArray(items) ? items.map((item) => {
      if (!item || typeof item !== "object") return item;
      const legacyDiscount = item.kind === undefined && (Number(item.amountCents) < 0 || /折扣|減免|補助/.test(String(item.label || "")));
      const kind = item.kind === "discount" || legacyDiscount ? "discount" : (item.kind || "cost");
      const amountCents = Number.isFinite(item.amountCents) ? Math.abs(item.amountCents) : item.amountCents;
      const label = typeof item.label === "string" && item.label.trim() ? item.label : "未命名項目";
      return { ...item, label, kind, amountCents };
    }) : items;
    if (Array.isArray(s.items)) s.items = normalizeItems(s.items);
    if (Array.isArray(s.itemTemplate)) s.itemTemplate = normalizeItems(s.itemTemplate);
    const discountLabels = new Set((s.itemTemplate || []).filter(item => item?.kind === "discount").map(item => item.label));
    if (Array.isArray(s.periods)) s.periods = s.periods.map(period => {
      if (!period || typeof period !== "object" || !period.overrides || typeof period.overrides !== "object") return period;
      const overrides = Object.fromEntries(Object.entries(period.overrides).map(([label, value]) => [
        label,
        discountLabels.has(label) && Number.isFinite(value) ? Math.abs(value) : value
      ]));
      return { ...period, overrides };
    });
    return s;
  };

  const validateScenario = (s, path = 'scenario') => {
    const errors = [];
    if (!s || typeof s !== 'object') return { valid: false, errors: [error(path, 'INVALID_SCENARIO', '情境必須是物件')], warnings: [] };
    if (typeof s.scenarioId !== 'string' || !s.scenarioId) errors.push(error(`${path}.scenarioId`, 'MISSING_ID', '情境缺少 scenarioId'));
    if (s.calcType !== undefined && !['items', 'periods', 'retirement_fund', 'fire'].includes(s.calcType)) errors.push(error(path + '.calcType', 'INVALID_TYPE', 'Unsupported scenario type'));
    if (Array.isArray(s.items)) s.items.forEach((item, i) => {
      if (!item || typeof item.label !== "string" || !item.label.trim() || !["cost", "discount"].includes(item.kind || "cost") || !finite(item.amountCents) || !integer(item.amountCents) || item.amountCents < 0) errors.push(error(path + ".items[" + i + "]", "INVALID_ITEM", "項目必須包含名稱、類型與非負整數分金額"));
    });
    if (s.mortgage) {
      if (!finite(s.mortgage.purchaseAge) || s.mortgage.purchaseAge < 0) errors.push(error(`${path}.mortgage.purchaseAge`, 'INVALID_AGE', '購屋年齡必須為非負數'));
      if (!finite(s.mortgage.annualRate) || s.mortgage.annualRate < 0 || s.mortgage.annualRate > 0.20) errors.push(error(`${path}.mortgage.annualRate`, 'INVALID_RATE', '房貸年利率須介於 0%–20%'));
      if (!finite(s.mortgage.termYears) || s.mortgage.termYears < 1) errors.push(error(`${path}.mortgage.termYears`, 'INVALID_TERM', '房貸年限至少一年'));
      if (!finite(s.mortgage.graceYears) || s.mortgage.graceYears < 0 || s.mortgage.graceYears >= s.mortgage.termYears) errors.push(error(`${path}.mortgage.graceYears`, 'INVALID_TERM', '房貸寬限期必須小於總年限'));
      if (!['estimated', 'manual'].includes(s.mortgage.principalMode || 'estimated')) errors.push(error(`${path}.mortgage.principalMode`, 'INVALID_MODE', '房貸本金來源不合法'));
      if (s.mortgage.principalMode === 'manual' && (!finite(s.mortgage.manualPrincipalCents) || s.mortgage.manualPrincipalCents < 0)) errors.push(error(`${path}.mortgage.manualPrincipalCents`, 'INVALID_MONEY', '房貸未償本金必須為非負金額'));
    }
    if (s.calcType === 'retirement_fund') {
      if (!integer(s.currentAge) || !integer(s.retireAge) || !integer(s.deathAge) || !(s.currentAge < s.retireAge && s.retireAge < s.deathAge)) errors.push(error(path, 'AGE_ORDER', '養老金必須符合目前年齡 < 退休年齡 < 預期壽命'));
      if (!finite(s.monthlyLivingCostCents) || s.monthlyLivingCostCents < 0) errors.push(error(`${path}.monthlyLivingCostCents`, 'INVALID_MONEY', '每月生活費必須是非負有限金額'));
    }
    if (s.calcType === 'periods') {
      if (!Array.isArray(s.itemTemplate) || !Array.isArray(s.periods)) errors.push(error(path, 'INVALID_PERIODS', '期別情境缺少範本或期別陣列'));
      if (Array.isArray(s.itemTemplate)) s.itemTemplate.forEach((item, i) => {
        if (!item || typeof item.label !== "string" || !item.label.trim() || !['cost', 'discount'].includes(item.kind || 'cost') || !finite(item.amountCents) || !integer(item.amountCents) || item.amountCents < 0) errors.push(error(`${path}.itemTemplate[${i}]`, "INVALID_ITEM", "期別項目必須包含名稱、類型與非負整數分金額"));
      });
      if (s.repayment) {
        if (!finite(s.repayment.graduationAge) || s.repayment.graduationAge < 0) errors.push(error(`${path}.repayment.graduationAge`, 'INVALID_AGE', '預計畢業年齡必須為非負數'));
        if (!finite(s.repayment.graceYears) || s.repayment.graceYears < 0) errors.push(error(`${path}.repayment.graceYears`, 'INVALID_TERM', '寬限年數必須為非負數'));
        if (!finite(s.repayment.annualRate) || s.repayment.annualRate < 0 || s.repayment.annualRate > 0.20) errors.push(error(`${path}.repayment.annualRate`, 'INVALID_RATE', '學貸年利率須介於 0%–20%'));
        if (!['standard', 'extended', 'low_income'].includes(s.repayment.termPlan)) errors.push(error(`${path}.repayment.termPlan`, 'INVALID_TERM', '學貸攤還方案不合法'));
        if (!['estimated', 'manual'].includes(s.repayment.principalMode || 'estimated')) errors.push(error(`${path}.repayment.principalMode`, 'INVALID_MODE', '學貸本金來源不合法'));
        if (s.repayment.principalMode === 'manual' && (!finite(s.repayment.manualPrincipalCents) || s.repayment.manualPrincipalCents < 0)) errors.push(error(`${path}.repayment.manualPrincipalCents`, 'INVALID_MONEY', '銀行未償本金必須為非負金額'));
        if (!finite(s.repayment.reserveMonths) || s.repayment.reserveMonths < 0) errors.push(error(`${path}.repayment.reserveMonths`, 'INVALID_TERM', '預備金月數必須為非負數'));
      }
    }
    if (s.calcType === 'fire') {
      if (!integer(s.startAge) || !integer(s.retireAge) || !integer(s.deathAge)) errors.push(error(path, 'INVALID_AGE', 'FIRE 年齡必須是整數'));
      else if (!(s.startAge < s.retireAge && s.retireAge < s.deathAge)) errors.push(error(path, 'AGE_ORDER', '必須符合開始工作年齡 < 退休年齡 < 預期壽命'));
      if (!finite(s.postRetirementAnnualReturnRate) || s.postRetirementAnnualReturnRate < 0 || s.postRetirementAnnualReturnRate > 0.20) errors.push(error(`${path}.postRetirementAnnualReturnRate`, 'INVALID_RATE', '退休後年化報酬率須介於 0%–20%'));
      if (!['perpetuity', 'finite'].includes(s.retirementFundingModel || 'perpetuity')) errors.push(error(path + '.retirementFundingModel', 'INVALID_MODEL', 'Invalid retirement funding model'));
      if (s.retirementInflationAnnualRate !== undefined && (!finite(s.retirementInflationAnnualRate) || s.retirementInflationAnnualRate < 0 || s.retirementInflationAnnualRate > 0.20)) errors.push(error(path + '.retirementInflationAnnualRate', 'INVALID_RATE', '退休後通膨率須介於 0%–20%'));
      // money.js 的 calcFireScenario 一律用 `?? 0` 補上未填的通膨率再計算，
      // 這裡的永續模型可行性檢查也必須用同一個補完後的值比對，不能只在
      // 使用者「有明確填」時才檢查——否則單純省略此欄位（等同於填0）就會
      // 繞過這條防呆，money.js 那邊仍然照樣用0去算，算出一個看似合法但
      // 數學上不可能永續的財務獨立目標金額（2026-09-11全倉庫稽核發現）。
      const effectiveRetirementInflationRate = s.retirementInflationAnnualRate ?? 0;
      if ((s.retirementFundingModel || 'perpetuity') === 'perpetuity' && s.postRetirementAnnualReturnRate <= effectiveRetirementInflationRate) errors.push(error(path + '.retirementInflationAnnualRate', 'UNSUSTAINABLE_WITHDRAWAL', '永續模型要求退休後報酬率高於退休後通膨率'));
      const fireMoneyFields = ["currentMonthlySalaryCents", "currentMonthlyExpenseCents", "retirementMonthlyExpenseCents", "totalSavedCents", "buyHouseGoalCents", "studyAbroadFundCents", "insuredSalaryCents"];
      fireMoneyFields.forEach((key) => { if (!finite(s[key]) || s[key] < 0) errors.push(error(`${path}.${key}`, "INVALID_MONEY", `${key} 必須是非負有限金額`)); });
      if (!finite(s.emergencyFundMonths) || s.emergencyFundMonths < 0 || s.emergencyFundMonths > 120) errors.push(error(`${path}.emergencyFundMonths`, "INVALID_TERM", "FIRE 緊急預備金月數須介於 0–120 個月"));
      if (!s.allocationPercents || typeof s.allocationPercents !== "object" || Array.isArray(s.allocationPercents)) errors.push(error(`${path}.allocationPercents`, "INVALID_ALLOCATION", "薪資分配比例格式不合法"));
      else Object.entries(s.allocationPercents).forEach(([key, pct]) => { if (!finite(pct) || pct < 0 || pct > 1) errors.push(error(`${path}.allocationPercents.${key}`, "INVALID_ALLOCATION", "每項薪資分配比例須介於 0%–100%")); });
      if (!finite(s.assumedSalaryGrowthRate) || s.assumedSalaryGrowthRate <= -1 || s.assumedSalaryGrowthRate > 0.50) errors.push(error(`${path}.assumedSalaryGrowthRate`, 'INVALID_RATE', '薪資成長率須大於 −100% 且不高於 50%'));
      const preRetirementRate = s.preRetirementAnnualReturnRate ?? 0;
      if (!finite(preRetirementRate) || preRetirementRate < 0 || preRetirementRate > 0.50) errors.push(error(`${path}.preRetirementAnnualReturnRate`, 'INVALID_RATE', '退休前年報酬率須介於 0%–50%'));
    }
    return { valid: errors.length === 0, errors, warnings: [] };
  };

  // contentChecks=false 只檢查結構（物件、ID 唯一）；載入工作區時用，
  // 因為編輯中的情境本來就可能暫時不合法（例如先改退休年齡再改目前年齡），
  // 若連內容一起當成致命錯誤，整份工作區（含自訂情境）會在重新載入時被丟棄。
  const validateScenarios = (data, { contentChecks = true } = {}) => {
    const errors = [];
    if (!data || !Array.isArray(data.scenarios) || data.scenarios.length === 0) return { valid: false, errors: [error('scenarios', 'INVALID_SCENARIOS', '試算情境必須是非空陣列')], warnings: [] };
    const ids = new Set();
    data.scenarios.forEach((s, i) => {
      if (contentChecks) errors.push(...validateScenario(s, `scenarios[${i}]`).errors);
      else if (!s || typeof s !== 'object') errors.push(error(`scenarios[${i}]`, 'INVALID_SCENARIO', '情境必須是物件'));
      else if (typeof s.scenarioId !== 'string' || !s.scenarioId) errors.push(error(`scenarios[${i}].scenarioId`, 'MISSING_ID', '情境缺少 scenarioId'));
      if (s?.scenarioId && ids.has(s.scenarioId)) errors.push(error(`scenarios[${i}].scenarioId`, 'DUPLICATE_ID', `情境 ID 重複：${s.scenarioId}`));
      else if (s?.scenarioId) ids.add(s.scenarioId);
    });
    return { valid: errors.length === 0, errors, warnings: [] };
  };

  const validateWage = (s) => {
    const errors = [];
    if (!s || typeof s !== 'object') return { valid: false, errors: [error('', 'INVALID_WAGE', '工時情境必須是物件')], warnings: [] };
    if (!finite(s.targetAmountCents) || s.targetAmountCents < 0) errors.push(error('targetAmountCents', 'INVALID_MONEY', '目標金額必須為非負有限數字'));
    if (!finite(s.baseRateCentsPerHour) || s.baseRateCentsPerHour <= 0) errors.push(error('baseRateCentsPerHour', 'INVALID_RATE', '時薪必須大於 0'));
    if (!currencies.has(s.currency || 'TWD')) errors.push(error('currency', 'INVALID_CURRENCY', '不支援此幣別'));
    if ((s.currency || 'TWD') !== 'TWD' && (!finite(s.rateToTWD) || s.rateToTWD <= 0)) errors.push(error('rateToTWD', 'INVALID_RATE', '外幣匯率必須大於 0'));
    if (!Array.isArray(s.conversionChain) || s.conversionChain.some(x => !finite(x.factor) || x.factor <= 0)) errors.push(error('conversionChain', 'INVALID_CHAIN', '換算鏈的每個係數都必須大於 0'));
    if (s.grossMonthlySalaryCents !== undefined && (!finite(s.grossMonthlySalaryCents) || s.grossMonthlySalaryCents <= 0)) errors.push(error('grossMonthlySalaryCents', 'INVALID_MONEY', '月總工資必須大於 0'));
    if (s.monthlyWorkHours !== undefined && (!finite(s.monthlyWorkHours) || s.monthlyWorkHours <= 0)) errors.push(error('monthlyWorkHours', 'INVALID_HOURS', '月工時必須大於 0'));
    return { valid: errors.length === 0, errors, warnings: [] };
  };
  const validateRecurringFlows = (flows) => {
    const errors = [], ids = new Set();
    if (!Array.isArray(flows)) return { valid: false, errors: [error('recurringCashFlows', 'INVALID_RECURRING', '固定出入帳必須是陣列')], warnings: [] };
    flows.forEach((f, i) => {
      const p = `recurringCashFlows[${i}]`;
      if (!f || typeof f !== 'object') { errors.push(error(p, 'INVALID_FLOW', '固定項目必須是物件')); return; }
      if (typeof f.id !== 'string' || !f.id || ids.has(f.id)) errors.push(error(`${p}.id`, 'INVALID_ID', '固定項目 ID 不可空白或重複')); else ids.add(f.id);
      if (!['income', 'expense', 'saving'].includes(f.type)) errors.push(error(`${p}.type`, 'INVALID_TYPE', '固定項目只能是收入、支出或儲蓄'));
      if (!integer(f.amountCents) || f.amountCents < 0) errors.push(error(`${p}.amountCents`, 'INVALID_MONEY', '固定金額必須是非負整數分'));
      if (!integer(f.dayOfMonth) || f.dayOfMonth < 1 || f.dayOfMonth > 31) errors.push(error(`${p}.dayOfMonth`, 'INVALID_DAY', '固定日期須介於 1–31 日'));
      if (f.type === 'income') {
        const basis = f.payBasis === undefined ? 'monthly' : f.payBasis;
        const nonNeg = (v) => finite(v) && v >= 0;
        if (!['monthly', 'hourly', 'per_case'].includes(basis)) errors.push(error(`${p}.payBasis`, 'INVALID_PAY_BASIS', '計薪方式只能是月薪、時薪或按件'));
        // 時薪與按件的本月工時可以是 0（當月沒排班或沒接案）；月薪需要正工時才能換算時薪
        if (basis === 'monthly' ? (!finite(f.monthlyWorkHours) || f.monthlyWorkHours <= 0) : !nonNeg(f.monthlyWorkHours)) errors.push(error(`${p}.monthlyWorkHours`, 'INVALID_HOURS', '收入來源的月工時不正確'));
        if ((basis === 'hourly' || (basis === 'per_case' && f.caseFeeMode !== 'fixed')) && (!integer(f.hourlyRateCents) || f.hourlyRateCents < 0)) errors.push(error(`${p}.hourlyRateCents`, 'INVALID_RATE', '時薪必須是非負整數分'));
        if (basis === 'per_case') {
          if (!nonNeg(f.caseCount)) errors.push(error(`${p}.caseCount`, 'INVALID_CASE_COUNT', '案件數不可為負'));
          if (!finite(f.hoursPerCase) || f.hoursPerCase <= 0) errors.push(error(`${p}.hoursPerCase`, 'INVALID_HOURS', '每件時數必須大於 0'));
          if (f.caseFeeMode === 'fixed' && (!integer(f.caseFeeCents) || f.caseFeeCents < 0)) errors.push(error(`${p}.caseFeeCents`, 'INVALID_MONEY', '每件報酬必須是非負整數分'));
        }
      }
      if (f.housing !== undefined) {
        const h = f.housing, hp = `${p}.housing`;
        const optDate = (v) => v === undefined || v === '' || isValidDate(v);
        const nonNeg = (v) => v === undefined || (finite(v) && v >= 0);
        if (!h || typeof h !== 'object') errors.push(error(hp, 'INVALID_HOUSING', '租屋設定必須是物件'));
        else {
          if (![1, 2, 3, 6, 12].includes(h.payCycleMonths)) errors.push(error(`${hp}.payCycleMonths`, 'INVALID_CYCLE', '繳租週期只能是 1、2、3、6、12 個月'));
          if (!integer(h.rentCents) || h.rentCents < 0) errors.push(error(`${hp}.rentCents`, 'INVALID_MONEY', '月租必須是非負整數分'));
          if (!integer(h.occupants) || h.occupants < 1) errors.push(error(`${hp}.occupants`, 'INVALID_OCCUPANTS', '同住人數至少 1 人'));
          if (!optDate(h.contractStart) || !optDate(h.contractEnd)) errors.push(error(hp, 'INVALID_DATE', '租約日期格式不正確'));
          if (!Array.isArray(h.fees) || h.fees.some(x => !x || !integer(x.amountCents) || x.amountCents < 0)) errors.push(error(`${hp}.fees`, 'INVALID_MONEY', '租屋費用金額必須是非負整數分'));
          const e = h.electricity || {};
          if (![e.rateCentsPerKwh, e.lastReading, e.currentReading, e.fallbackMonthlyKwh].every(nonNeg) || !optDate(e.lastReadingDate) || !optDate(e.currentReadingDate)) errors.push(error(`${hp}.electricity`, 'INVALID_ELECTRICITY', '電費設定的度數、單價或日期不正確'));
          const s = h.subsidy;
          const optMonth = (v) => v === undefined || v === '' || isValidMonth(v);
          if (s !== undefined && (!s || typeof s !== 'object' || (s.amountCents !== undefined && (!integer(s.amountCents) || s.amountCents < 0)) || !optMonth(s.startMonth) || !optMonth(s.endMonth) || (s.startMonth && s.endMonth && s.endMonth < s.startMonth))) errors.push(error(`${hp}.subsidy`, 'INVALID_SUBSIDY', '租屋補助的金額或核定期間不正確'));
        }
      }
      if (f.payCycleMonths !== undefined && ![1, 2, 3, 6, 12].includes(f.payCycleMonths)) errors.push(error(`${p}.payCycleMonths`, 'INVALID_CYCLE', '繳款週期只能是 1、2、3、6、12 個月'));
      else if (f.payCycleMonths > 1 && !isValidMonth(f.payStartMonth)) errors.push(error(`${p}.payStartMonth`, 'INVALID_DATE', '非每月繳的固定支出必須指定首次繳款月份'));
      if (typeof f.accountId !== 'string' || !f.accountId) errors.push(error(`${p}.accountId`, 'MISSING_ACCOUNT', '固定項目必須指定帳戶'));
      if (f.type === 'saving' && (typeof f.fromAccountId !== 'string' || !f.fromAccountId || f.fromAccountId === f.accountId)) errors.push(error(p, 'INVALID_SAVING_TRANSFER', '固定儲蓄必須指定兩個不同帳戶'));
    });
    return { valid: errors.length === 0, errors, warnings: [] };
  };

  const validateWorkspace = (data, { scenarioContentChecks = true } = {}) => {
    const errors = [];
    if (!data || typeof data !== "object" || !data.config || !data.ledger || !Array.isArray(data.scenarios)) return { valid: false, errors: [error("", "INVALID_WORKSPACE", "工作區缺少設定、帳本或情境")], warnings: [] };
    errors.push(...validateQuickPlan(data.config.quickPlan || {}).errors);
    errors.push(...validateLedger(data.ledger).errors);
    errors.push(...validateScenarios({ scenarios: data.scenarios }, { contentChecks: scenarioContentChecks }).errors);
    const profiles = Array.isArray(data.config.accountProfiles) ? data.config.accountProfiles : [];
    const accountIds = new Set();
    const accountKeys = new Set();
    profiles.forEach((account, index) => { if (!account || typeof account.id !== "string" || !account.id || accountIds.has(account.id)) errors.push(error(`config.accountProfiles[${index}].id`, "INVALID_ACCOUNT", "帳戶 ID 不可空白或重複")); else { accountIds.add(account.id); accountKeys.add(account.id); if (typeof account.name === "string" && account.name) accountKeys.add(account.name); } });
    data.ledger.entries.forEach((entry, index) => { ["account", "fromAccount", "toAccount"].forEach((key) => { if (entry[key] !== undefined && entry[key] !== null && !accountKeys.has(entry[key])) errors.push(error(`ledger.entries[${index}].${key}`, "MISSING_ACCOUNT", "帳本指定的帳戶不存在")); }); });
    const dashboard = data.config.dashboard || {};
    ALLOCATION_PURPOSES.map(p => p.field).forEach((key) => { if (dashboard[key] !== undefined && dashboard[key] !== null && !accountIds.has(dashboard[key])) errors.push(error(`config.dashboard.${key}`, "MISSING_ACCOUNT", "首頁指定帳戶不存在")); });
    const flows = data.config.recurringCashFlows || [];
    errors.push(...validateRecurringFlows(flows).errors);
    flows.forEach((flow, index) => { ["accountId", "fromAccountId"].forEach((key) => { if (flow[key] !== undefined && !accountKeys.has(flow[key])) errors.push(error(`config.recurringCashFlows[${index}].${key}`, "MISSING_ACCOUNT", "固定項目指定的帳戶不存在")); }); });
    const managedIds = new Map([
      ['system-student-loan-repayment', { systemManaged: 'student_loan', source: 'scenario:student_loan' }],
      ['system-mortgage-repayment', { systemManaged: 'mortgage', source: 'scenario:mortgage' }]
    ]);
    const managedSources = new Set();
    flows.forEach((flow, index) => {
      const expected = managedIds.get(flow?.id) || [...managedIds.values()].find(item => item.source === flow?.source || item.systemManaged === flow?.systemManaged);
      if (!expected) return;
      if (flow.systemManaged && flow.systemManaged !== expected.systemManaged) errors.push(error('config.recurringCashFlows[' + index + '].systemManaged', 'INVALID_SOURCE', '自動固定支出的來源類型不一致'));
      if (flow.source && flow.source !== expected.source) errors.push(error('config.recurringCashFlows[' + index + '].source', 'INVALID_SOURCE', '自動固定支出的來源不一致'));
      if (managedSources.has(expected.source)) errors.push(error('config.recurringCashFlows[' + index + '].source', 'DUPLICATE_SOURCE', '同一情境不可產生多筆自動固定支出'));
      managedSources.add(expected.source);
    });
    if (data.wageReverseScenario !== undefined) errors.push(...validateWage(data.wageReverseScenario).errors);
    const scenarioIds = new Set(data.scenarios.map(s => s?.scenarioId).filter(Boolean));
    Object.keys(dashboard.scenarioSelections || {}).forEach((id) => { if (!scenarioIds.has(id)) errors.push(error('config.dashboard.scenarioSelections.' + id, 'MISSING_SCENARIO', '首頁選取的情境不存在')); });
    Object.keys(dashboard.scenarioTargetMonths || {}).forEach((id) => { if (!scenarioIds.has(id) || !isValidMonth(dashboard.scenarioTargetMonths[id])) errors.push(error('config.dashboard.scenarioTargetMonths.' + id, 'INVALID_TARGET_MONTH', '首頁情境目標月份無效或情境不存在')); });
    return { valid: errors.length === 0, errors, warnings: [] };
  };

  // 載入前修復「可安全自動修正」的欄位，避免單一欄位讓整份工作區被拒絕：
  // 首頁情境設定指向已不存在的情境或空白月份 → 移除該筆（畫面會回退到健檢目標月份）；
  // 首頁指定帳戶已不存在 → 改回第一個帳戶；
  // 快速健檢的不合法欄位 → 換回預設值。會直接修改 data，回傳修正筆數。
  const repairWorkspace = (data, defaults) => {
    let repaired = 0;
    if (!data || typeof data !== 'object' || !data.config || !Array.isArray(data.scenarios)) return repaired;
    const scenarioIds = new Set(data.scenarios.map(s => s?.scenarioId).filter(Boolean));
    const dashboard = data.config.dashboard || {};
    for (const key of ['scenarioSelections', 'scenarioAccountMap', 'scenarioTargetMonths']) {
      const map = dashboard[key];
      if (!map || typeof map !== 'object') continue;
      Object.keys(map).forEach((id) => {
        if (scenarioIds.has(id) && (key !== 'scenarioTargetMonths' || isValidMonth(map[id]))) return;
        delete map[id]; repaired++;
      });
    }
    // 首頁指定帳戶被刪除時改回第一個帳戶（與 app.js 的 ensureDashboard 相同規則）
    const accountIds = (data.config.accountProfiles || []).map(a => a?.id).filter(Boolean);
    for (const key of ALLOCATION_PURPOSES.map(p => p.field)) {
      if (dashboard[key] === undefined || dashboard[key] === null || accountIds.includes(dashboard[key])) continue;
      dashboard[key] = accountIds[0] ?? null; repaired++;
    }
    const repairFields = (target, fallback, errors) => errors.forEach(({ path }) => {
      if (!target || !fallback || !Object.prototype.hasOwnProperty.call(fallback, path)) return;
      target[path] = structuredClone(fallback[path]); repaired++;
    });
    if (data.config.quickPlan) repairFields(data.config.quickPlan, defaults?.quickPlan, validateQuickPlan(data.config.quickPlan).errors);
    return repaired;
  };

  const validateImported = (data, kind) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { valid: false, errors: [error('', 'INVALID_ROOT', 'JSON 根節點必須是物件')], warnings: [] };
    if (!integer(data.schemaVersion)) return { valid: false, errors: [error('schemaVersion', 'MISSING_VERSION', '資料缺少整數 schemaVersion')], warnings: [] };
    if (kind === 'ledger') return validateLedger(data);
    return { valid: true, errors: [], warnings: [] };
  };

  return { finite, isValidDate, isValidMonth, normalizeScenario, validateQuickPlan, validateLedger, validateScenario, validateScenarios, validateWage, validateRecurringFlows, validateWorkspace, repairWorkspace, validateImported };
})();