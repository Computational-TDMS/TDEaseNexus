# -*- coding: utf-8 -*-
"""Regenerate the three companion technical docs (总体设计/详细设计/测试案例)
and rename the code-excerpt docs, all under the TDEaseNexus name."""
import os
import re
import sys
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Pt

sys.stdout.reconfigure(encoding="utf-8")

MATERIALS = Path(os.path.expanduser("~/Desktop/软件著作权申请资料"))
COMPANION = MATERIALS / "配套技术文档"
FORMAL = MATERIALS / "正式资料"
NAME = "TDEaseNexus蛋白质组学智能数据分析系统"
VERSION = "V1.0"


def set_font(run, size=10.5, bold=False, name="宋体"):
    run.font.name = name
    run.font.size = Pt(size)
    run.font.bold = bold
    run._element.rPr.rFonts.set(qn("w:eastAsia"), name)


def add_header(section, title):
    p = section.header.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    set_font(p.add_run(f"{NAME}{VERSION}{title}"), size=9)


def add_page_numbers(section):
    p = section.footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run()
    fld = run._element.makeelement(qn("w:fldSimple"), {qn("w:instr"): "PAGE"})
    run._element.append(fld)
    set_font(run, size=9)


def add_table(doc, rows):
    table = doc.add_table(rows=len(rows), cols=len(rows[0]))
    table.style = "Table Grid"
    for r, row in enumerate(rows):
        for c, text in enumerate(row):
            cell = table.cell(r, c)
            set_font(cell.paragraphs[0].add_run(text), size=9.5, bold=(r == 0))
    doc.add_paragraph()


def build_doc(md_path, out_path, title):
    doc = Document()
    section = doc.sections[0]
    add_header(section, title)
    add_page_numbers(section)
    for _ in range(6):
        doc.add_paragraph()
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    set_font(p.add_run(NAME), size=22, bold=True)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    set_font(p.add_run(title), size=26, bold=True)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    set_font(p.add_run(f"版本号:{VERSION}"), size=14)
    doc.add_page_break()

    table_buf = []
    for line in md_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("|"):
            cells = [c.strip() for c in stripped.strip("|").split("|")]
            if set("".join(cells)) <= set("-: "):
                continue
            table_buf.append(cells)
            continue
        if table_buf:
            add_table(doc, table_buf)
            table_buf = []
        if not stripped:
            continue
        if stripped.startswith("# "):
            continue
        if stripped.startswith("## "):
            h = doc.add_heading(stripped[3:], level=1)
            for run in h.runs:
                set_font(run, size=14, bold=True, name="黑体")
            continue
        if stripped.startswith("### "):
            h = doc.add_heading(stripped[4:], level=2)
            for run in h.runs:
                set_font(run, size=12, bold=True, name="黑体")
            continue
        p = doc.add_paragraph()
        p.paragraph_format.first_line_indent = Pt(21)
        set_font(p.add_run(stripped))
    if table_buf:
        add_table(doc, table_buf)
    doc.save(out_path)
    print("generated", out_path)


def main():
    for title in ["总体设计", "详细设计", "测试案例"]:
        md = COMPANION / f"{NAME}-{title}.md"
        out = COMPANION / f"{NAME}-{title}.docx"
        build_doc(md, out, title)
        old = COMPANION / f"TDNexus蛋白质组学智能数据分析系统-{title}.docx"
        if old.exists():
            old.unlink()
            print("removed old", old.name)
    # rename the code-excerpt docx files and fix their internal header text
    for old in FORMAL.glob("TDNexus*代码*.docx"):
        new = FORMAL / old.name.replace("TDNexus", "TDEaseNexus")
        rename_code_doc(old, new)
        print("regenerated", new.name, "removed", old.name)


def rename_code_doc(old, new):
    import shutil
    tmp = old.with_suffix(".tmp.docx")
    shutil.copy(old, tmp)
    doc = Document(str(tmp))
    for section in doc.sections:
        for p in section.header.paragraphs:
            for run in p.runs:
                if "TDNexus" in run.text:
                    run.text = run.text.replace("TDNexus", "TDEaseNexus")
    for p in doc.paragraphs:
        for run in p.runs:
            if "TDNexus" in run.text:
                run.text = run.text.replace("TDNexus", "TDEaseNexus")
    doc.save(new)
    tmp.unlink()
    old.unlink()


if __name__ == "__main__":
    main()
