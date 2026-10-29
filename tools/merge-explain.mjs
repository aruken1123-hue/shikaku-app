// 過去問の取り込みJSONに、別ファイルの解説（AIの下書き）を合わせて、新しい取り込みJSONを作る。
// 使い方: node tools/merge-explain.mjs <取り込みJSON> <解説JSON>... --out <出力JSON>
// 例: node tools/merge-explain.mjs private/takken-R7.json private/explain/R7-*.json --out private/takken-R7-ex.json
// 解説JSONの形: { "<問題id>": { explanation, notes[], basis, basisText[], lawChangeNote, confidence, noTf } }
// 正解（ok・pick・answer）と問題文には触らない。元のファイルは上書きしない。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { correctIndex } from '../js/store.js';
import { checkPrivate } from './check-private.mjs';

/** 解説を合わせた新しいファイル（オブジェクト）と、問題の一覧を返す */
export function mergeExplain(file, explains) {
  const out = JSON.parse(JSON.stringify(file));
  const problems = [];
  const used = new Set();
  for (const q of out.questions) {
    const ex = explains[q.id];
    if (!ex) { problems.push(`${q.id}: 解説がありません`); continue; }
    used.add(q.id);
    const before = correctIndex(q);
    if (typeof ex.explanation === 'string' && ex.explanation.trim()) {
      let text = ex.explanation.trim();
      if (ex.lawChangeNote && String(ex.lawChangeNote).trim()) text += `\n【法改正の注意】${String(ex.lawChangeNote).trim()}`;
      if (ex.confidence === 'low') text += '\n（この解説は確かさが低めです。条文で確かめてください）';
      q.explanation = text;
    } else {
      problems.push(`${q.id}: explanation が空です`);
    }
    if (Array.isArray(ex.notes)) {
      if (ex.notes.length !== q.choices.length) problems.push(`${q.id}: notes の数（${ex.notes.length}）が選択肢の数（${q.choices.length}）と違います`);
      q.choices.forEach((c, i) => {
        const n = ex.notes[i];
        if (typeof n === 'string' && n.trim()) c.note = n.trim();
      });
    }
    if (typeof ex.basis === 'string' && ex.basis.trim()) q.basis = ex.basis.trim();
    if (Array.isArray(ex.basisText) && ex.basisText.length) q.basisText = ex.basisText;
    // 選択肢が名詞などで○×に分けられない問題は、解説側で noTf を付けられる
    if (ex.noTf === true) q.noTf = true;
    if (correctIndex(q) !== before) throw new Error(`${q.id}: 正解が変わってしまいます（合わせ方の誤り）`);
  }
  for (const id of Object.keys(explains)) {
    if (!used.has(id)) problems.push(`${id}: 取り込みJSONにない問題の解説です`);
  }
  out.updated = new Date().toISOString().slice(0, 10);
  return { file: out, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const o = args.indexOf('--out');
  const outPath = o >= 0 ? args[o + 1] : null;
  const inputs = o >= 0 ? args.slice(0, o).concat(args.slice(o + 2)) : args;
  if (!outPath || inputs.length < 2) {
    console.error('使い方: node tools/merge-explain.mjs <取り込みJSON> <解説JSON>... --out <出力JSON>');
    process.exit(2);
  }
  const [basePath, ...explainPaths] = inputs;
  if (inputs.includes(outPath)) { console.error('出力先が入力と同じです。別の名前にしてください'); process.exit(2); }
  const base = JSON.parse(readFileSync(basePath, 'utf8'));
  const explains = {};
  for (const p of explainPaths) {
    for (const [id, ex] of Object.entries(JSON.parse(readFileSync(p, 'utf8')))) {
      if (explains[id]) { console.error(`${id} の解説が複数のファイルにあります（${p}）`); process.exit(1); }
      explains[id] = ex;
    }
  }
  const { file, problems } = mergeExplain(base, explains);
  const text = JSON.stringify(file, null, 2) + '\n';
  const check = checkPrivate(text);
  if (!check.ok) {
    console.error('検査に通りませんでした。出力しません:');
    for (const p of check.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  if (existsSync(outPath)) console.log(`${outPath} を上書きします`);
  writeFileSync(outPath, text, 'utf8');
  console.log(`${outPath} を作りました（${file.questions.length}問、検査に通りました）`);
  if (problems.length) {
    console.log(`気になる点 ${problems.length}件:`);
    for (const p of problems) console.log(`  - ${p}`);
  }
}
