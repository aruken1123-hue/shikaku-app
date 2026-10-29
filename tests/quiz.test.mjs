// 出題キュー・○×の項目の作り方・採点、成績の表・残り日数
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateExam, validateQuestion } from '../js/store.js';
import { buildQueue, tfItems, choiceItem, resolveItem, gradeChoice, gradeTf, shuffle, tagsOf } from '../js/quiz.js';
import { makeRecord } from '../js/progress.js';
import { subjectRows, examDate, daysUntil, daysUntilText, passLine, maxPoints, needsBackup, formatRate } from '../js/stats.js';

const exam = validateExam({
  schemaVersion: 1, id: 'takken', name: '宅建', revision: 1,
  exam: { questions: 50, minutes: 120, choices: 4, passLineHint: 36 }, nextExamDate: '2027-10-17',
  subjects: [{ id: 'kenri', name: '権利関係', count: 14 }, { id: 'zei', name: '税', count: 8 }], questionFiles: ['q-kenri.json'],
});
const mk = (id, subject, over = {}) => validateQuestion({
  id, subject, type: 'choice', ask: '誤っているもの', stem: `問題${id}`, tags: ['甲'],
  choices: [{ text: 'A', ok: true, note: 'nA' }, { text: 'B', ok: false, note: 'nB' }, { text: 'C', ok: true, note: 'nC' }, { text: 'D', ok: true, note: 'nD' }],
  basis: '条文', source: { kind: 'original' }, reviewed: true, ...over,
}, exam);
const questions = [
  mk('takken-kenri-0001', 'kenri'),
  mk('takken-kenri-0002', 'kenri', { tags: ['乙'] }),
  mk('takken-zei-0001', 'zei', { status: 'retired' }),
  mk('takken-zei-0002', 'zei'),
  validateQuestion({ id: 'takken-zei-0003', subject: 'zei', type: 'truefalse', stem: '税は課される。', ok: false, tags: ['乙'], source: { kind: 'original' }, reviewed: false }, exam),
];
const at = (d, h = 12) => new Date(2026, 0, d, h);
const rec = (itemId, correct, when, mode = 'choice') => makeRecord({ itemId, examId: 'takken', correct, mode, at: when });

test('○×の項目: 4択は選択肢ごとに1項目。問い方（誤っているもの）に関係なく、記述が正しいか(ok)を答えにする', () => {
  const items = tfItems(questions[0]);
  assert.equal(items.length, 4);
  assert.deepEqual(items.map((i) => i.itemId), ['takken-kenri-0001#0', 'takken-kenri-0001#1', 'takken-kenri-0001#2', 'takken-kenri-0001#3']);
  assert.deepEqual(items.map((i) => i.answer), [true, false, true, true]);
  assert.equal(items[1].statement, 'B');
  assert.equal(items[1].note, 'nB');
  assert.equal(gradeTf(items[1], false), true);
  assert.equal(gradeTf(items[1], true), false);
});

test('○×問題は1項目で、itemId は問題id', () => {
  const [it] = tfItems(questions[4]);
  assert.equal(it.itemId, 'takken-zei-0003');
  assert.equal(it.statement, '税は課される。');
  assert.equal(it.answer, false);
});

test('4択の採点: 正解は ask と ok から決まる', () => {
  const it = choiceItem(questions[0]);
  assert.equal(gradeChoice(it, 1), true);
  assert.equal(gradeChoice(it, 0), false);
});

test('4択演習: 4択問題だけ・retired は出ない。科目・タグで絞れる', () => {
  const q = (o) => buildQueue({ questions, mode: 'choice', ...o }).map((i) => i.itemId);
  assert.deepEqual(q({}), ['takken-kenri-0001', 'takken-kenri-0002', 'takken-zei-0002']);
  assert.deepEqual(q({ subject: 'kenri' }), ['takken-kenri-0001', 'takken-kenri-0002']);
  assert.deepEqual(q({ tag: '乙' }), ['takken-kenri-0002']);
  assert.deepEqual(q({ subject: 'zei', tag: '乙' }), []); // ○×問題は4択に出ない
  assert.deepEqual(q({ limit: 2 }), ['takken-kenri-0001', 'takken-kenri-0002']);
});

test('○×演習: 4択の選択肢と ○×問題が出る（retired は出ない）', () => {
  const ids = buildQueue({ questions, mode: 'tf' }).map((i) => i.itemId);
  assert.equal(ids.length, 4 + 4 + 4 + 1); // kenri-0001, kenri-0002, zei-0002 の各4つ + ○×問題
  assert.ok(!ids.some((i) => i.startsWith('takken-zei-0001')));
  assert.ok(ids.includes('takken-zei-0003'));
});

test('ランダム: 乱数を差し替えると順番が決まり、中身は同じ', () => {
  const seq = () => { let n = 0; return () => [0.1, 0.9, 0.5, 0.3][n++ % 4]; };
  const a = buildQueue({ questions, mode: 'choice', order: 'random', rng: seq() }).map((i) => i.itemId);
  const b = buildQueue({ questions, mode: 'choice', order: 'random', rng: seq() }).map((i) => i.itemId);
  assert.deepEqual(a, b);
  assert.deepEqual([...a].sort(), ['takken-kenri-0001', 'takken-kenri-0002', 'takken-zei-0002']);
  assert.deepEqual(shuffle([1, 2, 3, 4], () => 0.999), [1, 2, 3, 4]);
});

test('今日の復習: 期限の来た項目（4択・○×の両方）を出す。消えた・retired の問題は除く', () => {
  const records = [
    rec('takken-kenri-0001', true, at(1)),                   // 箱2 → 1/4
    rec('takken-kenri-0002#1', false, at(1), 'tf'),          // 箱1 → 1/2
    rec('takken-zei-0001', false, at(1)),                    // retired → 出さない
    rec('takken-gone-0001', false, at(1)),                   // 問題が無い → 出さない
    rec('takken-zei-0003', false, at(1), 'tf'),              // ○×問題 → 1/2
  ];
  const ids = (d) => buildQueue({ questions, mode: 'review', records, today: at(d) }).map((i) => i.itemId);
  assert.deepEqual(ids(1), []);
  assert.deepEqual(ids(2), ['takken-kenri-0002#1', 'takken-zei-0003']);
  assert.deepEqual(ids(4), ['takken-kenri-0002#1', 'takken-zei-0003', 'takken-kenri-0001']);
  const first = buildQueue({ questions, mode: 'review', records, today: at(2) })[0];
  assert.equal(first.kind, 'tf');
  assert.equal(first.index, 1);
});

test('間違えた問題: 直近が不正解の項目だけ', () => {
  const records = [
    rec('takken-kenri-0001', false, at(1)), rec('takken-kenri-0001', true, at(2)),
    rec('takken-kenri-0002', true, at(1)), rec('takken-kenri-0002', false, at(3)),
    rec('takken-zei-0002#3', false, at(2), 'tf'),
  ];
  const ids = buildQueue({ questions, mode: 'wrong', records }).map((i) => i.itemId);
  assert.deepEqual(ids, ['takken-kenri-0002', 'takken-zei-0002#3']);
  assert.equal(resolveItem('takken-zei-0002#9', new Map(questions.map((q) => [q.id, q]))), null);
  assert.throws(() => buildQueue({ questions, mode: 'nothing' }));
});

test('タグの一覧は出題できる問題のものだけ', () => {
  assert.deepEqual(tagsOf(questions), ['乙', '甲']);
});

test('科目別の表: 回答数・正答率・合計の行', () => {
  const records = [
    rec('takken-kenri-0001', true, at(1)), rec('takken-kenri-0001#0', false, at(1), 'tf'),
    rec('takken-kenri-0002', true, at(2)), rec('takken-zei-0003', true, at(2), 'tf'),
  ];
  const rows = subjectRows(exam, questions, records);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId.kenri.questionCount, 2);
  assert.equal(byId.kenri.answers, 3);
  assert.equal(byId.kenri.rate, 2 / 3);
  assert.equal(byId.kenri.doneItems, 3);
  assert.equal(byId.zei.questionCount, 2); // retired を除く（0002 と 0003）
  assert.equal(byId.zei.rate, 1);
  assert.equal(byId._total.answers, 4);
  assert.equal(byId._total.rate, 0.75);
  const empty = subjectRows(exam, questions, []);
  assert.equal(empty[0].rate, null);
  assert.equal(formatRate(empty[0].rate), '―');
  assert.equal(formatRate(2 / 3), '67%');
});

test('試験日・残り日数・合格目安（設定で上書きできる）', () => {
  assert.deepEqual(examDate(exam, {}), { date: '2027-10-17', overridden: false });
  assert.deepEqual(examDate(exam, { examDates: { takken: '2027-10-24' } }), { date: '2027-10-24', overridden: true });
  assert.deepEqual(examDate(exam, { examDates: { takken: '変な値' } }), { date: '2027-10-17', overridden: false });
  assert.equal(daysUntil('2027-10-17', new Date(2026, 9, 29, 23, 0)), 353);
  assert.equal(daysUntil('2026-10-29', new Date(2026, 9, 29, 0, 1)), 0);
  assert.equal(daysUntilText(353), '試験まで あと 353 日');
  assert.equal(daysUntilText(0), '今日が試験日です');
  assert.equal(daysUntilText(-3), '試験日は過ぎました');
  assert.equal(daysUntilText(null), '試験日は未設定です');
  assert.deepEqual(passLine(exam, {}), { points: 36, overridden: false });
  assert.deepEqual(passLine(exam, { passLines: { takken: 38 } }), { points: 38, overridden: true });
  assert.deepEqual(passLine(exam, { passLines: { takken: 99 } }), { points: 36, overridden: false });
});

test('書き出しを促す条件: 最後の書き出し（なければ最初の記録）から14日以上たち、その後に記録が増えている', () => {
  const day = (d) => new Date(2026, 0, d, 12);
  const r = (d) => rec('x', true, day(d));
  assert.equal(needsBackup({ lastExportAt: '', records: [], now: day(30) }), false);
  assert.equal(needsBackup({ lastExportAt: '', records: [r(1)], now: day(10) }), false);
  assert.equal(needsBackup({ lastExportAt: '', records: [r(1)], now: day(15) }), true);
  assert.equal(needsBackup({ lastExportAt: day(10).toISOString(), records: [r(1), r(12)], now: day(23) }), false);
  assert.equal(needsBackup({ lastExportAt: day(10).toISOString(), records: [r(1), r(12)], now: day(24) }), true);
  assert.equal(needsBackup({ lastExportAt: day(10).toISOString(), records: [r(1)], now: day(30) }), false); // 書き出し後に増えていない
});

test('項目IDの # の後ろが数字でなければ出題項目にしない', () => {
  const byId = new Map(questions.map((q) => [q.id, q]));
  assert.equal(resolveItem('takken-kenri-0001#1', byId).index, 1);
  for (const bad of ['takken-kenri-0001#', 'takken-kenri-0001#x', 'takken-kenri-0001#1x', 'takken-kenri-0001#-1', 'takken-kenri-0001#1#2', 'takken-kenri-0001#1.5', 'takken-zei-0003#0']) {
    assert.equal(resolveItem(bad, byId), null, bad);
  }
});

test('満点（maxPoints）があれば合格目安の上限と表示はそれに従う', () => {
  const ex = validateExam({
    schemaVersion: 1, id: 'fp', name: 'FP', revision: 1, exam: { questions: 60, minutes: 120, choices: 3, maxPoints: 100, passLineHint: 60 },
    subjects: [{ id: 'a', name: 'A', count: 60 }], questionFiles: ['q-a.json'],
  });
  assert.equal(maxPoints(ex), 100);
  assert.equal(maxPoints(exam), 50);
  assert.deepEqual(passLine(ex, { passLines: { fp: 80 } }), { points: 80, overridden: true });
  assert.deepEqual(passLine(ex, { passLines: { fp: 101 } }), { points: 60, overridden: false });
});

test('書き出しを促す判定は、記録が何十万件あっても落ちない', () => {
  const t0 = new Date(2026, 0, 1).getTime();
  const records = Array.from({ length: 300000 }, (_, i) => ({ at: new Date(t0 + i * 1000).toISOString() }));
  assert.equal(needsBackup({ lastExportAt: '', records, now: new Date(2026, 1, 1) }), true);
});

test('single 型: 4択演習・間違い・復習には出るが、○×一問一答には出ない', () => {
  const sq = validateQuestion({
    id: 'takken-kenri-0009', subject: 'kenri', type: 'single', stem: '個数の問題', tags: ['丙'],
    choices: [{ text: '一つ' }, { text: '二つ' }, { text: '三つ' }, { text: '四つ' }], answer: 2,
    source: { kind: 'original' }, reviewed: true,
  }, exam);
  const all = [...questions, sq];
  assert.equal(buildQueue({ questions: all, mode: 'choice' }).some((i) => i.itemId === 'takken-kenri-0009'), true);
  assert.equal(buildQueue({ questions: all, mode: 'tf' }).some((i) => i.itemId.startsWith('takken-kenri-0009')), false);
  assert.deepEqual(tfItems(sq), []);
  const item = choiceItem(sq);
  assert.equal(gradeChoice(item, 2), true);
  assert.equal(gradeChoice(item, 1), false);
  const records = [rec('takken-kenri-0009', false, at(1))];
  assert.deepEqual(buildQueue({ questions: all, mode: 'wrong', records }).map((i) => i.itemId), ['takken-kenri-0009']);
  assert.deepEqual(buildQueue({ questions: all, mode: 'review', records, today: at(2) }).map((i) => i.itemId), ['takken-kenri-0009']);
  const byId = new Map(all.map((q) => [q.id, q]));
  assert.equal(resolveItem('takken-kenri-0009', byId).kind, 'choice');
  assert.equal(resolveItem('takken-kenri-0009#0', byId), null); // single に○×の項目は無い
});
