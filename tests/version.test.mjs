// 画面の版（js/version.js）と Service Worker の版（sw.js）がずれていないか
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { APP_VERSION } from '../js/version.js';
import { parseAppFiles } from '../tools/release.mjs';

const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

test('sw.js の VERSION が js/version.js と同じ', () => {
  const m = sw.match(/const VERSION = '([^']+)'/);
  assert.ok(m, 'sw.js に VERSION がありません');
  assert.equal(m[1], APP_VERSION);
});

const list = parseAppFiles(sw);

test('APP_FILES の読み取り: コメントを除き、最後の項目にカンマが無くても拾う', () => {
  const src = ['const APP_FILES = [', "  './',", "  // 'ignored.js',", "  'a.js',", "  'b/c.json'", '];'].join('\n');
  assert.deepEqual(parseAppFiles(src), ['a.js', 'b/c.json']);
  assert.throws(() => parseAppFiles('const X = 1;'));
});

test('sw.js が事前保存するファイルがすべて存在し、重複がない', () => {
  assert.ok(list.length > 10);
  assert.equal(new Set(list).size, list.length, 'APP_FILES に同じファイルが2回あります');
  for (const f of list) assert.ok(existsSync(new URL(`../${f}`, import.meta.url)), `${f} がありません`);
});

test('画面のファイル（js/・css/・icons/・index.html・manifest）がすべて sw.js の保存一覧に入っている（入れ忘れると圏外で動かない）', () => {
  const set = new Set(list);
  const files = ['index.html', 'manifest.webmanifest'];
  for (const dir of ['js', 'css', 'icons']) for (const f of readdirSync(new URL(`../${dir}/`, import.meta.url))) files.push(`${dir}/${f}`);
  for (const f of files) assert.ok(set.has(f), `${f} が sw.js の APP_FILES にありません`);
});

test('画面のファイルを変えたら版を上げている（npm run bump）', async () => {
  const { appHash, readLock } = await import('../tools/release.mjs');
  const lock = readLock();
  assert.equal(lock.version, APP_VERSION, 'version-lock.json の版が js/version.js と違います。npm run bump を実行してください');
  assert.equal(appHash(), lock.hash, '画面のファイルが変わったのに版が上がっていません。npm run bump を実行してください');
});
