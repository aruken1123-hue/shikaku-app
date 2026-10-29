#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""画像だけのPDF（令和4年度以前など）の過去問を、ページ画像からの書き起こし（transcript.txt）と正解表から JSON にする。
読み取りの本体は tools/import-retio.py の parse_pages をそのまま使う（正解表だけ外から渡す）。

使い方:
    python -I tools/import-retio-ocr.py private/ocr/R4/transcript.txt R4 \
        --key-a 1234123412 2341234123 3412341234 4123412341 1234123x12 \
        --key-b 1234123412 2341234123 3412341234 4123412341 1234123x12 \
        --out private/takken-R4.json

  ・回は R4 のように「R＋令和の年」。同じ年度に2回ある令和2・3年度は R2-10 / R2-12（id は p＋西暦＋月＋問番号、タグに「10月」）。
    12月の回の表紙には「（12月27日）」のような日付があり、10月の回には無い。回の名前と表紙が食い違えば止まる。
  ・正解表は2人が別々に画像を読んで、それぞれ --key-a と --key-b に渡す（1行10問ずつ5組。正解なし・複数正解の問は x）。
    2つが1文字でも違えば止まる（50桁の写し間違いは本人の見直しでは気づきにくいため。2026-10-29 に2回起きた）。
  ・transcript.txt の形:
      #表紙            … 次の「#ページ」までは表紙の文言（「令和〇年度」「令和〇年4月1日現在施行」を含める）
      #ページ 3        … PNG のページ番号（p03.png）。以降その頁の行（同じ番号を2回書かない）
    「#」で始まる行はこの2つの印だけ。ほかの「#」の行（「# ページ 3」など）は書き間違いとして止まる。
  ・書き起こしには50問すべてがあるはず。問題が見つからない・見出しが2回ある・選択肢が4つない問題があれば止まる
    （見出しの打ち間違いで、別の問の正解が付いたまま出力されるのを防ぐ）。外れてよいのは正解表で x の問だけ。
      【問 1】… ／ ア　… ／ 1　…（半角数字＋全角空白）
  ・書き起こしの確かめ方は docs/問題作り.md の「画像だけのPDF」を参照（tools/winocr.ps1 と tools/ocr-diff.py）。
"""
import argparse
import datetime
import importlib.util
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('import_retio', os.path.join(HERE, 'import-retio.py'))
ir = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ir)

UNDECIDED = '正解なし・複数正解（公式の注記）'
TWO_ROUND_ERAS = (2, 3)  # 10月と12月の2回、試験があった年度（令和2・3年度）
# 書き起こしなら起きないはずの警告。出たら書き起こしの形の誤りなので止める
STRICT_WARNINGS = ('問題が見つかりませんでした', '見出しが2回', '選択肢を4つ取れませんでした', '問題文が空')
LEFTOVER_HEADER_RE = re.compile(r'[【\[［]\s*問\s*[0-9０-９]')


def parse_key(groups):
    """10問ずつ5組の正解 → 50文字。形が違えば ParseError"""
    if len(groups) != 5 or not all(re.fullmatch(r'[1-4x]{10}', g) for g in groups):
        raise ir.ParseError('正解は表の1行（10問）ずつ、1〜4の数字10個を5組で渡してください（正解なし・複数正解の問は x）')
    return ''.join(groups)


def key_differences(a, b):
    """2人が読んだ正解の列で、食い違う問番号の一覧"""
    return [i + 1 for i, (x, y) in enumerate(zip(a, b)) if x != y]


def parse_round(name):
    """'R4' → (4, None)、'R2-10' → (2, '10')"""
    m = re.fullmatch(r'R([1-9]\d?)(?:-(10|12))?', name)
    if not m:
        raise ir.ParseError(f'回の名前「{name}」が読めません（例 R4、R2-10）')
    era, month = int(m.group(1)), m.group(2)
    if era in TWO_ROUND_ERAS and not month:
        raise ir.ParseError(f'令和{era}年度は10月と12月の2回あります。R{era}-10 か R{era}-12 で指定してください')
    if era not in TWO_ROUND_ERAS and month:
        raise ir.ParseError(f'令和{era}年度は試験が1回だけです。R{era} で指定してください')
    return era, month


def check_cover_month(cover, month):
    """12月の回の表紙には「（12月27日）」のような日付がある。回の名前（10月／12月）と表紙が合わなければ止める"""
    text = ''.join(ir.squash(ln) for ln in cover)
    has12 = '12月' in text
    if month == '12' and not has12:
        raise ir.ParseError('12月の回として指定されましたが、表紙に「12月」の日付がありません。回の名前か書き起こしを確かめてください')
    if month != '12' and has12:
        raise ir.ParseError('表紙に「12月」の日付があります。12月の回（R〇-12）ではありませんか')


def read_transcript(text):
    """書き起こしの文字列 → (表紙の行, [{'no': ページ番号, 'lines': [...]}])"""
    cover, pages, cur = [], [], None
    seen_cover = False
    for n, raw in enumerate(text.splitlines(), 1):
        if raw.strip() == '#表紙':
            if seen_cover:
                raise ir.ParseError(f'{n}行目: 「#表紙」が2回あります')
            seen_cover, cur = True, cover
            continue
        m = re.fullmatch(r'#ページ\s*(\d+)\s*', raw)
        if m:
            no = int(m.group(1))
            if any(p['no'] == no for p in pages):
                raise ir.ParseError(f'{n}行目: 「#ページ {no}」が2回あります')
            pages.append({'no': no, 'lines': []})
            cur = pages[-1]['lines']
            continue
        if raw.startswith('#'):
            raise ir.ParseError(f'{n}行目: 「{raw[:20]}」は読めない印です（使えるのは「#表紙」と「#ページ 3」の形だけ）')
        if cur is None:
            if raw.strip():
                raise ir.ParseError(f'{n}行目: 「#表紙」より前に文があります')
            continue
        cur.append(raw)
    if not seen_cover or not any(ln.strip() for ln in cover):
        raise ir.ParseError('「#表紙」と表紙の文言がありません（年度と法令の基準日の確かめに使います）')
    if not pages:
        raise ir.ParseError('「#ページ N」の印が1つもありません')
    return cover, pages


def build(text, round_name, key, today=None):
    """書き起こし＋正解（50文字）→ (questions, warnings, base_date)"""
    era, month = parse_round(round_name)
    cover, tpages = read_transcript(text)
    if era in TWO_ROUND_ERAS:
        check_cover_month(cover, month)
    pages = [{'lines': cover, 'boxes': [], 'images': 0, 'drawings': 0}]
    pages += [{'lines': p['lines'], 'boxes': [], 'images': 0, 'drawings': 0} for p in tpages]
    pages.append({'lines': [], 'boxes': [], 'images': 0, 'drawings': 0})  # 正解表の代わり
    answers = {i + 1: (UNDECIDED if c == 'x' else c) for i, c in enumerate(key)}
    original = ir.find_answers
    ir.find_answers = lambda pg: (answers, len(pg) - 1)
    try:
        questions, warnings, base = ir.parse_pages(pages, 2018 + era, today)
    finally:
        ir.find_answers = original
    strict = [w for w in warnings if any(s in w for s in STRICT_WARNINGS)]
    if strict:
        raise ir.ParseError('書き起こしの形に誤りがあります（見出し・選択肢の行頭を確かめてください）: ' + ' ／ '.join(strict))
    leftover = [q['id'][-2:] for q in questions
                if LEFTOVER_HEADER_RE.search(q['stem'] + ''.join(c['text'] for c in q['choices']))]
    if leftover:
        raise ir.ParseError(f'問{"、問".join(str(int(n)) for n in leftover)}の本文に別の問の見出しらしいもの（「[問 2]」など）が混ざっています')
    expected = [i + 1 for i, c in enumerate(key) if c != 'x']
    got = sorted(int(q['id'][-2:]) for q in questions)
    if got != expected:
        raise ir.ParseError(f'取り込めた問題が正解表と合いません（足りない問: {sorted(set(expected) - set(got))}）')
    for q in questions:
        num = int(q['id'][-2:])
        if month:  # 同じ年度に2回ある回は id・タグ・出典で分ける
            q['id'] = re.sub(r'p(\d{4})(\d{2})$', lambda x: f'p{x.group(1)}{month}{x.group(2)}', q['id'])
            q['tags'].insert(1, f'{month}月')
            q['source']['ref'] = f'令和{era}年度（{month}月）宅建試験 問{num}'
        body = q['stem'] + ''.join(c['text'] for c in q['choices'])
        if '〔図' in body or '〔表' in body:
            warnings.append(f'問{num}: 図・表を言葉で書き起こしています。確認してください')
    return questions, warnings, base


def main(argv=None):
    ap = argparse.ArgumentParser(description='画像PDFの書き起こし＋正解表 → アプリで取り込める JSON')
    ap.add_argument('transcript')
    ap.add_argument('round', help='R4、R2-10 など')
    ap.add_argument('--key-a', nargs=5, required=True, help='1人目が読んだ正解（10問×5組）')
    ap.add_argument('--key-b', nargs=5, required=True, help='2人目が別に読んだ正解（10問×5組）')
    ap.add_argument('--out', required=True)
    args = ap.parse_args(argv)
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    try:
        a, b = parse_key(args.key_a), parse_key(args.key_b)
        diff = key_differences(a, b)
        if diff:
            raise ir.ParseError(f'2人が読んだ正解が食い違っています（問{"、問".join(map(str, diff))}）。正解表の画像を見直してください')
        with open(args.transcript, encoding='utf-8') as f:
            questions, warnings, base = build(f.read(), args.round, a)
    except ir.ParseError as e:
        print(f'エラー: {e}', file=sys.stderr)
        print('止めました。何も出力していません。', file=sys.stderr)
        return 1
    out = {'schemaVersion': 1, 'exam': ir.EXAM_ID, 'revision': 1, 'updated': datetime.date.today().isoformat(), 'questions': questions}
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
        f.write('\n')
    by_type, by_subject = ir.summarize(questions)
    print(f'{args.out} に {len(questions)} 問を書き出しました（基準日 {base or "不明"}）')
    print('  型別: ' + '、'.join(f'{k} {v}' for k, v in sorted(by_type.items())))
    print('  科目別: ' + '、'.join(f'{k} {v}' for k, v in sorted(by_subject.items())))
    print(f'警告 {len(warnings)} 件')
    for w in warnings:
        print(f'  - {w}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
