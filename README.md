# 錢路｜個人理財規劃工具

**把收入、支出、儲蓄與人生目標放在同一張財務地圖上。**

## 下載與開始使用

| 使用方式 | 立即前往 |
| --- | --- |
| 不使用 Git，直接下載 | [下載最新版 ZIP](https://github.com/si-kui-a/finance-tools/archive/refs/heads/main.zip) |
| Windows 電腦 | [Windows 下載、安裝與瀏覽器載入](#安裝到-windows-電腦) |
| Mac 電腦 | [Mac 下載、安裝與瀏覽器載入](#安裝到-mac) |
| 使用 Git 安裝與更新 | [Windows Git 指令](#windows使用-git方便更新)・[Mac Git 指令](#mac使用-git方便更新) |
| 已經下載完成 | [第一次開啟與設定](#第一次使用) |
| 查看原始碼與版本 | [GitHub 公開倉庫](https://github.com/si-kui-a/finance-tools) |

目前採本機版使用：下載後開啟資料夾內的 `index.html`。尚未提供正式的 GitHub Pages 線上版，因此不需要登入，也不會把輸入資料送到網站伺服器。

錢路是一套免費、純本機的繁體中文個人理財工具，整合記帳、多帳戶管理、每月資金分配、儲蓄率分析，以及房貸、學貸、買房、旅行與退休試算。資料只需輸入一次，各項結果便會自動連動；不需註冊、不依賴 AI，也不會把財務資料傳到伺服器。

> 適合想知道「每月能存多少、每天能花多少、目標何時達成」的人。

## 一眼看懂

| 你想知道的事 | 錢路提供的答案 |
| --- | --- |
| 每月的錢該怎麼分？ | 自動整理固定支出、應儲蓄、每日生活費與額外可用資金 |
| 現在的儲蓄狀況健康嗎？ | 計算儲蓄率、目標達成率，指出做得好的地方與待改善項目 |
| 多份工作與多個帳戶怎麼管理？ | 合併正職、兼職、接案收入，再依帳戶用途分配資金 |
| 買房、還學貸或退休需要多少錢？ | 試算總成本、通膨、月繳、資金缺口與預計達成時間 |
| 一個目標等於多少工時？ | 由薪資、工時與勞健保設定反推時薪、班次、週數及月數 |
| 資料會不會外流？ | 所有計算與保存均在瀏覽器本機完成，不需帳號或雲端服務 |

## 主要功能

- **本月總覽**：快速查看月收入、固定支出、每月應儲蓄、每日生活費和月度餘裕。
- **智慧資金分配**：先安排基本生活、固定支出與緊急預備金，再分配至選定目標和指定帳戶。
- **簡單記帳**：記錄收入、支出、轉帳與固定儲蓄；自動統計分類月均花費和占比。
- **帳戶核對（不逐筆記帳）**：月初把錢存進各用途帳戶後，只要定期填各帳戶餘額、想到再加備註；工具依固定出入帳計畫推算每段期間用掉多少。和逐筆記帳可以並存，並可設定開啟帳本時先顯示哪一種。
- **多收入管理**：支援正職、兼職與接案；各收入可獨立設定發薪日、入帳帳戶及是否扣勞健保。
- **多帳戶管理**：自訂帳戶名稱、用途和起始餘額，轉帳不會被誤算成收入或支出。
- **目標與成本試算**：內建買房、買地自建、學貸、旅費、喪葬費、養老金與 FIRE 退休情境，也能新增或複製情境。
- **貸款規劃**：估算房貸與學貸的月繳、年限、利息、寬限期及壓力情境，並可納入固定支出。
- **工時反推**：用月薪和月工時回算時薪與估計實領，再計算達成目標所需工時。
- **結論／編輯模式**：結論模式只看關鍵結果；需要調整時再切換完整編輯畫面。
- **本機自動保存**：修改後立即保存，最多保留 20 個滾動版本，也可綁定 JSON 工作區檔案。

## 安裝到 Windows 電腦

錢路不需要安裝程式，也不需要 Node.js 才能使用。只要下載專案並用瀏覽器載入 `index.html`。

### Windows：下載 ZIP（最簡單）

1. 在 GitHub 專案頁按 **Code → Download ZIP**。
2. 解壓縮後，把資料夾改名為 `MoneyPath`，移到自己的「文件」資料夾：

   ```text
   C:\Users\<你的帳號>\Documents\MoneyPath
   ```

3. 在檔案總管開啟下列檔案：

   ```text
   C:\Users\<你的帳號>\Documents\MoneyPath\index.html
   ```

4. 也可以把下列網址貼到 Edge 或 Chrome 網址列：

   ```text
   file:///C:/Users/<你的帳號>/Documents/MoneyPath/index.html
   ```

5. 建議為 `index.html` 建立桌面捷徑，以後雙擊即可使用。

> `<你的帳號>` 需換成目前的 Windows 使用者資料夾名稱。若「文件」已由 OneDrive 接管，實際位置可能包含 `OneDrive`；直接在檔案總管雙擊 `index.html` 最可靠。以含有 `index.html`、`shared` 與 `README.md` 的資料夾為準。

### Windows：使用 Git（方便更新）

在 PowerShell 執行：

```powershell
$moneyPathDocuments = [Environment]::GetFolderPath('MyDocuments')
Set-Location $moneyPathDocuments
git clone https://github.com/si-kui-a/finance-tools.git MoneyPath
Set-Location .\MoneyPath
Start-Process .\index.html
```

安裝完成後的對應路徑：

| 用途 | 路徑 |
| --- | --- |
| 專案資料夾 | `C:\Users\<你的帳號>\Documents\MoneyPath` |
| 網頁入口 | `C:\Users\<你的帳號>\Documents\MoneyPath\index.html` |
| 瀏覽器載入網址 | `file:///C:/Users/<你的帳號>/Documents/MoneyPath/index.html` |
| 共用程式 | `C:\Users\<你的帳號>\Documents\MoneyPath\shared` |
| 範例資料 | `C:\Users\<你的帳號>\Documents\MoneyPath\sample-data` |
| 建議的個人備份檔 | `C:\Users\<你的帳號>\Documents\MoneyPath Data\money-path-workspace.json` |

更新程式時，在 PowerShell 執行：

```powershell
$moneyPathDocuments = [Environment]::GetFolderPath('MyDocuments')
Set-Location (Join-Path $moneyPathDocuments 'MoneyPath')
git pull
```

個人工作區 JSON 請放在專案外的 `MoneyPath Data` 資料夾，不要放進 `MoneyPath` 公開程式碼資料夾，避免日後被 Git 誤提交。

## 安裝到 Mac

macOS 同樣不需要安裝程式或 Node.js。下載後以 Safari、Chrome 或 Edge 開啟 `index.html` 即可；若要把工作區直接綁定至本機 JSON 檔案，建議使用最新版 Chrome 或 Edge。

### Mac：下載 ZIP（最簡單）

1. 在 GitHub 專案頁按 **Code → Download ZIP**。
2. 在 Finder 的「下載項目」雙擊 ZIP 解壓縮。
3. 將資料夾改名為 `MoneyPath`，再移到自己的「文件」資料夾：

   ```text
   /Users/<你的帳號>/Documents/MoneyPath
   ```

4. 在 Finder 開啟 `MoneyPath`，雙擊 `index.html`；或在瀏覽器網址列輸入：

   ```text
   file:///Users/<你的帳號>/Documents/MoneyPath/index.html
   ```

> `<你的帳號>` 是 Mac 的短使用者名稱。可在「終端機」執行 `whoami` 查詢；不要把中文顯示名稱直接當成路徑。

### Mac：使用 Git（方便更新）

先確認 Mac 已安裝 Git，再於「終端機」執行：

```bash
cd ~/Documents
git clone https://github.com/si-kui-a/finance-tools.git MoneyPath
cd MoneyPath
open index.html
```

安裝完成後的對應路徑：

| 用途 | macOS 路徑 |
| --- | --- |
| 專案資料夾 | `~/Documents/MoneyPath` |
| 網頁入口 | `~/Documents/MoneyPath/index.html` |
| 瀏覽器載入網址 | `file:///Users/<你的帳號>/Documents/MoneyPath/index.html` |
| 共用程式 | `~/Documents/MoneyPath/shared` |
| 範例資料 | `~/Documents/MoneyPath/sample-data` |
| 建議的個人備份檔 | `~/Documents/MoneyPath Data/money-path-workspace.json` |

更新程式時，在「終端機」執行：

```bash
cd ~/Documents/MoneyPath
git pull
```

個人工作區 JSON 請放在專案外的 `~/Documents/MoneyPath Data`，不要放進 `MoneyPath` 公開程式碼資料夾。Safari 可以使用瀏覽器本機保存與 JSON 匯入／匯出；若「選擇本機保存位置」不可用，請改用 Chrome／Edge，或定期按匯出下載備份。

> 如果 Windows「文件」由 OneDrive 同步，或 Mac「文件」由 iCloud Drive 同步，放在其中的檔案可能會上傳雲端。希望資料嚴格留在單機時，請在未同步的本機資料夾建立 `MoneyPath` 與 `MoneyPath Data`；程式可從任何有讀取權限的位置載入。

## 第一次使用

1. 開啟 `index.html`，進入「帳本」設定出生年份、固定收入與帳戶。
2. 設定每月固定支出、固定儲蓄與入扣款日期；已知金額會自動連動。
3. 回到「首頁」查看每月分配、儲蓄率、每日生活費與財務健檢。
4. 到「成本試算」建立買房、學貸、旅行或退休目標。
5. 在首頁選擇本機保存位置，建立或綁定 `money-path-workspace.json`。

不必先整理完整帳本。只有收入與支出，也能立即得到每月結餘、儲蓄率和每日可用生活費。

## 設計原則

- **輸入一次，全站連動**：優先沿用已有資料，自動推導可計算的數值。
- **先看結論，再看細節**：預設突出行動所需的關鍵數字，進階公式可自行展開。
- **公式透明，不靠 AI**：純前端 JavaScript 計算，可離線使用、測試與核對。
- **資料留在本機**：不設後端、不需登入，也不連接真實銀行帳戶。
- **低維護、可長期使用**：制度與利率採有日期的參考快照，重要參數皆可手動調整。

## 資料保存與備份

- 最新工作資料保存在目前瀏覽器設定檔的 `localStorage`，滾動版本保存在 IndexedDB。
- 修改、切換背景、關閉分頁或離開頁面時，系統會嘗試自動保存；右下角顯示最後成功保存時間。
- 可在首頁選擇或建立 JSON 工作區檔案。授權有效時，修改內容會同步寫入該檔案。
- 匯入的原始檔不會被移動或改寫；匯出的 JSON 會進入瀏覽器設定的下載位置。
- 清除網站資料、更換瀏覽器設定檔或重灌瀏覽器可能移除本機資料，請定期匯出 JSON 備份。
- 公開倉庫只應存放程式碼與範例假資料；真實財務資料請留在本機或私密倉庫。

## 計算方式與重要界線

- 所有金額以整數「分」儲存與計算，避免小數誤差；帳戶核對紀錄存在帳本的 `snapshots` 欄位，舊資料沒有這個欄位也能照常讀取。
- 目標預估採複利通膨：`今日金額 × (1 ＋ 年通膨率)^(月份 ÷ 12)`。
- 實質報酬率：`(1 ＋ 名目報酬率) ÷ (1 ＋ 通膨率) − 1`。
- 財務健檢同時提供有利、基準與壓力情境；壓力情境包含收入下降、較高通膨和零投資報酬。
- 帳戶核對的「用掉」是推算值：`期初餘額 ＋ 期間內計畫存入 − 期末餘額`，計畫存入來自固定出入帳（收入入帳、儲蓄轉入減轉出）。帳戶互轉不記錄時，個別帳戶會一邊多花、一邊多存，但全部帳戶加總不受影響，所以總覽以加總為主；結果為負時顯示「多出」（利息、退款、計畫外收入）。核對間隔不固定，比較各期時看「每 30 天」換算值。
- 儲蓄健康度是本工具的規劃規則：低於 10% 為偏低、10% 至未滿 20% 為待改善、20% 至 40% 為健康、高於 40% 為充足。
- 官方資料以 `shared/reference-data.js` 內的離線快照為準；介面會顯示來源日期，使用者也可覆寫參數。
- 試算結果取決於輸入與假設，不代表收益保證，也不構成投資、稅務、保險、法律或貸款建議。

## 隱私防護

首次複製專案後，建議啟用提交前的隱私掃描：

```powershell
git config core.hooksPath hooks
```

本機 hook 與 GitHub Actions 都會執行 `scripts/check-no-real-data.sh`，發現疑似真實財務資料時阻止提交或標記檢查失敗。

## 開發與測試

本專案無第三方執行期套件，使用 Node.js 內建測試器：

```powershell
npm test
npm run check
```

測試涵蓋通膨、實質報酬、財務健檢、壓力情境、帳本驗證、外幣匯率、FIRE、目標推算及多項邊界條件。GitHub Actions 會同步執行程式檢查、測試與隱私掃描。

每次 GitHub Actions 執行都會跑 `npm run check`，並將完整輸出保存為 `finance-ci-logs-<run_id>` artifact（保留 14 天）。若檢查失敗，請先下載該 artifact，再依日誌中的語法錯誤、測試名稱與堆疊位置進行修正。

## 機械複查（2026-08-30訂定，移植自wordpress-builder-playbook repo的同類規則）

本專案是純前端靜態工具，沒有PAT編號式知識庫，不確定的做法先查本節
上方「計算方式與重要界線」，內部真的沒有才查外部。**機械複查**：
`node scripts/dev-knowledge-audit.mjs`——`shared/`底下JS檔案篇幅離群值
/README過時關鍵字候選，純Node內建模組，只找候選不判斷對錯，不進CI，
手動觸發即可。

**★閥值自動觸發★**收工時先跑這行判斷要不要做健檢，不用自己記或等
使用者提醒：
```bash
git rev-list --count $(head -c 7 scripts/.last-audit-marker)..HEAD
```
（**這個檔案不存在**時上面這行會直接報錯——代表從沒跑過健檢，視同
數字已達閥值，直接跑健檢腳本並用結果建立這個檔案，不用回頭修這行
指令）**這個數字≥8就自動跑**`node scripts/dev-knowledge-audit.mjs`，
跑完後用當下HEAD的short SHA+日期覆寫`scripts/.last-audit-marker`。

**全面收斂稽核（多輪修改收工前，或使用者要求「嚴格審核」時執行，
2026-08-30訂定，移植自wordpress-builder-playbook repo Phase 4.5的
同類概念，通用程式碼repo版）**：跟上面的機械複查是不同顆粒度、不同
觸發時機的兩件事——機械複查抓的是「距離上次健檢累積了幾個commit」
這種跨時間的知識庫落後；這裡抓的是「同一個功能/檔案範圍累積了多輪
反覆修改」造成的跨輪次內部不一致，零星單點驗證會漏掉這種「這一輪改
完當下沒問題，但跟三輪前改的地方兜不起來」的落差（fintools的FIRE/
驗證強化那批11檔WIP就是實例——`app.js`的`catch{}`綁定bug就是這種
跨輪次不一致，收斂稽核抓的正是這一類）。

觸發時機：①同一功能/同一批檔案累積修改超過~10輪以上準備收工前，
②使用者明確要求「嚴格審核」/「全面檢查」時，③或懷疑有跨輪次殘留
不一致但說不出具體是什麼時。

查什麼：(1)跨檔案命名/欄位一致性——同一概念在本輪異動涉及的不同
檔案有沒有被叫成不同名字；(2)死碼/孤兒函式——早期輪次寫的邏輯被
同一輪內更晚版本取代但沒刪掉；(3)文件/註解與目前程式碼行為脫節；
(4)重複邏輯可收斂成共用函式卻沒有抽。跑完直接修掉抓到的問題，不用
等使用者再次提出——這是「收斂」動作的一部分，不是額外加碼。
