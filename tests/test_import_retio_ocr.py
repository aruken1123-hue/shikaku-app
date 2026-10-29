# -*- coding: utf-8 -*-
"""tools/import-retio-ocr.py（画像PDFの書き起こし → JSON）の単体テスト。合成した小さな書き起こしで確かめる。
実行: python -I tests/test_import_retio_ocr.py   （npm test からは tests/python.test.mjs が呼ぶ）"""
import contextlib
import importlib.util
import io
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('import_retio_ocr', os.path.join(HERE, '..', 'tools', 'import-retio-ocr.py'))
ocr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ocr)
ParseError = ocr.ir.ParseError

SP = '　'
KEY = ['1234123412', '2341234123', '3412341234', '4123412341', '1234123x12']  # 作り物の正解表（問48が x）


def transcript(era='4', month_line=None, nums=range(1, 51), heading=lambda n: f'【問 {n}】', per_page=10):
    """表紙＋問1〜50（1ページ10問）の書き起こし。month_line は12月の回の表紙の日付（例 '（12月27日）'）"""
    lines = ['#表紙', f'令和{era}年度'] + ([month_line] if month_line else []) + ['問題', f'令和{era}年4月1日現在施行されている規定に基づいて出題されています。']
    for k, n in enumerate(nums):
        if k % per_page == 0:
            lines.append(f'#ページ {3 + k // per_page}')
        lines.append(f'{heading(n)}{SP}問{n}の記述のうち、民法の規定によれば、正しいものはどれか。')
        lines += [f'{i}{SP}問{n}の選択肢{i}。' for i in range(1, 5)]
    return '\n'.join(lines) + '\n'


def build(text, round_name='R4', key=KEY):
    return ocr.build(text, round_name, ocr.parse_key(key), today='2026-10-29')


class KeyTest(unittest.TestCase):
    def test_parse_key_needs_five_groups_of_ten(self):
        self.assertEqual(len(ocr.parse_key(KEY)), 50)
        with self.assertRaises(ParseError):
            ocr.parse_key([''.join(KEY)])  # 区切りなしの50桁は受け付けない
        with self.assertRaises(ParseError):
            ocr.parse_key(KEY[:4] + ['123412x31'])  # 9桁
        with self.assertRaises(ParseError):
            ocr.parse_key(KEY[:4] + ['1234125x12'])  # 1〜4とx以外

    def test_key_differences(self):
        a = ocr.parse_key(KEY)
        b = ocr.parse_key(KEY[:4] + ['123412x312'])
        self.assertEqual(ocr.key_differences(a, b), [47, 48])
        self.assertEqual(ocr.key_differences(a, a), [])

    def test_main_stops_when_keys_differ(self):
        with tempfile.TemporaryDirectory() as d:
            tr = os.path.join(d, 't.txt')
            with open(tr, 'w', encoding='utf-8') as f:
                f.write(transcript('4'))
            out = os.path.join(d, 'out.json')
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                code = ocr.main([tr, 'R4', '--key-a', *KEY, '--key-b', *KEY[:4], '123412x312', '--out', out])
                self.assertEqual(code, 1)
                self.assertFalse(os.path.exists(out))
                self.assertEqual(ocr.main([tr, 'R4', '--key-a', *KEY, '--key-b', *KEY, '--out', out]), 0)
            self.assertTrue(os.path.exists(out))


class RoundTest(unittest.TestCase):
    def test_round_names(self):
        self.assertEqual(ocr.parse_round('R4'), (4, None))
        self.assertEqual(ocr.parse_round('R2-12'), (2, '12'))
        for bad in ('R2', 'R3', 'R4-10', 'R0', 'R5-12', '4'):
            with self.assertRaises(ParseError, msg=bad):
                ocr.parse_round(bad)

    def test_month_must_match_cover(self):
        build(transcript('2', '（12月27日）'), 'R2-12')
        build(transcript('2'), 'R2-10')
        with self.assertRaises(ParseError):
            build(transcript('2', '（12月27日）'), 'R2-10')  # 12月の表紙を10月として
        with self.assertRaises(ParseError):
            build(transcript('2'), 'R2-12')  # 10月の表紙を12月として

    def test_year_on_cover_must_match_round(self):
        with self.assertRaises(ParseError):
            build(transcript('4'), 'R2-10')


class BuildTest(unittest.TestCase):
    def test_single_round_ids_and_answers(self):
        qs, warns, base = build(transcript('4'))
        self.assertEqual(base, '2022-04-01')
        self.assertEqual(len(qs), 49)
        self.assertEqual(qs[0]['id'], 'takken-kenri-p202201')
        self.assertEqual(qs[0]['tags'], ['R4'])
        self.assertEqual(qs[0]['source']['ref'], '令和4年度 宅建試験 問1')
        by_num = {int(q['id'][-2:]): q for q in qs}
        # 各組の1文字目（問1=1、問11=2、問21=3、問31=4、問41=1）と、組の最後（問10=2、問50=2）
        for num, ans in ((1, 1), (11, 2), (21, 3), (31, 4), (41, 1), (10, 2), (50, 2)):
            self.assertEqual([c['ok'] for c in by_num[num]['choices']], [i == ans for i in range(1, 5)], f'問{num}')

    def test_two_rounds_in_one_year_get_month(self):
        qs, _, _ = build(transcript('2', '（12月27日）'), 'R2-12')
        self.assertEqual(qs[0]['id'], 'takken-kenri-p20201201')
        self.assertEqual(qs[0]['source']['ref'], '令和2年度（12月）宅建試験 問1')
        by_num = {int(q['id'][-2:]): q for q in qs}
        self.assertEqual(by_num[1]['tags'], ['R2', '12月'])
        self.assertEqual(by_num[46]['tags'], ['R2', '12月', '5問免除'])
        self.assertEqual([c['ok'] for c in by_num[11]['choices']], [False, True, False, False])

    def test_undecided_answer_is_dropped_with_warning(self):
        qs, warns, _ = build(transcript('4'))
        self.assertNotIn('takken-zei-p202248', [q['id'] for q in qs])
        self.assertTrue(any(w.startswith('問48:') and '外しました' in w for w in warns))

    def test_find_answers_restored_even_on_error(self):
        before = ocr.ir.find_answers
        build(transcript('4'))
        self.assertIs(ocr.ir.find_answers, before)
        with self.assertRaises(ParseError):
            build(transcript('4', nums=range(1, 50)))
        self.assertIs(ocr.ir.find_answers, before)


class TranscriptMistakeTest(unittest.TestCase):
    """書き起こしの打ち間違いで、別の問の正解が付いたまま黙って出力されないこと"""

    def test_missing_question_stops(self):
        with self.assertRaises(ParseError):
            build(transcript('4', nums=[n for n in range(1, 51) if n != 13]))

    def test_heading_typo_stops(self):
        # 【問 13】を【問 31】と打ち間違えると、問31が2回・問13が無い
        with self.assertRaises(ParseError):
            build(transcript('4', heading=lambda n: '【問 31】' if n == 13 else f'【問 {n}】'))

    def test_halfwidth_bracket_heading_stops(self):
        # 「[問 2]」は見出しと読まれず、問1の選択肢4に混ざる
        with self.assertRaises(ParseError):
            build(transcript('4', heading=lambda n: '[問 2]' if n == 2 else f'【問 {n}】'))

    def test_bad_markers_stop(self):
        good = transcript('4')
        for bad in (good.replace('#ページ 3', '# ページ 3'),
                    good.replace('#ページ 4', '#ページ'),
                    good.replace('#ページ 4', '#ページ 3'),
                    good.replace('#表紙\n', ''),
                    good.replace('#ページ 3', '#ページ 3\n#ページ 3')):
            with self.assertRaises(ParseError):
                build(bad)

    def test_main_returns_error_and_keeps_old_file(self):
        with tempfile.TemporaryDirectory() as d:
            tr = os.path.join(d, 't.txt')
            with open(tr, 'w', encoding='utf-8') as f:
                f.write(transcript('4').replace('#ページ 3', '# ページ 3'))
            out = os.path.join(d, 'out.json')
            with open(out, 'w', encoding='utf-8') as f:
                f.write('old')
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(ocr.main([tr, 'R4', '--key-a', *KEY, '--key-b', *KEY, '--out', out]), 1)
            with open(out, encoding='utf-8') as f:
                self.assertEqual(f.read(), 'old')


if __name__ == '__main__':
    unittest.main()
