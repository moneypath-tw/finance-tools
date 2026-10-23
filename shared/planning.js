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
  // 目標時間三種填法（age 目標年紀／years 幾年後／month 年月）一律換算成年月存；至少下個月
  const targetMonthFrom = (mode, value, now, currentAge) => {
    if (mode !== 'age' && mode !== 'years') return value;
    const d = addMonths(now.getFullYear(), now.getMonth() + 1, Math.max(1, mode === 'age' ? Math.ceil((value - currentAge) * 12) : Math.round(value * 12)));
    return `${d.year}-${String(d.month).padStart(2, '0')}`;
  };
  // 反向：年月 → 幾年後、屆時年紀，給輸入欄旁的換算說明
  const describeTargetMonth = (month, now, currentAge) => {
    const years = monthsBetween(now, month) / 12;
    return { years, age: currentAge + years };
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
  // 生活花費的唯一判斷：已入帳的支出、不是固定項目產生的、記在計入生活花費的帳戶。
  // 沒指定帳戶的舊帳目無從歸屬，一律算進來；信用卡繳款記成轉帳，不是支出，所以刷卡不會算兩次
  const isLivingSpend = (e, accountIds) => e.type === 'expense' && e.status !== 'projected' && !e.recurringFlowId && (!e.account || accountIds.has(e.account));
  const livingSpendCents = (entries, accountIds, from, to) => entries
    .filter(e => isLivingSpend(e, accountIds) && e.date >= from && e.date < to)
    .reduce((s, e) => s + Math.abs(Money.entryTWDCents(e) ?? 0), 0);
  // 哪些帳戶的支出算生活花費：使用者有勾選就照勾選；沒勾選時自動判斷——
  //   算：生活費、固定支出、薪資入帳帳戶，信用卡（刷卡就是花費），其他可動用帳戶（例如現金）
  //   不算：只搭配儲蓄用途的帳戶（緊急預備金、一般儲蓄、成本目標；在那裡付款多半是動用存款）、投資等不算可動用的帳戶
  //   accounts：[{ id, nature, liquid }]
  const livingSpendAccounts = ({ accounts, chosenIds = [], spendIds = [], savingIds = [] }) => {
    const chosen = chosenIds.filter(id => accounts.some(a => a.id === id));
    if (chosen.length) return { ids: new Set(chosen), auto: false };
    const spend = new Set(spendIds), saving = new Set(savingIds);
    return { ids: new Set(accounts.filter(a => spend.has(a.id) || a.nature === 'credit' || (a.liquid && !saving.has(a.id))).map(a => a.id)), auto: true };
  };
  const median = (list) => {
    if (!list.length) return null;
    const sorted = [...list].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  };
  // 已結束的完整發薪週期（新的在前）：只算開始記帳之後的週期，不然記帳前的空白週期會被當成「沒花錢、沒收入」
  const pastCycles = ({ entries, payday, today, count }) => {
    const started = entries.filter(e => e.status !== 'projected' && e.type !== 'wishlist' && e.date).map(e => e.date).sort()[0];
    const past = [];
    let c = payCycle(today, payday);
    while (started && past.length < count) {
      const [y, m, d] = c.start.split('-').map(Number);
      c = payCycle(new Date(y, m - 1, d - 1), payday);
      if (c.start < started) break;
      past.push(c);
    }
    return past;
  };
  // 近幾個完整發薪週期的生活花費與建議預算：中位數（不被單次大額拉高），無條件進位到百元
  const livingSpendHistory = ({ entries, accountIds, payday, today, cycles = PLANNING_RULES.livingSuggestCycles }) => {
    const past = pastCycles({ entries, payday, today, count: cycles }).map(c => ({ start: c.start, next: c.next, spentCents: livingSpendCents(entries, accountIds, c.start, c.next) }));
    const medianCents = median(past.map(p => p.spentCents));
    return { cycles: past, medianCents, suggestedCents: medianCents === null ? null : Math.ceil(medianCents / 10000) * 10000 };
  };
  // 每期收支報告（存花習慣的唯一資料來源）。互轉不是收入也不是支出，但要看錢有沒有真的放進儲蓄：
  //   savedCents＝收入－全部支出（＝帳面淨資產增加；帳戶間轉帳互相抵銷）
  //   toSavingsCents＝從其他帳戶轉進儲蓄帳戶的淨額；withdrawnCents＝從儲蓄帳戶轉回其他帳戶（動用存款）
  //   spentFromSavingsCents＝直接從儲蓄帳戶付的支出（也是動用存款）
  //   netWorthEndCents＝期初帳面淨資產（帳戶期初餘額合計）＋到期末為止的收入－支出；投資帳戶不含市價變動
  //   byCategory：生活花費依分類加總（isLivingSpend）
  const cycleReports = ({ entries, cycles, livingIds, savingIds, openingCents = 0 }) => {
    const saving = new Set(savingIds);
    const cents = (e) => Math.abs(Money.entryTWDCents(e) ?? 0);
    const realized = entries.filter(e => e.status !== 'projected' && e.type !== 'wishlist' && e.date);
    return cycles.map(c => {
      const inside = realized.filter(e => e.date >= c.start && e.date < c.next);
      const sum = (pred) => inside.filter(pred).reduce((s, e) => s + cents(e), 0);
      const incomeCents = sum(e => e.type === 'income');
      const expenseCents = sum(e => e.type === 'expense');
      const toSavingsCents = sum(e => e.type === 'transfer' && saving.has(e.toAccount) && !saving.has(e.fromAccount));
      const withdrawnCents = sum(e => e.type === 'transfer' && saving.has(e.fromAccount) && !saving.has(e.toAccount));
      const byCategory = {};
      for (const e of inside) if (isLivingSpend(e, livingIds)) byCategory[e.category || '未分類'] = (byCategory[e.category || '未分類'] || 0) + cents(e);
      const flowsToEnd = realized.filter(e => e.date < c.next).reduce((s, e) => s + (e.type === 'income' ? cents(e) : e.type === 'expense' ? -cents(e) : 0), 0);
      return {
        start: c.start, next: c.next, incomeCents, expenseCents,
        livingCents: Object.values(byCategory).reduce((s, v) => s + v, 0),
        savedCents: incomeCents - expenseCents, savingsRate: incomeCents > 0 ? (incomeCents - expenseCents) / incomeCents : null,
        toSavingsCents: toSavingsCents - withdrawnCents, withdrawnCents, spentFromSavingsCents: sum(e => e.type === 'expense' && saving.has(e.account)),
        netWorthEndCents: openingCents + flowsToEnd, byCategory
      };
    });
  };
  // 存花習慣：reports 新的在前（cycleReports），current＝本期到今天的報告
  //   上一期哪個分類比「平常」（再之前幾期的中位數）多花最多；本期哪些分類已超過平常一整期的量
  //   連續幾期實際存下的錢達到建議儲蓄；存下的錢有沒有轉進儲蓄帳戶、有沒有動用存款
  const habitInsights = ({ reports, current, recommendedSavingCents }) => {
    const rule = PLANNING_RULES.habitIncrease;
    const usual = (from) => {
      const cats = new Set(from.flatMap(r => Object.keys(r.byCategory)));
      return Object.fromEntries([...cats].map(k => [k, median(from.map(r => r.byCategory[k] || 0))]));
    };
    const notable = (spent, normal) => spent - normal >= Math.max(rule.minCents, normal * rule.ratio);
    const lines = [];
    let topIncrease = null;
    if (reports.length >= 2) {
      const base = usual(reports.slice(1));
      for (const [cat, spent] of Object.entries(reports[0].byCategory)) {
        const normal = base[cat] || 0;
        if (notable(spent, normal) && (!topIncrease || spent - normal > topIncrease.extraCents)) topIncrease = { category: cat, spentCents: spent, usualCents: normal, extraCents: spent - normal };
      }
      if (topIncrease) lines.push(`上期「${topIncrease.category}」花 ${fmt(topIncrease.spentCents)}，比平常多 ${fmt(topIncrease.extraCents)}；回到平常水準每期可多存 ${fmt(topIncrease.extraCents)}`);
    }
    const overNow = [];
    if (current && reports.length) {
      const base = usual(reports);
      for (const [cat, spent] of Object.entries(current.byCategory)) if (base[cat] > 0 && spent > base[cat]) overNow.push({ category: cat, spentCents: spent, usualCents: base[cat] });
      overNow.sort((a, b) => (b.spentCents - b.usualCents) - (a.spentCents - a.usualCents));
      if (overNow.length) lines.push(`本期「${overNow[0].category}」已花 ${fmt(overNow[0].spentCents)}，超過平常一整期的 ${fmt(overNow[0].usualCents)}`);
    }
    let streak = 0;
    for (const r of reports) { if (recommendedSavingCents > 0 && r.savedCents >= recommendedSavingCents) streak++; else break; }
    const last = reports[0];
    if (last) {
      if (last.withdrawnCents + last.spentFromSavingsCents > 0) lines.push(`上期動用存款 ${fmt(last.withdrawnCents + last.spentFromSavingsCents)}（從儲蓄帳戶轉出或直接付款）`);
      else if (last.savedCents > 0 && last.toSavingsCents < last.savedCents) lines.push(`上期存下 ${fmt(last.savedCents)}，只有 ${fmt(Math.max(0, last.toSavingsCents))} 轉進儲蓄帳戶；留在生活帳戶的錢容易被花掉`);
    }
    return { topIncrease, overNow, streak, lines };
  };
  // 照實際存錢速度預測各存錢項目何時達成：實際速度依計畫比例分給各項（與分配表同一順序與比例）
  //   items：[{ label, gapCents, plannedMonthlyCents, targetMonth? }]；actualMonthlyCents＝近幾期實際存下的中位數
  const goalForecast = ({ items, plannedSavingCents, actualMonthlyCents, today }) => {
    const factor = plannedSavingCents > 0 ? Math.max(0, actualMonthlyCents || 0) / plannedSavingCents : 0;
    return items.filter(i => i.gapCents > 0).map(i => {
      const pace = Math.floor(i.plannedMonthlyCents * factor);
      const months = pace > 0 ? Math.ceil(i.gapCents / pace) : null;
      const d = months === null ? null : new Date(today.getFullYear(), today.getMonth() + months, 1);
      const doneMonth = d ? Money.ym(d) : null;
      return { ...i, paceCents: pace, months, doneMonth, late: !!(i.targetMonth && (doneMonth === null || doneMonth > i.targetMonth)) };
    });
  };
  // 支應計畫需要的每月淨收入（與 currentMonthSavingsHealth 的應儲蓄同一規則）：
  //   應儲蓄 R(I)＝max(savingFloorCents, 儲蓄率基準 × I)；savingFloorCents＝緊急預備金＋成本目標＋存到其他帳戶的固定儲蓄
  //   minimum＝付得起固定支出與生活費；recommended＝最小的 I 使 I＝支出＋R(I)
  const requiredIncome = ({ spendCents, savingFloorCents }) => {
    const spend = Math.max(0, Math.round(spendCents || 0));
    const floor = Math.max(0, Math.round(savingFloorCents || 0));
    return { minimumCents: spend, recommendedCents: Math.max(spend + floor, Math.ceil(spend / (1 - PLANNING_RULES.savingsRateTarget))) };
  };
  // 要多少工時或時薪才賺得到 needNetCents：只調整一份收入（flow），其他收入照舊（otherNetCents）
  //   淨額換算稅前用這份收入目前的淨額／稅前比例（勞健保大致隨薪資比例）；時薪與工時都無條件進位
  //   flow：{ netCents, grossCents, hourlyRateCents, monthlyWorkHours }；maxMonthlyHours＝使用者設定的工時上限
  const workTarget = ({ needNetCents, otherNetCents = 0, flow, maxMonthlyHours, minimumHourlyCents }) => {
    const flowNeed = Math.max(0, Math.round(needNetCents - otherNetCents));
    const ratio = flow.grossCents > 0 && flow.netCents > 0 ? flow.netCents / flow.grossCents : 1;
    const grossNeeded = Math.ceil(flowNeed / ratio);
    const toYuan = (c) => Math.ceil(c / 100) * 100;
    const rate = Math.max(0, flow.hourlyRateCents || 0);
    const hours = Math.max(0, flow.monthlyWorkHours || 0);
    const hoursAtRate = rate > 0 ? Math.ceil(grossNeeded / rate) : null;
    return {
      grossNeededCents: grossNeeded, hoursAtRate,
      wageAtHoursCents: hours > 0 ? toYuan(grossNeeded / hours) : null,
      wageAtMaxCents: maxMonthlyHours > 0 ? Math.max(toYuan(grossNeeded / maxMonthlyHours), minimumHourlyCents || 0) : null,
      overMax: hoursAtRate !== null && hoursAtRate > maxMonthlyHours,
      belowMinimum: rate > 0 && minimumHourlyCents > 0 && rate < minimumHourlyCents
    };
  };
  // 某日適用的法定基本工資（reference-data 的唯一來源）；next＝之後已公告、還沒生效的一筆
  const minimumWageOn = (ymd) => {
    const list = [...REFERENCE_DATA.twMinimumWage.schedule].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    return { current: [...list].reverse().find(w => w.effectiveFrom <= ymd) || null, next: list.find(w => w.effectiveFrom > ymd) || null };
  };
  // 帳戶裡本期還要用來付支出的錢：還沒扣的固定支出＋生活費預算還沒花的部分。
  // 同一個帳戶也放存款時，餘額依分配順序（固定支出→生活費→緊急預備金→儲蓄→目標）先留給這些支出，剩下的才算存款
  const spendingNeedByAccount = ({ fixedAccountId, livingAccountId, fixedDueRemainingCents, livingBudgetCents, livingSpentCents }) => {
    const need = {};
    const add = (id, cents) => { if (id) need[id] = (need[id] || 0) + Math.max(0, Math.round(cents || 0)); };
    add(fixedAccountId, fixedDueRemainingCents);
    add(livingAccountId, (livingBudgetCents || 0) - (livingSpentCents || 0));
    return need;
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
    // transfer：這個解方是「轉錢到某帳戶」；首頁改用 transferPlan 依帳戶合併後的指示，不逐列重複
    // text 可傳陣列＝[結論, 原因, 參考數字…]：分配表第一行粗體、其餘小字；其他地方用 text（各行以「；」接起）
    const out = (level, text, tag, action, transfer) => {
      const shown = level === 'ok' || row.shortfallCents > 0 ? undefined : action;
      // 收入不夠是結構性的附帶說明，放最後一行，不搶結論與直接原因
      const lines = [...[].concat(text), ...(row.shortfallCents > 0 ? [`收入只夠分配 ${fmt(row.allocatedCents)}（需要 ${fmt(row.requestedCents)}）`] : [])];
      return { level, tag: level === 'ok' ? undefined : (row.shortfallCents > 0 ? '收入不夠分配' : tag), text: lines.join('；'), lines, action: shown, ...(shown && transfer ? { transfer: true } : {}) };
    };
    const target = row.allocatedCents;
    if (row.key === 'fixed') {
      const remaining = Math.max(0, (facts.dueTotalCents || 0) - (facts.paidCents || 0));
      if (!(facts.dueTotalCents > 0)) return out('ok', '本期沒有要扣的固定支出');
      if (remaining <= 0) return out('ok', `本期固定支出 ${fmt(facts.dueTotalCents)} 已全部扣款`);
      const unconfirmed = Math.min(remaining, Math.max(0, facts.unconfirmedCents || 0));
      const confirmNote = unconfirmed > 0 ? [`其中 ${fmt(unconfirmed)} 已過扣款日，扣款後到帳本按「確認入帳」`] : [];
      const lack = remaining - Math.max(0, facts.balanceCents || 0);
      if (lack > 0) return out('short', [`扣款日前轉 ${fmt(lack)} 到${facts.accountName}`, `因為本期還要扣 ${fmt(remaining)}，${facts.accountName}餘額不足 ${fmt(lack)}`, ...confirmNote], '餘額不足', `扣款日前轉 ${fmt(lack)} 到${facts.accountName}`, true);
      return out(unconfirmed > 0 ? 'watch' : 'ok', [`本期還要扣 ${fmt(remaining)}，${facts.accountName}餘額足夠`, ...confirmNote], '待確認入帳', `固定支出扣款後到帳本按「確認入帳」（${fmt(unconfirmed)}）`);
    }
    if (row.key === 'living') {
      const spent = Math.max(0, facts.spentCents || 0);
      const spendable = target + Math.max(0, facts.spareCents || 0);
      const expected = Math.round(target * cycle.ratio);
      // 每日可花取整數元並無條件捨去，不高估能花的錢
      const perDay = Math.floor(Math.max(0, spendable - spent) / Math.max(1, cycle.daysLeft) / 100) * 100;
      // 結論（要做什麼）→ 原因 → 參考數字；第 X／Y 天已在分配表上方的本期說明
      const pace = `已花 ${fmt(spent)}，照天數平均到今天約 ${fmt(expected)}`;
      if (spent > spendable) return out('short', [`已超支 ${fmt(spent - spendable)}，剩 ${cycle.daysLeft} 天只花必要開銷`, `因為已花 ${fmt(spent)}，超過本期可花的 ${fmt(spendable)}（預算＋未分配的錢）`], '超支', `生活費已超支 ${fmt(spent - spendable)}，剩 ${cycle.daysLeft} 天只花必要開銷`);
      const lack = target - spent - Math.max(0, facts.balanceCents ?? Infinity);
      const lowBalance = lack > 0 ? `${facts.accountName}只有 ${fmt(Math.max(0, facts.balanceCents))}，這期生活費還有 ${fmt(target - spent)}沒花` : '';
      const daily = `剩 ${cycle.daysLeft} 天，每日可花 ${fmt(perDay)}`;
      const over = spent > target || spent > expected * 1.1;
      let lines;
      if (spent > target) lines = [`已超出生活費預算 ${fmt(spent - target)}；${daily}`, `因為已花 ${fmt(spent)}，預算 ${fmt(target)}，超出的部分正在用未分配的錢`];
      else if (spent > expected * 1.1) lines = [`花得比平均快；${daily}`, `因為${pace}，多了 ${fmt(spent - expected)}`];
      else if (lowBalance) lines = [`先轉 ${fmt(lack)} 到${facts.accountName}`, `因為${lowBalance}`, `轉完後${daily}（${pace}）`];
      else lines = [`生活費正常；${daily}`, pace];
      if (over && lowBalance) lines.push(`另外${lowBalance}，要轉入 ${fmt(lack)}`);
      return out(over || lowBalance ? 'watch' : 'ok', lines, spent > target ? '超出預算' : (over ? '花得比進度快' : '餘額偏低'),
        over ? `剩 ${cycle.daysLeft} 天每天最多花 ${fmt(perDay)}` : `轉 ${fmt(lack)} 到${facts.accountName}當生活費`, !over);
    }
    if (target <= 0) return row.shortfallCents > 0 ? { level: 'short', tag: '收入不夠分配', text: `收入付完前面的用途後沒有剩，這期無法提撥（需要 ${fmt(row.requestedCents)}）` } : out('ok', '本期不需提撥');
    if (facts.sharedWithIncome) return out('watch', [`建議改搭配薪資以外的帳戶`, `因為${facts.accountName}也是薪資入帳帳戶，分不出這期轉入多少`], '無法追蹤', `${row.label}改搭配薪資以外的帳戶`);
    const moved = Math.max(0, facts.movedInCents || 0);
    if (moved >= target) return out('ok', `本期已轉入 ${fmt(moved)}，達建議 ${fmt(target)}`);
    const projected = Math.max(0, facts.projectedInCents || 0);
    if (moved + projected >= target) return out('watch', [`轉帳後到帳本按「確認入帳」`, `固定儲蓄預計轉入 ${fmt(projected)} 到${facts.accountName}，帳本還沒確認`], '待確認入帳', `固定儲蓄轉帳後到帳本按「確認入帳」（${fmt(projected)}）`);
    if (cycle.elapsedDays <= 3) return out('watch', `發薪後先轉入 ${fmt(target - moved)} 到${facts.accountName}`, '待轉入', `轉 ${fmt(target - moved)} 到${facts.accountName}（${row.label}）`, true);
    const pendingNote = projected > 0 ? [`其中固定儲蓄預計轉入 ${fmt(projected)}，帳本尚未確認`] : [];
    return out('short', [`先轉 ${fmt(target - moved)} 到${facts.accountName}`, `因為第 ${cycle.elapsedDays} 天了，本期還差 ${fmt(target - moved)} 沒轉入`, ...pendingNote], '尚未轉入', `轉 ${fmt(target - moved)} 到${facts.accountName}（${row.label}）`, true);
  };
  // 每期轉帳指示的唯一算法，依目的帳戶合併（首頁「要做的事」與分配狀態的已轉入金額都讀這裡）：
  //   plannedCents＝每期要轉進該帳戶的分配額；薪資入帳帳戶的用途不用轉（stay，金額計入 stayCents）
  //     非 stay 的 plannedCents 加總＋stayCents＝已分配的收入
  //   stay 帳戶只回報支出缺額（薪資帳戶餘額不夠付本期剩下的支出，要從別的帳戶補）；那裡的存款分不出轉入多少，不追蹤
  //   remainingCents＝本期還要轉：
  //     支出用途（固定支出、生活費）補到夠付本期剩下的支出：spendingNeed－可用餘額
  //     儲蓄用途（緊急預備金、儲蓄、成本目標）每期都要存入：分配額－本期已轉入－固定儲蓄預計轉入
  //   同帳戶多用途時，本期轉入的錢依分配順序先算支出用途、剩下的才算存入；本期存入的錢不算可用餘額
  //   accounts[id]＝{ balanceCents, movedInCents（本期已入帳的淨轉入）, projectedInCents（固定儲蓄預測轉入） }
  const SPEND_KEYS = ['fixed', 'living'];
  const transferPlan = ({ rows, stayAccountIds = [], accounts = {}, spendingNeed = {} }) => {
    const stay = new Set(stayAccountIds.filter(Boolean));
    const byAccount = new Map();
    for (const row of rows) {
      if (!(row.allocatedCents > 0)) continue;
      if (!byAccount.has(row.accountId)) byAccount.set(row.accountId, []);
      byAccount.get(row.accountId).push(row);
    }
    const transfers = [], rowFacts = {};
    let stayCents = 0;
    for (const [accountId, list] of byAccount) {
      const plannedCents = list.reduce((s, r) => s + r.allocatedCents, 0);
      const isStay = stay.has(accountId);
      if (isStay) stayCents += plannedCents;
      const a = accounts[accountId] || {};
      const spendRows = list.filter(r => SPEND_KEYS.includes(r.key));
      const spendAlloc = spendRows.reduce((s, r) => s + r.allocatedCents, 0);
      let movedSave = Math.max(0, Math.round(a.movedInCents || 0) - spendAlloc);
      let projected = Math.max(0, Math.round(a.projectedInCents || 0));
      const spendLackCents = spendRows.length ? Math.max(0, (spendingNeed[accountId] || 0) - Math.max(0, Math.round(a.balanceCents || 0) - movedSave)) : 0;
      let remainingCents = spendLackCents;
      for (const r of isStay ? [] : list.filter(r => !SPEND_KEYS.includes(r.key))) {
        const moved = Math.min(movedSave, r.allocatedCents);
        movedSave -= moved;
        const proj = Math.min(projected, r.allocatedCents - moved);
        projected -= proj;
        rowFacts[r.key] = { movedInCents: moved, projectedInCents: proj };
        remainingCents += r.allocatedCents - moved - proj;
      }
      transfers.push({ accountId, purposes: list.map(r => r.label), plannedCents, remainingCents, spendLackCents, stay: isStay });
    }
    return { transfers, stayCents, rowFacts };
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
  return { monthsBetween, targetMonthFrom, describeTargetMonth, futureValue, realRate, requiredMonthlyContribution, monthsToReachGoal, emergencyFund, isLivingSpend, livingSpendCents, livingSpendAccounts, livingSpendHistory, spendingNeedByAccount, median, pastCycles, cycleReports, habitInsights, goalForecast, requiredIncome, workTarget, minimumWageOn, allocateMonthly, payCycle, allocationStatus, transferPlan, homeVerdict, poolGoalSavings, assessMonthlySavings, assess };
})();
