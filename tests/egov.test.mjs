// tools/egov.mjs（e-Gov 法令API から条文を取る道具）の、通信しない部分と、偽の通信での動作の確認
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lawOf, parseArticle, parseParagraph, buildElm, buildRef, buildUrl, textOf, fetchBasisText, LAWS } from '../tools/egov.mjs';

test('法令名 → 法令ID（別名・法令IDそのものも可）。表に無い名前は候補つきで失敗', () => {
  assert.deepEqual(lawOf('宅建業法'), { name: '宅建業法', id: '327AC1000000176', direct: false });
  assert.equal(lawOf('宅地建物取引業法').id, '327AC1000000176');
  assert.equal(lawOf('民法').id, '129AC0000000089');
  assert.equal(lawOf('329AC0000000119').id, '329AC0000000119');
  assert.throws(() => lawOf('存在しない法'), /宅建業法/);
  assert.ok(Object.keys(LAWS).length >= 12);
});

test('条・項の指定: 枝番（22の2）に対応し、elm と表示名を作る', () => {
  assert.deepEqual(parseArticle('35'), ['35']);
  assert.deepEqual(parseArticle('22の2'), ['22', '2']);
  assert.deepEqual(parseArticle('22-2'), ['22', '2']);
  assert.deepEqual(parseArticle('第２２条の２'), ['22', '2']);
  assert.deepEqual(parseArticle('8の2の3'), ['8', '2', '3']);
  assert.throws(() => parseArticle('abc'), /読めません/);
  assert.equal(parseParagraph('6'), '6');
  assert.equal(parseParagraph('第6項'), '6');
  assert.throws(() => parseParagraph('x'), /読めません/);
  assert.equal(buildElm(['35'], '6'), 'MainProvision-Article_35-Paragraph_6');
  assert.equal(buildElm(['22', '2'], null), 'MainProvision-Article_22_2');
  assert.equal(buildElm(['22', '2'], '3'), 'MainProvision-Article_22_2-Paragraph_3');
  assert.equal(buildRef('宅建業法', ['35'], '6'), '宅建業法35条6項');
  assert.equal(buildRef('宅建業法', ['22', '2'], '3'), '宅建業法22条の2第3項');
  assert.equal(buildRef('民法', ['177'], null), '民法177条');
});

test('URL: e-Gov 法令API v2 の形（asof は付けたときだけ）', () => {
  const u = new URL(buildUrl('327AC1000000176', 'MainProvision-Article_35-Paragraph_6'));
  assert.equal(u.origin + u.pathname, 'https://laws.e-gov.go.jp/api/2/law_data/327AC1000000176');
  assert.equal(u.searchParams.get('elm'), 'MainProvision-Article_35-Paragraph_6');
  assert.equal(u.searchParams.get('response_format'), 'json');
  assert.equal(u.searchParams.get('asof'), null);
  assert.equal(new URL(buildUrl('x', 'e', '2025-04-01')).searchParams.get('asof'), '2025-04-01');
});

const tree = {
  tag: 'Paragraph', attr: { Num: '2' }, children: [
    { tag: 'ParagraphNum', attr: {}, children: ['２'] },
    { tag: 'ParagraphSentence', attr: {}, children: [{ tag: 'Sentence', attr: {}, children: ['次に掲げる事項を',
      { tag: 'Ruby', attr: {}, children: ['説明', { tag: 'Rt', attr: {}, children: ['せつめい'] }] }, 'する。'] }] },
    { tag: 'Item', attr: {}, children: [{ tag: 'ItemTitle', attr: {}, children: ['一'] }, { tag: 'ItemSentence', attr: {}, children: [{ tag: 'Sentence', attr: {}, children: ['甲の事項'] }] }] },
    { tag: 'Item', attr: {}, children: [{ tag: 'ItemTitle', attr: {}, children: ['二'] }, { tag: 'ItemSentence', attr: {}, children: [{ tag: 'Sentence', attr: {}, children: ['乙の事項'] }] }] },
  ],
};

test('条文ツリーから本文を作る: 項番号・号を改行して並べ、ふりがなは捨てる', () => {
  assert.equal(textOf(tree), ['２　次に掲げる事項を説明する。', '一　甲の事項', '二　乙の事項'].join('\n'));
  assert.equal(textOf('そのまま'), 'そのまま');
  assert.equal(textOf(null), '');
});

const fakeFetch = (status, body, calls = []) => async (url) => {
  calls.push(String(url));
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
};

test('条文を取る（偽の通信）: basisText 1件分の形で返し、取得日を asOf にする', async () => {
  const calls = [];
  const r = await fetchBasisText({ law: '宅建業法', article: '35', paragraph: '2', fetchImpl: fakeFetch(200, { law_full_text: tree }, calls), today: () => '2026-10-29' });
  assert.deepEqual(r, { ref: '宅建業法35条2項', lawId: '327AC1000000176', elm: 'MainProvision-Article_35-Paragraph_2', asOf: '2026-10-29', text: textOf(tree) });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /law_data\/327AC1000000176\?elm=MainProvision-Article_35-Paragraph_2&response_format=json/);
  const r2 = await fetchBasisText({ law: '宅建業法', article: '22の2', asof: '2025-04-01', fetchImpl: fakeFetch(200, { law_full_text: tree }, calls) });
  assert.equal(r2.asOf, '2025-04-01');
  assert.match(calls[1], /Article_22_2&response_format=json&asof=2025-04-01/);
});

test('条文を取る: エラー（404・空の本文・通信できない）はわかる文で失敗する', async () => {
  await assert.rejects(fetchBasisText({ law: '宅建業法', article: '999', fetchImpl: fakeFetch(404, { message: 'not found' }) }), /404/);
  await assert.rejects(fetchBasisText({ law: '宅建業法', article: '1', fetchImpl: fakeFetch(200, { law_full_text: { tag: 'Paragraph', children: [] } }) }), /取り出せません/);
  await assert.rejects(fetchBasisText({ law: '宅建業法', article: '1', fetchImpl: async () => { throw new Error('offline'); } }), /接続できません/);
  await assert.rejects(fetchBasisText({ law: 'ない法', article: '1', fetchImpl: fakeFetch(200, {}) }), /表にありません/);
});
