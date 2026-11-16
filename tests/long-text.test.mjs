// Ratchet: UI sentences over the limit may only shrink. New or longer ones fail;
// fixed ones must be removed from the baseline so the debt list keeps getting shorter.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root, scanLongSentences, MAX_SENTENCE_LEN } from './text-scan.mjs';

const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/long-text-baseline.json'), 'utf8'));

test(`說明句長度：超過 ${MAX_SENTENCE_LEN} 字的句子只准減不准增`, () => {
  const found = new Map();
  for (const f of scanLongSentences()) found.set(f.key, Math.max(found.get(f.key) ?? 0, f.len));
  const added = [...found].filter(([k, len]) => !(k in baseline) || len > baseline[k]);
  assert.deepEqual(added.map(([k, len]) => `${len} 字 ${k}`), [], '新增或變長的長句：請拆短、改成一行結論＋折疊');
  const fixed = Object.keys(baseline).filter((k) => !found.has(k));
  assert.deepEqual(fixed, [], '已改短的句子：執行 node tests/text-scan.mjs --write-baseline 更新基準（只會變少）');
});
