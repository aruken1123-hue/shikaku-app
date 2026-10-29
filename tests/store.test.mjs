// 問題データの形の検査（store.js）と、private 問題の取り込みの判定
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateExam, validateQuestion, validateQuestionFile, validateIndex, correctIndex, pickOf, prepareImport, mergePrivate, isActive, assertNoMojibake } from '../js/store.js';

const exam = () => ({
  schemaVersion: 1, id: 'takken', name: '宅地建物取引士', revision: 1,
  exam: { questions: 50, minutes: 120, choices: 4, passLineHint: 36 },
  nextExamDate: '2027-10-17',
  subjects: [{ id: 'kenri', name: '権利関係', count: 14 }, { id: 'zei', name: '税・その他', count: 8 }],
  questionFiles: ['q-kenri.json'],
});
const choiceQ = (over = {}) => ({
  id: 'takken-kenri-0001', subject: 'kenri', type: 'choice', ask: '正しいもの', stem: '次のうち正しいものはどれか。',
  choices: [{ text: 'A', ok: false, note: 'a' }, { text: 'B', ok: true, note: 'b' }, { text: 'C', ok: false, note: 'c' }, { text: 'D', ok: false, note: 'd' }],
  basis: '民法1条', source: { kind: 'original' }, reviewed: true, ...over,
});
const tfQ = (over = {}) => ({
  id: 'takken-kenri-0002', subject: 'kenri', type: 'truefalse', stem: '〇〇である。', ok: true,
  basis: '民法2条', source: { kind: 'original' }, reviewed: false, ...over,
});

test('正解の番号は ask と ok から計算する', () => {
  assert.equal(correctIndex(choiceQ()), 1);
  const wrongAsk = choiceQ({ ask: '誤っているもの', choices: [{ text: 'A', ok: true, note: '' }, { text: 'B', ok: true, note: '' }, { text: 'C', ok: false, note: '' }, { text: 'D', ok: true, note: '' }] });
  assert.equal(correctIndex(wrongAsk), 2);
  assert.equal(correctIndex(tfQ()), -1);
  assert.equal(correctIndex(choiceQ({ choices: choiceQ().choices.map((c) => ({ ...c, ok: false })) })), -1);
});

test('正しい問題は通り、status と tags は補われる', () => {
  const q = validateQuestion(choiceQ(), exam());
  assert.equal(q.status, 'active');
  assert.deepEqual(q.tags, []);
  validateQuestion(tfQ(), exam());
});

test('不正な問題は理由つきで落ちる', () => {
  const e = exam();
  const bad = (q, re) => assert.throws(() => validateQuestion(q, e), re);
  bad(choiceQ({ id: 'kenri-0001' }), /id は/);
  bad(choiceQ({ id: 'other-kenri-0001' }), /資格ID/);
  bad(choiceQ({ id: 'takken-zei-0001' }), /科目ID/);
  bad(choiceQ({ id: 'takken-xxx-0001', subject: 'xxx' }), /科目にありません/);
  bad(choiceQ({ ask: 'どれでも' }), /ask/);
  bad(choiceQ({ choices: choiceQ().choices.slice(0, 3) }), /4 個/);
  bad(choiceQ({ choices: choiceQ().choices.map((c) => ({ ...c, ok: true })) }), /ちょうど1つ/); // 「正しいもの」で ok が4つ
  bad(choiceQ({ choices: choiceQ().choices.map((c) => ({ ...c, ok: false })) }), /ちょうど1つ/);
  bad(choiceQ({ ask: '誤っているもの' }), /ちょうど1つ/); // 誤っているもの なのに ok:false が3つ
  bad(choiceQ({ source: { kind: 'unknown' } }), /source.kind/);
  bad(choiceQ({ source: undefined }), /source.kind/);
  bad(choiceQ({ reviewed: 'yes' }), /reviewed/);
  bad(choiceQ({ status: 'deleted' }), /status/);
  bad(choiceQ({ stem: ' ' }), /stem/);
  bad(choiceQ({ lawAsOf: '令和8年' }), /lawAsOf/);
  bad(tfQ({ ok: 'はい' }), /ok/);
  bad(tfQ({ type: 'matching' }), /type/);
});

test('選択肢の数は資格の定義（exam.choices）に従う', () => {
  const e = exam();
  e.exam.choices = 5;
  assert.throws(() => validateQuestion(choiceQ(), e), /5 個/);
});

test('問題ファイル: 資格違い・科目違い・ファイル内の id 重複を弾く', () => {
  const e = exam();
  const file = (over = {}) => ({ schemaVersion: 1, exam: 'takken', subject: 'kenri', questions: [choiceQ(), tfQ()], ...over });
  validateQuestionFile(file(), e);
  assert.throws(() => validateQuestionFile(file({ exam: 'other' }), e), /資格/);
  assert.throws(() => validateQuestionFile(file({ subject: 'zei' }), e), /違う科目/);
  assert.throws(() => validateQuestionFile(file({ questions: [choiceQ(), choiceQ()] }), e), /重複/);
  assert.throws(() => validateQuestionFile(file({ schemaVersion: 2 }), e), /schemaVersion/);
});

test('資格の定義・一覧の検査', () => {
  validateExam(exam());
  const bad = (over, re) => assert.throws(() => validateExam({ ...exam(), ...over }), re);
  bad({ id: 'Takken' }, /id/);
  bad({ subjects: [] }, /subjects/);
  bad({ subjects: [{ id: 'a', name: 'A', count: 1 }, { id: 'a', name: 'B', count: 1 }] }, /2回/);
  bad({ nextExamDate: '2027/10/17' }, /nextExamDate/);
  bad({ questionFiles: ['../x.json'] }, /問題ファイル名/);
  bad({ exam: { questions: 50, minutes: 120, choices: 4, passLineHint: 99 } }, /passLineHint/);
  validateIndex({ schemaVersion: 1, exams: [{ id: 'takken', name: 'x', path: 'takken/exam.json', revision: 1 }] });
  assert.throws(() => validateIndex({ schemaVersion: 1, exams: [{ id: 'takken', name: 'x', path: '../exam.json', revision: 1 }] }), /path/);
});

test('retired の問題は出題対象外', () => {
  assert.equal(isActive({ status: 'retired' }), false);
  assert.equal(isActive({ status: 'active' }), true);
  assert.equal(isActive({}), true);
});

test('pick が無ければ ask から推定し、適切なもの／不適切なものにも対応する。決まらなければ不正データ', () => {
  const e = exam();
  assert.equal(pickOf(choiceQ()), true);
  assert.equal(pickOf(choiceQ({ ask: '誤っているもの' })), false);
  assert.equal(pickOf(choiceQ({ ask: '適切なもの' })), true);
  assert.equal(pickOf(choiceQ({ ask: '不適切なもの' })), false);
  assert.equal(pickOf(choiceQ({ ask: 'どれでも' })), null);
  assert.equal(pickOf(choiceQ({ ask: 'どれでも', pick: false })), false); // pick が優先
  assert.equal(pickOf(choiceQ({ ask: '正しいもの', pick: false })), false);
  // 不適切なもの（ok:false を選ぶ）
  const inappropriate = choiceQ({ ask: '最も不適切なもの', choices: choiceQ().choices.map((c, i) => ({ ...c, ok: i !== 2 })) });
  validateQuestion(inappropriate, e);
  assert.equal(correctIndex(inappropriate), 2);
  // 自由な ask でも pick があれば通る
  const free = choiceQ({ ask: '当てはまるのは次のうちどれか', pick: true });
  validateQuestion(free, e);
  assert.equal(correctIndex(free), 1);
  assert.throws(() => validateQuestion(choiceQ({ ask: 'どれでも' }), e), /pick/);
  assert.throws(() => validateQuestion(choiceQ({ pick: 'yes' }), e), /pick/);
  // pick:false なのに ok:false が3つ → 不正
  assert.throws(() => validateQuestion(choiceQ({ pick: false }), e), /ちょうど1つ/);
  assert.equal(correctIndex(choiceQ({ ask: 'どれでも' })), -1);
});

test('合格目安の上限は maxPoints（無ければ問題数）で検査する', () => {
  const e = (x) => ({ ...exam(), exam: { questions: 60, minutes: 120, choices: 4, ...x } });
  validateExam(e({ passLineHint: 60 }));
  assert.throws(() => validateExam(e({ passLineHint: 61 })), /passLineHint/);
  validateExam(e({ maxPoints: 100, passLineHint: 60 }));
  validateExam(e({ maxPoints: 100, passLineHint: 100 }));
  assert.throws(() => validateExam(e({ maxPoints: 100, passLineHint: 101 })), /passLineHint/);
  assert.throws(() => validateExam(e({ maxPoints: 0 })), /maxPoints/);
});

const privQ = (n, over = {}) => tfQ({ id: `takken-kenri-p${String(n).padStart(4, '0')}`, ...over });

test('取り込み: private の id は「資格ID-科目ID-p4桁」だけ。公開データの形の id は受け付けない', () => {
  const entry = { exam: exam(), questions: [validateQuestion(choiceQ(), exam())] };
  const json = { schemaVersion: 1, exam: 'takken', questions: [privQ(1, { source: { kind: 'past-exam', ref: '私的使用' }, __x: 1 }), privQ(2)] };
  const r = prepareImport(json, [entry]);
  assert.deepEqual(r.accepted.map((q) => q.id), ['takken-kenri-p0001', 'takken-kenri-p0002']);
  assert.equal(r.accepted[0].source.kind, 'past-exam'); // private なら過去問でも受け付ける
  assert.equal('__x' in r.accepted[0], false);        // 画面用の項目は持ち込まない
  // 公開データと同じ形の id（衝突しうる）は理由つきで拒否
  assert.throws(() => prepareImport({ ...json, questions: [choiceQ()] }, [entry]), /p4〜8桁/);
  assert.throws(() => prepareImport({ ...json, questions: [tfQ()] }, [entry]), /takken-kenri-p0001/);
  assert.throws(() => prepareImport({ ...json, exam: 'nothing' }, [entry]), /登録されていません/);
  assert.throws(() => prepareImport({ ...json, questions: [privQ(1, { ok: 'x' })] }, [entry]), /ok/);
  assert.throws(() => prepareImport(null, [entry]), /登録されていません/);
  // 公開側（p なし）の検査は p 付きの id を通さない
  assert.throws(() => validateQuestion(privQ(1), exam()), /id は/);
});

test('取り込み済みの問題は資格に合流し、使えない行は errors に入る（黙って捨てない）', () => {
  const exams = [{ exam: exam(), questions: [validateQuestion(choiceQ(), exam())] }];
  const errors = [];
  mergePrivate(exams, [
    { id: 'takken-kenri-p0002', examId: 'takken', question: privQ(2) },
    { id: 'takken-kenri-p0003', examId: 'takken', question: privQ(3, { ok: 'x' }) },
    { id: 'takken-kenri-0001', examId: 'takken', question: choiceQ({ stem: '公開と同じ形の id' }) }, // 旧形式・衝突しうる id
    { id: 'zzz-kenri-p0001', examId: 'zzz', question: privQ(1) },
  ], errors);
  assert.deepEqual(exams[0].questions.map((q) => q.id), ['takken-kenri-0001', 'takken-kenri-p0002']);
  assert.equal(exams[0].questions[0].stem, '次のうち正しいものはどれか。');
  assert.equal(exams[0].questions[1].__private, true);
  assert.equal(errors.length, 3);
});

test('Shift-JIS などで文字化けしたファイル（� が混ざる）は止める', () => {
  const sjis = new TextDecoder('utf-8').decode(new Uint8Array([0x8d, 0x91, 0x82, 0xb1])); // Shift-JIS の「今こ」を UTF-8 として読んだ状態
  assert.ok(sjis.includes('�'));
  assert.throws(() => assertNoMojibake(sjis), /UTF-8/);
  assert.equal(assertNoMojibake('{"stem":"宅建"}'), '{"stem":"宅建"}');
});

const singleQ = (over = {}) => ({
  id: 'takken-kenri-0003', subject: 'kenri', type: 'single', ask: '誤っているものはいくつあるか', stem: '個数の問題',
  choices: [{ text: '一つ' }, { text: '二つ' }, { text: '三つ' }, { text: '四つ' }], answer: 2,
  source: { kind: 'original' }, reviewed: true, ...over,
});

test('single 型: answer（0始まり）で正解が決まり、選択肢に ok は要らない', () => {
  const e = exam();
  const q = validateQuestion(singleQ(), e);
  assert.equal(correctIndex(q), 2);
  validateQuestion(singleQ({ ask: undefined }), e); // ask は任意
  const bad = (over, re) => assert.throws(() => validateQuestion(singleQ(over), e), re);
  bad({ answer: 4 }, /answer/);
  bad({ answer: -1 }, /answer/);
  bad({ answer: '2' }, /answer/);
  bad({ answer: undefined }, /answer/);
  bad({ choices: singleQ().choices.slice(0, 3) }, /4 個/);
  bad({ choices: [{ text: 'a' }, { text: 'b' }, { text: '' }, { text: 'd' }] }, /text/);
  assert.equal(correctIndex(singleQ({ answer: 9 })), -1);
});

test('private の id は p＋4〜8桁（過去問は p＋西暦年＋問番号）。公開データの id に p は使えない', () => {
  const e = exam();
  const priv = (id) => validateQuestion(tfQ({ id }), e, { priv: true });
  priv('takken-kenri-p0001');
  priv('takken-kenri-p202501');
  priv('takken-kenri-p12345678');
  assert.throws(() => priv('takken-kenri-p123'), /p4〜8桁/);
  assert.throws(() => priv('takken-kenri-p123456789'), /p4〜8桁/);
  assert.throws(() => priv('takken-kenri-0001'), /p4〜8桁/);
  assert.throws(() => validateQuestion(tfQ({ id: 'takken-kenri-p202501' }), e), /id は/);
});

test('basisText（根拠条文の本文）の検査', () => {
  const e = exam();
  const ok = { ref: '宅建業法35条6項', lawId: '327AC1000000176', elm: 'MainProvision-Article_35-Paragraph_6', asOf: '2026-10-29', text: '条文…' };
  validateQuestion(choiceQ({ basisText: [ok, { ref: '民法1条', text: '本文' }] }), e);
  const bad = (v, re) => assert.throws(() => validateQuestion(choiceQ({ basisText: v }), e), re);
  bad('条文', /配列/);
  bad([{ ref: '民法1条' }], /ref（条文名）と text/);
  bad([{ text: '本文' }], /ref（条文名）と text/);
  bad([{ ...ok, asOf: '昨日' }], /asOf/);
  bad([{ ...ok, lawId: 1 }], /lawId/);
  bad([null], /1 件目/);
});

test('pickOf は「適当／不適当」にも対応する', () => {
  assert.equal(pickOf({ ask: '最も不適当なもの' }), false);
  assert.equal(pickOf({ ask: '最も適当なもの' }), true);
});
