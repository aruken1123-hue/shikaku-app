// 過去問取り込みツール（tools/import-retio.py・import-retio-ocr.py）の単体テストを、npm test から一緒に走らせる。
// Python が入っていない環境では、このテストだけ飛ばす（飛ばしたことが出力に出る）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./test_import_retio.py', import.meta.url));
const ocrScript = fileURLToPath(new URL('./test_import_retio_ocr.py', import.meta.url));

function findPython() {
  for (const cmd of ['python', 'python3', 'py']) {
    const r = spawnSync(cmd, ['-I', '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === '3') return cmd;
  }
  return null;
}

const py = findPython();

test('tools/import-retio.py のパーサー（Python unittest）', { skip: py ? false : 'Python 3 が見つからないため飛ばしました' }, () => {
  const r = spawnSync(py, ['-I', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, `Python のテストが失敗しました\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr + r.stdout, /OK/);
});

test('tools/import-retio-ocr.py（画像PDFの書き起こし→JSON、正解表の2人照合）', { skip: py ? false : 'Python 3 が見つからないため飛ばしました' }, () => {
  const r = spawnSync(py, ['-I', ocrScript], { encoding: 'utf8' });
  assert.equal(r.status, 0, `Python のテストが失敗しました\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /\nOK\s*$/);
});
