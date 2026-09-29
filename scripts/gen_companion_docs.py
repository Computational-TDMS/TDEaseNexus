import sys, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, '.agents', 'skills',
                                'software-copyright-materials', 'scripts'))
from pathlib import Path
import build_docx_from_md as b

materials = Path(os.path.expanduser('~/Desktop/软件著作权申请资料'))
outdir = materials / '配套技术文档'
name = 'TDEaseNexus蛋白质组学智能数据分析系统'
for doc in ['总体设计', '详细设计', '测试案例']:
    md = outdir / f'{name}-{doc}.md'
    out = outdir / f'{name}-{doc}.docx'
    b.build_manual_docx_python(md, out, outdir, name, 'V1.0')
    print('generated', out)
