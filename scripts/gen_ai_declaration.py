# -*- coding: utf-8 -*-
"""Regenerate the software-copyright AI declaration PDF.

Paragraph 1 is rewritten to the project's facts (LLM assistant integrated in
the proteomics workbench, permission-controlled; no pretraining, no domestic-
chip model adaptation). The regulation quotes (第四条/第七条) and the closing
follow the school's standard template unchanged.

Usage: python scripts/gen_ai_declaration.py
Output: ~/Desktop/声明-TDEaseNexus蛋白质组学智能数据分析系统.pdf
"""
import os
import sys
from pathlib import Path

from fpdf import FPDF

sys.stdout.reconfigure(encoding="utf-8")

OUT = Path(os.path.expanduser("~/Desktop/声明-TDEaseNexus蛋白质组学智能数据分析系统.pdf"))
FONT_SONG = "C:/Windows/Fonts/simsun.ttc"
FONT_HEI = "C:/Windows/Fonts/simhei.ttf"

PARA_1 = (
    "浙江大学申请的软件著作权，软件名称：TDEaseNexus蛋白质组学智能数据分析系统，"
    "简称：TDEaseNexus，版本号：V1.0。"
)
PARA_STRENGTH = (
    "该软件为智能体（Agent）应用：软件自身不提供生成式人工智能服务，"
    "不内置任何自有大模型，仅通过标准接口调用由使用者自行配置的第三方大语言"
    "模型服务。在此定位上，软件将生成式人工智能能力与蛋白质组学质谱数据分析"
    "深度结合：智能助手以自然语言接受分析意图，代替研究人员检索工作区数据、"
    "编写分析流程、执行分析任务并回报结论；配合工作流引擎调度、Rust 科学计算"
    "内核与十余种科学数据查看器，实现从原始质谱数据到可解释结论的全流程"
    "桌面分析。"
)
PARA_SECURITY = (
    "在数据与安全性方面：实验数据全程保存在本机；软件不主动向外部发送用户数据，"
    "任何数据外发均由使用者主动配置或发起——例如使用者自行配置的大语言模型"
    "接口调用，以及使用者主动发起的分享上传（仅上传其当次选择的内容）；软件"
    "不采集、不积累用户数据用于任何未经使用者同意的用途。智能助手设有探索"
    "（只读）与执行（可写）两种工作方式，以及逐次询问与自动放行的分级权限轴，"
    "助手发起的每一次文件写入与命令执行均须先经使用者确认，文件操作受当前"
    "工作区边界约束，命令执行权限可整体关闭；全部会话事件与运行事件实时留痕、"
    "全程可追溯；接口密钥仅保存在本机配置中并对用户脱敏显示。"
)
PARA_BOUNDARY = (
    "该软件本身不开展人工智能模型的预训练与优化训练，也不涉及将人工智能模型"
    "适配到特定人工智能芯片等底层硬件。软件所涉及的人工智能生成内容，基于"
    "人工智能的控制人或研发人员设置的技术、算法与使用者的指令而得，属于人类"
    "的智力成果，不含有侵犯知识产权的内容。"
)

ARTICLE_4 = [
    "遵守《生成式人工智能服务管理暂行办法》第四条",
    "（一）坚持社会主义核心价值观，不得生成煽动颠覆国家政权、推翻社会主义制度，"
    "危害国家安全和利益、损害国家形象，煽动分裂国家、破坏国家统一和社会稳定，"
    "宣扬恐怖主义、极端主义，宣扬民族仇恨、民族歧视，暴力、淫秽色情，以及虚假"
    "有害信息等法律、行政法规禁止的内容；",
    "（二）在算法设计、训练数据选择、模型生成和优化、提供服务过程中，采取有效"
    "措施防止产生民族、信仰、国别、地域、性别、年龄、职业、健康等歧视；",
    "（三）尊重知识产权、商业道德，保守商业秘密，不得利用算法、数据、平台等"
    "优势，实施垄断和不正当竞争行为；",
    "（四）尊重他人合法权益，不得危害他人身心健康，不得侵害他人肖像权、名誉权、"
    "荣誉权、隐私权和个人信息权益；",
    "（五）基于服务类型特点，采取有效措施，提升生成式人工智能服务的透明度，"
    "提高生成内容的准确性和可靠性。",
]

ARTICLE_7 = [
    "第七条 生成式人工智能服务提供者（以下称提供者）应当依法开展预训练、"
    "优化训练等训练数据处理活动，遵守以下规定：",
    "（一）使用具有合法来源的数据和基础模型；",
    "（二）涉及知识产权的，不得侵害他人依法享有的知识产权；",
    "（三）涉及个人信息的，应当取得个人同意或者符合法律、行政法规规定的其他"
    "情形；",
    "（四）采取有效措施提高训练数据质量，增强训练数据的真实性、准确性、"
    "客观性、多样性；",
    "（五）《中华人民共和国网络安全法》、《中华人民共和国数据安全法》、"
    "《中华人民共和国个人信息保护法》等法律、行政法规的其他有关规定和有关"
    "主管部门的相关监管要求。",
]

CLOSING = [
    "软件使用生成式人工智能服务输出的内容遵守相关法律法规。软件开发遵守"
    "《生成式人工智能服务管理暂行办法》相关规定，特此声明。",
]


class DeclarationPDF(FPDF):
    def footer(self):
        self.set_y(-15)
        self.set_font("SimSun", "", 9)
        self.cell(0, 10, f"{self.page_no()}", align="C")


def build():
    pdf = DeclarationPDF(format="A4")
    pdf.set_margins(22, 22, 22)
    pdf.set_auto_page_break(auto=True, margin=25)
    pdf.add_font("SimSun", "", FONT_SONG)
    pdf.add_font("SimHei", "", FONT_HEI)
    pdf.add_page()

    pdf.set_font("SimHei", "", 22)
    pdf.cell(0, 15, "声  明", align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)

    pdf.set_font("SimSun", "", 12)
    pdf.cell(0, 8, "中国版权保护中心：", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)

    def body(text, indent=True):
        prefix = "\u3000\u3000" if indent else ""
        pdf.set_font("SimSun", "", 12)
        pdf.multi_cell(0, 8.0, prefix + text)
        pdf.ln(1.2)

    body(PARA_1)
    body(PARA_STRENGTH)
    body(PARA_SECURITY)
    body(PARA_BOUNDARY)
    for i, para in enumerate(ARTICLE_4):
        body(para, indent=(i == 0))
    for para in ARTICLE_7:
        body(para, indent=para.startswith("第七条"))
    for para in CLOSING:
        body(para)

    pdf.ln(6)
    pdf.set_font("SimSun", "", 12)
    pdf.cell(0, 8, "学校名称：浙江大学", new_x="LMARGIN", new_y="NEXT")
    pdf.cell(0, 8, "日期：2026年9月14日", new_x="LMARGIN", new_y="NEXT")

    pdf.output(OUT)
    print("generated", OUT)


if __name__ == "__main__":
    build()
