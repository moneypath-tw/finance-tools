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

  // 一段期間內各帳戶依計畫的進出：{ [accountId]: { inCents, fixedOutCents } }
  const planned = (flows, from, to) => {
    const out = {};
    const add = (id, key, cents) => {
      if (!id) return;
      out[id] = out[id] || { inCents: 0, fixedOutCents: 0 };
      out[id][key] += cents;
    };
    for (const f of flows || []) {
      const n = occurrences(f.dayOfMonth, from, to);
      if (!n) continue;
      if (f.type === 'income') add(f.accountId, 'inCents', n * (f.netCents || 0));
      else if (f.type === 'saving') {
        if (!f.fromAccountId || f.fromAccountId === f.accountId) continue;
        add(f.accountId, 'inCents', n * (f.grossCents || 0));
        add(f.fromAccountId, 'inCents', -n * (f.grossCents || 0));
      } else if (f.type === 'expense') add(f.accountId, 'fixedOutCents', n * (f.grossCents || 0));
    }
    return out;
  };

  // 相鄰兩次核對之間的期間，最新的在前。計入兩次都有填餘額的帳戶，以及第一次出現的新帳戶（isNew，期初 0）。
  const periods = (snapshots, flows) => {
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

  return { occurrences, planned, periods, validate };
})();
