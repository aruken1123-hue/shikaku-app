// 取り込み用のJSON（tools/import-retio.py の出力など）が、アプリの検査（js/store.js）に通るか確かめる。
// 使い方: node tools/check-private.mjs private/takken-R7.json
// 1問ずつ検査して、おかしい問題をすべて一覧にする（アプリの取り込みは最初の1件で止まるため）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateExam, validateQuestion, prepareImport, assertNoMojibake } from '../js/store.js';

const dataDir = new URL('../data/', import.meta.url);

/** data/ の資格の定義（問題は読まない）を { exam, questions: [] } の形で全部読む */
export function loadExamDefs() {
  const index = JSON.parse(readFileSync(new URL('index.json', dataDir), 'utf8'));
  return index.exams.map((e) => ({ exam: validateExam(JSON.parse(readFileSync(new URL(e.path, dataDir), 'utf8'))), questions: [] }));
}

/** 検査する。戻り値 { ok, problems: [文字列], counts: { byType, bySubject, total } } */
export function checkPrivate(text, exams = loadExamDefs()) {
  const problems = [];
  const counts = { total: 0, byType: {}, bySubject: {} };
  let json;
  try {
    assertNoMojibake(text);
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, problems: [e.message], counts };
  }
  const entry = exams.find((e) => e.exam.id === (json && json.exam));
  if (!entry) return { ok: false, problems: [`この資格（${json && json.exam}）は data/ にありません`], counts };
  if (!Array.isArray(json.questions)) return { ok: false, problems: ['questions（問題の配列）がありません'], counts };
  const seen = new Set();
  for (const q of json.questions) {
    try {
      validateQuestion(JSON.parse(JSON.stringify(q)), entry.exam, { priv: true });
      if (seen.has(q.id)) throw new Error(`問題 ${q.id} が重複しています`);
      seen.add(q.id);
      counts.total++;
      counts.byType[q.type] = (counts.byType[q.type] || 0) + 1;
      counts.bySubject[q.subject] = (counts.bySubject[q.subject] || 0) + 1;
    } catch (e) {
      problems.push(e.message);
    }
  }
  // ファイル全体としても、アプリの取り込みと同じ関数に通ることを確かめる
  if (!problems.length) {
    try { prepareImport(json, exams); } catch (e) { problems.push(e.message); }
  }
  return { ok: problems.length === 0, problems, counts };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error('使い方: node tools/check-private.mjs <取り込み用のJSON>');
    process.exit(2);
  }
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { console.error(`ファイルを読めません: ${e.message}`); process.exit(2); }
  const r = checkPrivate(text);
  const fmt = (o) => Object.entries(o).sort().map(([k, v]) => `${k} ${v}`).join('、');
  console.log(`${file}: ${r.ok ? '検査に通りました' : '検査に通りませんでした'}（問題 ${r.counts.total} 問）`);
  console.log(`  型別: ${fmt(r.counts.byType)}`);
  console.log(`  科目別: ${fmt(r.counts.bySubject)}`);
  for (const p of r.problems) console.log(`  - ${p}`);
  process.exit(r.ok ? 0 : 1);
}
