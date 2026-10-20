// frame-guard.js — 防止線上版被其他網站用 iframe 嵌入（點擊劫持）。
// GitHub Pages 無法設定 frame-ancestors／X-Frame-Options 標頭，<meta> CSP 也不支援 frame-ancestors，
// 只能在頁面內自行偵測；必須在 <head> 最先載入，畫面出現前就隱藏。
(() => {
  if (window.top === window.self) return;
  document.documentElement.style.display = 'none';
  try { window.top.location.replace(window.location.href); } catch { /* sandbox 禁止頂層導覽時維持隱藏 */ }
})();
