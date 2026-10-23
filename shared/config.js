// config.js — 預設設定值與本工具自訂的規劃規則；外部制度數字一律讀 reference-data.js，這裡不重寫。
// 所有金額單位為「分」（cents）。情境的項目金額只是起始範例，使用者可在畫面上調整。
// 匯率不設共用表：每筆帳目／情境自帶 currency + rateToTWD 手動輸入。

// 本工具的規劃規則（不是官方規定）：儲蓄率基準與健康分級、緊急預備金月數範圍與補足期間
const PLANNING_RULES = {
  savingsRateTarget: 0.20,
  savingsRateBands: { low: 0.10, healthy: 0.20, strong: 0.40 },
  emergencyMonths: { default: 6, min: 3, max: 18 },
  emergencyFillMonths: 12,
  livingSuggestCycles: 3, // 生活費建議值取最近幾個完整發薪週期的實際花費中位數
  habitCycles: 6, // 存花習慣看最近幾個完整發薪週期
  habitIncrease: { minCents: 50000, ratio: 0.2 }, // 分類比平常多花至少 500 元且多 20% 才提醒，免得小波動一直跳
  defaultMaxWeeklyWorkHours: 40, // 工時上限預設＝勞基法每週正常工時（REFERENCE_DATA.twLaborStandards），使用者可改
  defaultMonthlyWorkHours: 160 // 月薪換算時薪、缺月工時時的預設
};

const DEFAULT_CONFIG = {
  schemaVersion: 2,
  ui: { viewMode: 'simple', activeTab: 'health', currentScenarioId: 'buy_house', expandedDetails: [] },
  // 各地區年通膨率；預設取官方預測，使用者可覆寫。成本試算依目標月份複利換算
  inflationRates: Object.fromEntries(Object.entries(REFERENCE_DATA.inflation).map(([k, v]) => [k, v.annualRate])),
  categories: ['食', '超商', '飲料', '手續費', '娛', '居家', '行', '學用', '3C'],
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
    targetInputModes: {},
    summaryCards: [
      { id: 'income', source: 'income', label: '月收入', visible: true, builtIn: true },
      { id: 'fixed-expense', source: 'fixedExpense', label: '固定支出', visible: true, builtIn: true },
      { id: 'recommended-saving', source: 'recommendedSaving', label: '應儲蓄', visible: true, builtIn: true },
      { id: 'daily-living', source: 'dailyLiving', label: '每日生活費', visible: true, builtIn: true },
      { id: 'monthly-flex', source: 'monthlyFlex', label: '月度餘裕', visible: true, builtIn: true },
      { id: 'allocation-status', source: 'allocationStatus', label: '分配狀態', visible: true, builtIn: true }
    ]
  },
  // 受僱者個人負擔的勞保（含就業保險）與健保；預設取 reference-data.js 的官方費率
  insuranceRates: {
    laborInsuranceRate: REFERENCE_DATA.twLaborInsurance.ordinaryRate + REFERENCE_DATA.twLaborInsurance.employmentRate,
    laborInsurancePersonalShare: REFERENCE_DATA.twLaborInsurance.personalShare,
    healthInsuranceRate: REFERENCE_DATA.twHealthInsurance.rate,
    healthInsurancePersonalShare: REFERENCE_DATA.twHealthInsurance.personalShare
  },
  // monthlySavingsCapacityCents 只在沒有固定出入帳時手填；有固定出入帳時由帳本推算
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
    // 'none'＝不設定主要目標；'manual'＝自填金額；其他＝連動該成本試算情境
    goalScenarioId: 'none',
    goalNoneOption: true,
    emergencyTargetMonths: PLANNING_RULES.emergencyMonths.default,
    goalAmountTodayCents: 30000000,
    goalDeadlineMode: 'month',
    goalTargetMonth: '2028-12',
    goalTargetAge: 30,
    nominalReturnAnnualRate: 0.05
  },
  lastUpdated: null
};

const DEFAULT_LEDGER = { schemaVersion: 2, entries: [] };

// 首頁分配用途（依分配先後）：新增用途只要加在這裡，「必備分配帳戶」選單、帳戶檢查與修復都會自動帶到
// field＝dashboard 上存搭配帳戶的欄位；尚未選過時用 fallback 欄位的帳戶，沒有 fallback 就用第一個帳戶
const ALLOCATION_PURPOSES = [
  { key: 'fixed', label: '固定支出', field: 'fixedExpenseAccountId' },
  { key: 'living', label: '生活費', field: 'livingAccountId' },
  { key: 'emergency', label: '緊急預備金', field: 'emergencyAccountId' },
  { key: 'saving', label: '一般儲蓄', field: 'savingAccountId', fallback: 'emergencyAccountId' }
];

// 買房費用情境：項目金額為起始範例；通膨依目標月份與 inflationRates 複利換算
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
  loanAmountCents: 1050000000,
  mortgage: {
    purchaseAge: 30, annualRate: 0.0337, termYears: 30, graceYears: 0,
    principalMode: 'estimated', manualPrincipalCents: 0,
    includeAsFixedExpense: false, paymentDay: 5, accountId: '', reserveMonths: 6,
    loanPosition: 'first_home'
  }
};

// 買地自建費用情境，項目與買房情境不同，但共用同一套計算引擎
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
  loanAmountCents: 460000000
};

// 旅費情境：每個項目自選計算方式（整趟／每人／每天／每晚…）與幣別（台幣或目的地貨幣），
// 小計＝金額 × 數量（由天數、人數算出）× 匯率；目的地決定貨幣與通膨率。金額為起始範例。
// 晚數＝天數－1（10 天 9 晚）；「每晚」是整間房，「每人每晚」是床位
const TRIP_BASES = {
  trip: { label: '整趟一次', unit: '' },
  person: { label: '每人一次', unit: '人' },
  day: { label: '每天（全團）', unit: '天' },
  person_day: { label: '每人每天', unit: '人天' },
  night: { label: '每晚（整間房）', unit: '晚' },
  person_night: { label: '每人每晚', unit: '人晚' }
};
// inflationKey＝null：reference-data.js 沒有該地官方通膨預測，不套用通膨（不自己編數字）
const TRIP_DESTINATIONS = {
  JP: { label: '日本', currency: 'JPY', inflationKey: 'JP' },
  EU: { label: '歐元區國家', currency: 'EUR', inflationKey: 'EU' },
  US: { label: '美國', currency: 'USD', inflationKey: null },
  TW: { label: '台灣國內', currency: 'TWD', inflationKey: 'TW' },
  OTHER: { label: '其他國家（以台幣輸入）', currency: 'TWD', inflationKey: null }
};
const TRIP_LIMITS = { maxDays: 365, maxPeople: 50 };
// 匯率不內建（每天在變）；請使用者到臺灣銀行查「現金賣出」或「即期賣出」自行填入
const FX_RATE_SOURCE = { label: '臺灣銀行牌告匯率', url: 'https://rate.bot.com.tw/xrt?Lang=zh-TW' };
const SCENARIO_TRIP_BUDGET = {
  schemaVersion: 2,
  currency: 'JPY',
  rateToTWD: 0,
  calcType: 'items',
  scenarioId: 'trip_budget',
  label: '旅費預算試算',
  applyInflation: true,
  inflationKey: 'JP',
  trip: { destination: 'JP', days: 10, people: 1 },
  items: [
    { label: '機票', kind: 'cost', basis: 'person', currency: 'TWD', amountCents: 1000000 },
    { label: '住宿', kind: 'cost', basis: 'night', currency: 'TWD', amountCents: 200000 },
    { label: '交通', kind: 'cost', basis: 'person_day', currency: 'TWD', amountCents: 21000 },
    { label: '伙食', kind: 'cost', basis: 'person_day', currency: 'TWD', amountCents: 42000 },
    { label: '娛樂', kind: 'cost', basis: 'person_day', currency: 'TWD', amountCents: 210000 }
  ]
};
// 改版前的內建旅費項目（10 天總額、台幣）；存檔中完全沒改過時，載入時換成上面的新範例（1 人 10 天總額相同）
const LEGACY_TRIP_ITEMS = [['機票', 1000000], ['民宿', 1800000], ['交通費用（10日）', 210000], ['伙食費（10日）', 420000], ['娛樂費（10日）', 2100000]];

// 學貸情境：每學期 學雜費＋電腦網路通訊費＋平安保險費－減免，8 學期逐期呈現
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

// 喪葬費情境：項目金額為起始範例
const SCENARIO_FUNERAL = {
  schemaVersion: 2,
  currency: 'TWD',
  rateToTWD: 1,
  calcType: 'items',
  scenarioId: 'funeral',
  label: '喪葬費用試算',
  applyInflation: false,
  items: [
    { label: '樹葬／灑葬', amountCents: 600000 },
    { label: '葬儀社行情價', amountCents: 5000000 }
  ],
  // 目前已為此項目存下的金額，請自行填入；差額 = 總額 － 已存
  currentSavedCents: 0
};

// 養老金情境：每月生活費 × 12 × 退休後年數，通膨複利換算到退休年齡
// monthlyLivingCostCents 為 null 時，第一次開啟會帶入目前每月支出（固定支出＋生活開銷）
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
  monthlyLivingCostCents: null,
  applyInflation: true,
  inflationKey: 'TW',
  // 目前已提撥的養老金存款，請自行填入
  currentSavedCents: 0
};

// FIRE／退休財務獨立試算：退休前總需求資金＝退休資產目標＋其他目標＋緊急預備金，
// 往後應有月薪＝(資金缺口＋退休前總支出)／剩餘工作月數。
// linkLedger 開啟時，目前年齡、月薪、月支出、已存資產、其他目標與緊急預備金都由帳本與首頁帶入（app.js 的 linkScenario）
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
  retirementInflationAnnualRate: REFERENCE_DATA.inflation.TW.annualRate,
  linkLedger: true,
  // 手動模式才用：除退休以外、退休前要備妥的其他目標總額，以及緊急預備金月數（× 目前月支出）
  otherGoalsCents: 0,
  emergencyFundMonths: PLANNING_RULES.emergencyMonths.default,
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
  preRetirementAnnualReturnRate: 0.05
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
  monthlyWorkHours: PLANNING_RULES.defaultMonthlyWorkHours,
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