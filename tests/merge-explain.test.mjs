import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeExplain } from '../tools/merge-explain.mjs';
import { correctIndex } from '../js/store.js';

const base = () => ({
  schemaVersion: 1,
  exam: 'takken',
  questions: [
    {
      id: 'takken-kenri-p202501', subject: 'kenri', type: 'choice', ask: '正しいもの', pick: true, stem: '問題文',
      choices: [{ text: 'a', ok: false }, { text: 'b', ok: true }, { text: 'c', ok: false }, { text: 'd', ok: false }],
    },
    {
      id: 'takken-kenri-p202502', subject: 'kenri', type: 'single', answer: 2, stem: '個数問題',
      choices: [{ text: '一つ' }, { text: '二つ' }, { text: '三つ' }, { text: '四つ' }],
    },
  ],
});

test('解説・ひとこと・根拠を入れ、正解は変えない', () => {
  const { file, problems } = mergeExplain(base(), {
    'takken-kenri-p202501': { explanation: '理由', notes: ['n1', 'n2', 'n3', 'n4'], basis: '民法1条', basisText: [{ ref: '民法1条', text: '…' }] },
    'takken-kenri-p202502': { explanation: 'ア〜エ', notes: ['', '', '正解', ''], lawChangeNote: '改正あり', confidence: 'low', noTf: true },
  });
  assert.equal(file.questions[0].noTf, undefined);
  assert.equal(file.questions[1].noTf, true);
  assert.deepEqual(problems, []);
  const [a, b] = file.questions;
  assert.equal(a.explanation, '理由');
  assert.deepEqual(a.choices.map((c) => c.note), ['n1', 'n2', 'n3', 'n4']);
  assert.equal(a.basis, '民法1条');
  assert.equal(correctIndex(a), 1);
  assert.match(b.explanation, /【法改正の注意】改正あり/);
  assert.match(b.explanation, /確かさが低め/);
  assert.equal(b.choices[0].note, undefined);
  assert.equal(b.choices[2].note, '正解');
  assert.equal(correctIndex(b), 2);
});

test('元のオブジェクトは変えない', () => {
  const src = base();
  mergeExplain(src, { 'takken-kenri-p202501': { explanation: 'x' } });
  assert.equal(src.questions[0].explanation, undefined);
});

test('解説の抜け・数の違い・余分な解説を知らせる', () => {
  const { problems } = mergeExplain(base(), {
    'takken-kenri-p202501': { explanation: 'x', notes: ['1', '2'] },
    'takken-kenri-p209999': { explanation: 'y' },
  });
  assert.ok(problems.some((p) => p.includes('p202502') && p.includes('解説がありません')));
  assert.ok(problems.some((p) => p.includes('notes の数')));
  assert.ok(problems.some((p) => p.includes('p209999')));
});
