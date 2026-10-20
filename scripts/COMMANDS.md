# 10-1801_Finance_Tools_個人理財試算工具/scripts 指令目錄

<!-- make_command_catalog: dirs=.; title=10-1801_Finance_Tools_個人理財試算工具/scripts 指令目錄 -->
本檔由 `make_command_catalog.py` 從各腳本開頭說明自動產生，不要手動編輯；改腳本說明後執行 `python make_command_catalog.py --recheck COMMANDS.md --write`。

| 腳本 | 用途 |
|---|---|
| `check-no-real-data.sh` | 擋下真實財務資料（帳本、設定、試算匯出）進入公開倉庫；sample-data/*.sample.json 除外。 |

## 呼叫方式

### `check-no-real-data.sh`

```
bash scripts/check-no-real-data.sh [--staged]
```
