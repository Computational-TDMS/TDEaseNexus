# -*- coding: utf-8 -*-
"""Build the software-copyright operation manual docx from the markdown draft.

Usage: python scripts/gen_copyright_manual.py
Reads   ~/Desktop/软件著作权申请资料/草稿/操作手册.md
Writes  ~/Desktop/软件著作权申请资料/正式资料/TDEaseNexus蛋白质组学智能数据分析系统_操作手册.docx

Markdown conventions understood:
  # / ##      -> document title / headings
  | a | b |   -> table (first row = header)
  (图 X-Y …)  -> embed the mapped screenshot, centered, caption below
  plain line  -> paragraph
"""
import os
import re
import sys
from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Cm, Pt

sys.stdout.reconfigure(encoding="utf-8")

MATERIALS = Path(os.path.expanduser("~/Desktop/软件著作权申请资料"))
MD_PATH = MATERIALS / "草稿" / "操作手册.md"
SHOTS = MATERIALS / "截图-v2"
OUT_PATH = MATERIALS / "正式资料" / "TDEaseNexus蛋白质组学智能数据分析系统_操作手册.docx"
SOFTWARE_NAME = "TDEaseNexus蛋白质组学智能数据分析系统"
VERSION = "V1.0"

FIGURE_FILES = {
    "6-1": "00-启动画面.png",
    "6-2": "00-欢迎页.png",
    "6-3": "01-工作区选择.png",
    "7-1": "02-工作台与文件浏览.png",
    "7-2": "07-2-命令面板.png",
    "8-1": "03-智能助手对话.png",
    "9-1": "04-权限确认.png",
    "10-1": "06-运行列表.png",
    "10-2": "06-运行管理.png",
    "11-1": "07-数据可视化.png",
    "12-1": "08-质谱原始文件浏览.png",
    "13-1": "11-知识库.png",
    "14-1": "09-后台任务与产物.png",
    "15-1": "15-1-设置-通用.png",
    "15-2": "15-2-设置-外观.png",
    "15-3": "15-3-设置-服务商.png",
    "15-4": "15-4-设置-权限.png",
    "15-5": "15-5-设置-AgentTools.png",
    "15-6": "15-6-设置-MCP.png",
    "15-7": "15-7-设置-分享.png",
    "15-8": "15-8-分享访客登录页.png",
    "15-9": "15-9-设置-统计.png",
    "15-10": "15-10-设置-关于.png",
    "11-2": "11-2-特征图.png",
    "12-2": "12-2-多序列比对.png",
}
# Per-figure printed widths. Narrower widths keep small/vertical figures from
# towering over the full-window screenshots.
FIGURE_WIDTH_CM = {
    "6-1": 12.0,   # splash window (near-square, default width would tower)
}
FIG_RE = re.compile(r"^[（(]图 (\d+-\d+) (.+)[）)]$")


def smartquotes(text):
    """Pair ASCII double quotes into Chinese curly quotes per line; Word will
    not autocorrect programmatically inserted text, and unpaired straight
    quotes render with reversed direction in 宋体."""
    out = []
    open_next = True
    for ch in text:
        if ch == '"':
            out.append("\u201c" if open_next else "\u201d")
            open_next = not open_next
        else:
            out.append(ch)
    return "".join(out)


def set_font(run, size=10.5, bold=False, name="宋体"):
    run.font.name = name
    run.font.size = Pt(size)
    run.font.bold = bold
    run._element.rPr.rFonts.set(qn("w:eastAsia"), name)


def add_header(section):
    header = section.header
    p = header.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(f"{SOFTWARE_NAME}{VERSION}操作手册")
    set_font(run, size=9)


def add_page_numbers(section):
    footer = section.footer
    p = footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run()
    fld = run._element.makeelement(qn("w:fldSimple"), {qn("w:instr"): "PAGE"})
    run._element.append(fld)
    set_font(run, size=9)


def add_cover(doc):
    for _ in range(6):
        doc.add_paragraph()
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    set_font(p.add_run(SOFTWARE_NAME), size=22, bold=True)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    set_font(p.add_run("操 作 手 册"), size=26, bold=True)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    set_font(p.add_run(f"版本号:{VERSION}"), size=14)
    doc.add_page_break()


def add_table(doc, rows):
    table = doc.add_table(rows=len(rows), cols=len(rows[0]))
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    for r, row in enumerate(rows):
        # keep each row in one piece: a row sliced across pages reads as garbage
        tr = table.rows[r]._tr
        trPr = tr.get_or_add_trPr()
        trPr.append(tr.makeelement(qn("w:cantSplit"), {}))
        for c, text in enumerate(row):
            cell = table.cell(r, c)
            cell.paragraphs[0].alignment = (
                WD_ALIGN_PARAGRAPH.CENTER if r == 0 else WD_ALIGN_PARAGRAPH.LEFT
            )
            set_font(cell.paragraphs[0].add_run(smartquotes(text)), size=10, bold=(r == 0))
    doc.add_paragraph()


def add_figure(doc, fig_id, caption):
    fname = FIGURE_FILES[fig_id]
    path = SHOTS / fname
    if not path.exists():
        raise SystemExit(f"missing screenshot: {path}")
    # Picture and caption share ONE paragraph with keepLines: Word may ignore
    # keepNext around tall inline images, but it never splits a keepLines
    # paragraph, so the pair cannot land on different pages.
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.keep_together = True
    p.add_run().add_picture(str(path), width=Cm(FIGURE_WIDTH_CM.get(fig_id, 14.5)))
    p.add_run().add_break()
    set_font(p.add_run(f"图 {fig_id} {caption}"), size=9, bold=True)


def build():
    doc = Document()
    section = doc.sections[0]
    add_header(section)
    add_page_numbers(section)
    add_cover(doc)

    lines = MD_PATH.read_text(encoding="utf-8").splitlines()
    table_buf = []
    for line in lines:
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
            continue  # cover already carries the title
        if stripped.startswith("## "):
            h = doc.add_heading(stripped[3:], level=1)
            for run in h.runs:
                set_font(run, size=14, bold=True, name="黑体")
            continue
        m = FIG_RE.match(stripped)
        if m:
            add_figure(doc, m.group(1), smartquotes(m.group(2)))
            continue
        p = doc.add_paragraph()
        p.paragraph_format.first_line_indent = Pt(21)
        set_font(p.add_run(smartquotes(stripped)))
    if table_buf:
        add_table(doc, table_buf)

    doc.save(OUT_PATH)
    print("generated", OUT_PATH)


if __name__ == "__main__":
    build()
