// sw-register.js — 線上版（https，開發時含 localhost）才註冊離線快取；下載版以 file:// 開啟時瀏覽器本來就不支援，直接略過。
if ((location.protocol === 'https:' || location.hostname === 'localhost') && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('離線快取未啟用：', err.message));
}
