// io.js — 匯入 / 匯出 / 驗證 / 資料遺失防呆
// 原則：全程只在瀏覽器本機記憶體運算，不對外送出任何資料。

const IO = (() => {
  let dirty = false;
  let stateProvider = null;
  let statusListener = null;
  let historyTimer = null;
  let fileSaveTimer = null;
  let boundFileHandle = null;
  let fileWriteChain = Promise.resolve();
  let lastLifecycleFlushAt = 0;
  // 另一個分頁寫入了較新的工作區：這個分頁手上的是舊資料，再保存就會覆蓋掉對方的修改
  let staleFromOtherTab = false;
  const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
  const WORKSPACE_KEY = 'finance-tools.workspace.v1';
  const DB_NAME = 'finance-tools-local';
  const HISTORY_LIMIT = 20;
  let lastSavedAt = null;

  const notifyStatus = (message, ok = true) => {
    if (statusListener) statusListener({ message, ok, lastSavedAt, bindingName: boundFileHandle?.name || null });
  };
  const currentEnvelope = () => ({ schemaVersion: 1, savedAt: new Date().toISOString(), ...(stateProvider ? stateProvider() : {}) });
  const saveCurrent = () => {
    if (!stateProvider) return false;
    if (staleFromOtherTab) {
      notifyStatus('另一個分頁已更新資料；這個分頁已停止保存以免覆蓋，請重新整理後再編輯', false);
      return false;
    }
    try {
      const envelope = currentEnvelope();
      localStorage.setItem(WORKSPACE_KEY, JSON.stringify(envelope));
      lastSavedAt = envelope.savedAt;
      dirty = false;
      notifyStatus(`已自動保存・${new Date(lastSavedAt).toLocaleString('zh-Hant-TW')}`);
      return envelope;
    } catch (err) {
      dirty = true;
      notifyStatus(`自動保存失敗：${err.message}`, false);
      return false;
    }
  };
  const openHistoryDb = () => new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('此瀏覽器不支援 IndexedDB')); return; }
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('history')) req.result.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
      if (!req.result.objectStoreNames.contains('settings')) req.result.createObjectStore('settings');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const saveHistory = async () => {
    if (!stateProvider || staleFromOtherTab) return;
    try {
      const db = await openHistoryDb();
      const tx = db.transaction('history', 'readwrite');
      const store = tx.objectStore('history');
      store.add(currentEnvelope());
      const countReq = store.count();
      countReq.onsuccess = () => {
        let remove = Math.max(0, countReq.result - HISTORY_LIMIT);
        if (!remove) return;
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => { const cursor = cursorReq.result; if (cursor && remove-- > 0) { cursor.delete(); cursor.continue(); } };
      };
      tx.oncomplete = () => db.close();
    } catch (err) { notifyStatus(`目前資料已保存，但滾動版本建立失敗：${err.message}`, false); }
  };
  const saveBindingHandle = async (handle) => {
    const db = await openHistoryDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('settings', 'readwrite');
      const store = tx.objectStore('settings');
      handle ? store.put(handle, 'boundWorkspaceFile') : store.delete('boundWorkspaceFile');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  };
  const initializeFileBinding = async () => {
    try {
      const db = await openHistoryDb();
      boundFileHandle = await new Promise((resolve, reject) => {
        const tx = db.transaction('settings', 'readonly');
        const req = tx.objectStore('settings').get('boundWorkspaceFile');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => db.close();
      });
      return boundFileHandle;
    } catch { boundFileHandle = null; return null; }
  };
  const writeBoundFile = async ({ requestPermission = false } = {}) => {
    if (!boundFileHandle || !stateProvider || staleFromOtherTab) return false;
    try {
      let permission = await boundFileHandle.queryPermission({ mode: 'readwrite' });
      if (permission !== 'granted' && requestPermission) permission = await boundFileHandle.requestPermission({ mode: 'readwrite' });
      if (permission !== 'granted') throw new Error('需要重新授權綁定檔案');
      const envelope = currentEnvelope();
      const writable = await boundFileHandle.createWritable();
      await writable.write(JSON.stringify(envelope, null, 2));
      await writable.close();
      lastSavedAt = envelope.savedAt;
      notifyStatus(`本機與 ${boundFileHandle.name} 已同步`);
      return true;
    } catch (err) {
      notifyStatus(`瀏覽器資料已保存；綁定檔案未更新：${err.message}`, false);
      return false;
    }
  };
  const saveBoundFile = (options = {}) => {
    fileWriteChain = fileWriteChain.then(() => writeBoundFile(options), () => writeBoundFile(options));
    return fileWriteChain;
  };
  const scheduleBoundFileSave = () => {
    clearTimeout(fileSaveTimer);
    if (boundFileHandle) fileSaveTimer = setTimeout(() => saveBoundFile(), 0);
  };
  const bindWorkspaceFile = async () => {
    if (!globalThis.showSaveFilePicker) throw new Error('此瀏覽器不支援工作區檔案綁定，請使用最新版 Edge 或 Chrome');
    const handle = await showSaveFilePicker({ suggestedName: 'Finance-Workspace.json', types: [{ description: '理財工作區 JSON', accept: { 'application/json': ['.json'] } }] });
    boundFileHandle = handle;
    await saveBindingHandle(handle);
    await saveBoundFile({ requestPermission: true });
    return handle.name;
  };
  const unbindWorkspaceFile = async () => {
    boundFileHandle = null;
    clearTimeout(fileSaveTimer);
    await saveBindingHandle(null);
    notifyStatus('已解除檔案綁定；仍會自動保存於瀏覽器本機資料');
  };
  const getBindingInfo = () => ({ supported: !!globalThis.showSaveFilePicker, name: boundFileHandle?.name || null, lastSavedAt });
  const markDirty = () => {
    dirty = true;
    saveCurrent();
    clearTimeout(historyTimer);
    historyTimer = setTimeout(saveHistory, 800);
    scheduleBoundFileSave();
  };
  const clearDirty = () => { dirty = false; };
  const configurePersistence = (provider, listener) => { stateProvider = provider; statusListener = listener || null; };
  const loadWorkspace = () => {
    try {
      const raw = localStorage.getItem(WORKSPACE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      lastSavedAt = parsed.savedAt || null;
      return parsed;
    } catch (err) { notifyStatus(`讀取本機工作區失敗：${err.message}`, false); return null; }
  };
  const requestPersistentStorage = async () => {
    try {
      if (!navigator.storage?.persist) return false;
      const granted = await navigator.storage.persist();
      notifyStatus(granted ? '瀏覽器已允許持久保存' : '瀏覽器未授予防清除保護；請定期匯出備份', granted);
      return granted;
    } catch { return false; }
  };
  const loadPreviousWorkspace = async () => {
    const db = await openHistoryDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('history', 'readonly');
      const req = tx.objectStore('history').getAll();
      req.onsuccess = () => {
        const rows = req.result || [];
        resolve(rows.length >= 2 ? rows[rows.length - 2] : (rows[0] || null));
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  };

  const flushBeforeLeaving = () => {
    const now = Date.now();
    if (now - lastLifecycleFlushAt < 500) return;
    lastLifecycleFlushAt = now;
    // 正在輸入但還沒移開焦點的欄位不會觸發 change；先移開焦點，讓它的修改先寫入再保存
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur?.();
    clearTimeout(historyTimer);
    clearTimeout(fileSaveTimer);
    // 每次修改已立即寫入；只有寫入失敗（dirty）才需要重寫，否則切換分頁也會觸發其他分頁的 storage 事件
    if (dirty) saveCurrent();
    saveHistory();
    if (boundFileHandle) saveBoundFile();
  };
  window.addEventListener('storage', (e) => {
    if (e.key !== WORKSPACE_KEY || e.newValue === null || e.storageArea !== localStorage) return;
    staleFromOtherTab = true;
    clearTimeout(historyTimer);
    clearTimeout(fileSaveTimer);
    if (document.visibilityState === 'hidden') { location.reload(); return; }
    notifyStatus('另一個分頁已更新資料；這個分頁已停止保存以免覆蓋，請重新整理後再編輯', false);
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushBeforeLeaving(); });
  window.addEventListener('pagehide', flushBeforeLeaving);
  window.addEventListener('beforeunload', (e) => {
    flushBeforeLeaving();
    if (!dirty || staleFromOtherTab) return;
    e.preventDefault();
    e.returnValue = '';
  });

  const exportJson = (dataObject, baseName) => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const filename = `${baseName}_${stamp}.json`;
    const blob = new Blob([JSON.stringify(dataObject, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    clearDirty();
    return filename;
  };

  // 讀取使用者選取的檔案，回傳 Promise<object>；格式錯誤或版本不符會丟出可讀訊息，不覆蓋現有資料
  const importJsonFile = (file, { expectedSchemaVersion } = {}) =>
    new Promise((resolve, reject) => {
      if (file.size > MAX_IMPORT_BYTES) {
        reject(new Error(`檔案超過 ${MAX_IMPORT_BYTES / 1024 / 1024} MB，未匯入，也未覆蓋現有資料。`));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        let parsed;
        try {
          parsed = JSON.parse(reader.result);
        } catch (err) {
          reject(new Error('檔案不是有效的 JSON 格式，未覆蓋現有資料。請確認檔案內容完整。'));
          return;
        }
        if (expectedSchemaVersion !== undefined && parsed.schemaVersion !== undefined
            && parsed.schemaVersion > expectedSchemaVersion) {
          reject(new Error(
            `此資料檔案版本（v${parsed.schemaVersion}）比目前工具支援的版本（v${expectedSchemaVersion}）新，` +
            `請更新工具後再匯入，避免欄位判讀錯誤。`
          ));
          return;
        }
        resolve(parsed);
      };
      reader.onerror = () => reject(new Error('讀取檔案時發生錯誤，請重試。'));
      reader.readAsText(file);
    });

  return { markDirty, clearDirty, configurePersistence, loadWorkspace, loadPreviousWorkspace, saveCurrent, requestPersistentStorage, initializeFileBinding, bindWorkspaceFile, unbindWorkspaceFile, saveBoundFile, getBindingInfo, exportJson, importJsonFile };
})();
