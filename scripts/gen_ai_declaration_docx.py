# -*- coding: utf-8 -*-
"""Replicate the AI declaration as an editable docx (+ plain-text version).

Layout mirrors the school's original template PDF: centered bold title,
recipient line, every paragraph with a 2-char first-line indent, 12pt SimSun
body at 1.5 line spacing, no page-number footer. Content comes from
gen_ai_declaration.py's constants, so docx/txt/PDF stay word-identical.

Usage: python scripts/gen_ai_declaration_docx.py
Out:   ~/Desktop/声明-TDEaseNexus蛋白质组学智能数据分析系统.docx
       ~/Desktop/声明-文字版.txt
"""
import importlib.util
import os
import sys
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.oxml.ns import qn
from docx.shared import Cm, Pt

sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("decl_pdf", HERE / "gen_ai_declaration.py")
decl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(decl)

DESKTOP = Path(os.path.expanduser("~/Desktop"))
OUT_DOCX = DESKTOP / "声明-TDEaseNexus蛋白质组学智能数据分析系统.docx"
OUT_TXT = DESKTOP / "声明-文字版.txt"

TITLE = "声  明"
RECIPIENT = "中国版权保护中心："
BODY = [
    decl.PARA_1,
    decl.PARA_STRENGTH,
    decl.PARA_SECURITY,
    decl.PARA_BOUNDARY,
    *decl.ARTICLE_4,
    *decl.ARTICLE_7,
    *decl.CLOSING,
]
SIGNOFF = ["学校名称：浙江大学", "日期：2026年9月14日"]


def set_run(run, size=12, bold=False, name="宋体"):
    run.font.name = name
    run.font.size = Pt(size)
    run.font.bold = bold
    run._element.rPr.rFonts.set(qn("w:eastAsia"), name)


def add_para(doc, text, indent=True, size=12, bold=False, font="宋体"):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    pf = p.paragraph_format
    pf.line_spacing_rule = WD_LINE_SPACING.MULTIPLE
    pf.line_spacing = 1.5
    pf.space_after = Pt(0)
    if indent:
        # two Chinese chars at the given body size
        pf.first_line_indent = Pt(size * 2)
    set_run(p.add_run(text), size=size, bold=bold, name=font)
    return p


def build_docx():
    doc = Document()
    section = doc.sections[0]
    section.page_width, section.page_height = Cm(21.0), Cm(29.7)
    section.top_margin = section.bottom_margin = Cm(2.54)
    section.left_margin = section.right_margin = Cm(2.8)

    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_after = Pt(18)
    set_run(p.add_run(TITLE), size=22, bold=True, name="黑体")

    add_para(doc, RECIPIENT, indent=False)
    doc.add_paragraph()
    for text in BODY:
        add_para(doc, text)
    doc.add_paragraph()
    for line in SIGNOFF:
        add_para(doc, line, indent=False)
    doc.save(OUT_DOCX)
    print("generated", OUT_DOCX)


def build_txt():
    parts = [TITLE, "", RECIPIENT, ""]
    parts += [t + "\n" for t in BODY]
    parts += [""]
    parts += SIGNOFF
    OUT_TXT.write_text("\n".join(parts) + "\n", encoding="utf-8-sig")
    print("generated", OUT_TXT)


def verify():
    from docx import Document as D
    got = []
    for p in D(str(OUT_DOCX)).paragraphs:
        if p.text.strip():
            got.append(p.text.strip())
    expect = [TITLE, RECIPIENT] + BODY + SIGNOFF
    ok = len(got) == len(expect) and all(
        g.replace(" ", "") == e.replace(" ", "") for g, e in zip(got, expect)
    )
    print("docx/text parity:", "OK" if ok else "MISMATCH")
    assert ok


if __name__ == "__main__":
    build_docx()
    build_txt()
    verify()
