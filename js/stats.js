// 成績の表と、試験日までの残り日数。画面にも保存先にも依存しない。
import { accuracyBySubject, computeStates, daysBetween, toDateKey, questionIdOf } from './progress.js';
import { isActive, isDateStr } from './store.js';

/** 正答率の表示（回答が無ければ「―」） */
export function formatRate(rate) {
  return rate == null ? '―' : `${Math.round(rate * 100)}%`;
}

/**
 * 科目別の表の行。records はその資格の記録、questions はその資格の全問題。
 * 各行 { id, name, questionCount(出題できる問題数), answers, correct, rate(0〜1・回答なしは null), doneItems(1回以上解いた項目数) }
 * 最後に合計の行（id: '_total'）を付ける。
 */
export function subjectRows(exam, questions, records) {
  const subjectOf = new Map(questions.map((q) => [q.id, q.subject]));
  const acc = accuracyBySubject(records, (qid) => subjectOf.get(qid));
  const done = new Map();
  for (const id of computeStates(records).keys()) {
    const s = subjectOf.get(questionIdOf(id));
    if (s) done.set(s, (done.get(s) || 0) + 1);
  }
  const rows = exam.subjects.map((s) => {
    const a = acc.get(s.id);
    return {
      id: s.id, name: s.name,
      questionCount: questions.filter((q) => q.subject === s.id && isActive(q)).length,
      answers: a ? a.answers : 0, correct: a ? a.correct : 0, rate: a ? a.rate : null,
      doneItems: done.get(s.id) || 0,
    };
  });
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  const answers = sum('answers');
  const correct = sum('correct');
  rows.push({
    id: '_total', name: '全体', questionCount: sum('questionCount'), answers, correct,
    rate: answers ? correct / answers : null, doneItems: sum('doneItems'),
  });
  return rows;
}

/** 試験日。設定の上書き（YYYY-MM-DD）があればそれ、無ければ exam.json の nextExamDate */
export function examDate(exam, settings = {}) {
  const over = settings.examDates && settings.examDates[exam.id];
  if (over && isDateStr(over)) return { date: over, overridden: true };
  return { date: exam.nextExamDate || null, overridden: false };
}

/** 試験日までの日数（今日が試験日なら0、過ぎていれば負） */
export function daysUntil(dateKey, today = new Date()) {
  if (!dateKey) return null;
  return daysBetween(toDateKey(today), dateKey);
}

/** 画面に出す文 */
export function daysUntilText(days) {
  if (days == null) return '試験日は未設定です';
  if (days > 0) return `試験まで あと ${days} 日`;
  if (days === 0) return '今日が試験日です';
  return '試験日は過ぎました';
}

/** 満点。exam.exam.maxPoints があればそれ、無ければ「1問1点」で問題数 */
export function maxPoints(exam) {
  return exam.exam.maxPoints ?? exam.exam.questions;
}

/** 合格目安（点）。設定の上書きがあればそれ、無ければ exam.json の passLineHint */
export function passLine(exam, settings = {}) {
  const over = settings.passLines && settings.passLines[exam.id];
  if (Number.isInteger(over) && over >= 1 && over <= maxPoints(exam)) return { points: over, overridden: true };
  return { points: exam.exam.passLineHint ?? null, overridden: false };
}

export const BACKUP_DAYS = 14;

/**
 * 記録の書き出しを促すか。最後に書き出した日（なければ最初の記録の日）から14日以上たち、
 * その後に増えた記録（学習記録または確認の印）があるとき true。
 */
export function needsBackup({ lastExportAt, records, reviews = [], now = new Date() }) {
  if (!records.length && !reviews.length) return false;
  // 記録が多くても落ちないよう、Math.min(...配列) は使わずループで最小・最大を求める
  let first = Infinity;
  let latest = -Infinity;
  for (const r of [...records, ...reviews]) {
    const t = Date.parse(r.at);
    if (t < first) first = t;
    if (t > latest) latest = t;
  }
  const exported = lastExportAt && !Number.isNaN(Date.parse(lastExportAt));
  const base = exported ? Date.parse(lastExportAt) : first;
  if (exported && !(latest > base)) return false;
  return (now.getTime() - base) >= BACKUP_DAYS * 86400000;
}
