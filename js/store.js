// 資格データ（data/）の読み込みと、形の検査。
// このファイルは画面にも IndexedDB にも依存しない（node のテストからそのまま読める）。

export const SOURCE_KINDS = ['original', 'ai-draft', 'past-exam', 'textbook-ref'];
// choice … 選択肢に ok を持つ4択（正解は pick と ok から計算）／single … 正解の番号 answer を持つ選択式（個数・組合せ問題など）／truefalse … ○×
export const QUESTION_TYPES = ['choice', 'single', 'truefalse'];

const SLUG = /^[a-z][a-z0-9]*$/; // 資格ID・科目ID（問題IDの区切りの - と混ざらないようハイフン無し）
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isStr = (x) => typeof x === 'string' && x.trim() !== '';
const isInt = (x) => Number.isInteger(x);

function isDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export { isDateStr };

// ---------- 検査 ----------

/** data/index.json の形を確かめる。おかしければ例外 */
export function validateIndex(idx) {
  if (!isObj(idx) || idx.schemaVersion !== 1) throw new Error('data/index.json: 対応していない形式です（schemaVersion が 1 ではない）');
  if (!Array.isArray(idx.exams)) throw new Error('data/index.json: exams（資格の一覧）がありません');
  const ids = new Set();
  for (const e of idx.exams) {
    if (!isObj(e) || !SLUG.test(e.id || '')) throw new Error('data/index.json: 資格の id は半角英小文字と数字にしてください');
    if (ids.has(e.id)) throw new Error(`data/index.json: 資格 ${e.id} が2回あります`);
    ids.add(e.id);
    if (!isStr(e.name)) throw new Error(`data/index.json: ${e.id} の name がありません`);
    if (typeof e.path !== 'string' || !/^[a-z][a-z0-9]*\/exam\.json$/.test(e.path)) throw new Error(`data/index.json: ${e.id} の path は「フォルダ名/exam.json」の形にしてください`);
    if (!isInt(e.revision) || e.revision < 1) throw new Error(`data/index.json: ${e.id} の revision は1以上の整数にしてください`);
  }
  return idx;
}

/** 資格の定義（exam.json）の形を確かめる。おかしければ例外 */
export function validateExam(e) {
  if (!isObj(e) || e.schemaVersion !== 1) throw new Error('対応していない形式です（schemaVersion が 1 ではない）');
  if (typeof e.id !== 'string' || !SLUG.test(e.id)) throw new Error('資格の id は半角英小文字と数字にしてください');
  if (!isStr(e.name)) throw new Error(`${e.id}: name（資格名）がありません`);
  if (e.shortName != null && !isStr(e.shortName)) throw new Error(`${e.id}: shortName が不正です`);
  if (!isInt(e.revision) || e.revision < 1) throw new Error(`${e.id}: revision は1以上の整数にしてください`);
  const x = e.exam;
  if (!isObj(x) || !isInt(x.questions) || x.questions < 1 || !isInt(x.minutes) || x.minutes < 1) {
    throw new Error(`${e.id}: exam（問題数 questions・時間 minutes・選択肢の数 choices）が不正です`);
  }
  if (!isInt(x.choices) || x.choices < 2) throw new Error(`${e.id}: exam.choices（選択肢の数）は2以上の整数にしてください`);
  if (x.maxPoints != null && (!isInt(x.maxPoints) || x.maxPoints < 1)) throw new Error(`${e.id}: exam.maxPoints（満点）は1以上の整数にしてください`);
  const max = x.maxPoints ?? x.questions; // 満点。無ければ「1問1点」で問題数
  if (x.passLineHint != null && (!isInt(x.passLineHint) || x.passLineHint < 1 || x.passLineHint > max)) {
    throw new Error(`${e.id}: exam.passLineHint（合格目安）は 1〜満点（${max}）の整数にしてください`);
  }
  if (e.nextExamDate != null && !isDateStr(e.nextExamDate)) throw new Error(`${e.id}: nextExamDate は YYYY-MM-DD の日付にしてください`);
  if (!Array.isArray(e.subjects) || e.subjects.length === 0) throw new Error(`${e.id}: subjects（科目）がありません`);
  const sids = new Set();
  for (const s of e.subjects) {
    if (!isObj(s) || !SLUG.test(s.id || '') || !isStr(s.name)) throw new Error(`${e.id}: 科目の id（半角英小文字と数字）と name が必要です`);
    if (!isInt(s.count) || s.count < 0) throw new Error(`${e.id}: 科目 ${s.id} の count は0以上の整数にしてください`);
    if (sids.has(s.id)) throw new Error(`${e.id}: 科目 ${s.id} が2回あります`);
    sids.add(s.id);
  }
  if (!Array.isArray(e.questionFiles)) throw new Error(`${e.id}: questionFiles（問題ファイルの一覧）がありません`);
  if (new Set(e.questionFiles).size !== e.questionFiles.length) throw new Error(`${e.id}: questionFiles に同じファイルが2回あります`);
  for (const f of e.questionFiles) {
    if (typeof f !== 'string' || !/^q-[a-z0-9-]+\.json$/.test(f)) throw new Error(`${e.id}: 問題ファイル名 ${f} は「q-〇〇.json」の形にしてください`);
  }
  return e;
}

/**
 * 4択で選ぶ選択肢が「記述が正しい（ok:true）」ものか「誤り（ok:false）」ものか。
 * 問題の pick（true=正しい／適切なものを選ぶ、false=誤り／不適切なものを選ぶ）があればそれ。
 * 無ければ ask の文言から推定（正しいもの・適切なもの→true、誤っているもの・不適切なもの→false）。決まらなければ null。
 */
export function pickOf(q) {
  if (typeof q.pick === 'boolean') return q.pick;
  const ask = typeof q.ask === 'string' ? q.ask : '';
  // 「正しくないもの」「適切でないもの」のように否定が付くと向きが逆になる。「誤っていないもの」のように否定語が
  // 誤り側の語につくと、また逆（＝正しいもの）。ふつうの語（正しいもの・不適切なもの）は否定語が無いので変わらない。
  let polarity;
  if (/不適切|不適当|誤|間違/.test(ask)) polarity = false;
  else if (/適切|適当|正し/.test(ask)) polarity = true;
  else return null;
  if (/でない|ではない|くない|ていない/.test(ask)) polarity = !polarity;
  return polarity;
}

/**
 * 問題1問の形を確かめる。おかしければ例外（メッセージに問題IDを含める）。
 * 欠けている tags・status は補う。exam は検査済みの資格定義。
 */
export function validateQuestion(q, exam, { priv = false } = {}) {
  const where = isObj(q) && typeof q.id === 'string' ? `問題 ${q.id}` : '問題';
  const fail = (msg) => { throw new Error(`${where}: ${msg}`); };
  if (!isObj(q)) fail('形が不正です');
  // 公開データの id は「資格ID-科目ID-4桁」、取り込む（private）問題の id は「資格ID-科目ID-p4〜8桁」（過去問は p＋西暦年＋問番号 など）。形を分けて、公開データとの衝突をなくす
  const m = typeof q.id === 'string' ? q.id.match(priv ? /^([a-z][a-z0-9]*)-([a-z][a-z0-9]*)-p(\d{4,8})$/ : /^([a-z][a-z0-9]*)-([a-z][a-z0-9]*)-(\d{4})$/) : null;
  if (!m) fail(priv ? `取り込む問題の id は「資格ID-科目ID-p4〜8桁の番号」（例 ${exam.id}-${exam.subjects[0].id}-p0001、過去問なら ${exam.id}-${exam.subjects[0].id}-p202501）の形にしてください` : 'id は「資格ID-科目ID-4桁の番号」（例 takken-kenri-0001）の形にしてください');
  if (m[1] !== exam.id) fail(`id の資格ID（${m[1]}）が資格 ${exam.id} と違います`);
  if (m[2] !== q.subject) fail(`id の科目ID（${m[2]}）と subject（${q.subject}）が違います`);
  if (!exam.subjects.some((s) => s.id === q.subject)) fail(`subject ${q.subject} は資格の科目にありません`);
  q.tags ??= [];
  if (!Array.isArray(q.tags) || !q.tags.every(isStr)) fail('tags は文字列の配列にしてください');
  if (!QUESTION_TYPES.includes(q.type)) fail(`type は ${QUESTION_TYPES.join(' / ')} のどれかにしてください`);
  if (!isStr(q.stem)) fail('stem（問題文）がありません');
  if (q.noTf != null && typeof q.noTf !== 'boolean') fail('noTf は true か false にしてください（true なら○×一問一答に出さない）');
  if (q.type === 'single') {
    const n = exam.exam.choices;
    if (q.ask != null && typeof q.ask !== 'string') fail('ask は文字列にしてください');
    if (!Array.isArray(q.choices) || q.choices.length !== n) fail(`choices（選択肢）は ${n} 個にしてください`);
    q.choices.forEach((c, i) => {
      if (!isObj(c) || !isStr(c.text)) fail(`選択肢 ${i + 1} の text がありません`);
      if (c.note != null && typeof c.note !== 'string') fail(`選択肢 ${i + 1} の note は文字列にしてください`);
    });
    if (!isInt(q.answer) || q.answer < 0 || q.answer >= n) fail(`answer（正解の選択肢の番号。0始まり）は 0〜${n - 1} の整数にしてください`);
  } else if (q.type === 'choice') {
    if (!isStr(q.ask)) fail('ask（問い方。例「正しいもの」「適切なもの」）がありません');
    if (q.pick != null && typeof q.pick !== 'boolean') fail('pick は true か false にしてください');
    if (pickOf(q) === null) fail(`ask「${q.ask}」から、正しいものを選ぶのか誤りを選ぶのか決められません。pick（true=正しい／適切なものを選ぶ、false=誤り／不適切なものを選ぶ）を指定してください`);
    const n = exam.exam.choices;
    if (!Array.isArray(q.choices) || q.choices.length !== n) fail(`choices（選択肢）は ${n} 個にしてください`);
    q.choices.forEach((c, i) => {
      if (!isObj(c) || !isStr(c.text)) fail(`選択肢 ${i + 1} の text がありません`);
      if (typeof c.ok !== 'boolean') fail(`選択肢 ${i + 1} の ok は true か false にしてください`);
      if (c.note != null && typeof c.note !== 'string') fail(`選択肢 ${i + 1} の note は文字列にしてください`);
    });
    const want = pickOf(q);
    const hit = q.choices.filter((c) => c.ok === want).length;
    if (hit !== 1) fail(`「${q.ask}」を選ぶ問題では、ok が ${want} の選択肢がちょうど1つ必要です（今は ${hit} 個）`);
  } else if (typeof q.ok !== 'boolean') {
    fail('○×問題には ok（記述が正しいなら true）が必要です');
  }
  if (q.explanation != null && typeof q.explanation !== 'string') fail('explanation は文字列にしてください');
  if (q.basis != null && typeof q.basis !== 'string') fail('basis は文字列にしてください');
  if (q.basisText != null) {
    // 根拠条文の本文（tools/egov.mjs で取ったもの）。解説の下に「条文を見る」で表示する
    if (!Array.isArray(q.basisText)) fail('basisText は配列にしてください');
    q.basisText.forEach((b, i) => {
      if (!isObj(b) || !isStr(b.ref) || !isStr(b.text)) fail(`basisText の ${i + 1} 件目に ref（条文名）と text（本文）が必要です`);
      for (const k of ['lawId', 'elm']) if (b[k] != null && typeof b[k] !== 'string') fail(`basisText の ${i + 1} 件目の ${k} は文字列にしてください`);
      if (b.asOf != null && !isDateStr(b.asOf)) fail(`basisText の ${i + 1} 件目の asOf は YYYY-MM-DD の日付にしてください`);
    });
  }
  if (!isObj(q.source) || !SOURCE_KINDS.includes(q.source.kind)) fail(`source.kind は ${SOURCE_KINDS.join(' / ')} のどれかにしてください`);
  if (q.source.ref != null && typeof q.source.ref !== 'string') fail('source.ref は文字列にしてください');
  if (q.source.url != null && typeof q.source.url !== 'string') fail('source.url は文字列にしてください');
  if (q.lawAsOf != null && !isDateStr(q.lawAsOf)) fail('lawAsOf は YYYY-MM-DD の日付にしてください');
  if (typeof q.reviewed !== 'boolean') fail('reviewed（人が確かめたか）は true か false にしてください');
  if (q.reviewedAt != null && !isDateStr(q.reviewedAt)) fail('reviewedAt は YYYY-MM-DD の日付にしてください');
  q.status ??= 'active';
  if (q.status !== 'active' && q.status !== 'retired') fail('status は active か retired にしてください');
  if (q.revision != null && (!isInt(q.revision) || q.revision < 1)) fail('revision は1以上の整数にしてください');
  if (q.updated != null && !isDateStr(q.updated)) fail('updated は YYYY-MM-DD の日付にしてください');
  return q;
}

/** 問題ファイル（q-*.json）の形を確かめる。おかしければ例外 */
export function validateQuestionFile(f, exam, opts) {
  if (!isObj(f) || f.schemaVersion !== 1) throw new Error('対応していない形式です（schemaVersion が 1 ではない）');
  if (f.exam !== exam.id) throw new Error(`exam（${f.exam}）が資格 ${exam.id} と違います`);
  if (f.subject != null && !exam.subjects.some((s) => s.id === f.subject)) throw new Error(`subject ${f.subject} は資格の科目にありません`);
  if (!Array.isArray(f.questions)) throw new Error('questions（問題の配列）がありません');
  const ids = new Set();
  for (const q of f.questions) {
    validateQuestion(q, exam, opts);
    if (f.subject != null && q.subject !== f.subject) throw new Error(`問題 ${q.id}: ファイルの subject（${f.subject}）と違う科目です`);
    if (ids.has(q.id)) throw new Error(`問題 ${q.id} がファイルの中で重複しています`);
    ids.add(q.id);
  }
  return f;
}

// ---------- 正解の計算・出題対象 ----------

/** 選択式の問題（choice・single）の正解の選択肢の番号（0始まり）。○×問題や不正な問題は -1 */
export function correctIndex(q) {
  if (q && q.type === 'single') return Number.isInteger(q.answer) && Array.isArray(q.choices) && q.answer >= 0 && q.answer < q.choices.length ? q.answer : -1;
  if (!q || q.type !== 'choice' || !Array.isArray(q.choices)) return -1;
  const target = pickOf(q);
  if (target === null) return -1;
  const hits = q.choices.map((c, i) => (c.ok === target ? i : -1)).filter((i) => i >= 0);
  return hits.length === 1 ? hits[0] : -1;
}

/** 出題してよい問題か（retired は出さない） */
export function isActive(q) {
  return q.status !== 'retired';
}

// ---------- 取り込み（private） ----------

/**
 * 取り込むJSON（q-*.json と同じ形）を検査し、取り込める問題と、公開データと id が重複して取り込めない問題に分ける。
 * exams は loadCatalog の exams。形がおかしければ例外。
 */
export function prepareImport(json, exams) {
  const entry = exams.find((e) => e.exam.id === (json && json.exam));
  if (!entry) throw new Error(`この資格（${json && json.exam}）は登録されていません`);
  // 画面の都合の項目（__ で始まるもの）は持ち込まない
  const clean = JSON.parse(JSON.stringify(json, (k, v) => (k.startsWith('__') ? undefined : v)));
  // 取り込む問題の id は「資格ID-科目ID-p4〜8桁」の形だけ。公開データの id（pなし）とは形が違うので衝突しない
  validateQuestionFile(clean, entry.exam, { priv: true });
  return { examId: entry.exam.id, accepted: clean.questions };
}

/**
 * ファイルを UTF-8 として読んだ文字列が文字化けしていないか確かめる（Shift-JIS で保存されたファイルは
 * 読むと � が混ざる）。化けていたら例外
 */
export function assertNoMojibake(text) {
  if (text.includes('\uFFFD')) throw new Error('文字化けしています。UTF-8 で保存し直してください（メモ帳なら「名前を付けて保存」で文字コードに UTF-8 を選びます）');
  return text;
}

// ---------- 読み込み ----------

async function fetchJson(path) {
  let res;
  try {
    res = await fetch(path, { cache: 'no-cache' });
  } catch {
    throw new Error(`${path} を読めません（通信できません。まだ一度も開いていない場合は、電波のあるところで開いてください）`);
  }
  if (!res.ok) throw new Error(`${path} を読めません（${res.status}）`);
  try {
    return await res.json();
  } catch {
    throw new Error(`${path} の中身がJSONとして読めません`);
  }
}

/** 端末内に取り込んだ問題（rows: { question }）を、検査してから各資格に合流させる。使えない問題は errors に入れる */
export function mergePrivate(exams, rows, errors = []) {
  for (const row of rows) {
    const entry = exams.find((e) => e.exam.id === row.examId);
    if (!entry) { errors.push(`取り込み済みの問題 ${row.id}: 資格 ${row.examId} が見つかりません`); continue; }
    try {
      const q = validateQuestion(JSON.parse(JSON.stringify(row.question)), entry.exam, { priv: true });
      // 形が違うので普通は起きないが、起きたら黙って捨てずに知らせる（公開側を優先）
      if (entry.questions.some((x) => x.id === q.id)) throw new Error(`問題 ${q.id} は公開データと id が重複しているため使いません`);
      q.__private = true;
      entry.questions.push(q);
    } catch (e) {
      errors.push(`取り込み済みの問題: ${e.message}`);
    }
  }
  return exams;
}

/**
 * data/index.json から資格・問題を読む。戻り値 { exams: [{ exam, questions }], errors: [文字列] }
 * 一部のファイルが壊れていても、読めたものは使う（壊れたものは errors に入れる）。
 * index.json そのものが読めなければ例外。
 */
export async function loadCatalog({ privateRows = [] } = {}) {
  const errors = [];
  const index = validateIndex(await fetchJson('data/index.json'));
  const exams = [];
  for (const entry of index.exams) {
    try {
      const exam = validateExam(await fetchJson(`data/${entry.path}`));
      if (exam.id !== entry.id) throw new Error(`id（${exam.id}）が一覧（${entry.id}）と違います`);
      const dir = entry.path.replace(/[^/]*$/, '');
      const questions = [];
      const seen = new Set();
      for (const file of exam.questionFiles) {
        try {
          const f = validateQuestionFile(await fetchJson(`data/${dir}${file}`), exam);
          for (const q of f.questions) {
            if (seen.has(q.id)) throw new Error(`問題 ${q.id} が他のファイルと重複しています`);
          }
          for (const q of f.questions) { seen.add(q.id); questions.push(q); }
        } catch (e) {
          errors.push(`${exam.name} ${file}: ${e.message}`);
        }
      }
      exams.push({ exam, questions });
    } catch (e) {
      errors.push(`${entry.name}: ${e.message}`);
    }
  }
  mergePrivate(exams, privateRows, errors);
  return { exams, errors };
}
