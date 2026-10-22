// reference-data.js — 外部制度與官方預測數字的唯一來源（離線快照，頁面不連網）。
// 規則：每一筆都要有官方機關的 sourceUrl 與檢索日；查不到官方依據的數字不放進來。
// 使用者沒改過的設定一律讀這裡；更新時只改本檔，tests/core.test.mjs 會檢查欄位齊全。
// 通膨取官方最遠一期的預測年度，作為長期目標的年增率（短期衝擊年度不適合拿來複利多年）。
const REFERENCE_DATA = {
  inflation: {
    TW: {
      annualRate: 0.0183, label: '台灣 CPI 年增率預測（2027 年）',
      source: '中央銀行 115 年 9 月 17 日理監事聯席會議決議新聞稿',
      sourceUrl: 'https://www.cbc.gov.tw/tw/cp-302-192864-4319f-1.html',
      observedThrough: '2026-09-17', retrievedAt: '2026-10-21'
    },
    JP: {
      annualRate: 0.020, label: '日本消費者物價（除生鮮食品）政策委員見通し中位數（2028 年度）',
      source: '日本銀行「経済・物価情勢の展望（2026年7月）」',
      sourceUrl: 'https://www.boj.or.jp/mopo/outlook/gor2607b.pdf',
      observedThrough: '2026-07-31', retrievedAt: '2026-10-21'
    },
    EU: {
      annualRate: 0.021, label: '歐元區 HICP 年增率預測（2028 年）',
      source: 'European Central Bank, ECB staff macroeconomic projections, September 2026',
      sourceUrl: 'https://www.ecb.europa.eu/press/projections/html/ecb.projections202609_ecbstaff~8e340fc69d.en.html',
      observedThrough: '2026-09-10', retrievedAt: '2026-10-21'
    }
  },
  // 有一定雇主的受僱者；職業工會、自營業者的負擔比例不同，請自行覆寫
  twLaborInsurance: {
    ordinaryRate: 0.115, employmentRate: 0.01, personalShare: 0.20,
    source: '勞動部勞工保險局：普通事故保險費率自 114 年 1 月 1 日起 11.5%，另就業保險費率 1%；勞工保險條例第 15 條（被保險人負擔 20%）',
    sourceUrl: 'https://www.bli.gov.tw/0014162.html',
    lawUrl: 'https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=N0050001&flno=15',
    retrievedAt: '2026-10-21'
  },
  twHealthInsurance: {
    rate: 0.0517, personalShare: 0.30,
    source: '衛生福利部中央健康保險署：一般保險費率自 110 年起 5.17%；全民健康保險法第 27 條（受僱者負擔 30%，不含眷屬）',
    sourceUrl: 'https://www.nhi.gov.tw/ch/cp-19418-9eefb-2576-1.html',
    lawUrl: 'https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=L0060001&flno=27',
    retrievedAt: '2026-10-21'
  },
  twStudentLoan: {
    effectiveFrom: '2026-08-01', borrowerAnnualRate: 0.00775,
    standardGraceYears: 2, yearsPerBorrowedSemester: 1,
    extendedTermMultiplier: 1.5, lowIncomeTermMultiplier: 2,
    source: '教育部高級中等以上學校學生就學貸款辦法及臺灣銀行就學貸款公告',
    sourceUrl: 'https://edu.law.moe.gov.tw/LawContent.aspx?id=FL008414',
    bankUrl: 'https://sloan.bot.com.tw/customer/login/SLoanLogin.action',
    retrievedAt: '2026-10-21',
    note: '一般畢業情境估算；實際起算日、利率、展延、承貸銀行帳單及個人資格優先。'
  },
  // 最低工資：依生效日排序，Planning.minimumWageOn 取某日適用的一筆
  twMinimumWage: {
    schedule: [
      { effectiveFrom: '2026-01-01', monthlyCents: 2950000, hourlyCents: 19600 },
      { effectiveFrom: '2027-01-01', monthlyCents: 3090000, hourlyCents: 20500 }
    ],
    source: '勞動部「歷年最低工資／基本工資調整」；116 年起數額依最低工資審議會決議，行政院 115 年 10 月 1 日院會核定',
    sourceUrl: 'https://www.mol.gov.tw/1607/28162/28166/28180/70460/76761/',
    nextUrl: 'https://www.mol.gov.tw/1607/1632/1633/99195/post',
    approvalUrl: 'https://www.ey.gov.tw/Page/9277F759E41CCD91/59848ab4-676b-41b7-898e-9f5207325f0a',
    retrievedAt: '2026-10-22'
  },
  // 勞基法第 30 條：每週正常工時 40 小時；第 32 條：延長工時每月不得超過 46 小時
  twLaborStandards: {
    weeklyNormalHours: 40, monthlyOvertimeCapHours: 46,
    source: '勞動基準法第 30 條、第 32 條',
    sourceUrl: 'https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=N0030001&flno=30',
    lawUrl: 'https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=N0030001&flno=32',
    retrievedAt: '2026-10-22'
  },
  twMortgage: {
    referenceAnnualRate: 0.0337, referenceTermYears: 30,
    source: '臺灣銀行消費者貸款適用利率一覽表（利率指數 1.751%，115 年 9 月 21 日起）及中央銀行不動產貸款規定',
    sourceUrl: 'https://www.bot.com.tw/Images/File/GetFileId/8ecae4b0-7567-4ebc-951b-ec8c77524c3c',
    regulationUrl: 'https://www.cbc.gov.tw/tw/lp-6299-1.html',
    retrievedAt: '2026-10-21',
    note: '3.37% 僅為一般房屋購置貸款公開參考下限，不代表個人核貸；實際利率、成數、年限與寬限期以銀行契約為準。'
  }
};
