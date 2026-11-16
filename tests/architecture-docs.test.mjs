// Guards the architecture docs so they cannot drift from the code: doc map, file map, concept owners,
// the numbers quoted by the style guide, and the decision log's heading format.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { root, MAX_SENTENCE_LEN } from './text-scan.mjs';

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const arch = read('docs/設計架構與計算邏輯.md');
const section = (text, startHeading, endHeading) => {
  const from = text.indexOf(startHeading);
  assert.ok(from >= 0, `missing section ${startHeading}`);
  const to = endHeading ? text.indexOf(endHeading, from + startHeading.length) : text.length;
  return text.slice(from, to < 0 ? text.length : to);
};

test('文件分工：每份 docs/*.md 都列在架構文件，文件內的相對連結都存在', () => {
  const map = section(arch, '## 文件分工', '## 表的擁有者與防線');
  for (const f of fs.readdirSync(path.join(root, 'docs')).filter((n) => n.endsWith('.md'))) {
    assert.ok(map.includes(`(${f})`) || map.includes(`(docs/${f})`), `docs/${f} 沒有列在「文件分工」`);
  }
  for (const file of fs.readdirSync(path.join(root, 'docs')).filter((n) => n.endsWith('.md'))) {
    for (const [, target] of read(`docs/${file}`).matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
      if (/^https?:/.test(target)) continue;
      assert.ok(fs.existsSync(path.join(root, 'docs', target)), `docs/${file} 連到不存在的 ${target}`);
    }
  }
});

test('檔案分工：每支 shared/*.js 與 sw.js 都在表上，文件寫的 shared 路徑都存在', () => {
  const files = section(arch, '## 二、檔案分工與載入順序', '## 三、');
  const shared = fs.readdirSync(path.join(root, 'shared')).filter((n) => n.endsWith('.js')).map((n) => `shared/${n}`);
  for (const rel of [...shared, 'sw.js']) assert.ok(files.includes(`\`${rel}\``) || files.includes(rel), `${rel} 沒有列在「檔案分工」`);
  for (const [, rel] of arch.matchAll(/`(shared\/[\w.-]+\.(?:js|css))/g)) assert.ok(fs.existsSync(path.join(root, rel)), `文件寫的 ${rel} 不存在`);
});

test('概念與唯一擁有者：表上寫的函式真的存在', () => {
  const ctx = { console, structuredClone };
  vm.createContext(ctx);
  for (const rel of ['shared/reference-data.js', 'shared/config.js', 'shared/snapshots.js', 'shared/validation.js', 'shared/planning.js', 'shared/money.js']) {
    vm.runInContext(read(rel), ctx, { filename: rel });
  }
  const api = vm.runInContext('({Planning, Money, Snapshots, Validation})', ctx);
  const owners = section(arch, '### 5.1 概念與唯一擁有者', '### 5.2');
  const seen = new Set();
  for (const [, obj, name] of owners.matchAll(/\b(Planning|Money|Snapshots|Validation)\.(\w+)/g)) {
    seen.add(`${obj}.${name}`);
    assert.equal(typeof api[obj][name], 'function', `5.1 寫了 ${obj}.${name}，程式裡沒有這個函式`);
  }
  assert.ok(seen.size >= 10, '概念表仍涵蓋足夠多的擁有者');
});

test('文字與視覺規範：寫的字數上限等於程式常數', () => {
  const style = read('docs/文字與視覺規範.md');
  assert.ok(style.includes(`超過 ${MAX_SENTENCE_LEN} 字`), `規範文件要寫「超過 ${MAX_SENTENCE_LEN} 字」（tests/text-scan.mjs 的 MAX_SENTENCE_LEN）`);
});

test('決定紀錄：每個段落標題都有「（使用者 YYYY-MM-DD…）」', () => {
  const log = read('docs/決定紀錄.md');
  const headings = log.split('\n').filter((l) => l.startsWith('## '));
  assert.ok(headings.length >= 5, '決定紀錄仍有內容');
  for (const h of headings) assert.match(h, /（使用者 \d{4}-\d{2}-\d{2}[^）]*）$/, `標題格式不符：${h}`);
});
