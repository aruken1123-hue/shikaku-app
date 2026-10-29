#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""RETIO（宅建試験）の過去問PDFから、アプリの設定画面で取り込める JSON を作る。

使い方（PDFは自分でダウンロードして private/ などに置く。外から来たファイルなので python -I で動かす）:
    python -I tools/import-retio.py private/R7.pdf --out private/takken-R7.json
    python -I tools/import-retio.py private/R7.pdf --year 2025 --out private/takken-R7.json

  ・--year（西暦。令和7年度なら 2025）を省くと、表紙の「令和〇年度」から決める。付けたときは表紙と食い違えば止まる。
  ・文字を取り出せるPDF（令和5〜7年度）だけが対象。画像のPDF（令和4年度以前）は文字が取れず「問題が見つかりません」になる。
    画像のPDFは tools/import-retio-ocr.py を使う（手順は docs/問題作り.md）。
  ・正解表は文字の座標（行→列）で読み、ちょうど50個読めなければ止まる（何も出力しない）。
  ・過去問は著作物（私的使用のみ）。出力は private/ に置き、公開フォルダ data/ には入れない（.gitignore 済み）。
  ・PyMuPDF（import pymupdf）が必要。パーサー本体（parse_pages）は PyMuPDF なしでも動く（テスト用）。
"""
import argparse
import datetime
import json
import os
import re
import statistics
import sys
import unicodedata

EXAM_ID = 'takken'
SOURCE_URL = 'https://www.retio.or.jp/exam/past_ques_ans/other/'

# 問番号の範囲 → 科目（宅建の出題構成）。46〜50 は登録講習修了者の5問免除の対象
SUBJECT_RANGES = [
    (1, 14, 'kenri', []),
    (15, 22, 'seigen', []),
    (23, 25, 'zei', []),
    (26, 45, 'gyouhou', []),
    (46, 50, 'zei', ['5問免除']),
]
TOTAL_QUESTIONS = 50

RUBY_RATIO = 0.6  # 本文の文字サイズの6割より小さい文字はふりがな（ルビ）として捨てる
FW = '　'     # 全角空白


class ParseError(Exception):
    """読み取りを続けられない。出力せずに止める"""


HEADER_RE = re.compile(r'^【問\s*(\d{1,2})\s*】')
OPTION_RE = re.compile('^([1-4])[ \t]*　')  # 「1 　」の形（半角数字＋全角空白）。ページ内の数字だけの行とは区別できる
ITEM_RE = re.compile('^[ア-オ][　 ]')       # 個数・組合せ問題の「ア　…」
FORM_RE = re.compile('受験番号|受験者氏名')        # 答案用紙のページ
NOTICE_RE = re.compile(r'以下[のは]?\s*[【\[]?\s*問\s*\d+')  # 「以下の【問46】から…解答しないでください」

# 問いの文（「〜どれか」「〜いくつあるか」）の中身で型を決める
QUESTION_END_RE = re.compile(r'どれか|いくつあるか|何(?:個|問|組)(?:ある|か)')
CHOICE_ASK_RE = re.compile(r'((?:最も)?(?:不適切|不適当|適切|適当|正しい|誤っている)(?:な)?もの)(?:は|が)[、]?どれか')
SINGLE_FORM_RE = re.compile(r'いくつ|何個|何問|何組|組合せ|組み合わせ|組合わせ|掲げた')
NEGATIVE_RE = re.compile(r'不適切|不適当|誤')

CJK_GAP_RE = re.compile('(?<=[぀-ヿ一-鿿]) +(?=[぀-ヿ一-鿿])')
LABEL_RE = re.compile(r'^問(\d{1,2})$')


def nfkc(s):
    return unicodedata.normalize('NFKC', s)


def squash(s):
    """判定用: NFKC にして空白をすべて除く（本文には使わない）"""
    return re.sub(r'[\s　]+', '', nfkc(s))


def is_blank(line):
    return line.replace(FW, '').strip() == ''


# ---------- PDF の読み取り（PyMuPDF が必要） ----------

def read_pdf(path):
    """PDF を読み、ページごとに {'lines': [...], 'boxes': [(x0,y0,x1,y1)...], 'images': 画像数, 'drawings': 図形数} を返す。
    ふりがな（小さい文字）は捨てる。boxes は lines と同じ並びの、各行の位置"""
    import pymupdf  # 遅く読み込む（パーサーのテストでは不要）
    doc = pymupdf.open(path)
    sizes = {}
    pages_raw = []
    for page in doc:
        blocks = [b for b in page.get_text('dict')['blocks'] if b.get('type') == 0]
        pages_raw.append((page, blocks))
        for b in blocks:
            for ln in b['lines']:
                for sp in ln['spans']:
                    key = round(sp['size'], 1)
                    sizes[key] = sizes.get(key, 0) + len(sp['text'])
    body = max(sizes, key=sizes.get) if sizes else 11.0
    pages = []
    for page, blocks in pages_raw:
        lines, boxes = [], []
        for b in blocks:
            for ln in b['lines']:
                text = ''.join(sp['text'] for sp in ln['spans'] if sp['size'] >= body * RUBY_RATIO)
                if text.strip():
                    lines.append(text)
                    boxes.append(tuple(ln['bbox']))
        pages.append({'lines': lines, 'boxes': boxes, 'images': len(page.get_images()), 'drawings': len(page.get_drawings())})
    return pages


# ---------- 表紙（年度・基準日） ----------

def era_to_year(s):
    """令和の年（「元」も）→ 西暦"""
    return 2018 + (1 if s == '元' else int(s))


def find_cover_year(pages):
    """表紙の「令和7年度」から西暦年を取る。無ければ None"""
    text = ''.join(squash(ln) for p in pages[:2] for ln in p['lines'])
    m = re.search(r'令和(元|\d+)年度', text)
    return era_to_year(m.group(1)) if m else None


def find_base_date(pages):
    """表紙の「令和7年4月1日現在施行されている規定」から基準日（YYYY-MM-DD）を取る。無ければ None"""
    text = ''.join(squash(ln) for p in pages[:2] for ln in p['lines'])
    m = re.search(r'令和(元|\d+)年(\d+)月(\d+)日現在施行', text)
    if not m:
        return None
    try:
        return datetime.date(era_to_year(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
    except ValueError:
        return None


def resolve_year(pages, year):
    """試験の西暦年を決める。--year が表紙（年度・基準日）と食い違えば止める。省かれていれば表紙から決める"""
    cover = find_cover_year(pages)
    base = find_base_date(pages)
    base_year = int(base[:4]) if base else None
    if year is not None:
        if cover is not None and cover != year:
            raise ParseError(f'--year（{year}）と表紙の年度（令和{cover - 2018}年度＝{cover}年）が食い違います。年を確かめてください')
        if base_year is not None and base_year != year:
            raise ParseError(f'--year（{year}）と表紙の法令基準日（{base}）の年が食い違います。年を確かめてください')
        return year
    if cover is not None:
        if base_year is not None and base_year != cover:
            raise ParseError(f'表紙の年度（{cover}年）と法令基準日（{base}）の年が食い違います。--year で指定してください')
        return cover
    if base_year is not None:
        return base_year
    raise ParseError('表紙から年度（「令和〇年度」）を読めませんでした。--year（西暦）で指定してください')


# ---------- 正解表（文字の座標で読む） ----------

def cluster(values, tol):
    """近い値をまとめて、まとまりごとの中心（昇順）を返す"""
    groups = []
    for v in sorted(values):
        if groups and v - groups[-1][-1] <= tol:
            groups[-1].append(v)
        else:
            groups.append([v])
    return [sum(g) / len(g) for g in groups]


def nearest(centers, v):
    return min(range(len(centers)), key=lambda i: abs(centers[i] - v))


def find_answer_page(pages):
    """正解表のページ（1〜4だけの短い行が40個以上あるいちばん後ろのページ）。無ければ None"""
    for idx in range(len(pages) - 1, -1, -1):
        n = sum(1 for ln in pages[idx]['lines'] if re.fullmatch(r'[1-4]', squash(ln)))
        if n >= 40:
            return idx
    return None


def read_answer_grid(page):
    """正解表の1ページを、文字の座標（行→列）で読む。戻り値 {問番号: 正解の文字列（'1'〜'4'、または「全員正解」など）}。
    ・「問1…問10」の見出しがある形は、見出しの下の欄を見出しの列で結ぶ。行ごとに見出しの数と欄の数が合わなければ止める。
    ・見出しの無い形は、上の行から順に、左の列から順に 1,2,3… とする。
    ・欄が2行に分かれていても1つの欄として読む。欄が欠けている・ちょうど50個でないときは止める。"""
    lines, boxes = page['lines'], page.get('boxes')
    if not boxes or len(boxes) != len(lines):
        raise ParseError('正解表の文字の位置を取れませんでした（座標がありません）')
    items = []
    for text, (x0, y0, x1, y1) in zip(lines, boxes):
        t = squash(text)
        if t:
            items.append({'t': t, 'cx': (x0 + x1) / 2, 'cy': (y0 + y1) / 2})
    labels = [it for it in items if LABEL_RE.match(it['t'])]
    digits = [it for it in items if re.fullmatch(r'[1-4]', it['t'])]
    if not digits:
        raise ParseError('正解表に正解の数字が見つかりません')
    rows = cluster([d['cy'] for d in digits], 6)
    cols = cluster([d['cx'] for d in digits] + [lb['cx'] for lb in labels], 14)
    pitch = statistics.median([b - a for a, b in zip(rows, rows[1:])]) if len(rows) > 1 else 60
    # 欄ごとに文字を集める（数字のほか、「全員正解」「※」や2行に分かれた欄の文字も）
    cells = {}
    for it in items:
        if LABEL_RE.match(it['t']):
            continue
        r = nearest(rows, it['cy'])
        c = nearest(cols, it['cx'])
        if abs(rows[r] - it['cy']) > pitch * 0.4 or abs(cols[c] - it['cx']) > 14:
            continue  # 表の外（見出しの文など）
        cells.setdefault((r, c), []).append(it)
    total = len(rows) * len(cols)
    for r in range(len(rows)):
        for c in range(len(cols)):
            if (r, c) not in cells:
                raise ParseError(f'正解表の{r + 1}行目{c + 1}列目の欄が空です（欄の欠け）。正解を読み取れません')
    if total != TOTAL_QUESTIONS:
        raise ParseError(f'正解表から正解を{total}個（{len(rows)}行×{len(cols)}列）読みました。{TOTAL_QUESTIONS}個ではないので止めます')
    value = {rc: ''.join(it['t'] for it in sorted(v, key=lambda it: (it['cy'], it['cx']))) for rc, v in cells.items()}
    answers = {}
    if labels:
        for r in range(len(rows)):
            lo = rows[r - 1] if r > 0 else rows[0] - pitch
            band = [lb for lb in labels if lo < lb['cy'] < rows[r]]
            if len(band) != len(cols):
                raise ParseError(f'正解表の{r + 1}行目: 問番号が{len(band)}個、正解が{len(cols)}個で一致しません。止めます')
            seen_cols = set()
            for lb in band:
                c = nearest(cols, lb['cx'])
                seen_cols.add(c)
                answers[int(LABEL_RE.match(lb['t']).group(1))] = value[(r, c)]
            if len(seen_cols) != len(cols):
                raise ParseError(f'正解表の{r + 1}行目: 問番号の位置と正解の列が合いません。止めます')
        if sorted(answers) != list(range(1, TOTAL_QUESTIONS + 1)):
            raise ParseError('正解表の問番号が 1〜50 になっていません。止めます')
    else:
        for r in range(len(rows)):
            for c in range(len(cols)):
                answers[r * len(cols) + c + 1] = value[(r, c)]
    return answers


def find_answers(pages):
    """正解表を読む。戻り値 (answers, 正解表のページ番号)。見つからない・読めないときは ParseError"""
    idx = find_answer_page(pages)
    if idx is None:
        raise ParseError('正解表のページが見つかりません')
    return read_answer_grid(pages[idx]), idx


# ---------- 問題文の取り出し ----------

def strip_notice(lines):
    """「以下の【問46】から【問50】までについては…解答しないでください。」の注意書きを、その文だけ捨てる（次の見出しは残す）"""
    out = []
    i = 0
    while i < len(lines):
        ln = lines[i]
        norm = nfkc(ln)
        m = NOTICE_RE.search(norm)
        if not m:
            out.append(ln)
            i += 1
            continue
        # 文の頭から始まらないときは、その前までを残す（本文は元の行から。長さが変わる文字があれば正規化後の文字で代える）
        prefix = ln[:m.start()] if len(norm) == len(ln) else norm[:m.start()]
        if prefix.strip():
            out.append(prefix)
        end = i
        for j in range(i, min(i + 4, len(lines))):
            if '解答しないで' in nfkc(lines[j]):
                end = j
                break
        i = end + 1
    return out


def clean_pages(pages, end_idx):
    """問題のあるページ（表紙の次〜正解表の前）の行を、(行, ページ番号) の並びにする。
    ページ番号・空行・答案用紙のページ・注意書きを除く。見出しも選択肢も無いページでも、
    直前に問題があれば続きとして残す（問題文が1ページを超える場合）"""
    out = []
    seen_question = False
    for idx in range(1, end_idx):
        lines = [ln for ln in pages[idx]['lines'] if not is_blank(ln)]
        has_q = any(HEADER_RE.match(nfkc(ln).strip()) or OPTION_RE.match(ln) for ln in lines)
        if not has_q and (FORM_RE.search(''.join(squash(ln) for ln in lines)) or not seen_question):
            continue  # 答案用紙のページ、または最初の問題より前のページ
        seen_question = seen_question or has_q
        if lines and re.fullmatch(r'\d{1,3}', nfkc(lines[0]).strip()):
            lines = lines[1:]  # ページ番号
        lines = strip_notice(lines)
        out.extend((ln, idx) for ln in lines)
    return out


def join_lines(lines, items=False):
    """行を、日本語なので空白なしでつなぐ。items=True なら「ア　…」の行は改行して始める"""
    text = ''
    for ln in lines:
        s = ln.strip().strip(FW).strip()
        if not s:
            continue
        if items and text and ITEM_RE.match(s):
            text += '\n' + s
        else:
            text += s
    # PDF の都合で漢字・かなの間に入った半角空白を除く（「4,000 万円」のように数字のあとの空白は残す）
    return CJK_GAP_RE.sub('', text)


def split_questions(cleaned):
    """行の並びを問ごとに分け、{問番号: {'stem': 文, 'options': [文...], 'pages': {ページ番号}}} と、見出しが重複した問番号を返す。
    本文は元の行のまま使う（NFKC は見出し・選択肢番号の判定にだけ使う）"""
    blocks = []
    for ln, pg in cleaned:
        m = HEADER_RE.match(nfkc(ln).strip())
        if m:
            blocks.append({'num': int(m.group(1)), 'lines': [], 'pages': {pg}})
            rest = ln.split('】', 1)[1] if '】' in ln else ''
            if rest.strip():
                blocks[-1]['lines'].append((rest, pg))
        elif blocks:
            blocks[-1]['lines'].append((ln, pg))
            blocks[-1]['pages'].add(pg)
    result = {}
    dups = []
    for b in blocks:
        stem_lines, options = [], []
        for ln, _pg in b['lines']:
            m = OPTION_RE.match(ln)
            if m and int(m.group(1)) == len(options) + 1:
                options.append([re.sub('^[1-4][ \t]*　+', '', ln, count=1)])
            elif options:
                options[-1].append(ln)
            else:
                stem_lines.append(ln)
        q = {'stem': join_lines(stem_lines, items=True), 'options': [join_lines(o) for o in options], 'pages': b['pages']}
        if b['num'] in result:
            dups.append(b['num'])
        else:
            result[b['num']] = q
    return result, dups


def ask_sentence(flat):
    """問題文のうち、問いの文（「…どれか」「…いくつあるか」を含む文）を返す。無ければ None。
    括弧の中の「。」（「…という。）」）では文を切らない"""
    m = QUESTION_END_RE.search(flat)
    if not m:
        return None
    idx = flat.rfind('。', 0, m.start())
    while idx >= 0 and flat[idx + 1:idx + 2] in ('）', '」', ')'):
        idx = flat.rfind('。', 0, idx)
    return flat[idx + 1:m.end()]


def classify(stem):
    """問いの文の形から型を決める。戻り値 (型, ask, pick, 理由)
      ('choice', '最も不適当なもの', False, '')  … 「〜なものはどれか」
      ('single', None, None, '個数・組合せ')      … 「いくつあるか」「組合せ」「全て掲げたもの」
      ('single', None, None, '問い方を判定できない') … 上のどちらでもない"""
    sent = ask_sentence(stem.replace('\n', ''))
    if sent is None:
        return 'single', None, None, '問い方を判定できない'
    if SINGLE_FORM_RE.search(sent):
        return 'single', None, None, '個数・組合せ'
    m = CHOICE_ASK_RE.search(sent)
    if m:
        ask = m.group(1)
        return 'choice', ask, not NEGATIVE_RE.search(ask), ''
    return 'single', None, None, '問い方を判定できない'


def subject_of(num):
    for lo, hi, subj, tags in SUBJECT_RANGES:
        if lo <= num <= hi:
            return subj, list(tags)
    return None, []


def parse_pages(pages, year=None, today=None):
    """ページの行から問題の一覧を作る（PyMuPDF 不要）。戻り値 (questions, warnings, base_date)。
    読み取りを続けられないとき（年の食い違い・正解表が読めない）は ParseError"""
    today = today or datetime.date.today().isoformat()
    year = resolve_year(pages, year)
    warnings = []
    base_date = find_base_date(pages)
    if not base_date:
        warnings.append('表紙から法令の基準日（「令和〇年〇月〇日現在施行」）を読めませんでした。lawAsOf は付けていません')
    answers, ans_idx = find_answers(pages)
    cleaned = clean_pages(pages, ans_idx)
    found, dups = split_questions(cleaned)
    for n in dups:
        warnings.append(f'問{n}: 見出しが2回あります（最初のものを使いました）')
    draw_counts = [pages[i]['drawings'] for i in range(1, ans_idx)]
    baseline = statistics.median(draw_counts) if draw_counts else 0
    era = year - 2018
    questions = []
    for num in range(1, TOTAL_QUESTIONS + 1):
        subj, extra_tags = subject_of(num)
        if num not in found:
            warnings.append(f'問{num}: 問題が見つかりませんでした（PDFから文字を取れていない可能性）')
            continue
        q = found[num]
        label = f'問{num}'
        figure = [i for i in q['pages'] if pages[i]['images'] > 0 or pages[i]['drawings'] > baseline + 8]
        if figure:
            warnings.append(f'{label}: 図・表がある可能性があります（ページ{sorted(i + 1 for i in figure)}に画像または図形）。本文だけでは足りないかもしれません。入れましたが確認してください')
        if not q['stem']:
            warnings.append(f'{label}: 問題文が空です。外しました')
            continue
        if len(q['options']) != 4 or not all(q['options']):
            warnings.append(f'{label}: 選択肢を4つ取れませんでした（{len(q["options"])}個）。外しました')
            continue
        ans = answers.get(num)
        if ans is None:
            warnings.append(f'{label}: 正解表から正解を読めませんでした。外しました')
            continue
        if not re.fullmatch(r'[1-4]', ans):
            warnings.append(f'{label}: 正解が「{ans}」で、1つに決まりません。外しました')
            continue
        answer = int(ans) - 1
        kind, ask, pick, why = classify(q['stem'])
        rec = {
            'id': f'{EXAM_ID}-{subj}-p{year}{num:02d}',
            'subject': subj,
            'tags': [f'R{era}'] + extra_tags,
            'type': kind,
            'stem': q['stem'],
        }
        if kind == 'choice':
            rec['ask'] = ask
            rec['pick'] = pick
            # 正しいものを選ぶ問題は正解の選択肢だけ ok:true、誤りを選ぶ問題はその逆
            rec['choices'] = [{'text': t, 'ok': (i == answer) == pick} for i, t in enumerate(q['options'])]
            if '最も' in ask:
                rec['noTf'] = True  # 「最も〜」は、選択肢1つずつの正誤（○×）にすると意味が変わるので、○×には出さない
        else:
            rec['choices'] = [{'text': t} for t in q['options']]
            rec['answer'] = answer
            if why == '問い方を判定できない':
                warnings.append(f'{label}: 問い方（正しいもの／誤っているもの 等）を判定できなかったため、正解番号だけを持つ single 型にしました')
        rec['source'] = {'kind': 'past-exam', 'ref': f'令和{era}年度 宅建試験 問{num}', 'url': SOURCE_URL}
        if base_date:
            rec['lawAsOf'] = base_date
        rec['reviewed'] = False
        rec['status'] = 'active'
        rec['revision'] = 1
        rec['updated'] = today
        questions.append(rec)
    return questions, warnings, base_date


def summarize(questions):
    by_type, by_subject = {}, {}
    for q in questions:
        by_type[q['type']] = by_type.get(q['type'], 0) + 1
        by_subject[q['subject']] = by_subject.get(q['subject'], 0) + 1
    return by_type, by_subject


def main(argv=None):
    ap = argparse.ArgumentParser(description='RETIO の過去問PDF → アプリで取り込める JSON')
    ap.add_argument('pdf', help='過去問のPDF')
    ap.add_argument('--year', type=int, default=None, help='試験の西暦年（令和7年度なら 2025）。省くと表紙の「令和〇年度」から決める')
    ap.add_argument('--out', required=True, help='出力するJSON（例 private/takken-R7.json）')
    args = ap.parse_args(argv)
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    if not os.path.isfile(args.pdf):
        print(f'PDF が見つかりません: {args.pdf}', file=sys.stderr)
        return 2
    try:
        pages = read_pdf(args.pdf)
    except ImportError:
        print('PyMuPDF（import pymupdf）が入っていません。pip install pymupdf で入れてください。', file=sys.stderr)
        return 2
    except Exception as e:  # 壊れたPDFなど
        print(f'PDF を読めませんでした: {e}', file=sys.stderr)
        return 2
    try:
        questions, warnings, base_date = parse_pages(pages, args.year)
    except ParseError as e:
        print(f'エラー: {e}', file=sys.stderr)
        print('止めました。何も出力していません。', file=sys.stderr)
        return 1
    if not questions:
        print('問題を1つも取り出せませんでした。')
        for w in warnings:
            print(f'  警告: {w}')
        return 1
    out = {
        'schemaVersion': 1, 'exam': EXAM_ID, 'revision': 1, 'updated': datetime.date.today().isoformat(),
        'questions': questions,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
        f.write('\n')
    by_type, by_subject = summarize(questions)
    print(f'{args.out} に {len(questions)} 問を書き出しました（基準日 {base_date or "不明"}）')
    print('  型別: ' + '、'.join(f'{k} {v}' for k, v in sorted(by_type.items())))
    print('  科目別: ' + '、'.join(f'{k} {v}' for k, v in sorted(by_subject.items())))
    no_tf = [q['id'][-2:] for q in questions if q.get('noTf')]
    print(f'  ○×に出さない（noTf）: {len(no_tf)} 問' + (f'（問{"、問".join(str(int(n)) for n in no_tf)}）' if no_tf else ''))
    print(f'警告 {len(warnings)} 件')
    for w in warnings:
        print(f'  - {w}')
    print('次は、アプリの設定 → 「自分の問題の取り込み」でこのファイルを選んでください。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
