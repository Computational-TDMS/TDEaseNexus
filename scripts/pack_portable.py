import io, shutil, sys
from pathlib import Path
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

ROOT = Path('C:/Users/ray/Desktop/TDEase-zero')
P = ROOT / 'presentation'
STAGE = P / '_package' / 'TDEaseNexus-deck'

if STAGE.exists():
    shutil.rmtree(STAGE)
STAGE.mkdir(parents=True)

# 1) 工程本体
for item in ['slides.md', 'package.json', 'pnpm-lock.yaml', 'components', 'public', 'styles', 'README-编辑指南.md']:
    src = P / item
    dst = STAGE / item
    if src.is_dir():
        shutil.copytree(src, dst)
    else:
        shutil.copy2(src, dst)

# 2) paper 包(精选:文稿/记录/事实基准/图源/SI/文献摘录,排除 100M+ 原始数据)
paper_dst = STAGE / 'paper'
paper_dst.mkdir()
root_files = [
    'MANUSCRIPT-FINAL.md', 'MANUSCRIPT-TECHNICAL-NOTE-EN.md', 'MANUSCRIPT-TECHNICAL-NOTE-EN.docx',
    'MANUSCRIPT-TECHNICAL-NOTE-AC-FORMAT.md', 'SOFTWARE-FACTS.md', 'DATA-INDEX.md',
    'CERTIFIED-SESSIONS.md', 'PAPER-DESIGN-CONTRACT.md', 'WRITING-STYLE.md', 'README.md',
    'RECORD-CHLAMY-2026-09-07.md', 'RECORD-MOUSE-2026-09-07.md', 'RECORD-SOYBEAN-2026-09-07.md',
]
for f in root_files:
    src = ROOT / 'docs/paper' / f
    if src.exists():
        shutil.copy2(src, paper_dst / f)
        print('paper/', f)
for f in ['CASE-FACTS-2026-08-31.md', 'CLAIM-EVIDENCE-MATRIX.csv']:
    src = ROOT / 'docs/paper/results' / f
    if src.exists():
        shutil.copy2(src, paper_dst / f)
        print('paper/', f)
shutil.copy2(ROOT / 'docs/paper/SI/SUPPORTING-INFORMATION.md', paper_dst / 'SUPPORTING-INFORMATION.md')
print('paper/SUPPORTING-INFORMATION.md')
shutil.copytree(ROOT / 'docs/paper/results/figures', paper_dst / 'figures')
print('paper/figures/', len(list((paper_dst / 'figures').iterdir())), 'files')
shutil.copytree(ROOT / 'docs/paper/literature', paper_dst / 'literature')
print('paper/literature/ copied')

# 3) HTML 图表库(产品 chart-forge 产出的交互图 + 数据伴随文件)
lib = STAGE / 'html-library'
lib.mkdir()
def copy_figs(src_dir, dst_name, patterns):
    d = lib / dst_name
    d.mkdir()
    n = 0
    for f in Path(src_dir).iterdir():
        if f.is_file() and (f.suffix in {'.html', '.js', '.json', '.csv', '.tsv', '.md'} or any(f.match(p) for p in patterns)):
            shutil.copy2(f, d / f.name)
            n += 1
    print(f'html-library/{dst_name}/', n, 'files')
copy_figs(ROOT / 'data/workspace/.archive/analysis-20260905/runs/soybean-all/analysis/c6t4v4-figures', 'c6t4v4-figures',
          ['fig*.png'])
copy_figs(ROOT / 'data/workspace/.archive/analysis-20260905/runs/soybean-all/analysis/ekn-nterm-family', 'ekn-nterm-family',
          ['fig*.png', 'theory-*.json', 'fit-*.json', '*.csv', '*.tsv'])

# 4) 结构证据工具产物说明(ekn-structure.html 已在 public/demos)
print('public/demos/ekn-structure.html already bundled:', (STAGE / 'public/demos/ekn-structure.html').exists())
