// Shared scanner: finds Chinese sentences longer than the limit in UI source files.
// Used by long-text.test.mjs and by `node tests/text-scan.mjs` to list current offenders.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MAX_SENTENCE_LEN = 40;
export const FILES = ['shared/app.js', 'index.html'];
const CJK = /[一-鿿]/;

function literalsOf(rel, text) {
  if (rel.endsWith('.html')) {
    const noScript = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '');
    return [...noScript.matchAll(/>([^<]{5,})</g)].map((m) => m[1]);
  }
  text = text.replace(/(['"`])\s*\+\s*\1/g, ''); // 'a' + 'b' is one block of text
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  return [...text.matchAll(re)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
}

// Returns [{file, key, len, text}] for every sentence over the limit.
export function scanLongSentences() {
  const out = [];
  for (const rel of FILES) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const lit of literalsOf(rel, text)) {
      // One literal = one block of text shown together; interpolations count as 4 chars (a typical number).
      const clean = lit.replace(/\$\{[^}]*\}/g, '0000').replace(/\s+/g, ' ').trim();
      if (!CJK.test(clean)) continue;
      if (clean.length > MAX_SENTENCE_LEN) out.push({ file: rel, key: `${rel}::${clean.slice(0, 24)}`, len: clean.length, text: clean });
    }
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const found = scanLongSentences();
  if (process.argv.includes('--write-baseline')) {
    const base = {};
    for (const f of found) base[f.key] = Math.max(base[f.key] ?? 0, f.len);
    const sorted = Object.fromEntries(Object.entries(base).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(path.join(root, 'tests/long-text-baseline.json'), JSON.stringify(sorted, null, 2) + '\n');
    console.log(`baseline: ${Object.keys(sorted).length} sentences`);
  } else {
    for (const f of found) console.log(f.len, f.key);
    console.log(`total ${found.length}`);
  }
}
