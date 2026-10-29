// e-Gov 法令API v2（国の法令データ。認証不要）から条文の本文を取り、問題の basisText 1件分のJSONを出す道具。
//
// 使い方: node tools/egov.mjs <法令名> <条> [項] [--asof YYYY-MM-DD]
//   例:   node tools/egov.mjs 宅建業法 35 6        → 宅建業法35条6項
//         node tools/egov.mjs 宅建業法 22の2 3     → 宅建業法22条の2第3項（枝番は「22の2」「22-2」「22_2」のどれでも）
//         node tools/egov.mjs 民法 177              → 民法177条（項を省くと条の全文）
//   出力: { ref, lawId, elm, asOf, text } … 問題の basisText 配列にそのまま足せる
//
// 外部に通信するのは、この道具を手で動かしたときだけ（アプリ本体は e-Gov に通信しない）。大量に呼ばないこと。
import { fileURLToPath } from 'node:url';

export const API_BASE = 'https://laws.e-gov.go.jp/api/2/law_data';

/** 法令名 → 法令ID（docs/問題作り.md と同じ） */
export const LAWS = {
  宅建業法: '327AC1000000176',
  民法: '129AC0000000089',
  都市計画法: '343AC0000000100',
  建築基準法: '325AC0000000201',
  国土利用計画法: '349AC1000000092',
  地方税法: '325AC0000000226',
  借地借家法: '403AC0000000090',
  区分所有法: '337AC0000000069',
  不動産登記法: '416AC0000000123',
  農地法: '327AC0000000229',
  土地区画整理法: '329AC0000000119',
  宅地造成及び特定盛土等規制法: '336AC0000000191',
  // 宅建でよく出る法令（IDは e-Gov の法令一覧API https://laws.e-gov.go.jp/api/2/laws?law_title=<名前> で確かめたもの）
  租税特別措置法: '332AC0000000026',
  所得税法: '340AC0000000033',
  登録免許税法: '342AC0000000035',
  印紙税法: '342AC0000000023',
  地価公示法: '344AC0000000049',
  不当景品類及び不当表示防止法: '337AC0000000134',
  宅地建物取引業法施行令: '339CO0000000383',
  宅地建物取引業法施行規則: '332M50004000012',
  建築基準法施行令: '325CO0000000338',
  都市計画法施行令: '344CO0000000158',
  独立行政法人住宅金融支援機構法: '417AC0000000082',
  住宅の品質確保の促進等に関する法律: '411AC0000000081',
  特定住宅瑕疵担保責任の履行の確保等に関する法律: '419AC0000000066',
};
/** 別の呼び名 */
const ALIASES = {
  宅地建物取引業法: '宅建業法',
  盛土規制法: '宅地造成及び特定盛土等規制法',
  宅地造成等規制法: '宅地造成及び特定盛土等規制法',
  建物の区分所有等に関する法律: '区分所有法',
  国土法: '国土利用計画法',
  宅建業法施行令: '宅地建物取引業法施行令',
  宅建業法施行規則: '宅地建物取引業法施行規則',
  租特法: '租税特別措置法',
  景表法: '不当景品類及び不当表示防止法',
  品確法: '住宅の品質確保の促進等に関する法律',
  履行確保法: '特定住宅瑕疵担保責任の履行の確保等に関する法律',
  住宅金融支援機構法: '独立行政法人住宅金融支援機構法',
  機構法: '独立行政法人住宅金融支援機構法',
};

const normalize = (s) => String(s).normalize('NFKC').trim();

/** 法令IDの形（例 327AC1000000176、332M50004000012）。法令名と取り違えないよう、先頭は数字3桁＋英大文字 */
const LAW_ID_RE = /^\d{3}[A-Z][A-Z0-9]{5,}$/;

/** 法令名（または法令ID）から { name, id, direct } を返す。direct は法令IDを直接渡したとき（名前は応答から取る）。分からなければ例外 */
export function lawOf(nameOrId) {
  const key = normalize(nameOrId);
  if (LAW_ID_RE.test(key)) return { name: key, id: key, direct: true }; // 法令IDそのもの
  const name = ALIASES[key] || key;
  if (!LAWS[name]) throw new Error(`法令名「${key}」は表にありません。使える名前: ${Object.keys(LAWS).join('、')}（法令IDを直接渡すこともできます）`);
  return { name, id: LAWS[name], direct: false };
}

/** --asof の値を確かめる（YYYY-MM-DD で、実在する日付）。違えば例外 */
export function checkAsof(s) {
  const d = typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : null;
  const ok = d !== null && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  if (!ok) throw new Error(`--asof の値「${s}」が日付ではありません（例 2025-04-01）`);
  return s;
}

/** 「35」「22の2」「22-2」「第35条」→ ['35'] / ['22', '2']（枝番つき） */
export function parseArticle(s) {
  const t = normalize(s).replace(/^第/, '').replace(/条の/g, 'の').replace(/条$/, '');
  if (!/^\d+([の\-_]\d+)*$/.test(t)) throw new Error(`条の指定「${s}」を読めません（例: 35、22の2、22-2）`);
  return t.split(/[の\-_]/);
}

export function parseParagraph(s) {
  const t = normalize(s).replace(/^第/, '').replace(/項$/, '');
  if (!/^\d+$/.test(t)) throw new Error(`項の指定「${s}」を読めません（例: 6）`);
  return t;
}

/** e-Gov の elm 指定。例 MainProvision-Article_22_2-Paragraph_3 */
export function buildElm(articleParts, paragraph) {
  return `MainProvision-Article_${articleParts.join('_')}${paragraph ? `-Paragraph_${paragraph}` : ''}`;
}

/** 表示用の条文名。例 宅建業法22条の2第3項（項だけの指定なら「35条6項」） */
export function buildRef(lawName, articleParts, paragraph) {
  const art = `${articleParts[0]}条${articleParts.slice(1).map((n) => `の${n}`).join('')}`;
  return `${lawName}${art}${paragraph ? (articleParts.length > 1 ? `第${paragraph}項` : `${paragraph}項`) : ''}`;
}

export function buildUrl(lawId, elm, asof) {
  const q = new URLSearchParams({ elm, response_format: 'json' });
  if (asof) q.set('asof', asof);
  return `${API_BASE}/${lawId}?${q}`;
}

// 改行して始める要素と、あとに全角空白を付ける見出しの要素
const BLOCKS = new Set(['Article', 'ArticleCaption', 'Paragraph', 'Item', 'TableRow', 'Remarks', 'List', 'ListSentence',
  ...Array.from({ length: 10 }, (_, i) => `Subitem${i + 1}`)]);
const TITLES = new Set(['ArticleTitle', 'ParagraphNum', 'ItemTitle', ...Array.from({ length: 10 }, (_, i) => `Subitem${i + 1}Title`)]);

/** e-Gov の条文ツリー（{ tag, attr, children }）から、読める本文を作る */
export function textOf(root) {
  const out = [];
  const walk = (n) => {
    if (typeof n === 'string') { out.push(n); return; }
    if (!n || typeof n !== 'object') return;
    if (n.tag === 'Rt') return; // ふりがな
    if (BLOCKS.has(n.tag)) out.push('\n');
    for (const c of n.children || []) walk(c);
    if (TITLES.has(n.tag) || n.tag === 'TableColumn') out.push('　');
  };
  for (const r of Array.isArray(root) ? root : [root]) walk(r);
  return out.join('').split('\n').map((l) => l.replace(/[ 　]+$/, '')).filter((l) => l.trim() !== '').join('\n').trim();
}

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * 条文を取って basisText 1件分を返す。
 * 取れた本文は「取得した日」を asOf にする（--asof を付けたときはその日時点の条文で、asOf もその日）。
 */
export async function fetchBasisText({ law, article, paragraph, asof, fetchImpl = fetch, today = todayStr }) {
  const { name, id, direct } = lawOf(law);
  if (asof != null) checkAsof(asof);
  const parts = parseArticle(article);
  const para = paragraph == null ? null : parseParagraph(paragraph);
  const elm = buildElm(parts, para);
  let res;
  try {
    res = await fetchImpl(buildUrl(id, elm, asof), { signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw new Error(`e-Gov に接続できませんでした: ${e.message}`);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`e-Gov がエラーを返しました（${res.status}）。条・項の指定が法令に無いかもしれません。${body}`);
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error('e-Gov の返事を読めませんでした（JSON ではありません。通信が途中で切れたか、API の形が変わった可能性があります）');
  }
  const text = textOf(json && json.law_full_text);
  if (!text) throw new Error('条文の本文を取り出せませんでした（e-Gov の返り値の形が変わった可能性があります）');
  // 法令IDを直接渡したときは、応答の法令名（例「租税特別措置法」）で「租税特別措置法72条1項」の形にする
  const title = direct && json.revision_info && typeof json.revision_info.law_title === 'string' && json.revision_info.law_title.trim();
  return { ref: buildRef(direct ? (title || name) : name, parts, para), lawId: id, elm, asOf: asof || today(), text };
}

async function main(argv) {
  const args = [];
  let asof;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--asof') {
      asof = argv[++i];
      if (asof === undefined || asof.startsWith('--')) { console.error('--asof には日付（YYYY-MM-DD）を続けてください'); return 2; }
    } else args.push(argv[i]);
  }
  if (args.length < 2 || args.length > 3) {
    console.error('使い方: node tools/egov.mjs <法令名> <条> [項] [--asof YYYY-MM-DD]\n例: node tools/egov.mjs 宅建業法 35 6');
    return 2;
  }
  if (asof !== undefined) {
    try { checkAsof(asof); } catch (e) { console.error(e.message); return 2; }
  }
  try {
    const r = await fetchBasisText({ law: args[0], article: args[1], paragraph: args[2], asof });
    console.log(JSON.stringify(r, null, 2));
    console.error('（出典: e-Gov 法令検索。問題の basisText 配列に足して使います）');
    return 0;
  } catch (e) {
    console.error(e.message);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
