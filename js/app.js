// 画面。問題文・解説など外から来る文字列は、すべて textContent（テキストノード）で表示する。
// innerHTML には一切データを入れない（取り込んだJSONの不正なHTMLを防ぐため）。
import { APP_VERSION } from './version.js';
import { setupPWA, toast } from './pwa.js';
import { loadCatalog, prepareImport, correctIndex, assertNoMojibake } from './store.js';
import { makeRecord, mergeRecords, makeReview, mergeReviews, latestReviews, nextReviewAt, sortRecords, toDateKey } from './progress.js';
import { buildQueue, gradeChoice, gradeTf, tagsOf, filterQuestions } from './quiz.js';
import { subjectRows, formatRate, examDate, daysUntil, daysUntilText, passLine, maxPoints, needsBackup } from './stats.js';
import * as db from './db.js';

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const SOURCE_LABEL = { original: '自作', 'ai-draft': 'AIの下書き', 'past-exam': '過去問', 'textbook-ref': '教材を参照' };
/** モードの表示名。4択演習は選択肢の数（exam.choices）に合わせて「5択演習」などにする */
function modeLabel(mode, exam) {
  if (mode === 'choice') return `${exam.exam.choices}択演習`;
  return { tf: '○×一問一答', review: '今日の復習', wrong: '間違えた問題' }[mode];
}
const NUMS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];

const state = {
  catalog: null,        // { exams: [{ exam, questions }], errors }
  records: [],          // 全資格の学習記録（古い順）
  reviews: [],          // 確認の印（古い順）。問題ごとに最新の1件が有効
  reviewMap: new Map(), // questionId → 最新の印
  privateRows: [],      // 取り込んだ問題の保存行
  settings: db.loadSettings(),
  dbError: '',          // 端末内の保存が使えないときの理由（使えるようになったら消す）
  saveWarned: false,    // 保存失敗の警告を出した（1問ごとに出し続けない。保存できたら戻す）
  fatal: '',            // 資格データを読めないときの理由
  session: null,        // 演習中の状態
  notice: null,         // 設定画面に出す結果の文 { text, err }
};

// ---------- 小道具 ----------

/** 要素を作る。文字列の子は必ずテキストノードにする（HTMLとして解釈しない） */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'value') value = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
  }
  if (value !== undefined) el.value = value;
  return el;
}

const app = document.getElementById('app');
function show(...nodes) {
  app.replaceChildren(...nodes.flat(Infinity).filter(Boolean));
  window.scrollTo(0, 0);
}

function go(hash, replace = false) {
  if (location.hash === hash) { route(); return; }
  if (replace) location.replace(hash);
  else location.hash = hash;
}

const currentEntry = () => {
  const list = state.catalog ? state.catalog.exams : [];
  return list.find((e) => e.exam.id === state.settings.currentExam) || list[0] || null;
};
const examRecords = (entry = currentEntry()) => state.records.filter((r) => r.examId === entry.exam.id);
const deviceName = () => state.settings.deviceName || '端末';
const examLabel = (exam) => exam.shortName || exam.name;
const examById = (id) => (state.catalog.exams.find((e) => e.exam.id === id) || currentEntry()).exam;

function updateSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  if (!db.saveSettings(state.settings)) toast('設定を保存できませんでした（ブラウザの保存が使えません）', null, null, 8000);
}

// ---------- 起動・画面の切り替え ----------

async function loadData() {
  try { state.privateRows = await db.getPrivateRows(); state.dbError = ''; } catch (e) { state.privateRows = []; state.dbError = e.message; }
  try {
    state.catalog = await loadCatalog({ privateRows: state.privateRows });
    state.fatal = '';
  } catch (e) {
    state.fatal = e.message;
  }
}

function route() {
  const hash = location.hash;
  if (state.fatal || !state.catalog) return renderFatal();
  if (!currentEntry()) return renderFatal('資格データが1件も読めませんでした。');
  if (hash === '#settings') return renderSettings();
  if (hash === '#start-choice') return renderStart('choice');
  if (hash === '#start-tf') return renderStart('tf');
  if (hash === '#quiz') return state.session ? (state.session.done ? renderResult() : renderQuiz()) : go('#home', true);
  if (hash === '#result') return state.session ? renderResult() : go('#home', true);
  return renderHome();
}

function renderFatal(msg) {
  show(
    h('h1', null, '資格学習'),
    h('div', { class: 'banner err' }, msg || state.fatal || '読み込めませんでした。'),
    h('p', { class: 'sub' }, '初めて開くときは、電波のあるところで開いてください。2回目からは圏外でも使えます。'),
    h('button', { class: 'primary', onclick: async () => { await loadData(); route(); } }, 'もう一度読み込む'),
  );
}

// ---------- ホーム ----------

function renderHome() {
  const entry = currentEntry();
  const { exam, questions } = entry;
  const records = examRecords(entry);
  const today = new Date();
  const ed = examDate(exam, state.settings);
  const days = daysUntil(ed.date, today);
  const pl = passLine(exam, state.settings);
  const dueCount = buildQueue({ questions, mode: 'review', records, today }).length;
  const wrongCount = buildQueue({ questions, mode: 'wrong', records, today }).length;
  const rows = subjectRows(exam, questions, records);

  const exams = state.catalog.exams;
  const head = h('div', { class: 'top' },
    exams.length > 1
      ? h('select', {
        'aria-label': '資格を選ぶ',
        onchange: (e) => { updateSettings({ currentExam: e.target.value }); renderHome(); },
      }, exams.map((x) => h('option', { value: x.exam.id, selected: x.exam.id === exam.id }, x.exam.name)))
      : h('h1', null, exam.name),
    h('button', { 'aria-label': '設定', onclick: () => go('#settings') }, '設定'),
  );

  const notes = [];
  if (state.dbError) notes.push(h('div', { class: 'banner err' }, `記録を保存できません: ${state.dbError}`));
  if (state.catalog.errors.length) {
    notes.push(h('div', { class: 'banner err' }, `読み込めなかった問題データがあります（${state.catalog.errors.length}件）。設定画面で内容を確認できます。`));
  }
  if (needsBackup({ lastExportAt: state.settings.lastExportAt, records: state.records, reviews: state.reviews, now: today })) {
    notes.push(h('div', { class: 'banner' },
      h('p', null, '学習記録を書き出してから14日以上たっています。端末が壊れたりブラウザのデータを消すと記録も消えるので、書き出しておくと安心です。'),
      h('button', { onclick: () => go('#settings') }, '設定で書き出す')));
  }

  const dayCard = h('div', { class: 'card' },
    h('div', { class: 'days' }, daysUntilText(days)),
    h('div', { class: 'sub' }, [
      ed.date ? `試験日 ${ed.date}${ed.overridden ? '（設定で変更）' : ''}` : '',
      pl.points ? `　合格目安 ${pl.points}点 / ${maxPoints(exam)}点${pl.overridden ? '（設定で変更）' : ''}` : '',
    ].join('')),
    exam.nextExamDateNote && !ed.overridden ? h('div', { class: 'sub' }, `※${exam.nextExamDateNote}`) : null,
  );

  const table = h('table', null,
    h('thead', null, h('tr', null, ['科目', '問題数', '回答数', '正答率'].map((t) => h('th', null, t)))),
    h('tbody', null, rows.map((r) => h('tr', { class: r.id === '_total' ? 'total' : '' },
      h('td', null, r.name), h('td', null, r.questionCount), h('td', null, r.answers), h('td', null, formatRate(r.rate))))),
  );

  show(
    head, ...notes, dayCard,
    h('div', { class: 'grid2' },
      h('button', { class: 'mode-btn primary', onclick: () => go('#start-choice') }, modeLabel('choice', exam), h('small', null, '問題を解いて解説')),
      h('button', { class: 'mode-btn primary', onclick: () => go('#start-tf') }, modeLabel('tf', exam), h('small', null, '記述が正しいか')),
      h('button', {
        class: 'mode-btn', disabled: dueCount === 0,
        onclick: () => startSession('review', {}, false),
      }, modeLabel('review', exam), h('small', null, `${dueCount}問`)),
      h('button', {
        class: 'mode-btn', disabled: wrongCount === 0,
        onclick: () => startSession('wrong', {}, false),
      }, modeLabel('wrong', exam), h('small', null, `${wrongCount}問`)),
    ),
    h('h2', null, '科目別の正答率'),
    h('div', { class: 'card' }, table),
    h('p', { class: 'sub' }, '正答率は、これまでの回答（演習・○×の合計）のうち正解だった割合です。'),
  );
}

// ---------- 出題の設定 ----------

function renderStart(mode) {
  const entry = currentEntry();
  const { exam, questions } = entry;
  const records = examRecords(entry);
  const subjectSel = h('select', { id: 'selSubject', onchange: refresh },
    h('option', { value: '' }, '全科目'),
    exam.subjects.map((s) => h('option', { value: s.id }, s.name)));
  const tagSel = h('select', { id: 'selTag', onchange: refresh }, h('option', { value: '' }, 'すべて'));
  const orderSel = h('select', { id: 'selOrder' },
    h('option', { value: 'random', selected: true }, 'ランダム'), h('option', { value: 'seq' }, '問題の並び順'));
  const limitSel = h('select', { id: 'selLimit' },
    h('option', { value: '10' }, '10問'), h('option', { value: '20' }, '20問'),
    h('option', { value: '50' }, '50問'), h('option', { value: '0' }, 'ぜんぶ'));
  const info = h('p', { class: 'sub' });
  const startBtn = h('button', { class: 'primary', onclick: begin }, 'はじめる');

  function opts() {
    return { subject: subjectSel.value || undefined, tag: tagSel.value || undefined, order: orderSel.value, limit: Number(limitSel.value) || undefined };
  }
  function refresh() {
    // 科目を変えたら、その科目にあるタグだけを選べるようにする
    const prev = tagSel.value;
    const tags = tagsOf(filterQuestions(questions, { subject: subjectSel.value || undefined }));
    tagSel.replaceChildren(h('option', { value: '' }, 'すべて'), ...tags.map((t) => h('option', { value: t, selected: t === prev }, t)));
    const n = buildQueue({ questions, mode, subject: subjectSel.value || undefined, tag: tagSel.value || undefined, records }).length;
    info.textContent = `対象 ${n} 問`;
    startBtn.disabled = n === 0;
  }
  function begin() {
    if (!startSession(mode, opts(), true)) info.textContent = '対象の問題がありません。';
  }

  show(
    h('div', { class: 'top' }, h('h1', null, modeLabel(mode, exam)), h('button', { onclick: () => go('#home') }, 'ホームへ')),
    h('div', { class: 'card' },
      h('label', { for: 'selSubject' }, '科目'), subjectSel,
      h('label', { for: 'selTag' }, 'タグ'), tagSel,
      h('label', { for: 'selOrder' }, '順番'), orderSel,
      h('label', { for: 'selLimit' }, '問題数'), limitSel,
      info,
    ),
    mode === 'tf'
      ? h('p', { class: 'sub' }, '4択問題の選択肢1つ1つを「その記述は正しいか」で答えます。問い方が「誤っているもの」の問題でも、記述が正しければ ○ です。個数・組合せの問題はここには出ません。')
      : h('p', { class: 'sub' }, `○×問題（${exam.exam.choices}択でない問題）はこの演習には出ません。`),
    startBtn,
  );
  refresh();
}

// ---------- 演習 ----------

function startSession(mode, opts, replace) {
  const entry = currentEntry();
  const items = buildQueue({ questions: entry.questions, mode, ...opts, records: examRecords(entry), today: new Date() });
  if (!items.length) return false;
  state.session = { mode, opts, examId: entry.exam.id, items, pos: 0, results: [], current: null, done: false };
  go('#quiz', replace);
  return true;
}

function recordAnswer(item, correct) {
  const rec = makeRecord({ itemId: item.itemId, examId: state.session.examId, correct, mode: item.kind, device: deviceName() });
  state.records.push(rec);
  state.session.results.push({ item, correct });
  db.addRecord(rec).then(() => {
    state.dbError = '';
    state.saveWarned = false;
  }).catch((e) => {
    state.dbError = e.message;
    // 保存できない間、1問ごとに警告を出し続けない（最初の1回だけ）
    if (!state.saveWarned) {
      state.saveWarned = true;
      toast(`記録を保存できませんでした（この先の回答も保存されないかもしれません）: ${e.message}`, null, null, 8000);
    }
  });
  // 記録を消されにくくするよう、初めて答えたときに1回だけブラウザに頼む（許可されるかはブラウザしだい）
  if (!state.settings.persistAsked) {
    updateSettings({ persistAsked: true });
    db.requestPersist();
  }
}

/**
 * 問題の確認状態。この端末での印（最新の1件）が公開データの reviewed より優先される。
 * 'suspect' … 誤りかも　'ok' … 確認済み　'unverified-explanation' … 過去問で解説が未確認（正解は公式）　'unverified' … 未確認
 */
function reviewState(q) {
  const r = state.reviewMap.get(q.id);
  if (r && r.status === 'suspect') return 'suspect';
  if (r && r.status === 'ok') return 'ok';
  if (q.reviewed) return 'ok';
  return q.source && q.source.kind === 'past-exam' ? 'unverified-explanation' : 'unverified';
}

function metaBadges(q) {
  const st = reviewState(q);
  return [
    st === 'suspect' ? h('span', { class: 'badge bad', title: 'この端末で「誤りかも」にしています' }, '誤りかも') : null,
    st === 'unverified' ? h('span', { class: 'badge', title: '人が条文で確かめていません' }, '未確認') : null,
    st === 'unverified-explanation' ? h('span', { class: 'badge', title: '正解は公式のものです。解説は人が確かめていません' }, '解説未確認') : null,
    q.__private ? h('span', { class: 'badge priv' }, '取り込み') : null,
  ];
}

/** 確認の印を1件足す（端末内に追記）。問題ごとに最新の1件が有効 */
function saveReview(questionId, status, note) {
  // 日時は同じ問題の前の印より必ず後にする（端末の時計が戻っても、押した順が入れ替わらないように）
  const rev = makeReview({ questionId, status, note, device: deviceName(), at: nextReviewAt(state.reviewMap.get(questionId)) });
  state.reviews.push(rev);
  state.reviewMap = latestReviews(state.reviews);
  db.addReview(rev).catch((e) => toast(`確認の印を保存できませんでした: ${e.message}`, null, null, 8000));
  return rev;
}

function explanationCard(item) {
  const q = item.question;
  const src = q.source || {};
  const lines = [];
  if (item.kind === 'tf' && item.note) lines.push(h('p', { class: 'explain' }, `この記述について: ${item.note}`));
  if (q.explanation) lines.push(h('p', { class: 'explain' }, q.explanation));
  if (q.basis) lines.push(h('p', { class: 'meta' }, `根拠: ${q.basis}`));
  const origin = [SOURCE_LABEL[src.kind] || src.kind, src.ref, src.url].filter(Boolean).join(' / ');
  lines.push(h('p', { class: 'meta' }, `出典: ${origin}${q.lawAsOf ? `（${q.lawAsOf} 時点の法令）` : ''}`));
  const st = reviewState(q);
  if (st === 'unverified') lines.push(h('p', { class: 'meta' }, '※この問題は人が条文で確かめていません。内容が違うこともあります。'));
  if (st === 'unverified-explanation') lines.push(h('p', { class: 'meta' }, '※正解は公式のものです。解説は人が確かめていません。'));
  if (st === 'suspect') lines.push(h('p', { class: 'meta' }, '※この端末で「誤りかも」にしています。'));
  const card = h('div', { class: 'card' }, h('strong', null, '解説'), lines);
  const cards = [card];
  // 根拠条文の本文（e-Gov から取って問題に入れたもの）。textContent で表示する
  if (Array.isArray(q.basisText) && q.basisText.length) {
    cards.push(h('details', { class: 'card law' },
      h('summary', null, '条文を見る'),
      q.basisText.map((b) => h('div', { class: 'law-item' },
        h('strong', null, b.ref),
        h('div', { class: 'law-text' }, b.text),
        h('small', null, `e-Gov 法令検索${b.asOf ? `（${b.asOf} に取得）` : ''}`)))));
  }
  cards.push(reviewCard(q));
  return cards;
}

/** 回答後の「確認済みにする」「誤りかも」 */
function reviewCard(q) {
  const cur = state.reviewMap.get(q.id);
  const label = cur
    ? `この端末での確認: ${cur.status === 'ok' ? '確認済み' : '誤りかも'}${cur.note ? `（${cur.note}）` : ''}`
    : 'この問題・解説に気づいた点があれば印を付けておけます。';
  return h('div', { class: 'card' },
    h('p', { class: 'meta' }, label),
    h('div', { class: 'row' },
      h('button', { onclick: () => { saveReview(q.id, 'ok', ''); renderQuiz(true); } }, '確認済みにする'),
      h('button', {
        class: 'danger',
        onclick: () => {
          const note = prompt('どこが誤りそうですか？（空でもかまいません。500文字まで。やめるときは「キャンセル」）', '');
          if (note === null) return;
          saveReview(q.id, 'suspect', note.trim());
          renderQuiz(true);
        },
      }, '誤りかも')));
}

function renderQuiz(keepScroll = false) {
  const savedY = keepScroll ? window.scrollY : 0;
  const s = state.session;
  if (s.pos >= s.items.length) { s.done = true; return go('#result', true); }
  const item = s.items[s.pos];
  const q = item.question;
  const cur = s.current; // 回答後は { picked, correct }
  const ci = item.kind === 'choice' ? correctIndex(q) : -1;
  const body = [];

  body.push(h('div', { class: 'progress' },
    h('span', null, `${modeLabel(s.mode, examById(s.examId))}　${s.pos + 1} / ${s.items.length}`),
    h('span', null, metaBadges(q))));

  if (item.kind === 'choice') {
    body.push(h('div', { class: 'stem' }, q.stem));
    if (cur) {
      body.push(h('div', { class: `verdict ${cur.correct ? 'ok' : 'ng'}` }, cur.correct ? '正解！' : '不正解'),
        h('p', null, `正解は ${NUMS[ci] || ci + 1} です${q.ask ? `（${q.ask}）` : ''}`));
    }
    q.choices.forEach((c, i) => {
      const cls = cur ? (i === ci ? 'correct' : (i === cur.picked ? 'wrong' : '')) : '';
      const inner = [
        h('span', { class: 'no' }, NUMS[i] || String(i + 1)),
        h('span', { class: 'body' }, c.text,
          cur ? h('span', { class: 'note' },
            // single（個数・組合せ）の選択肢には ok が無いので、各記述の正誤は出さない
            h('span', { class: 'mark' }, `${q.type === 'single' ? '' : (c.ok ? 'この記述は正しい' : 'この記述は誤り')}${i === cur.picked ? `${q.type === 'single' ? '' : '　'}← あなたの回答` : ''}`),
            c.note ? ` ${c.note}` : '') : null),
      ];
      body.push(h('button', { class: `choice ${cls}`, disabled: !!cur, onclick: () => answer(item, i, gradeChoice) }, inner));
    });
  } else {
    if (item.index !== null) body.push(h('div', { class: 'ctx' }, `もとの問題: ${q.stem}`));
    body.push(h('div', { class: 'stem' }, item.statement), h('p', { class: 'sub' }, 'この記述は正しいですか？'));
    if (cur) {
      body.push(h('div', { class: `verdict ${cur.correct ? 'ok' : 'ng'}` }, cur.correct ? '正解！' : '不正解'),
        h('p', null, `この記述は ${item.answer ? '正しい（○）' : '誤り（×）'} です`));
    }
    const cls = (v) => (cur ? (v === item.answer ? 'correct' : (v === cur.picked ? 'wrong' : '')) : '');
    body.push(h('div', { class: 'tf-row' },
      h('button', { class: cls(true), 'aria-label': '正しい（○）', disabled: !!cur, onclick: () => answer(item, true, gradeTf) }, '○'),
      h('button', { class: cls(false), 'aria-label': '誤り（×）', disabled: !!cur, onclick: () => answer(item, false, gradeTf) }, '×')));
  }

  if (cur) body.push(...explanationCard(item));

  const last = s.pos + 1 >= s.items.length;
  const bar = h('div', { class: 'actionbar' }, h('div', { class: 'inner' },
    h('button', { onclick: finishQuiz }, '終わる'),
    cur ? h('button', { class: 'primary', onclick: nextQuestion }, last ? '結果を見る' : '次へ') : null));

  show(...body, bar);
  if (keepScroll) window.scrollTo(0, savedY); // 印を付けたあとは位置を動かさない
}

/** 回答を採点して記録し、画面を回答後の表示にする（4択・○×共通。grade は quiz.js の採点関数） */
function answer(item, picked, grade) {
  const s = state.session;
  if (s.current) return;
  const correct = grade(item, picked);
  s.current = { picked, correct };
  recordAnswer(item, correct);
  renderQuiz();
}

function nextQuestion() {
  const s = state.session;
  s.pos++;
  s.current = null;
  if (s.pos >= s.items.length) finishQuiz(); else renderQuiz();
}

function finishQuiz() {
  state.session.done = true;
  go('#result', true);
}

function renderResult() {
  const s = state.session;
  const total = s.results.length;
  const ok = s.results.filter((r) => r.correct).length;
  const wrong = s.results.filter((r) => !r.correct);
  const text = (it) => (it.kind === 'tf' ? it.statement : it.question.stem);
  show(
    h('h1', null, '結果'),
    h('div', { class: 'card' },
      total ? h('div', { class: 'result-big' }, `${ok} / ${total} 問正解`) : h('p', null, 'まだ1問も答えていません。'),
      total ? h('div', { class: 'sub' }, `正答率 ${formatRate(ok / total)}（${modeLabel(s.mode, examById(s.examId))}）`) : null,
      total < s.items.length ? h('div', { class: 'sub' }, `途中で終了（全${s.items.length}問のうち${total}問）`) : null,
    ),
    total ? h('ul', { class: 'plain' }, s.results.map((r) => h('li', null,
      h('span', { class: `mk ${r.correct ? 'ok' : 'ng'}` }, r.correct ? '○' : '×'),
      h('span', null, text(r.item).slice(0, 80) + (text(r.item).length > 80 ? '…' : ''))))) : null,
    h('div', { class: 'stack', style: 'margin-top:14px' },
      wrong.length ? h('button', { class: 'primary', onclick: () => retryWrong(wrong.map((r) => r.item)) }, `間違えた ${wrong.length} 問をやり直す`) : null,
      h('button', { onclick: () => { state.session = null; go('#home', true); } }, 'ホームへ')),
  );
}

function retryWrong(items) {
  state.session = { mode: state.session.mode, opts: {}, examId: state.session.examId, items, pos: 0, results: [], current: null, done: false };
  go('#quiz', true);
}

// ---------- 設定 ----------

/** 設定画面の上に出す結果。text は文字列か、1行ずつの配列 */
function setNotice(text, err = false) { state.notice = { lines: Array.isArray(text) ? text : [text], err }; }

function pickFile(onFile) {
  // 種類（accept）で絞らない。Android で .json が選べないことがあるため、中身で確かめる
  for (const old of document.querySelectorAll('input[data-picker]')) old.remove(); // 前に選ばれなかった入力欄を残さない
  const input = h('input', { type: 'file', class: 'hidden', 'data-picker': '1' });
  input.addEventListener('change', async () => {
    const f = input.files && input.files[0];
    input.remove();
    if (f) await onFile(f);
  });
  input.addEventListener('cancel', () => input.remove()); // ファイルを選ばずに閉じたとき
  document.body.append(input);
  input.click();
}

async function readJsonFile(file, maxBytes) {
  if (file.size > maxBytes) throw new Error(`ファイルが大きすぎます（${Math.round(file.size / 1024 / 1024)}MB）`);
  let text;
  try { text = await file.text(); } catch { throw new Error('ファイルを読めませんでした'); }
  assertNoMojibake(text); // Shift-JIS で保存されたファイルは UTF-8 として読むと � が混ざる。化けたまま取り込まない
  try { return JSON.parse(text); } catch { throw new Error('JSONとして読めません（壊れているか、別の種類のファイルです）'); }
}

/** 記録の書き出し。共有（保存先を選べる）が使えればそれを優先し、保存できたと分かったときだけ「最後の書き出し」を更新する */
async function exportRecords() {
  const now = new Date();
  const data = { app: 'shikaku', schemaVersion: 1, exportedAt: now.toISOString(), device: deviceName(), records: state.records, reviews: state.reviews };
  const fileName = `shikaku-records-${toDateKey(now)}.json`;
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  let saved = false;
  let how = '';
  const file = typeof File === 'function' ? new File([blob], fileName, { type: 'application/json' }) : null;
  if (file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: '学習記録' });
      saved = true;
      how = '共有で保存しました';
    } catch (e) {
      if (e && e.name === 'AbortError') {
        setNotice('書き出しをやめました（保存先を選ばずに閉じました）。記録はまだ書き出されていません。', true);
        return renderSettings();
      }
      // 共有に失敗したときは、ダウンロードに切り替える
    }
  }
  if (!saved) {
    const a = h('a', { href: URL.createObjectURL(blob), download: fileName });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    saved = confirm('保存できましたか？（ダウンロード フォルダなどに学習記録のファイルがあれば「OK」）');
    how = 'ダウンロードしました';
  }
  if (saved) {
    updateSettings({ lastExportAt: now.toISOString() });
    setNotice(`学習記録 ${state.records.length} 件・確認の印 ${state.reviews.length} 件を書き出しました（${how}）。`);
  } else {
    setNotice('保存できていないため、書き出し済みにはしませんでした。もう一度お試しください。', true);
  }
  renderSettings();
}

async function importRecords(file) {
  try {
    const json = await readJsonFile(file, 50 * 1024 * 1024);
    const recList = Array.isArray(json) ? json : json && json.records;
    const revList = !Array.isArray(json) && json && json.reviews;
    if (!Array.isArray(recList) && !Array.isArray(revList)) throw new Error('学習記録のファイルではありません（records がありません）');
    const parts = [];
    if (Array.isArray(recList)) {
      const before = new Set(state.records.map((r) => r.id));
      const m = mergeRecords(state.records, recList);
      await db.putRecords(m.records.filter((r) => !before.has(r.id)));
      state.records = m.records;
      parts.push(`学習記録: 追加 ${m.added} 件、すでにあった ${m.duplicate} 件、形が不正で除いた ${m.invalid} 件`);
    }
    if (Array.isArray(revList)) {
      const before = new Set(state.reviews.map((r) => r.id));
      const m = mergeReviews(state.reviews, revList);
      await db.putReviews(m.reviews.filter((r) => !before.has(r.id)));
      state.reviews = m.reviews;
      state.reviewMap = latestReviews(state.reviews);
      parts.push(`確認の印: 追加 ${m.added} 件、すでにあった ${m.duplicate} 件、形が不正で除いた ${m.invalid} 件`);
    }
    setNotice(['読み込みました。', ...parts.map((p) => `${p}。`)]);
  } catch (e) {
    setNotice(`読み込めませんでした: ${e.message}`, true);
  }
  renderSettings();
}

async function importPrivate(file) {
  try {
    const json = await readJsonFile(file, MAX_IMPORT_BYTES);
    const prep = prepareImport(json, state.catalog.exams);
    const existing = new Set(state.privateRows.map((r) => r.id));
    const batch = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const importedAt = new Date().toISOString();
    const rows = prep.accepted.map((question) => ({ id: question.id, examId: prep.examId, batch, fileName: file.name, importedAt, question }));
    if (rows.length) await db.putPrivateRows(rows);
    await loadData();
    // 件数は「保存した数」ではなく、実際に問題として使える状態になった数で数える
    const merged = mergedPrivateIds();
    const usable = rows.filter((r) => merged.has(r.id)).length;
    const updated = rows.filter((r) => merged.has(r.id) && existing.has(r.id)).length;
    let msg = `${usable} 問を取り込みました（うち取り込み済みの更新 ${updated} 問）。この端末の中だけに保存し、外部には送りません。`;
    if (usable < rows.length) msg += ` 保存した ${rows.length} 問のうち ${rows.length - usable} 問は使えませんでした（下の「読み込めなかったデータ」を見てください）。`;
    setNotice(msg, usable === 0);
  } catch (e) {
    setNotice(`取り込めませんでした: ${e.message}`, true);
  }
  renderSettings();
}

async function deletePrivate(batch) {
  try {
    if (batch) await db.deletePrivateBatch(batch); else await db.deleteAllPrivate();
    await loadData();
    setNotice('取り込んだ問題を削除しました（学習記録は残ります）。');
  } catch (e) {
    setNotice(`削除できませんでした: ${e.message}`, true);
  }
  renderSettings();
}

/** 実際に資格の問題として合流している取り込み問題の id */
function mergedPrivateIds() {
  return new Set(state.catalog.exams.flatMap((e) => e.questions.filter((q) => q.__private).map((q) => q.id)));
}

function privateBatches() {
  const merged = mergedPrivateIds();
  const m = new Map();
  for (const r of state.privateRows) {
    const b = m.get(r.batch) || { batch: r.batch, fileName: r.fileName, importedAt: r.importedAt, examId: r.examId, count: 0, unusable: 0 };
    if (merged.has(r.id)) b.count++; else b.unusable++; // 使える問題数と、保存はあるが使えない問題数を分ける
    m.set(r.batch, b);
  }
  return [...m.values()].sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1));
}

async function renderSettings() {
  const entry = currentEntry();
  const { exam } = entry;
  const ed = examDate(exam, state.settings);
  const pl = passLine(exam, state.settings);
  const persist = await db.persistStatus();
  const persistText = { persisted: '消されにくい状態です', 'not-persisted': 'まだ保護されていません（容量が足りなくなると消されることがあります）', unsupported: 'この端末・ブラウザでは使えません' }[persist];
  const notice = state.notice;
  state.notice = null;

  const nameInput = h('input', { type: 'text', id: 'inpDevice', maxlength: '20', value: state.settings.deviceName, placeholder: '例: スマホ、パソコン' });
  const dateInput = h('input', { type: 'date', id: 'inpDate', value: ed.date || '' });
  const passInput = h('input', { type: 'number', id: 'inpPass', min: '1', max: String(maxPoints(exam)), value: pl.points ?? '' });

  const batches = privateBatches();
  const qById = new Map(state.catalog.exams.flatMap((e) => e.questions.map((q) => [q.id, q])));
  const suspects = [...state.reviewMap.values()].filter((r) => r.status === 'suspect')
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).map((r) => ({ r, q: qById.get(r.questionId) }));

  show(
    h('div', { class: 'top' }, h('h1', null, '設定'), h('button', { onclick: () => go('#home') }, 'ホームへ')),
    notice ? h('div', { class: `banner${notice.err ? ' err' : ''}`, role: 'status' }, notice.lines.map((t) => h('p', null, t))) : null,

    h('h2', null, '端末の名前'),
    h('div', { class: 'card' },
      h('label', { for: 'inpDevice' }, '学習記録に付ける名前'),
      nameInput,
      h('p', { class: 'sub' }, '複数の端末の記録を合わせたときに、どの端末で解いたか分かるようにするための名前です。'),
      h('button', { onclick: () => { updateSettings({ deviceName: nameInput.value.trim() }); setNotice('端末の名前を保存しました。'); renderSettings(); } }, '保存')),

    h('h2', null, `${examLabel(exam)}の試験日・合格目安`),
    h('div', { class: 'card' },
      h('label', { for: 'inpDate' }, '試験日'),
      dateInput,
      h('p', { class: 'sub' }, `もとの設定: ${exam.nextExamDate || '未設定'}${exam.nextExamDateNote ? `（${exam.nextExamDateNote}）` : ''}`),
      h('div', { class: 'row' },
        h('button', {
          onclick: () => {
            if (!dateInput.value) { setNotice('日付を入れてください。', true); return renderSettings(); }
            updateSettings({ examDates: { ...state.settings.examDates, [exam.id]: dateInput.value } });
            setNotice('試験日を保存しました。'); renderSettings();
          },
        }, '試験日を保存'),
        h('button', {
          onclick: () => {
            const d = { ...state.settings.examDates }; delete d[exam.id];
            updateSettings({ examDates: d }); setNotice('試験日をもとの設定に戻しました。'); renderSettings();
          },
        }, 'もとに戻す')),
      h('label', { for: 'inpPass' }, `合格目安（点。${maxPoints(exam)}点満点）`),
      passInput,
      h('p', { class: 'sub' }, `もとの設定: ${exam.exam.passLineHint ?? '未設定'}点（年によって変わります）`),
      h('div', { class: 'row' },
        h('button', {
          onclick: () => {
            const n = Number(passInput.value);
            if (!Number.isInteger(n) || n < 1 || n > maxPoints(exam)) { setNotice(`合格目安は 1〜${maxPoints(exam)} の整数にしてください。`, true); return renderSettings(); }
            updateSettings({ passLines: { ...state.settings.passLines, [exam.id]: n } });
            setNotice('合格目安を保存しました。'); renderSettings();
          },
        }, '合格目安を保存'),
        h('button', {
          onclick: () => {
            const d = { ...state.settings.passLines }; delete d[exam.id];
            updateSettings({ passLines: d }); setNotice('合格目安をもとの設定に戻しました。'); renderSettings();
          },
        }, 'もとに戻す'))),

    h('h2', null, '学習記録の書き出し・読み込み'),
    h('div', { class: 'card' },
      h('p', null, `いまの記録: ${state.records.length} 件／確認の印: ${state.reviews.length} 件`),
      h('p', { class: 'sub' }, state.settings.lastExportAt ? `最後に書き出した日時: ${new Date(state.settings.lastExportAt).toLocaleString('ja-JP')}` : 'まだ書き出していません。'),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: exportRecords }, 'ファイルに書き出す'),
        h('button', { onclick: () => pickFile(importRecords) }, 'ファイルから読み込む')),
      h('p', { class: 'sub' }, '読み込んでも今の記録は消えず、無い記録だけが足されます。別の端末の記録を合わせるときにも使えます。')),

    h('h2', null, `誤りかもの問題（${suspects.length}件）`),
    h('div', { class: 'card' },
      suspects.length ? h('ul', { class: 'plain' }, suspects.map(({ r, q }) => h('li', { style: 'align-items:center' },
        h('span', { style: 'flex:1' },
          q ? q.stem.slice(0, 40) + (q.stem.length > 40 ? '…' : '') : `（問題 ${r.questionId} が見つかりません）`,
          h('br'), h('small', null, `${r.note ? `メモ: ${r.note}　` : ''}${new Date(r.at).toLocaleString('ja-JP')}`)),
        h('button', { onclick: () => { saveReview(r.questionId, 'ok', ''); setNotice(q ? '確認済みにしました。' : '一覧から消しました。'); renderSettings(); } }, q ? '確認済みにする' : '一覧から消す'))))
        : h('p', { class: 'sub' }, '「誤りかも」にした問題はありません。')),

    h('h2', null, '自分の問題の取り込み（private）'),
    h('div', { class: 'card' },
      h('p', null, '問題のファイル（q-〇〇.json と同じ形のJSON）を選ぶと、形を検査してこの端末に保存し、その資格の問題に加えます。'),
      h('p', { class: 'sub' }, '外部には一切送りません。問題の id は「資格ID-科目ID-p4〜8桁」（例 takken-kenri-p0001、過去問は takken-kenri-p202501）の形にしてください（公開データの id とぶつからないため）。UTF-8 で保存したファイルを選んでください。過去問など公開してはいけない問題は、公開フォルダではなくここから取り込みます。'),
      h('button', { class: 'primary', onclick: () => pickFile(importPrivate) }, '問題ファイルを取り込む'),
      batches.length ? h('ul', { class: 'plain', style: 'margin-top:12px' }, batches.map((b) => h('li', { style: 'align-items:center' },
        h('span', { style: 'flex:1' }, `${b.fileName || '(名前なし)'}　${b.count}問${b.unusable ? `（使えない ${b.unusable}問）` : ''}`, h('br'), h('small', null, `${b.examId} / ${new Date(b.importedAt).toLocaleString('ja-JP')}`)),
        h('button', { class: 'danger', onclick: () => { if (confirm(`「${b.fileName}」から取り込んだ ${b.count + b.unusable} 問を削除しますか？（学習記録は残ります）`)) deletePrivate(b.batch); } }, '削除')))) : h('p', { class: 'sub' }, '取り込んだ問題はありません。'),
      batches.length > 1 ? h('button', { class: 'danger', style: 'margin-top:10px', onclick: () => { if (confirm('取り込んだ問題をすべて削除しますか？（学習記録は残ります）')) deletePrivate(null); } }, 'すべて削除') : null),

    h('h2', null, '記録を消されにくくする'),
    h('div', { class: 'card' },
      h('p', null, `状態: ${persistText}`),
      h('button', {
        disabled: persist !== 'not-persisted',
        onclick: async () => {
          const r = await db.requestPersist();
          setNotice(r === 'persisted' ? '消されにくい状態にしました。' : '許可されませんでした。ブラウザが自動で判断します（ホーム画面に追加すると許可されやすくなります）。', r !== 'persisted');
          renderSettings();
        },
      }, '消されにくくするよう頼む'),
      h('p', { class: 'sub' }, '許可されるかはブラウザが決めます。念のため、ときどき記録を書き出してください。')),

    state.catalog.errors.length ? h('div', null,
      h('h2', null, '読み込めなかったデータ'),
      h('div', { class: 'banner err' }, state.catalog.errors.map((t) => h('p', null, t)))) : null,

    h('p', { class: 'sub', style: 'margin-top:20px' }, `版 v${APP_VERSION}`),
  );
}

// ---------- 起動 ----------

async function boot() {
  document.getElementById('ver').textContent = `v${APP_VERSION}`;
  setupPWA();
  let blockedToast = null;
  db.onBlocked((st) => { // 古い版のタブが保存を開いたままのとき: 失敗にせず、閉じてもらって、つながるのを待つ
    if (st === 'blocked') {
      blockedToast = toast('古い版のタブが保存を使っているため、記録を読み込めません。ほかのタブを閉じてください（閉じると自動で続きます）', null, null, 0);
    } else {
      if (blockedToast) blockedToast.remove();
      blockedToast = null;
      toast('保存につながりました。記録を読み込みます', null, null, 4000); // この下の読み込み（getAll…）が、つながったあとに動く
    }
  });
  db.onStale(() => toast('ほかのタブで更新されました。再読み込みしてください', '再読み込み', () => location.reload(), 0));
  try { state.records = sortRecords(await db.getAllRecords()); state.dbError = ''; } catch (e) { state.dbError = e.message; }
  try { state.reviews = sortRecords(await db.getAllReviews()); state.reviewMap = latestReviews(state.reviews); } catch (e) { state.dbError = state.dbError || e.message; }
  await loadData();
  window.addEventListener('hashchange', route);
  route();
}

boot();
