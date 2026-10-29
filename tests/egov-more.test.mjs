// tools/egov.mjs の追加分: 法令表・法令ID・--asof・応答の読み取り失敗
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lawOf, checkAsof, fetchBasisText } from '../tools/egov.mjs';

const tree = { tag: 'Paragraph', attr: {}, children: [{ tag: 'ParagraphSentence', attr: {}, children: [{ tag: 'Sentence', attr: {}, children: ['本文。'] }] }] };
const fakeFetch = (status, body) => async () => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

test('法令表: 宅建でよく使う法令と別名、法令IDの形', () => {
  assert.equal(lawOf('租税特別措置法').id, '332AC0000000026');
  assert.equal(lawOf('租特法').name, '租税特別措置法');
  assert.equal(lawOf('独立行政法人住宅金融支援機構法').id, '417AC0000000082');
  assert.equal(lawOf('宅建業法施行規則').id, '332M50004000012');
  assert.equal(lawOf('景表法').name, '不当景品類及び不当表示防止法');
  for (const n of ['所得税法', '登録免許税法', '印紙税法', '地価公示法', '宅地建物取引業法施行令', '建築基準法施行令', '都市計画法施行令']) assert.ok(lawOf(n).id, n);
  // 法令ID（先頭が数字3桁＋英大文字）は直接渡せる。M 系・CO 系も
  for (const id of ['327AC1000000176', '332M50004000012', '339CO0000000383']) assert.deepEqual(lawOf(id), { name: id, id, direct: true });
  assert.throws(() => lawOf('12345'), /表にありません/);
});

test('--asof の検査: 日付の形・実在する日付', () => {
  assert.equal(checkAsof('2025-04-01'), '2025-04-01');
  for (const bad of ['2025-13-45', '2025-02-30', '2025/04/01', '昨日', '', undefined]) assert.throws(() => checkAsof(bad), /日付/, String(bad));
});

test('法令IDを直接渡したときは応答の法令名で ref を作る。応答が JSON でなければ日本語のエラー', async () => {
  const body = { law_full_text: tree, revision_info: { law_title: '租税特別措置法' } };
  const r = await fetchBasisText({ law: '332AC0000000026', article: '72', paragraph: '1', fetchImpl: fakeFetch(200, body), today: () => '2026-10-29' });
  assert.equal(r.ref, '租税特別措置法72条1項');
  assert.equal(r.lawId, '332AC0000000026');
  // 応答に法令名が無ければ法令IDのまま
  const r2 = await fetchBasisText({ law: '332AC0000000026', article: '72', fetchImpl: fakeFetch(200, { law_full_text: tree }) });
  assert.equal(r2.ref, '332AC0000000026' + '72条');
  // 表にある名前のときは表の名前（応答の名前は使わない）。出力の形は従来どおり
  const r3 = await fetchBasisText({ law: '宅建業法', article: '35', fetchImpl: fakeFetch(200, { law_full_text: tree, revision_info: { law_title: '別名' } }), today: () => '2026-10-29' });
  assert.deepEqual(Object.keys(r3), ['ref', 'lawId', 'elm', 'asOf', 'text']);
  assert.equal(r3.ref, '宅建業法35条');
  const broken = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); }, text: async () => '<html>' });
  await assert.rejects(fetchBasisText({ law: '宅建業法', article: '35', fetchImpl: broken }), /JSON ではありません/);
  await assert.rejects(fetchBasisText({ law: '宅建業法', article: '35', asof: '2025-99-99', fetchImpl: fakeFetch(200, {}) }), /日付/);
});
