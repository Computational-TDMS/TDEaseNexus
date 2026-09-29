import io, sys
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BASE = 'C:/Users/ray/Desktop/TDEase-zero/presentation'

def icon(name):
    return open(f'{BASE}/.icons/{name}.svg', encoding='utf-8').read().strip()

ep = {n: icon(n) for n in
      ['folder-opened','setting','fold','expand','histogram','reading','files','grid','chat-dot-round']}

# ---------- run-demo.html ----------
p = f'{BASE}/public/demos/run-demo.html'
s = open(p, encoding='utf-8').read()
rep = [
    # rail:设置
    ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 8h16M4 16h16"/><circle cx="9" cy="8" r="2"/><circle cx="15" cy="16" r="2"/></svg>',
     ep['setting']),
    # rail:密度
    ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 6h16M4 10h16M4 14h16M4 18h16"/></svg>',
     ep['fold']),
    # navtab 运行
    ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M7 21V9m5 12V4m5 17v-8"/></svg>',
     ep['histogram']),
    # navtab 知识库
    ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zm0 0a2 2 0 0 0 2 2h13"/></svg>',
     ep['reading']),
    # navtab 文件
    ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.3h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>',
     ep['files']),
]
for old, new in rep:
    assert old in s, 'run-demo missing: ' + old[:60]
    s = s.replace(old, new)
# rail 顶部加真实的工作区按钮(FolderOpened)
old_logo = '<div class="logo">TD</div>\n    <div class="gap"></div>'
new_logo = ('<div class="logo">TD</div>\n    <button class="railbtn" title="工作区">' + ep['folder-opened'] + '</button>\n    <div class="gap"></div>')
assert old_logo in s
s = s.replace(old_logo, new_logo)
open(p, 'w', encoding='utf-8').write(s)
print('run-demo icons injected')

# ---------- agent-demo.html ----------
p = f'{BASE}/public/demos/agent-demo.html'
s = open(p, encoding='utf-8').read()
rep = [
    # rail 工作台(PageHandle Grid)
    ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.3h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg></button>',
     ep['grid'] + '</button>'),
    # rail Agent(ChatDotRound)
    ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg></button>',
     ep['chat-dot-round'] + '</button>'),
    # rail 设置
    ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 8h16M4 16h16"/><circle cx="9" cy="8" r="2"/><circle cx="15" cy="16" r="2"/></svg></button>',
     ep['setting'] + '</button>'),
    # rail 密度
    ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 6h16M4 10h16M4 14h16M4 18h16"/></svg></button>',
     ep['fold'] + '</button>'),
]
for old, new in rep:
    assert old in s, 'agent-demo missing: ' + old[:60]
    s = s.replace(old, new)
# ep 图标是 1024 viewBox 实心风格,railbtn svg 的 CSS 尺寸已定,补充选择器让颜色继承(默认即 currentColor,无需改)
open(p, 'w', encoding='utf-8').write(s)
print('agent-demo icons injected')
