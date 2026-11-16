// Ratchet: UI sentences over the limit may only shrink. New or longer ones fail;
// fixed ones must be removed from the baseline so the debt list keeps getting shorter.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root, scanLongSentences, MAX_SENTENCE_LEN } from './text-scan.mjs';

const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/long-text-baseline.json'), 'utf8'));

test('長說明只用 noteLines／foldNotes 一個建構處（可重複使用的編排）', () => {
  const src = fs.readFileSync(path.join(root, 'shared/app.js'), 'utf8');
  assert.equal(src.match(/const noteLines = /g)?.length, 1);
  assert.equal(src.match(/const foldNotes = /g)?.length, 1);
  for (const id of ['home-floors-how', 'recon-used-how', 'recon-formula-how']) assert.ok(src.includes(`foldNotes('${id}'`), `${id} 要走 foldNotes`);
});

test(`說明句長度：超過 ${MAX_SENTENCE_LEN} 字的句子只准減不准增`, () => {
  const found = new Map();
  for (const f of scanLongSentences()) found.set(f.key, Math.max(found.get(f.key) ?? 0, f.len));
  const added = [...found].filter(([k, len]) => !(k in baseline) || len > baseline[k]);
  assert.deepEqual(added.map(([k, len]) => `${len} 字 ${k}`), [], '新增或變長的長句：請拆短、改成一行結論＋折疊');
  const fixed = Object.keys(baseline).filter((k) => !found.has(k));
  assert.deepEqual(fixed, [], '已改短的句子：執行 node tests/text-scan.mjs --write-baseline 更新基準（只會變少）');
});

// 低注意力讀者（懶散、資深、只看 5 秒的金融從業者）：折疊標題要一眼看懂，折疊內不能堆成一面牆。
const MAX_FOLD_SUMMARY = 14;
const MAX_FOLD_LINES = 6;
test(`折疊說明：標題 ≤ ${MAX_FOLD_SUMMARY} 字、每個折疊 ≤ ${MAX_FOLD_LINES} 行`, () => {
  const src = fs.readFileSync(path.join(root, 'shared/app.js'), 'utf8');
  const heads = [...src.matchAll(/foldNotes\('([^']+)',\s*'([^']+)',\s*([^\n]*)/g)];
  assert.ok(heads.length >= 9, '應掃到所有 foldNotes 呼叫');
  const bad = [];
  for (const m of heads) {
    const [, id, summary] = m;
    if (summary.length > MAX_FOLD_SUMMARY) bad.push(`${id}: 標題 ${summary.length} 字`);
    // 行數：從呼叫位置數到第一個「])」之前的字串（三元式的兩組清單各自數，取較大者）
    const body = src.slice(m.index + m[0].length - m[3].length).split('])')[0];
    const lines = Math.max(...body.split(' : [').map((part) => [...part.matchAll(/'[^']*'/g)].length));
    if (lines > MAX_FOLD_LINES) bad.push(`${id}: ${lines} 行`);
  }
  assert.deepEqual(bad, [], '標題要短、細節拆成 ≤ 6 行；太多就分成兩個折疊');
});
