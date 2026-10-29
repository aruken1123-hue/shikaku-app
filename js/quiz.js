// 出題キューと採点。画面にも保存先にも依存しない。
import { correctIndex, isActive } from './store.js';
import { itemIdFor, dueItemIds, wrongItemIds } from './progress.js';

/**
 * 出題の1項目:
 *   4択（choice・single） { kind:'choice', itemId, question }
 *   ○×    { kind:'tf', itemId, question, index, statement, answer, note }
 *          index … 4択問題から作った項目のときの選択肢番号（○×問題そのものなら null）
 *          statement … 画面に出す記述。answer … その記述が正しいか（true=○）
 */
export function choiceItem(q) {
  return { kind: 'choice', itemId: itemIdFor(q, 'choice'), question: q };
}

/** 問題から作れる○×の項目（4択なら選択肢の数だけ、○×問題なら1つ） */
export function tfItems(q) {
  if (q.type === 'single') return []; // 個数・組合せ問題は選択肢1つ1つの正誤にできないので、○×には出さない
  if (q.noTf) return [];              // 「最も〜」など、選択肢1つずつの正誤にすると意味が変わる問題（noTf:true）も、○×には出さない
  if (q.type === 'truefalse') {
    return [{ kind: 'tf', itemId: itemIdFor(q, 'tf'), question: q, index: null, statement: q.stem, answer: q.ok, note: '' }];
  }
  // 「正しいもの／誤っているもの」に関係なく、選択肢の記述そのものが正しいか（ok）を問う
  return q.choices.map((c, i) => ({
    kind: 'tf', itemId: itemIdFor(q, 'tf', i), question: q, index: i, statement: c.text, answer: c.ok, note: c.note || '',
  }));
}

/** 項目IDから出題項目を作る。問題が無い・出題できないときは null */
export function resolveItem(itemId, questionsById) {
  const parts = String(itemId).split('#');
  if (parts.length > 2) return null;
  const q = questionsById.get(parts[0]);
  if (!q || !isActive(q)) return null;
  if (parts.length === 1) {
    return q.type === 'truefalse' ? tfItems(q)[0] : choiceItem(q); // choice・single は4択として解く
  }
  if (q.type !== 'choice' || !/^\d+$/.test(parts[1])) return null;
  const i = Number(parts[1]);
  return tfItems(q).find((it) => it.index === i) || null;
}

/** 4択の採点。picked は選択肢の番号 */
export function gradeChoice(item, picked) {
  return picked === correctIndex(item.question);
}

/** ○×の採点。picked は true(○) か false(×) */
export function gradeTf(item, picked) {
  return picked === item.answer;
}

/** 配列を並べ替えた新しい配列（rng は 0以上1未満の乱数を返す関数。テストで差し替える） */
export function shuffle(list, rng = Math.random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 資格の問題から、出題できるもの（retired を除く）を、科目・タグで絞る */
export function filterQuestions(questions, { subject, tag } = {}) {
  return questions.filter((q) => isActive(q)
    && (!subject || q.subject === subject)
    && (!tag || (q.tags || []).includes(tag)));
}

/** 出題できる問題にあるタグの一覧（重複なし・五十音順に近い並び） */
export function tagsOf(questions) {
  return [...new Set(questions.filter(isActive).flatMap((q) => q.tags || []))].sort((a, b) => a.localeCompare(b, 'ja'));
}

/**
 * 出題キューを作る。
 *   mode: 'choice'（4択演習）| 'tf'（○×）| 'review'（今日の復習）| 'wrong'（間違えた問題）
 *   subject / tag: 絞り込み（任意）　order: 'seq'（問題の並びどおり）| 'random'
 *   records: その資格の学習記録　today: 復習の期限の判定に使う日（Date か 'YYYY-MM-DD'）
 *   limit: 最大の問題数（任意）　rng: 乱数（テスト用）
 */
export function buildQueue({ questions, mode, subject, tag, order = 'seq', records = [], today = new Date(), limit, rng = Math.random }) {
  const pool = filterQuestions(questions, { subject, tag });
  const byId = new Map(pool.map((q) => [q.id, q]));
  let items;
  if (mode === 'choice') {
    items = pool.filter((q) => q.type === 'choice' || q.type === 'single').map(choiceItem);
  } else if (mode === 'tf') {
    items = pool.flatMap(tfItems);
  } else if (mode === 'review' || mode === 'wrong') {
    const ids = mode === 'review' ? dueItemIds(records, today) : wrongItemIds(records);
    items = ids.map((id) => resolveItem(id, byId)).filter(Boolean); // 並びは期限順／新しく間違えた順のまま
  } else {
    throw new Error(`mode が不正です: ${mode}`);
  }
  if (order === 'random') items = shuffle(items, rng);
  return limit ? items.slice(0, limit) : items;
}
