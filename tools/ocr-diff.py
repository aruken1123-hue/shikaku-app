# -*- coding: utf-8 -*-
"""書き起こし（transcript.txt）と Windows 内蔵OCR（pNN.win.txt）をページごとに比べ、食い違う所を一覧にする。
内蔵OCRは誤読が多いので、食い違い＝書き起こしの誤り とは限らない。各箇所を画像で見て決めるための一覧。
使い方: python -I tools/ocr-diff.py <ocrフォルダ（pNN.png と pNN.win.txt がある所）> <transcript.txt> [--out 一覧.txt]
  ・一覧には過去問の文が入るので、--out は private/ の中（例 private/ocr/R4/diff.txt）に書く。
  ・表紙（#表紙）は p01 と比べる。内蔵OCRの結果があるのに書き起こしに無いページは、最初に一覧にする（白紙・裏表紙・正解表なら問題なし）。
"""
import difflib
import os
import re
import sys
import unicodedata


def norm(s):
    s = unicodedata.normalize('NFKC', s)
    return re.sub(r'\s+', '', s)


def read_win(path):
    """内蔵OCRの結果を1つの文字列に。最後の数字だけの行（ページ番号）は除く"""
    with open(path, encoding='utf-8') as f:
        lines = [ln for ln in f.read().splitlines() if ln.strip()]
    if lines and re.fullmatch(r'[\s\-—―一ー－]*\d{1,3}[\s\-—―一ー－]*', unicodedata.normalize('NFKC', lines[-1])):
        lines = lines[:-1]
    return norm(''.join(lines))


def read_transcript(path):
    """{ページ番号: [行]}。表紙はページ1として扱う。同じページ番号が2回あれば止める"""
    pages, cur = {}, None
    with open(path, encoding='utf-8') as f:
        for raw in f.read().splitlines():
            m = re.fullmatch(r'#ページ\s*(\d+)\s*', raw)
            if raw.strip() == '#表紙' or m:
                cur = int(m.group(1)) if m else 1
                if cur in pages:
                    sys.exit(f'ページ {cur} が書き起こしに2回あります')
                pages[cur] = []
            elif raw.startswith('#'):
                sys.exit(f'読めない印です: {raw[:20]}（使えるのは「#表紙」と「#ページ 3」の形だけ）')
            elif cur is not None:
                pages[cur].append(raw)
    return pages


def compare(d, pages):
    lines, total = [], 0
    win_pages = sorted(int(m.group(1)) for f in os.listdir(d) if (m := re.fullmatch(r'p(\d+)\.win\.txt', f)))
    skipped = [n for n in win_pages if n not in pages]
    lines.append('書き起こしに無いページ（白紙・裏表紙・正解表か確かめる）: ' + ('、'.join(f'p{n:02d}' for n in skipped) or 'なし'))
    for no, ls in sorted(pages.items()):
        p = os.path.join(d, f'p{no:02d}.win.txt')
        if not os.path.exists(p):
            lines.append(f'== p{no:02d}: 内蔵OCRの結果がありません')
            continue
        win = read_win(p)
        t = norm(''.join(ls))
        if not win:
            lines.append(f'== p{no:02d}: 内蔵OCRの結果が空です（OCRの失敗かもしれません。画像で全体を見直す）')
            continue
        sm = difflib.SequenceMatcher(None, t, win, autojunk=False)
        hunks = [op for op in sm.get_opcodes() if op[0] != 'equal']
        total += len(hunks)
        label = '表紙' if no == 1 else f'p{no:02d}'
        lines.append(f'== {label}（一致率 {sm.ratio():.3f}、食い違い {len(hunks)} 箇所）')
        for _tag, i1, i2, j1, j2 in hunks:
            lines.append(f'  …{t[max(0, i1 - 8):i1]}［書き起こし: {t[i1:i2] or "（なし）"} ／ 内蔵OCR: {win[j1:j2] or "（なし）"}］{t[i2:i2 + 8]}…')
    lines.insert(0, f'全 {len(pages)} ページ（表紙を含む）、食い違い {total} 箇所')
    return lines


def main(argv):
    args = [a for a in argv if a != '--out']
    out = argv[argv.index('--out') + 1] if '--out' in argv else None
    if out:
        args.remove(out)
    if len(args) != 2:
        sys.exit('使い方: python -I tools/ocr-diff.py <ocrフォルダ> <transcript.txt> [--out 一覧.txt]')
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    lines = compare(args[0], read_transcript(args[1]))
    text = '\n'.join(lines) + '\n'
    if out:
        with open(out, 'w', encoding='utf-8') as f:
            f.write(text)
        print(lines[0], '→', out)
        print(lines[1])
    else:
        print(text)


if __name__ == '__main__':
    main(sys.argv[1:])
