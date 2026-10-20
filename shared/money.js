// money.js — 金額換算與計算引擎（帳本 + 成本試算 + 工時反推 共用）
// 設計原則：一律用整數「分」計算，避免浮點數誤差累積。
// v8 更新：匯率不再查共用設定表，改用每筆紀錄自帶的 currency + rateToTWD 手動換算。

const CURRENCY_UNITS = { TWD: '元', EUR: '€', JPY: '¥', USD: '$' };

const Money = (() => {
  const toCents = (yuan) => Math.round(Number(yuan) * 100);
  const toYuan = (cents) => cents / 100;
  // 推算出的台幣金額一律四捨五入到整數元（勞健保費、時薪、電費等），避免出現角、分
  const roundYuan = (cents) => Math.round(Math.round(cents) / 100) * 100;

  // 幣別感知格式化：TWD 顯示「元」、EUR 顯示「€」...未知幣別直接顯示代碼，避免裸數字看不出單位
  const formatMoney = (cents, currency = 'TWD') => {
    const yuan = toYuan(cents);
    const sign = yuan < 0 ? '-' : '';
    // 台幣顯示到整數元；外幣保留兩位小數（使用者輸入的原始金額，四捨五入會失真）
    const num = Math.abs(yuan).toLocaleString('zh-Hant-TW', { maximumFractionDigits: currency === 'TWD' ? 0 : 2 });
    const unit = CURRENCY_UNITS[currency] || currency;
    return currency === 'EUR' || currency === 'USD' ? `${sign}${unit}${num}` : `${sign}${num}${unit}`;
  };
  // 向下相容別名（原本呼叫 formatTWD 的地方仍可用，等同 formatMoney(cents,'TWD')）
  const formatTWD = (cents) => formatMoney(cents, 'TWD');

  // 換算成台幣分：非台幣一律用該筆紀錄自己帶的 rateToTWD 換算，缺少匯率就丟出明確錯誤，不靜默出 NaN
  const toTWDCents = (amountCents, currency, rateToTWD) => {
    if (!Number.isFinite(amountCents)) throw new Error('金額必須是有限數字');
    if (!currency || currency === 'TWD') return amountCents;
    if (!Number.isFinite(rateToTWD) || rateToTWD <= 0) {
      throw new Error(`幣別 ${currency} 缺少匯率，請先輸入這筆的「當下匯率」`);
    }
    return Math.round(amountCents * rateToTWD);
  };

  // 依 key 分組加總（key 可以是分類、帳戶、年月...），加總前一律先換算成台幣，避免混幣別直接相加
  const groupSum = (entries, keyFn, filterFn = () => true) => {
    const out = {};
    for (const e of entries) {
      if (!filterFn(e)) continue;
      const k = keyFn(e);
      if (k === null || k === undefined) continue;
      let twd;
      try {
        twd = toTWDCents(e.amountCents, e.currency, e.rateToTWD);
      } catch (err) {
        twd = 0; // 缺匯率的紀錄先跳過加總，畫面上另外會提示
      }
      out[k] = (out[k] || 0) + twd;
    }
    return out;
  };
  const calcExpenseAverages = (entries) => {
    const expenses = (entries || []).filter(e => e.type === 'expense' && e.status !== 'projected' && /^\d{4}-\d{2}/.test(e.date || ''));
    if (!expenses.length) return { monthCount: 0, totalCents: 0, rows: [] };
    const months = expenses.map(e => e.date.slice(0, 7)).sort();
    const [sy, sm] = months[0].split('-').map(Number), [ey, em] = months.at(-1).split('-').map(Number);
    const monthCount = (ey - sy) * 12 + em - sm + 1;
    const totals = {};
    for (const e of expenses) {
      const amount = Math.abs(toTWDCents(e.amountCents, e.currency, e.rateToTWD));
      const key = e.category || '未分類';
      totals[key] = (totals[key] || 0) + amount;
    }
    const totalCents = Object.values(totals).reduce((s, v) => s + v, 0);
    const rows = Object.entries(totals).map(([label, total]) => ({ label, totalCents: total, monthlyAverageCents: Math.round(total / monthCount), share: totalCents > 0 ? total / totalCents : 0 })).sort((a, b) => b.totalCents - a.totalCents);
    return { monthCount, totalCents, rows };
  };

  const sumItems = (items) => {
    const costs = items.reduce((s, i) => s + (i.kind === "discount" ? 0 : Math.abs(i.amountCents)), 0);
    const discounts = items.reduce((s, i) => s + (i.kind === "discount" ? Math.abs(i.amountCents) : 0), 0);
    return Math.max(0, costs - discounts);
  };

  // 反推驗證後的通膨公式：inflated = total * multiplier（單次直接相乘，非複利、不需要年數）
  // 驗證依據：買房 20,001,143 × 1.58 = 31,601,806（原表數字一致）
  //           買地自建 12,940,676 × 1.58 = 20,446,268（原表數字一致）
  //           旅費 55,300 × 1.3 = 71,890（原表數字一致）
  const applyInflation = (totalCents, multiplier) => Math.round(totalCents * multiplier);

  // 勞健保正推／反推：互為反函式，費率由使用者自填（不內建會過期的官方分級表）
  const grossToNet = (grossMonthlyCents, insuredSalaryCents, rates) => {
    const laborFee = roundYuan(insuredSalaryCents * rates.laborInsuranceRate * rates.laborInsurancePersonalShare);
    const healthFee = roundYuan(insuredSalaryCents * rates.healthInsuranceRate * rates.healthInsurancePersonalShare);
    return { laborFee, healthFee, net: grossMonthlyCents - laborFee - healthFee };
  };
  const netToGross = (targetNetCents, insuredSalaryCents, rates) => {
    const laborFee = roundYuan(insuredSalaryCents * rates.laborInsuranceRate * rates.laborInsurancePersonalShare);
    const healthFee = roundYuan(insuredSalaryCents * rates.healthInsuranceRate * rates.healthInsurancePersonalShare);
    return { laborFee, healthFee, gross: targetNetCents + laborFee + healthFee };
  };
  const calcPayroll = (grossMonthlyCents, monthlyWorkHours, insuredSalaryCents, rates) => {
    if (!Number.isFinite(grossMonthlyCents) || grossMonthlyCents <= 0) throw new RangeError('月總工資必須大於 0');
    if (!Number.isFinite(monthlyWorkHours) || monthlyWorkHours <= 0) throw new RangeError('月工時必須大於 0');
    const insured = Number.isFinite(insuredSalaryCents) && insuredSalaryCents >= 0 ? insuredSalaryCents : grossMonthlyCents;
    const payroll = grossToNet(grossMonthlyCents, insured, rates);
    return { ...payroll, gross: grossMonthlyCents, insuredSalaryCents: insured, hourlyRateCents: roundYuan(grossMonthlyCents / monthlyWorkHours) };
  };
  // 收入計薪方式：固定的是月薪或時薪與投保級距，每月變動的是工時或案件數
  //   monthly：月薪固定，時薪 = 月薪 ÷ 月工時
  //   hourly：月總收入 = 時薪 × 本月工時
  //   per_case：月總收入 = 案件數 × 每件報酬；每件報酬 = 案件時薪 × 每件時數，或固定每件價
  const INCOME_PAY_BASES = ['monthly', 'hourly', 'per_case'];
  const deriveIncome = (flow) => {
    const pos = (v) => (Number(v) > 0 ? Number(v) : 0);
    const payBasis = INCOME_PAY_BASES.includes(flow?.payBasis) ? flow.payBasis : 'monthly';
    if (payBasis === 'hourly') {
      const hourlyRateCents = Math.round(pos(flow.hourlyRateCents));
      const monthlyWorkHours = pos(flow.monthlyWorkHours);
      return { payBasis, grossCents: roundYuan(hourlyRateCents * monthlyWorkHours), monthlyWorkHours, hourlyRateCents };
    }
    if (payBasis === 'per_case') {
      const caseCount = pos(flow.caseCount);
      const hoursPerCase = pos(flow.hoursPerCase);
      const caseFeeCents = flow.caseFeeMode === 'fixed' ? Math.round(pos(flow.caseFeeCents)) : roundYuan(pos(flow.hourlyRateCents) * hoursPerCase);
      return {
        payBasis, caseCount, hoursPerCase, caseFeeCents,
        grossCents: Math.round(caseCount * caseFeeCents),
        monthlyWorkHours: caseCount * hoursPerCase,
        hourlyRateCents: hoursPerCase > 0 ? roundYuan(caseFeeCents / hoursPerCase) : 0
      };
    }
    const grossCents = Math.abs(Number(flow?.amountCents) || 0);
    const monthlyWorkHours = pos(flow?.monthlyWorkHours) || 160;
    return { payBasis, grossCents, monthlyWorkHours, hourlyRateCents: roundYuan(grossCents / monthlyWorkHours) };
  };
  // 投保薪資是固定級距；只有勾選「跟著實際收入」才隨月總收入變動
  const insuredSalaryOf = (flow, grossCents) => (flow.insuredSalaryFollowsGross !== false ? grossCents : (Number(flow.insuredSalaryCents) || grossCents));
  const calcRecurringMonthly = (flows, rates) => {
    const items = (Array.isArray(flows) ? flows : []).filter(f => f.active !== false).map((f) => {
      if (f.type === 'income') {
        const income = deriveIncome(f);
        const amount = income.grossCents;
        const insured = insuredSalaryOf(f, amount);
        const fees = f.applyInsurance && amount > 0 ? grossToNet(amount, insured, rates) : { net: amount, laborFee: 0, healthFee: 0 };
        const payroll = { ...fees, gross: amount, hourlyRateCents: income.hourlyRateCents, insuredSalaryCents: insured };
        return { ...f, grossCents: amount, netCents: payroll.net, payroll, income };
      }
      const housingCalc = f.type === 'expense' && f.housing ? calcHousing(f.housing) : null;
      const amount = housingCalc ? housingCalc.monthlyCents : Math.abs(Number(f.amountCents) || 0);
      if (f.type === 'saving') return { ...f, grossCents: amount, netCents: 0, payroll: null };
      return { ...f, grossCents: amount, netCents: -amount, payroll: null, housingCalc };
    });
    const incomeCents = items.filter(f => f.type === 'income').reduce((s, f) => s + f.netCents, 0);
    const essentialExpenseCents = items.filter(f => f.type === 'expense' && f.essential !== false).reduce((s, f) => s + f.grossCents, 0);
    const otherExpenseCents = items.filter(f => f.type === 'expense' && f.essential === false).reduce((s, f) => s + f.grossCents, 0);
    const fixedSavingCents = items.filter(f => f.type === 'saving').reduce((s, f) => s + f.grossCents, 0);
    return { items, incomeCents, essentialExpenseCents, otherExpenseCents, fixedSavingCents, monthlySavingsCents: incomeCents - essentialExpenseCents - otherExpenseCents };
  };
  const wageSettingsFromIncome = (flow) => {
    if (!flow || flow.type !== 'income') throw new TypeError('必須選擇有效的固定收入來源');
    const income = deriveIncome(flow);
    // 工時反推需要正工時；本月工時為 0（如當月沒接案）時以每件時數或 160 小時代入，時薪仍以計薪方式為準
    const monthlyWorkHours = income.monthlyWorkHours > 0 ? income.monthlyWorkHours : (income.hoursPerCase || 160);
    const grossMonthlySalaryCents = income.grossCents > 0 ? income.grossCents : Math.round(income.hourlyRateCents * monthlyWorkHours);
    const insuredSalaryFollowsGross = flow.insuredSalaryFollowsGross !== false;
    return {
      grossMonthlySalaryCents, monthlyWorkHours, applyInsurance: !!flow.applyInsurance,
      insuredSalaryFollowsGross,
      insuredSalaryCents: insuredSalaryOf(flow, grossMonthlySalaryCents),
      baseRateCentsPerHour: income.hourlyRateCents || Math.round(grossMonthlySalaryCents / monthlyWorkHours)
    };
  };


  // 租屋：房租可每月／每兩月／每季／半年／一年繳，額外費用可按人數計，電費依電表度數推估
  const RENT_CYCLES = [1, 2, 3, 6, 12];
  const parseYmd = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? { y: +m[1], m: +m[2], d: +m[3] } : null; };
  const ymIndex = (y, m) => y * 12 + (m - 1);
  const dateInMonth = (index, day) => {
    const y = Math.floor(index / 12), m = index % 12 + 1;
    const d = Math.min(day, new Date(y, m, 0).getDate());
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
  const daysBetween = (a, b) => Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
  // 租屋補助：核定期間內每月撥款到自己帳戶（不從房租扣），金額由使用者依核定通知填寫，不內建會過期的官方級距
  const currentYm = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
  const housingSubsidyInMonth = (housing, ym) => {
    const s = housing?.subsidy;
    // enabled＝有領補助（資料保留）；includeInCalc＝是否扣入每月平均與記入帳本（舊資料未設定視為納入）
    if (!s?.enabled || s.includeInCalc === false || !/^\d{4}-\d{2}$/.test(ym || '')) return 0;
    if (s.startMonth && ym < s.startMonth) return 0;
    if (s.endMonth && ym > s.endMonth) return 0;
    return Math.max(0, Math.round(Number(s.amountCents) || 0));
  };
  const calcHousing = (housing, asOfYm = currentYm()) => {
    const h = housing || {};
    const cycle = RENT_CYCLES.includes(Number(h.payCycleMonths)) ? Number(h.payCycleMonths) : 1;
    const occupants = Number(h.occupants) >= 1 ? Math.trunc(Number(h.occupants)) : 1;
    const rentCents = Math.max(0, Math.round(Number(h.rentCents) || 0));
    const fees = (Array.isArray(h.fees) ? h.fees : []).map((f) => {
      const monthlyCents = Math.max(0, Math.round(Number(f.amountCents) || 0)) * (f.perPerson ? occupants : 1);
      return { ...f, monthlyCents };
    });
    const feesCents = fees.reduce((s, f) => s + f.monthlyCents, 0);
    const start = parseYmd(h.contractStart);
    // 繳租日：從簽約日每 cycle 個月一次（小月夾到月底），到期日當天起不再繳
    const paymentDateAt = (k) => dateInMonth(ymIndex(start.y, start.m) + k * cycle, start.d);
    const nextPaymentOnOrAfter = (ymd, strict = false) => {
      if (!start || !parseYmd(ymd)) return null;
      const from = parseYmd(ymd);
      let k = Math.max(0, Math.floor((ymIndex(from.y, from.m) - ymIndex(start.y, start.m)) / cycle) - 1);
      for (let guard = 0; guard < 1200; guard += 1, k += 1) {
        const date = paymentDateAt(k);
        if (h.contractEnd && date >= h.contractEnd) return null;
        if (strict ? date > ymd : date >= ymd) return date;
      }
      return null;
    };
    // 電費跟房租同一天繳：每個繳租日結清上次抄表到該日的用電
    const e = h.electricity || {};
    const rate = Math.max(0, Number(e.rateCentsPerKwh) || 0);
    const last = parseYmd(e.lastReadingDate), cur = parseYmd(e.currentReadingDate);
    const usedKwh = Number(e.currentReading) - Number(e.lastReading);
    const days = last && cur ? daysBetween(last, cur) : 0;
    const measured = days > 0 && usedKwh >= 0 && Number.isFinite(usedKwh);
    const dailyKwh = measured ? usedKwh / days : (Math.max(0, Number(e.fallbackMonthlyKwh) || 0) * 12) / 365;
    const monthlyKwh = dailyKwh * 365 / 12;
    // 上次抄表日當天若剛好是繳租日，那天已結清，下一次結算是之後的繳租日
    const nextSettleDate = last ? nextPaymentOnOrAfter(e.lastReadingDate, true) : null;
    const projectedKwh = last && nextSettleDate ? dailyKwh * daysBetween(last, parseYmd(nextSettleDate)) : monthlyKwh * cycle;
    const electricity = {
      enabled: !!e.enabled, measured, usedKwh: measured ? usedKwh : 0, days, dailyKwh, monthlyKwh,
      usedSoFarCents: measured ? roundYuan(usedKwh * rate) : 0,
      nextSettleDate, projectedKwh, projectedBillCents: e.enabled ? roundYuan(projectedKwh * rate) : 0,
      monthlyCents: e.enabled ? roundYuan(monthlyKwh * rate) : 0
    };
    const grossMonthlyCents = rentCents + feesCents + electricity.monthlyCents;
    const subsidyCents = housingSubsidyInMonth(h, asOfYm);
    // 每月平均看實際負擔：房租＋費用＋電費－本月有效的補助
    const monthlyCents = Math.max(0, grossMonthlyCents - subsidyCents);
    const perPaymentCents = (rentCents + feesCents) * cycle;
    // 某次繳租日的總額：房租＋費用 × 週期，加上這段期間的電費（下次結算用實測推估，之後用每月平均）
    const paymentOn = (date) => {
      const parts = [];
      if (rentCents > 0) parts.push({ label: cycle === 1 ? '房租' : `房租 ${cycle} 個月`, cents: rentCents * cycle });
      if (feesCents > 0) parts.push({ label: cycle === 1 ? '其他費用' : `其他費用 ${cycle} 個月`, cents: feesCents * cycle });
      if (electricity.enabled) {
        const cents = date === nextSettleDate ? electricity.projectedBillCents : electricity.monthlyCents * cycle;
        if (cents > 0) parts.push({ label: '電費（預估）', cents });
      }
      return { date, parts, cents: parts.reduce((s, p) => s + p.cents, 0) };
    };
    return { cycle, occupants, rentCents, fees, feesCents, electricity, grossMonthlyCents, subsidyCents, monthlyCents, perPaymentCents, paymentDateAt: start ? paymentDateAt : null, nextPaymentOnOrAfter, paymentOn };
  };
  // 某月實際要付的錢（現金流）：只有繳租月要付，房租、費用、電費同一天繳
  const housingDueInMonth = (housing, ym) => {
    const start = parseYmd(housing?.contractStart);
    const m = /^(\d{4})-(\d{2})$/.exec(ym || '');
    if (!start || !m) return { totalCents: 0, parts: [] };
    const r = calcHousing(housing);
    const diff = ymIndex(+m[1], +m[2]) - ymIndex(start.y, start.m);
    if (diff < 0 || diff % r.cycle !== 0) return { totalCents: 0, parts: [] };
    const date = r.paymentDateAt(diff / r.cycle);
    if (housing.contractEnd && date >= housing.contractEnd) return { totalCents: 0, parts: [] };
    const pay = r.paymentOn(date);
    return { totalCents: pay.cents, parts: pay.parts, date };
  };
  // 從 fromDate（YYYY-MM-DD）起列出接下來 count 次繳款的日期與總額
  const housingPaymentSchedule = (housing, fromDate, count = 6) => {
    const r = calcHousing(housing);
    const out = [];
    let date = r.nextPaymentOnOrAfter(fromDate);
    while (date && out.length < count) {
      out.push(r.paymentOn(date));
      date = r.nextPaymentOnOrAfter(date, true);
    }
    return out;
  };

  // 一般固定支出也跟房租一樣可選繳款週期：amountCents 是每月金額，從 payStartMonth 起每 cycle 個月付一次「每月金額 × 週期」
  const flowPayCycle = (flow) => (RENT_CYCLES.includes(Number(flow?.payCycleMonths)) ? Number(flow.payCycleMonths) : 1);
  const flowDueInMonth = (flow, ym) => {
    const monthlyCents = Math.abs(Math.round(Number(flow?.amountCents) || 0));
    const cycle = flowPayCycle(flow);
    if (cycle === 1) return monthlyCents;
    const s = /^(\d{4})-(\d{2})$/.exec(flow.payStartMonth || ''), m = /^(\d{4})-(\d{2})$/.exec(ym || '');
    if (!s || !m) return 0;
    const diff = ymIndex(+m[1], +m[2]) - ymIndex(+s[1], +s[2]);
    return diff >= 0 && diff % cycle === 0 ? monthlyCents * cycle : 0;
  };

  // 一次性情境（買房／買地自建／旅費／喪葬）
  const calcOneTimeScenario = (scenario, config) => {
    const total = sumItems(scenario.items);
    const multiplier = scenario.inflationKey ? (config.inflationMultipliers[scenario.inflationKey] ?? 1) : 1;
    const inflated = scenario.applyInflation ? applyInflation(total, multiplier) : total;
    const afterLoan = (scenario.loanAmountCents !== undefined && scenario.loanAmountCents !== null)
      ? total - scenario.loanAmountCents
      : null;
    const inflatedAfterLoan = (afterLoan !== null && scenario.applyInflation)
      ? applyInflation(afterLoan, multiplier)
      : afterLoan;
    const gap = (scenario.currentSavedCents !== undefined && scenario.currentSavedCents !== null)
      ? (scenario.applyInflation ? inflated : total) - scenario.currentSavedCents
      : null;

    const formulaText = scenario.applyInflation
      ? `通膨後總額 = 總額 × ${scenario.inflationKey}通膨倍數(${multiplier})\n` +
        `           = ${formatTWD(total)} × ${multiplier}\n` +
        `           = ${formatTWD(inflated)}`
      : `總額 = 各項目加總 = ${formatTWD(total)}（此情境未套用通膨）`;

    return { total, inflated, afterLoan, inflatedAfterLoan, gap, multiplier, formulaText };
  };

  // 養老金情境：總額 = 每月生活費 × 12 × (身故年齡－退休年齡)，可選套用通膨倍數
  const calcRetirementFundScenario = (scenario, config) => {
    const retirementYears = scenario.deathAge - scenario.retireAge;
    const baseTotal = scenario.monthlyLivingCostCents * 12 * retirementYears;
    const multiplier = scenario.inflationKey ? (config.inflationMultipliers[scenario.inflationKey] ?? 1) : 1;
    const inflated = scenario.applyInflation ? applyInflation(baseTotal, multiplier) : baseTotal;
    const gap = inflated - (scenario.currentSavedCents || 0);
    const formulaText =
      `退休後年數 = 身故年齡(${scenario.deathAge}) － 退休年齡(${scenario.retireAge}) = ${retirementYears} 年\n` +
      `養老所需總額 = 每月生活費 × 12 × 退休後年數\n` +
      `            = ${formatTWD(scenario.monthlyLivingCostCents)} × 12 × ${retirementYears}\n` +
      `            = ${formatTWD(baseTotal)}` +
      (scenario.applyInflation
        ? `\n通膨後總額 = ${formatTWD(baseTotal)} × ${multiplier} = ${formatTWD(inflated)}`
        : '') +
      `\n差額 = 通膨後總額 － 目前已存 = ${formatTWD(inflated)} － ${formatTWD(scenario.currentSavedCents || 0)} = ${formatTWD(gap)}`;
    return { retirementYears, baseTotal, inflated, gap, multiplier, formulaText };
  };

  // FIRE／財務獨立退休試算：逐步計算，每一步都已用原表數字驗證吻合
  // v8 更新：salaryType 切換稅前/稅後（透過勞健保函式換算一致）；retireAgeSolveMode 可切換成
  // 「已知薪資成長率，反推幾歲能退休」（同一組公式，解不同的未知數）
  const calcRetirementAssetTarget = (annualExpense, retirementYears, returnRate, inflationRate, fundingModel) => {
    const years = Math.max(0, retirementYears);
    const r = Number(returnRate) || 0;
    const g = Math.max(0, Number(inflationRate) || 0);
    if (years === 0) return 0;
    if (fundingModel === 'finite') {
      if (Math.abs(r) < 1e-12) return Math.round(g === 0 ? annualExpense * years : annualExpense * (Math.pow(1 + g, years) - 1) / g);
      if (Math.abs(r - g) < 1e-12) return Math.round(annualExpense * years / (1 + r));
      return Math.round(annualExpense * (1 - Math.pow((1 + g) / (1 + r), years)) / (r - g));
    }
    if (Math.abs(r) < 1e-12) return Math.round(annualExpense * years);
    if (r <= g) return Number.POSITIVE_INFINITY;
    return Math.round(annualExpense / (r - g));
  };

  const calcFireScenario = (scenario, config) => {
    const validation = Validation.validateScenario(scenario);
    if (!validation.valid) throw new RangeError(validation.errors.map(e => e.message).join('；'));
    const workingYearsLeft = scenario.retireAge - scenario.startAge;
    const retirementYears = scenario.deathAge - scenario.retireAge;
    const annualRetirementExpense = scenario.retirementMonthlyExpenseCents * 12;
    const retirementFundingModel = scenario.retirementFundingModel || 'perpetuity';
    const retirementRate = scenario.postRetirementAnnualReturnRate;
    const retirementInflationRate = scenario.retirementInflationAnnualRate ?? 0;
    const retirementAssetTarget = calcRetirementAssetTarget(annualRetirementExpense, retirementYears, retirementRate, retirementInflationRate, retirementFundingModel);
    const emergencyFundTotal = scenario.currentMonthlyExpenseCents * scenario.emergencyFundMonths;
    const totalNeededBeforeRetire = retirementAssetTarget + scenario.buyHouseGoalCents
      + scenario.studyAbroadFundCents + emergencyFundTotal;
    const totalFundingGap = totalNeededBeforeRetire - scenario.totalSavedCents;
    const totalExpenseBeforeRetire = scenario.currentMonthlyExpenseCents * 12 * workingYearsLeft;
    const totalIncomeNeeded = totalFundingGap + totalExpenseBeforeRetire;
    const requiredAvgMonthlySalaryNet = Math.max(0, Math.round(totalIncomeNeeded / (workingYearsLeft * 12)));
    // salaryType 一律在「淨額」這個共同基準上比較（因為支出是用淨收入支付的），
    // 只有要顯示「應有月薪」給人看、要對照薪資單時，才換算回使用者選擇的 salaryType
    const requiredAvgMonthlySalaryDisplay = scenario.salaryType === 'gross'
      ? netToGross(requiredAvgMonthlySalaryNet, scenario.insuredSalaryCents, config.insuranceRates).gross
      : requiredAvgMonthlySalaryNet;
    const currentSalaryNet = scenario.salaryType === 'gross'
      ? grossToNet(scenario.currentMonthlySalaryCents, scenario.insuredSalaryCents, config.insuranceRates).net
      : scenario.currentMonthlySalaryCents;
    // 防呆：投保薪資高於實際月薪時，換算出的淨薪可能是負數，此時「年成長率」在數學上無意義
    // （負數開非整數次方在實數範圍內無解），改回傳 null，畫面上顯示「無法計算」而不是 NaN%
    const impliedCAGR = totalFundingGap > 0 && currentSalaryNet > 0
      ? Math.pow(requiredAvgMonthlySalaryNet / currentSalaryNet, 1 / workingYearsLeft) - 1
      : null;
    const nextYearTargetSalary = Math.round(scenario.currentMonthlySalaryCents * (1 + scenario.assumedSalaryGrowthRate));

    // 月薪分配：一律以「勞健保扣除後淨薪」為基準分配，因為勞健保是先扣才發薪，
    // 稅前月薪你根本拿不到那筆錢，用稅前金額分配會高估實際可運用的錢。
    const allocationBaseNet = currentSalaryNet;
    const allocation = Object.entries(scenario.allocationPercents).map(([label, pct]) => ({
      label, pct, amountCents: Math.round(allocationBaseNet * pct)
    }));
    const allocationSumPct = Object.values(scenario.allocationPercents).reduce((s, p) => s + p, 0);

    let solvedRetireAge = null;
    if (scenario.retireAgeSolveMode === 'given_growth_rate') {
      solvedRetireAge = solveFireRetireAge(scenario, config);
    }

    const retirementFormulaText = (retirementFundingModel === 'finite'
      ? `退休資產目標 = 退休後支出的有限年期現值（${retirementYears} 年）\n`
      : `退休資產目標 = 退休後年支出 ÷（退休後報酬率－退休後通膨率）\n`) +
      `退休後通膨率 = ${(retirementInflationRate * 100).toFixed(2)}%\n`;
    const formulaText =
      retirementFormulaText +
      `            = ${formatTWD(retirementAssetTarget)}\n` +
      `退休前總需求資金 = 退休資產目標 + 買房目標 + 留學預備金 + 緊急儲備金總額\n` +
      `              = ${formatTWD(totalNeededBeforeRetire)}\n` +
      `尚欠總資金缺口 = 退休前總需求資金 － 目前已存 = ${formatTWD(totalFundingGap)}\n` +
      `往後總收入需求 = 尚欠總資金缺口 + 退休前總支出預估 = ${formatTWD(totalIncomeNeeded)}\n` +
      (totalFundingGap <= 0 ? `目前資產已足夠，無需額外月薪` : `往後應有平均月薪(淨) = 往後總收入需求 ÷ (剩餘工作年數 × 12) = ${formatTWD(requiredAvgMonthlySalaryNet)}`) +
      (scenario.salaryType === 'gross'
        ? `往後應有平均月薪(稅前，含勞健保換算) = ${formatTWD(requiredAvgMonthlySalaryDisplay)}\n`
        : '') +
      (impliedCAGR !== null
        ? `理論所需年成長率 ≈ ${(impliedCAGR * 100).toFixed(2)}%（供對照，實際採用你設定的 ${(scenario.assumedSalaryGrowthRate * 100).toFixed(0)}%）\n`
        : `理論所需年成長率：無法計算（目前月薪換算成稅後淨薪後為負數，代表你填的「投保薪資」比實際月薪高很多，請檢查這兩個欄位是否合理）\n`) +
      `月薪分配基準 = 勞健保扣除後淨薪 = ${formatTWD(allocationBaseNet)}（分配是以「實際到手的錢」計算，不是稅前月薪，因為勞健保先扣才發薪，稅前金額你根本拿不到）` +
      (Math.abs(allocationSumPct - 1) > 0.001 ? `\n目前分配比例加總為 ${(allocationSumPct * 100).toFixed(1)}%，不等於 100%，請調整` : '');

    return {
      workingYearsLeft, retirementYears, retirementAssetTarget, emergencyFundTotal,
      totalNeededBeforeRetire, totalFundingGap, totalExpenseBeforeRetire,
      requiredAvgMonthlySalary: requiredAvgMonthlySalaryDisplay, requiredAvgMonthlySalaryNet,
      impliedCAGR, nextYearTargetSalary, allocation, allocationBaseNet, allocationSumPct,
      solvedRetireAge, formulaText
    };
  };

  // 反推「幾歲能退休」：以月度現金流累積，薪資先轉為淨薪、扣除生活費後投入，
  // 並要求資產同時覆蓋退休資產、買房、留學與緊急預備金，避免和主試算口徑不一致。
  const solveFireRetireAge = (scenario, config) => {
    let accumulated = scenario.totalSavedCents;
    let grossOrNetSalary = scenario.currentMonthlySalaryCents;
    const monthlySalaryGrowth = Math.pow(1 + scenario.assumedSalaryGrowthRate, 1 / 12) - 1;
    const monthlyInvestmentReturn = Math.pow(1 + (scenario.preRetirementAnnualReturnRate || 0), 1 / 12) - 1;
    for (let month = 1; month <= (scenario.deathAge - scenario.startAge) * 12; month++) {
      grossOrNetSalary *= (1 + monthlySalaryGrowth);
      const salaryNet = scenario.salaryType === 'gross'
        ? grossToNet(Math.round(grossOrNetSalary), scenario.insuredSalaryCents, config.insuranceRates).net
        : Math.round(grossOrNetSalary);
      const surplus = salaryNet - scenario.currentMonthlyExpenseCents;
      accumulated = Math.round(accumulated * (1 + monthlyInvestmentReturn)) + surplus;
      const age = scenario.startAge + month / 12;
      const retireAge = Math.ceil(age);
      const annualRetirementExpense = scenario.retirementMonthlyExpenseCents * 12;
      const retirementYears = Math.max(0, scenario.deathAge - retireAge);
      const retirementRate = scenario.postRetirementAnnualReturnRate;
      const retirementInflationRate = scenario.retirementInflationAnnualRate ?? 0;
      const retirementTarget = calcRetirementAssetTarget(annualRetirementExpense, retirementYears, retirementRate, retirementInflationRate, scenario.retirementFundingModel || 'perpetuity');
      const emergency = scenario.currentMonthlyExpenseCents * scenario.emergencyFundMonths;
      const fullTarget = retirementTarget + scenario.buyHouseGoalCents + scenario.studyAbroadFundCents + emergency;
      if (accumulated >= fullTarget) return Math.ceil(age * 10) / 10;
    }
    return null; // 70 歲前都達不到
  };


  // 期別型情境（學貸）：itemTemplate 逐期套用，periods 內的 overrides 覆寫個別項目
  // v8 更新：期別可標記 isLeaveOfAbsence（休學），該期金額自動算 0 但仍保留在時間軸上顯示
  const calcPeriodScenario = (scenario) => {
    const periods = scenario.periods.map((p) => {
      if (p.isLeaveOfAbsence) {
        return { label: p.label, items: [], total: 0, isLeaveOfAbsence: true };
      }
      const items = scenario.itemTemplate.map((tpl) => {
        const override = p.overrides && Object.prototype.hasOwnProperty.call(p.overrides, tpl.label)
          ? p.overrides[tpl.label]
          : null;
        return { label: tpl.label, kind: tpl.kind || "cost", amountCents: Math.max(0, override !== null ? override : tpl.amountCents) };
      });
      const periodTotal = sumItems(items);
      return { label: p.label, items, total: periodTotal };
    });
    const grandTotal = periods.reduce((s, p) => s + p.total, 0);
    return { periods, grandTotal };
  };

  const calcStudentLoanRepayment = (principalCents, borrowedSemesters, repayment, currentAge) => {
    const principal = Math.max(0, Math.round(Number(principalCents) || 0));
    const semesters = Math.max(1, Math.trunc(Number(borrowedSemesters) || 1));
    const multiplier = repayment.termPlan === 'low_income' ? 2 : (repayment.termPlan === 'extended' ? 1.5 : 1);
    const termMonths = Math.max(12, Math.round(semesters * 12 * multiplier));
    const annualRate = Math.max(0, Number(repayment.annualRate) || 0);
    const monthlyRate = annualRate / 12;
    const monthlyPaymentCents = principal === 0 ? 0 : Math.ceil(monthlyRate === 0
      ? principal / termMonths
      : principal * monthlyRate / (1 - Math.pow(1 + monthlyRate, -termMonths)));
    const totalRepaymentCents = monthlyPaymentCents * termMonths;
    const repaymentStartAge = Number(repayment.graduationAge) + Number(repayment.graceYears);
    const repaymentEndAge = repaymentStartAge + termMonths / 12;
    const age = Number(currentAge);
    const status = age < repaymentStartAge ? 'waiting' : (age >= repaymentEndAge ? 'completed' : 'repaying');
    return { principalCents: principal, borrowedSemesters: semesters, termMonths, termYears: termMonths / 12, annualRate, monthlyPaymentCents, totalRepaymentCents, totalInterestCents: Math.max(0, totalRepaymentCents - principal), repaymentStartAge, repaymentEndAge, status };
  };

  const calcMortgageRepayment = (principalCents, mortgage, currentAge) => {
    const principal = Math.max(0, Math.round(Number(principalCents) || 0));
    const annualRate = Math.max(0, Number(mortgage.annualRate) || 0);
    const monthlyRate = annualRate / 12;
    const termMonths = Math.max(12, Math.round(Math.max(1, Number(mortgage.termYears) || 1) * 12));
    const graceMonths = Math.min(termMonths - 1, Math.max(0, Math.round(Math.max(0, Number(mortgage.graceYears) || 0) * 12)));
    const amortizingMonths = termMonths - graceMonths;
    const interestOnlyPaymentCents = principal === 0 ? 0 : Math.ceil(principal * monthlyRate);
    const monthlyPaymentCents = principal === 0 ? 0 : Math.ceil(monthlyRate === 0 ? principal / amortizingMonths : principal * monthlyRate / (1 - Math.pow(1 + monthlyRate, -amortizingMonths)));
    const totalRepaymentCents = interestOnlyPaymentCents * graceMonths + monthlyPaymentCents * amortizingMonths;
    const repaymentStartAge = Number(mortgage.purchaseAge);
    const graceEndAge = repaymentStartAge + graceMonths / 12;
    const repaymentEndAge = repaymentStartAge + termMonths / 12;
    const age = Number(currentAge);
    const status = age < repaymentStartAge ? 'waiting' : (age < graceEndAge ? 'grace' : (age < repaymentEndAge ? 'repaying' : 'completed'));
    const currentPaymentCents = (status === 'grace' || (status === 'waiting' && graceMonths > 0)) ? interestOnlyPaymentCents : monthlyPaymentCents;
    return { principalCents: principal, annualRate, termMonths, termYears: termMonths / 12, graceMonths, graceYears: graceMonths / 12, amortizingMonths, interestOnlyPaymentCents, monthlyPaymentCents, currentPaymentCents, totalRepaymentCents, totalInterestCents: Math.max(0, totalRepaymentCents - principal), repaymentStartAge, graceEndAge, repaymentEndAge, status };
  };

  // 工時反推計算機：全站唯一實作，成本試算頁面的「自動提示」也是呼叫這個函式，不另外寫簡化公式。
  // 精度規則（已用「期望收益910,626」「學貸還款155,893」兩組真實數字重新驗證修正）：
  // 每一層要用「上一層無條件進位後的整數」往下除，是無條件進位（ceiling），不是四捨五入——
  // 例如 867.4 要進位成 868、542.125 要進位成 543，用 Math.round 會算錯，必須用 Math.ceil。
  const calcWageReverseChain = (targetAmountCents, chain) => {
    const steps = [];
    let current = targetAmountCents;
    for (const step of chain) {
      const raw = current / step.factor;
      const rounded = Math.ceil(raw);
      steps.push({ label: step.toLabel, raw, rounded });
      current = rounded; // 進位給下一層用「無條件進位後」的值，不是 raw
    }
    return steps;
  };

  const calcWageReverse = (scenario, config) => {
    const targetTWD = toTWDCents(scenario.targetAmountCents, scenario.currency, scenario.rateToTWD);
    const effectiveTarget = scenario.applyInsurance
      ? netToGross(targetTWD, scenario.insuredSalaryCents, config.insuranceRates).gross
      : targetTWD;
    const baseUnits = Math.ceil(effectiveTarget / scenario.baseRateCentsPerHour);
    const chain = calcWageReverseChain(baseUnits, scenario.conversionChain);
    const altChain = scenario.altChain ? calcWageReverseChain(baseUnits, scenario.altChain) : null;
    return { targetTWD, effectiveTarget, baseUnits, chain, altChain };
  };

  // 工時反推＋存款版雙提示（成本試算/願望清單各項目下方的「自動提示」都呼叫這個，唯讀顯示、不寫回資料）
  const calcAchievabilityHint = (amountCents, currency, rateToTWD, wageScenario, config) => {
    const twd = toTWDCents(amountCents, currency, rateToTWD);
    const wage = calcWageReverse({ ...wageScenario, targetAmountCents: twd, currency: 'TWD', rateToTWD: 1 }, config);
    const monthsViaSaving = config.personalBaseline.monthlySavingsCapacityCents > 0
      ? Math.ceil(Math.max(0, twd) / config.personalBaseline.monthlySavingsCapacityCents)
      : null;
    const ageAtCompletion = monthsViaSaving !== null
      ? Math.round((config.personalBaseline.currentAge + monthsViaSaving / 12) * 10) / 10
      : null;
    return { twd, hoursNeeded: wage.baseUnits, monthsViaSaving, ageAtCompletion };
  };


  const getScenarioType = (scenario) => scenario?.calcType || (Array.isArray(scenario?.periods) ? 'periods' : 'items');

  const toScenarioSummary = (scenario, result) => {
    const type = getScenarioType(scenario);
    if (type === 'periods') {
      const totalCents = Math.max(0, result.grandTotal || 0);
      return { type, totalCents, targetCents: totalCents, rawGapCents: totalCents, gapCents: totalCents, surplusCents: 0, status: totalCents > 0 ? 'planned' : 'empty', detail: result };
    }
    if (type === 'retirement_fund') {
      const totalCents = Math.max(0, result.inflated || 0);
      const gapCents = Math.max(0, result.gap || 0);
      return { type, totalCents, targetCents: gapCents, rawGapCents: result.gap || 0, gapCents, surplusCents: Math.max(0, -(result.gap || 0)), status: gapCents > 0 ? 'gap' : 'funded', detail: result };
    }
    if (type === 'fire') {
      const totalCents = Math.max(0, result.totalNeededBeforeRetire || 0);
      const gapCents = Math.max(0, result.totalFundingGap || 0);
      return { type, totalCents, targetCents: gapCents, rawGapCents: result.totalFundingGap || 0, gapCents, surplusCents: Math.max(0, -(result.totalFundingGap || 0)), status: gapCents > 0 ? 'gap' : 'funded', detail: result };
    }
    const totalCents = Math.max(0, scenario.applyInflation ? (result.inflated || 0) : (result.total || 0));
    const rawGapCents = result.gap ?? result.inflatedAfterLoan ?? result.afterLoan ?? totalCents;
    const targetCents = Math.max(0, result.gap ?? result.inflatedAfterLoan ?? result.afterLoan ?? totalCents);
    return { type, totalCents, targetCents, rawGapCents, gapCents: Math.max(0, rawGapCents), surplusCents: Math.max(0, -rawGapCents), status: targetCents > 0 ? 'planned' : (totalCents > 0 ? 'funded' : 'empty'), detail: result };
  };

  const calcScenario = (scenario, config) => {
    const type = getScenarioType(scenario);
    if (type === 'periods') return calcPeriodScenario(scenario);
    if (type === 'retirement_fund') return calcRetirementFundScenario(scenario, config);
    if (type === 'fire') return calcFireScenario(scenario, config);
    if (type !== 'items') throw new RangeError(`不支援的試算類型：${type}`);
    return calcOneTimeScenario(scenario, config);
  };

  // 純 SVG 趨勢圖：月度支出長條 + 薪資折線，無任何第三方套件依賴
  // 輸出會被 innerHTML 插入，月份字串來自帳本日期，仍一律跳脫
  const escapeXml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const buildTrendChartSVG = (monthlyExpenseTWD, monthlySalaryTWD) => {
    const months = [...new Set([...Object.keys(monthlyExpenseTWD), ...Object.keys(monthlySalaryTWD)])].sort();
    if (months.length === 0) return '<svg viewBox="0 0 400 160"></svg>';
    const w = 400, h = 160, padding = 24;
    const values = months.flatMap((m) => [Math.abs(monthlyExpenseTWD[m] || 0), monthlySalaryTWD[m] || 0]);
    const maxV = Math.max(...values, 1);
    const barW = (w - padding * 2) / months.length * 0.6;
    const scaleY = (v) => h - padding - (Math.abs(v) / maxV) * (h - padding * 2);
    const stepX = (w - padding * 2) / Math.max(months.length - 1, 1);

    const bars = months.map((m, i) => {
      const x = padding + i * stepX - barW / 2;
      const val = Math.abs(monthlyExpenseTWD[m] || 0);
      const y = scaleY(val);
      return `<rect x="${x}" y="${y}" width="${barW}" height="${h - padding - y}" fill="var(--negative)" opacity="0.6"><title>${escapeXml(m)} 支出 ${formatTWD(val)}</title></rect>`;
    }).join('');

    const points = months.map((m, i) => {
      const x = padding + i * stepX;
      const y = scaleY(monthlySalaryTWD[m] || 0);
      return `${x},${y}`;
    }).join(' ');

    const labels = months.map((m, i) => {
      const x = padding + i * stepX;
      return `<text x="${x}" y="${h - 4}" font-size="9" text-anchor="middle" fill="var(--ink-soft)">${escapeXml(m.slice(5))}</text>`;
    }).join('');

    return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto">
      ${bars}
      <polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="2"/>
      ${labels}
    </svg>`;
  };

  return {
    toCents, toYuan, formatMoney, formatTWD, toTWDCents, groupSum, calcExpenseAverages, sumItems, applyInflation,
    getScenarioType, toScenarioSummary, grossToNet, netToGross, calcPayroll, INCOME_PAY_BASES, deriveIncome, calcRecurringMonthly, wageSettingsFromIncome, RENT_CYCLES, flowPayCycle, flowDueInMonth, calcHousing, housingDueInMonth, housingSubsidyInMonth, housingPaymentSchedule, calcWageReverse, calcAchievabilityHint, calcScenario, calcStudentLoanRepayment, calcMortgageRepayment, buildTrendChartSVG
  };
})();