# Rust kernel `tdeasenexus-toolbox` — layered architecture

> Measured from `tdease-ai-capability/rust/` on 2026-08-28 (29 files, ~22.6k
> lines incl. tests). Contract authority: `docs/spec/RUST-MS-CONTRACT.md`.
> Render with the docu.md Markdown Viewer (HTML-embedded diagram).

<div style="width: 1280px; box-sizing: border-box; position: relative; background: #f5f9f5; padding: 20px; border-radius: 8px; border: 1px solid #c3d9c3;">
  <style scoped>
    .arch-wrapper { display: flex; gap: 12px; }.arch-sidebar { width: 185px; flex-shrink: 0; }.arch-main { flex: 1; min-width: 0; }.arch-title { text-align: center; font-size: 22px; font-weight: bold; color: #14532d; margin-bottom: 16px; }
    .arch-layer { margin: 8px 0; padding: 14px; border-radius: 8px; box-shadow: 0 2px 8px rgba(22, 101, 52, 0.06); }.arch-layer-title { font-size: 13px; font-weight: bold; margin-bottom: 10px; text-align: center; }
    .arch-grid { display: grid; gap: 8px; }.arch-grid-2 { grid-template-columns: repeat(2, 1fr); }.arch-grid-3 { grid-template-columns: repeat(3, 1fr); }.arch-grid-4 { grid-template-columns: repeat(4, 1fr); }.arch-grid-5 { grid-template-columns: repeat(5, 1fr); }.arch-grid-6 { grid-template-columns: repeat(6, 1fr); }
    .arch-box { border-radius: 5px; padding: 8px; text-align: center; font-size: 11px; font-weight: 600; line-height: 1.35; color: #14532d; background: rgba(255, 255, 255, 0.9); border: 1px solid rgba(34, 197, 94, 0.15); }.arch-box.highlight { background: linear-gradient(135deg, #dcfce7 0%, #bbf7d0 100%); border: 2px solid #16a34a; }.arch-box.tech { font-size: 10px; color: #166534; background: rgba(240, 253, 244, 0.8); }
    .arch-layer.external { background: linear-gradient(135deg, #f3f8f3 0%, #e8f0e8 100%); border: 2px dashed #a3c0a3; }.arch-layer.external .arch-layer-title { color: #6b8f6b; }.arch-layer.user { background: linear-gradient(135deg, #dcfce7 0%, #bbf7d0 100%); border: 2px solid #22c55e; }.arch-layer.user .arch-layer-title { color: #15803d; }.arch-layer.application { background: linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%); border: 2px solid #059669; }.arch-layer.application .arch-layer-title { color: #047857; }.arch-layer.ai { background: linear-gradient(135deg, #ecfdf5 0%, #ccfbf1 100%); border: 2px solid #14b8a6; }.arch-layer.ai .arch-layer-title { color: #0f766e; }.arch-layer.data { background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border: 2px solid #ca8a04; }.arch-layer.data .arch-layer-title { color: #854d0e; }.arch-layer.infra { background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%); border: 2px solid #64748b; }.arch-layer.infra .arch-layer-title { color: #334155; }
    .arch-sidebar-panel { border-radius: 8px; padding: 10px; background: linear-gradient(135deg, #e8f0e8 0%, #dce6dc 100%); border: 2px solid #86b086; margin-bottom: 8px; box-shadow: 0 1px 3px rgba(22, 101, 52, 0.04); }.arch-sidebar-title { font-size: 12px; font-weight: bold; text-align: center; color: #14532d; margin-bottom: 6px; }.arch-sidebar-item { font-size: 10px; text-align: center; color: #166534; background: rgba(255, 255, 255, 0.85); padding: 5px; border-radius: 4px; margin: 3px 0; border: 1px solid rgba(34, 197, 94, 0.12); }.arch-sidebar-item.metric { background: #dcfce7; border: 1px solid #22c55e; color: #15803d; font-weight: 600; }
  </style>
  <div class="arch-title">🧬 Rust Kernel <code>tdeasenexus-toolbox</code> — Single-Truth Layered Architecture</div>
  <div class="arch-wrapper">
    <div class="arch-sidebar">
      <div class="arch-sidebar-panel"><div class="arch-sidebar-title">单源真相 (Single Truth)</div><div class="arch-sidebar-item">物理常数 → constants.rs</div><div class="arch-sidebar-item">化学组成 → proforma/</div><div class="arch-sidebar-item">理论同位素 → theory.rs</div><div class="arch-sidebar-item">UniMod 逻辑 → unimod.rs<br><small>SQLite 只在 CLI 侧</small></div></div>
      <div class="arch-sidebar-panel"><div class="arch-sidebar-title">证据格 (Lattice)</div><div class="arch-sidebar-item metric">mass ⊂ composition ⊂ identity</div><div class="arch-sidebar-item">shape 类操作拒绝 mass-only</div><div class="arch-sidebar-item">位置类操作接受并标注<br><small>hypothesisType: massDelta<br>notIdentity: true</small></div><div class="arch-sidebar-item">身份 = skill 层合取<br><small>内核永不裁决</small></div></div>
      <div class="arch-sidebar-panel"><div class="arch-sidebar-title">坐标与边界</div><div class="arch-sidebar-item">observed / calibrated /<br>isotope index / shift 分离</div><div class="arch-sidebar-item">fit-envelope 一帧固定求值<br><small>无隐式偏移参数</small></div><div class="arch-sidebar-item">有界 stdout + sha256 证据件<br><small>全表不进 agent 上下文</small></div><div class="arch-sidebar-item">错误面: 4 (lib) + 3 (bin)<br><small>exit 1 运行错 / 2 用法错</small></div></div>
    </div>
    <div class="arch-main">
      <div class="arch-layer external">
        <div class="arch-layer-title">Callers — 调用方 (进程边界 = 契约边界)</div>
        <div class="arch-grid arch-grid-3"><div class="arch-box">Python Skills<br><small>_shared/native: binary() 命名规则 + run_json() 子进程卫生</small></div><div class="arch-box">Agent Runtime<br><small>bash 直调; --help 即接口</small></div><div class="arch-box">契约测试 (双侧)<br><small>Rust cli_contract.rs + Python test_cli_surface_contract.py</small></div></div>
      </div>
      <div class="arch-layer application">
        <div class="arch-layer-title">CLI Adapter — bin/tdeasenexus-toolbox (每命令 1:1 映射内核函数, 不是第二实现)</div>
        <div class="arch-grid arch-grid-3"><div class="arch-box">main.rs<br><small>退出码 0/1/2; elapsedMs</small></div><div class="arch-box highlight">commands.rs<br><small>22 派发臂 + 证据格门 (theory/validate-precursor 拒绝 mass-only)</small></div><div class="arch-box">args.rs<br><small>clap 派生; 22 子命令</small></div><div class="arch-box">output.rs<br><small>stdout 结果 / stderr 错误, 永不混流; sha256 source</small></div><div class="arch-box">prsm.rs<br><small>候选生成, 隔离修饰库策略</small></div><div class="arch-box">unimod_db.rs<br><small>bundled SQLite 读取</small></div></div>
      </div>
      <div class="arch-layer ai">
        <div class="arch-layer-title">Composition — 编排层 (原子能力的显式组合, 各自仍可独立调用)</div>
        <div class="arch-grid arch-grid-3"><div class="arch-box">refine.rs<br><small>parse_proforma + theory + fit_envelope 三原子编排; C13 窗口 = 常量 CALIBRATION_MAX_OFFSET</small></div><div class="arch-box">query.rs<br><small>谱图查询门面 (scan/index/XIC/precursor/product)</small></div><div class="arch-box">envelope.rs<br><small>观测 vs 理论匹配; 复用单源, 无第二次卷积</small></div></div>
      </div>
      <div class="arch-layer user">
        <div class="arch-layer-title">Atomic Kernel — 原子内核层 (物理/化学/统计的唯一真相)</div>
        <div class="arch-grid arch-grid-5"><div class="arch-box highlight">proforma/<br><small>唯一化学真相; 数值 delta 显式降级</small></div><div class="arch-box highlight">theory.rs<br><small>唯一 BRAIN 卷积; 相对偏移+重锚定</small></div><div class="arch-box">isotopic.rs<br><small>averagine 模型族 (mzdeisotope 移植)</small></div><div class="arch-box">fragment.rs<br><small>理论碎片/match/compare (mzannotate)</small></div><div class="arch-box">localize.rs<br><small>载体存在性窗口扫描 (msalign)</small></div><div class="arch-box highlight">seqgraph.rs<br><small>序列图修饰搜索 (Informed-Proteomics 移植, 2 处已声明偏离)</small></div><div class="arch-box">select.rs<br><small>谓词式谱图筛选</small></div><div class="arch-box">unimod.rs<br><small>纯逻辑查询/组合求解 (无 IO)</small></div><div class="arch-box">proforma_unimod.rs<br><small>[UNIMOD:n]/命名解析 → 交回 proforma</small></div><div class="arch-box">constants.rs<br><small>PROTON / NEUTRON / H2O 单源</small></div></div>
      </div>
      <div class="arch-layer data">
        <div class="arch-layer-title">IO — 数据进出 (最薄的两块)</div>
        <div class="arch-grid arch-grid-2"><div class="arch-box">mzml.rs<br><small>读取适配, 19 行委托 mzdata</small></div><div class="arch-box">mztab.rs<br><small>mzTab-M 写出, 零 crate 依赖</small></div></div>
      </div>
      <div class="arch-layer infra">
        <div class="arch-layer-title">Foundation Crates — 外部科学计算底座 (kernel 不重造)</div>
        <div class="arch-grid arch-grid-4"><div class="arch-box tech">mzdata 0.51<br><small>mzML/MGF 解析</small></div><div class="arch-box tech">mzcore 0.2<br><small>ProFormA + 内嵌本体</small></div><div class="arch-box tech">mzannotate 0.2<br><small>碎片化模型</small></div><div class="arch-box tech">chemical_elements 0.7<br><small>BRAIN 同位素引擎</small></div><div class="arch-box tech">mzpeaks 1<br><small>峰类型</small></div><div class="arch-box tech">rusqlite (bundled)<br><small>UniMod 库, 打包免系统依赖</small></div><div class="arch-box tech">rayon<br><small>批命令并行</small></div><div class="arch-box tech">clap + serde_json<br><small>CLI + JSON 契约</small></div></div>
      </div>
    </div>
    <div class="arch-sidebar">
      <div class="arch-sidebar-panel"><div class="arch-sidebar-title">守护测试 (可执行证明)</div><div class="arch-sidebar-item metric">cli_contract.rs 2516 行<br><small>CLI 输出 ≡ 内核直调 (1e-12 相对容差)</small></div><div class="arch-sidebar-item">证据格活体测试<br><small>对真实二进制执行</small></div><div class="arch-sidebar-item">mzannotate_e2e / query_scan / mzpaf_output</div><div class="arch-sidebar-item">Python 侧 CLI surface 快照</div></div>
      <div class="arch-sidebar-panel"><div class="arch-sidebar-title">自洽机制 (in-code)</div><div class="arch-sidebar-item">中性丢失位点门控<br><small>position 必填 + span 校验</small></div><div class="arch-sidebar-item">--evidence-out 强制<br><small>fragment --mode match</small></div><div class="arch-sidebar-item">混合电离系列拒绝<br><small>MIXED_ION_SERIES (skill 侧)</small></div><div class="arch-sidebar-item">release: lto + strip<br><small>单二进制交付</small></div></div>
      <div class="arch-sidebar-panel"><div class="arch-sidebar-title">体量指标</div><div class="arch-sidebar-item metric">29 文件 / 22.6k 行 (含测试)</div><div class="arch-sidebar-item metric">22 子命令</div><div class="arch-sidebar-item">最大: seqgraph 3.5k / commands 2.5k</div><div class="arch-sidebar-item">最薄: mzml 19 行</div></div>
    </div>
  </div>
</div>

## Reading notes

- **Vertical flow = dependency direction**: callers cross the process
  boundary into the CLI adapter; the adapter dispatches 1:1 into composition
  or atomic-kernel functions; IO modules are the only places that touch files;
  no kernel module reaches upward past its own layer.
- **Highlights mark the single-truth anchors** (`proforma/`, `theory.rs`,
  `constants.rs`) and the two places where self-consistency is *actively
  policed* (`commands.rs` lattice gates, `cli_contract.rs` byte-equality).
- **Left sidebar = the invariants; right sidebar = how each invariant is
  enforced** (tests, or mechanical behavior in code). If a change breaks a
  sidebar claim, either the code or this diagram is wrong — fix one of them.
