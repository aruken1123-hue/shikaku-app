// 確認の印のまわり（メモの長さ・日時の順・書き出しを促す条件）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeReview, mergeReviews, nextReviewAt, latestReviews, makeRecord, REVIEW_NOTE_MAX } from '../js/progress.js';
import { needsBackup } from '../js/stats.js';

test('メモは500文字で切る（取り込んだ長いメモも）', () => {
  assert.equal(REVIEW_NOTE_MAX, 500);
  assert.equal(makeReview({ questionId: 'q1', status: 'suspect', note: 'あ'.repeat(800) }).note.length, 500);
  assert.equal(makeReview({ questionId: 'q1', status: 'suspect', note: 'あ'.repeat(500) }).note.length, 500);
  const imported = { ...makeReview({ id: 'long1', questionId: 'q1', status: 'suspect' }), note: 'あ'.repeat(800) };
  assert.equal(mergeReviews([], [imported]).reviews[0].note.length, 500);
});

test('新しい印の日時は同じ問題の前の印より必ず後（端末の時計が戻っていても）', () => {
  const prev = makeReview({ id: 'a', questionId: 'q1', status: 'suspect', at: new Date(2026, 5, 1, 12) });
  const clockBack = new Date(2026, 5, 1, 11);
  const at2 = nextReviewAt(prev, clockBack);
  assert.ok(at2.getTime() > Date.parse(prev.at));
  assert.equal(at2.getTime(), Date.parse(prev.at) + 1);
  assert.equal(nextReviewAt(prev, new Date(2026, 5, 2)).getTime(), new Date(2026, 5, 2).getTime()); // 普通は今の時刻
  assert.equal(nextReviewAt(null, clockBack).getTime(), clockBack.getTime());
  const b = makeReview({ id: 'b', questionId: 'q1', status: 'ok', at: nextReviewAt(prev, clockBack) });
  assert.equal(latestReviews([b, prev]).get('q1').status, 'ok'); // あとに押した印が最新
});

test('書き出しを促す判定には、確認の印の増加も含める', () => {
  const day = (d) => new Date(2026, 0, d, 12);
  const r = (d) => makeRecord({ itemId: 'x', examId: 'takken', correct: true, mode: 'choice', at: day(d) });
  const v = (d) => ({ at: day(d).toISOString() });
  // 学習記録は書き出し前まで、印だけが書き出しのあとに増えた
  assert.equal(needsBackup({ lastExportAt: day(10).toISOString(), records: [r(1)], reviews: [v(12)], now: day(30) }), true);
  assert.equal(needsBackup({ lastExportAt: day(10).toISOString(), records: [r(1)], reviews: [v(5)], now: day(30) }), false);
  // 記録は無く印だけでも、最初の印から14日たてば促す
  assert.equal(needsBackup({ lastExportAt: '', records: [], reviews: [v(1)], now: day(20) }), true);
  assert.equal(needsBackup({ lastExportAt: '', records: [], reviews: [], now: day(20) }), false);
  // 従来の呼び方（reviews なし）も動く
  assert.equal(needsBackup({ lastExportAt: '', records: [r(1)], now: day(20) }), true);
});
