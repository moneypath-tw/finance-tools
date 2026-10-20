// planning.js — 今日幣值、少輸入財務健檢與固定壓力情境；純函式、無網路、無 AI。
const Planning = (() => {
  const addMonths = (year, month, count) => {
    const d = new Date(Date.UTC(year, month - 1 + count, 1));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
  };
  const monthsBetween = (fromDate, targetMonth) => {
    const [y, m] = targetMonth.split('-').map(Number);
    return Math.max(0, (y - fromDate.getFullYear()) * 12 + (m - 1 - fromDate.getMonth()));
  };
  const futureValue = (todayCents, annualInflation, months) => Math.round(todayCents * Math.pow(1 + annualInflation, months / 12));
  const realRate = (nominal, inflation) => (1 + nominal) / (1 + inflation) - 1;
  const requiredMonthlyContribution = (targetFutureCents, currentCents, annualReturn, months) => {
    if (months <= 0) return Math.max(0, targetFutureCents - currentCents);
    const monthlyRate = Math.pow(1 + annualReturn, 1 / 12) - 1;
    const grownCurrent = currentCents * Math.pow(1 + monthlyRate, months);
    const gap = Math.max(0, targetFutureCents - grownCurrent);
    if (Math.abs(monthlyRate) < 1e-12) return Math.ceil(gap / months);
    const annuityFactor = (Math.pow(1 + monthlyRate, months) - 1) / monthlyRate;
    return Math.ceil(gap / annuityFactor);
  };
  const monthsToReachGoal = (goalTodayCents, currentCents, monthlyContributionCents, annualInflation, annualReturn, maxMonths = 1200) => {
    let balance = Math.max(0, Math.round(currentCents || 0));
    const contribution = Math.max(0, Math.round(monthlyContributionCents || 0));
    const monthlyReturn = Math.pow(1 + annualReturn, 1 / 12) - 1;
    for (let month = 1; month <= maxMonths; month++) {
      balance = Math.round(balance * (1 + monthlyReturn)) + contribution;
      const target = futureValue(goalTodayCents, annualInflation, month);
      if (balance >= target) return month;
    }
    return null;
  };
  const allocateMonthly = ({ incomeCents, livingCents, fixedExpenseCents, emergencyGapCents, emergencyMonthlyCents, savingCents = 0, livingAccountId, fixedExpenseAccountId, emergencyAccountId, savingsAccountId, goals = [] }) => {
    let remaining = Math.max(0, Math.round(incomeCents || 0));
    const rows = [];
    const assign = (key, label, requestedCents, accountId, required, extra = {}) => {
      const requested = Math.max(0, Math.round(requestedCents || 0));
      const allocated = Math.min(remaining, requested);
      remaining -= allocated;
      rows.push({ key, label, requestedCents: requested, allocatedCents: allocated, shortfallCents: requested - allocated, accountId, required, ...extra });
    };
    // 固定支出是已約定的款項（房租、保費、貸款），收入不足時要先付，再分生活費
    assign('fixed', '固定支出', fixedExpenseCents, fixedExpenseAccountId, true);
    assign('living', '基本生活需求', livingCents, livingAccountId, true);
    assign('emergency', '緊急預備金', emergencyMonthlyCents ?? Math.ceil(Math.max(0, emergencyGapCents || 0) / 12), emergencyAccountId, true);
    if (savingCents > 0) assign('saving', '一般儲蓄', savingCents, savingsAccountId, true);
    [...goals].sort((a, b) => (a.months || Infinity) - (b.months || Infinity)).forEach(g => {
      const requested = g.monthlyRequiredCents ?? Math.ceil(Math.max(0, g.gapCents || 0) / Math.max(1, g.months || 1));
      assign(g.key, g.label, requested, g.accountId, false, g);
    });
    return { incomeCents: Math.round(incomeCents || 0), rows, unallocatedCents: remaining, totalAllocatedCents: rows.reduce((s, r) => s + r.allocatedCents, 0) };
  };
  // 成本目標的已存金額取自指定帳戶餘額；同帳戶先保留緊急預備金目標，再依期限先後分給各目標，同一筆錢不重複計算
  const poolGoalSavings = (goals, balances, reservedByAccount = {}) => {
    const pool = {};
    return [...goals].sort((a, b) => (a.months || Infinity) - (b.months || Infinity)).map((g) => {
      if (!(g.accountId in pool)) pool[g.accountId] = Math.max(0, Math.max(0, Math.round(balances[g.accountId] || 0)) - Math.max(0, Math.round(reservedByAccount[g.accountId] || 0)));
      const target = g.invalid ? 0 : Math.max(0, Math.round(g.targetCents || 0));
      const saved = Math.min(pool[g.accountId], target);
      pool[g.accountId] -= saved;
      const gap = target - saved;
      return { ...g, targetCents: target, savedCents: saved, gapCents: gap, monthlyRequiredCents: Math.ceil(gap / Math.max(1, g.months || 1)) };
    });
  };
  // recommendedSavingCents 由呼叫端算好（含緊急預備金與成本目標）時直接用，問題點與摘要卡才會看同一個應儲蓄
  const assessMonthlySavings = ({ incomeCents, fixedExpenseCents, fixedSavingCents, actualIncomeCents, actualExpenseCents, daysInMonth, recommendedSavingCents: plannedSavingCents }) => {
    const income = Math.max(0, Math.round(incomeCents || 0));
    const fixedExpense = Math.max(0, Math.round(fixedExpenseCents || 0));
    const fixedSaving = Math.max(0, Math.round(fixedSavingCents || 0));
    const recommendedSavingCents = Number.isFinite(plannedSavingCents) ? Math.max(0, Math.round(plannedSavingCents)) : Math.max(fixedSaving, Math.ceil(income * 0.20));
    const plannedSavingsRate = income > 0 ? recommendedSavingCents / income : null;
    const actualSavingsCents = Math.round((actualIncomeCents || 0) - Math.max(0, actualExpenseCents || 0));
    const actualSavingsRate = actualIncomeCents > 0 ? actualSavingsCents / actualIncomeCents : null;
    const attainmentRate = recommendedSavingCents > 0 ? actualSavingsCents / recommendedSavingCents : null;
    const dailyLivingCents = Math.floor(Math.max(0, income - fixedExpense - recommendedSavingCents) / Math.max(1, daysInMonth || 30));
    let health = { level: 'unknown', label: '資料不足' };
    const issues = [];
    const strengths = [];
    if (actualSavingsRate !== null) {
      if (actualSavingsRate < 0) health = { level: 'critical', label: '收支失衡' };
      else if (actualSavingsRate < 0.10) health = { level: 'risk', label: '偏低' };
      else if (actualSavingsRate < 0.20) health = { level: 'watch', label: '待改善' };
      else if (actualSavingsRate <= 0.40) health = { level: 'healthy', label: '健康' };
      else health = { level: 'strong', label: '充足' };
    }
    if (income <= 0) issues.push('尚無本月收入，無法判斷儲蓄率');
    if (actualSavingsCents < 0) issues.push('本月支出已高於收入');
    else if (actualSavingsRate !== null && actualSavingsRate < 0.10) issues.push('本月儲蓄率低於 10%，緩衝不足');
    else if (actualSavingsRate !== null && actualSavingsRate < 0.20) issues.push('本月儲蓄率尚未達到 20% 規劃基準');
    if (dailyLivingCents <= 0 && income > 0) issues.push('扣除固定支出與應儲蓄後，已無每日生活費空間');
    if (attainmentRate !== null && attainmentRate < 1) issues.push('本月儲蓄尚未達成建議金額');
    if (actualIncomeCents > 0 && actualSavingsCents >= 0) strengths.push('本月收入仍高於或等於支出，現金流維持非負');
    if (actualSavingsRate !== null && actualSavingsRate >= 0.20) strengths.push(`本月儲蓄率 ${(actualSavingsRate * 100).toFixed(1)}%，已達 20% 規劃基準`);
    if (attainmentRate !== null && attainmentRate >= 1) strengths.push('本月實際儲蓄已達成建議金額');
    if (fixedSaving > 0) strengths.push('已建立固定儲蓄安排，降低遺漏儲蓄的機會');
    if (dailyLivingCents > 0 && income > 0) strengths.push('依目前規劃，扣除固定支出與應儲蓄後仍保有生活費空間');
    return { recommendedSavingCents, plannedSavingsRate, actualSavingsCents, actualSavingsRate, attainmentRate, dailyLivingCents, health, issues, strengths };
  };

  const assess = (p, now = new Date()) => {
    const checked = Validation.validateQuickPlan(p);
    if (!checked.valid) return { ok: false, errors: checked.errors };
    const monthlyExpense = p.monthlyEssentialExpenseCents + p.monthlyOtherExpenseCents;
    const monthlySurplus = p.monthlyNetIncomeCents - monthlyExpense;
    const savingsRate = p.monthlyNetIncomeCents > 0 ? monthlySurplus / p.monthlyNetIncomeCents : null;
    const emergencyReserveCents = Number.isFinite(p.emergencyReserveCents) ? Math.max(0, p.emergencyReserveCents) : p.liquidAssetsCents;
    const emergencyMonths = p.monthlyEssentialExpenseCents > 0 ? emergencyReserveCents / p.monthlyEssentialExpenseCents : null;
    const emergencyTargetMonths = Number.isFinite(p.emergencyTargetMonths) ? p.emergencyTargetMonths : 6;
    const emergencyTarget = p.monthlyEssentialExpenseCents * emergencyTargetMonths;
    const emergencyGap = Math.max(0, emergencyTarget - emergencyReserveCents);
    // 緊急預備金不可同時充當目標本金；只有超過設定目標月數必要支出的部分可投入主要目標。
    const goalStartingAssets = Math.max(0, p.liquidAssetsCents - emergencyTarget);
    const months = monthsBetween(now, p.goalTargetMonth);
    const futureGoal = futureValue(p.goalAmountTodayCents, p.inflationAnnualRate, months);
    const monthlyGoalContribution = requiredMonthlyContribution(futureGoal, goalStartingAssets, p.nominalReturnAnnualRate, months);
    const contributionLoad = monthlySurplus > 0 ? monthlyGoalContribution / monthlySurplus : Infinity;
    const estimatedMonths = monthlySurplus > 0
      ? monthsToReachGoal(p.goalAmountTodayCents, goalStartingAssets, monthlySurplus, p.inflationAnnualRate, p.nominalReturnAnnualRate)
      : null;
    const completion = estimatedMonths === null ? null : addMonths(now.getFullYear(), now.getMonth() + 1, estimatedMonths);
    const realAnnualReturnRate = realRate(p.nominalReturnAnnualRate, p.inflationAnnualRate);

    const scenarios = [
      { key: 'favorable', label: '有利', inflation: Math.max(-0.99, p.inflationAnnualRate - 0.005), incomeFactor: 1, returnRate: p.nominalReturnAnnualRate + 0.02 },
      { key: 'base', label: '基準', inflation: p.inflationAnnualRate, incomeFactor: 1, returnRate: p.nominalReturnAnnualRate },
      { key: 'stress', label: '壓力', inflation: Math.min(0.20, p.inflationAnnualRate + 0.015), incomeFactor: 0.8, returnRate: 0 }
    ].map((s) => {
      const goal = futureValue(p.goalAmountTodayCents, s.inflation, months);
      const surplus = Math.round(p.monthlyNetIncomeCents * s.incomeFactor) - monthlyExpense;
      const need = requiredMonthlyContribution(goal, goalStartingAssets, s.returnRate, months);
      return { ...s, futureGoalCents: goal, monthlySurplusCents: surplus, monthlyRequiredCents: need, feasible: surplus >= need && surplus >= 0 };
    });

    const risks = [];
    if (monthlySurplus < 0) risks.push({ severity: 'high', code: 'NEGATIVE_CASHFLOW', text: '目前每月收支為負數' });
    if (emergencyMonths !== null && emergencyMonths < 3) risks.push({ severity: 'high', code: 'LOW_EMERGENCY', text: `緊急預備金僅可支應 ${emergencyMonths.toFixed(1)} 個月必要支出` });
    else if (emergencyMonths !== null && emergencyMonths < emergencyTargetMonths) risks.push({ severity: 'medium', code: 'EMERGENCY_BELOW_TARGET', text: `緊急預備金未達 ${emergencyTargetMonths} 個月目標，仍差 ${emergencyGap} 分` });
    if (!Number.isFinite(contributionLoad) || contributionLoad > 1) risks.push({ severity: 'high', code: 'GOAL_INFEASIBLE', text: '目前月結餘不足以在期限內完成目標' });
    else if (contributionLoad > 0.8) risks.push({ severity: 'medium', code: 'GOAL_TIGHT', text: '目標提撥占月結餘超過 80%，緩衝有限' });
    if (!scenarios.find(s => s.key === 'stress').feasible) risks.push({ severity: 'medium', code: 'INCOME_STRESS', text: '收入下降 20% 且零報酬時，目標無法如期完成' });

    return { ok: true, monthlyExpense, monthlySurplus, savingsRate, emergencyMonths, emergencyTargetMonths, emergencyTarget, emergencyReserveCents, emergencyGap, goalStartingAssets, monthsToGoal: months, futureGoal, monthlyGoalContribution, contributionLoad, estimatedMonths, completion, realAnnualReturnRate, scenarios, risks };
  };
  return { monthsBetween, futureValue, realRate, requiredMonthlyContribution, monthsToReachGoal, allocateMonthly, poolGoalSavings, assessMonthlySavings, assess };
})();
