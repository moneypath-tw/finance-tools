// app.js — 主應用邏輯（Tab 切換 + 帳本 + 成本試算）

const App = (() => {
  let config = structuredClone(DEFAULT_CONFIG);
  let ledger = structuredClone(DEFAULT_LEDGER);
  let scenarios = structuredClone(DEFAULT_SCENARIOS).map(Validation.normalizeScenario);
  let wageReverseScenario = structuredClone(WAGE_REVERSE_SCENARIO);
  let currentScenarioId = scenarios[0].scenarioId;
  let compareMode = false;
  let summaryCardSettingsOpen = false;
  let expandedDetailKeys = new Set();
  let lastRestoreErrors = [];
  const workspaceSnapshot = () => ({ config, ledger, scenarios, wageReverseScenario });
  const restoreWorkspace = (saved) => {
    if (!saved || typeof saved !== "object") return false;
    const sourceConfig = saved.config && typeof saved.config === "object" ? saved.config : {};
    const nextConfig = { ...structuredClone(DEFAULT_CONFIG), ...sourceConfig,
      ui: { ...structuredClone(DEFAULT_CONFIG.ui), ...(sourceConfig.ui || {}) },
      dashboard: { ...structuredClone(DEFAULT_CONFIG.dashboard), ...(sourceConfig.dashboard || {}),
        scenarioSelections: { ...structuredClone(DEFAULT_CONFIG.dashboard.scenarioSelections), ...(sourceConfig.dashboard?.scenarioSelections || {}) },
        scenarioAccountMap: { ...structuredClone(DEFAULT_CONFIG.dashboard.scenarioAccountMap), ...(sourceConfig.dashboard?.scenarioAccountMap || {}) },
        scenarioTargetMonths: { ...structuredClone(DEFAULT_CONFIG.dashboard.scenarioTargetMonths), ...(sourceConfig.dashboard?.scenarioTargetMonths || {}) }
      },
      quickPlan: { ...structuredClone(DEFAULT_CONFIG.quickPlan), ...(sourceConfig.quickPlan || {}) },
      personalBaseline: { ...structuredClone(DEFAULT_CONFIG.personalBaseline), ...(sourceConfig.personalBaseline || {}) },
      insuranceRates: { ...structuredClone(DEFAULT_CONFIG.insuranceRates), ...(sourceConfig.insuranceRates || {}) }
    };
    if (!Object.prototype.hasOwnProperty.call(sourceConfig.personalBaseline || {}, "birthYear")) nextConfig.personalBaseline.birthYear = new Date().getFullYear() - Math.max(0, Math.min(120, Math.trunc(nextConfig.personalBaseline.currentAge || 0)));
    lastRestoreErrors = saved.ledger ? Validation.validateLedger(saved.ledger).errors : [{ path: 'ledger', message: '缺少帳本' }];
    if (lastRestoreErrors.length) return false;
    const nextLedger = saved.ledger;
    const nextScenarios = (Array.isArray(saved.scenarios) ? saved.scenarios : structuredClone(DEFAULT_SCENARIOS)).map(Validation.normalizeScenario);
    Validation.repairWorkspace({ config: nextConfig, scenarios: nextScenarios }, DEFAULT_CONFIG);
    // 情境內容錯誤不擋載入：編輯中本來就允許暫時不合法，畫面會顯示錯誤讓使用者修正
    const checkedWorkspace = Validation.validateWorkspace({ config: nextConfig, ledger: nextLedger, scenarios: nextScenarios }, { scenarioContentChecks: false });
    lastRestoreErrors = checkedWorkspace.errors;
    if (!checkedWorkspace.valid) return false;
    config = nextConfig;
    ledger = nextLedger;
    scenarios = nextScenarios;
    const trip = scenarios.find(s => s.scenarioId === "trip_budget");
    if (trip?.label?.startsWith("旅費預算試算（")) trip.label = "旅費預算試算";
    if (saved.wageReverseScenario && typeof saved.wageReverseScenario === "object") wageReverseScenario = { ...structuredClone(WAGE_REVERSE_SCENARIO), ...saved.wageReverseScenario };
    currentScenarioId = scenarios.some(s => s.scenarioId === config.ui?.currentScenarioId) ? config.ui.currentScenarioId : scenarios[0]?.scenarioId;
    return true;
  };
  const updateStorageStatus = ({ message, ok, lastSavedAt, bindingName }) => {
    const box = document.querySelector('#storage-status');
    const text = document.querySelector('#storage-status-text');
    if (box) box.classList.toggle('failed', !ok);
    if (text) text.textContent = message;
    const indicator = document.querySelector('#save-indicator');
    const indicatorText = document.querySelector('#save-indicator-text');
    const locationButton = document.querySelector('#choose-storage-location');
    if (indicator) indicator.classList.toggle('failed', !ok);
    if (indicatorText) indicatorText.textContent = lastSavedAt
      ? `上次保存 ${new Date(lastSavedAt).toLocaleString('zh-Hant-TW')}${bindingName ? `・已綁定 ${bindingName}` : '・瀏覽器本機'}`
      : message;
    if (locationButton) locationButton.textContent = bindingName ? `更改保存位置・${bindingName}` : '選擇本機保存位置';
  };
  const createEntryId = () => globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `e-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const syncCurrentAgeFromBirthYear = () => {
    const year = new Date().getFullYear();
    const baseline = config.personalBaseline || (config.personalBaseline = {});
    if (!Number.isInteger(baseline.birthYear) || baseline.birthYear < year - 120 || baseline.birthYear > year) {
      const legacyAge = Number.isFinite(baseline.currentAge) ? Math.max(0, Math.min(120, Math.trunc(baseline.currentAge))) : 22;
      baseline.birthYear = year - legacyAge;
    }
    baseline.currentAge = year - baseline.birthYear;
    config.quickPlan.currentAge = baseline.currentAge;
    return baseline.currentAge;
  };
  const birthYearField = () => {
    const year = new Date().getFullYear();
    const age = syncCurrentAgeFromBirthYear();
    return el('div', { class: 'field' }, [
      el('label', { text: '出生年份（西元）' }),
      el('input', { type: 'number', min: String(year - 120), max: String(year), step: '1', value: config.personalBaseline.birthYear, onchange: e => {
        config.personalBaseline.birthYear = Math.max(year - 120, Math.min(year, Math.trunc(Number(e.target.value))));
        syncCurrentAgeFromBirthYear(); IO.markDirty(); renderAll();
      } }),
      el('small', { class: 'notice', text: `系統推算目前約 ${age} 歲；因未輸入生日，可能相差 1 歲。` })
    ]);
  };
  const accountNatures = { checking: '活存／收支', savings: '儲蓄', cash: '現金', investment: '投資', credit: '信用／負債', earmarked: '專款' };
  const BUILTIN_LIQUID_NATURES = ['cash', 'checking', 'savings', 'earmarked'];
  // 使用者自訂的帳戶性質（config.customAccountNatures），可設定是否算可動用資金
  const natureLabels = () => ({ ...accountNatures, ...Object.fromEntries((config.customAccountNatures || []).map(n => [n.id, n.label || '未命名性質'])) });
  const isLiquidNature = (nature) => BUILTIN_LIQUID_NATURES.includes(nature) || (config.customAccountNatures || []).some(n => n.id === nature && n.liquid !== false);
  // 帳戶可關閉「連動固定收支」：關閉後不出現在固定項目的帳戶選單，掛在它上面的固定項目不計入每月總額與帳本預測
  const accountLinked = (id) => (config.accountProfiles || []).find(a => a.id === id)?.linkRecurring !== false;
  const flowLinked = (f) => accountLinked(f.accountId) && (f.type !== 'saving' || accountLinked(f.fromAccountId));
  // 補上缺少的預設值，但保留同一個物件：畫面上的輸入框綁的是這個物件，若換成新物件，
  // 之後的修改會寫進沒人再讀的舊物件（2026-10-20：房貸、學貸欄位改了立刻跳回預設值）
  const fillDefaults = (target, defaults) => {
    const obj = target && typeof target === 'object' && !Array.isArray(target) ? target : {};
    for (const [k, v] of Object.entries(defaults)) if (obj[k] === undefined) obj[k] = v;
    return obj;
  };
  const ensureAccountProfiles = () => {
    if (!Array.isArray(config.accountProfiles) || !config.accountProfiles.length) {
      const legacy = Array.isArray(config.accounts) ? config.accounts : [];
      config.accountProfiles = legacy.map((name, i) => ({ id: `legacy-${i + 1}`, name, nature: name === '現金' ? 'cash' : 'checking', initialBalanceCents: 0 }));
    }
    config.accounts = config.accountProfiles.map(a => a.name);
    for (const entry of ledger.entries || []) {
      const matched = config.accountProfiles.find(a => a.name === entry.account);
      if (matched) entry.account = matched.id;
    }
    for (const flow of config.recurringCashFlows || []) {
      const matched = config.accountProfiles.find(a => a.name === flow.accountId);
      if (matched) flow.accountId = matched.id;
      const fromMatched = config.accountProfiles.find(a => a.name === flow.fromAccountId);
      if (fromMatched) flow.fromAccountId = fromMatched.id;
    }
  };
  const accountName = (idOrName) => config.accountProfiles.find(a => a.id === idOrName || a.name === idOrName)?.name || idOrName || '—';
  const ensureSavingsAccount = (fromAccountId) => {
    let target = config.accountProfiles.find(a => a.id !== fromAccountId && ['savings', 'earmarked', 'investment'].includes(a.nature)) || config.accountProfiles.find(a => a.id !== fromAccountId);
    if (!target) {
      target = { id: createEntryId(), name: '儲蓄帳戶', nature: 'savings', initialBalanceCents: 0 };
      config.accountProfiles.push(target);
    }
    return target.id;
  };
  const recurringKinds = { salary: '正職薪資', part_time: '兼職薪資', freelance: '接案收入', other_income: '其他收入', fixed_expense: '固定支出' };
  const ensureDashboard = () => {
    const first = config.accountProfiles[0]?.id || null;
    config.dashboard = fillDefaults(config.dashboard, { scenarioSelections: {}, scenarioAccountMap: {}, scenarioTargetMonths: {} });
    for (const key of ['scenarioSelections', 'scenarioAccountMap', 'scenarioTargetMonths']) if (!config.dashboard[key] || typeof config.dashboard[key] !== 'object' || Array.isArray(config.dashboard[key])) config.dashboard[key] = {};
    const valid = (id) => config.accountProfiles.some(a => a.id === id);
    for (const { key, field, fallback } of ALLOCATION_PURPOSES) {
      if (valid(config.dashboard[field])) continue;
      // 一般儲蓄沿用改版前的預設：有固定儲蓄就用它轉入的帳戶，否則跟緊急預備金同帳戶
      const fromFlow = key === 'saving' ? (config.recurringCashFlows || []).find(f => f.type === 'saving' && f.active !== false)?.accountId : null;
      config.dashboard[field] = [fromFlow, fallback && config.dashboard[fallback]].find(valid) || first;
    }
    if (!Array.isArray(config.dashboard.summaryCards)) config.dashboard.summaryCards = structuredClone(DEFAULT_CONFIG.dashboard.summaryCards);
    config.dashboard.summaryCards = config.dashboard.summaryCards.filter(card => card && typeof card === 'object').map((card, index) => ({
      id: String(card.id || `custom-${index}`), source: String(card.source || 'monthlyFlex'),
      label: String(card.label || '摘要'), visible: card.visible !== false, builtIn: card.builtIn === true
    }));
    // 改版後新增的內建卡補進舊存檔；內建卡不能刪只能隱藏，所以缺少就代表存檔早於該卡
    for (const card of DEFAULT_CONFIG.dashboard.summaryCards) if (!config.dashboard.summaryCards.some(c => c.id === card.id)) config.dashboard.summaryCards.push(structuredClone(card));
  };
  const getAccountBalances = (includeProjected = false) => {
    ensureAccountProfiles();
    const balances = Object.fromEntries(config.accountProfiles.map(a => [a.id, a.initialBalanceCents || 0]));
    for (const entry of ledger.entries) {
      if (entry.type === 'wishlist' || (!includeProjected && entry.status === 'projected')) continue;
      let amount;
      try { amount = Money.toTWDCents(entry.amountCents, entry.currency, entry.rateToTWD); } catch { continue; }
      if (entry.type === 'transfer') {
        balances[entry.fromAccount] = (balances[entry.fromAccount] || 0) - Math.abs(amount);
        balances[entry.toAccount] = (balances[entry.toAccount] || 0) + Math.abs(amount);
      } else if (entry.account) balances[entry.account] = (balances[entry.account] || 0) + amount;
    }
    return balances;
  };
  const scenarioSummary = (scenario) => {
    try {
      // 不合法的情境（可保存、待修正）不能把錯誤金額帶進首頁分配與健檢目標
      const issues = Validation.validateScenario(scenario).errors;
      if (issues.length) throw new RangeError(issues.map(e => e.message).join('；'));
      const result = Money.calcScenario(scenario, config);
      return Money.toScenarioSummary(scenario, result);
    } catch (err) {
      return { type: Money.getScenarioType(scenario), totalCents: null, targetCents: null, rawGapCents: null, gapCents: null, surplusCents: null, status: 'invalid', error: err.message, detail: null };
    }
  };
  const scenarioTargetCents = (scenario) => scenarioSummary(scenario).targetCents;

  const ensureStudentLoanRepayment = (scenario) => {
    const ref = REFERENCE_DATA.twStudentLoan;
    scenario.repayment = fillDefaults(scenario.repayment, {
      graduationAge: 22, graceYears: ref.standardGraceYears, annualRate: ref.borrowerAnnualRate,
      termPlan: 'standard', includeAsFixedExpense: false, paymentDay: 5, accountId: '',
      principalMode: 'estimated', manualPrincipalCents: 0, reserveMonths: 3
    });
    ensureAccountProfiles(); ensureDashboard();
    if (!config.accountProfiles.some(a => a.id === scenario.repayment.accountId)) scenario.repayment.accountId = config.dashboard.fixedExpenseAccountId || config.accountProfiles[0]?.id || '';
    return scenario.repayment;
  };
  const studentLoanPlan = (scenario) => {
    const repayment = ensureStudentLoanRepayment(scenario);
    const result = Money.calcScenario(scenario, config);
    const borrowedSemesters = scenario.periods.filter(p => !p.isLeaveOfAbsence).length;
    const principal = repayment.principalMode === 'manual' ? repayment.manualPrincipalCents : result.grandTotal;
    return Money.calcStudentLoanRepayment(principal, borrowedSemesters, repayment, config.personalBaseline.currentAge);
  };
  const syncStudentLoanFixedExpense = () => {
    const scenario = scenarios.find(s => s.scenarioId === 'student_loan');
    if (!scenario) return null;
    const repayment = ensureStudentLoanRepayment(scenario);
    const plan = studentLoanPlan(scenario);
    if (!Array.isArray(config.recurringCashFlows)) config.recurringCashFlows = [];
    let flow = config.recurringCashFlows.find(f => f.id === 'system-student-loan-repayment');
    if (!flow && repayment.includeAsFixedExpense) {
      flow = { id: 'system-student-loan-repayment', name: '學貸每月攤還', type: 'expense', kind: 'fixed_expense', essential: true, source: 'scenario:student_loan' };
      config.recurringCashFlows.push(flow);
    }
    if (flow) Object.assign(flow, {
      amountCents: plan.monthlyPaymentCents, dayOfMonth: Math.min(31, Math.max(1, Math.trunc(repayment.paymentDay || 5))),
      accountId: repayment.accountId, active: !!repayment.includeAsFixedExpense && plan.status === 'repaying',
      systemManaged: 'student_loan', source: 'scenario:student_loan', scheduledStartAge: plan.repaymentStartAge, scheduledEndAge: plan.repaymentEndAge
    });
    return { repayment, plan, flow };
  };
  const ensureMortgageSettings = (scenario) => {
    const ref = REFERENCE_DATA.twMortgage;
    scenario.mortgage = fillDefaults(scenario.mortgage, {
      purchaseAge: 30, annualRate: ref.referenceAnnualRate, termYears: ref.referenceTermYears, graceYears: 0,
      principalMode: 'estimated', manualPrincipalCents: 0, includeAsFixedExpense: false,
      paymentDay: 5, accountId: '', reserveMonths: 6, loanPosition: 'first_home'
    });
    ensureAccountProfiles(); ensureDashboard();
    if (!config.accountProfiles.some(a => a.id === scenario.mortgage.accountId)) scenario.mortgage.accountId = config.dashboard.fixedExpenseAccountId || config.accountProfiles[0]?.id || '';
    return scenario.mortgage;
  };
  const mortgagePlan = (scenario) => {
    const settings = ensureMortgageSettings(scenario);
    const principal = settings.principalMode === 'manual' ? settings.manualPrincipalCents : scenario.loanAmountCents;
    return Money.calcMortgageRepayment(principal, settings, config.personalBaseline.currentAge);
  };
  const syncMortgageFixedExpense = () => {
    const scenario = scenarios.find(s => s.scenarioId === 'buy_house');
    if (!scenario) return null;
    const settings = ensureMortgageSettings(scenario);
    const plan = mortgagePlan(scenario);
    if (!Array.isArray(config.recurringCashFlows)) config.recurringCashFlows = [];
    let flow = config.recurringCashFlows.find(f => f.id === 'system-mortgage-repayment');
    if (!flow && settings.includeAsFixedExpense) {
      flow = { id: 'system-mortgage-repayment', name: '房貸每月攤還', type: 'expense', kind: 'fixed_expense', essential: true, source: 'scenario:mortgage' };
      config.recurringCashFlows.push(flow);
    }
    if (flow) Object.assign(flow, {
      amountCents: plan.currentPaymentCents, dayOfMonth: Math.min(31, Math.max(1, Math.trunc(settings.paymentDay || 5))),
      accountId: settings.accountId, active: !!settings.includeAsFixedExpense && ['grace', 'repaying'].includes(plan.status),
      systemManaged: 'mortgage', source: 'scenario:mortgage', scheduledStartAge: plan.repaymentStartAge, scheduledEndAge: plan.repaymentEndAge
    });
    return { settings, plan, flow };
  };
  // 首頁的必要／其他支出：有固定支出項目時，必要支出直接用標為必要的固定支出每月推估，
  // 其他支出＝非必要固定支出＋自填的「固定支出以外的生活開銷」；沒有固定支出時沿用自填的兩個數字
  const plannedExpenses = (recurring = recurringSummary()) => {
    const q = config.quickPlan;
    const derived = recurring.items.some(f => f.type === 'expense');
    if (!derived) return { derived, essentialCents: q.monthlyEssentialExpenseCents, otherCents: q.monthlyOtherExpenseCents, livingCents: q.monthlyEssentialExpenseCents + q.monthlyOtherExpenseCents };
    return { derived, essentialCents: recurring.essentialExpenseCents, otherCents: recurring.otherExpenseCents + q.monthlyOtherExpenseCents, livingCents: q.monthlyOtherExpenseCents };
  };
  // 首頁勾選的成本目標（期限、總額、搭配帳戶）；已存金額另由 Planning.poolGoalSavings 分配
  const selectedGoals = (now = new Date()) => scenarios.filter(s => config.dashboard.scenarioSelections[s.scenarioId]).map(s => {
    const accountId = config.dashboard.scenarioAccountMap[s.scenarioId] || config.accountProfiles[0]?.id;
    const configuredMonth = config.dashboard.scenarioTargetMonths[s.scenarioId];
    const targetMonth = Validation.isValidMonth(configuredMonth) ? configuredMonth : config.quickPlan.goalTargetMonth;
    const months = Math.max(1, Planning.monthsBetween(now, targetMonth));
    const summary = scenarioSummary(s);
    return { key: s.scenarioId, label: s.label, accountId, targetMonth, months, targetCents: summary.status === 'invalid' ? 0 : summary.targetCents, invalid: summary.status === 'invalid', error: summary.error || null };
  });
  // 分配表各列的「狀態」：發薪日取金額最大的固定收入；只看已入帳（非預測）的帳目與實際餘額
  const allocationStatuses = (health, now = new Date()) => {
    const recurring = recurringSummary();
    const mainIncome = recurring.items.filter(f => f.type === 'income').sort((a, b) => (b.netCents || 0) - (a.netCents || 0))[0];
    const cycle = Planning.payCycle(now, mainIncome?.dayOfMonth || 1);
    const balances = getAccountBalances();
    const twd = (e) => { try { return Math.abs(Money.toTWDCents(e.amountCents, e.currency, e.rateToTWD)); } catch { return 0; } };
    const inCycle = (e) => e.status !== 'projected' && e.date >= cycle.start && e.date <= cycle.today;
    // 本期（發薪日到下次發薪前）每個固定支出的應扣金額，算法與帳本預測帳目相同
    const dueIds = new Set();
    let dueTotalCents = 0;
    const months = [...new Set([cycle.start.slice(0, 7), cycle.next.slice(0, 7)])];
    for (const flow of recurring.items.filter(f => f.type === 'expense')) {
      for (const ym of months) {
        const [y, m] = ym.split('-').map(Number);
        const date = `${ym}-${String(Math.min(Math.max(1, Math.trunc(flow.dayOfMonth || 1)), new Date(y, m, 0).getDate())).padStart(2, '0')}`;
        if (date < cycle.start || date >= cycle.next) continue;
        const cents = flow.housingCalc ? Money.housingDueInMonth(flow.housing, ym).totalCents : (Money.flowPayCycle(flow) > 1 ? Money.flowDueInMonth(flow, ym) : flow.grossCents);
        if (!(cents > 0)) continue;
        dueTotalCents += cents;
        dueIds.add(`recurring-${flow.id}-${ym}`);
      }
    }
    const paidCents = ledger.entries.filter(e => dueIds.has(e.id) && e.status === 'realized').reduce((s, e) => s + twd(e), 0);
    const spentCents = ledger.entries.filter(e => e.type === 'expense' && !e.recurringFlowId && inCycle(e)).reduce((s, e) => s + twd(e), 0);
    const incomeAccounts = new Set(recurring.items.filter(f => f.type === 'income').map(f => f.accountId));
    // 同一帳戶搭配多個用途時，本期轉入的錢依分配順序先滿足前面的用途
    const movedPool = {};
    const movedInto = (accountId) => {
      if (!(accountId in movedPool)) movedPool[accountId] = ledger.entries.filter(e => e.type === 'transfer' && inCycle(e)).reduce((s, e) => s + (e.toAccount === accountId ? twd(e) : 0) - (e.fromAccount === accountId ? twd(e) : 0), 0);
      return movedPool[accountId];
    };
    const statuses = {};
    for (const row of health.allocation.rows) {
      const base = { accountName: accountName(row.accountId), balanceCents: balances[row.accountId] || 0 };
      let facts = base;
      if (row.key === 'fixed') facts = { ...base, dueTotalCents, paidCents };
      else if (row.key === 'living') facts = { ...base, spentCents };
      else {
        const movedInCents = Math.max(0, Math.min(movedInto(row.accountId), row.allocatedCents));
        movedPool[row.accountId] -= movedInCents;
        facts = { ...base, movedInCents, sharedWithIncome: incomeAccounts.has(row.accountId) };
      }
      statuses[row.key] = Planning.allocationStatus(row, cycle, facts);
    }
    return { cycle, payday: mainIncome ? { name: mainIncome.name || recurringKinds[mainIncome.kind], day: cycle.payday } : null, statuses };
  };
  // 每月計畫的唯一算法：摘要卡、建議分配表都讀這裡的結果
  const currentMonthSavingsHealth = (now = new Date()) => {
    ensureAccountProfiles(); ensureDashboard();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const recurring = recurringSummary();
    const expenses = plannedExpenses(recurring);
    const hasRecurringIncome = recurring.items.some(f => f.type === 'income');
    const plannedIncome = hasRecurringIncome ? recurring.incomeCents : config.quickPlan.monthlyNetIncomeCents;
    let actualIncome = 0, actualExpense = 0;
    for (const entry of ledger.entries) {
      if (!entry.date?.startsWith(ym) || entry.status === 'projected') continue;
      let amount;
      try { amount = Money.toTWDCents(entry.amountCents, entry.currency, entry.rateToTWD); } catch { continue; }
      if (entry.type === 'income') actualIncome += Math.max(0, amount);
      else if (entry.type === 'expense') actualExpense += Math.abs(amount);
    }
    const fixedExpense = recurring.essentialExpenseCents + recurring.otherExpenseCents;
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const balances = getAccountBalances();
    const emergencyAccountId = config.dashboard.emergencyAccountId;
    const emergencyTargetCents = expenses.essentialCents * (config.quickPlan.emergencyTargetMonths ?? 6);
    const emergencyBalanceCents = Math.max(0, balances[emergencyAccountId] || 0);
    const emergencyGapCents = Math.max(0, emergencyTargetCents - emergencyBalanceCents);
    const rawEmergencyMonthly = Math.ceil(emergencyGapCents / 12);
    // 固定儲蓄轉入緊急預備金帳戶時算進緊急預備金；一般儲蓄的搭配帳戶在「必備分配帳戶」自選
    const savingsFlow = recurring.items.find(f => f.type === 'saving');
    const sameAccount = (savingsFlow?.accountId || emergencyAccountId) === emergencyAccountId;
    const savingsAccountId = config.dashboard.savingAccountId || emergencyAccountId;
    const emergencyMonthlyCents = sameAccount ? Math.max(rawEmergencyMonthly, recurring.fixedSavingCents) : rawEmergencyMonthly;
    const goals = Planning.poolGoalSavings(selectedGoals(now), balances, { [emergencyAccountId]: emergencyTargetCents });
    const goalMonthlyCents = goals.reduce((s, g) => s + g.monthlyRequiredCents, 0);
    // 應儲蓄＝緊急預備金＋成本目標＋一般儲蓄，合計至少收入的 20%；固定儲蓄轉到其他帳戶時，一般儲蓄至少是那筆金額
    const savingCents = Math.max(sameAccount ? 0 : recurring.fixedSavingCents, Math.ceil(plannedIncome * 0.20) - emergencyMonthlyCents - goalMonthlyCents, 0);
    const recommendedSavingCents = emergencyMonthlyCents + goalMonthlyCents + savingCents;
    const assessed = Planning.assessMonthlySavings({ incomeCents: plannedIncome, fixedExpenseCents: fixedExpense, fixedSavingCents: recurring.fixedSavingCents, actualIncomeCents: actualIncome, actualExpenseCents: actualExpense, daysInMonth, recommendedSavingCents });
    const allocation = Planning.allocateMonthly({
      incomeCents: plannedIncome, livingCents: expenses.livingCents, fixedExpenseCents: fixedExpense, emergencyGapCents,
      emergencyMonthlyCents, savingCents, livingAccountId: config.dashboard.livingAccountId, fixedExpenseAccountId: config.dashboard.fixedExpenseAccountId,
      emergencyAccountId, savingsAccountId, goals: goals.filter(g => !g.invalid)
    });
    return {
      ...assessed, incomeCents: plannedIncome, hasRecurringIncome, fixedExpenseCents: fixedExpense, expenses, emergencyBalanceCents, emergencyGapCents,
      emergencyMonthlyCents, savingCents, savingsAccountId, goals, allocation,
      // 月度餘裕＝收入扣掉固定支出、生活費與全部應儲蓄（含成本目標），負數表示計畫超支
      monthlyFlexCents: plannedIncome - fixedExpense - expenses.livingCents - recommendedSavingCents
    };
  };
  const recurringSummary = () => { syncStudentLoanFixedExpense(); syncMortgageFixedExpense(); return Money.calcRecurringMonthly((config.recurringCashFlows || []).filter(flowLinked), config.insuranceRates); };
  const syncWageFromLinkedIncome = () => {
    const flows = (config.recurringCashFlows || []).filter(f => f.type === 'income' && f.active !== false);
    if ((!wageReverseScenario.linkedRecurringFlowId || wageReverseScenario.linkedRecurringFlowId === 'auto') && flows.length) wageReverseScenario.linkedRecurringFlowId = flows[0].id;
    const flow = flows.find(f => f.id === wageReverseScenario.linkedRecurringFlowId);
    if (!flow) return null;
    Object.assign(wageReverseScenario, Money.wageSettingsFromIncome(flow));
    return flow;
  };
  const materializeDueRecurringEntries = (now = new Date()) => {
    ensureAccountProfiles();
    if (!Array.isArray(config.recurringCashFlows)) config.recurringCashFlows = [];
    const year = now.getFullYear(), month = now.getMonth() + 1;
    const currentYm = `${year}-${String(month).padStart(2, '0')}`;
    const summary = recurringSummary();
    const nextMonth = (ym) => {
      const [y, m] = ym.split('-').map(Number);
      const d = new Date(y, m, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    };
    const marker = config.recurringProjectionThroughMonth;
    // 過去月份只補一次；本月每次都重算，固定項目月中改動（新增、改金額、加補助）才會反映到本月預測
    const resumeYm = /^\d{4}-(0[1-9]|1[0-2])$/.test(marker || '') ? nextMonth(marker) : currentYm;
    const startYm = resumeYm < currentYm ? resumeYm : currentYm;
    let changed = false;
    // 本月仍適用的預測帳目；其餘本月預測（項目已停用、刪除、取消連動或改成非繳款月）在迴圈後移除
    const keepThisMonth = new Set();
    for (let ym = startYm; ym <= currentYm; ym = nextMonth(ym)) {
      const [entryYear, entryMonth] = ym.split('-').map(Number);
      const entryLastDay = new Date(entryYear, entryMonth, 0).getDate();
      for (const flow of summary.items) {
        const day = Math.min(Math.max(1, Math.trunc(flow.dayOfMonth || 1)), entryLastDay);
        // 租屋不是每月等額：半年／一年繳的房租與電費結算只在到期月入帳，金額為當期實付
        // 租屋補助另外撥款：獨立一筆收入，按撥款日入帳，不跟繳租月綁在一起
        const subsidyCents = flow.housingCalc ? Money.housingSubsidyInMonth(flow.housing, ym) : 0;
        const subsidyDay = Math.min(Math.max(1, Math.trunc(flow.housing?.subsidy?.dayOfMonth || 1)), entryLastDay);
        if (subsidyCents > 0 && !(ym === currentYm && now.getDate() < subsidyDay)) {
          const sid = `recurring-${flow.id}-subsidy-${ym}`;
          keepThisMonth.add(sid);
          const subsidyEntry = {
            id: sid, recurringFlowId: flow.id, date: `${ym}-${String(subsidyDay).padStart(2, '0')}`,
            type: 'income', category: null, account: flow.accountId || config.accountProfiles[0]?.id || null,
            currency: 'TWD', rateToTWD: 1, amountCents: subsidyCents, incomeSource: '租屋補助',
            essential: null, reimbursable: false, status: 'projected', note: `${flow.name || '租屋'}：租屋補助（預測）`
          };
          const prev = ledger.entries.find(e => e.id === sid);
          if (prev?.status !== 'realized') { if (prev) Object.assign(prev, subsidyEntry); else ledger.entries.push(subsidyEntry); changed = true; }
        }
        if (ym === currentYm && now.getDate() < day) continue;
        const housingDue = flow.housingCalc ? Money.housingDueInMonth(flow.housing, ym) : null;
        // 一般固定支出若是兩月／季／半年／年繳，只在繳款月入帳，金額為每月金額 × 週期
        const cycle = flow.type === 'expense' && !housingDue ? Money.flowPayCycle(flow) : 1;
        const dueCents = housingDue ? housingDue.totalCents : (cycle > 1 ? Money.flowDueInMonth(flow, ym) : flow.grossCents);
        if (!(dueCents > 0)) continue;
        const id = `recurring-${flow.id}-${ym}`;
        const isIncome = flow.type === 'income';
        const isSaving = flow.type === 'saving';
        if (isSaving && (!flow.fromAccountId || flow.fromAccountId === flow.accountId)) continue;
        const entryData = isSaving ? {
          id, recurringFlowId: flow.id, date: `${ym}-${String(day).padStart(2, '0')}`,
          type: 'transfer', category: null, account: flow.fromAccountId, fromAccount: flow.fromAccountId, toAccount: flow.accountId,
          currency: 'TWD', rateToTWD: 1, amountCents: flow.grossCents, incomeSource: null,
          essential: null, reimbursable: false, status: 'projected', note: `${flow.name || '固定儲蓄'}（每月預測轉帳）`
        } : {
          id, recurringFlowId: flow.id, date: `${ym}-${String(day).padStart(2, '0')}`,
          type: flow.type, category: isIncome ? null : '固定支出', account: flow.accountId || config.accountProfiles[0]?.id || null,
          currency: 'TWD', rateToTWD: 1, amountCents: isIncome ? flow.netCents : -dueCents,
          incomeSource: isIncome ? (recurringKinds[flow.kind] || flow.name || '其他') : null,
          essential: isIncome ? null : flow.essential !== false, reimbursable: false, status: 'projected',
          note: housingDue ? `${flow.name || '租屋'}：${housingDue.parts.map(p => `${p.label} ${Money.formatTWD(p.cents)}`).join('、')}（預測）` : (cycle > 1 ? `${flow.name || '固定支出'}：每月 ${Money.formatTWD(flow.grossCents)} × ${cycle} 個月（預測）` : `${flow.name || recurringKinds[flow.kind] || '固定項目'}（每月預測入帳）`)
        };
        keepThisMonth.add(id);
        const existing = ledger.entries.find(e => e.id === id);
        if (existing?.status === 'realized') continue;
        if (existing) Object.assign(existing, entryData);
        else ledger.entries.push(entryData);
        changed = true;
      }
    }
    // 只清本月、由固定項目產生、仍是預測的帳目；已入帳的與過去月份一律保留
    for (let i = ledger.entries.length - 1; i >= 0; i -= 1) {
      const e = ledger.entries[i];
      if (e.status === 'projected' && e.recurringFlowId && e.date?.startsWith(currentYm) && !keepThisMonth.has(e.id)) { ledger.entries.splice(i, 1); changed = true; }
    }
    if (config.recurringProjectionThroughMonth !== currentYm) {
      config.recurringProjectionThroughMonth = currentYm;
      changed = true;
    }
    if (changed) IO.markDirty();
    if (config.recurringCashFlows.length) config.personalBaseline.monthlySavingsCapacityCents = summary.monthlySavingsCents;
  };

  // ---------- 共用小工具 ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null) continue; // 避免 setAttribute(k, undefined) 被當成屬性存在
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) node.appendChild(c);
    return node;
  };
  const empty = () => document.createDocumentFragment();
  // 數字輸入欄位的唯一建構處；className 只決定排版（個人設定 'field'、成本試算 'field estimator-field'）
  const numberField = (label, value, onchange, className) => el('div', { class: className }, [
    el('label', { text: label }),
    el('input', { type: 'number', class: 'mono', value, onchange: (ev) => onchange(Number(ev.target.value)) })
  ]);

  // ---------- 全站檢視模式 ----------
  const normalizeViewMode = () => {
    if (!config.ui || typeof config.ui !== 'object') config.ui = {};
    if (!['simple', 'detailed'].includes(config.ui.viewMode)) config.ui.viewMode = 'simple';
    return config.ui.viewMode;
  };

  const applyViewMode = ({ force = false, root = document } = {}) => {
    const mode = normalizeViewMode();
    document.body.dataset.viewMode = mode;
    $$('.view-mode-btn').forEach((button) => {
      const active = button.dataset.viewMode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const normalizeSummary = text => String(text || '').trim().replace(/[\d０-９][\d０-９,.，：:％%\-–—/／]*/g, '#').replace(/\s+/g, ' ');
    const detailKey = section => {
      if (section.dataset.collapseId) return `${section.closest('.tab-panel')?.id || 'global'}｜${section.dataset.collapseId}`;
      const parts = [];
      let cursor = section;
      while (cursor) {
        const summary = Array.from(cursor.children).find(child => child.tagName === 'SUMMARY');
        parts.unshift(normalizeSummary(summary?.textContent || '未命名區塊'));
        cursor = cursor.parentElement?.closest('details') || null;
      }
      const panel = section.closest('.tab-panel');
      const nearestId = section.parentElement?.closest('[id]')?.id || '';
      const scenarioScope = panel?.id === 'panel-estimator' ? `｜scenario:${currentScenarioId}` : '';
      return `${panel?.id || section.closest('footer')?.className || 'global'}｜${nearestId}${scenarioScope}｜${parts.join('〉')}`;
    };
    const details = [];
    if (root instanceof Element && root.matches('details') && !root.dataset.collapseBound) details.push(root);
    if (root.querySelectorAll) details.push(...root.querySelectorAll('details:not([data-collapse-bound])'));
    [...new Set(details)].forEach((section) => {
      const key = detailKey(section);
      section.dataset.collapseKey = key;
      section.open = expandedDetailKeys.has(key);
      section.dataset.viewReady = 'true';
      section.dataset.collapseBound = 'true';
      section.addEventListener('toggle', () => {
        if (section.open) expandedDetailKeys.add(key); else expandedDetailKeys.delete(key);
        config.ui.expandedDetails = [...expandedDetailKeys].slice(-100);
        IO.markDirty();
      });
    });
  };

  const initViewMode = () => {
    expandedDetailKeys = new Set(Array.isArray(config.ui?.expandedDetails) ? config.ui.expandedDetails : []);
    $$('.view-mode-btn').forEach((button) => {
      button.addEventListener('click', () => {
        config.ui.viewMode = button.dataset.viewMode;
        applyViewMode({ force: true });
        IO.markDirty();
      });
    });
    $('#open-detailed-mode')?.addEventListener('click', () => {
      config.ui.viewMode = 'detailed';
      applyViewMode({ force: true });
      IO.markDirty();
    });
    applyViewMode({ force: true });
    $("#open-goal-manager")?.addEventListener("click", () => {
      config.ui.viewMode = "detailed";
      config.ui.activeTab = "estimator";
      applyViewMode({ force: true });
      $$(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === "estimator"));
      $$(".tab-panel").forEach(p => p.classList.toggle("active", p.id === "panel-estimator"));
      $("#scenario-select")?.focus();
      IO.markDirty();
    });
    new MutationObserver((records) => {
      records.forEach((record) => record.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) applyViewMode({ root: node });
      }));
    }).observe(document.body, { childList: true, subtree: true });
  };

  // ---------- Tab 切換 ----------
  const initTabs = () => {
    const activateTab = tab => {
      const valid = $(`.tab-btn[data-tab="${tab}"]`) ? tab : 'health';
      $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === valid));
      $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${valid}`));
      config.ui.activeTab = valid;
    };
    $$('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        activateTab(btn.dataset.tab);
        IO.markDirty();
      });
    });
    activateTab(config.ui.activeTab);
  };

  // ================= 少輸入財務健檢 =================
  const healthMoneyField = (label, key) => el('div', { class: 'field' }, [
    el('label', { text: label }),
    el('input', {
      type: 'number', min: '0', step: '1', value: Money.toYuan(config.quickPlan[key]),
      onchange: (ev) => { config.quickPlan[key] = Math.max(0, Money.toCents(ev.target.value)); IO.markDirty(); renderHealth(); }
    })
  ]);

  const renderAllocationDashboard = () => {
    const root = $('#allocation-dashboard');
    if (!root) return;
    ensureAccountProfiles(); ensureDashboard();
    const q = config.quickPlan;
    const balances = getAccountBalances();
    const savingsHealth = currentMonthSavingsHealth();
    const recurring = recurringSummary();
    const { hasRecurringIncome, goals, allocation } = savingsHealth;
    const income = savingsHealth.incomeCents;
    const fixedExpense = savingsHealth.fixedExpenseCents;
    const emergencyBalance = savingsHealth.emergencyBalanceCents;
    const emergencyGap = savingsHealth.emergencyGapCents;
    const monthlyFlex = savingsHealth.monthlyFlexCents;
    const progress = allocationStatuses(savingsHealth);
    const accountSelect = (value, onchange) => el('select', { onchange }, config.accountProfiles.map(a => el('option', { value: a.id, text: a.name, selected: value === a.id ? 'selected' : undefined })));
    const requiredSettings = el('details', { class: 'compact-settings' }, [
      el('summary', { text: '必備分配帳戶' }),
      el('div', { class: 'toolbar' }, [
        // 每個分配用途（含之後新增的）都列出來；已選的成本目標也在這裡，跟「選擇成本目標」存同一個設定
        ...ALLOCATION_PURPOSES.map(p => el('label', {}, [document.createTextNode(`${p.label}　`), accountSelect(config.dashboard[p.field], e => { config.dashboard[p.field] = e.target.value; IO.markDirty(); renderAllocationDashboard(); })])),
        ...goals.map(g => el('label', {}, [document.createTextNode(`${g.label}（成本目標）　`), accountSelect(g.accountId, e => { config.dashboard.scenarioAccountMap[g.key] = e.target.value; IO.markDirty(); renderAllocationDashboard(); })]))
      ])
    ]);
    const optionalGoals = el('details', { class: 'compact-settings' }, [
      el('summary', { text: `選擇成本目標（已選 ${goals.length}）` }),
      ...scenarios.map(s => {
        const selected = !!config.dashboard.scenarioSelections[s.scenarioId];
        const accountId = config.dashboard.scenarioAccountMap[s.scenarioId] || config.accountProfiles[0]?.id;
        const configuredMonth = config.dashboard.scenarioTargetMonths[s.scenarioId];
        const targetMonth = Validation.isValidMonth(configuredMonth) ? configuredMonth : q.goalTargetMonth;
        return el('div', { class: 'goal-picker' }, [
          el('label', {}, [el('input', { type: 'checkbox', checked: selected ? 'checked' : undefined, onchange: e => { config.dashboard.scenarioSelections[s.scenarioId] = e.target.checked; IO.markDirty(); renderAllocationDashboard(); } }), document.createTextNode(` ${s.label}`)]),
          selected ? accountSelect(accountId, e => { config.dashboard.scenarioAccountMap[s.scenarioId] = e.target.value; IO.markDirty(); renderAllocationDashboard(); }) : null,
          selected ? el('input', { type: 'month', value: targetMonth, onchange: e => { if (Validation.isValidMonth(e.target.value)) config.dashboard.scenarioTargetMonths[s.scenarioId] = e.target.value; else delete config.dashboard.scenarioTargetMonths[s.scenarioId]; IO.markDirty(); renderAllocationDashboard(); } }) : null
        ]);
      })
    ]);
    const selectedGoalLists = goals.length ? el('div', { class: 'selected-goals' }, goals.map(goal => {
      const scenario = scenarios.find(s => s.scenarioId === goal.key);
      const items = scenario?.items || scenario?.itemTemplate || [];
      return el('details', { class: 'compact-settings', 'data-collapse-id': `selected-goal-${goal.key}` }, [
        el('summary', { text: goal.invalid ? goal.label + '（試算錯誤，未納入分配）' : goal.label + '清單・尚需 ' + Money.formatTWD(goal.gapCents) }),
        items.length ? el('table', {}, [el('tbody', {}, items.map(item => el('tr', {}, [el('td', { text: item.label }), el('td', { class: 'mono', text: Money.formatTWD(item.kind === 'discount' ? -item.amountCents : item.amountCents) })])))]) : el('p', { class: 'notice', text: '此試算為固定公式型，詳細參數請至成本試算頁調整。' })
      ]);
    })) : el('div', { class: 'selected-goals' });
    const studentLoanScenario = scenarios.find(s => s.scenarioId === 'student_loan');
    const studentLoan = studentLoanScenario ? studentLoanPlan(studentLoanScenario) : null;
    const studentLoanSettings = studentLoanScenario ? ensureStudentLoanRepayment(studentLoanScenario) : null;
    const mortgageScenario = scenarios.find(s => s.scenarioId === 'buy_house');
    const mortgage = mortgageScenario ? mortgagePlan(mortgageScenario) : null;
    const mortgageSettings = mortgageScenario ? ensureMortgageSettings(mortgageScenario) : null;
    const sourceDefinitions = [
      { value: 'income', label: '收支｜月收入', amountCents: income, note: hasRecurringIncome ? '多份工作勞健保扣除後粗估合計' : '財務健檢收入' },
      { value: 'fixedExpense', label: '收支｜固定支出', amountCents: fixedExpense, note: '每月固定款項合計' },
      { value: 'recommendedSaving', label: '收支｜應儲蓄', amountCents: savingsHealth.recommendedSavingCents, note: `規劃儲蓄率 ${savingsHealth.plannedSavingsRate === null ? '—' : (savingsHealth.plannedSavingsRate * 100).toFixed(1) + '%'}` },
      { value: 'dailyLiving', label: '收支｜每日生活費', amountCents: savingsHealth.dailyLivingCents, note: '扣除固定支出與應儲蓄（含成本目標）' },
      { value: 'monthlyFlex', label: '收支｜月度餘裕', amountCents: monthlyFlex, note: '收入扣除固定支出、生活費與應儲蓄（含成本目標）' },
      { value: 'actualSaving', label: '收支｜本月實際儲蓄', amountCents: savingsHealth.actualSavingsCents, note: savingsHealth.health.label },
      { value: 'actualSavingsRate', label: '比率｜本月儲蓄率', valueNumber: savingsHealth.actualSavingsRate, format: 'percent', note: savingsHealth.health.label },
      { value: 'attainmentRate', label: '比率｜儲蓄達成率', valueNumber: savingsHealth.attainmentRate, format: 'percent', note: `應儲蓄 ${Money.formatTWD(savingsHealth.recommendedSavingCents)}` },
      { value: 'emergencyBalance', label: '緊急預備金｜目前餘額', amountCents: emergencyBalance, note: accountName(config.dashboard.emergencyAccountId) },
      { value: 'emergencyGap', label: `緊急預備金｜距${q.emergencyTargetMonths ?? 6}個月差額`, amountCents: emergencyGap, note: emergencyGap > 0 ? '仍需補足' : `已達${q.emergencyTargetMonths ?? 6}個月目標` }
    ];
    recurring.items.forEach(flow => sourceDefinitions.push({
      value: `flow:${flow.id}`, label: `固定項目｜${flow.name || recurringKinds[flow.kind] || '未命名'}`,
      amountCents: flow.type === 'income' ? Math.max(0, flow.netCents ?? flow.amountCents ?? 0) : Math.max(0, flow.grossCents ?? flow.amountCents ?? 0),
      note: `每月 ${flow.dayOfMonth || 1} 日・${flow.type === 'income' ? '收入' : (flow.type === 'saving' ? '儲蓄' : '應繳')}`
    }));
    const accountNatureText = { checking: '活存／收支', savings: '儲蓄', cash: '現金', investment: '投資', credit: '信用／負債', earmarked: '專款' };
    config.accountProfiles.forEach(account => sourceDefinitions.push({ value: `account:${account.id}`, label: `帳戶｜${account.name}`, amountCents: balances[account.id] || 0, note: accountNatureText[account.nature] || '帳戶餘額' }));
    allocation.rows.forEach(row => {
      sourceDefinitions.push(
        { value: `allocation:${row.key}:needed`, label: `分配｜${row.label}・每月需要`, amountCents: row.requestedCents, note: accountName(row.accountId) },
        { value: `allocation:${row.key}:allocated`, label: `分配｜${row.label}・建議分配`, amountCents: row.allocatedCents, note: row.shortfallCents > 0 ? `尚差 ${Money.formatTWD(row.shortfallCents)}` : '足額' },
        { value: `allocation:${row.key}:shortfall`, label: `分配｜${row.label}・不足額`, amountCents: row.shortfallCents, note: row.shortfallCents > 0 ? '尚未足額' : '已足額' }
      );
    });
    // 狀態卡沿用分配表的判斷；整體狀態取最差的一列，說明列出要處理的用途
    const levelText = { ok: '正常', watch: '留意', short: '不足' };
    const levelRank = { ok: 0, watch: 1, short: 2 };
    const statusRows = allocation.rows.map(row => ({ row, status: progress.statuses[row.key] }));
    const worst = statusRows.reduce((max, s) => Math.max(max, levelRank[s.status.level] ?? 0), 0);
    const flagged = statusRows.filter(s => (levelRank[s.status.level] ?? 0) > 0);
    sourceDefinitions.push({
      value: 'allocationStatus', label: '分配｜整體狀態', format: 'status', level: Object.keys(levelRank)[worst],
      note: flagged.length ? flagged.map(s => `${s.row.label}${levelText[s.status.level]}`).join('、') : `${statusRows.length} 項分配皆正常`
    });
    statusRows.forEach(({ row, status }) => sourceDefinitions.push({ value: `allocation:${row.key}:status`, label: `分配｜${row.label}・狀態`, format: 'status', level: status.level, note: status.text }));
    goals.forEach(goal => sourceDefinitions.push(
      { value: `goal:${goal.key}:target`, label: `目標｜${goal.label}・總額`, amountCents: goal.targetCents, note: goal.targetMonth },
      { value: `goal:${goal.key}:saved`, label: `目標｜${goal.label}・已存`, amountCents: goal.savedCents, note: accountName(goal.accountId) },
      { value: `goal:${goal.key}:gap`, label: `目標｜${goal.label}・尚缺`, amountCents: goal.gapCents, note: goal.targetMonth }
    ));
    if (studentLoan) sourceDefinitions.push({ value: 'loan:student:payment', label: '貸款｜學貸月繳', amountCents: studentLoan.monthlyPaymentCents, note: `${studentLoan.repaymentStartAge} 歲起繳` });
    if (mortgage) sourceDefinitions.push(
      { value: 'loan:mortgage:payment', label: '貸款｜房貸目前月繳', amountCents: mortgage.currentPaymentCents, note: `${mortgage.repaymentStartAge} 歲起繳` },
      { value: 'loan:mortgage:normalPayment', label: '貸款｜房貸寬限後月繳', amountCents: mortgage.monthlyPaymentCents, note: '本息平均攤還' }
    );
    const sourceById = Object.fromEntries(sourceDefinitions.map(source => [source.value, source]));
    const formatCardValue = source => source.format === 'status' ? levelText[source.level] : source.format === 'percent'
      ? (source.valueNumber === null || !Number.isFinite(source.valueNumber) ? '尚無資料' : `${(source.valueNumber * 100).toFixed(1)}%`)
      : Money.formatTWD(source.amountCents);
    const summaryCards = config.dashboard.summaryCards.filter(card => card.visible !== false).map(card => {
      const source = sourceById[card.source];
      const negative = source && (source.format === 'status' ? source.level === 'short' : source.format === 'percent' ? source.valueNumber < 0 : source.amountCents < 0);
      const watch = source?.format === 'status' && source.level === 'watch';
      return el('div', { class: `summary-block dashboard-mini-card${negative ? ' negative-card' : ''}${watch ? ' watch-card' : ''}${!source ? ' missing-card' : ''}` }, [
        el('h3', { text: card.label }),
        el('p', { class: `mono dashboard-mini-value${negative ? ' neg' : ''}${watch ? ' watch' : ''}`, text: source ? formatCardValue(source) : '來源不存在' }),
        el('p', { class: 'notice', text: source?.note || '原資料已被刪除，請重新選擇來源' })
      ]);
    });
    const renderSummaryCardSettings = () => {
      const sourceOptions = selected => sourceDefinitions.map(source => el('option', { value: source.value, text: source.label, selected: selected === source.value ? 'selected' : undefined }));
      const refreshSettings = () => { summaryCardSettingsOpen = true; IO.markDirty(); renderAllocationDashboard(); };
      return el('details', {
        class: 'compact-settings editor-only',
        'data-collapse-id': 'summary-card-settings',
        open: summaryCardSettingsOpen ? 'open' : undefined,
        'data-view-ready': 'true',
        ontoggle: e => { summaryCardSettingsOpen = e.currentTarget.open; }
      }, [
        el('summary', { text: `摘要卡設定（顯示 ${summaryCards.length} 張）` }),
        el('p', { class: 'notice', text: '可搭配本頁全部可計算來源：收支、比率、固定項目、帳戶、分配、目標與貸款；資料變動時卡片會同步更新。' }),
        ...config.dashboard.summaryCards.map(card => el('div', { class: 'summary-card-setting-row' }, [
          el('label', { class: 'inline-check' }, [el('input', { type: 'checkbox', checked: card.visible ? 'checked' : undefined, onchange: e => { card.visible = e.target.checked; refreshSettings(); } }), document.createTextNode(' 顯示')]),
          el('input', { type: 'text', value: card.label, 'aria-label': '摘要卡名稱', onchange: e => { card.label = e.target.value.trim() || sourceById[card.source]?.label.split('｜').pop() || '摘要'; refreshSettings(); } }),
          el('select', { 'aria-label': '摘要卡資料來源', disabled: card.builtIn ? 'disabled' : undefined, onchange: e => { card.source = e.target.value; card.label = sourceById[card.source]?.label.split('｜').pop() || card.label; refreshSettings(); } }, sourceOptions(card.source)),
          !card.builtIn ? el('button', { class: 'btn small danger', text: '刪除', onclick: () => { config.dashboard.summaryCards = config.dashboard.summaryCards.filter(item => item.id !== card.id); refreshSettings(); } }) : null
        ])),
        el('button', { class: 'btn small', text: '＋新增摘要卡', onclick: () => { config.dashboard.summaryCards.push({ id: `custom-${Date.now()}`, source: 'monthlyFlex', label: '月度餘裕', visible: true, builtIn: false }); refreshSettings(); } })
      ]);
    };
    const openLoanSettings = (scenarioId) => {
        config.ui.viewMode = 'detailed';
        config.ui.activeTab = 'estimator';
        config.ui.currentScenarioId = scenarioId;
        applyViewMode({ force: true });
        IO.markDirty();
        currentScenarioId = scenarioId;
        $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'estimator'));
        $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-estimator'));
        $('#scenario-select').value = currentScenarioId; renderEstimator();
        document.querySelector('#panel-estimator')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    const loanOverview = el('section', { class: 'loan-overview-home' }, [
      el('div', { class: 'section-heading' }, [el('h3', { text: '貸款規劃' }), el('p', { class: 'notice', text: '集中查看房貸與學貸；詳細參數只在成本試算調整。' })]),
      studentLoan ? el('div', { class: 'loan-overview-row' }, [el('div', {}, [el('strong', { text: '學貸' }), el('p', { class: 'notice', text: studentLoan.status === 'waiting' ? `${studentLoan.repaymentStartAge} 歲起・月繳 ${Money.formatTWD(studentLoan.monthlyPaymentCents)}` : (studentLoan.status === 'repaying' ? `攤還中・月繳 ${Money.formatTWD(studentLoan.monthlyPaymentCents)}・${studentLoanSettings.includeAsFixedExpense ? '已連動帳本' : '尚未連動'}` : '估算已完成') })]), el('button', { class: 'btn small', text: '設定學貸', onclick: () => openLoanSettings('student_loan') })]) : null,
      mortgage ? el('div', { class: 'loan-overview-row' }, [el('div', {}, [el('strong', { text: '房貸' }), el('p', { class: 'notice', text: mortgage.status === 'waiting' ? `${mortgage.repaymentStartAge} 歲起・月繳 ${Money.formatTWD(mortgage.currentPaymentCents)}` : (['grace', 'repaying'].includes(mortgage.status) ? `${mortgage.status === 'grace' ? '寬限期' : '攤還中'}・月繳 ${Money.formatTWD(mortgage.currentPaymentCents)}・${mortgageSettings.includeAsFixedExpense ? '已連動帳本' : '尚未連動'}` : '估算已完成') })]), el('button', { class: 'btn small', text: '設定房貸', onclick: () => openLoanSettings('buy_house') })]) : null
    ]);
    root.innerHTML = '';
    root.append(
      el('div', { class: 'dashboard-summary' }, summaryCards.length ? summaryCards : [el('p', { class: 'notice', text: '目前未顯示摘要卡；可切換至編輯模式重新勾選。' })]),
      renderSummaryCardSettings(),
      loanOverview,
      el('p', { class: 'notice editor-only allocation-cycle', text: `本期 ${progress.cycle.start.slice(5).replace('-', '/')}～${progress.cycle.next.slice(5).replace('-', '/')} 前（${progress.payday ? `依「${progress.payday.name}」每月 ${progress.payday.day} 日發薪` : '尚未設定固定收入，以每月 1 日起算'}）・第 ${progress.cycle.elapsedDays}／${progress.cycle.totalDays} 天（${Math.round(progress.cycle.ratio * 100)}%）；狀態只看已入帳的帳目與實際餘額` }),
      el('div', { class: 'table-scroll editor-only' }, [el('table', { class: 'allocation-table' }, [
        el('thead', {}, [el('tr', {}, [el('th', { text: '用途' }), el('th', { text: '搭配帳戶' }), el('th', { text: '每月需要' }), el('th', { text: '建議分配' }), el('th', { text: '狀態' })])]),
        el('tbody', {}, allocation.rows.map(r => el('tr', { class: r.shortfallCents > 0 ? 'allocation-short' : '' }, [
          el('td', {}, [document.createTextNode(r.label), r.required ? el('span', { class: 'badge', text: '必備' }) : null, !r.required ? el('div', { class: 'notice', text: `目標 ${Money.formatTWD(r.targetCents)}・帳戶已有 ${Money.formatTWD(r.savedCents)}・${r.targetMonth}` }) : null]),
          el('td', { text: accountName(r.accountId) }), el('td', { class: 'mono', text: Money.formatTWD(r.requestedCents) }),
          el('td', { class: 'mono', text: Money.formatTWD(r.allocatedCents) }),
          el('td', { class: `allocation-status status-${progress.statuses[r.key].level}`, text: progress.statuses[r.key].text })
        ])))
      ])]),
      selectedGoalLists,
      requiredSettings, optionalGoals,
      el('p', { class: 'notice editor-only', text: '此表會自動重算建議用途；不會連線或操作真實銀行帳戶。所選目標的已存金額取自指定帳戶目前餘額。' })
    );
  };

  const renderHealth = () => {
    const form = $('#health-form');
    const resultRoot = $('#health-results');
    if (!form || !resultRoot) return;
    form.innerHTML = '';
    const q = config.quickPlan;
    renderAllocationDashboard();
    const recurringForHealth = recurringSummary();
    const expensesForHealth = plannedExpenses(recurringForHealth);
    const hasRecurringIncome = recurringForHealth.items.some(f => f.type === 'income');
    const liquidBalances = getAccountBalances();
    const derivedLiquidAssets = config.accountProfiles.filter(a => isLiquidNature(a.nature)).reduce((sum, a) => sum + Math.max(0, liquidBalances[a.id] || 0), 0);
    const hasAccountAssets = derivedLiquidAssets > 0 || ledger.entries.length > 0;
    const derivedField = (label, cents, note) => el('div', { class: 'field' }, [el('label', { text: label }), el('span', { class: 'mono readonly-value', text: Money.formatTWD(cents) }), el('small', { class: 'notice', text: note })]);
    if (!['month', 'age'].includes(q.goalDeadlineMode)) q.goalDeadlineMode = 'month';
    if (!Number.isFinite(q.goalTargetAge) || q.goalTargetAge <= q.currentAge) q.goalTargetAge = Math.min(120, Math.max(q.currentAge + 1, 30));
    const ageDeadlineDate = new Date();
    ageDeadlineDate.setMonth(ageDeadlineDate.getMonth() + Math.max(1, Math.ceil((q.goalTargetAge - q.currentAge) * 12)));
    const ageTargetMonth = `${ageDeadlineDate.getFullYear()}-${String(ageDeadlineDate.getMonth() + 1).padStart(2, '0')}`;
    const effectiveTargetMonth = q.goalDeadlineMode === 'age' ? ageTargetMonth : q.goalTargetMonth;
    if (q.goalScenarioId !== 'manual' && !scenarios.some(s => s.scenarioId === q.goalScenarioId)) q.goalScenarioId = 'manual';
    const linkedGoal = scenarios.find(s => s.scenarioId === q.goalScenarioId);
    const linkedGoalAmount = linkedGoal ? scenarioTargetCents(linkedGoal) : q.goalAmountTodayCents;
    const linkedGoalInvalid = !!linkedGoal && linkedGoalAmount === null;
    const goalSourceField = el('div', { class: 'field wide' }, [
      el('label', { text: '主要儲蓄目標來源' }),
      el('select', { onchange: e => { q.goalScenarioId = e.target.value; IO.markDirty(); renderHealth(); } }, [
        el('option', { value: 'manual', text: '自行輸入金額', selected: q.goalScenarioId === 'manual' ? 'selected' : undefined }),
        ...scenarios.map(s => el('option', { value: s.scenarioId, text: `連動成本試算・${s.label}`, selected: q.goalScenarioId === s.scenarioId ? 'selected' : undefined }))
      ]),
      el('small', { class: 'notice', text: linkedGoal ? '直接引用成本試算的目標總額；該頁更新後同步重算，不重複加計通膨。' : '先填「如果今天完成，總共要花多少」；系統再推算完成月份需要準備的總額。' })
    ]);
    form.append(
      birthYearField(),
      numField('緊急預備金目標（月數）', q.emergencyTargetMonths, (v) => { q.emergencyTargetMonths = Math.max(3, Math.min(18, Math.trunc(v))); IO.markDirty(); renderHealth(); }),
      hasRecurringIncome ? derivedField('每月勞健保扣除後收入粗估', recurringForHealth.incomeCents, '由固定收入自動帶入') : healthMoneyField('每月勞健保扣除後收入粗估（元）', 'monthlyNetIncomeCents'),
      expensesForHealth.derived ? derivedField('每月必要支出', expensesForHealth.essentialCents, '由標為必要的固定支出每月推估自動帶入') : healthMoneyField('每月必要支出（元）', 'monthlyEssentialExpenseCents'),
      healthMoneyField(expensesForHealth.derived ? '固定支出以外的每月生活開銷（元）' : '每月其他支出（元）', 'monthlyOtherExpenseCents'),
      hasAccountAssets ? derivedField('可動用資產', derivedLiquidAssets, '由流動性帳戶餘額自動加總；緊急預備金另看指定帳戶') : healthMoneyField('可動用資產（元）', 'liquidAssetsCents'),
      goalSourceField,
      linkedGoal ? (linkedGoalInvalid ? el('p', { class: 'neg', text: '成本試算目前無法計算，請先修正情境設定。' }) : derivedField('成本試算目標總額', linkedGoalAmount, '由成本試算情境自動更新')) : healthMoneyField('如果今天完成，總共要花多少（元）', 'goalAmountTodayCents'),
      el('div', { class: 'field' }, [el('label', { text: '完成期限標準' }), el('select', { onchange: e => { q.goalDeadlineMode = e.target.value; IO.markDirty(); renderHealth(); } }, [
        el('option', { value: 'month', text: '希望完成月份', selected: q.goalDeadlineMode === 'month' ? 'selected' : undefined }),
        el('option', { value: 'age', text: '希望完成年齡', selected: q.goalDeadlineMode === 'age' ? 'selected' : undefined })
      ])]),
      q.goalDeadlineMode === 'month'
        ? el('div', { class: 'field' }, [el('label', { text: '希望完成月份' }), el('input', { type: 'month', value: q.goalTargetMonth, onchange: (e) => { if (Validation.isValidMonth(e.target.value)) q.goalTargetMonth = e.target.value; IO.markDirty(); renderHealth(); } })])
        : el('div', { class: 'field' }, [el('label', { text: '希望完成年齡' }), el('input', { type: 'number', min: String(Math.ceil(q.currentAge + 1)), max: '120', step: '1', value: q.goalTargetAge, onchange: e => { q.goalTargetAge = Math.min(120, Math.max(Math.ceil(q.currentAge + 1), Number(e.target.value))); IO.markDirty(); renderHealth(); } }), el('small', { class: 'notice', text: `依目前 ${q.currentAge} 歲推算，約為 ${ageTargetMonth.replace('-', ' 年 ')} 月` })]),
      el('details', {}, [
        el('summary', { text: '進階假設（可選）' }),
        el('div', { class: 'field' }, [el('label', { text: '年通膨率（小數）' }), el('input', { type: 'number', step: '0.001', value: q.inflationAnnualRate, onchange: (e) => { q.inflationAnnualRate = Number(e.target.value); IO.markDirty(); renderHealth(); } })]),
        el('div', { class: 'field' }, [el('label', { text: '名目年報酬率（小數）' }), el('input', { type: 'number', step: '0.001', value: q.nominalReturnAnnualRate, onchange: (e) => { q.nominalReturnAnnualRate = Number(e.target.value); IO.markDirty(); renderHealth(); } })]),
        el('p', { class: 'notice', text: `${REFERENCE_DATA.twInflation.source}；資料日 ${REFERENCE_DATA.twInflation.observedThrough}。預設值可手動覆寫。` })
      ])
    );
    const emergencyReserveCents = hasAccountAssets ? Math.max(0, liquidBalances[config.dashboard.emergencyAccountId] || 0) : q.liquidAssetsCents;
    const effectivePlan = { ...q, monthlyEssentialExpenseCents: expensesForHealth.essentialCents, monthlyOtherExpenseCents: expensesForHealth.otherCents, goalTargetMonth: effectiveTargetMonth, goalAmountTodayCents: linkedGoalAmount, inflationAnnualRate: linkedGoal ? 0 : q.inflationAnnualRate, monthlyNetIncomeCents: hasRecurringIncome ? recurringForHealth.incomeCents : q.monthlyNetIncomeCents, liquidAssetsCents: hasAccountAssets ? derivedLiquidAssets : q.liquidAssetsCents, emergencyReserveCents };
    const result = Planning.assess(effectivePlan);
    resultRoot.innerHTML = '';
    if (!result.ok) {
      resultRoot.append(el('h3', { text: '請修正輸入' }), el('ul', {}, result.errors.map(e => el('li', { class: 'neg', text: e.message }))));
      return;
    }
    const pct = (v) => v === null ? '無法計算' : `${Math.round(v * 100)}%`;
    const [goalYear, goalMonth] = String(effectiveTargetMonth || '').split('-');
    const goalDeadlineLabel = goalYear && goalMonth ? `${goalYear} 年 ${Number(goalMonth)} 月主要儲蓄目標` : '主要儲蓄目標';
    resultRoot.append(
      el('h3', { text: '健檢結果' }),
      el('div', { class: 'health-grid' }, [
        el('div', { class: 'summary-block highlight' }, [el('h3', { text: '每月結餘' }), el('p', { class: 'mono big', text: Money.formatTWD(result.monthlySurplus) }), el('p', { text: `儲蓄率 ${pct(result.savingsRate)}` })]),
        el('div', { class: 'summary-block highlight' }, [el('h3', { text: '緊急預備金' }), el('p', { class: 'mono big', text: result.emergencyMonths === null ? '無法計算' : `${result.emergencyMonths.toFixed(1)} 個月` }), el('p', { text: `距 ${result.emergencyTargetMonths} 個月目標差 ${Money.formatTWD(result.emergencyGap)}` })]),
        el('div', { class: 'summary-block highlight' }, [el('h3', { text: linkedGoal ? `${linkedGoal.label}・需準備總額` : goalDeadlineLabel }), el('p', { class: 'mono big', text: Money.formatTWD(result.futureGoal) }), el('p', { text: `${linkedGoal ? '直接引用成本試算結果' : '由今天的總花費按通膨推算'}・每月至少準備 ${Money.formatTWD(result.monthlyGoalContribution)}` })]),
        el('div', { class: 'summary-block highlight' }, [el('h3', { text: '實質報酬假設' }), el('p', { class: 'mono big', text: pct(result.realAnnualReturnRate) }), el('p', { text: '由名目報酬扣除通膨影響' })])
      ]),
      el('h3', { class: 'editor-only', text: '固定情境' }),
      el('table', { class: 'editor-only' }, [
        el('thead', {}, [el('tr', {}, [el('th', { text: '情境' }), el('th', { text: '通膨後目標' }), el('th', { text: '月結餘' }), el('th', { text: '每月所需' }), el('th', { text: '結果' })])]),
        el('tbody', {}, result.scenarios.map(s => el('tr', {}, [el('td', { text: s.label }), el('td', { class: 'mono', text: Money.formatTWD(s.futureGoalCents) }), el('td', { class: 'mono', text: Money.formatTWD(s.monthlySurplusCents) }), el('td', { class: 'mono', text: Money.formatTWD(s.monthlyRequiredCents) }), el('td', { class: s.feasible ? '' : 'neg', text: s.feasible ? '可行' : '無法如期' })])))
      ]),
      el('h3', { text: '主要風險' }),
      result.risks.length ? el('ul', {}, result.risks.map(r => el('li', { class: r.severity === 'high' ? 'neg' : '', text: r.text }))) : el('p', { text: '目前固定檢查未發現高風險；仍須定期更新收入、支出與假設。' })
    );
  };

  let lastRateByCurrency = {}; // session 記憶，不持久化

  // ================= 帳本 Tab =================
  const renderLedgerForm = () => {
    ensureAccountProfiles();
    const wrap = $('#ledger-form');
    wrap.innerHTML = '';
    const typeSel = el('select', { id: 'f-type' }, [
      el('option', { value: 'expense', text: '支出' }),
      el('option', { value: 'income', text: '收入' }),
      el('option', { value: 'transfer', text: '帳戶轉帳' }),
      el('option', { value: 'wishlist', text: '願望清單' })
    ]);
    const dateInput = el('input', { type: 'date', id: 'f-date', value: localToday() });
    const catSel = el('select', { id: 'f-category' },
      config.categories.map((c) => el('option', { value: c, text: c })));
    const accSel = el('select', { id: 'f-account' },
      config.accountProfiles.map((a) => el('option', { value: a.id, text: `${a.name}（${natureLabels()[a.nature] || a.nature}）` })));
    const toAccSel = el('select', { id: 'f-to-account' },
      config.accountProfiles.map((a) => el('option', { value: a.id, text: `${a.name}（${natureLabels()[a.nature] || a.nature}）` })));
    const amountInput = el('input', { type: 'number', id: 'f-amount', step: '1', placeholder: '金額（原始幣別，支出可留正數，系統自動處理正負號）' });
    const currencySel = el('select', { id: 'f-currency' }, [
      el('option', { value: 'TWD', text: 'TWD 台幣' }),
      el('option', { value: 'EUR', text: 'EUR 歐元' }),
      el('option', { value: 'JPY', text: 'JPY 日圓' }),
      el('option', { value: 'USD', text: 'USD 美元' })
    ]);
    const rateInput = el('input', { type: 'number', id: 'f-rate', step: '0.0001', placeholder: '當下匯率（1 單位 = ? 台幣）' });
    const rateField = el('div', { class: 'field', id: 'f-rate-field' }, [el('label', { text: '台幣匯率' }), rateInput]);
    rateField.style.display = 'none';
    currencySel.addEventListener('change', () => {
      const c = currencySel.value;
      if (c === 'TWD') { rateField.style.display = 'none'; }
      else { rateField.style.display = ''; rateInput.value = lastRateByCurrency[c] || ''; }
    });

    const incomeSourceSel = el('select', { id: 'f-income-source' }, [
      el('option', { value: '薪資', text: '薪資' }),
      el('option', { value: '接案', text: '接案' }),
      el('option', { value: '其他', text: '其他' })
    ]);
    const incomeSourceField = el('div', { class: 'field', id: 'f-income-source-field' }, [el('label', { text: '收入來源' }), incomeSourceSel]);

    const essentialChk = el('label', {}, [
      el('input', { type: 'checkbox', id: 'f-essential', checked: 'checked' }), document.createTextNode(' 必要支出')
    ]);
    const reimbChk = el('label', {}, [
      el('input', { type: 'checkbox', id: 'f-reimb' }), document.createTextNode(' 可報銷')
    ]);
    const noteInput = el('input', { type: 'text', id: 'f-note', placeholder: '備註' });
    const addBtn = el('button', { class: 'btn primary', text: '新增紀錄', onclick: addEntry });

    const catField = el('div', { class: 'field', id: 'f-category-field' }, [el('label', { text: '分類' }), catSel]);
    const accField = el('div', { class: 'field', id: 'f-account-field' }, [el('label', { text: '帳戶' }), accSel]);
    const toAccField = el('div', { class: 'field', id: 'f-to-account-field' }, [el('label', { text: '轉入帳戶' }), toAccSel]);

    typeSel.addEventListener('change', () => {
      const t = typeSel.value;
      catField.style.display = (t === 'income' || t === 'transfer') ? 'none' : '';
      accField.style.display = t === 'wishlist' ? 'none' : '';
      accField.querySelector('label').textContent = t === 'transfer' ? '轉出帳戶' : '帳戶';
      toAccField.style.display = t === 'transfer' ? '' : 'none';
      $('#f-essential-field').style.display = t === 'expense' ? '' : 'none';
      $('#f-reimb-field').style.display = t === 'expense' ? '' : 'none';
      incomeSourceField.style.display = t === 'income' ? '' : 'none';
    });

    wrap.append(
      el('div', { class: 'field' }, [el('label', { text: '類型' }), typeSel]),
      el('div', { class: 'field' }, [el('label', { text: '日期' }), dateInput]),
      catField, accField, toAccField,
      el('div', { class: 'field' }, [el('label', { text: '幣別' }), currencySel]),
      el('div', { class: 'field' }, [el('label', { text: '金額' }), amountInput]),
      rateField,
      incomeSourceField,
      el('div', { class: 'field', id: 'f-essential-field' }, [essentialChk]),
      el('div', { class: 'field', id: 'f-reimb-field' }, [reimbChk]),
      el('div', { class: 'field wide' }, [el('label', { text: '備註' }), noteInput]),
      addBtn
    );
    accField.style.display = '';
    toAccField.style.display = 'none';
    incomeSourceField.style.display = 'none';
  };

  const addEntry = () => {
    const type = $('#f-type').value;
    const rawAmount = Number($('#f-amount').value || 0);
    if (!rawAmount) { alert('請輸入金額'); return; }
    const currency = $('#f-currency').value;
    let rateToTWD = 1;
    if (currency !== 'TWD') {
      rateToTWD = Number($('#f-rate').value || 0);
      if (!rateToTWD) { alert('請輸入這筆的當下匯率'); return; }
      lastRateByCurrency[currency] = rateToTWD;
    }
    const amountYuan = type === 'expense' ? -Math.abs(rawAmount) : Math.abs(rawAmount);
    if (type === 'transfer' && $('#f-account').value === $('#f-to-account').value) { alert('轉出與轉入帳戶不可相同'); return; }
    const entry = {
      id: createEntryId(),
      date: $('#f-date').value,
      type,
      category: type === 'income' ? null : $('#f-category').value,
      account: type === 'wishlist' ? null : $('#f-account').value,
      fromAccount: type === 'transfer' ? $('#f-account').value : null,
      toAccount: type === 'transfer' ? $('#f-to-account').value : null,
      currency, rateToTWD,
      amountCents: Money.toCents(amountYuan),
      incomeSource: type === 'income' ? $('#f-income-source').value : null,
      essential: type === 'expense' ? $('#f-essential').checked : null,
      reimbursable: type === 'expense' ? $('#f-reimb').checked : null,
      status: type === 'wishlist' ? 'want' : 'realized',
      note: $('#f-note').value
    };
    ledger.entries.push(entry);
    IO.markDirty();
    $('#f-amount').value = '';
    $('#f-note').value = '';
    renderLedger();
  };

  const deleteEntry = (id) => {
    ledger.entries = ledger.entries.filter((e) => e.id !== id);
    IO.markDirty();
    renderLedger();
  };

  const renderLedgerList = () => {
    const body = $('#ledger-table-body');
    body.innerHTML = '';
    const sorted = [...ledger.entries].sort((a, b) => (a.date < b.date ? 1 : -1));
    for (const e of sorted) {
      const typeLabel = { expense: '支出', income: '收入', wishlist: '願望', transfer: '轉帳' }[e.type];
      const currency = e.currency || 'TWD';
      const twdEquivalent = (() => {
        try { return Money.toTWDCents(e.amountCents, e.currency, e.rateToTWD); }
        catch (err) { return null; }
      })();
      const amountCell = twdEquivalent !== null && currency !== 'TWD'
        ? el('td', {}, [
            el('div', { class: e.amountCents < 0 ? 'neg mono' : 'mono', text: Money.formatMoney(e.amountCents, currency) }),
            el('div', { class: 'mono notice', text: '≈ ' + Money.formatMoney(twdEquivalent, 'TWD') })
          ])
        : el('td', { class: e.amountCents < 0 ? 'neg mono' : 'mono', text: Money.formatMoney(e.amountCents, currency) });
      body.appendChild(el('tr', {}, [
        el('td', { text: e.date }),
        el('td', { text: typeLabel + (e.type === 'income' && e.incomeSource ? `（${e.incomeSource}）` : '') }),
        el('td', { text: e.type === 'transfer' ? `${accountName(e.fromAccount)} → ${accountName(e.toAccount)}` : ([e.category, e.account ? accountName(e.account) : null].filter(Boolean).join('／') || '—') }),
        amountCell,
        el('td', { text: e.type === 'expense' ? (e.essential ? '必要' : '非必要') : '—' }),
        el('td', { text: e.type === 'expense' ? (e.reimbursable ? '可報銷' : '—') : '—' }),
        el('td', { text: e.note || '' }),
        el('td', {}, [el('button', { class: 'btn small danger', text: '刪除', onclick: () => deleteEntry(e.id) })])
      ]));
    }
  };

  const renderLedgerSummary = () => {
    const box = $('#ledger-summary');
    box.innerHTML = '';
    const ledgerCheck = Validation.validateLedger(ledger);
    if (!ledgerCheck.valid) {
      box.append(el('h3', { class: 'neg', text: '帳本資料無法安全加總' }), el('ul', {}, ledgerCheck.errors.map(e => el('li', { class: 'neg', text: `${e.path}：${e.message}` }))));
      return;
    }

    // 換算成台幣後才能加總，避免不同幣別的原始金額直接相加（先前修正過的重點原則）
    const twd = (e) => { try { return Money.toTWDCents(e.amountCents, e.currency, e.rateToTWD); } catch (err) { return 0; } };

    const balancesById = getAccountBalances();
    const byAccount = Object.fromEntries(config.accountProfiles.map(a => [a.name, balancesById[a.id] || 0]));
    const byMonth = Money.groupSum(ledger.entries, (e) => e.date?.slice(0, 7), (e) => e.type !== 'wishlist' && e.type !== 'transfer' && e.status !== 'projected');
    const nonEssential = ledger.entries.filter((e) => e.type === 'expense' && e.essential === false)
      .reduce((s, e) => s + twd(e), 0);
    const reimbursable = ledger.entries.filter((e) => e.type === 'expense' && e.reimbursable)
      .reduce((s, e) => s + twd(e), 0);
    const income = ledger.entries.filter((e) => e.type === 'income').reduce((s, e) => s + twd(e), 0);
    const expense = ledger.entries.filter((e) => e.type === 'expense').reduce((s, e) => s + twd(e), 0);
    const available = income + expense;
    const savingsHealth = currentMonthSavingsHealth();
    const expenseAverages = Money.calcExpenseAverages(ledger.entries);

    const table = (title, obj, limits) => {
      const rows = Object.entries(obj).map(([k, v]) => {
        const limit = limits && limits[k];
        const over = limit !== undefined && Math.abs(v) > limit;
        return el('tr', {}, [
          el('td', { text: k }),
          el('td', { class: 'mono' + (over ? ' over' : ''), text: Money.formatTWD(v) }),
          el('td', { text: limit !== undefined ? Money.formatTWD(limit) : '—' })
        ]);
      });
      return el('div', { class: 'summary-block detail-only' }, [
        el('h3', { text: title }),
        el('table', {}, [el('tbody', {}, rows)])
      ]);
    };

    const byMonthExpense = Money.groupSum(ledger.entries, (e) => e.date?.slice(0, 7), (e) => e.type === 'expense');
    const byMonthSalary = Money.groupSum(ledger.entries, (e) => e.date?.slice(0, 7), (e) => e.type === 'income');
    const byYearIncome = Money.groupSum(ledger.entries, e => e.date?.slice(0, 4), e => e.type === 'income');
    const byYearExpense = Money.groupSum(ledger.entries, e => e.date?.slice(0, 4), e => e.type === 'expense');
    const years = [...new Set([...Object.keys(byYearIncome), ...Object.keys(byYearExpense)])].filter(Boolean).sort();
    const annualRows = years.map((year, index) => {
      const yearIncome = byYearIncome[year] || 0;
      const yearExpense = Math.abs(byYearExpense[year] || 0);
      const net = yearIncome - yearExpense;
      const previousYear = years[index - 1];
      const previousNet = previousYear ? (byYearIncome[previousYear] || 0) - Math.abs(byYearExpense[previousYear] || 0) : null;
      return el('tr', {}, [el('td', { text: year }), el('td', { class: 'mono', text: Money.formatTWD(yearIncome) }), el('td', { class: 'mono', text: Money.formatTWD(yearExpense) }), el('td', { class: `mono${net < 0 ? ' neg' : ''}`, text: Money.formatTWD(net) }), el('td', { class: `mono${previousNet !== null && net - previousNet < 0 ? ' neg' : ''}`, text: previousNet === null ? '—' : Money.formatTWD(net - previousNet) })]);
    });
    const annualBlock = el('details', { class: 'summary-block compact-settings detail-only' }, [el('summary', { text: '年度收支與淨現金流' }), annualRows.length ? el('div', { class: 'table-scroll' }, [el('table', {}, [el('thead', {}, [el('tr', {}, [el('th', { text: '年度' }), el('th', { text: '收入' }), el('th', { text: '支出' }), el('th', { text: '淨現金流' }), el('th', { text: '較前期' })])]), el('tbody', {}, annualRows)])]) : el('p', { class: 'notice', text: '尚無年度資料。' })]);
    const trendSVG = Money.buildTrendChartSVG(byMonthExpense, byMonthSalary);

    const trendBlock = el('div', { class: 'summary-block detail-only' }, [
      el('h3', { text: '趨勢總覽（紅色長條＝月支出，綠線＝月收入）' })
    ]);
    const trendChartHolder = el('div', {});
    trendChartHolder.innerHTML = trendSVG;
    trendBlock.appendChild(trendChartHolder);
    const expenseAverageBlock = el('div', { class: 'summary-block detail-only' }, [
      el('h3', { text: `分類花費分析・平均 ${expenseAverages.monthCount} 個月` }),
      el('p', { class: 'notice', text: '平均月份從第一筆支出到最後一筆支出連續計算，包含期間內沒有消費的月份；占比以全部支出為分母。' }),
      expenseAverages.rows.length ? el('div', { class: 'table-scroll' }, [el('table', {}, [
        el('thead', {}, [el('tr', {}, [el('th', { text: '分類' }), el('th', { text: '累計花費' }), el('th', { text: '平均每月' }), el('th', { text: '占全部支出' }), el('th', { text: '月預算上限' })])]),
        el('tbody', {}, expenseAverages.rows.map(row => {
          const limit = config.budgetLimitsCents[row.label];
          const over = limit !== undefined && row.monthlyAverageCents > limit;
          return el('tr', {}, [el('td', { text: row.label }), el('td', { class: 'mono', text: Money.formatTWD(row.totalCents) }), el('td', { class: `mono${over ? ' over' : ''}`, text: Money.formatTWD(row.monthlyAverageCents) }), el('td', { class: 'mono', text: `${(row.share * 100).toFixed(1)}%` }), el('td', { class: 'mono', text: limit !== undefined ? Money.formatTWD(limit) : '—' })]);
        }))
      ])]) : el('p', { class: 'notice', text: '尚無支出資料。' })
    ]);

    box.append(
      el('div', { class: 'health-grid' }, [
        el('div', { class: 'summary-block highlight' }, [el('h3', { text: '本月實際儲蓄' }), el('p', { class: 'mono big', text: Money.formatTWD(savingsHealth.actualSavingsCents) })]),
        el('div', { class: 'summary-block highlight' }, [el('h3', { text: '本月儲蓄率' }), el('p', { class: 'mono big', text: savingsHealth.actualSavingsRate === null ? '尚無收入' : `${(savingsHealth.actualSavingsRate * 100).toFixed(1)}%` }), el('p', { class: `notice health-${savingsHealth.health.level}`, text: savingsHealth.health.label })]),
        el('div', { class: 'summary-block highlight' }, [el('h3', { text: '月儲蓄達成率' }), el('p', { class: 'mono big', text: savingsHealth.attainmentRate === null ? '—' : `${Math.max(0, savingsHealth.attainmentRate * 100).toFixed(0)}%` }), el('p', { class: 'notice', text: `應儲蓄 ${Money.formatTWD(savingsHealth.recommendedSavingCents)}` })])
      ]),
      el('div', { class: 'summary-block highlight' }, [
        el('h3', { text: '總覽' }),
        el('p', {}, [document.createTextNode('可動用資金：'), el('span', { class: 'mono big', text: Money.formatTWD(available) })]),
        el('p', {}, [document.createTextNode('非必要支出總額：'), el('span', { class: 'mono', text: Money.formatTWD(nonEssential) })]),
        el('p', {}, [document.createTextNode('可報銷總額：'), el('span', { class: 'mono', text: Money.formatTWD(reimbursable) })])
      ]),
      expenseAverageBlock,
      table('各帳戶目前餘額（起始餘額 ＋ 收入 − 支出）', byAccount, null),
      table('月度彙總', byMonth, null),
      annualBlock,
      trendBlock
    );
  };

  const renderPersonalSettings = () => {
    const box = $('#personal-settings');
    if (!box) return;
    ensureAccountProfiles();
    box.innerHTML = '';
    const numField = (label, value, onchange) => numberField(label, value, onchange, 'field');
    const accountRows = config.accountProfiles.map((account) => {
      const used = ledger.entries.some(e => e.account === account.id || e.account === account.name || e.fromAccount === account.id || e.toAccount === account.id) || (config.recurringCashFlows || []).some(f => f.accountId === account.id || f.fromAccountId === account.id);
      return el('div', { class: 'toolbar account-row' }, [
        el('div', { class: 'field' }, [el('label', { text: '帳戶名稱' }), el('input', { value: account.name, onchange: (ev) => { const name = ev.target.value.trim(); if (name) { account.name = name; IO.markDirty(); renderLedgerForm(); renderLedger(); } } })]),
        el('div', { class: 'field' }, [el('label', { text: '性質' }), el('select', { onchange: (ev) => { account.nature = ev.target.value; IO.markDirty(); renderAll(); } }, Object.entries(natureLabels()).map(([value, text]) => el('option', { value, text, selected: account.nature === value ? 'selected' : undefined })))]),
        numField('起始餘額（元）', Money.toYuan(account.initialBalanceCents || 0), (v) => { account.initialBalanceCents = Money.toCents(v); IO.markDirty(); renderLedger(); }),
        el('label', {}, [el('input', { type: 'checkbox', checked: account.linkRecurring !== false ? 'checked' : undefined, onchange: (ev) => { account.linkRecurring = ev.target.checked; materializeDueRecurringEntries(); IO.markDirty(); renderAll(); } }), document.createTextNode(' 連動固定收支')]),
        el('button', { class: 'btn small danger', text: used ? '已有紀錄' : '刪除', disabled: used ? 'disabled' : undefined, onclick: () => { config.accountProfiles = config.accountProfiles.filter(a => a.id !== account.id); IO.markDirty(); renderPersonalSettings(); renderLedgerForm(); renderLedger(); } })
      ]);
    });
    const accountManager = el('details', {}, [
      el('summary', { text: '帳戶管理（名稱、性質、起始餘額）' }),
      ...accountRows,
      el('button', { class: 'btn small', text: '＋新增帳戶', onclick: () => { config.accountProfiles.push({ id: createEntryId(), name: `新帳戶 ${config.accountProfiles.length + 1}`, nature: 'checking', initialBalanceCents: 0 }); IO.markDirty(); renderPersonalSettings(); renderLedgerForm(); renderLedger(); } }),
      el('details', { class: 'flow-sub' }, [
        el('summary', { text: '自訂帳戶性質' }),
        ...(config.customAccountNatures || []).map((n) => {
          const inUse = config.accountProfiles.some(a => a.nature === n.id);
          return el('div', { class: 'toolbar' }, [
            el('div', { class: 'field' }, [el('label', { text: '性質名稱' }), el('input', { value: n.label || '', placeholder: '例如：旅遊基金', onchange: (ev) => { n.label = ev.target.value.trim(); IO.markDirty(); renderAll(); } })]),
            el('label', {}, [el('input', { type: 'checkbox', checked: n.liquid !== false ? 'checked' : undefined, onchange: (ev) => { n.liquid = ev.target.checked; IO.markDirty(); renderAll(); } }), document.createTextNode(' 算可動用資金')]),
            el('button', { class: 'btn small danger', text: inUse ? '使用中' : '刪除', disabled: inUse ? 'disabled' : undefined, onclick: () => { config.customAccountNatures = config.customAccountNatures.filter(x => x.id !== n.id); IO.markDirty(); renderPersonalSettings(); } })
          ]);
        }),
        el('button', { class: 'btn small', text: '＋自訂性質', onclick: () => { if (!Array.isArray(config.customAccountNatures)) config.customAccountNatures = []; config.customAccountNatures.push({ id: `custom-${createEntryId()}`, label: '', liquid: true }); IO.markDirty(); renderPersonalSettings(); } })
      ]),
      el('p', { class: 'notice', text: '收入與支出都會計入指定帳戶；已有交易的帳戶不可直接刪除，以免餘額失去歸屬。關閉「連動固定收支」的帳戶不會出現在固定項目的帳戶選單，掛在上面的固定項目也不計入每月總額。' })
    ]);
    if (!Array.isArray(config.recurringCashFlows)) config.recurringCashFlows = [];
    // 收入的 amountCents／monthlyWorkHours 由計薪方式推得後寫回，帳本、健檢與工時反推都沿用同一數字
    const syncIncomeFlow = (flow) => {
      if (flow.type === 'expense' && flow.housing) {
        flow.amountCents = Money.calcHousing(flow.housing).monthlyCents;
        const startDay = Number(/^\d{4}-\d{2}-(\d{2})$/.exec(flow.housing.contractStart || '')?.[1]);
        if (startDay) flow.dayOfMonth = startDay;
        return;
      }
      if (flow.type !== 'income') return;
      const income = Money.deriveIncome(flow);
      flow.amountCents = income.grossCents;
      flow.monthlyWorkHours = income.monthlyWorkHours;
    };
    const saveFlow = () => { config.recurringCashFlows.forEach(syncIncomeFlow); materializeDueRecurringEntries(); IO.markDirty(); renderPersonalSettings(); renderLedger(); };
    const flowTypeSelect = (flow) => el('div', { class: 'field' }, [el('label', { text: '類型' }), el('select', { onchange: (ev) => { flow.type = ev.target.value; flow.kind = flow.type === 'income' ? 'salary' : (flow.type === 'saving' ? 'fixed_saving' : 'fixed_expense'); saveFlow(); } }, [el('option', { value: 'income', text: '固定收入', selected: flow.type === 'income' ? 'selected' : undefined }), el('option', { value: 'expense', text: '固定支出', selected: flow.type === 'expense' ? 'selected' : undefined }), el('option', { value: 'saving', text: '固定儲蓄', selected: flow.type === 'saving' ? 'selected' : undefined })])]);
    const accountSelect = (flow, label) => el('div', { class: 'field' }, [el('label', { text: label }), el('select', { onchange: (ev) => { flow.accountId = ev.target.value; saveFlow(); } }, config.accountProfiles.filter(a => a.linkRecurring !== false || a.id === flow.accountId).map(a => el('option', { value: a.id, text: a.linkRecurring === false ? `${a.name}（未連動）` : a.name, selected: flow.accountId === a.id ? 'selected' : undefined, disabled: flow.type === 'saving' && a.id === flow.fromAccountId ? 'disabled' : undefined })))]);
    // 大字、附單位與說明的數字欄位，給收入卡片用（長者也能一眼看懂要填什麼）
    const incomeField = (label, unit, value, onchange, hint, step = 'any') => el('div', { class: 'field income-field' }, [
      el('label', { text: label }),
      el('div', { class: 'input-unit' }, [
        el('input', { type: 'number', inputmode: 'decimal', min: '0', step, class: 'mono', value, onchange: (ev) => { const v = Number(ev.target.value); if (!(v >= 0)) return alert('請輸入 0 或以上的數字'); onchange(step === '1' ? Math.round(v) : v); } }),
        el('span', { text: unit })
      ]),
      hint ? el('small', { text: hint }) : null
    ]);
    const payBasisOptions = {
      monthly: { label: '固定月薪', hint: '每月領差不多的薪水', kind: 'salary' },
      hourly: { label: '按時薪計算', hint: '時薪固定，每月工時不同', kind: 'part_time' },
      per_case: { label: '按件接案', hint: '每月接的案件數不同', kind: 'freelance' }
    };
    const switchPayBasis = (flow, basis) => {
      const prev = Money.deriveIncome(flow);
      // 收入分類仍是預設值時跟著換，使用者自己改過就不動
      if (flow.kind === payBasisOptions[prev.payBasis].kind) flow.kind = payBasisOptions[basis].kind;
      flow.payBasis = basis;
      if (!(flow.hourlyRateCents > 0)) flow.hourlyRateCents = prev.hourlyRateCents;
      if (basis === 'per_case') {
        if (!(flow.hoursPerCase > 0)) flow.hoursPerCase = 1;
        if (!(flow.caseCount >= 0)) flow.caseCount = 1;
        if (!flow.caseFeeMode) flow.caseFeeMode = 'hourly';
      }
      if (basis === 'monthly' && prev.payBasis !== 'monthly') flow.amountCents = prev.grossCents;
      // 時薪與接案收入每月變動，但勞健保依固定的投保級距扣，切換時預設改成固定級距
      if (basis !== 'monthly' && flow.insuredSalaryFollowsGross !== false) {
        flow.insuredSalaryFollowsGross = false;
        if (!(flow.insuredSalaryCents > 0)) flow.insuredSalaryCents = prev.grossCents;
      }
      saveFlow();
    };
    // 每個固定項目收合成一行重點（名稱、方式、每月金額），要改才展開；展開狀態由 data-collapse-id 記住
    const flowCard = (flow, summaryChildren, body) => {
      const linked = flowLinked(flow);
      return el('details', { class: 'card flow-card', 'data-collapse-id': `flow-${flow.id}` }, [
        el('summary', { class: 'flow-summary' }, [...summaryChildren, linked ? null : el('span', { class: 'flow-tag warn', text: '帳戶未連動・不計入' })]),
        el('div', { class: 'flow-body' }, [linked ? null : el('p', { class: 'linked-note', text: '指定的帳戶已關閉「連動固定收支」，本項目不計入每月總額與帳本預測；改選其他帳戶或到帳戶管理重新開啟即可。' }), ...body])
      ]);
    };
    const openFlowCard = (id) => { expandedDetailKeys.add(`panel-ledger｜flow-${id}`); };
    const rentCycleNames = { 1: '每月', 2: '每兩個月', 3: '每季', 6: '每半年', 12: '每年' };
    const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const dateField = (label, value, onchange) => el('div', { class: 'field' }, [el('label', { text: label }), el('input', { type: 'date', value: value || '', onchange: (ev) => onchange(ev.target.value) })]);
    const housingFeePresets = ['管理費', '網路費', '水費', '清潔費', '其他'];
    const housingCard = (flow) => {
      const h = flow.housing;
      if (!Array.isArray(h.fees)) h.fees = [];
      if (!h.electricity || typeof h.electricity !== 'object') h.electricity = { enabled: false };
      if (!h.subsidy || typeof h.subsidy !== 'object') h.subsidy = { enabled: false };
      const sub = h.subsidy;
      const monthField = (label, value, onchange) => el('div', { class: 'field' }, [el('label', { text: label }), el('input', { type: 'month', value: value || '', onchange: (ev) => onchange(Validation.isValidMonth(ev.target.value) ? ev.target.value : '') })]);
      const e = h.electricity;
      const r = Money.calcHousing(h);
      const yuan = (cents) => Money.formatTWD(cents);
      const kwh = (v) => `${Math.round(v).toLocaleString()} 度`;
      const schedule = Money.housingPaymentSchedule(h, localToday(), 6);
      const next = schedule[0];
      const elecBody = e.enabled ? [
        el('div', { class: 'toolbar' }, [
          numField('每度電費（元）', Money.toYuan(e.rateCentsPerKwh || 0), (v) => { e.rateCentsPerKwh = Math.max(0, Math.round(v * 100)); saveFlow(); }),
          dateField('上次結清日（抄表日）', e.lastReadingDate, (v) => { e.lastReadingDate = v; saveFlow(); }),
          numField('上次結清度數', e.lastReading || 0, (v) => { e.lastReading = Math.max(0, v); saveFlow(); }),
          numField('目前電表度數', e.currentReading || 0, (v) => { e.currentReading = Math.max(0, v); if (!e.currentReadingDate) e.currentReadingDate = localToday(); saveFlow(); }),
          dateField('抄表日', e.currentReadingDate, (v) => { e.currentReadingDate = v; saveFlow(); }),
          !r.electricity.measured ? numField('沒抄表時：每月約幾度', e.fallbackMonthlyKwh || 0, (v) => { e.fallbackMonthlyKwh = Math.max(0, v); saveFlow(); }) : null
        ]),
        el('p', { class: 'flow-result' }, [
          r.electricity.measured ? document.createTextNode(`已用 ${kwh(r.electricity.usedKwh)}／${r.electricity.days} 天（約 ${yuan(r.electricity.usedSoFarCents)}）；`) : null,
          document.createTextNode(`每月平均 ${kwh(r.electricity.monthlyKwh)} ≈ ${yuan(r.electricity.monthlyCents)}`),
          r.electricity.nextSettleDate ? document.createTextNode(`；預計 ${r.electricity.nextSettleDate} 隨房租結清 ${kwh(r.electricity.projectedKwh)}，約 ${yuan(r.electricity.projectedBillCents)}`) : null
        ])
      ] : [];
      const feeRows = h.fees.map((fee, i) => el('div', { class: 'toolbar fee-row' }, [
        el('div', { class: 'field' }, [el('label', { text: '費用名稱' }), el('input', { value: fee.name || '', onchange: (ev) => { fee.name = ev.target.value.trim(); saveFlow(); } })]),
        numField('每月金額（元）', Money.toYuan(fee.amountCents || 0), (v) => { fee.amountCents = Money.toCents(Math.max(0, v)); saveFlow(); }),
        el('label', {}, [el('input', { type: 'checkbox', checked: fee.perPerson ? 'checked' : undefined, onchange: (ev) => { fee.perPerson = ev.target.checked; saveFlow(); } }), document.createTextNode(' 每人一份')]),
        el('span', { class: 'mono', text: `＝${yuan(r.fees[i].monthlyCents)}／月` }),
        el('button', { class: 'btn small danger', text: '刪除', onclick: () => { h.fees.splice(i, 1); saveFlow(); } })
      ]));
      return flowCard(flow, [
        el('span', { class: 'flow-name', text: flow.name || '租屋' }),
        el('span', { class: 'flow-tag', text: `${rentCycleNames[r.cycle]}繳` }),
        el('span', { class: 'flow-amount negative mono', text: flow.active === false ? '未啟用' : `－${yuan(r.monthlyCents)}／月` }),
        next ? el('span', { class: 'flow-next', text: `下次 ${next.date} 繳 ${yuan(next.cents)}` }) : null
      ], [
        el('div', { class: 'toolbar' }, [
          el('label', {}, [el('input', { type: 'checkbox', checked: flow.active !== false ? 'checked' : undefined, onchange: (ev) => { flow.active = ev.target.checked; saveFlow(); } }), document.createTextNode(' 啟用')]),
          el('div', { class: 'field' }, [el('label', { text: '名稱' }), el('input', { value: flow.name || '', onchange: (ev) => { flow.name = ev.target.value.trim(); saveFlow(); } })]),
          numField('月租（元）', Money.toYuan(h.rentCents || 0), (v) => { h.rentCents = Money.toCents(Math.max(0, v)); saveFlow(); }),
          el('div', { class: 'field' }, [el('label', { text: '繳租方式' }), el('select', { onchange: (ev) => { h.payCycleMonths = Number(ev.target.value); saveFlow(); } }, Money.RENT_CYCLES.map(n => el('option', { value: n, text: `${rentCycleNames[n]}繳`, selected: r.cycle === n ? 'selected' : undefined })))]),
          dateField('簽約起租日', h.contractStart, (v) => { h.contractStart = v; saveFlow(); }),
          dateField('租約到期日（可空）', h.contractEnd, (v) => { h.contractEnd = v; saveFlow(); }),
          numField('同住人數', r.occupants, (v) => { h.occupants = Math.max(1, Math.trunc(v)); saveFlow(); })
        ]),
        el('div', { class: 'flow-result' }, [
          el('p', { text: `每月平均 ${yuan(r.monthlyCents)} ＝ 房租 ${yuan(r.rentCents)} ＋ 其他費用 ${yuan(r.feesCents)} ＋ 電費 ${yuan(r.electricity.monthlyCents)}${r.subsidyCents ? ` － 租屋補助 ${yuan(r.subsidyCents)}` : ''}` }),
          el('p', { text: `房租、其他費用、電費同一天繳：每次 ＝ (房租＋其他費用) × ${r.cycle} 個月＋該期電費` }),
          schedule.length
            ? el('div', { class: 'pay-schedule' }, schedule.map(p => el('span', { class: 'pay-chip mono', text: `${p.date}　${yuan(p.cents)}` })))
            : el('p', { class: 'notice', text: h.contractStart ? '租約期間內已無繳款日。' : '填入簽約起租日，就會列出接下來的繳款日。' })
        ]),
        el('details', { class: 'flow-sub' }, [
          el('summary', { text: `電費${e.enabled ? `：每月約 ${yuan(r.electricity.monthlyCents)}` : '（未計入）'}` }),
          el('label', {}, [el('input', { type: 'checkbox', checked: e.enabled ? 'checked' : undefined, onchange: (ev) => { e.enabled = ev.target.checked; saveFlow(); } }), document.createTextNode(' 計入電費（依電表度數推估）')]),
          ...elecBody
        ]),
        el('details', { class: 'flow-sub' }, [
          el('summary', { text: !sub.enabled ? '租屋補助（未申請）' : sub.includeInCalc === false ? '租屋補助：已填寫，未納入計算' : `租屋補助：${r.subsidyCents ? `本月 ＋${yuan(r.subsidyCents)}` : '本月不在核定期間'}` }),
          el('label', {}, [el('input', { type: 'checkbox', checked: sub.enabled ? 'checked' : undefined, onchange: (ev) => { sub.enabled = ev.target.checked; if (sub.enabled && !sub.startMonth) sub.startMonth = localToday().slice(0, 7); if (sub.enabled && sub.includeInCalc === undefined) sub.includeInCalc = true; saveFlow(); } }), document.createTextNode(' 有領租屋補助')]),
          sub.enabled ? el('label', {}, [el('input', { type: 'checkbox', checked: sub.includeInCalc !== false ? 'checked' : undefined, onchange: (ev) => { sub.includeInCalc = ev.target.checked; saveFlow(); } }), document.createTextNode(' 納入計算（扣入每月平均並記入帳本）')]) : null,
          sub.enabled ? el('div', { class: 'toolbar' }, [
            numField('每月補助（元）', Money.toYuan(sub.amountCents || 0), (v) => { sub.amountCents = Money.toCents(Math.max(0, v)); saveFlow(); }),
            monthField('核定起始月', sub.startMonth, (v) => { sub.startMonth = v; saveFlow(); }),
            monthField('核定結束月（可空）', sub.endMonth, (v) => { sub.endMonth = v; saveFlow(); }),
            numField('每月幾號撥款', sub.dayOfMonth || 1, (v) => { sub.dayOfMonth = Math.min(31, Math.max(1, Math.trunc(v))); saveFlow(); })
          ]) : null,
          sub.enabled ? el('p', { class: 'notice', text: '補助撥到自己的帳戶，不從房租扣；金額與期間請依核定通知填寫，到期續辦後更新結束月。' }) : null
        ]),
        el('details', { class: 'flow-sub' }, [
          el('summary', { text: `其他費用${h.fees.length ? `：每月 ${yuan(r.feesCents)}` : '（管理費、網路費…）'}` }),
          ...feeRows,
          el('div', { class: 'toolbar' }, housingFeePresets.map(name => el('button', { class: 'btn small', text: `＋${name}`, onclick: () => { h.fees.push({ id: createEntryId(), name: name === '其他' ? '' : name, amountCents: 0, perPerson: false }); saveFlow(); } })))
        ]),
        el('div', { class: 'toolbar' }, [
          accountSelect(flow, '扣款帳戶'),
          el('button', { class: 'btn small danger', text: '刪除租屋', onclick: () => { config.recurringCashFlows = config.recurringCashFlows.filter(f => f.id !== flow.id); IO.markDirty(); renderPersonalSettings(); } })
        ])
      ]);
    };
    const incomeCard = (flow) => {
      const summaryItem = recurringSummary().items.find(x => x.id === flow.id);
      const income = Money.deriveIncome(flow);
      const basis = income.payBasis;
      const yuan = (cents) => Money.formatTWD(cents);
      const hoursText = (h) => `${Math.round(h).toLocaleString()} 小時`;
      const basisPicker = el('div', { class: 'basis-picker', role: 'radiogroup', 'aria-label': '計薪方式' }, Object.entries(payBasisOptions).map(([value, opt]) => el('label', { class: `basis-option${basis === value ? ' active' : ''}` }, [
        el('input', { type: 'radio', name: `pay-basis-${flow.id}`, value, checked: basis === value ? 'checked' : undefined, onchange: () => switchPayBasis(flow, value) }),
        el('strong', { text: opt.label }),
        el('span', { text: opt.hint })
      ])));
      const basisFields = basis === 'hourly' ? [
        incomeField('時薪', '元／小時', Money.toYuan(flow.hourlyRateCents || 0), (v) => { flow.hourlyRateCents = Money.toCents(v); saveFlow(); }),
        incomeField('這個月工作時數', '小時', flow.monthlyWorkHours || 0, (v) => { flow.monthlyWorkHours = v; saveFlow(); }, '每月更新', '1')
      ] : basis === 'per_case' ? [
        incomeField('這個月接幾件', '件', flow.caseCount || 0, (v) => { flow.caseCount = v; saveFlow(); }, '每月更新', '1'),
        incomeField('每件大約花幾小時', '小時', flow.hoursPerCase || 1, (v) => { if (!(v > 0)) return alert('每件時數必須大於 0'); flow.hoursPerCase = v; saveFlow(); }, null, '1'),
        el('div', { class: 'field income-field' }, [
          el('label', { text: '案件怎麼計價' }),
          el('select', { onchange: (ev) => { flow.caseFeeMode = ev.target.value; if (flow.caseFeeMode === 'fixed' && !(flow.caseFeeCents > 0)) flow.caseFeeCents = income.caseFeeCents; saveFlow(); } }, [
            el('option', { value: 'hourly', text: '按案件時薪 × 時數', selected: flow.caseFeeMode !== 'fixed' ? 'selected' : undefined }),
            el('option', { value: 'fixed', text: '每件固定價格', selected: flow.caseFeeMode === 'fixed' ? 'selected' : undefined })
          ])
        ]),
        flow.caseFeeMode === 'fixed'
          ? incomeField('每件報酬', '元／件', Money.toYuan(flow.caseFeeCents || 0), (v) => { flow.caseFeeCents = Money.toCents(v); saveFlow(); }, '稅前')
          : incomeField('案件時薪', '元／小時', Money.toYuan(flow.hourlyRateCents || 0), (v) => { flow.hourlyRateCents = Money.toCents(v); saveFlow(); })
      ] : [
        incomeField('每月薪資（稅前）', '元', Money.toYuan(flow.amountCents || 0), (v) => { flow.amountCents = Money.toCents(v); saveFlow(); }, null),
        incomeField('每月大約工作時數', '小時', flow.monthlyWorkHours || 160, (v) => { if (!(v > 0)) return alert('月工時必須大於 0'); flow.monthlyWorkHours = v; saveFlow(); }, '換算時薪用', '1')
      ];
      const formula = basis === 'hourly'
        ? `時薪 ${yuan(income.hourlyRateCents)} × ${hoursText(income.monthlyWorkHours)} ＝ 本月稅前 ${yuan(income.grossCents)}`
        : basis === 'per_case'
          ? `每件 ${yuan(income.caseFeeCents)}${flow.caseFeeMode === 'fixed' ? '' : `（${yuan(income.hourlyRateCents)} × ${hoursText(income.hoursPerCase)}）`} × ${Math.round(income.caseCount).toLocaleString()} 件 ＝ 本月稅前 ${yuan(income.grossCents)}`
          : `月薪 ${yuan(income.grossCents)} ÷ ${hoursText(income.monthlyWorkHours)} ＝ 時薪約 ${yuan(income.hourlyRateCents)}`;
      const payroll = summaryItem?.payroll;
      const result = el('div', { class: 'income-result', 'aria-live': 'polite' }, [
        el('p', { class: 'income-formula', text: formula }),
        summaryItem ? el('p', { class: 'income-net' }, [
          document.createTextNode('每月實際入帳約 '),
          el('strong', { class: 'mono', text: yuan(summaryItem.netCents) })
        ]) : el('p', { class: 'income-net', text: '目前不計入每月收入' }),
        payroll && payroll.laborFee + payroll.healthFee > 0 ? el('p', { class: 'income-sub', text: `已扣勞保 ${yuan(payroll.laborFee)}、健保 ${yuan(payroll.healthFee)}（依投保薪資 ${yuan(payroll.insuredSalaryCents)}）` }) : null,
        basis !== 'monthly' && income.monthlyWorkHours > 0 ? el('p', { class: 'income-sub', text: `本月共工作 ${hoursText(income.monthlyWorkHours)}，實際時薪 ${yuan(income.hourlyRateCents)}` }) : null
      ]);
      const fixedBracket = flow.insuredSalaryFollowsGross === false;
      const insurance = el('div', { class: 'flow-sub' }, [
        el('label', { class: 'big-check' }, [el('input', { type: 'checkbox', checked: flow.applyInsurance ? 'checked' : undefined, onchange: (ev) => { flow.applyInsurance = ev.target.checked; saveFlow(); } }), document.createTextNode(' 從薪水扣勞健保')]),
        flow.applyInsurance ? el('div', { class: 'bracket-choice' }, [
          el('label', { class: 'big-check' }, [el('input', { type: 'radio', name: `bracket-${flow.id}`, checked: fixedBracket ? 'checked' : undefined, onchange: () => { flow.insuredSalaryFollowsGross = false; if (!(flow.insuredSalaryCents > 0)) flow.insuredSalaryCents = income.grossCents; saveFlow(); } }), document.createTextNode(' 固定投保級距')]),
          el('label', { class: 'big-check' }, [el('input', { type: 'radio', name: `bracket-${flow.id}`, checked: fixedBracket ? undefined : 'checked', onchange: () => { flow.insuredSalaryFollowsGross = true; saveFlow(); } }), document.createTextNode(' 跟著收入變動')]),
          fixedBracket ? incomeField('投保薪資級距', '元', Money.toYuan(flow.insuredSalaryCents || income.grossCents), (v) => { flow.insuredSalaryCents = Money.toCents(v); saveFlow(); }, '薪資單上的投保薪資') : null
        ]) : null,
        el('p', { class: 'income-hint', text: flow.applyInsurance
          ? '勞健保依投保級距扣，不隨當月收入變動。'
          : (basis === 'per_case' ? '接案多自行在工會投保，不從案件款扣。' : '不扣時，入帳 ＝ 稅前收入。') })
      ]);
      return flowCard(flow, [
        el('span', { class: 'flow-name', text: flow.name || recurringKinds[flow.kind] || '收入' }),
        el('span', { class: 'flow-tag', text: payBasisOptions[basis].label }),
        el('span', { class: 'flow-amount positive mono', text: flow.active === false ? '未啟用' : `＋${yuan(summaryItem?.netCents || 0)}／月` })
      ], [
        el('div', { class: 'toolbar' }, [
          el('label', {}, [el('input', { type: 'checkbox', checked: flow.active !== false ? 'checked' : undefined, onchange: (ev) => { flow.active = ev.target.checked; saveFlow(); } }), document.createTextNode(' 啟用')]),
          el('div', { class: 'field' }, [el('label', { text: '收入名稱' }), el('input', { value: flow.name || '', placeholder: '例如：超商兼職', onchange: (ev) => { flow.name = ev.target.value.trim(); saveFlow(); } })]),
          flowTypeSelect(flow)
        ]),
        basisPicker,
        el('div', { class: 'income-fields' }, basisFields),
        result,
        insurance,
        el('details', { class: 'flow-sub' }, [
          el('summary', { text: '入帳日期、帳戶與分類' }),
          el('div', { class: 'toolbar' }, [
            numField('每月幾號入帳', flow.dayOfMonth || 1, (v) => { flow.dayOfMonth = Math.min(31, Math.max(1, Math.trunc(v))); saveFlow(); }),
            accountSelect(flow, '入帳帳戶'),
            el('div', { class: 'field' }, [el('label', { text: '收入分類（記帳用）' }), el('select', { onchange: (ev) => { flow.kind = ev.target.value; saveFlow(); } }, Object.entries(recurringKinds).filter(([k]) => k !== 'fixed_expense').map(([value, text]) => el('option', { value, text, selected: flow.kind === value ? 'selected' : undefined })))])
          ])
        ]),
        el('button', { class: 'btn small danger', text: '刪除這份收入', onclick: () => { config.recurringCashFlows = config.recurringCashFlows.filter(f => f.id !== flow.id); IO.markDirty(); renderPersonalSettings(); } })
      ]);
    };
    const flowRows = config.recurringCashFlows.map(flow => {
      if (flow.type === 'income') return incomeCard(flow);
      if (flow.type === 'expense' && flow.housing) return housingCard(flow);
      const isSaving = flow.type === 'saving';
      // 學貸／房貸由貸款設定管理，固定每月繳；其他固定支出可跟房租一樣選繳款週期
      const canCycle = flow.type === 'expense' && !flow.systemManaged;
      const cycle = canCycle ? Money.flowPayCycle(flow) : 1;
      return flowCard(flow, [
        el('span', { class: 'flow-name', text: flow.name || (isSaving ? '固定儲蓄' : '固定支出') }),
        el('span', { class: 'flow-tag', text: isSaving ? `每月轉存 ${flow.dayOfMonth || 1} 日` : `${rentCycleNames[cycle]}扣款 ${flow.dayOfMonth || 1} 日${cycle > 1 ? `・每次 ${Money.formatTWD((flow.amountCents || 0) * cycle)}` : ''}` }),
        el('span', { class: `flow-amount mono${isSaving ? '' : ' negative'}`, text: flow.active === false ? '未啟用' : `${isSaving ? '' : '－'}${Money.formatTWD(flow.amountCents || 0)}／月` })
      ], [
        el('div', { class: 'toolbar' }, [
          el('label', {}, [el('input', { type: 'checkbox', checked: flow.active !== false ? 'checked' : undefined, disabled: flow.systemManaged ? 'disabled' : undefined, onchange: (ev) => { flow.active = ev.target.checked; saveFlow(); } }), document.createTextNode(flow.systemManaged ? ' 依年齡自動啟用' : ' 啟用')]),
          el('div', { class: 'field' }, [el('label', { text: '名稱' }), el('input', { value: flow.name || '', disabled: flow.systemManaged ? 'disabled' : undefined, onchange: (ev) => { flow.name = ev.target.value.trim(); saveFlow(); } })]),
          flowTypeSelect(flow),
          numField(isSaving ? '每月儲蓄（元）' : (cycle > 1 ? `每月金額（元，每次繳 ${cycle} 個月）` : '每月金額（元）'), Money.toYuan(flow.amountCents || 0), (v) => { flow.amountCents = Money.toCents(Math.abs(v)); saveFlow(); }),
          canCycle ? el('div', { class: 'field' }, [el('label', { text: '繳款方式' }), el('select', { onchange: (ev) => { flow.payCycleMonths = Number(ev.target.value); if (flow.payCycleMonths > 1 && !Validation.isValidMonth(flow.payStartMonth)) flow.payStartMonth = localToday().slice(0, 7); saveFlow(); } }, Money.RENT_CYCLES.map(n => el('option', { value: n, text: `${rentCycleNames[n]}繳`, selected: cycle === n ? 'selected' : undefined })))]) : null,
          canCycle && cycle > 1 ? el('div', { class: 'field' }, [el('label', { text: '首次繳款月份' }), el('input', { type: 'month', value: flow.payStartMonth || '', onchange: (ev) => { if (Validation.isValidMonth(ev.target.value)) { flow.payStartMonth = ev.target.value; saveFlow(); } } })]) : null,
          numField(isSaving ? '轉存日' : '扣款日', flow.dayOfMonth || 1, (v) => { flow.dayOfMonth = Math.min(31, Math.max(1, Math.trunc(v))); saveFlow(); }),
          isSaving ? el('div', { class: 'field' }, [el('label', { text: '轉出帳戶' }), el('select', { onchange: (ev) => { flow.fromAccountId = ev.target.value; saveFlow(); } }, config.accountProfiles.filter(a => a.linkRecurring !== false || a.id === flow.fromAccountId).map(a => el('option', { value: a.id, text: a.linkRecurring === false ? `${a.name}（未連動）` : a.name, selected: flow.fromAccountId === a.id ? 'selected' : undefined, disabled: a.id === flow.accountId ? 'disabled' : undefined })))]) : null,
          accountSelect(flow, isSaving ? '儲蓄帳戶' : '扣款帳戶')
        ]),
        isSaving ? el('p', { class: 'linked-note', text: '固定儲蓄會建立帳戶間轉帳，不列入收入或支出。' }) : el('label', {}, [el('input', { type: 'checkbox', checked: flow.essential !== false ? 'checked' : undefined, onchange: (ev) => { flow.essential = ev.target.checked; saveFlow(); } }), document.createTextNode(' 必要固定支出')]),
        el('button', { class: 'btn small danger', text: flow.systemManaged ? `由${flow.systemManaged === 'mortgage' ? '房貸' : '學貸'}設定管理` : '刪除固定項目', disabled: flow.systemManaged ? 'disabled' : undefined, onclick: () => { config.recurringCashFlows = config.recurringCashFlows.filter(f => f.id !== flow.id); IO.markDirty(); renderPersonalSettings(); } })
      ]);
    });
    const monthly = recurringSummary();
    const binding = IO.getBindingInfo();
    const fileBindingManager = el('details', {}, [
      el('summary', { text: '保存與工作區檔案綁定' }),
      el('div', { class: 'toolbar file-binding-row' }, [
        el('span', { class: 'file-binding-name', text: binding.name ? `目前綁定：${binding.name}` : '目前未綁定實體檔案' }),
        el('button', { class: 'btn small', text: binding.name ? '改綁其他檔案' : '綁定／建立工作區檔案', disabled: binding.supported ? undefined : 'disabled', onclick: async () => {
          try { await IO.bindWorkspaceFile(); renderPersonalSettings(); }
          catch (err) { if (err.name !== 'AbortError') alert(err.message); }
        } }),
        binding.name ? el('button', { class: 'btn small', text: '立即同步', onclick: async () => { await IO.saveBoundFile({ requestPermission: true }); } }) : null,
        binding.name ? el('button', { class: 'btn small danger', text: '解除綁定', onclick: async () => { await IO.unbindWorkspaceFile(); renderPersonalSettings(); } }) : null
      ]),
      el('p', { class: 'notice', text: binding.supported ? '每次修改會立即保存到瀏覽器本機並同步綁定 JSON；切到背景、關閉分頁或離開頁面前會再強制刷新。重新開啟後若權限失效，按「立即同步」重新授權即可。' : '目前瀏覽器不支援直接綁定檔案；仍會在每次修改及關閉頁面前保存到瀏覽器本機；請定期用 JSON 匯出備份。' })
    ]);
    const recurringManager = el('details', {}, [
      el('summary', { text: '每月固定出入帳（正職／兼職／接案／固定支出）' }),
      el('div', { class: 'health-grid' }, [
        el('div', { class: 'summary-block' }, [el('h3', { text: '每月固定收入' }), el('p', { class: 'mono big', text: Money.formatTWD(monthly.incomeCents) })]),
        el('div', { class: 'summary-block' }, [el('h3', { text: '每月固定支出' }), el('p', { class: 'mono big', text: Money.formatTWD(monthly.essentialExpenseCents + monthly.otherExpenseCents) })]),
        el('div', { class: 'summary-block' }, [el('h3', { text: '每月固定儲蓄' }), el('p', { class: 'mono big', text: Money.formatTWD(monthly.fixedSavingCents) })]),
        el('div', { class: 'summary-block' }, [el('h3', { text: '每月固定淨現金流' }), el('p', { class: 'mono big', text: Money.formatTWD(monthly.monthlySavingsCents) })])
      ]),
      ...flowRows,
      el('div', { class: 'toolbar' }, [
        ...[['monthly', '＋月薪收入', '正職薪水'], ['hourly', '＋時薪兼職', '兼職'], ['per_case', '＋接案收入', '接案']].map(([basis, text, name]) => el('button', { class: 'btn small', text, onclick: () => {
          const base = { id: createEntryId(), name, type: 'income', kind: payBasisOptions[basis].kind, payBasis: basis, amountCents: 0, dayOfMonth: 5, accountId: config.accountProfiles[0]?.id, monthlyWorkHours: basis === 'monthly' ? 160 : 0, applyInsurance: basis !== 'per_case', insuredSalaryFollowsGross: basis === 'monthly', insuredSalaryCents: 0, active: true };
          openFlowCard(base.id);
          config.recurringCashFlows.push(basis === 'monthly' ? base : { ...base, hourlyRateCents: 0, ...(basis === 'per_case' ? { caseCount: 0, hoursPerCase: 1, caseFeeMode: 'hourly' } : {}) });
          IO.markDirty(); renderPersonalSettings();
        } })),
        el('button', { class: 'btn small', text: '＋租屋（房租／電費／管理費）', onclick: () => {
          const id = createEntryId();
          config.recurringCashFlows.push({ id, name: '租屋', type: 'expense', kind: 'rent', amountCents: 0, dayOfMonth: 1, accountId: config.accountProfiles[0]?.id, essential: true, active: true, housing: { rentCents: 0, payCycleMonths: 1, contractStart: localToday(), contractEnd: '', occupants: 1, fees: [], electricity: { enabled: false, rateCentsPerKwh: 0, lastReading: 0, lastReadingDate: '', currentReading: 0, currentReadingDate: '', fallbackMonthlyKwh: 0 } } });
          openFlowCard(id); IO.markDirty(); renderPersonalSettings();
        } }),
        el('button', { class: 'btn small', text: '＋新增固定支出', onclick: () => { config.recurringCashFlows.push({ id: createEntryId(), name: '新固定支出', type: 'expense', kind: 'fixed_expense', amountCents: 0, dayOfMonth: 1, accountId: config.accountProfiles[0]?.id, essential: true, active: true }); IO.markDirty(); renderPersonalSettings(); } }),
        el('button', { class: 'btn small', text: '＋新增固定儲蓄', onclick: () => { const from = config.accountProfiles[0]?.id; const to = ensureSavingsAccount(from); config.recurringCashFlows.push({ id: createEntryId(), name: '固定儲蓄', type: 'saving', kind: 'fixed_saving', amountCents: 0, dayOfMonth: 6, fromAccountId: from, accountId: to, active: true }); IO.markDirty(); renderPersonalSettings(); renderLedgerForm(); } })
      ]),
      el('p', { class: 'notice', text: '到設定日期後，系統會為當月自動建立一次帳目；同一固定項目同月不會重複。每項收入可獨立選擇是否扣勞健保。' })
    ]);
    box.append(
      fileBindingManager,
      recurringManager,
      accountManager,
      el('details', {}, [
        el('summary', { text: '個人參數設定（勞健保費率與存款能力）' }),
        el('div', { class: 'toolbar' }, [
          recurringSummary().items.length
            ? el('div', { class: 'field' }, [el('label', { text: '每月固定淨現金流（自動）' }), el('span', { class: 'mono', text: Money.formatTWD(config.personalBaseline.monthlySavingsCapacityCents) })])
            : numField('每月可存（尚未設定固定出入帳）', Money.toYuan(config.personalBaseline.monthlySavingsCapacityCents), (v) => { config.personalBaseline.monthlySavingsCapacityCents = Money.toCents(v); IO.markDirty(); renderAll(); }),
          numField('勞保費率', config.insuranceRates.laborInsuranceRate, (v) => { config.insuranceRates.laborInsuranceRate = v; IO.markDirty(); renderAll(); }),
          numField('勞保個人負擔比例', config.insuranceRates.laborInsurancePersonalShare, (v) => { config.insuranceRates.laborInsurancePersonalShare = v; IO.markDirty(); renderAll(); }),
          numField('健保費率', config.insuranceRates.healthInsuranceRate, (v) => { config.insuranceRates.healthInsuranceRate = v; IO.markDirty(); renderAll(); }),
          numField('健保個人負擔比例', config.insuranceRates.healthInsurancePersonalShare, (v) => { config.insuranceRates.healthInsurancePersonalShare = v; IO.markDirty(); renderAll(); })
        ]),
        el('p', { class: 'notice', text: config.insuranceRates.note })
      ])
    );
  };

  // ================= 帳戶核對模式 =================
  // 不逐筆記帳：定期填各帳戶餘額，依固定出入帳計畫推算每段期間用掉多少（計算在 snapshots.js）。
  // 兩種記帳方式並存；ledgerDefaultView 決定開啟帳本時先看哪一種，切換只影響這次瀏覽。
  let ledgerView = null;
  let pendingSnapshotDelete = null;
  let snapshotMessage = '';
  const localToday = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const renderSnapshots = () => {
    const box = $('#ledger-view');
    if (!box) return;
    if (!['snapshot', 'entries'].includes(config.ui.ledgerDefaultView)) config.ui.ledgerDefaultView = 'entries';
    if (!ledgerView) ledgerView = config.ui.ledgerDefaultView;
    if (!Array.isArray(ledger.snapshots)) ledger.snapshots = [];
    $('#entries-view').style.display = ledgerView === 'entries' ? '' : 'none';
    box.innerHTML = '';
    const viewBtn = (view, text) => el('button', {
      class: `btn small${ledgerView === view ? ' primary' : ''}`, text, 'aria-pressed': String(ledgerView === view),
      onclick: () => { ledgerView = view; renderSnapshots(); }
    });
    box.append(el('div', { class: 'toolbar' }, [
      viewBtn('snapshot', '帳戶核對'), viewBtn('entries', '逐筆記帳'),
      el('div', { class: 'field' }, [el('label', { text: '開啟帳本時先顯示' }), el('select', {
        onchange: (ev) => { config.ui.ledgerDefaultView = ev.target.value; IO.markDirty(); }
      }, [['snapshot', '帳戶核對'], ['entries', '逐筆記帳']].map(([value, text]) =>
        el('option', { value, text, selected: config.ui.ledgerDefaultView === value ? 'selected' : undefined })))])
    ]));
    if (ledgerView !== 'snapshot') return;

    const accounts = config.accountProfiles;
    const sorted = [...ledger.snapshots].sort((a, b) => a.date.localeCompare(b.date));
    const last = sorted[sorted.length - 1];
    const nameOf = (id) => accounts.find(a => a.id === id)?.name || id;
    const inputs = {};
    const dateInput = el('input', { type: 'date', value: localToday() });
    const noteInput = el('input', { type: 'text', placeholder: '想到再寫，例如：繳了年度保險' });
    const status = el('p', { class: 'notice', text: snapshotMessage });
    snapshotMessage = '';
    box.append(
      el('h3', { text: '記下各帳戶目前的數字' }),
      el('p', { class: 'notice', text: '不用記每一筆花費：照網銀或存摺上的餘額填，沒變的帳戶直接沿用上次的數字。' }),
      el('div', { class: 'field' }, [el('label', { text: '核對日期' }), dateInput]),
      el('div', { class: 'table-scroll' }, [el('table', {}, [
        el('thead', {}, [el('tr', {}, [el('th', { text: '帳戶' }), el('th', { text: '上次' }), el('th', { text: '這次餘額（元）' })])]),
        el('tbody', {}, accounts.map(a => {
          const prev = last?.balances?.[a.id];
          inputs[a.id] = el('input', { type: 'number', step: '1', class: 'mono', value: prev !== undefined ? Money.toYuan(prev) : '' });
          return el('tr', {}, [el('td', { text: a.name }), el('td', { class: 'mono', text: prev !== undefined ? Money.formatTWD(prev) : '—' }), el('td', {}, [inputs[a.id]])]);
        }))
      ])]),
      el('div', { class: 'field' }, [el('label', { text: '備註（可空白）' }), noteInput]),
      el('button', { class: 'btn primary', text: '儲存核對', onclick: () => {
        const balances = {};
        for (const [id, input] of Object.entries(inputs)) if (input.value !== '') balances[id] = Money.toCents(Number(input.value));
        if (!dateInput.value || !Object.keys(balances).length) { status.textContent = '請填日期和至少一個帳戶的餘額。'; return; }
        const same = ledger.snapshots.find(s => s.date === dateInput.value);
        const next = { id: same?.id || createEntryId(), date: dateInput.value, balances, note: noteInput.value.trim() };
        const candidate = same ? ledger.snapshots.map(s => s === same ? next : s) : [...ledger.snapshots, next];
        const errors = Snapshots.validate(candidate);
        if (errors.length) { status.textContent = errors[0]; return; }
        ledger.snapshots = candidate;
        snapshotMessage = same ? `已更新 ${next.date} 的核對。` : `已儲存 ${next.date} 的核對。`;
        IO.markDirty();
        renderSnapshots();
      } }),
      status
    );

    const periods = Snapshots.periods(ledger.snapshots, config.recurringCashFlows || []);
    if (!periods.length) {
      box.append(el('p', { class: 'notice', text: '再核對一次之後，就能看到這段期間用掉多少。' }));
    } else {
      const outflowText = (cents) => cents < 0 ? `多出 ${Money.formatTWD(-cents)}` : Money.formatTWD(cents);
      const p = periods[0], t = p.total;
      box.append(
        el('h3', { text: `最近一期：${p.from} → ${p.to}（${p.days} 天）` }),
        el('div', { class: 'health-grid' }, [
          el('div', { class: 'summary-block highlight' }, [el('h3', { text: '推算用掉' }), el('p', { class: 'mono big', text: outflowText(t.outflowCents) }),
            el('p', { class: 'notice', text: t.outflowPer30Cents === null ? '' : `換算每 30 天 ${outflowText(t.outflowPer30Cents)}` })]),
          el('div', { class: 'summary-block highlight' }, [el('h3', { text: '其中固定支出（計畫）' }), el('p', { class: 'mono big', text: Money.formatTWD(t.fixedOutCents) }),
            el('p', { class: 'notice', text: `生活花費約 ${outflowText(t.livingCents)}` })]),
          el('div', { class: 'summary-block highlight' }, [el('h3', { text: '全部帳戶變動' }), el('p', { class: 'mono big', text: Money.formatTWD(t.changeCents) }),
            el('p', { class: 'notice', text: `計畫存入 ${Money.formatTWD(t.inCents)}` })])
        ]),
        el('p', { class: 'notice', text: '「用掉」是推算值：期初＋計畫存入（固定出入帳）−期末，不是逐筆明細。帳戶之間互轉沒有記錄時，個別帳戶會一邊多花、一邊多存，但全部加總不受影響；利息、退款、計畫外收入會讓數字變成「多出」。' }),
        el('details', {}, [el('summary', { text: '各帳戶明細（互轉未記錄時僅供參考）' }), el('div', { class: 'table-scroll' }, [el('table', {}, [
          el('thead', {}, [el('tr', {}, ['帳戶', '期初', '計畫存入', '期末', '推算用掉'].map(h => el('th', { text: h })))]),
          el('tbody', {}, p.accounts.map(a => el('tr', {}, [el('td', { text: nameOf(a.id) }),
            ...[a.startCents, a.inCents, a.endCents].map(v => el('td', { class: 'mono', text: Money.formatTWD(v) })),
            el('td', { class: 'mono', text: outflowText(a.outflowCents) })])))
        ])])]),
        el('h3', { text: '各期比較' }),
        el('div', { class: 'table-scroll' }, [el('table', {}, [
          el('thead', {}, [el('tr', {}, ['期間', '天數', '推算用掉', '每 30 天', '備註'].map(h => el('th', { text: h })))]),
          el('tbody', {}, periods.map(x => el('tr', {}, [el('td', { text: `${x.from} → ${x.to}` }), el('td', { class: 'mono', text: String(x.days) }),
            el('td', { class: 'mono', text: outflowText(x.total.outflowCents) }),
            el('td', { class: 'mono', text: x.total.outflowPer30Cents === null ? '—' : outflowText(x.total.outflowPer30Cents) }),
            el('td', { text: x.note })])))
        ])])
      );
    }
    if (sorted.length) {
      box.append(el('details', {}, [el('summary', { text: `核對紀錄（${sorted.length} 筆）` }),
        ...[...sorted].reverse().map(s => el('div', { class: 'toolbar' }, [
          el('span', { text: `${s.date}　合計 ${Money.formatTWD(Object.values(s.balances).reduce((a, b) => a + b, 0))}${s.note ? `　${s.note}` : ''}` }),
          el('button', { class: 'btn small danger', text: pendingSnapshotDelete === s.id ? '確定刪除' : '刪除', onclick: () => {
            if (pendingSnapshotDelete !== s.id) { pendingSnapshotDelete = s.id; renderSnapshots(); return; }
            ledger.snapshots = ledger.snapshots.filter(x => x.id !== s.id);
            pendingSnapshotDelete = null; IO.markDirty(); renderSnapshots();
          } })
        ]))]));
    }
  };

  const renderLedger = () => {
    renderSnapshots();
    renderLedgerList();
    renderLedgerSummary();
    renderHealth();
  };

  const renderAll = () => {
    renderLedger();
    renderEstimator();
    renderWageReverse();
    renderPersonalSettings();
  };

  // ================= 成本試算 Tab =================
  const currentScenario = () => scenarios.find((s) => s.scenarioId === currentScenarioId);

  const renderScenarioSelector = () => {
    const sel = $('#scenario-select');
    config.ui.currentScenarioId = currentScenarioId;
    sel.innerHTML = '';
    scenarios.forEach((s) => sel.appendChild(el('option', { value: s.scenarioId, text: s.label })));
    sel.value = currentScenarioId;
    const comparisonToggle = $('#compare-toggle');
    const comparisonAvailable = ['buy_house', 'self_build'].includes(currentScenarioId);
    comparisonToggle.closest('label').hidden = !comparisonAvailable;
    if (!comparisonAvailable && compareMode) { compareMode = false; comparisonToggle.checked = false; }
    $('#delete-scenario').disabled = currentScenario()?.custom !== true;
    sel.onchange = () => { currentScenarioId = sel.value; config.ui.currentScenarioId = currentScenarioId; IO.markDirty(); renderScenarioSelector(); renderEstimator(); };
  };

  // 自動提示：呼叫工時反推引擎正式函式（唯一計算來源，不另寫簡化公式）+ 存款版估算
  const renderAchievabilityBlock = (amountCents, currency = 'TWD', rateToTWD = 1) => {
    if (!amountCents || amountCents <= 0) return null;
    syncWageFromLinkedIncome();
    const hint = Money.calcAchievabilityHint(amountCents, currency, rateToTWD, wageReverseScenario, config);
    const lines = [
      el('p', { class: 'notice' }, [
        document.createTextNode(`以目前連動時薪換算，約需工作 ${hint.hoursNeeded.toLocaleString()} 小時　`),
        el('button', {
          class: 'btn small', text: '帶入工時反推',
          onclick: () => {
            wageReverseScenario.targetAmountCents = hint.twd;
            wageReverseScenario.currency = 'TWD'; wageReverseScenario.rateToTWD = 1;
            config.ui.activeTab = 'wage';
            IO.markDirty();
            $$('.tab-btn').forEach((b) => b.classList.remove('active'));
            $$('.tab-panel').forEach((p) => p.classList.remove('active'));
            $('.tab-btn[data-tab="wage"]').classList.add('active');
            $('#panel-wage').classList.add('active');
            renderWageReverse();
          }
        })
      ]),
      hint.monthsViaSaving !== null
        ? el('p', { class: 'notice', text: `以每月可存 ${Money.formatTWD(config.personalBaseline.monthlySavingsCapacityCents)} 估算，約需 ${hint.monthsViaSaving} 個月，預計 ${hint.ageAtCompletion} 歲可達成` })
        : el('p', { class: 'notice', text: '尚未設定每月可存金額，無法估算存款版達成時間。' })
    ];
    return el('div', { class: 'achievability' }, lines);
  };

  const renderMortgageRepaymentBlock = (scenario) => {
    const settings = ensureMortgageSettings(scenario);
    const principal = settings.principalMode === 'manual' ? settings.manualPrincipalCents : scenario.loanAmountCents;
    const plan = Money.calcMortgageRepayment(principal, settings, config.personalBaseline.currentAge);
    const stress1 = Money.calcMortgageRepayment(principal, { ...settings, annualRate: settings.annualRate + 0.01 }, config.personalBaseline.currentAge);
    const stress2 = Money.calcMortgageRepayment(principal, { ...settings, annualRate: settings.annualRate + 0.02 }, config.personalBaseline.currentAge);
    const housePrice = Math.max(0, scenario.items.find(i => i.label === '房價')?.amountCents || 0);
    const ltv = housePrice > 0 ? principal / housePrice : null;
    const neededDownPayment = Math.max(0, housePrice - principal);
    const downPaymentGap = Math.max(0, neededDownPayment - Math.max(0, scenario.downPaymentCurrentCents || 0));
    const cashFlowWithoutMortgage = Money.calcRecurringMonthly((config.recurringCashFlows || []).filter(f => f.id !== 'system-mortgage-repayment' && flowLinked(f)), config.insuranceRates);
    const beforeMortgage = cashFlowWithoutMortgage.incomeCents - cashFlowWithoutMortgage.essentialExpenseCents - cashFlowWithoutMortgage.otherExpenseCents - cashFlowWithoutMortgage.fixedSavingCents;
    const afterPayment = beforeMortgage - plan.currentPaymentCents;
    const burdenRate = cashFlowWithoutMortgage.incomeCents > 0 ? plan.currentPaymentCents / cashFlowWithoutMortgage.incomeCents : null;
    const reserve = plan.currentPaymentCents * Math.max(0, Math.trunc(settings.reserveMonths || 0));
    const restricted = settings.loanPosition !== 'first_home';
    const refresh = () => { syncMortgageFixedExpense(); IO.markDirty(); materializeDueRecurringEntries(); renderEstimator(); renderPersonalSettings(); renderLedger(); };
    const accountOptions = config.accountProfiles.map(a => el('option', { value: a.id, text: a.name, selected: settings.accountId === a.id ? 'selected' : undefined }));
    return el('section', { class: 'estimator-section student-loan-plan mortgage-plan' }, [
      el('div', { class: 'section-heading' }, [el('h3', { text: '房貸還款設定' }), el('p', { class: 'notice', text: `依目前年齡 ${config.personalBaseline.currentAge} 歲自動判斷・公開資料檢索日 ${REFERENCE_DATA.twMortgage.retrievedAt}` })]),
      el('ol', { class: 'setup-steps' }, [el('li', { text: '確認貸款本金' }), el('li', { text: '輸入銀行利率、年限與寬限期' }), el('li', { text: '檢查壓力結果並納入固定支出' })]),
      el('div', { class: 'estimator-field-grid' }, [
        el('label', { class: 'field estimator-field' }, [el('span', { text: '貸款本金來源' }), el('select', { onchange: e => { settings.principalMode = e.target.value; refresh(); } }, [
          el('option', { value: 'estimated', text: `沿用成本試算貸款・${Money.formatTWD(scenario.loanAmountCents)}`, selected: settings.principalMode === 'estimated' ? 'selected' : undefined }),
          el('option', { value: 'manual', text: '使用銀行目前未償本金', selected: settings.principalMode === 'manual' ? 'selected' : undefined })
        ])]),
        settings.principalMode === 'manual' ? numField('銀行目前未償本金（元）', Money.toYuan(settings.manualPrincipalCents), v => { settings.manualPrincipalCents = Money.toCents(Math.max(0, v)); refresh(); }) : null,
        numField('預計購屋／開始繳款年齡', settings.purchaseAge, v => { settings.purchaseAge = Math.max(0, v); refresh(); }),
        numField('銀行核定年利率（小數）', settings.annualRate, v => { settings.annualRate = Math.max(0, v); refresh(); }),
        numField('貸款總年限', settings.termYears, v => { settings.termYears = Math.max(1, v); refresh(); }),
        numField('只繳息寬限年數', settings.graceYears, v => { settings.graceYears = Math.max(0, Math.min(v, settings.termYears - 1 / 12)); refresh(); })
      ]),
      el('label', { class: 'student-loan-toggle' }, [el('input', { type: 'checkbox', checked: settings.includeAsFixedExpense ? 'checked' : undefined, onchange: e => { settings.includeAsFixedExpense = e.target.checked; refresh(); } }), el('span', {}, [el('strong', { text: '自動納入帳本固定支出' }), el('small', { text: '到達購屋年齡後自動啟用；寬限期只列利息，之後自動改為本息月繳。' })])]),
      el('div', { class: 'health-grid student-loan-summary' }, [
        el('div', { class: 'summary-block' }, [el('h3', { text: '貸款成數' }), el('p', { class: 'mono big', text: ltv === null ? '—' : `${(ltv * 100).toFixed(1)}%` }), el('p', { class: 'notice', text: `自備款尚差 ${Money.formatTWD(downPaymentGap)}` })]),
        plan.graceMonths > 0 ? el('div', { class: 'summary-block' }, [el('h3', { text: '寬限期月繳' }), el('p', { class: 'mono big', text: Money.formatTWD(plan.interestOnlyPaymentCents) }), el('p', { class: 'notice', text: '只繳息、不減少本金' })]) : null,
        el('div', { class: 'summary-block highlight' }, [el('h3', { text: '寬限後本息月繳' }), el('p', { class: 'mono big', text: Money.formatTWD(plan.monthlyPaymentCents) })]),
        el('div', { class: 'summary-block' }, [el('h3', { text: '總利息' }), el('p', { class: 'mono big', text: Money.formatTWD(plan.totalInterestCents) }), el('p', { class: 'notice', text: `總還款 ${Money.formatTWD(plan.totalRepaymentCents)}` })]),
        el('div', { class: 'summary-block' }, [el('h3', { text: '房貸還款預備金' }), el('p', { class: 'mono big', text: Money.formatTWD(reserve) }), el('p', { class: 'notice', text: `${settings.reserveMonths} 個月目前月繳` })]),
        el('div', { class: 'summary-block' }, [el('h3', { text: '月繳後固定現金流' }), el('p', { class: `mono big${afterPayment < 0 ? ' neg' : ''}`, text: cashFlowWithoutMortgage.incomeCents > 0 ? Money.formatTWD(afterPayment) : '尚無固定收入' }), el('p', { class: 'notice', text: burdenRate === null ? '請先在帳本設定固定收入' : `月繳占固定收入 ${(burdenRate * 100).toFixed(1)}%` })])
      ]),
      el('div', { class: 'mortgage-stress' }, [
        el('strong', { text: '升息壓力測試' }),
        el('span', { text: `目前 ${(settings.annualRate * 100).toFixed(2)}%：${Money.formatTWD(plan.monthlyPaymentCents)}` }),
        el('span', { text: `升 1%：${Money.formatTWD(stress1.monthlyPaymentCents)}` }),
        el('span', { text: `升 2%：${Money.formatTWD(stress2.monthlyPaymentCents)}` })
      ]),
      el('details', { class: 'compact-settings' }, [el('summary', { text: '進階設定：房貸戶數、扣款帳戶與還款預備金' }), el('div', { class: 'estimator-field-grid' }, [
        el('label', { class: 'field estimator-field' }, [el('span', { text: '房貸情況' }), el('select', { onchange: e => { settings.loanPosition = e.target.value; if (settings.loanPosition !== 'first_home') settings.graceYears = 0; refresh(); } }, [
          el('option', { value: 'first_home', text: '名下無自用住宅／首購', selected: settings.loanPosition === 'first_home' ? 'selected' : undefined }),
          el('option', { value: 'existing_no_mortgage', text: '名下有房、目前無房貸', selected: settings.loanPosition === 'existing_no_mortgage' ? 'selected' : undefined }),
          el('option', { value: 'second_mortgage', text: '名下已有 1 戶房貸', selected: settings.loanPosition === 'second_mortgage' ? 'selected' : undefined }),
          el('option', { value: 'third_plus', text: '名下已有 2 戶以上房貸', selected: settings.loanPosition === 'third_plus' ? 'selected' : undefined })
        ])]),
        numField('每月扣款日', settings.paymentDay, v => { settings.paymentDay = Math.min(31, Math.max(1, Math.trunc(v))); refresh(); }),
        numField('還款預備金月數', settings.reserveMonths, v => { settings.reserveMonths = Math.max(0, Math.trunc(v)); refresh(); }),
        el('label', { class: 'field estimator-field' }, [el('span', { text: '固定支出扣款帳戶' }), el('select', { onchange: e => { settings.accountId = e.target.value; refresh(); } }, accountOptions)])
      ]), restricted ? el('p', { class: 'savings-issues', text: '目前選擇的房貸情況可能受央行貸款成數及不得有寬限期等限制；本工具已將寬限期歸零，實際仍以銀行與央行最新規定為準。' }) : null]),
      el('p', { class: 'notice' }, [document.createTextNode(`${REFERENCE_DATA.twMortgage.source}。${REFERENCE_DATA.twMortgage.note} `), el('a', { href: REFERENCE_DATA.twMortgage.regulationUrl, target: '_blank', rel: 'noopener', text: '查看央行最新規定' })])
    ]);
  };

  const renderOneTimeScenario = (scenario) => {
    const root = $('#estimator-body');
    const result = Money.calcScenario(scenario, config);

    const itemRows = scenario.items.map((item, idx) => el('tr', {}, [
      el('td', {}, [el('input', {
        type: 'text', value: item.label, class: 'mono',
        onchange: (ev) => { item.label = ev.target.value.trim() || item.label; ev.target.value = item.label; IO.markDirty(); }
      })]),
      el('td', {}, [el('select', { onchange: (ev) => { item.kind = ev.target.value; IO.markDirty(); renderEstimator(); } }, [
        el('option', { value: 'cost', text: '成本', selected: (item.kind || 'cost') === 'cost' ? 'selected' : undefined }),
        el('option', { value: 'discount', text: '折扣／減免', selected: item.kind === 'discount' ? 'selected' : undefined })
      ])]),
      el('td', {}, [el('input', {
        type: 'number', value: Money.toYuan(item.amountCents), class: 'mono',
        onchange: (ev) => { item.amountCents = Math.max(0, Money.toCents(ev.target.value)); IO.markDirty(); renderEstimator(); }
      })]),
      el('td', {}, [el('button', {
        class: 'btn small danger', text: '刪除',
        onclick: () => { scenario.items.splice(idx, 1); IO.markDirty(); renderEstimator(); }
      })])
    ]));
    root.innerHTML = '';
    const targetForHint = result.gap !== null ? result.gap : (scenario.applyInflation ? result.inflated : result.total);
    root.append(
      scenario.scenarioId === 'buy_house' ? renderMortgageRepaymentBlock(scenario) : null,
      el('div', { class: 'table-scroll editor-only' }, [el('table', { class: 'items-table estimator-items-table' }, [
        el('thead', {}, [el('tr', {}, [el('th', { text: '項目' }), el('th', { text: '類型' }), el('th', { text: '金額（元）' }), el('th', { text: '' })])]),
        el('tbody', {}, itemRows)
      ])]),
      el('button', {
        class: 'btn small editor-only', text: '＋新增項目',
        onclick: () => { scenario.items.push({ label: '新項目', kind: 'cost', amountCents: 0 }); IO.markDirty(); renderEstimator(); }
      }),
      scenario.currentSavedCents !== undefined ? el('div', { class: 'field editor-only' }, [
        el('label', { text: '目前已存金額（元）' }),
        el('input', {
          type: 'number', value: Money.toYuan(scenario.currentSavedCents),
          onchange: (ev) => { scenario.currentSavedCents = Money.toCents(ev.target.value); IO.markDirty(); renderEstimator(); }
        })
      ]) : empty(),
      el('div', { class: 'result-block' }, [
        el('p', {}, [document.createTextNode('總額：'), el('span', { class: 'mono big', text: Money.formatTWD(result.total) })]),
        scenario.applyInflation ? el('p', {}, [document.createTextNode('通膨後總額：'), el('span', { class: 'mono big', text: Money.formatTWD(result.inflated) })]) : null,
        result.afterLoan !== null ? el('p', {}, [document.createTextNode('貸後金額：'), el('span', { class: 'mono', text: Money.formatTWD(result.afterLoan) })]) : null,
        result.inflatedAfterLoan !== null ? el('p', {}, [document.createTextNode('通膨後貸後金額：'), el('span', { class: 'mono', text: Money.formatTWD(result.inflatedAfterLoan) })]) : null,
        result.gap !== null ? el('p', {}, [document.createTextNode('與目前已存差額：'), el('span', { class: result.gap > 0 ? 'mono neg' : 'mono', text: Money.formatTWD(result.gap) })]) : null,
        el('details', {}, [
          el('summary', { text: '顯示算式' }),
          el('pre', { class: 'formula', text: result.formulaText })
        ])
      ]),
      renderAchievabilityBlock(targetForHint)
    );
  };

  const renderStudentLoanRepaymentBlock = (scenario, result) => {
    const repayment = ensureStudentLoanRepayment(scenario);
    const principal = repayment.principalMode === 'manual' ? repayment.manualPrincipalCents : result.grandTotal;
    const plan = Money.calcStudentLoanRepayment(principal, scenario.periods.filter(p => !p.isLeaveOfAbsence).length, repayment, config.personalBaseline.currentAge);
    const statusText = plan.status === 'waiting' ? `尚未起繳；預計 ${plan.repaymentStartAge} 歲開始` : (plan.status === 'repaying' ? `目前在攤還期${repayment.includeAsFixedExpense ? '，已自動納入固定支出' : '，請勾選納入固定支出'}` : `依年齡估算已於 ${plan.repaymentEndAge} 歲完成`);
    const cashFlowWithoutLoan = Money.calcRecurringMonthly((config.recurringCashFlows || []).filter(f => f.id !== 'system-student-loan-repayment' && flowLinked(f)), config.insuranceRates);
    const availableBeforeLoan = cashFlowWithoutLoan.incomeCents - cashFlowWithoutLoan.essentialExpenseCents - cashFlowWithoutLoan.otherExpenseCents - cashFlowWithoutLoan.fixedSavingCents;
    const afterPayment = availableBeforeLoan - plan.monthlyPaymentCents;
    const burdenRate = cashFlowWithoutLoan.incomeCents > 0 ? plan.monthlyPaymentCents / cashFlowWithoutLoan.incomeCents : null;
    const reserveCents = plan.monthlyPaymentCents * Math.max(0, Math.trunc(repayment.reserveMonths || 0));
    const refresh = () => { syncStudentLoanFixedExpense(); IO.markDirty(); materializeDueRecurringEntries(); renderEstimator(); renderPersonalSettings(); renderLedger(); };
    const accountOptions = config.accountProfiles.map(a => el('option', { value: a.id, text: a.name, selected: repayment.accountId === a.id ? 'selected' : undefined }));
    return el('section', { class: 'estimator-section student-loan-plan' }, [
      el('div', { class: 'section-heading' }, [el('h3', { text: '學貸還款設定' }), el('p', { class: 'notice', text: `依目前年齡 ${config.personalBaseline.currentAge} 歲自動判斷・制度基準日 ${REFERENCE_DATA.twStudentLoan.effectiveFrom}` })]),
      el('ol', { class: 'setup-steps' }, [el('li', { text: '確認計算本金' }), el('li', { text: '確認畢業年齡與攤還方案' }), el('li', { text: '勾選納入帳本固定支出' })]),
      el('div', { class: 'estimator-field-grid' }, [
        el('label', { class: 'field estimator-field' }, [el('span', { text: '計算本金來源' }), el('select', { onchange: e => { repayment.principalMode = e.target.value; refresh(); } }, [
          el('option', { value: 'estimated', text: `依下方學期估算・${Money.formatTWD(result.grandTotal)}`, selected: repayment.principalMode === 'estimated' ? 'selected' : undefined }),
          el('option', { value: 'manual', text: '使用銀行目前未償本金', selected: repayment.principalMode === 'manual' ? 'selected' : undefined })
        ])]),
        repayment.principalMode === 'manual' ? numField('銀行目前未償本金（元）', Money.toYuan(repayment.manualPrincipalCents), v => { repayment.manualPrincipalCents = Money.toCents(Math.max(0, v)); refresh(); }) : null,
        numField('預計畢業年齡', repayment.graduationAge, v => { repayment.graduationAge = Math.max(0, Math.trunc(v)); refresh(); }),
        el('label', { class: 'field estimator-field' }, [el('span', { text: '攤還年限方案' }), el('select', { onchange: e => { repayment.termPlan = e.target.value; refresh(); } }, [
          el('option', { value: 'standard', text: '一般・每貸 1 學期還 1 年', selected: repayment.termPlan === 'standard' ? 'selected' : undefined }),
          el('option', { value: 'extended', text: '專案延長・1.5 倍（須銀行同意）', selected: repayment.termPlan === 'extended' ? 'selected' : undefined }),
          el('option', { value: 'low_income', text: '低／中低收入戶・2 倍', selected: repayment.termPlan === 'low_income' ? 'selected' : undefined })
        ])])
      ]),
      el('label', { class: 'student-loan-toggle' }, [el('input', { type: 'checkbox', checked: repayment.includeAsFixedExpense ? 'checked' : undefined, onchange: e => { repayment.includeAsFixedExpense = e.target.checked; refresh(); } }), el('span', {}, [el('strong', { text: '自動納入帳本固定支出' }), el('small', { text: '到達起繳年齡後自動啟用，完成攤還年齡後自動停止。' })])]),
      el('div', { class: 'health-grid student-loan-summary' }, [
        el('div', { class: 'summary-block' }, [el('h3', { text: '計算本金' }), el('p', { class: 'mono big', text: Money.formatTWD(plan.principalCents) })]),
        el('div', { class: 'summary-block highlight' }, [el('h3', { text: '預計月繳' }), el('p', { class: 'mono big', text: Money.formatTWD(plan.monthlyPaymentCents) })]),
        el('div', { class: 'summary-block' }, [el('h3', { text: '預計攤還年限' }), el('p', { class: 'mono big', text: `${plan.termYears} 年・${plan.termMonths} 期` })]),
        el('div', { class: 'summary-block' }, [el('h3', { text: '預計還款總額' }), el('p', { class: 'mono big', text: Money.formatTWD(plan.totalRepaymentCents) }), el('p', { class: 'notice', text: `其中估計利息 ${Money.formatTWD(plan.totalInterestCents)}` })]),
        el('div', { class: 'summary-block' }, [el('h3', { text: '學貸還款預備金' }), el('p', { class: 'mono big', text: Money.formatTWD(reserveCents) }), el('p', { class: 'notice', text: `${repayment.reserveMonths} 個月月繳` })]),
        el('div', { class: 'summary-block' }, [el('h3', { text: '月繳後固定現金流' }), el('p', { class: `mono big${afterPayment < 0 ? ' neg' : ''}`, text: cashFlowWithoutLoan.incomeCents > 0 ? Money.formatTWD(afterPayment) : '尚無固定收入' }), el('p', { class: 'notice', text: burdenRate === null ? '請先在帳本設定固定收入' : `月繳占固定收入 ${(burdenRate * 100).toFixed(1)}%` })]),
        el('div', { class: 'summary-block' }, [el('h3', { text: '年齡對應狀態' }), el('p', { text: statusText })])
      ]),
      el('details', { class: 'compact-settings' }, [el('summary', { text: '進階設定：利率、寬限期、扣款帳戶與還款預備金' }), el('div', { class: 'estimator-field-grid' }, [
        numField('畢業後寬限年數', repayment.graceYears, v => { repayment.graceYears = Math.max(0, v); refresh(); }),
        numField('學生負擔年利率（小數）', repayment.annualRate, v => { repayment.annualRate = Math.max(0, v); refresh(); }),
        numField('每月扣款日', repayment.paymentDay, v => { repayment.paymentDay = Math.min(31, Math.max(1, Math.trunc(v))); refresh(); }),
        numField('還款預備金月數', repayment.reserveMonths, v => { repayment.reserveMonths = Math.max(0, Math.trunc(v)); refresh(); }),
        el('label', { class: 'field estimator-field' }, [el('span', { text: '固定支出扣款帳戶' }), el('select', { onchange: e => { repayment.accountId = e.target.value; refresh(); } }, accountOptions)])
      ])]),
      el('p', { class: 'notice' }, [document.createTextNode(`${REFERENCE_DATA.twStudentLoan.source}。${REFERENCE_DATA.twStudentLoan.note} `), el('a', { href: REFERENCE_DATA.twStudentLoan.sourceUrl, target: '_blank', rel: 'noopener', text: '查看教育部法規' })])
    ]);
  };

  const renderPeriodScenario = (scenario) => {
    const root = $('#estimator-body');
    const result = Money.calcScenario(scenario, config);
    root.innerHTML = '';
    root.append(
      el('p', { class: 'notice editor-only', text: '此情境為期別型（如學貸），每期套用同一組項目範本，個別期別可覆寫單一項目金額。可標記某期為休學，該期金額自動算 0。' }),
      scenario.scenarioId === 'student_loan' ? renderStudentLoanRepaymentBlock(scenario, result) : null,
      el('details', { class: 'estimator-section editor-only' }, [
        el('summary', { text: '編輯共用欄目' }),
        el('div', { class: 'table-scroll' }, [el('table', { class: 'estimator-items-table' }, [el('tbody', {}, scenario.itemTemplate.map((item, itemIndex) => el('tr', {}, [
          el('td', {}, [el('input', { value: item.label, onchange: e => { const old = item.label; item.label = e.target.value.trim() || old; scenario.periods.forEach(p => { if (p.overrides && Object.prototype.hasOwnProperty.call(p.overrides, old)) { p.overrides[item.label] = p.overrides[old]; delete p.overrides[old]; } }); IO.markDirty(); renderEstimator(); } })]),
          el('td', {}, [el('input', { type: 'number', value: Money.toYuan(item.amountCents), onchange: e => { item.amountCents = Money.toCents(e.target.value); IO.markDirty(); renderEstimator(); } })]),
          el('td', {}, [el('button', { class: 'btn small danger', text: '刪除', onclick: () => { scenario.itemTemplate.splice(itemIndex, 1); IO.markDirty(); renderEstimator(); } })])
        ])))])]),
        el('button', { class: 'btn small', text: '＋新增欄目', onclick: () => { scenario.itemTemplate.push({ label: '新欄目', amountCents: 0 }); IO.markDirty(); renderEstimator(); } })
      ]),
      ...result.periods.map((p, idx) => el('div', { class: 'period-block editor-only' + (p.isLeaveOfAbsence ? ' leave' : '') }, [
        el('h4', {}, [
          el('input', { value: p.label, onchange: e => { scenario.periods[idx].label = e.target.value.trim() || p.label; IO.markDirty(); renderEstimator(); } }),
          el('label', { class: 'inline-check' }, [
            el('input', {
              type: 'checkbox', checked: p.isLeaveOfAbsence ? 'checked' : undefined,
              onchange: (ev) => { scenario.periods[idx].isLeaveOfAbsence = ev.target.checked; IO.markDirty(); renderEstimator(); }
            }),
            document.createTextNode(' 標記為休學')
          ]),
          el('button', { class: 'btn small danger', text: '刪除此期', onclick: () => { scenario.periods.splice(idx, 1); IO.markDirty(); renderEstimator(); } })
        ]),
        p.isLeaveOfAbsence
          ? el('p', { class: 'notice', text: '休學期間，不計入學費' })
          : el('div', { class: 'table-scroll' }, [el('table', {}, [el('tbody', {}, p.items.map((i) => el('tr', {}, [
              el('td', { text: i.label }), el('td', { class: 'mono', text: Money.formatTWD(i.amountCents) })
            ])))])]),
        el('p', {}, [document.createTextNode('本期小計：'), el('span', { class: 'mono', text: Money.formatTWD(p.total) })])
      ])),
      el('button', { class: 'btn small editor-only', text: '＋新增期別', onclick: () => { scenario.periods.push({ label: `新期別 ${scenario.periods.length + 1}`, overrides: {} }); IO.markDirty(); renderEstimator(); } }),
      el('div', { class: 'result-block' }, [
        el('p', {}, [document.createTextNode('全期合計：'), el('span', { class: 'mono big', text: Money.formatTWD(result.grandTotal) })])
      ]),
      renderAchievabilityBlock(result.grandTotal)
    );
  };

  const numField = (label, value, onchange) => numberField(label, value, onchange, 'field estimator-field');

  const renderRetirementFundScenario = (scenario) => {
    const root = $('#estimator-body');
    scenario.currentAge = syncCurrentAgeFromBirthYear();
    const result = Money.calcScenario(scenario, config);
    root.innerHTML = '';
    root.append(
      el('div', { class: 'estimator-field-grid' }, [
        el('div', { class: 'field estimator-field' }, [el('label', { text: '目前年齡（由出生年份推算）' }), el('span', { class: 'mono readonly-value', text: `${scenario.currentAge} 歲` })]),
        numField('預計退休年齡', scenario.retireAge, (v) => { scenario.retireAge = v; IO.markDirty(); renderEstimator(); }),
        numField('預計身故年齡', scenario.deathAge, (v) => { scenario.deathAge = v; IO.markDirty(); renderEstimator(); }),
        numField('每月生活費（元）', Money.toYuan(scenario.monthlyLivingCostCents), (v) => { scenario.monthlyLivingCostCents = Money.toCents(v); IO.markDirty(); renderEstimator(); }),
        numField('目前已存金額（元）', Money.toYuan(scenario.currentSavedCents || 0), (v) => { scenario.currentSavedCents = Money.toCents(v); IO.markDirty(); renderEstimator(); })
      ]),
      scenario.referenceNote ? el('p', { class: 'notice', text: scenario.referenceNote }) : empty(),
      el('div', { class: 'result-block' }, [
        el('p', {}, [document.createTextNode('退休後年數：'), el('span', { class: 'mono', text: result.retirementYears + ' 年' })]),
        el('p', {}, [document.createTextNode('養老所需總額：'), el('span', { class: 'mono big', text: Money.formatTWD(result.inflated) })]),
        el('p', {}, [document.createTextNode('與目前已存差額：'), el('span', { class: result.gap > 0 ? 'mono neg' : 'mono', text: Money.formatTWD(result.gap) })]),
        el('details', {}, [el('summary', { text: '顯示算式' }), el('pre', { class: 'formula', text: result.formulaText })])
      ]),
      renderAchievabilityBlock(result.gap)
    );
  };

  const renderFireScenario = (scenario) => {
    const root = $('#estimator-body');
    let result;
    try { result = Money.calcScenario(scenario, config); }
    catch (err) { root.innerHTML = ''; root.append(el('p', { class: 'neg', text: err.message })); return; }
    root.innerHTML = '';
    root.append(
      el('div', { class: 'estimator-field-grid' }, [
        numField('開始工作年齡', scenario.startAge, (v) => { scenario.startAge = v; IO.markDirty(); renderEstimator(); }),
        numField('預計退休年齡', scenario.retireAge, (v) => { scenario.retireAge = v; IO.markDirty(); renderEstimator(); }),
        numField('預期壽命', scenario.deathAge, (v) => { scenario.deathAge = v; IO.markDirty(); renderEstimator(); }),
        numField('目前月薪（元）', Money.toYuan(scenario.currentMonthlySalaryCents), (v) => { scenario.currentMonthlySalaryCents = Money.toCents(v); IO.markDirty(); renderEstimator(); }),
        numField('目前月支出（元）', Money.toYuan(scenario.currentMonthlyExpenseCents), (v) => { scenario.currentMonthlyExpenseCents = Money.toCents(v); IO.markDirty(); renderEstimator(); }),
        numField('退休後月支出（元）', Money.toYuan(scenario.retirementMonthlyExpenseCents), (v) => { scenario.retirementMonthlyExpenseCents = Money.toCents(v); IO.markDirty(); renderEstimator(); }),
        numField('退休後年化報酬率（小數）', scenario.postRetirementAnnualReturnRate, (v) => { scenario.postRetirementAnnualReturnRate = v; IO.markDirty(); renderEstimator(); }),
        numField('退休後通膨率（小數）', scenario.retirementInflationAnnualRate ?? 0, (v) => { scenario.retirementInflationAnnualRate = Math.max(0, Math.min(0.20, v)); IO.markDirty(); renderEstimator(); }),
        numField('目前已存總額（元）', Money.toYuan(scenario.totalSavedCents), (v) => { scenario.totalSavedCents = Money.toCents(v); IO.markDirty(); renderEstimator(); }),
        numField('假設薪資年成長率（小數）', scenario.assumedSalaryGrowthRate, (v) => { scenario.assumedSalaryGrowthRate = v; IO.markDirty(); renderEstimator(); }),
        numField('退休前名目年報酬率（小數）', scenario.preRetirementAnnualReturnRate || 0, (v) => { scenario.preRetirementAnnualReturnRate = v; IO.markDirty(); renderEstimator(); }),
        numField('投保薪資（元，供勞健保換算）', Money.toYuan(scenario.insuredSalaryCents), (v) => { scenario.insuredSalaryCents = Money.toCents(v); IO.markDirty(); renderEstimator(); })
      ]),
      el('div', { class: 'estimator-option-grid' }, [
        el('label', { class: 'field estimator-field' }, [
          el('span', { text: '薪資基準' }),
          el('select', {
            onchange: (ev) => { scenario.salaryType = ev.target.value; IO.markDirty(); renderEstimator(); }
          }, [
            el('option', { value: 'gross', text: '稅前（毛薪）', selected: scenario.salaryType === 'gross' ? 'selected' : undefined }),
            el('option', { value: 'net', text: '稅後（淨薪）', selected: scenario.salaryType === 'net' ? 'selected' : undefined })
          ])
        ]),
        el('label', { class: 'field estimator-field' }, [
          el('span', { text: '反推模式' }),
          el('select', {
            onchange: (ev) => { scenario.retireAgeSolveMode = ev.target.value; IO.markDirty(); renderEstimator(); }
          }, [
            el('option', { value: 'given_age', text: '已知退休年齡→算應有月薪', selected: scenario.retireAgeSolveMode === 'given_age' ? 'selected' : undefined }),
            el('option', { value: 'given_growth_rate', text: '已知薪資成長率→反推退休年齡', selected: scenario.retireAgeSolveMode === 'given_growth_rate' ? 'selected' : undefined })
          ])
        ]),
        el('label', { class: 'field estimator-field' }, [
          el('span', { text: '退休資金模型' }),
          el('select', { onchange: (ev) => { scenario.retirementFundingModel = ev.target.value; IO.markDirty(); renderEstimator(); } }, [
            el('option', { value: 'perpetuity', text: '永續提領（本金不耗盡）', selected: (scenario.retirementFundingModel || 'perpetuity') === 'perpetuity' ? 'selected' : undefined }),
            el('option', { value: 'finite', text: '有限壽命（算至預期壽命）', selected: scenario.retirementFundingModel === 'finite' ? 'selected' : undefined })
          ])
        ]),
      ]),
      el('div', { class: 'result-block' }, [
        el('p', {}, [document.createTextNode('退休資產目標：'), el('span', { class: 'mono big', text: Money.formatTWD(result.retirementAssetTarget) })]),
        el('p', {}, [document.createTextNode('退休前總需求資金：'), el('span', { class: 'mono', text: Money.formatTWD(result.totalNeededBeforeRetire) })]),
        el('p', {}, [document.createTextNode('尚欠總資金缺口：'), el('span', { class: 'mono neg', text: Money.formatTWD(result.totalFundingGap) })]),
        el('p', {}, [document.createTextNode('往後應有平均月薪：'), el('span', { class: 'mono big', text: Money.formatTWD(result.requiredAvgMonthlySalary) })]),
        el('p', {}, [document.createTextNode('明年應有月薪目標（依你設定的成長率）：'), el('span', { class: 'mono', text: Money.formatTWD(result.nextYearTargetSalary) })]),
        scenario.retireAgeSolveMode === 'given_growth_rate' ? el('p', {}, [
          document.createTextNode('以此薪資成長率反推，預計可退休年齡：'),
          el('span', { class: 'mono big', text: result.solvedRetireAge ? result.solvedRetireAge + ' 歲' : '70 歲前無法達成（請調整假設）' })
        ]) : empty(),
        el('details', {}, [el('summary', { text: '顯示算式' }), el('pre', { class: 'formula', text: result.formulaText })])
      ]),
      el('div', { class: 'card detail-only' }, [
        el('h3', { text: '目前月薪分配建議（以勞健保扣除後淨薪為基準）' }),
        el('p', { class: 'notice', text: `分配基準（勞健保扣除後淨薪粗估）：${Money.formatTWD(result.allocationBaseNet)}　｜　比例加總：${(result.allocationSumPct * 100).toFixed(1)}%${Math.abs(result.allocationSumPct - 1) > 0.001 ? '　｜　未達 100%，建議調整' : '　｜　已完整分配'}` }),
        el('table', {}, [
          el('thead', {}, [el('tr', {}, [el('th', { text: '項目' }), el('th', { text: '比例（可編輯）' }), el('th', { text: '金額' })])]),
          el('tbody', {}, result.allocation.map((a) => el('tr', {}, [
            el('td', { text: a.label }),
            el('td', {}, [el('input', {
              type: 'number', step: '0.01', class: 'mono', value: a.pct,
              onchange: (ev) => {
                scenario.allocationPercents[a.label] = Number(ev.target.value);
                IO.markDirty(); renderEstimator();
              }
            }), document.createTextNode(' (' + (a.pct * 100).toFixed(0) + '%)')]),
            el('td', { class: 'mono', text: Money.formatTWD(a.amountCents) })
          ])))
        ]),
        el('p', { class: 'notice', text: '這些預設比例只是起始值，建議對照帳本「成本試算」分頁的分類支出小計或月度彙總的實際數字，手動調整成符合你真實固定開銷的比例，讓分配貼近實際狀況。' })
      ])
    );
  };

  const renderCompare = () => {
    const root = $('#estimator-body');
    const house = scenarios.find((s) => s.scenarioId === 'buy_house');
    const build = scenarios.find((s) => s.scenarioId === 'self_build');
    if (!house || !build) { root.textContent = '找不到買房或買地自建情境可供比較。'; return; }
    const rh = Money.calcScenario(house, config);
    const rb = Money.calcScenario(build, config);
    root.innerHTML = '';
    root.append(el('table', { class: 'compare-table' }, [
      el('thead', {}, [el('tr', {}, [el('th', { text: '項目' }), el('th', { text: house.label }), el('th', { text: build.label })])]),
      el('tbody', {}, [
        el('tr', {}, [el('td', { text: '總額' }), el('td', { class: 'mono', text: Money.formatTWD(rh.total) }), el('td', { class: 'mono', text: Money.formatTWD(rb.total) })]),
        el('tr', {}, [el('td', { text: '通膨後總額' }), el('td', { class: 'mono', text: Money.formatTWD(rh.inflated) }), el('td', { class: 'mono', text: Money.formatTWD(rb.inflated) })]),
        el('tr', {}, [el('td', { text: '貸後金額' }), el('td', { class: 'mono', text: Money.formatTWD(rh.afterLoan) }), el('td', { class: 'mono', text: Money.formatTWD(rb.afterLoan) })]),
        el('tr', {}, [el('td', { text: '通膨後貸後金額' }), el('td', { class: 'mono', text: Money.formatTWD(rh.inflatedAfterLoan) }), el('td', { class: 'mono', text: Money.formatTWD(rb.inflatedAfterLoan) })])
      ])
    ]));
  };

  const renderEstimator = () => {
    if (compareMode) { renderCompare(); renderAllocationDashboard(); return; }
    const scenario = currentScenario();
    if (!scenario) return;
    const type = Money.getScenarioType(scenario);
    if (type === 'periods') renderPeriodScenario(scenario);
    else if (type === 'retirement_fund') renderRetirementFundScenario(scenario);
    else if (type === 'fire') renderFireScenario(scenario);
    else renderOneTimeScenario(scenario);
    // 情境允許暫時不合法地保存（見 restoreWorkspace），所以要在這裡明確告知哪些欄位還要修正
    const issues = Validation.validateScenario(scenario).errors;
    if (issues.length) $('#estimator-body').prepend(el('p', { class: 'neg', text: `此情境有欄位需要修正，試算結果可能不正確：${issues.map(e => e.message).join('；')}` }));
    renderAllocationDashboard();
    if (config.quickPlan.goalScenarioId === scenario.scenarioId) renderHealth();
  };

  const offerScenarioForAllocation = (scenario) => {
    ensureDashboard();
    if (!confirm(`是否立即將「${scenario.label}」加入首頁本月資金分配？`)) return;
    config.dashboard.scenarioSelections[scenario.scenarioId] = true;
    config.dashboard.scenarioAccountMap[scenario.scenarioId] = config.dashboard.livingAccountId || config.accountProfiles[0]?.id || "";
    config.dashboard.scenarioTargetMonths[scenario.scenarioId] = config.quickPlan.goalTargetMonth;
  };

  const initEstimatorControls = () => {
    renderScenarioSelector();
    $('#compare-toggle').addEventListener('change', (ev) => { compareMode = ev.target.checked; renderEstimator(); });
    $('#new-scenario').addEventListener('click', () => {
      const label = prompt('新情境名稱', '自訂成本試算')?.trim();
      if (!label) return;
      const scenario = { schemaVersion: 2, scenarioId: `custom-${Date.now()}`, label, custom: true, currency: 'TWD', rateToTWD: 1, calcType: 'items', applyInflation: false, inflationKey: 'TW', currentSavedCents: 0, loanAmountCents: 0, items: [{ label: '新項目', kind: 'cost', amountCents: 0 }] };
      scenarios.push(scenario); offerScenarioForAllocation(scenario); currentScenarioId = scenario.scenarioId; compareMode = false;
      renderScenarioSelector(); renderEstimator(); renderHealth(); IO.markDirty();
    });
    $('#duplicate-scenario').addEventListener('click', () => {
      const source = currentScenario();
      if (!source) return;
      const copy = structuredClone(source);
      copy.scenarioId = `custom-${Date.now()}`; copy.label = `${source.label}・副本`; copy.custom = true;
      delete copy.mortgage; delete copy.repayment;
      scenarios.push(copy); offerScenarioForAllocation(copy); currentScenarioId = copy.scenarioId; compareMode = false;
      renderScenarioSelector(); renderEstimator(); renderHealth(); IO.markDirty();
    });
    $('#rename-scenario').addEventListener('click', () => {
      const scenario = currentScenario();
      if (!scenario) return;
      const label = prompt('情境名稱', scenario.label)?.trim();
      if (!label) return;
      scenario.label = label; renderScenarioSelector(); renderEstimator(); renderHealth(); IO.markDirty();
    });
    $('#delete-scenario').addEventListener('click', () => {
      const scenario = currentScenario();
      if (!scenario?.custom) return;
      if (!confirm(`確定刪除「${scenario.label}」？`)) return;
      scenarios = scenarios.filter(item => item.scenarioId !== scenario.scenarioId);
      delete config.dashboard.scenarioSelections[scenario.scenarioId];
      delete config.dashboard.scenarioAccountMap[scenario.scenarioId];
      delete config.dashboard.scenarioTargetMonths[scenario.scenarioId];
      if (config.quickPlan.goalScenarioId === scenario.scenarioId) config.quickPlan.goalScenarioId = 'manual';
      currentScenarioId = scenarios[0]?.scenarioId; compareMode = false;
      renderScenarioSelector(); renderEstimator(); renderHealth(); IO.markDirty();
    });
  };

  // ================= 工時反推 Tab =================
  const renderWageReverse = () => {
    const root = $('#wage-body');
    if (!root) return;
    const s = wageReverseScenario;
    const incomeFlows = (config.recurringCashFlows || []).filter(f => f.type === 'income' && f.active !== false);
    if ((!s.linkedRecurringFlowId || s.linkedRecurringFlowId === 'auto') && incomeFlows.length) s.linkedRecurringFlowId = incomeFlows[0].id;
    else if (!incomeFlows.length && s.linkedRecurringFlowId === 'auto') s.linkedRecurringFlowId = 'custom';
    let linkedFlow = incomeFlows.find(f => f.id === s.linkedRecurringFlowId);
    if (s.linkedRecurringFlowId !== 'custom' && !linkedFlow) s.linkedRecurringFlowId = 'custom';
    linkedFlow = syncWageFromLinkedIncome();
    if (!Number.isFinite(s.grossMonthlySalaryCents)) s.grossMonthlySalaryCents = s.insuredSalaryCents || 0;
    if (!Number.isFinite(s.monthlyWorkHours) || s.monthlyWorkHours <= 0) s.monthlyWorkHours = 160;
    if (s.insuredSalaryFollowsGross === undefined) s.insuredSalaryFollowsGross = false;
    if (s.insuredSalaryFollowsGross) s.insuredSalaryCents = s.grossMonthlySalaryCents;
    const payroll = Money.calcPayroll(s.grossMonthlySalaryCents, s.monthlyWorkHours, s.insuredSalaryCents, config.insuranceRates);
    s.baseRateCentsPerHour = payroll.hourlyRateCents;
    const result = Money.calcWageReverse(s, config);

    root.innerHTML = '';
    root.append(
      el('div', { class: 'card wage-source-card' }, [
        el('div', { class: 'section-heading' }, [el('div', {}, [el('h3', { text: '收入來源與時薪' }), el('p', { class: 'notice', text: '選擇既有收入即可自動沿用；只有自訂模式需要輸入。' })])]),
        el('div', { class: 'field source-field' }, [
          el('label', { text: '使用收入來源' }),
          el('select', { onchange: e => { s.linkedRecurringFlowId = e.target.value; IO.markDirty(); renderWageReverse(); } }, [
            ...incomeFlows.map(f => el('option', { value: f.id, text: `${f.name || recurringKinds[f.kind]}・${Money.formatTWD(f.amountCents)}`, selected: s.linkedRecurringFlowId === f.id ? 'selected' : undefined })),
            el('option', { value: 'custom', text: '自訂收入', selected: s.linkedRecurringFlowId === 'custom' ? 'selected' : undefined })
          ])
        ]),
        linkedFlow ? el('p', { class: 'linked-note', text: `已連動「${linkedFlow.name || recurringKinds[linkedFlow.kind]}」的月收入、工時、投保薪資與勞健保設定。` }) : el('div', { class: 'toolbar' }, [
          el('div', { class: 'field' }, [el('label', { text: '月總工資（稅前）' }), el('input', { type: 'number', value: Money.toYuan(s.grossMonthlySalaryCents), onchange: (ev) => { const v = Money.toCents(ev.target.value); if (!(v > 0)) return alert('月總工資必須大於 0'); s.grossMonthlySalaryCents = v; IO.markDirty(); renderWageReverse(); } })]),
          el('div', { class: 'field' }, [el('label', { text: '每月工作時數' }), el('input', { type: 'number', step: '0.5', value: s.monthlyWorkHours, onchange: (ev) => { const v = Number(ev.target.value); if (!(v > 0)) return alert('月工時必須大於 0'); s.monthlyWorkHours = v; IO.markDirty(); renderWageReverse(); } })]),
          el('label', {}, [el('input', { type: 'checkbox', checked: s.insuredSalaryFollowsGross ? 'checked' : undefined, onchange: (ev) => { s.insuredSalaryFollowsGross = ev.target.checked; IO.markDirty(); renderWageReverse(); } }), document.createTextNode(' 投保薪資同月總工資')]),
          !s.insuredSalaryFollowsGross ? el('div', { class: 'field' }, [el('label', { text: '投保薪資' }), el('input', { type: 'number', value: Money.toYuan(s.insuredSalaryCents), onchange: (ev) => { s.insuredSalaryCents = Money.toCents(ev.target.value); IO.markDirty(); renderWageReverse(); } })]) : null
        ]),
        el('div', { class: 'health-grid' }, [
          el('div', { class: 'summary-block' }, [el('h3', { text: '自動回算時薪' }), el('p', { class: 'mono big', text: Money.formatTWD(payroll.hourlyRateCents) })]),
          el('div', { class: 'summary-block' }, [el('h3', { text: '勞保自付' }), el('p', { class: 'mono big', text: Money.formatTWD(payroll.laborFee) })]),
          el('div', { class: 'summary-block' }, [el('h3', { text: '健保自付' }), el('p', { class: 'mono big', text: Money.formatTWD(payroll.healthFee) })]),
          el('div', { class: 'summary-block' }, [el('h3', { text: '勞健保扣除後粗估' }), el('p', { class: 'mono big', text: Money.formatTWD(payroll.net) })])
        ]),
        el('p', { class: 'notice', text: '時薪 ＝ 月總工資 ÷ 月工時；勞健保依個人參數中的費率及投保薪資計算。' })
      ]),
      el('div', { class: 'toolbar editor-only' }, [
        el('div', { class: 'field' }, [
          el('label', { text: '目標金額' }),
          el('input', {
            type: 'number', class: 'mono', value: Money.toYuan(s.targetAmountCents),
            onchange: (ev) => { s.targetAmountCents = Money.toCents(ev.target.value); IO.markDirty(); renderWageReverse(); }
          })
        ]),
        el('div', { class: 'field' }, [
          el('label', { text: '幣別' }),
          el('select', {
            onchange: (ev) => { s.currency = ev.target.value; IO.markDirty(); renderWageReverse(); }
          }, ['TWD', 'EUR', 'JPY', 'USD'].map((c) => el('option', { value: c, text: c, selected: s.currency === c ? 'selected' : undefined })))
        ]),
        s.currency !== 'TWD' ? el('div', { class: 'field' }, [
          el('label', { text: '台幣匯率' }),
          el('input', {
            type: 'number', step: '0.0001', class: 'mono', value: s.rateToTWD,
            onchange: (ev) => { s.rateToTWD = Number(ev.target.value); IO.markDirty(); renderWageReverse(); }
          })
        ]) : null,
        el('div', { class: 'field' }, [
          el('label', { text: '時薪（由上方自動計算）' }),
          el('input', {
            type: 'number', class: 'mono', value: Money.toYuan(s.baseRateCentsPerHour), readonly: 'readonly'
          })
        ]),
        el('label', {}, [
          el('input', {
            type: 'checkbox', checked: s.applyInsurance ? 'checked' : undefined, disabled: linkedFlow ? 'disabled' : undefined,
            onchange: (ev) => { s.applyInsurance = ev.target.checked; IO.markDirty(); renderWageReverse(); }
          }),
          document.createTextNode(linkedFlow ? ' 沿用收入來源的勞健保設定' : ' 此收入扣除勞健保')
        ])
      ]),
      s.applyInsurance && !linkedFlow ? el('div', { class: 'field editor-only' }, [
        el('label', { text: '投保薪資（元）' }),
        el('input', {
          type: 'number', class: 'mono', value: Money.toYuan(s.insuredSalaryCents),
          onchange: (ev) => { s.insuredSalaryCents = Money.toCents(ev.target.value); IO.markDirty(); renderWageReverse(); }
        })
      ]) : empty(),
      el('div', { class: 'result-block' }, [
        el('p', {}, [document.createTextNode('換算成台幣目標：'), el('span', { class: 'mono', text: Money.formatTWD(result.targetTWD) })]),
        s.applyInsurance ? el('p', {}, [document.createTextNode('墊高勞健保後的實際目標：'), el('span', { class: 'mono', text: Money.formatTWD(result.effectiveTarget) })]) : null,
        el('p', {}, [document.createTextNode('週末班時數：'), el('span', { class: 'mono big', text: result.baseUnits.toLocaleString() + ' 小時' })])
      ]),
      el('div', { class: 'card wage-detail-card' }, [
        el('h3', { text: '換算路徑（半日班）' }),
        el('table', {}, [el('tbody', {}, result.chain.map((step) => el('tr', {}, [
          el('td', { text: step.label }), el('td', { class: 'mono', text: step.rounded.toLocaleString() })
        ])))])
      ]),
      result.altChain ? el('div', { class: 'card wage-detail-card' }, [
        el('h3', { text: '換算路徑（整日班）' }),
        el('table', {}, [el('tbody', {}, result.altChain.map((step) => el('tr', {}, [
          el('td', { text: step.label }), el('td', { class: 'mono', text: step.rounded.toLocaleString() })
        ])))])
      ]) : empty(),
      el('p', { class: 'notice', text: '精度規則：每一層用「上一步無條件進位後的整數」往下除，已用真實數字驗證過此規則。' })
    );
  };

  // ================= 匯入 / 匯出 =================
  const initIO = () => {
    $('#choose-storage-location').addEventListener('click', async () => {
      try {
        const filename = await IO.bindWorkspaceFile();
        renderPersonalSettings();
        alert(`已綁定並保存至 ${filename}`);
      } catch (err) {
        if (err.name !== 'AbortError') alert(err.message);
      }
    });
    $('#export-ledger').addEventListener('click', () => IO.exportJson(ledger, 'ledger'));
    $('#export-config').addEventListener('click', () => IO.exportJson(config, 'config'));
    $('#export-scenarios').addEventListener('click', () => IO.exportJson({ schemaVersion: 2, scenarios }, 'estimator_scenarios'));
    $('#export-wage').addEventListener('click', () => IO.exportJson(wageReverseScenario, 'wage_reverse_scenario'));
    $('#export-workspace').addEventListener('click', () => IO.exportJson({ schemaVersion: 1, savedAt: new Date().toISOString(), ...workspaceSnapshot() }, 'finance_tools_workspace'));
    $('#restore-workspace').addEventListener('click', async () => {
      try {
        const previous = await IO.loadPreviousWorkspace();
        if (!previous) { alert('目前尚無可回復的滾動版本'); return; }
        if (!confirm(`確定回復到 ${new Date(previous.savedAt).toLocaleString('zh-Hant-TW')} 的版本？`)) return;
        if (!restoreWorkspace(previous)) { alert('歷史版本資料驗證失敗，未進行還原'); return; }
        materializeDueRecurringEntries(); renderScenarioSelector(); renderAll(); renderLedgerForm(); IO.markDirty(); alert('已回復上一版本');
      } catch (err) { alert(`無法回復版本：${err.message}`); }
    });

    $('#import-file').addEventListener('change', async (ev) => {
      const file = ev.target.files[0];
      if (!file) return;
      try {
        const data = await IO.importJsonFile(file, { expectedSchemaVersion: 2 });
        if (data.config && data.ledger && data.scenarios) {
          if (!restoreWorkspace(data)) throw new Error('完整工作區格式不正確');
          materializeDueRecurringEntries(); renderScenarioSelector(); renderAll(); renderLedgerForm(); IO.markDirty(); alert('完整工作區已匯入並保存至瀏覽器本機資料');
        }
        else if (data.entries) {
          const checked = Validation.validateImported(data, 'ledger');
          if (!checked.valid) throw new Error('帳本驗證失敗：\n' + checked.errors.map(e => `${e.path} ${e.message}`).join('\n'));
          ledger = data; renderLedger(); IO.markDirty(); alert('帳本資料已匯入並保存至瀏覽器本機資料');
        }
        else if (data.scenarios) {
          const checked = Validation.validateScenarios(data);
          if (!checked.valid) throw new Error('情境驗證失敗：\n' + checked.errors.map(e => `${e.path} ${e.message}`).join('\n'));
          scenarios = data.scenarios.map(Validation.normalizeScenario); currentScenarioId = scenarios[0]?.scenarioId;
          Validation.repairWorkspace({ config, scenarios }, DEFAULT_CONFIG); renderScenarioSelector(); renderEstimator(); IO.markDirty(); alert('成本試算情境已匯入並保存至瀏覽器本機資料');
        }
        else if (data.conversionChain) {
          const checked = Validation.validateWage(data);
          if (!checked.valid) throw new Error('工時設定驗證失敗：\n' + checked.errors.map(e => `${e.path} ${e.message}`).join('\n'));
          wageReverseScenario = data; renderWageReverse(); IO.markDirty(); alert('工時反推設定已匯入並保存至瀏覽器本機資料');
        }
        else if (data.categories) {
          if (!data.quickPlan) data.quickPlan = structuredClone(DEFAULT_CONFIG.quickPlan);
          const checked = Validation.validateQuickPlan(data.quickPlan);
          if (!checked.valid) throw new Error('設定驗證失敗：\n' + checked.errors.map(e => e.message).join('\n'));
          if (!Array.isArray(data.recurringCashFlows)) data.recurringCashFlows = [];
          const recurringChecked = Validation.validateRecurringFlows(data.recurringCashFlows);
          if (!recurringChecked.valid) throw new Error('固定出入帳驗證失敗：\n' + recurringChecked.errors.map(e => `${e.path} ${e.message}`).join('\n'));
          config = data; materializeDueRecurringEntries(); renderHealth(); renderLedgerForm(); renderLedger(); renderPersonalSettings(); IO.markDirty(); alert('設定檔已匯入並保存至瀏覽器本機資料');
        }
        else { alert('無法辨識這份 JSON 的內容類型'); }
      } catch (err) {
        alert(err.message);
      }
      ev.target.value = '';
    });
  };

  // 輸入框按 Enter 就確認並保存：移開焦點會觸發瀏覽器原生的 change（只觸發一次，各瀏覽器一致）。
  // 中文輸入法選字時的 Enter（isComposing）不能攔，否則選不了字。
  const initEnterToCommit = () => {
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' || ev.isComposing || ev.keyCode === 229) return;
      const t = ev.target;
      if (!(t instanceof HTMLInputElement) || ['button', 'submit', 'checkbox', 'radio', 'file'].includes(t.type)) return;
      ev.preventDefault();
      t.blur();
    });
  };

  const init = () => {
    IO.configurePersistence(workspaceSnapshot, updateStorageStatus);
    initEnterToCommit();
    const saved = IO.loadWorkspace();
    if (saved && !restoreWorkspace(saved)) {
      // 不能靜默改用預設值：下一次自動保存就會覆寫使用者原本的資料
      try { localStorage.setItem('finance-tools.workspace.rejected', JSON.stringify(saved)); } catch {}
      const detail = lastRestoreErrors.slice(0, 5).map(e => `${e.path} ${e.message}`).join('\n');
      if (confirm(`本機工作區資料驗證失敗，暫以預設值開啟：\n${detail}\n\n原始資料已另存於瀏覽器（finance-tools.workspace.rejected）。是否立即下載原始資料備份？`)) IO.exportJson(saved, 'finance_tools_workspace_rejected');
    }
    syncCurrentAgeFromBirthYear();
    IO.initializeFileBinding().then(() => renderPersonalSettings());
    IO.requestPersistentStorage();
    initTabs();
    materializeDueRecurringEntries();
    renderHealth();
    renderLedgerForm();
    renderLedger();
    renderPersonalSettings();
    initEstimatorControls();
    renderEstimator();
    renderWageReverse();
    initViewMode();
    initIO();
  };

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);