#!/usr/bin/env bash
# check-no-real-data.sh — 擋下真實財務資料（帳本、設定、試算匯出）進入公開倉庫；sample-data/*.sample.json 除外。
# Usage: bash scripts/check-no-real-data.sh [--staged]
#   --staged 只查暫存區（hooks/pre-commit 用）；不帶參數查整個工作目錄（CI 用）。Exit 1 = 發現疑似真實資料。
set -euo pipefail

blocked=0
check_file() {
  local f="$1" rel base
  rel="${f#./}"
  base="$(basename "$rel")"
  [[ -f "$f" ]] || return 0
  # 被 .gitignore 排除的個人工作區不屬於提交內容；staged 檔案仍會被檢查。
  if git check-ignore -q -- "$f" 2>/dev/null; then return 0; fi
  if [[ "$rel" == sample-data/* && "$base" == *.sample.json ]]; then return 0; fi
  if [[ "$base" =~ ^(ledger|config|estimator_.*|wage_reverse_.*|loan_.*)(_[0-9-]+)?\.(json|csv)$ ]]; then
    echo "❌ 疑似真實財務資料檔案：$rel"; blocked=1
  fi
  if [[ "$rel" == *.json || "$rel" == *.csv ]] && grep -Eq '"(entries|currentMonthlySalaryCents|totalSavedCents|amountCents)"' "$f" 2>/dev/null; then
    echo "❌ 疑似真實財務資料內容：$rel"; blocked=1
  fi
}

if [[ "${1:-}" == "--staged" ]]; then
  while IFS= read -r -d '' f; do check_file "$f"; done < <(git diff --cached --name-only --diff-filter=ACMR -z)
else
  while IFS= read -r -d '' f; do check_file "$f"; done < <(find . -type f -not -path './.git/*' -print0)
fi
exit "$blocked"