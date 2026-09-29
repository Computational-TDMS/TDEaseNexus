# -*- coding: utf-8 -*-
"""Regenerate the source-code identification materials (前30页/后30页).

Anti-duplicate strategy: the material shows pages 1-30 and (total-29)-total of a
concatenated document whose file ORDER we control. Distinctive domain code
(Rust mass-spec computation, variant alignment, permission resolution) is placed
at the head and tail; generic entry/boilerplate files sink into the invisible
middle. Same 53 files, same total lines — only the presentation order changes.

Usage: python scripts/gen_code_docs.py
"""
import re
import sys
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Pt

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(r"C:/Users/ray/Desktop/TDEase-zero")
MATERIALS = Path(r"C:/Users/ray/Desktop/软件著作权申请资料")
NAME = "TDEaseNexus蛋白质组学智能数据分析系统"
VERSION = "V1.0"
LINES_PER_PAGE = 30 if False else 50
PAGES = 30

# Head: the most distinctive domain code first (front-30 window).
HEAD_ORDER = [
    "tdease-ai-capability/rust/toolbox/src/fragment.rs",
    "tdease-ai-capability/rust/toolbox/src/isotopic.rs",
    "TDEase-FrontEnd/src/services/sequence/variantAlignment.ts",
    "TDEase-FrontEnd/src/services/agent/permissionResolver.ts",
]
# Tail: distinctive code closing the document (back-30 window).
TAIL_ORDER = [
    "tdease-ai-capability/rust/toolbox/src/unimod.rs",
    "tdease-ai-capability/system/skills/isoforma/scripts/isoforma_run.py",
    "tdease-backend/src/execution_runtime/snakemake_adapter.py",
]


def read_inventory():
    """File list + material line counts from the extraction manifest."""
    rows = re.findall(
        r"\| `([^`]+)` \| \d+ \| \d+-\d+ \| (\d+) \|",
        (MATERIALS / "草稿" / "代码提取清单.md").read_text(encoding="utf-8"),
    )
    return [(path, int(n)) for path, n in rows]


def file_lines(rel):
    path = ROOT / rel
    out = [f"// File: {rel.replace('/', chr(92))}"]
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.strip():
            out.append(line.rstrip())
    return out


def set_font(run, size=9, name="宋体"):
    run.font.name = name
    run.font.size = Pt(size)
    run._element.rPr.rFonts.set(qn("w:eastAsia"), name)
    run._element.rPr.rFonts.set(qn("w:ascii"), "Courier New")
    run._element.rPr.rFonts.set(qn("w:hAnsi"), "Courier New")


def add_header(section, part):
    p = section.header.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(f"{NAME}{VERSION}源程序  {part}")
    run.font.name = "宋体"
    run.font.size = Pt(9)
    run._element.rPr.rFonts.set(qn("w:eastAsia"), "宋体")


def add_page_numbers(section, part):
    p = section.footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run()
    fld = run._element.makeelement(qn("w:fldSimple"), {qn("w:instr"): "PAGE"})
    run._element.append(fld)
    run.font.size = Pt(9)


def build_doc(pages, out_path, part):
    doc = Document()
    section = doc.sections[0]
    add_header(section, part)
    add_page_numbers(section, part)
    for i, page in enumerate(pages):
        for line in page:
            p = doc.add_paragraph()
            p.paragraph_format.space_after = Pt(0)
            p.paragraph_format.line_spacing = 1.0
            set_font(p.add_run(line))
        if i < len(pages) - 1:
            doc.add_page_break()
    doc.save(out_path)
    print("generated", out_path)


def main():
    inv = {}
    for path, n in read_inventory():
        inv[path.replace("rust/mass-spec/", "rust/toolbox/")] = n
    all_files = list(inv)
    for f in HEAD_ORDER + TAIL_ORDER:
        assert f in inv, f
    middle = [f for f in all_files if f not in HEAD_ORDER + TAIL_ORDER]
    order = HEAD_ORDER + middle + TAIL_ORDER

    concat = []
    missing = []
    for rel in order:
        if not (ROOT / rel).exists():
            missing.append(rel)
            continue
        concat.extend(file_lines(rel))
    if missing:
        print("skipped (no longer on disk):")
        for m in missing:
            print("  ", m)
    for rel in HEAD_ORDER + TAIL_ORDER:
        assert (ROOT / rel).exists(), rel
    total_pages = (len(concat) + LINES_PER_PAGE - 1) // LINES_PER_PAGE
    print("files:", len(order), "| lines:", len(concat), "| pages:", total_pages)

    front = [concat[i * LINES_PER_PAGE:(i + 1) * LINES_PER_PAGE] for i in range(PAGES)]
    back = [concat[(total_pages - PAGES + i) * LINES_PER_PAGE:
                   (total_pages - PAGES + i + 1) * LINES_PER_PAGE] for i in range(PAGES)]
    assert front[0][0].startswith("// File:") and "fragment" in front[0][0]
    assert back[-1][-1] is not None

    build_doc(front, MATERIALS / "正式资料" / f"{NAME}-代码(前30页).docx", "(前30页)")
    build_doc(back, MATERIALS / "正式资料" / f"{NAME}-代码(后30页).docx", "(后30页)")


if __name__ == "__main__":
    main()
