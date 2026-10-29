// 学習記録・復習の箱・合わせ方・正答率の計算
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOX_DAYS, makeRecord, itemIdFor, questionIdOf, isValidRecord, toDateKey, addDaysKey, daysBetween,
  itemState, isDue, computeStates, dueItemIds, wrongItemIds, mergeRecords, accuracyBy, accuracyBySubject, sortRecords,
} from '../js/progress.js';

// 現地時刻で日時を作る（タイムゾーンに関係なく、日付の境目の判定が同じになる）
const at = (y, m, d, hh = 12, mm = 0) => new Date(y, m - 1, d, hh, mm);
let seq = 0;
const rec = (itemId, correct, when, extra = {}) => makeRecord({ id: `r${String(++seq).padStart(4, '0')}`, itemId, examId: 'takken', correct, mode: 'choice', device: 'pc', at: when, ...extra });
const stateOf = (list, id = 'q1') => itemState(id, sortRecords(list.filter((r) => r.itemId === id)));

test('箱の間隔は 1・3・7・14・30 日', () => {
  assert.deepEqual(BOX_DAYS, [1, 3, 7, 14, 30]);
});

test('初めて見る項目は未学習（復習の対象にならない）', () => {
  const s = itemState('q1', []);
  assert.equal(s.seen, false);
  assert.equal(s.box, 1);
  assert.equal(s.nextDate, null);
  assert.equal(isDue(s, at(2026, 11, 1)), false);
});

test('期限が来るたびに正解すると次の箱へ進み、箱5で止まる。次回の日は答えた日＋進んだ先の箱の間隔', () => {
  const list = [];
  let day = '2026-01-01';
  const expected = [[2, 3], [3, 7], [4, 14], [5, 30], [5, 30], [5, 30]]; // [箱, 間隔(日)]
  expected.forEach(([box, days], i) => {
    const [y, m, d] = day.split('-').map(Number);
    list.push(rec('q1', true, at(y, m, d)));
    const s = stateOf(list);
    assert.equal(s.box, box, `${i + 1}回目の正解のあとの箱`);
    assert.equal(s.nextDate, addDaysKey(day, days), `${i + 1}回目の次回`);
    day = s.nextDate; // 次は期限の日に答える
  });
});

test('同じ日に何度正解しても箱は1つしか進まない（4回正解しても箱5にならない）', () => {
  const list = [0, 1, 2, 3].map((h) => rec('q1', true, at(2026, 1, 1, 9 + h)));
  const s = stateOf(list);
  assert.equal(s.box, 2);
  assert.equal(s.nextDate, '2026-01-04');
});

test('期限前の正解は箱も次回期限も据え置く。期限の日（以降）の正解は進める', () => {
  const list = [rec('q1', true, at(2026, 1, 1))]; // 箱2 → 1/4
  list.push(rec('q1', true, at(2026, 1, 3))); // 期限前
  assert.equal(stateOf(list).box, 2);
  assert.equal(stateOf(list).nextDate, '2026-01-04');
  list.push(rec('q1', true, at(2026, 1, 4))); // 期限の日
  assert.equal(stateOf(list).box, 3);
  assert.equal(stateOf(list).nextDate, '2026-01-11');
  list.push(rec('q1', true, at(2026, 2, 20))); // 期限をだいぶ過ぎてから
  assert.equal(stateOf(list).box, 4);
  assert.equal(stateOf(list).nextDate, '2026-03-06');
});

test('間違えた直後のやり直しで正解しても、箱1のまま翌日が期限（間違えた問題の一覧からは外れる）', () => {
  const list = [rec('q1', true, at(2026, 1, 1)), rec('q1', true, at(2026, 1, 4))]; // 箱3
  list.push(rec('q1', false, at(2026, 1, 10, 10)));
  list.push(rec('q1', true, at(2026, 1, 10, 10, 5)));
  const s = stateOf(list);
  assert.equal(s.box, 1);
  assert.equal(s.nextDate, '2026-01-11');
  assert.equal(s.lastCorrect, true);
  assert.deepEqual(wrongItemIds(list), []);
  assert.deepEqual(dueItemIds(list, at(2026, 1, 10, 23)), []);
  assert.deepEqual(dueItemIds(list, at(2026, 1, 11)), ['q1']);
});

test('不正解は箱1に戻り、次回は翌日', () => {
  const list = [rec('q1', true, at(2026, 1, 1)), rec('q1', true, at(2026, 1, 4)), rec('q1', true, at(2026, 1, 11))];
  assert.equal(stateOf(list).box, 4);
  list.push(rec('q1', false, at(2026, 1, 20)));
  const s = stateOf(list);
  assert.equal(s.box, 1);
  assert.equal(s.lastCorrect, false);
  assert.equal(s.nextDate, '2026-01-21');
});

test('最初から不正解なら箱1・翌日が期限、そのあと正解すると箱2', () => {
  const list = [rec('q1', false, at(2026, 3, 10))];
  assert.equal(stateOf(list).box, 1);
  assert.equal(stateOf(list).nextDate, '2026-03-11');
  list.push(rec('q1', true, at(2026, 3, 11)));
  assert.equal(stateOf(list).box, 2);
  assert.equal(stateOf(list).nextDate, '2026-03-14');
});

test('期限の判定は現地の日付で行う（夜の回答でも「翌日」は翌日の0時から）', () => {
  const s = stateOf([rec('q1', false, at(2026, 5, 1, 23, 59))]); // 箱1 → 次回 5/2
  assert.equal(s.nextDate, '2026-05-02');
  assert.equal(isDue(s, at(2026, 5, 1, 23, 59)), false);
  assert.equal(isDue(s, at(2026, 5, 2, 0, 0)), true);
  assert.equal(isDue(s, '2026-05-02'), true);
  assert.equal(isDue(s, '2026-05-01'), false);
  assert.equal(isDue(s, at(2026, 6, 30)), true); // 期限を過ぎても対象のまま
});

test('月・年またぎの日付計算', () => {
  assert.equal(addDaysKey('2026-12-31', 1), '2027-01-01');
  assert.equal(addDaysKey('2026-01-31', 30), '2026-03-02');
  assert.equal(daysBetween('2026-10-29', '2027-10-17'), 353);
  assert.equal(daysBetween('2026-10-29', '2026-10-29'), 0);
  assert.equal(daysBetween('2026-10-30', '2026-10-29'), -1);
});

test('今日の復習: 期限が来た項目だけを、期限の古い順に返す', () => {
  const list = [
    rec('a', true, at(2026, 1, 1)),   // 箱2 → 1/4
    rec('b', false, at(2026, 1, 2)),  // 箱1 → 1/3
    rec('c', true, at(2026, 1, 3)),   // 箱2 → 1/6
    rec('d', true, at(2026, 1, 1)), rec('d', true, at(2026, 1, 4)), // 箱3 → 1/11
  ];
  assert.deepEqual(dueItemIds(list, at(2026, 1, 3)), ['b']);
  assert.deepEqual(dueItemIds(list, at(2026, 1, 6)), ['b', 'a', 'c']);
  assert.deepEqual(dueItemIds(list, at(2026, 1, 11)), ['b', 'a', 'c', 'd']);
  assert.deepEqual(dueItemIds([], at(2026, 1, 1)), []);
});

test('同じ項目の記録が時刻の順でなくても、古い順に並べて計算する', () => {
  const a = rec('q1', true, at(2026, 2, 1));
  const b = rec('q1', false, at(2026, 2, 5));
  assert.equal(stateOf([b, a]).box, 1);
  assert.equal(computeStates([b, a]).get('q1').lastCorrect, false);
});

test('間違えた問題: 直近の回答が不正解のものだけ。新しく間違えた順', () => {
  const list = [
    rec('a', false, at(2026, 1, 1)), rec('a', true, at(2026, 1, 5)),   // 直近は正解 → 含めない
    rec('b', true, at(2026, 1, 1)), rec('b', false, at(2026, 1, 6)),   // 含める
    rec('c', false, at(2026, 1, 2)),                                   // 含める（古い）
    rec('d', false, at(2026, 1, 9)),                                   // 含める（最新）
  ];
  assert.deepEqual(wrongItemIds(list), ['d', 'b', 'c']);
});

test('項目ID: 4択は問題id、○×は 問題id#選択肢番号、○×問題は問題id', () => {
  const choice = { id: 'takken-kenri-0001', type: 'choice' };
  const tf = { id: 'takken-gyouhou-0004', type: 'truefalse' };
  assert.equal(itemIdFor(choice, 'choice'), 'takken-kenri-0001');
  assert.equal(itemIdFor(choice, 'tf', 0), 'takken-kenri-0001#0');
  assert.equal(itemIdFor(choice, 'tf', 3), 'takken-kenri-0001#3');
  assert.equal(itemIdFor(tf, 'tf'), 'takken-gyouhou-0004');
  assert.equal(itemIdFor(tf, 'choice'), 'takken-gyouhou-0004');
  assert.equal(questionIdOf('takken-kenri-0001#2'), 'takken-kenri-0001');
  assert.equal(questionIdOf('takken-kenri-0001'), 'takken-kenri-0001');
});

test('4択として解いた記録と、○×として解いた記録は別の項目として数える', () => {
  const list = [
    rec('takken-kenri-0001', true, at(2026, 1, 1)),
    rec('takken-kenri-0001#0', false, at(2026, 1, 1), { mode: 'tf' }),
  ];
  const st = computeStates(list);
  assert.equal(st.size, 2);
  assert.equal(st.get('takken-kenri-0001').box, 2);
  assert.equal(st.get('takken-kenri-0001#0').box, 1);
});

test('記録の形の検査と作成', () => {
  const r = makeRecord({ itemId: 'x', examId: 'takken', correct: 1, mode: 'tf', device: 'sp', at: new Date('2026-01-01T00:00:00Z') });
  assert.equal(r.correct, true);
  assert.equal(r.at, '2026-01-01T00:00:00.000Z');
  assert.ok(isValidRecord(r));
  assert.ok(r.id.length > 8);
  assert.notEqual(makeRecord({ itemId: 'x', examId: 'takken', correct: true, mode: 'tf' }).id, makeRecord({ itemId: 'x', examId: 'takken', correct: true, mode: 'tf' }).id);
  assert.throws(() => makeRecord({ itemId: 'x', examId: 'takken', correct: true, mode: 'zzz' }));
  for (const bad of [null, {}, { ...r, id: '' }, { ...r, at: 'いつか' }, { ...r, at: '2026-01-01' }, { ...r, at: '2026/01/01 10:00' },
    { ...r, at: '1999-12-31T23:59:59.000Z' }, { ...r, at: '2101-01-01T00:00:00.000Z' }, { ...r, at: '2026-13-40T00:00:00.000Z' }, { ...r, correct: 'yes' }, { ...r, mode: 'x' }, { ...r, itemId: undefined }]) {
    assert.equal(isValidRecord(bad), false);
  }
});

test('記録のマージ: id で重複を除き、足りない記録だけが増える（順序・端末が違っても同じ結果）', () => {
  const a1 = rec('q1', true, at(2026, 1, 1), { device: 'pc' });
  const a2 = rec('q1', false, at(2026, 1, 2), { device: 'pc' });
  const b1 = rec('q2', true, at(2026, 1, 1, 13), { device: 'sp' });
  const pc = [a1, a2];
  const sp = [a2, b1, { broken: true }];
  const m1 = mergeRecords(pc, sp);
  assert.equal(m1.added, 1);
  assert.equal(m1.duplicate, 1);
  assert.equal(m1.invalid, 1);
  assert.equal(m1.records.length, 3);
  assert.deepEqual(m1.records.map((r) => r.id), [a1.id, b1.id, a2.id]);
  // 逆向きに合わせても、同じ記録の集まりになる
  const m2 = mergeRecords(sp.filter((r) => r.id), pc);
  assert.deepEqual(m2.records.map((r) => r.id), m1.records.map((r) => r.id));
  // 同じものをもう一度読み込んでも増えない
  const m3 = mergeRecords(m1.records, sp);
  assert.equal(m3.added, 0);
  assert.equal(m3.records.length, 3);
});

test('科目別正答率と、汎用の集計', () => {
  const subj = (qid) => ({ 'takken-kenri-0001': 'kenri', 'takken-kenri-0002': 'kenri', 'takken-zei-0001': 'zei' })[qid];
  const list = [
    rec('takken-kenri-0001', true, at(2026, 1, 1)),
    rec('takken-kenri-0002', false, at(2026, 1, 1)),
    rec('takken-kenri-0001#2', true, at(2026, 1, 2), { mode: 'tf' }),
    rec('takken-kenri-0001', true, at(2026, 1, 3)),
    rec('takken-zei-0001', false, at(2026, 1, 1)),
    rec('消えた問題', true, at(2026, 1, 1)),
  ];
  const acc = accuracyBySubject(list, subj);
  assert.deepEqual(acc.get('kenri'), { answers: 4, correct: 3, rate: 0.75 });
  assert.deepEqual(acc.get('zei'), { answers: 1, correct: 0, rate: 0 });
  assert.equal(acc.size, 2); // 科目の分からない記録は数えない
  const byDay = accuracyBy(list, (r) => toDateKey(r.at));
  assert.equal(byDay.get('2026-01-01').answers, 4);
});

test('確認の印: 作成・検査・id でのマージ・問題ごとに最新が有効', async () => {
  const { makeReview, isValidReview, mergeReviews, latestReviews } = await import('../js/progress.js');
  const a = makeReview({ id: 'v1', questionId: 'q1', status: 'suspect', note: '数字が違うかも', device: 'pc', at: at(2026, 1, 1) });
  const b = makeReview({ id: 'v2', questionId: 'q1', status: 'ok', device: 'sp', at: at(2026, 1, 2) });
  const c = makeReview({ id: 'v3', questionId: 'q2', status: 'suspect', at: at(2026, 1, 1) });
  assert.ok([a, b, c].every(isValidReview));
  assert.equal(a.note, '数字が違うかも');
  assert.equal(b.note, '');
  assert.throws(() => makeReview({ questionId: 'q1', status: 'maybe' }));
  for (const bad of [null, {}, { ...a, status: 'x' }, { ...a, questionId: '' }, { ...a, at: '昨日' }, { ...a, id: '' }]) assert.equal(isValidReview(bad), false);
  const m = mergeReviews([a, c], [b, a, { broken: 1 }]);
  assert.equal(m.added, 1);
  assert.equal(m.duplicate, 1);
  assert.equal(m.invalid, 1);
  assert.deepEqual(m.reviews.map((r) => r.id), ['v1', 'v3', 'v2']);
  const latest = latestReviews(m.reviews);
  assert.equal(latest.get('q1').status, 'ok');      // 後から押した「確認済み」が有効
  assert.equal(latest.get('q2').status, 'suspect');
  assert.equal(mergeReviews(m.reviews, m.reviews).added, 0);
});
