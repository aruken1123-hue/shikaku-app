// 学習記録と復習間隔の計算。画面にも保存先にも依存しない純粋な関数だけを置く。
//
// 学習記録は「回答1回ごとに1件足すだけ」: { id, itemId, examId, at(ISO日時), correct, mode, device }
//   itemId: 4択として解いたら問題id／○×として解いたら「問題id#選択肢番号(0始まり)」／○×問題は問題id
// 復習の箱・正答率などは、毎回この記録の並びから計算する（記録を書き換えない）。
// 複数端末の記録は、id で重複を除いて足し合わせるだけで合わせられる。

/** 箱1〜5 に入っているときの、次の復習までの日数（最後に答えた日から数える） */
export const BOX_DAYS = [1, 3, 7, 14, 30];
export const MAX_BOX = BOX_DAYS.length;
export const MODES = ['choice', 'tf'];

// ---------- 記録の作成 ----------

export function newRecordId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 項目ID。4択は問題id、○×は「問題id#選択肢番号」、○×問題（truefalse）は問題id */
export function itemIdFor(question, mode, choiceIndex) {
  if (question.type === 'truefalse') return question.id;
  if (mode === 'tf') return `${question.id}#${choiceIndex}`;
  return question.id;
}

/** 項目IDから問題idを取り出す */
export function questionIdOf(itemId) {
  return String(itemId).split('#')[0];
}

/** 回答1回分の記録を作る（保存は呼び出し側） */
export function makeRecord({ itemId, examId, correct, mode, device = '', at = new Date(), id = newRecordId() }) {
  if (!MODES.includes(mode)) throw new Error(`mode が不正です: ${mode}`);
  return { id, itemId, examId, at: (at instanceof Date ? at : new Date(at)).toISOString(), correct: !!correct, mode, device };
}

const ISO_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
/** 日時は ISO 形式（2026-10-29T01:06:30.776Z など）で、年が 2000〜2100 のものだけ */
function isValidAt(at) {
  if (typeof at !== 'string' || !ISO_AT.test(at)) return false;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return false;
  const y = new Date(t).getUTCFullYear();
  return y >= 2000 && y <= 2100;
}

export function isValidRecord(r) {
  return r !== null && typeof r === 'object'
    && typeof r.id === 'string' && r.id !== ''
    && typeof r.itemId === 'string' && r.itemId !== ''
    && typeof r.examId === 'string' && r.examId !== ''
    && isValidAt(r.at)
    && typeof r.correct === 'boolean'
    && MODES.includes(r.mode);
}

// ---------- 日付（日付の境目は端末の現地時刻） ----------

const pad = (n) => String(n).padStart(2, '0');

/** 現地時刻の日付 'YYYY-MM-DD'。Date・ISO日時のほか、すでに 'YYYY-MM-DD' ならそのまま */
export function toDateKey(d) {
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

export function addDaysKey(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return toDateKey(new Date(y, m - 1, d + n, 12));
}

/** a から b までの日数（b が後なら正） */
export function daysBetween(aKey, bKey) {
  const t = (k) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(bKey) - t(aKey)) / 86400000);
}

// ---------- 復習の箱（Leitner） ----------

/** 記録を古い順に並べる（同時刻は id 順で安定させる） */
export function sortRecords(records) {
  return [...records].sort((a, b) => (Date.parse(a.at) - Date.parse(b.at)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * 1項目の記録（古い順）から現在の状態を計算する。
 *   不正解 … 箱1に戻り、次回は翌日（間隔1日）
 *   正解   … 初めて答えたとき、またはその項目の次回期限の日以降のときだけ、箱を1つ進める（最大5）。
 *            次回 = 答えた日 + 進んだ先の箱の間隔
 *            期限前の正解（同じ日の繰り返し、間違えた直後のやり直しなど）は、箱も次回期限も据え置く
 *   間隔: 箱1=1日, 2=3日, 3=7日, 4=14日, 5=30日（日付は現地時刻）
 * 戻り値 { itemId, seen, box, lastAt, lastCorrect, nextDate }  seen=false なら未学習（nextDate は null）
 */
export function itemState(itemId, sortedRecords) {
  let box = 1;
  let nextDate = null;
  let last = null;
  for (const r of sortedRecords) {
    const day = toDateKey(r.at);
    if (!r.correct) {
      box = 1;
      nextDate = addDaysKey(day, BOX_DAYS[0]);
    } else if (last === null || day >= nextDate) {
      box = Math.min(box + 1, MAX_BOX);
      nextDate = addDaysKey(day, BOX_DAYS[box - 1]);
    }
    last = r;
  }
  if (!last) return { itemId, seen: false, box: 1, lastAt: null, lastCorrect: null, nextDate: null };
  return { itemId, seen: true, box, lastAt: last.at, lastCorrect: last.correct, nextDate };
}

/** 今日が復習の期限（次回の日以降）か。today は Date か 'YYYY-MM-DD' */
export function isDue(state, today) {
  return state.seen && state.nextDate <= toDateKey(today);
}

/** 全項目の状態。Map<itemId, state> */
export function computeStates(records) {
  const groups = new Map();
  for (const r of sortRecords(records)) {
    if (!groups.has(r.itemId)) groups.set(r.itemId, []);
    groups.get(r.itemId).push(r);
  }
  const out = new Map();
  for (const [id, list] of groups) out.set(id, itemState(id, list));
  return out;
}

const cmpId = (a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0); // 同じ順位のときは項目IDで安定させる

/** 今日が期限の項目ID（期限が古いものが先） */
export function dueItemIds(records, today) {
  return [...computeStates(records).values()]
    .filter((s) => isDue(s, today))
    .sort((a, b) => (a.nextDate < b.nextDate ? -1 : a.nextDate > b.nextDate ? 1 : 0) || cmpId(a, b))
    .map((s) => s.itemId);
}

/** 間違えた項目ID（直近の回答が不正解のもの。新しく間違えたものが先） */
export function wrongItemIds(records) {
  return [...computeStates(records).values()]
    .filter((s) => s.seen && s.lastCorrect === false)
    .sort((a, b) => (Date.parse(b.lastAt) - Date.parse(a.lastAt)) || cmpId(a, b))
    .map((s) => s.itemId);
}

// ---------- 合わせる ----------

/**
 * 複数端末の記録を id で重複を除いて合わせる。
 * 戻り値 { records(古い順), added(existing に無かった件数), duplicate(重複で捨てた件数), invalid(形が不正で捨てた件数) }
 */
export function mergeRecords(existing, incoming) {
  const map = new Map();
  for (const r of existing) if (isValidRecord(r)) map.set(r.id, r);
  let added = 0, duplicate = 0, invalid = 0;
  for (const r of incoming) {
    if (!isValidRecord(r)) { invalid++; continue; }
    if (map.has(r.id)) { duplicate++; continue; }
    map.set(r.id, r);
    added++;
  }
  return { records: sortRecords([...map.values()]), added, duplicate, invalid };
}

// ---------- 集計 ----------

/**
 * 回答の正答率をまとめる。keyOf(record) が null/undefined の記録は数えない。
 * 戻り値 Map<key, { answers, correct, rate(0〜1) }>
 */
export function accuracyBy(records, keyOf) {
  const out = new Map();
  for (const r of records) {
    const k = keyOf(r);
    if (k == null) continue;
    const a = out.get(k) || { answers: 0, correct: 0, rate: 0 };
    a.answers++;
    if (r.correct) a.correct++;
    a.rate = a.correct / a.answers;
    out.set(k, a);
  }
  return out;
}

/** 科目別の正答率。subjectOfQuestionId(問題id) が科目IDを返す。Map<科目ID, { answers, correct, rate }> */
export function accuracyBySubject(records, subjectOfQuestionId) {
  return accuracyBy(records, (r) => subjectOfQuestionId(questionIdOf(r.itemId)));
}

// ---------- 確認の印（「確認済み」「誤りかも」） ----------
// 学習記録と同じく「押すたびに1件足すだけ」。問題ごとに、いちばん新しい1件が有効。
// { id(一意), questionId, at(ISO日時), status:"ok"|"suspect", note, device }

export const REVIEW_STATUSES = ['ok', 'suspect'];
export const REVIEW_NOTE_MAX = 500; // メモの最大の長さ（これより長いものは切る）

/** 新しい印の日時。同じ問題の前の印より必ず後にする（端末の時計が戻っていても「最新」が入れ替わらないように） */
export function nextReviewAt(prevReview, now = new Date()) {
  const prev = prevReview ? Date.parse(prevReview.at) : NaN;
  return new Date(Number.isNaN(prev) ? now.getTime() : Math.max(now.getTime(), prev + 1));
}

export function makeReview({ questionId, status, note = '', device = '', at = new Date(), id = newRecordId() }) {
  if (!REVIEW_STATUSES.includes(status)) throw new Error(`status が不正です: ${status}`);
  return { id, questionId, at: (at instanceof Date ? at : new Date(at)).toISOString(), status, note: String(note || '').slice(0, REVIEW_NOTE_MAX), device };
}

export function isValidReview(r) {
  return r !== null && typeof r === 'object'
    && typeof r.id === 'string' && r.id !== ''
    && typeof r.questionId === 'string' && r.questionId !== ''
    && isValidAt(r.at)
    && REVIEW_STATUSES.includes(r.status)
    && (r.note == null || typeof r.note === 'string');
}

/** 確認の印を id で重複を除いて合わせる（mergeRecords と同じ。戻り値の形も同じ） */
export function mergeReviews(existing, incoming) {
  const map = new Map();
  for (const r of existing) if (isValidReview(r)) map.set(r.id, r);
  let added = 0, duplicate = 0, invalid = 0;
  for (const r of incoming) {
    if (!isValidReview(r)) { invalid++; continue; }
    if (map.has(r.id)) { duplicate++; continue; }
    map.set(r.id, typeof r.note === 'string' && r.note.length > REVIEW_NOTE_MAX ? { ...r, note: r.note.slice(0, REVIEW_NOTE_MAX) } : r);
    added++;
  }
  return { reviews: sortRecords([...map.values()]), added, duplicate, invalid };
}

/** 問題ごとの最新の印。Map<questionId, review> */
export function latestReviews(reviews) {
  const out = new Map();
  for (const r of sortRecords(reviews)) out.set(r.questionId, r);
  return out;
}
