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

# 真實帳戶名稱寫進程式註解、文件或進度紀錄（2026-11-03：除錯時把真實存檔的銀行名與餘額寫進註解與進度紀錄，
# 上面的檔名／欄位檢查都沒擋到）。有本機存檔時，取其中的帳戶名稱（含以 / 分開的每一段），
# 公開 main 從沒出現過的才算私人，再查這次新增的行。
real="記帳區/Finance-Workspace.json"
if [[ -f "$real" ]] && command -v node >/dev/null; then
  if [[ "${1:-}" == "--staged" ]]; then added="$(git diff --cached -U0 | grep '^+' | grep -v '^+++' || true)"
  else added="$( { git diff HEAD -U0; git diff "$(git merge-base HEAD origin/main 2>/dev/null || echo HEAD)" HEAD -U0; } | grep '^+' | grep -v '^+++' || true)"; fi
  base="$(git rev-parse -q --verify origin/main || git rev-parse HEAD)"
  while IFS= read -r name; do
    [[ ${#name} -ge 2 ]] || continue
    git grep -q -F -- "$name" "$base" 2>/dev/null && continue
    if grep -qF -- "$name" <<<"$added"; then echo "❌ 新增內容含真實帳戶名稱「$name」：改成一般描述（例如「儲蓄帳戶」）"; blocked=1; fi
  done < <(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const c=d.config||d;const out=new Set();for(const a of (c.accountProfiles||[])){const n=String(a.name||"").trim();if(n)out.add(n);for(const p of n.split(/[\/／、,，\s]+/))if(p)out.add(p)}console.log([...out].join("\n"))' "$real")
fi
exit "$blocked"
