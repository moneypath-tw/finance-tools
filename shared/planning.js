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
  const fmt = (c) => `${Math.round(c / 100).toLocaleString('en-US')}元`;
  // 緊急預備金的唯一算法：首頁分配、進階健檢與 FIRE 連動都用這裡。
  // baseMonthlyCents＝未扣任何補助的必要固定支出＋生活費（由 app.js 的 plannedExpenses 提供）
  const emergencyFund = ({ baseMonthlyCents, months, balanceCents }) => {
    const rule = PLANNING_RULES.emergencyMonths;
    const targetMonths = Number.isFinite(months) ? Math.min(rule.max, Math.max(rule.min, months)) : rule.default;
    const base = Math.max(0, Math.round(baseMonthlyCents || 0));
    const balance = Math.max(0, Math.round(balanceCents || 0));
    const targetCents = base * targetMonths;
    const gapCents = Math.max(0, targetCents - balance);
    return { baseMonthlyCents: base, targetMonths, targetCents, balanceCents: balance, gapCents, coverageMonths: base > 0 ? balance / base : null, monthlyCents: Math.ceil(gapCents / PLANNING_RULES.emergencyFillMonths) };
  };
  // 名稱取自 ALLOCATION_PURPOSES；用途沒登記在那裡就直接報錯，免得新用途少了搭配帳戶選單
  const purposeLabel = (key) => {
    const purpose = ALLOCATION_PURPOSES.find(p => p.key === key);
    if (!purpose) throw new Error(`分配用途 ${key} 未登記在 ALLOCATION_PURPOSES`);
    return purpose.label;
  };
  const allocateMonthly = ({ incomeCents, livingCents, fixedExpenseCents, emergencyMonthlyCents, savingCents = 0, livingAccountId, fixedExpenseAccountId, emergencyAccountId, savingsAccountId, goals = [] }) => {
    let remaining = Math.max(0, Math.round(incomeCents || 0));
    const rows = [];
    const assign = (key, label, requestedCents, accountId, required, extra = {}) => {
      const requested = Math.max(0, Math.round(requestedCents || 0));
      const allocated = Math.min(remaining, requested);
      remaining -= allocated;
      rows.push({ key, label, requestedCents: requested, allocatedCents: allocated, shortfallCents: requested - allocated, accountId, required, ...extra });
    };
    // 固定支出是已約定的款項（房租、保費、貸款），收入不足時要先付，再分生活費
    assign('fixed', purposeLabel('fixed'), fixedExpenseCents, fixedExpenseAccountId, true);
    assign('living', purposeLabel('living'), livingCents, livingAccountId, true);
    assign('emergency', purposeLabel('emergency'), emergencyMonthlyCents, emergencyAccountId, true);
    if (savingCents > 0) assign('saving', purposeLabel('saving'), savingCents, savingsAccountId, true);
    [...goals].sort((a, b) => (a.months || Infinity) - (b.months || Infinity)).forEach(g => {
      const requested = g.monthlyRequiredCents ?? Math.ceil(Math.max(0, g.gapCents || 0) / Math.max(1, g.months || 1));
      assign(g.key, g.label, requested, g.accountId, false, g);
    });
    return { incomeCents: Math.round(incomeCents || 0), rows, unallocatedCents: remaining, totalAllocatedCents: rows.reduce((s, r) => s + r.allocatedCents, 0) };
  };
  // 發薪週期：最近一次發薪日（含今天）到下次發薪日前一天；發薪日超過該月天數時用月底
  const payCycle = (today, payday) => {
    const d = Math.min(31, Math.max(1, Math.trunc(payday) || 1));
    const at = (y, m) => new Date(y, m, Math.min(d, new Date(y, m + 1, 0).getDate()));
    const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    let start = at(t.getFullYear(), t.getMonth());
    if (start > t) start = at(t.getFullYear(), t.getMonth() - 1);
    const next = at(start.getFullYear(), start.getMonth() + 1);
    const ymd = Money.ymd; // money.js 載入在後，呼叫時才取用
    const totalDays = Math.round((next - start) / 86400000);
    const elapsedDays = Math.round((t - start) / 86400000) + 1;
    return { payday: d, start: ymd(start), today: ymd(t), next: ymd(next), totalDays, elapsedDays, daysLeft: totalDays - elapsedDays + 1, ratio: elapsedDays / totalDays };
  };
  // 分配表「狀態」：依本期已過天數與實際帳務（已入帳的帳目、實際餘額）判斷每個用途是否跟上進度，並給下一步建議
  //   fixed：{ dueTotalCents, paidCents, balanceCents, accountName }  本期還沒扣的固定支出要由帳戶餘額撐住
  //   living：{ spentCents, spareCents, balanceCents, accountName } 已花 vs 依天數比例的進度，剩餘每日可花
  //           spareCents＝分配完沒有用途的錢；每日可花跟摘要卡「每日生活費」一樣算進來，花超預算但沒超過它只算留意
  //   其他（緊急預備金、儲蓄、成本目標）：{ movedInCents, projectedInCents, sharedWithIncome, accountName }  發薪後應先轉入
  //           projectedInCents＝本期固定儲蓄的預測轉帳（帳本還沒確認入帳）；夠的話只提醒確認，不判不足
  //   facts.noData：沒有任何已入帳帳目、帳戶餘額也都是 0 → 還沒開始記帳，不判斷進度（不然新使用者一打開就全紅）
  // tag＝整體狀態卡列出的簡短原因：「不足」可能是收入結構不夠，也可能只是本期還沒轉帳，兩者要分開講
  //   fixed 另收 unconfirmedCents：扣款日已過、帳本仍是預測的固定支出（多半已扣款，只是還沒按「確認入帳」）
  const allocationStatus = (row, cycle, facts = {}) => {
    if (facts.noData) return { level: 'none', text: '尚未記帳或填寫帳戶餘額，暫不判斷進度' };
    // action: one imperative line for the homepage; a row short on income has none (the homepage verdict covers it)
    const out = (level, text, tag, action) => ({ level, tag: level === 'ok' ? undefined : (row.shortfallCents > 0 ? '收入不夠分配' : tag), text: row.shortfallCents > 0 ? `收入只夠分配 ${fmt(row.allocatedCents)}；${text}` : text, action: level === 'ok' || row.shortfallCents > 0 ? undefined : action });
    const target = row.allocatedCents;
    if (row.key === 'fixed') {
      const remaining = Math.max(0, (facts.dueTotalCents || 0) - (facts.paidCents || 0));
      if (!(facts.dueTotalCents > 0)) return out('ok', '本期沒有要扣的固定支出');
      if (remaining <= 0) return out('ok', `本期固定支出 ${fmt(facts.dueTotalCents)} 已全部扣款`);
      const unconfirmed = Math.min(remaining, Math.max(0, facts.unconfirmedCents || 0));
      const confirmNote = unconfirmed > 0 ? `；其中 ${fmt(unconfirmed)} 已過扣款日，扣款後到帳本按「確認入帳」` : '';
      const lack = remaining - Math.max(0, facts.balanceCents || 0);
      if (lack > 0) return out('short', `本期還要扣 ${fmt(remaining)}，${facts.accountName}餘額不足 ${fmt(lack)}，請在扣款日前轉入${confirmNote}`, '餘額不足', `扣款日前轉 ${fmt(lack)} 到${facts.accountName}`);
      return out(unconfirmed > 0 ? 'watch' : 'ok', `本期還要扣 ${fmt(remaining)}，${facts.accountName}餘額足夠${confirmNote}`, '待確認入帳', `固定支出扣款後到帳本按「確認入帳」（${fmt(unconfirmed)}）`);
    }
    if (row.key === 'living') {
      const spent = Math.max(0, facts.spentCents || 0);
      const spendable = target + Math.max(0, facts.spareCents || 0);
      const expected = Math.round(target * cycle.ratio);
      // 每日可花取整數元並無條件捨去，不高估能花的錢
      const perDay = Math.floor(Math.max(0, spendable - spent) / Math.max(1, cycle.daysLeft) / 100) * 100;
      const progress = `第 ${cycle.elapsedDays}／${cycle.totalDays} 天，已花 ${fmt(spent)}（進度 ${fmt(expected)}）`;
      if (spent > spendable) return out('short', `${progress}，已超出本期可花用 ${fmt(spent - spendable)}`, '超支', `生活費已超支 ${fmt(spent - spendable)}，剩 ${cycle.daysLeft} 天只花必要開銷`);
      const over = spent > target ? `，超出生活費預算 ${fmt(spent - target)}，已動用未分配的錢` : (spent > expected * 1.1 ? `，比進度多花 ${fmt(spent - expected)}` : '');
      const lowBalance = (facts.balanceCents ?? Infinity) < target - spent ? `；${facts.accountName}餘額只剩 ${fmt(Math.max(0, facts.balanceCents))}，不夠剩下的生活費` : '';
      return out(over || lowBalance ? 'watch' : 'ok', `${progress}${over}；剩 ${cycle.daysLeft} 天每日可花 ${fmt(perDay)}${lowBalance}`, spent > target ? '超出預算' : (over ? '花得比進度快' : '餘額偏低'),
        over ? `剩 ${cycle.daysLeft} 天每天最多花 ${fmt(perDay)}` : `轉 ${fmt(target - spent - Math.max(0, facts.balanceCents))} 到${facts.accountName}當生活費`);
    }
    if (target <= 0) return row.shortfallCents > 0 ? { level: 'short', tag: '收入不夠分配', text: `收入付完前面的用途後沒有剩，這期無法提撥（需要 ${fmt(row.requestedCents)}）` } : out('ok', '本期不需提撥');
    if (facts.sharedWithIncome) return out('watch', `${facts.accountName}也是薪資入帳帳戶，分不出這期轉入多少；建議改搭配獨立帳戶`, '無法追蹤', `${row.label}改搭配薪資以外的帳戶`);
    const moved = Math.max(0, facts.movedInCents || 0);
    if (moved >= target) return out('ok', `本期已轉入 ${fmt(moved)}，達建議 ${fmt(target)}`);
    const projected = Math.max(0, facts.projectedInCents || 0);
    if (moved + projected >= target) return out('watch', `固定儲蓄預計轉入 ${fmt(projected)} 到${facts.accountName}；轉帳後到帳本按「確認入帳」`, '待確認入帳', `固定儲蓄轉帳後到帳本按「確認入帳」（${fmt(projected)}）`);
    if (cycle.elapsedDays <= 3) return out('watch', `發薪後先轉入 ${fmt(target - moved)} 到${facts.accountName}`, '待轉入', `轉 ${fmt(target - moved)} 到${facts.accountName}（${row.label}）`);
    const pendingNote = projected > 0 ? `（其中固定儲蓄預計轉入 ${fmt(projected)}，帳本尚未確認）` : '';
    return out('short', `第 ${cycle.elapsedDays} 天仍差 ${fmt(target - moved)} 未轉入${facts.accountName}${pendingNote}`, '尚未轉入', `轉 ${fmt(target - moved)} 到${facts.accountName}（${row.label}）`);
  };
  // 首頁結論：只回答「這個月夠不夠、能存多少、差多少怎麼補」，數字全取自同一份分配結果（allocateMonthly）
  const homeVerdict = ({ allocation, emergency }) => {
    const row = (key) => allocation.rows.find(r => r.key === key) || { label: purposeLabel(key), requestedCents: 0, allocatedCents: 0, shortfallCents: 0 };
    const fixed = row('fixed'), living = row('living');
    const spendShort = fixed.shortfallCents + living.shortfallCents;
    const shortfallCents = allocation.rows.reduce((s, r) => s + r.shortfallCents, 0);
    const savingCents = allocation.totalAllocatedCents - fixed.allocatedCents - living.allocatedCents;
    const level = spendShort > 0 ? 'short' : (shortfallCents > 0 ? 'watch' : 'ok');
    const headline = spendShort > 0 ? `收入不夠付支出，每月差 ${fmt(spendShort)}`
      : `本月可存 ${fmt(savingCents)}${shortfallCents > 0 ? `，離建議還差 ${fmt(shortfallCents)}` : ''}`;
    const fixes = [];
    // 生活費是唯一能自己調的大項：差額不超過生活費就說要降到多少，否則只能增加收入或減少固定支出
    if (shortfallCents > 0 && spendShort === 0 && living.requestedCents >= shortfallCents) fixes.push(`${living.label}預算降到 ${fmt(living.requestedCents - shortfallCents)}，就能存滿建議金額`);
    else if (shortfallCents > 0) fixes.push(`每月多 ${fmt(shortfallCents)} 收入，或減少固定支出`);
    const segments = [
      { key: 'fixed', label: fixed.label, cents: fixed.allocatedCents },
      { key: 'living', label: living.label, cents: living.allocatedCents },
      { key: 'saving', label: '儲蓄', cents: savingCents },
      shortfallCents > 0 ? { key: 'short', label: '缺', cents: shortfallCents } : { key: 'spare', label: '未分配', cents: allocation.unallocatedCents }
    ].filter(s => s.cents > 0);
    return { level, headline, fixes, segments, savingCents, shortfallCents, emergency: { months: emergency.coverageMonths, targetMonths: emergency.targetMonths, gapCents: emergency.gapCents } };
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
  // spendableCents（可選）＝分配表的生活費＋未分配的錢；有給時每日生活費用它，跟分配表與生活費狀態同一個數字
  const assessMonthlySavings = ({ incomeCents, fixedExpenseCents, fixedSavingCents, actualIncomeCents, actualExpenseCents, daysInMonth, recommendedSavingCents: plannedSavingCents, spendableCents }) => {
    const income = Math.max(0, Math.round(incomeCents || 0));
    const fixedExpense = Math.max(0, Math.round(fixedExpenseCents || 0));
    const fixedSaving = Math.max(0, Math.round(fixedSavingCents || 0));
    const bands = PLANNING_RULES.savingsRateBands;
    const targetPct = `${Math.round(PLANNING_RULES.savingsRateTarget * 100)}%`;
    const recommendedSavingCents = Number.isFinite(plannedSavingCents) ? Math.max(0, Math.round(plannedSavingCents)) : Math.max(fixedSaving, Math.ceil(income * PLANNING_RULES.savingsRateTarget));
    const plannedSavingsRate = income > 0 ? recommendedSavingCents / income : null;
    const actualSavingsCents = Math.round((actualIncomeCents || 0) - Math.max(0, actualExpenseCents || 0));
    const actualSavingsRate = actualIncomeCents > 0 ? actualSavingsCents / actualIncomeCents : null;
    const attainmentRate = recommendedSavingCents > 0 ? actualSavingsCents / recommendedSavingCents : null;
    const days = Math.max(1, daysInMonth || 30);
    const livingSpaceCents = Math.max(0, income - fixedExpense - recommendedSavingCents);
    const dailyLivingCents = Math.floor((Number.isFinite(spendableCents) ? Math.max(0, spendableCents) : livingSpaceCents) / days);
    let health = { level: 'unknown', label: '資料不足' };
    const issues = [];
    const strengths = [];
    if (actualSavingsRate !== null) {
      if (actualSavingsRate < 0) health = { level: 'critical', label: '收支失衡' };
      else if (actualSavingsRate < bands.low) health = { level: 'risk', label: '偏低' };
      else if (actualSavingsRate < bands.healthy) health = { level: 'watch', label: '待改善' };
      else if (actualSavingsRate <= bands.strong) health = { level: 'healthy', label: '健康' };
      else health = { level: 'strong', label: '充足' };
    }
    if (income <= 0) issues.push('尚無本月收入，無法判斷儲蓄率');
    if (actualSavingsCents < 0) issues.push('本月支出已高於收入');
    else if (actualSavingsRate !== null && actualSavingsRate < bands.low) issues.push(`本月儲蓄率低於 ${Math.round(bands.low * 100)}%，緩衝不足`);
    else if (actualSavingsRate !== null && actualSavingsRate < PLANNING_RULES.savingsRateTarget) issues.push(`本月儲蓄率尚未達到 ${targetPct} 規劃基準`);
    if (livingSpaceCents <= 0 && income > 0) issues.push('扣除固定支出與應儲蓄後，已無每日生活費空間');
    if (attainmentRate !== null && attainmentRate < 1) issues.push('本月儲蓄尚未達成建議金額');
    if (actualIncomeCents > 0 && actualSavingsCents >= 0) strengths.push('本月收入仍高於或等於支出，現金流維持非負');
    if (actualSavingsRate !== null && actualSavingsRate >= PLANNING_RULES.savingsRateTarget) strengths.push(`本月儲蓄率 ${(actualSavingsRate * 100).toFixed(1)}%，已達 ${targetPct} 規劃基準`);
    if (attainmentRate !== null && attainmentRate >= 1) strengths.push('本月實際儲蓄已達成建議金額');
    if (fixedSaving > 0) strengths.push('已建立固定儲蓄安排，降低遺漏儲蓄的機會');
    if (livingSpaceCents > 0 && income > 0) strengths.push('依目前規劃，扣除固定支出與應儲蓄後仍保有生活費空間');
    return { recommendedSavingCents, plannedSavingsRate, actualSavingsCents, actualSavingsRate, attainmentRate, dailyLivingCents, health, issues, strengths };
  };

  const assess = (input, now = new Date()) => {
    // 未指定通膨率時用台灣官方預測（app.js 會帶入使用者在 inflationRates.TW 的覆寫值）
    const p = { ...input, inflationAnnualRate: input.inflationAnnualRate ?? REFERENCE_DATA.inflation.TW.annualRate };
    const checked = Validation.validateQuickPlan(p);
    if (!checked.valid) return { ok: false, errors: checked.errors };
    const monthlyExpense = p.monthlyEssentialExpenseCents + p.monthlyOtherExpenseCents;
    const monthlySurplus = p.monthlyNetIncomeCents - monthlyExpense;
    const savingsRate = p.monthlyNetIncomeCents > 0 ? monthlySurplus / p.monthlyNetIncomeCents : null;
    const emergency = emergencyFund({
      baseMonthlyCents: Number.isFinite(p.emergencyBaseCents) ? p.emergencyBaseCents : p.monthlyEssentialExpenseCents,
      months: p.emergencyTargetMonths,
      balanceCents: Number.isFinite(p.emergencyReserveCents) ? p.emergencyReserveCents : p.liquidAssetsCents
    });
    const { balanceCents: emergencyReserveCents, coverageMonths: emergencyMonths, targetMonths: emergencyTargetMonths, targetCents: emergencyTarget, gapCents: emergencyGap } = emergency;
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
    if (emergencyMonths !== null && emergencyMonths < PLANNING_RULES.emergencyMonths.min) risks.push({ severity: 'high', code: 'LOW_EMERGENCY', text: `緊急預備金僅可支應 ${emergencyMonths.toFixed(1)} 個月必要支出` });
    else if (emergencyMonths !== null && emergencyMonths < emergencyTargetMonths) risks.push({ severity: 'medium', code: 'EMERGENCY_BELOW_TARGET', text: `緊急預備金未達 ${emergencyTargetMonths} 個月目標，仍差 ${fmt(emergencyGap)}` });
    // 沒設主要目標（金額 0）時不出現目標相關風險；收支為負已由 NEGATIVE_CASHFLOW 提醒
    const hasGoal = p.goalAmountTodayCents > 0;
    if (hasGoal && (!Number.isFinite(contributionLoad) || contributionLoad > 1)) risks.push({ severity: 'high', code: 'GOAL_INFEASIBLE', text: '目前月結餘不足以在期限內完成目標' });
    else if (hasGoal && contributionLoad > 0.8) risks.push({ severity: 'medium', code: 'GOAL_TIGHT', text: '目標提撥占月結餘超過 80%，緩衝有限' });
    if (hasGoal && !scenarios.find(s => s.key === 'stress').feasible) risks.push({ severity: 'medium', code: 'INCOME_STRESS', text: '收入下降 20% 且零報酬時，目標無法如期完成' });

    return { ok: true, monthlyExpense, monthlySurplus, savingsRate, emergencyMonths, emergencyTargetMonths, emergencyTarget, emergencyReserveCents, emergencyGap, goalStartingAssets, monthsToGoal: months, futureGoal, monthlyGoalContribution, contributionLoad, estimatedMonths, completion, realAnnualReturnRate, scenarios, risks };
  };
  return { monthsBetween, futureValue, realRate, requiredMonthlyContribution, monthsToReachGoal, emergencyFund, allocateMonthly, payCycle, allocationStatus, homeVerdict, poolGoalSavings, assessMonthlySavings, assess };
})();
