// config.js — 預設設定值（反推自原 Google Sheet，供首次使用與後續滾動修正）
// 所有金額單位為「分」（cents）。標記 [反推] 的數字是從原表數字互相核對後還原，已驗證公式一致；
// 標記 [待確認] 的部分原表結構有合併儲存格疑慮，先給合理預設，之後可直接在畫面上調整。
// v8 更新：不再有共用匯率表，改成每筆帳目/情境自帶 currency + rateToTWD 手動輸入。

const DEFAULT_CONFIG = {
  schemaVersion: 2,
  ui: { viewMode: 'simple', activeTab: 'health', currentScenarioId: 'buy_house', expandedDetails: [] },
  // [反推] TW/JP/EU 通膨倍數：驗證方式為「總額 × 倍數 = 原表通膨後總額」，三個情境交叉核對皆吻合
  inflationMultipliers: { TW: 1.58, JP: 1.3, EU: 1.291 },
  categories: ['食', '超商', '飲料', '手續費', '娛', '居家', '行', '學用', '3C'],
  accounts: ['華南', '遠東', '狗狗', '聯邦', '王道', '台新', '現金', '郵局', '元大', '玉山', '合作'],
  accountProfiles: [
    { id: 'cash', name: '現金', nature: 'cash', initialBalanceCents: 0 },
    { id: 'bank', name: '主要銀行', nature: 'checking', initialBalanceCents: 0 }
  ],
  recurringCashFlows: [],
  dashboard: {
    livingAccountId: 'bank',
    fixedExpenseAccountId: 'bank',
    emergencyAccountId: 'bank',
    scenarioSelections: {},
    scenarioAccountMap: {},
    scenarioTargetMonths: {},
    summaryCards: [
      { id: 'income', source: 'income', label: '月收入', visible: true, builtIn: true },
      { id: 'fixed-expense', source: 'fixedExpense', label: '固定支出', visible: true, builtIn: true },
      { id: 'recommended-saving', source: 'recommendedSaving', label: '應儲蓄', visible: true, builtIn: true },
      { id: 'daily-living', source: 'dailyLiving', label: '每日生活費', visible: true, builtIn: true },
      { id: 'monthly-flex', source: 'monthlyFlex', label: '月度餘裕', visible: true, builtIn: true }
    ]
  },
  // [反推] 原表「目標上限」列
  budgetLimitsCents: {
    食: 200000, 超商: 10000, 飲料: 0, 手續費: 1500,
    娛: 0, 居家: 10000, 行: 20000, 學用: 30000, '3C': 60000
  },
  // 佔位示意值，非反推結果，請至勞保局/健保署官網核對最新費率與自己的投保薪資後修改
  insuranceRates: {
    laborInsuranceRate: 0.115,
    laborInsurancePersonalShare: 0.20,
    healthInsuranceRate: 0.0517,
    healthInsurancePersonalShare: 0.30,
    note: '佔位示意值，請至勞保局/健保署官網核對最新費率後自行修改'
  },
  // 用於「存款版」工時反推提示（跟工時反推引擎的費率設定無關，只用來算存錢版的達成月數/年齡）
  personalBaseline: {
    birthYear: 2004,
    currentAge: 22,
    monthlySavingsCapacityCents: 0
  },
  quickPlan: {
    currentAge: 22,
    monthlyNetIncomeCents: 3300000,
    monthlyEssentialExpenseCents: 1800000,
    monthlyOtherExpenseCents: 700000,
    liquidAssetsCents: 5000000,
    goalScenarioId: 'manual',
    emergencyTargetMonths: 6,
    goalAmountTodayCents: 30000000,
    goalDeadlineMode: 'month',
    goalTargetMonth: '2028-12',
    goalTargetAge: 30,
    inflationAnnualRate: REFERENCE_DATA.twInflation.annualRate,
    nominalReturnAnnualRate: 0.05
  },
  lastUpdated: null
};

const DEFAULT_LEDGER = { schemaVersion: 2, entries: [] };

// 首頁分配用途（依分配先後）：新增用途只要加在這裡，「必備分配帳戶」選單、帳戶檢查與修復都會自動帶到
// field＝dashboard 上存搭配帳戶的欄位；尚未選過時用 fallback 欄位的帳戶，沒有 fallback 就用第一個帳戶
const ALLOCATION_PURPOSES = [
  { key: 'fixed', label: '固定支出', field: 'fixedExpenseAccountId' },
  { key: 'living', label: '基本生活需求', field: 'livingAccountId' },
  { key: 'emergency', label: '緊急預備金', field: 'emergencyAccountId' },
  { key: 'saving', label: '一般儲蓄', field: 'savingAccountId', fallback: 'emergencyAccountId' }
];

// [反推] 買房費用情境：數字取自原表「買房費用（估計）」欄，公式已用「通膨後總額」「貸後金額」交叉驗證
const SCENARIO_BUY_HOUSE = {
  schemaVersion: 2,
  currency: 'TWD',
  rateToTWD: 1,
  calcType: 'items',
  scenarioId: 'buy_house',
  label: '買房成本試算',
  applyInflation: true,
  inflationKey: 'TW',
  items: [
    { label: '房價', amountCents: 1500000000 },
    { label: '房屋鑑價費', amountCents: 500000 },
    { label: '帳管費', amountCents: 800000 },
    { label: '貸款開辦費', amountCents: 800000 },
    { label: '代書費', amountCents: 500000 },
    { label: '仲介費', amountCents: 30000000 },
    { label: '設計費', amountCents: 48000000 },
    { label: '裝潢費', amountCents: 320000000 },
    { label: '履約保證專戶', amountCents: 450000 },
    { label: '契稅', amountCents: 90000000 },
    { label: '印花稅', amountCents: 90000 },
    { label: '產權移轉登記', amountCents: 7514307 },
    { label: '貸款設定規費', amountCents: 1260000 },
    { label: '保險費', amountCents: 200000 }
  ],
  downPaymentCurrentCents: 8937400,
  downPaymentRequiredCents: 750000000,
  loanAmountCents: 1050000000,
  mortgage: {
    purchaseAge: 30, annualRate: 0.0337, termYears: 30, graceYears: 0,
    principalMode: 'estimated', manualPrincipalCents: 0,
    includeAsFixedExpense: false, paymentDay: 5, accountId: '', reserveMonths: 6,
    loanPosition: 'first_home'
  }
};

// [反推] 買地自建費用情境，項目與買房情境不同，但共用同一套計算引擎
const SCENARIO_SELF_BUILD = {
  schemaVersion: 2,
  currency: 'TWD',
  rateToTWD: 1,
  calcType: 'items',
  scenarioId: 'self_build',
  label: '買地自建成本試算',
  applyInflation: true,
  inflationKey: 'TW',
  items: [
    { label: '鑑界費', amountCents: 5280 },
    { label: '水保技師費', amountCents: 1500000 },
    { label: '貸款開辦費', amountCents: 800000 },
    { label: '代書費', amountCents: 500000 },
    { label: '仲介費', amountCents: 2000000 },
    { label: '地價', amountCents: 100000000 },
    { label: '自建費用（建材/安裝/設備）', amountCents: 800000000 },
    { label: '室內設計費', amountCents: 21840000 },
    { label: '建築設計費', amountCents: 33600000 },
    { label: '裝潢費', amountCents: 320000000 },
    { label: '履約保證專戶', amountCents: 30000 },
    { label: '契稅', amountCents: 6000000 },
    { label: '印花稅', amountCents: 6000 },
    { label: '產權移轉登記', amountCents: 7514307 },
    { label: '貸款設定規費', amountCents: 72000 },
    { label: '保險費', amountCents: 200000 }
  ],
  downPaymentCurrentCents: 8937400,
  downPaymentRequiredCents: 70000000,
  loanAmountCents: 460000000
};

// [反推] 旅費情境：機票/民宿一次性 + 交通/伙食/娛樂為每日×10天加總，套用日本通膨倍數
const SCENARIO_TRIP_BUDGET = {
  schemaVersion: 2,
  currency: 'TWD',
  rateToTWD: 1,
  calcType: 'items',
  scenarioId: 'trip_budget',
  label: '旅費預算試算',
  applyInflation: true,
  inflationKey: 'JP',
  items: [
    { label: '機票', amountCents: 1000000 },
    { label: '民宿', amountCents: 1800000 },
    { label: '交通費用（10日）', amountCents: 210000 },
    { label: '伙食費（10日）', amountCents: 420000 },
    { label: '娛樂費（10日）', amountCents: 2100000 }
  ]
};

// [待確認] 學貸情境：學期總結公式已反推驗證（學雜費總額+電腦網路通訊費+平安保險費，語言教學費不計入），
// 但「學年總結」跨學期加總的排列方式原表有合併儲存格疑慮，此處先以 8 學期逐期呈現，
// 待你對照原表確認學年加總的實際分組方式後再調整。
const SCENARIO_STUDENT_LOAN = {
  schemaVersion: 2,
  currency: 'TWD',
  rateToTWD: 1,
  calcType: 'periods',
  scenarioId: 'student_loan',
  label: '學貸攤還試算',
  applyInflation: false,
  itemTemplate: [
    { label: '學費', amountCents: 4012500 },
    { label: '雜費', amountCents: 809200 },
    { label: '減免', kind: 'discount', amountCents: 1750000 },
    { label: '電腦網路通訊費', amountCents: 125000 },
    { label: '平安保險費', amountCents: 23500 }
  ],
  periods: [
    { label: '大一上', overrides: { 減免: 0 } },
    { label: '大一下', overrides: {} },
    { label: '大二上', overrides: {} },
    { label: '大二下', overrides: {} },
    { label: '大三上', overrides: {} },
    { label: '大三下', overrides: {} },
    { label: '大四上', overrides: {} },
    { label: '大四下', overrides: {} }
  ],
  repayment: {
    graduationAge: 22, graceYears: 2, annualRate: 0.00775,
    termPlan: 'standard', includeAsFixedExpense: false,
    paymentDay: 5, accountId: '', principalMode: 'estimated',
    manualPrincipalCents: 0, reserveMonths: 3
  }
};

// [反推＋驗證] 喪葬費情境：項目加總與原表「預估喪葬所需總額」56,000 完全吻合
const SCENARIO_FUNERAL = {
  schemaVersion: 2,
  currency: 'TWD',
  rateToTWD: 1,
  calcType: 'items',
  scenarioId: 'funeral',
  label: '喪葬費用試算',
  applyInflation: false,
  items: [
    { label: '樹灑葬（歸思園/大坑樹灑葬區）', amountCents: 600000 },
    { label: '葬儀社行情價', amountCents: 5000000 }
  ],
  // 目前已為此項目存下的金額，請自行填入；差額 = 總額 － 已存
  currentSavedCents: 0
};

// [反推＋驗證] 養老金情境：公式為「每月生活費 × 12 × 退休後餘命年數」，可選是否套用通膨倍數
// 驗證方式：此為標準精算估算法，非原表逐格覆刻（原表己估/均估兩欄用了較複雜的複利成長試算，
// 無法從錯位表格完全還原），採用透明、可核對的簡化公式，你可在畫面上直接調整任一輸入值。
const SCENARIO_ELDERCARE_FUND = {
  schemaVersion: 2,
  currency: 'TWD',
  rateToTWD: 1,
  calcType: 'retirement_fund',
  scenarioId: 'eldercare_fund',
  label: '養老金試算',
  currentAge: 19,
  retireAge: 60,
  deathAge: 85,
  monthlyLivingCostCents: 190100,
  applyInflation: true,
  inflationKey: 'TW',
  // 目前已提撥的養老金存款，請自行填入
  currentSavedCents: 0,
  referenceNote: '參考數值：台中單人 111 年平均每月生活費約 18,566 元（僅供對照，不影響計算）'
};

// [反推＋驗證] FIRE／退休財務獨立試算：以下每一步公式都已對照原表數字逐項核對，完全吻合
// 例：退休資產目標=年支出/報酬率、退休前總需求資金=退休資產目標+買房目標+留學金+緊急儲備、
//     往後應有月薪=(資金缺口+退休前總支出)/(剩餘工作月數)
const SCENARIO_FIRE = {
  schemaVersion: 2,
  currency: 'TWD',
  rateToTWD: 1,
  calcType: 'fire',
  scenarioId: 'fire_retirement',
  label: 'FIRE／財務獨立退休試算',
  startAge: 21,
  retireAge: 35,
  deathAge: 85,
  currentMonthlySalaryCents: 3300000,
  currentMonthlyExpenseCents: 2500000,
  retirementMonthlyExpenseCents: 5000000,
  postRetirementAnnualReturnRate: 0.05,
  retirementFundingModel: 'perpetuity',
  retirementInflationAnnualRate: REFERENCE_DATA.twInflation.annualRate,
  buyHouseGoalCents: 3000000000,
  studyAbroadFundCents: 300000000,
  emergencyFundMonths: 12,
  totalSavedCents: 4344100,
  // v8 新增：薪資是稅前(gross)或稅後(net)，影響是否套用勞健保換算
  salaryType: 'gross',
  insuredSalaryCents: 3300000,
  // v8 新增：'given_age' 用退休年齡算應有月薪；'given_growth_rate' 用薪資成長率反推退休年齡
  retireAgeSolveMode: 'given_age',
  // 你自己設定的「明年薪資成長假設」，用來反推「明年應有月薪目標」；
  // 旁邊會同時顯示「理論上需要的年成長率」供對照，兩者不一致很正常，代表現實與理想的落差
  assumedSalaryGrowthRate: 0.2,
  // 退休前累積資產所用的名目年報酬假設；反推退休年齡會按月複利並納入生活費與全部目標。
  preRetirementAnnualReturnRate: 0.05,
  // 目前月薪的分配比例（總和須為 1.0），用來看目前薪水打算怎麼分配運用
  allocationPercents: {
    '投資提撥（FIRE 基金）': 0.20,
    '留學儲備金': 0.10,
    '緊急儲備金提撥': 0.05,
    '住宿支出': 0.25,
    '自煮伙食費': 0.10,
    '外食/社交餐飲': 0.10,
    '水電/通訊/保險': 0.10,
    '娛樂支出': 0.05,
    '額外活動資金': 0.05
  }
};

const DEFAULT_SCENARIOS = [
  SCENARIO_BUY_HOUSE, SCENARIO_SELF_BUILD, SCENARIO_TRIP_BUDGET, SCENARIO_STUDENT_LOAN,
  SCENARIO_FUNERAL, SCENARIO_ELDERCARE_FUND, SCENARIO_FIRE
];

// [反推＋驗證] 工時反推計算機：用「期望收益 910,626」與「學貸還款 155,893」兩組真實數字交叉驗證，
// 換算鏈與「上一步四捨五入後才往下除」的精度規則皆已確認吻合原表。
const WAGE_REVERSE_SCENARIO = {
  schemaVersion: 1,
  scenarioId: 'wage_reverse_default',
  label: '目標收入反推工時',
  targetAmountCents: 0,
  currency: 'TWD',
  rateToTWD: 1,
  baseRateCentsPerHour: 21000,
  grossMonthlySalaryCents: 3300000,
  monthlyWorkHours: 160,
  insuredSalaryFollowsGross: true,
  linkedRecurringFlowId: 'auto',
  applyInsurance: false,
  insuredSalaryCents: 3300000,
  conversionChain: [
    { fromLabel: '週末班時數', toLabel: '半日班數', factor: 5, op: 'divide' },
    { fromLabel: '半日班數', toLabel: '半日週數', factor: 2, op: 'divide' }
  ],
  altChain: [
    { fromLabel: '週末班時數', toLabel: '整日班數', factor: 8, op: 'divide' },
    { fromLabel: '整日班數', toLabel: '假日週數', factor: 2, op: 'divide' },
    { fromLabel: '假日週數', toLabel: '月數', factor: 4, op: 'divide' },
    { fromLabel: '月數', toLabel: '年數', factor: 12, op: 'divide' }
  ]
};