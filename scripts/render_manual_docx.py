# -*- coding: utf-8 -*-
"""Render the manual docx to per-page PNGs via Word COM, for visual review."""
import os
import sys
from pathlib import Path

import comtypes.client

sys.stdout.reconfigure(encoding="utf-8")

SRC = Path(r"C:/Users/ray/Desktop/软件著作权申请资料/正式资料/TDEaseNexus蛋白质组学智能数据分析系统_操作手册.docx")
OUT_PDF = Path(r"C:/Users/ray/Desktop/TDEase-zero/.scratch/manual-render/manual.pdf")
PAGES_DIR = OUT_PDF.parent

word = comtypes.client.CreateObject("Word.Application")
word.Visible = False
try:
    doc = word.Documents.Open(str(SRC), ReadOnly=True)
    doc.SaveAs2(str(OUT_PDF), FileFormat=17)  # wdFormatPDF
    n_pages = doc.ComputeStatistics(2)  # wdStatisticPages
    doc.Close(False)
finally:
    word.Quit()

print("pdf written, pages:", n_pages)

import pypdfium2 as pdfium

pdf = pdfium.PdfDocument(str(OUT_PDF))
for i in range(len(pdf)):
    pdf[i].render(scale=1.1).to_pil().save(PAGES_DIR / f"page-{i+1:02d}.png")
print("rendered", len(pdf), "pages to", PAGES_DIR)
