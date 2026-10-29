// 配信している問題データ（data/）の点検。公開してはいけない過去問が紛れ込んでいたら失敗させる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parseAppFiles } from '../tools/release.mjs';
import { validateIndex, validateExam, validateQuestionFile, correctIndex } from '../js/store.js';

const dataUrl = (f) => new URL(`../data/${f}`, import.meta.url);
const read = (f) => JSON.parse(readFileSync(dataUrl(f), 'utf8'));
const index = validateIndex(read('index.json'));
const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

/** 一覧の資格ごとに { entry, exam, dir, files: [{ name, file }] } を作る */
function load() {
  return index.exams.map((entry) => {
    const exam = validateExam(read(entry.path));
    const dir = entry.path.replace(/[^/]*$/, '');
    const files = exam.questionFiles.map((name) => ({ name, file: validateQuestionFile(read(`${dir}${name}`), exam) }));
    return { entry, exam, dir, files };
  });
}

test('data/index.json に1件以上あり、id・名前・版が exam.json と合っている', () => {
  assert.ok(index.exams.length >= 1);
  for (const { entry, exam } of load()) {
    assert.equal(exam.id, entry.id);
    assert.equal(exam.name, entry.name);
    assert.equal(exam.revision, entry.revision, `${entry.id}: 一覧の revision と exam.json の revision が違います`);
  }
});

test('questionFiles の一覧と、フォルダにある q-*.json が一致する', () => {
  for (const { exam, dir } of load()) {
    const actual = readdirSync(dataUrl(dir)).filter((f) => /^q-.*\.json$/.test(f)).sort();
    assert.deepEqual([...exam.questionFiles].sort(), actual, `${exam.id}: 一覧に無い（または実ファイルが無い）問題ファイルがあります`);
  }
});

test('問題の id は資格の中で重複しない', () => {
  for (const { exam, files } of load()) {
    const seen = new Set();
    for (const { name, file } of files) {
      for (const q of file.questions) {
        assert.ok(!seen.has(q.id), `${exam.id}: ${q.id} が重複しています（${name}）`);
        seen.add(q.id);
      }
    }
  }
});

test('4択は正解がちょうど1つ決まり、選択肢の数が資格の定義と同じ', () => {
  for (const { exam, files } of load()) {
    for (const { file } of files) {
      for (const q of file.questions.filter((x) => x.type === 'choice')) {
        assert.equal(q.choices.length, exam.exam.choices, q.id);
        const i = correctIndex(q);
        assert.ok(i >= 0 && i < q.choices.length, `${q.id}: 正解が1つに決まりません`);
        const same = q.choices.filter((c) => c.ok === q.choices[i].ok).length;
        assert.equal(same, 1, `${q.id}: 正解と同じ ok の選択肢がほかにもあります`);
      }
    }
  }
});

test('公開フォルダ data/ に過去問（source.kind が past-exam）が入っていない', () => {
  for (const { files } of load()) {
    for (const { name, file } of files) {
      for (const q of file.questions) {
        assert.notEqual(q.source.kind, 'past-exam', `${q.id}（${name}）は過去問です。公開してはいけません。private/ に置き、設定画面から取り込んでください`);
      }
    }
  }
});

test('全問題に根拠（basis）と解説（explanation）がある', () => {
  for (const { files } of load()) {
    for (const { file } of files) {
      for (const q of file.questions) {
        assert.ok(typeof q.basis === 'string' && q.basis.trim(), `${q.id}: basis（根拠条文）がありません`);
        assert.ok(typeof q.explanation === 'string' && q.explanation.trim(), `${q.id}: explanation（解説）がありません`);
      }
    }
  }
});

test('○×問題には ok があり、4択の各選択肢には解説（note）がある', () => {
  for (const { files } of load()) {
    for (const { file } of files) {
      for (const q of file.questions) {
        if (q.type === 'truefalse') assert.equal(typeof q.ok, 'boolean', q.id);
        else if (q.type === 'choice') for (const [i, c] of q.choices.entries()) assert.ok(c.note && c.note.trim(), `${q.id}: 選択肢${i + 1}の note がありません`);
      }
    }
  }
});

test('データのファイルは圏外でも使えるよう sw.js で事前保存する（コメントを除いた APP_FILES の配列で判定）', () => {
  const saved = new Set(parseAppFiles(sw));
  assert.ok(saved.has('data/index.json'), 'data/index.json が sw.js の APP_FILES にありません');
  for (const { entry, exam, dir } of load()) {
    assert.ok(saved.has(`data/${entry.path}`), `data/${entry.path} が sw.js の APP_FILES にありません`);
    for (const f of exam.questionFiles) assert.ok(saved.has(`data/${dir}${f}`), `data/${dir}${f} が sw.js の APP_FILES にありません`);
  }
});

test('公開データの問題 id に private 用の p 付きの形（takken-kenri-p0001）が混ざっていない', () => {
  for (const { files } of load()) for (const { file } of files) for (const q of file.questions) assert.ok(!/-p\d+$/.test(q.id), q.id);
});
