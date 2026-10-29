// 取り込み用JSONの検査ツール（tools/check-private.mjs）と、取り込み形式の確認
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPrivate, loadExamDefs } from '../tools/check-private.mjs';

const exams = loadExamDefs();
const base = (over = {}) => ({
  id: 'takken-kenri-p202501', subject: 'kenri', tags: ['R7'], type: 'choice', ask: '最も不適当なもの', pick: false, stem: '問題文',
  choices: [{ text: 'A', ok: true }, { text: 'B', ok: false }, { text: 'C', ok: true }, { text: 'D', ok: true }],
  source: { kind: 'past-exam', ref: '令和7年度 宅建試験 問1', url: 'https://example.invalid/' }, lawAsOf: '2025-04-01', reviewed: false, ...over,
});
const single = (over = {}) => base({ id: 'takken-kenri-p202503', type: 'single', ask: undefined, pick: undefined, choices: [{ text: '一つ' }, { text: '二つ' }, { text: '三つ' }, { text: '四つ' }], answer: 1, ...over });
const file = (qs, over = {}) => JSON.stringify({ schemaVersion: 1, exam: 'takken', questions: qs, ...over });

test('過去問の取り込み形式（explanation・basis なし、choice と single）が検査に通る', () => {
  const r = checkPrivate(file([base(), single()]), exams);
  assert.equal(r.ok, true, r.problems.join('\n'));
  assert.deepEqual(r.counts, { total: 2, byType: { choice: 1, single: 1 }, bySubject: { kenri: 2 } });
});

test('おかしい問題はすべて一覧にする（最初の1件で止まらない）', () => {
  const r = checkPrivate(file([
    base({ id: 'takken-kenri-0001' }),                                        // 公開データの形の id
    base({ id: 'takken-kenri-p202502', choices: base().choices.slice(0, 3) }), // 選択肢が3つ
    single({ answer: 7 }),                                                     // 正解番号が範囲外
    base({ id: 'takken-kenri-p202504' }),                                      // これは正常
    base({ id: 'takken-kenri-p202504' }),                                      // 重複
  ]), exams);
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 4);
  const all = r.problems.join('\n');
  assert.match(all, /p4〜8桁/);
  assert.match(all, /4 個/);
  assert.match(all, /answer/);
  assert.match(all, /重複/);
});

test('壊れたJSON・文字化け・別の資格・questions なし', () => {
  assert.equal(checkPrivate('{broken', exams).ok, false);
  assert.match(checkPrivate(file([base()]).replace('問題文', '��'), exams).problems[0], /UTF-8/);
  assert.match(checkPrivate(file([base()], { exam: 'zzz' }), exams).problems[0], /data\/ にありません/);
  assert.match(checkPrivate(JSON.stringify({ schemaVersion: 1, exam: 'takken' }), exams).problems[0], /questions/);
});
