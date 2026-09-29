import re, io, sys
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

src = open('TDEase-FrontEnd/electron/splash.html', encoding='utf-8').read()

# 1) 去 electron 依赖
a = src.replace('  const { ipcRenderer } = require("electron");\n\n', '')
print('step1 removed require:', a != src)

# 2) 替换脚本尾(错误屏 IPC 块)为循环驱动 — 注意定位 JS 注释(含 'tone'),不是同名 CSS 注释
marker = 'Error screen: same celadon tone'
i = a.find(marker)
i = a.rfind('  /*', 0, i)
print('step2 marker at', i)
assert i > 0
j = a.rindex('})();')
driver = """  /* Deck port: timer-driven stage loop */
  const SEQUENCE=[
    {step:'uv',d:1400},{step:'uv-install',d:1500},{step:'uv-sync',d:2000},
    {step:'spawn',d:1700},{step:'health',d:1400},{step:'assets',d:1100},
    {step:'db-init',d:1000},{step:'ready',d:3400}
  ];
  let seqIdx=0, t0=performance.now();
  function nextStage(){
    if(seqIdx>=SEQUENCE.length){
      stepIcon.innerHTML='';
      stepText.textContent='Starting\u2026';
      bar.style.width='4%';
      seqIdx=0; t0=performance.now();
      setTimeout(nextStage, 900);
      return;
    }
    const st=STAGE_MAP[SEQUENCE[seqIdx].step], d=SEQUENCE[seqIdx].d;
    seqIdx++;
    stepText.classList.add('fade');
    setTimeout(()=>applyStage(st), 180);
    setTimeout(nextStage, d);
  }
  setTimeout(nextStage, 900);

"""
a = a[:i] + driver + a[j:]

# 3) 移除 applyStage 内的 closing-done
b = re.sub(r"if\(st\.p===100\)\{[\s\S]*?\n\s*\}\n", "", a, count=1)
print('step3 closing-done removed:', b != a)

# 4) 去 progress 监听
c = re.sub(r"\s*// After launch[\s\S]*?splash:progress[\s\S]*?\n", "\n", b, count=1)
print('step4 progress listener removed:', c != b)

# 5) 删错误屏 DOM(注释 → <script> 之间)
es = c.find('<!-- Error screen')
ee = c.find('<script>')
print('step5 overlay', es, ee)
assert 0 < es < ee
d = c[:es] + c[ee:]
print('error-overlay refs left:', d.count('error-overlay'), '| ipc refs left:', d.count('ipcRenderer'))

open('presentation/public/demos/splash.html', 'w', encoding='utf-8').write(d)
print('written', len(d), 'bytes')
