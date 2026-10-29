# -*- coding: utf-8 -*-
"""tools/import-retio.py のパーサーの単体テスト（合成した小さなテキストで確かめる。PDFは使わない）。
実行: python -I tests/test_import_retio.py   （npm test からは tests/python.test.mjs が呼ぶ）"""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('import_retio', os.path.join(HERE, '..', 'tools', 'import-retio.py'))
ir = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ir)

SP = '　'  # 全角空白


def page(lines, images=0, drawings=30, boxes=None):
    p = {'lines': lines, 'images': images, 'drawings': drawings}
    if boxes is not None:
        p['boxes'] = boxes
    return p


def cover(era='7', date_line=None, with_year=True):
    date_line = date_line or f'令和{era} 年4 月1 日現在施行されている規定に基づいて'
    lines = ([f'令和{era} 年度'] if with_year else []) + ['問', '題', '（注意事項）', '3 適用法令', '　問題の中の法令に関する部分は、', date_line, '出題されています。']
    return page(lines)


def q_lines(num, stem, options):
    """1問分の行。選択肢の行頭は「1 　…」（半角数字＋半角空白＋全角空白）"""
    head = f'【問{SP}{num} 】 ' if num < 10 else f'【問{SP}{num}】 '
    return [head] + stem + [f'{i} {SP}{text}' for i, text in enumerate(options, 1)]


# ---------- 正解表のページ（文字の座標つき） ----------

COL_X = [80 + 48 * c for c in range(10)]   # 欄の左端
ROW_Y = [240 + 82 * r for r in range(5)]   # 欄の上端


def grid_page(answers, labelled=True, drop=(), split=(), extra_label_row=None):
    """10列×5行の正解表。labelled なら各行の上に「問N」の見出し行を置く。
    drop: 欄ごと無い問番号／split: 値を2行に分けて置く問番号（「全員」「正解」など）"""
    lines, boxes = [], []

    def add(text, x, y, w=10, h=12):
        lines.append(text)
        boxes.append((x, y, x + w, y + h))

    add('◆試験問題の正解番号', 65, 177, 120)  # 見出し（表の外）
    for n in range(1, 51):
        r, c = divmod(n - 1, 10)
        if labelled and (extra_label_row is None or (r, c) != extra_label_row):
            add(f'問{SP}{n}' if n < 10 else f'問{n}', COL_X[c] - 12, ROW_Y[r] - 37, 24)
        if n in drop:
            continue
        v = str(answers[n])
        if n in split:
            half = len(v) // 2
            add(v[:half], COL_X[c], ROW_Y[r] - 6, 20)
            add(v[half:], COL_X[c], ROW_Y[r] + 8, 20)
        else:
            add(v, COL_X[c], ROW_Y[r])
    return page(lines, boxes=boxes)


def make_doc(overrides=None, answers=None, base_cover=None, answer_page=None, labelled=True):
    overrides = overrides or {}
    answers = answers or {n: (n % 4) + 1 for n in range(1, 51)}
    pages = [base_cover or cover()]
    qpages = []
    for n in range(1, 51):
        if n in overrides:
            qpages.append(overrides[n])
        else:
            qpages.append(q_lines(n, [f'問題{n}に関する次の記述のうち、民法の規定によれば、正しいものはどれか。'],
                                  [f'選択肢{n}-{k}である。' for k in range(1, 5)]))
    for i in range(0, 50, 5):  # 5問ずつ1ページ。ページの先頭にはページ番号の行
        pages.append(page([f'{i // 5 + 1}'] + [ln for q in qpages[i:i + 5] for ln in q]))
    pages.append(answer_page or grid_page(answers, labelled=labelled))
    return pages, answers


class TestYear(unittest.TestCase):
    def test_cover_year_and_base_date(self):
        self.assertEqual(ir.find_base_date([cover()]), '2025-04-01')
        self.assertEqual(ir.find_cover_year([cover()]), 2025)
        self.assertEqual(ir.find_cover_year([page(['令和 6 年 度', '問題'])]), 2024)
        self.assertEqual(ir.find_base_date([page(['令和 6 年 度']), page(['令和6年4月1日現在施行され'])]), '2024-04-01')
        self.assertIsNone(ir.find_base_date([page(['基準日の記載なし'])]))
        self.assertIsNone(ir.find_cover_year([page(['年度の記載なし'])]))

    def test_gannen(self):
        c = cover(era='元')
        self.assertEqual(ir.find_cover_year([c]), 2019)
        self.assertEqual(ir.find_base_date([c]), '2019-04-01')
        self.assertEqual(ir.resolve_year([c], None), 2019)

    def test_resolve_year(self):
        self.assertEqual(ir.resolve_year([cover()], None), 2025)   # 省くと表紙から
        self.assertEqual(ir.resolve_year([cover()], 2025), 2025)
        with self.assertRaisesRegex(ir.ParseError, '食い違'):
            ir.resolve_year([cover()], 2024)                       # --year が表紙と違う
        # 年度は無く基準日だけある表紙
        only_base = cover(with_year=False)
        self.assertEqual(ir.resolve_year([only_base], None), 2025)
        with self.assertRaisesRegex(ir.ParseError, '基準日'):
            ir.resolve_year([only_base], 2023)
        # 表紙の年度と基準日の年が食い違う
        odd = page(['令和7 年度', '令和6 年4 月1 日現在施行されている規定'])
        with self.assertRaisesRegex(ir.ParseError, '食い違'):
            ir.resolve_year([odd], None)
        # どちらも読めない
        with self.assertRaisesRegex(ir.ParseError, '--year'):
            ir.resolve_year([page(['何もない'])], None)
        self.assertEqual(ir.resolve_year([page(['何もない'])], 2025), 2025)  # 指定があれば表紙が読めなくても進む

    def test_year_mismatch_stops_parse(self):
        pages, _ = make_doc()
        with self.assertRaises(ir.ParseError):
            ir.parse_pages(pages, 2024)


class TestAnswerGrid(unittest.TestCase):
    def setUp(self):
        self.answers = {n: (n * 7) % 4 + 1 for n in range(1, 51)}

    def test_labelled_and_plain(self):
        for labelled in (True, False):
            got = ir.read_answer_grid(grid_page(self.answers, labelled=labelled))
            self.assertEqual({n: int(v) for n, v in got.items()}, self.answers, f'labelled={labelled}')

    def test_order_comes_from_coordinates_not_text_order(self):
        # 文字が出てくる順をぐちゃぐちゃにしても、位置で読む
        p = grid_page(self.answers, labelled=False)
        order = list(range(len(p['lines'])))[::-1]
        shuffled = page([p['lines'][i] for i in order], boxes=[p['boxes'][i] for i in order])
        got = ir.read_answer_grid(shuffled)
        self.assertEqual({n: int(v) for n, v in got.items()}, self.answers)

    def test_fullwidth_digit_and_special_cell(self):
        answers = dict(self.answers)
        answers[50] = '全員正解'
        answers[3] = '１'
        got = ir.read_answer_grid(grid_page(answers))
        self.assertEqual(got[50], '全員正解')
        self.assertEqual(got[3], '1')

    def test_cell_split_over_two_lines(self):
        answers = dict(self.answers)
        answers[17] = '全員正解'
        got = ir.read_answer_grid(grid_page(answers, split=(17,)))
        self.assertEqual(got[17], '全員正解')
        self.assertEqual(got[16], str(answers[16]))   # 隣の欄はそのまま
        got = ir.read_answer_grid(grid_page(answers, labelled=False, split=(17,)))
        self.assertEqual(got[17], '全員正解')

    def test_missing_cell_stops(self):
        for labelled in (True, False):
            with self.assertRaisesRegex(ir.ParseError, '欄が空'):
                ir.read_answer_grid(grid_page(self.answers, labelled=labelled, drop=(23,)))

    def test_not_fifty_stops(self):
        # 1行足りない（5行→4行）
        a = {n: 1 for n in range(1, 41)}
        with self.assertRaisesRegex(ir.ParseError, '50個ではない'):
            ir.read_answer_grid(grid_page({**a, **{n: 1 for n in range(41, 51)}}, drop=range(41, 51)))

    def test_label_count_mismatch_stops(self):
        with self.assertRaisesRegex(ir.ParseError, '一致しません'):
            ir.read_answer_grid(grid_page(self.answers, extra_label_row=(2, 4)))   # 3行目の見出しが1つ欠ける

    def test_no_coordinates_or_no_page(self):
        with self.assertRaisesRegex(ir.ParseError, '座標'):
            ir.read_answer_grid(page(['1', '2']))
        with self.assertRaisesRegex(ir.ParseError, '見つかりません'):
            ir.find_answers([cover()])

    def test_answer_page_detected(self):
        pages, _ = make_doc()
        _, idx = ir.find_answers(pages)
        self.assertEqual(idx, len(pages) - 1)


class TestText(unittest.TestCase):
    def test_join_lines_without_spaces(self):
        self.assertEqual(ir.join_lines(['所有者ＡがＢに甲土地を', '売却した。']), '所有者ＡがＢに甲土地を売却した。')
        self.assertEqual(ir.join_lines(['金額は4,000 万円', 'とする。']), '金額は4,000 万円とする。')  # 数字のあとの空白は残す
        self.assertEqual(ir.join_lines([f'{SP}{SP}所有 権の登記{SP}']), '所有権の登記')              # 漢字の間の空白は除く
        self.assertEqual(ir.join_lines(['次のうち', f'ア{SP}甲は乙である。', f'イ{SP}丙は丁である。'], items=True),
                         f'次のうち\nア{SP}甲は乙である。\nイ{SP}丙は丁である。')

    def test_body_keeps_original_characters(self):
        # 本文は元の行のまま（NFKC は判定にだけ使う）。全角の英字・数字・記号を変えない
        cleaned = [(f'【問{SP}1】 ＡがＢに１００万円を貸した。', 1), (f'1 {SP}Ｃは（Ａ）に㈱を売却。', 1), (f'2 {SP}い', 1), (f'3 {SP}う', 1), (f'4 {SP}え', 1)]
        found, _ = ir.split_questions(cleaned)
        self.assertEqual(found[1]['stem'], 'ＡがＢに１００万円を貸した。')
        self.assertEqual(found[1]['options'][0], 'Ｃは（Ａ）に㈱を売却。')

    def test_classify_by_question_sentence(self):
        c = lambda s: ir.classify(s)  # noqa: E731
        self.assertEqual(c('民法の規定によれば、正しいものはどれか。')[:3], ('choice', '正しいもの', True))
        self.assertEqual(c('誤っているものはどれか。なお、Ａは善意とする。')[:3], ('choice', '誤っているもの', False))
        self.assertEqual(c('次のうち、最も不適当なものはどれか。')[:3], ('choice', '最も不適当なもの', False))
        self.assertEqual(c('次のうち、最も適切なものはどれか。')[:3], ('choice', '最も適切なもの', True))
        self.assertEqual(c('次のうち、不適切なものはどれか。')[:3], ('choice', '不適切なもの', False))
        # 括弧の中の「。」で文を切らない
        self.assertEqual(c('宅地建物取引業法（以下この問において「法」という。）の規定によれば、誤っているものはどれか。')[:3], ('choice', '誤っているもの', False))
        # 問いの文に「組合せ」「いくつ」「全て掲げた」があれば single
        self.assertEqual(c('誤っているものはいくつあるか。\nア　甲\nイ　乙')[0], 'single')
        self.assertEqual(c('正しいものの組合せはどれか。')[0], 'single')
        self.assertEqual(c('アからエまでの記述のうち、正しいものを全て掲げたものはどれか。')[:2], ('single', None))
        # 問いの文以外にある語には引きずられない（なお書きの「組合せ」、前の文の「いくつ」）
        self.assertEqual(c('次の記述のうち、正しいものはどれか。なお、組合せ契約は考えないものとする。')[0], 'choice')
        self.assertEqual(c('甲は物件をいくつか所有している。次のうち、正しいものはどれか。')[0], 'choice')
        kind, _ask, _pick, why = c('法に違反しないものはどれか。')
        self.assertEqual(kind, 'single')
        self.assertIn('判定できない', why)
        self.assertEqual(c('問いの文がありません')[0], 'single')

    def test_subject_ranges(self):
        for n, subj in ((1, 'kenri'), (14, 'kenri'), (15, 'seigen'), (22, 'seigen'), (23, 'zei'), (25, 'zei'), (26, 'gyouhou'), (45, 'gyouhou')):
            self.assertEqual(ir.subject_of(n)[0], subj)
        self.assertEqual(ir.subject_of(46), ('zei', ['5問免除']))
        self.assertEqual(ir.subject_of(50), ('zei', ['5問免除']))


class TestCleanPages(unittest.TestCase):
    NOTICE = ['以下の【問46】から【問50】までについては、登録講習修了者としての受験申込みを', '受理された方は、免除となりますので、解答しないでください。']

    def texts(self, pages, end=None):
        return [ln for ln, _ in ir.clean_pages(pages, end or len(pages) - 1)]

    def test_page_number_and_form_page(self):
        pages = [
            cover(),
            page([f'{SP}{SP}', '2'] + q_lines(1, ['問題文。正しいものはどれか。'], ['あ', 'い', 'う', 'え'])),
            page(['受', '験', '番', '号', '令和7 年度問題']),  # 答案用紙のページ
            page(['1', '2', '3', '4']),
        ]
        t = self.texts(pages, 3)
        self.assertNotIn('2', t)
        self.assertFalse(any('受' == x for x in t))
        self.assertEqual(len(t), 6)  # 見出し・問題文・選択肢4つ

    def test_notice_dropped_only_that_sentence(self):
        # 注意書きのあとに次の問が続いても、その問は残る
        pages = [cover(), page(q_lines(1, ['ア。正しいものはどれか。'], ['あ', 'い', 'う', f'え。']) + self.NOTICE + q_lines(2, ['イ。正しいものはどれか。'], ['か', 'き', 'く', 'け'])),
                 page(['1'])]
        t = self.texts(pages, 2)
        self.assertFalse(any('解答しない' in x or '以下の' in x for x in t))
        self.assertIn(f'【問{SP}2 】 ', t)
        self.assertEqual(len(t), 12)

    def test_notice_glued_to_option_line(self):
        lines = q_lines(1, ['ア。正しいものはどれか。'], ['あ', 'い', 'う', 'え。以下の【問46】から【問50】までについては、解答しないでください。'])
        pages = [cover(), page(lines), page(['1'])]
        t = self.texts(pages, 2)
        self.assertEqual(t[-1], f'4 {SP}え。')
        self.assertFalse(any('解答しない' in x for x in t))

    def test_continuation_page_without_header_kept(self):
        # 問題文が次のページにまたがる（次のページには見出しも選択肢番号も無い）
        pages = [cover(), page(['1', f'【問{SP}1 】 ', '長い問題文の前半が', '続く']), page(['2', '長い問題文の後半。正しいものはどれか。']), page(['3'] + q_lines(2, ['次。'], ['a', 'b', 'c', 'd'])), page(['1'])]
        found, _ = ir.split_questions(ir.clean_pages(pages, 4))
        self.assertEqual(found[1]['stem'], '長い問題文の前半が続く長い問題文の後半。正しいものはどれか。')

    def test_pages_before_first_question_skipped(self):
        pages = [cover(), page(['注意事項のつづき', '白紙']), page(q_lines(1, ['問。'], ['a', 'b', 'c', 'd'])), page(['1'])]
        t = self.texts(pages, 3)
        self.assertEqual(t[0], f'【問{SP}1 】 ')


class TestParse(unittest.TestCase):
    def test_choice_polarity_and_ids(self):
        pages, answers = make_doc(overrides={2: q_lines(2, ['誤っているものはどれか。'], ['A', 'B', 'C', 'D'])})
        qs, warns, base = ir.parse_pages(pages, 2025, today='2026-01-01')
        self.assertEqual(base, '2025-04-01')
        self.assertEqual(len(qs), 50)
        self.assertEqual(warns, [])
        by = {q['id']: q for q in qs}
        q1 = by['takken-kenri-p202501']
        self.assertEqual((q1['type'], q1['ask'], q1['pick']), ('choice', '正しいもの', True))
        self.assertEqual([c['ok'] for c in q1['choices']], [i == answers[1] - 1 for i in range(4)])
        q2 = by['takken-kenri-p202502']
        self.assertFalse(q2['pick'])
        self.assertEqual([c['ok'] for c in q2['choices']], [i != answers[2] - 1 for i in range(4)])
        self.assertEqual(q1['tags'], ['R7'])
        self.assertEqual(q1['source'], {'kind': 'past-exam', 'ref': '令和7年度 宅建試験 問1', 'url': ir.SOURCE_URL})
        self.assertEqual(q1['lawAsOf'], '2025-04-01')
        self.assertFalse(q1['reviewed'])
        self.assertNotIn('explanation', q1)
        self.assertNotIn('noTf', q1)

    def test_year_omitted_uses_cover(self):
        pages, _ = make_doc()
        qs, _, _ = ir.parse_pages(pages)
        self.assertIn('takken-kenri-p202501', {q['id'] for q in qs})

    def test_subjects_and_tags(self):
        pages, _ = make_doc(base_cover=cover(era='6'))
        qs, _, _ = ir.parse_pages(pages, 2024)
        by = {q['id']: q for q in qs}
        for pid in ('takken-seigen-p202415', 'takken-zei-p202423', 'takken-gyouhou-p202426', 'takken-gyouhou-p202445'):
            self.assertIn(pid, by)
        self.assertEqual(by['takken-zei-p202446']['tags'], ['R6', '5問免除'])
        self.assertEqual(by['takken-zei-p202450']['tags'], ['R6', '5問免除'])
        self.assertEqual(by['takken-zei-p202424']['tags'], ['R6'])

    def test_no_tf_for_most_questions(self):
        pages, _ = make_doc(overrides={
            49: q_lines(49, ['土地に関する次の記述のうち、最も不適当なものはどれか。'], ['A', 'B', 'C', 'D']),
            3: q_lines(3, ['次の記述のうち、不適切なものはどれか。'], ['A', 'B', 'C', 'D']),
        })
        qs, _, _ = ir.parse_pages(pages, 2025)
        by = {q['id']: q for q in qs}
        self.assertTrue(by['takken-zei-p202549']['noTf'])
        self.assertEqual(by['takken-zei-p202549']['ask'], '最も不適当なもの')
        self.assertNotIn('noTf', by['takken-kenri-p202503'])
        self.assertNotIn('noTf', by['takken-kenri-p202501'])

    def test_single_for_count_questions(self):
        pages, answers = make_doc(overrides={
            3: q_lines(3, ['意思表示に関する次の記述のうち、誤っているものはいくつあるか。', f'ア{SP}甲は乙である。', f'イ{SP}丙は丁である。'], ['一つ', '二つ', '三つ', '四つ']),
        })
        qs, warns, _ = ir.parse_pages(pages, 2025)
        q3 = {q['id']: q for q in qs}['takken-kenri-p202503']
        self.assertEqual((q3['type'], q3['answer']), ('single', answers[3] - 1))
        self.assertTrue(all('ok' not in c for c in q3['choices']))
        self.assertNotIn('ask', q3)
        self.assertEqual(q3['stem'], f'意思表示に関する次の記述のうち、誤っているものはいくつあるか。\nア{SP}甲は乙である。\nイ{SP}丙は丁である。')
        self.assertEqual(warns, [])

    def test_undeterminable_goes_single_with_warning(self):
        pages, _ = make_doc(overrides={4: q_lines(4, ['法の規定に違反しないものはどれか。'], ['A', 'B', 'C', 'D'])})
        qs, warns, _ = ir.parse_pages(pages, 2025)
        self.assertEqual({q['id']: q for q in qs}['takken-kenri-p202504']['type'], 'single')
        self.assertTrue(any('問4' in w and '判定できなかった' in w for w in warns))

    def test_options_wrapped_over_lines(self):
        pages, _ = make_doc(overrides={5: [f'【問{SP}5 】 ', '甲に関する次の記述のうち、', '正しいものはどれか。', f'1 {SP}第一の選択肢は、とても長いので', '途中で改行される。',
                                           f'2 {SP}第二。', f'3 {SP}第三。', f'4 {SP}第四。']})
        qs, _, _ = ir.parse_pages(pages, 2025)
        q5 = {q['id']: q for q in qs}['takken-kenri-p202505']
        self.assertEqual(q5['choices'][0]['text'], '第一の選択肢は、とても長いので途中で改行される。')
        self.assertEqual(q5['stem'], '甲に関する次の記述のうち、正しいものはどれか。')

    def test_warnings_and_exclusions(self):
        answers = {n: (n % 4) + 1 for n in range(1, 51)}
        answers[6] = '全員正解'
        pages, _ = make_doc(overrides={8: q_lines(8, ['正しいものはどれか。'], ['A', 'B', 'C'])}, answers=answers)
        pages[2]['images'] = 1  # 問6〜10 のページに画像
        qs, warns, _ = ir.parse_pages(pages, 2025)
        ids = {q['id'] for q in qs}
        self.assertNotIn('takken-kenri-p202506', ids)  # 正解が「全員正解」
        self.assertNotIn('takken-kenri-p202508', ids)  # 選択肢が3つ
        self.assertIn('takken-kenri-p202509', ids)     # 図つきでも入れる
        text = '\n'.join(warns)
        self.assertIn('問6: 正解が「全員正解」', text)
        self.assertIn('問8: 選択肢を4つ取れませんでした（3個）', text)
        self.assertIn('問9: 図・表がある可能性', text)

    def test_special_cell_symbol_warns(self):
        answers = {n: (n % 4) + 1 for n in range(1, 51)}
        answers[12] = '※'
        pages, _ = make_doc(answers=answers)
        qs, warns, _ = ir.parse_pages(pages, 2025)
        self.assertNotIn('takken-kenri-p202512', {q['id'] for q in qs})
        self.assertTrue(any('問12: 正解が「※」' in w for w in warns))

    def test_answer_table_broken_stops_everything(self):
        answers = {n: (n % 4) + 1 for n in range(1, 51)}
        pages, _ = make_doc(answer_page=grid_page(answers, drop=(7,)))
        with self.assertRaises(ir.ParseError):
            ir.parse_pages(pages, 2025)
        pages, _ = make_doc()
        with self.assertRaisesRegex(ir.ParseError, '見つかりません'):
            ir.parse_pages(pages[:-1], 2025)

    def test_missing_question_and_missing_base_date(self):
        pages, _ = make_doc(base_cover=cover(date_line='基準日なし'), overrides={10: []})
        qs, warns, base = ir.parse_pages(pages, 2025)
        self.assertIsNone(base)
        self.assertTrue(any('基準日' in w for w in warns))
        self.assertTrue(all('lawAsOf' not in q for q in qs))
        self.assertTrue(any('問10: 問題が見つかりませんでした' in w for w in warns))
        self.assertEqual(len(qs), 49)

    def test_output_summary(self):
        pages, _ = make_doc()
        qs, _, _ = ir.parse_pages(pages, 2025)
        by_type, by_subject = ir.summarize(qs)
        self.assertEqual(sum(by_type.values()), 50)
        self.assertEqual(by_subject, {'kenri': 14, 'seigen': 8, 'zei': 8, 'gyouhou': 20})


if __name__ == '__main__':
    unittest.main(verbosity=2)
