// snapshots.js — 帳戶核對模式：不逐筆記帳，只定期記下各帳戶餘額，推算每段期間用掉多少。
// 純函式、不碰畫面（tests/core.test.mjs 用 Node 直接測）。金額一律整數「分」。
//
// 推算方式（每個帳戶、每段期間）：
//   應存入 = 期間內依「固定出入帳」計畫進帳的金額（收入入帳、儲蓄轉入 − 儲蓄轉出）
//   推算流出 = 期初餘額 + 應存入 − 期末餘額
//   其中固定支出 = 計畫中從這個帳戶扣的固定支出；生活花費 = 推算流出 − 固定支出
// 推算流出為負時是「多出」（利息、退款、計畫外收入），不當成負的支出。
// 帳戶互轉沒有記錄時，單一帳戶會一邊多花、一邊多存，但全部帳戶加總不受影響，所以總覽以加總為主。
// 新增的帳戶（第一次出現在核對紀錄）期初以 0 計：錢通常是從其他帳戶轉入，排除它會讓加總多算一筆「用掉」。
// 以前填過、這次或上次漏填的帳戶期初／期末不明，仍不計入。
// 核對日期不固定（月初、月中都可能），比較各期時用每 30 天的換算值。

const Snapshots = (() => {
  const DAY = 86400000;
  const dateValue = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));

  // 期間 (from, to] 內有幾次「每月第 day 日」：月底較短時算在當月最後一天
  const occurrences = (day, from, to) => {
    let n = 0;
    const start = new Date(dateValue(from)), end = dateValue(to);
    for (let y = start.getUTCFullYear(), m = start.getUTCMonth(); ; m++) {
      const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const d = Date.UTC(y, m, Math.min(Math.max(1, Math.trunc(day || 1)), last));
      if (d > end) break;
      if (d > dateValue(from)) n++;
    }
    return n;
  };

  // 一段期間 (from, to] 內各帳戶依計畫的進出：{ [accountId]: { inCents, fixedOutCents } }
  // items 必須是 Money.calcRecurringMonthly 算好的固定項目（已排除停用、帶換算後金額）；
  // 每一筆的日期與金額取自 Money.flowEvents（與帳本預測帳目同一份排程：非月繳只算繳款月、租屋按繳租月、租屋補助入帳）。
  // money.js 載入在後，呼叫時才取用
  const planned = (items, from, to) => {
    const out = {};
    const add = (id, key, cents) => {
      if (!id) return;
      out[id] = out[id] || { inCents: 0, fixedOutCents: 0 };
      out[id][key] += cents;
    };
    const dayAfter = Money.ymd(new Date(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10) + 1));
    for (const ev of Money.flowEvents(items, dayAfter, to)) {
      if (ev.type === 'income') add(ev.accountId, 'inCents', ev.cents);
      else if (ev.type === 'saving') { add(ev.accountId, 'inCents', ev.cents); add(ev.fromAccountId, 'inCents', -ev.cents); }
      else if (ev.type === 'expense') add(ev.accountId, 'fixedOutCents', ev.cents);
    }
    return out;
  };

  // 相鄰兩次核對之間的期間，最新的在前。計入兩次都有填餘額的帳戶，以及第一次出現的新帳戶（isNew，期初 0）。
  // 給 entries 時自動對帳：total.unrecordedCents＝餘額變化−排程收支−期間內手記帳目（Money.entryDeltas），
  //   只算兩次都有填的帳戶；手記的固定收支已由 Planning.fixedEntryMatch 配對排除，不重複扣。負數＝有花費沒記到
  //   另給 total.floatingInCents／floatingOutCents（浮動收支），livingCents 會扣掉浮動收支的影響
  const periods = (snapshots, flows, entries = null) => {
    const sorted = [...(snapshots || [])].sort((a, b) => a.date.localeCompare(b.date));
    const result = [];
    const seen = new Set();
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1], b = sorted[i];
      Object.keys(a.balances || {}).forEach((id) => seen.add(id));
      const days = Math.round((dateValue(b.date) - dateValue(a.date)) / DAY);
      const plan = planned(flows, a.date, b.date);
      const accounts = Object.keys(b.balances || {})
        .filter((id) => Number.isInteger(b.balances[id]) && (Number.isInteger(a.balances?.[id]) || !seen.has(id)))
        .map((id) => {
          const isNew = !seen.has(id);
          const startCents = isNew ? 0 : a.balances[id], endCents = b.balances[id];
          const { inCents = 0, fixedOutCents = 0 } = plan[id] || {};
          return { id, isNew, startCents, endCents, changeCents: endCents - startCents, inCents, fixedOutCents,
                   outflowCents: startCents + inCents - endCents };
        });
      const sum = (key) => accounts.reduce((s, x) => s + x[key], 0);
      const total = { startCents: sum('startCents'), endCents: sum('endCents'), changeCents: sum('changeCents'),
                      inCents: sum('inCents'), fixedOutCents: sum('fixedOutCents'), outflowCents: sum('outflowCents') };
      total.livingCents = total.outflowCents - total.fixedOutCents;
      if (entries) {
        const old = new Set(accounts.filter(x => !x.isNew).map(x => x.id));
        const nextDay = (ymd) => Money.ymd(new Date(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10) + 1));
        const { matched } = Planning.fixedEntryMatch({ entries, items: flows, from: nextDay(a.date), to: nextDay(b.date) });
        let net = 0;
        for (const x of accounts) if (!x.isNew) net += x.changeCents - x.inCents + x.fixedOutCents;
        // Floating cash flows explain part of the balance change: income would hide spending and a one-off
        // expense would inflate it, so livingCents excludes them (same account set as livingCents)
        const all = new Set(accounts.map(x => x.id));
        let floatingInCents = 0, floatingOutCents = 0;
        for (const e of entries) {
          if (e.status === 'projected' || e.recurringFlowId || matched.has(e.id) || !(e.date > a.date && e.date <= b.date)) continue;
          for (const [id, cents] of Money.entryDeltas(e)) {
            if (old.has(id)) net -= cents;
            if (e.floating && all.has(id)) { if (cents > 0) floatingInCents += cents; else floatingOutCents -= cents; }
          }
        }
        total.unrecordedCents = net;
        total.floatingInCents = floatingInCents;
        total.floatingOutCents = floatingOutCents;
        total.livingCents += floatingInCents - floatingOutCents;
      }
      total.outflowPer30Cents = days > 0 ? Math.round(total.outflowCents * 30 / days) : null;
      result.push({ from: a.date, to: b.date, days, note: b.note || '', accounts, total });
    }
    return result.reverse();
  };

  // 儲存前的檢查：日期、餘額為整數分、同一天不重複
  const validate = (snapshots) => {
    const errors = [];
    if (snapshots === undefined) return errors;
    if (!Array.isArray(snapshots)) return ['帳戶核對紀錄必須是陣列'];
    const dates = new Set(), ids = new Set();
    snapshots.forEach((s, i) => {
      if (!s || typeof s !== 'object') { errors.push(`第 ${i + 1} 筆核對紀錄格式錯誤`); return; }
      if (typeof s.id !== 'string' || !s.id || ids.has(s.id)) errors.push(`第 ${i + 1} 筆核對紀錄的 ID 缺少或重複`);
      ids.add(s.id);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date || '')) errors.push(`第 ${i + 1} 筆核對紀錄的日期必須是 YYYY-MM-DD`);
      else if (dates.has(s.date)) errors.push(`${s.date} 已有一筆核對紀錄`);
      dates.add(s.date);
      if (!s.balances || typeof s.balances !== 'object') errors.push(`第 ${i + 1} 筆核對紀錄缺少餘額`);
      else Object.values(s.balances).forEach((v) => { if (!Number.isInteger(v)) errors.push(`第 ${i + 1} 筆核對紀錄的餘額必須是整數分`); });
    });
    return errors;
  };

  // 生活花費推估（每 30 天）：最近幾期合計的（推算用掉−固定支出）÷ 合計天數 × 30，累積到至少 minDays 天才算；
  // 用合計而不是逐期平均，短期間（隔兩天就核對）不會被放大。null＝資料不夠
  const livingEstimate = (periodList, { minDays = 14, maxDays = 93 } = {}) => {
    let days = 0, living = 0, fixed = 0, used = 0;
    for (const p of periodList || []) {
      if (days >= maxDays) break;
      days += p.days; living += p.total.livingCents; fixed += p.total.fixedOutCents; used += 1;
    }
    if (days < minDays) return null;
    return { days, periods: used, livingPer30Cents: Math.round(living * 30 / days), fixedPer30Cents: Math.round(fixed * 30 / days) };
  };
  // 總資產曲線：每次核對的帳戶合計（漏填的帳戶沿用上次數字）、與上次相比的變化，以及每 30 天換算的變化與前一期比進步或退步
  const assetSeries = (snapshots) => {
    const known = {};
    let prev = null;
    return [...(snapshots || [])].sort((a, b) => a.date.localeCompare(b.date)).map((s) => {
      Object.entries(s.balances || {}).forEach(([id, v]) => { if (Number.isInteger(v)) known[id] = v; });
      const totalCents = Object.values(known).reduce((x, y) => x + y, 0);
      const point = { date: s.date, totalCents, changeCents: null, changePer30Cents: null, trend: null };
      if (prev) {
        const days = Math.round((dateValue(s.date) - dateValue(prev.date)) / DAY);
        point.changeCents = totalCents - prev.totalCents;
        point.changePer30Cents = days > 0 ? Math.round(point.changeCents * 30 / days) : null;
        if (prev.changePer30Cents !== null && point.changePer30Cents !== null) point.trend = point.changePer30Cents > prev.changePer30Cents ? 'up' : (point.changePer30Cents < prev.changePer30Cents ? 'down' : 'flat');
      }
      prev = point;
      return point;
    });
  };

  return { occurrences, planned, periods, validate, livingEstimate, assetSeries };
})();
