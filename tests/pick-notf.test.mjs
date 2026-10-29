// pickOf の否定の扱い、noTf（○×に出さない問題）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateExam, validateQuestion, pickOf, correctIndex } from '../js/store.js';
import { buildQueue, tfItems, resolveItem } from '../js/quiz.js';
import { makeRecord } from '../js/progress.js';

const exam = validateExam({
  schemaVersion: 1, id: 'takken', name: '宅建', revision: 1,
  exam: { questions: 50, minutes: 120, choices: 4, passLineHint: 36 },
  subjects: [{ id: 'kenri', name: '権利関係', count: 14 }], questionFiles: ['q-kenri.json'],
});
const choiceQ = (over = {}) => ({
  id: 'takken-kenri-0001', subject: 'kenri', type: 'choice', ask: '正しいもの', stem: '問題文',
  choices: [{ text: 'A', ok: false }, { text: 'B', ok: true }, { text: 'C', ok: false }, { text: 'D', ok: false }],
  source: { kind: 'original' }, reviewed: true, ...over,
});

test('pickOf: 否定（でない・ではない・くない・ていない）が付くと向きが逆になる', () => {
  const p = (ask) => pickOf({ ask });
  assert.equal(p('正しくないもの'), false);
  assert.equal(p('適切でないもの'), false);
  assert.equal(p('適切ではないもの'), false);
  assert.equal(p('適当でないもの'), false);
  assert.equal(p('誤っていないもの'), true);
  assert.equal(p('間違っていないもの'), true);
  assert.equal(p('不適切でないもの'), true);
  // ふつうの言い方は変わらない
  assert.equal(p('正しいもの'), true);
  assert.equal(p('誤っているもの'), false);
  assert.equal(p('最も不適当なもの'), false);
  assert.equal(p('適切なもの'), true);
  assert.equal(p('記載されているもの'), null);
  assert.equal(pickOf({ ask: '正しくないもの', pick: true }), true); // pick が優先
  // 4択として検査しても、正解がちょうど1つに決まる
  const q = choiceQ({ ask: '正しくないもの', choices: choiceQ().choices.map((c, i) => ({ ...c, ok: i !== 3 })) });
  validateQuestion(q, exam);
  assert.equal(correctIndex(q), 3);
});

test('noTf: 真偽値だけ許す', () => {
  validateQuestion(choiceQ({ noTf: true }), exam);
  validateQuestion(choiceQ({ noTf: false }), exam);
  assert.throws(() => validateQuestion(choiceQ({ noTf: 'yes' }), exam), /noTf/);
});

test('noTf:true の問題は○×一問一答に出ないが、4択演習・間違い・復習には出る', () => {
  const nq = validateQuestion(choiceQ({
    id: 'takken-kenri-0010', ask: '最も不適当なもの', stem: '最も不適当なものはどれか。', noTf: true,
    choices: [{ text: 'A', ok: true }, { text: 'B', ok: false }, { text: 'C', ok: true }, { text: 'D', ok: true }],
  }), exam);
  const normal = validateQuestion(choiceQ({ id: 'takken-kenri-0011' }), exam);
  const all = [nq, normal];
  const at = new Date(2026, 0, 1, 12);
  const rec = (itemId, correct, mode = 'choice') => makeRecord({ itemId, examId: 'takken', correct, mode, at });
  assert.deepEqual(tfItems(nq), []);
  assert.equal(tfItems(normal).length, 4);
  const tfIds = buildQueue({ questions: all, mode: 'tf' }).map((i) => i.itemId);
  assert.equal(tfIds.some((i) => i.startsWith('takken-kenri-0010')), false);
  assert.equal(tfIds.length, 4);
  assert.deepEqual(buildQueue({ questions: all, mode: 'choice' }).map((i) => i.itemId), ['takken-kenri-0010', 'takken-kenri-0011']);
  const records = [rec('takken-kenri-0010', false)];
  assert.deepEqual(buildQueue({ questions: all, mode: 'wrong', records }).map((i) => i.itemId), ['takken-kenri-0010']);
  assert.deepEqual(buildQueue({ questions: all, mode: 'review', records, today: new Date(2026, 0, 2) }).map((i) => i.itemId), ['takken-kenri-0010']);
  // 以前に○×として解いた記録（問題id#番号）は、出題項目にならない（黙って無視される）
  assert.deepEqual(buildQueue({ questions: all, mode: 'wrong', records: [rec('takken-kenri-0010#1', false, 'tf')] }), []);
  assert.equal(resolveItem('takken-kenri-0010#1', new Map(all.map((q) => [q.id, q]))), null);
});
