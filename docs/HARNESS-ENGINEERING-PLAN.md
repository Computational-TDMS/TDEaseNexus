# Harness 工程化改造计划

> 状态：**已评审通过（2026-09-10），按阶段在 main 落地**；问题台账随修复在同一 commit 内勾销
> 计划 commit 曾在 `harnessing` 分支做出，当日合回 main 并删分支 · 方法论参照：OpenAI《Harness Engineering》
> 本文档是工程过程记录，**不是产品权威**（见 `docs/README.md` § Not authoritative）。
> 台账条目以 `H<n>` 编号，后续 commit 以 `[harness] H<n>: …` 引用，保证全程可追溯。

## 0. 方法论映射：项目已具备什么、缺什么

OpenAI harness engineering 的核心实践与本项目的对照：

| 文章实践 | 本项目现状 | 差距 |
|---|---|---|
| AGENTS.md 是地图不是说明书 | 已具备：AGENTS.md 五条铁律 + `docs/README.md` 任务入口表 + 权威顺序 | 无 |
| 计划是一等公民、入库版本化 | 本文档即实践 | 无 |
| 机械强制不变量，不微观管理实现 | 已有 4 个自研门禁：`check:reachability`（死代码）、`check:bundle`（首屏预算）、`check:prompt-contract`（工具名注册一致性）、`check:contrast`（WCAG 对比度，**但不在 CI/build 任何环节**） | H2/H6/H7 |
| doc-gardening（文档保鲜用工具保障） | 制度好：spec 全部 <30 天、STATUS 快照制、双日志分离；但存在双登记与零提及文档 | H14/H21 |
| 数据形状在边界处验证 | 已具备：`containedPath` 路径包含、sanitizer、failure envelope | H8/H9/H10 收口 |
| 提交门禁保证可构建 | **提交前零校验**（无 hooksPath/无 husky），全押 push 后 CI；CI 亦有盲区 | H2/H3/H5/H6 |

**结论**：本项目的 harness 底子高于文章基线，不推倒重来。改造聚焦五个缺口：本地门禁缺失、CI 覆盖盲区（Rust 零覆盖、lint 未跑）、`electron/main.ts` 上帝模块、安全边界三处收口、文档零星漂移。

## 1. 问题清单（台账）

严重度：P0=阻碍"每次提交可构建、质量可控"；P1=安全/正确性/高维护成本；P2=债务与一致性。
阶段列 = 计划处置阶段（§2）。"行为变更"标记 = 该项不是纯重构，修的是缺陷。

| ID | P | 类别 | 位置 | 问题 | 阶段 |
|---|---|---|---|---|---|
| H1 | P0 | 结构 | `TDEase-FrontEnd/electron/main.ts`（1757 行） | 上帝模块：73 个 IPC 注册 + 窗口/tray/生命周期 + workspace 注册表 + 文件 RPC + watcher + share + 更新检查 + provisioning 全在一个文件，且是全仓最大零测试文件 | 4 |
| H2 | P0 | 门禁 | 仓库根 | 提交前零自动校验：`core.hooksPath` 未设置、无 husky；`node --check` 级别的错误只能等 CI | 3 |
| H3 | P0 | 门禁 | `tdease-ai-capability` | Rust 质谱内核（22k 行）零 CI 覆盖：cargo test/clippy/fmt 不在任何 workflow，前端只编译不测试它 | 3 |
| H4 | P0 | 流程 | 工作区 | 65 项在途变更未落账：含 `docs/STATUS.md`、`spec/WORKFLOW-RUN.md`、`spec/FAILURE-CONTRACT.md` 修改与未跟踪的 `design/BACKEND-HARDENING.md`——权威层与提交历史脱节，且阻塞后续阶段（这些文件会被本改造触碰） | 前置决策 D2 |
| H5 | P1 | 门禁 | `tdease-backend/pyproject.toml` | 声明了 black/isort/mypy 但零配置、CI 不跑、无 ruff；风格与类型回归无拦截 | 3 |
| H6 | P1 | 门禁 | `TDEase-FrontEnd` | eslint 10 + typescript-eslint 已安装且 `eslint.config.js` 存在，但 build 链与 CI 均不执行 | 3 |
| H7 | P1 | 门禁 | `scripts/check-contrast.mjs` | 对比度门禁不在 CI 也不在 `build` 链，主题 token 改坏不会被任何自动化发现 | 3 |
| H8 | P1 | 安全 | `electron/main.ts:1218` | `workspace:watch-start` 只校验 `path.isAbsolute`，不经 workspace 注册表成员校验（对比 `:952` 的 `workspacePath`）；渲染层可让主进程 watch 任意绝对目录并收到其文件事件（信息泄露面） | 5（行为变更：安全修复） |
| H9 | P1 | 安全 | `electron/main.ts:538` | `conversation:print-pdf` 将渲染层传入的任意 HTML 装入隐藏窗口，未禁 `will-navigate`/未设 `setWindowOpenHandler` | 5（行为变更：安全修复） |
| H10 | P1 | 测试 | `src/utils/markdown-html-sanitizer.ts` | 安全边界组件（DOM 三重 allowlist）无直接测试文件，仅被 smoke 间接擦过 | 5 |
| H11 | P1 | 测试 | `electron/main.ts` | 73 个 IPC handler 零契约测试；`electron/` 下仅 4 个点测试 | 4/5 |
| H12 | P1 | 性能 | `electron/main.ts:955` | `workspacePath` 每次 workspace RPC 都同步 `readFileSync` 解析注册表 JSON（热路径同步 IO） | 4（行为不变，纯内部） |
| H13 | P1 | 重复 | `MarkdownContent.vue:314-530` | inline media 与 iframe frame 两套镜像懒加载实现（observer/apply/markFailed 各写一遍） | 4 |
| H14 | P1 | 文档 | `docs/README.md:63` | failure contract 双登记：CORE-ARCHITECTURE "owns failure contract (§7)" 与 `spec/FAILURE-CONTRACT.md` 违反 "one authority per fact" | 2 |
| H15 | P2 | 安全 | `electron/main.ts:635` | splash 窗口 `nodeIntegration:true, contextIsolation:false`，与主窗口加固配置（`:1300`）不一致（内容为本地静态页，风险低） | 4（行为变更：加固） |
| H16 | P2 | 重复 | `electron/main.ts:427/1039/1075` | sha256 流式哈希 + atomic temp-rename 模式写了 3 遍；`atomic-write.ts` 已存在未处处复用 | 4 |
| H17 | P2 | 重复 | `scripts/check-*.mjs` | 3 个门禁脚本各自重复 repo 根定位/产物读取/输出格式（已有 `color.mjs` 共享先例） | 4 |
| H18 | P2 | 性能 | `FileTree.vue:38,695` | 大目录树无虚拟化；模块顶层 `dragend` 监听永不移除 | 4 后批 |
| H19 | P2 | 结构 | `src/stores/documents.ts`（1227 行） | 布局树纯算法（`:297-360`）与网关调用/持久化/MRU 混杂 | 4 后批 |
| H20 | P2 | 结构 | `electron/agent/agent-runtime.ts`（1076 行） | 工厂 + 门面 + 组合根三合一（有测试，风险可控） | 4 后批 |
| H21 | P2 | 文档 | 5 个 design 文档 | `MOTIF-PRIOR`、`PERMISSION-AUTO-FIX`、`SKILL-D3-RENDERING-ARCHITECTURE`、`MASS-SHIFT-LOOP`、`PTC-RELIABILITY` 在 STATUS.md 零提及——"presence = status" 反模式入口 | 2 |
| H22 | P2 | 文档 | `CLAUDE.md` / `README.md` | CLAUDE.md Commands 缺 `test:e2e:desktop` 等门禁命令（与自身 "E2E beats unit tests" 原则矛盾）；根 README clone URL 指向 `TDEaseNexus.git` 与本地名 `TDEase-zero` 分裂 | 2 |
| H23 | P2 | 门禁 | `.github/workflows/ci.yml` | 渲染器 Playwright 套件（`tests/e2e`）CI 不跑（仅 desktop project）；`check:reachability` 依赖 build 间接执行 | 3（可选项） |
| H24 | P2 | 门禁 | `tdease-backend/tests/` | 子模块自带测试仅 3 文件，真实套件（39 文件）在主仓库根 `tests/`——单独克隆子模块无完整测试 | 记录，暂不动 |
| H25 | P2 | 测试 | `src/utils/markdown.ts`（1254 行） | 仅 smoke 测试（4 用例）；插件组合/图片尺寸解析无边界测试 | 5 |
| H26 | P0 | 门禁 | `.github/workflows/*.yml` | `pnpm/action-setup@v4` 未传 `version`，且仓库根无 package.json——client/app-e2e/contract 三个 job 自 2026-08-18 起秒红，CI 的 pnpm 面整体失效 | 3（已提前修复） |
| H27 | P0 | 门禁 | `.github/workflows/ci.yml` | checkout 未拉子模块（kernel/backend 目录为空）+ 根目录 `uv run` 无 pyproject——client 死于 cargo manifest 缺失、app-e2e 因真实 Backend 起不来全用例超时、backend/contract 死于 uv 项目解析；被 H26 长期掩盖 | 3（已提前修复） |
| H28 | P2 | 文档/垃圾 | 根目录 + `docs/design/` | experience-gene 遗留脚本（`build_experience_gene_deck.py`、`evolver-bridge.mjs`）与 STATUS 陈旧提及；design 孤儿/派生文件 7 个（SKILL-FAMILY.html、SKILL-ISOFORMA.html 孤儿，ENGINE-RUN-JOURNEY.html 早期草稿被 STATUS 登记的四图取代，RUST-KERNEL 与 SKILL-D3 的 html/png 为活文档 .md 的重复导出）；未跟踪 `pelican_bike.html` 与空根 `node_modules/` | 2 |
| H29 | P1 | 缺陷（行为修复） | `electron/main.ts`（节点种子解包） | `"C:\Windows"` 中 `\W` 是无效转义，实际求值为 `C:Windows`（丢反斜杠）——SystemRoot 未设时 tar 路径错误。真实环境 SystemRoot 恒有值，故从未暴露；由 eslint `no-useless-escape` 抓出 | 3 |
| H30 | P2 | 门禁卫生 | 根 `.gitignore:113` | 无锚定的 `reference/` 规则误伤 `TDEase-FrontEnd/electron/agent/reference/` 源码目录——既有源文件当年靠 `add -f` 入库，该目录下**新增**源文件会被静默忽略。修法需先验证规则意图（疑为 `data/` 运行时资产）与 data 布局影响面，暂记录 | 后批 |
| H31 | P1 | 测试删繁就简 | `TDEase-FrontEnd/src/**` | 用户裁决（2026-09-13）：成熟功能不再需要单测，测试重点 = 关键数据管道 + 端到端 + beta 功能单测。删除对象 = **成熟且被桌面 E2E 旅程覆盖**的表现层单测；保留对象见勾销记录 | 3.5'（新增） |

**明确不是问题（扫描后排除，防止后续误改）**：根目录 `findings.md`/`progress.md`/`task_plan.md`/`logs/`/`tmp/` 等均已 gitignore（卫生合格）；TODO/FIXME 全仓仅 8 处（无债务堆积）；spec 层时效全部 <30 天；share-server 鉴权（constant-time token、cookie、路径包含）扎实；分层依赖方向总体受控。

### 台账勾销记录

- **H14 ✅（2026-09-11）**：README 的 CORE-ARCHITECTURE 行已改为纯事件/投影模型所有权，快速入口新增 failure envelope 专行指向 `spec/FAILURE-CONTRACT.md`。复核发现 §7 实为 Client architecture——原 README 标注属纯陈旧，非双登记。
- **H21 ✅（2026-09-11，验证后关闭）**：5 个文档全部自带显式状态标记（MOTIF-PRIOR `status: partial`、PERMISSION-AUTO-FIX `IMPLEMENTED 2026-08-07`、SKILL-D3 `accepted and implemented`、MASS-SHIFT-LOOP `methodology 2026-08-20`、PTC-RELIABILITY `status: implemented`）。扫描结论"STATUS 零提及"属实，但"缺状态"推论不成立——不再添加冗余状态行。
- **H22 ✅（2026-09-11）**：CLAUDE.md Commands 补 `test:e2e` / `test:e2e:desktop`（已核对 package.json 实有）。README clone URL 非问题：远端实名 `TDEaseNexus.git`，与 README 一致，仅本地目录名不同。
- **H26 ✅（2026-09-11，提前修复）**：两个 workflow 共 4 处 `pnpm/action-setup` 显式钉 `version: 10`（本地 pnpm 10.33.0 / node 24 对齐 CI）。此前该错误使 pnpm 系 job 在 setup 步秒死，8 月以来从未真正跑过测试——即 CI 长期红灯的真实原因。
- **H27 ✅（2026-09-11，修复待凭证生效）**：checkout 统一加 `submodules: recursive`；backend/contract 的 pytest 改为 `uv run --project tdease-backend` + `PYTHONPATH=tdease-backend`（对齐 CLAUDE.md 记载的本地调用契约）；setup-uv 缓存 glob 指向 `tdease-backend/uv.lock`。修复后首跑：electron-scripts ✓、client 走到 cargo（H26 修复生效）、app-e2e 真实跑满 8m30s——CI 第一次真实执行。**剩余一步（需仓库主人操作）**：三仓均 PRIVATE，CI 拉私有子模块需要一个有 `repo` 权限的 PAT 存为主仓 secret `CI_SUBMODULES_TOKEN`（workflow 已接 `secrets.CI_SUBMODULES_TOKEN || github.token` 兜底，secret 配置后重跑即绿）。
- **H28 ✅（2026-09-13，恢复执行日清扫）**：改造于 2026-09-10 评审后落地至阶段 2，同日本次恢复（用户确认沿用既有计划、main 施工、追加"简化文档、去除垃圾"指令）。遗留脚本两枚删除 + STATUS 行摘除（`d688973`）；design 孤儿/派生 7 文件删除（本 commit，git 历史可追溯，STATUS-HISTORY 中的历史引用属冻结记录不回改）；`pelican_bike.html` 与空根 `node_modules/` 为未跟踪垃圾，工作区直接清除不入库；LICENSE（GPL-3.0）入库（`90cca7b`）。**保留并核实为有效工具**：`forbidden_search.py`（术语禁入门禁，自带基线，注释称"CI pass criterion"但**尚未接入 CI**——记录为阶段 3 可选项）、`pytest_collection_gate.py`（后端套件收集门禁）、`gen_companion_docs.py`（软著申请资料工具）。
- **H6 ✅（2026-09-13，阶段 3.1）**：eslint 从"存在但从未可运行"到基线清零。**配置层**：ignores 补 `release/`/`electron/dist/` 等产物目录（原配置一跑即被打包内 d3.min.js 淹没，23k 假问题）；60 项手工 DOM globals 白名单删除，换 `globals` 包（新 devDependency，零传递依赖）；`no-undef` 对 TS/Vue 关闭（vue-tsc/tsc 在 build 链是未定义标识符的权威，typescript-eslint 官方建议），electron `.mjs` 保留并供 Node globals；unused-vars 策略 src/electron 统一（warn + `^_` 豁免）；`no-unused-expressions` 允许短路/三元守卫惯用法；测试文件关单词条组件与 prop-default 规则。`package.json` 增 `lint` script（`eslint src electron`）。**存量清零**：23,371 → 门禁内仅剩并行会话在途文件 2 个 error（Composer `no-dupe-keys` 真实代码异味、snapshot-policy 注释内新 ZWSP），随其落账由 hook 自愈。**门禁抓出的真实问题（全部修复）**：H29 转义缺陷；`session-log.ts` 重抛错误丢 `cause`；`vocabulary.ts` 空接口改 type alias；`TurnOutcomeCard` computed 补 default 返回；死赋值 ×4（markdown ×2、wiki-library、WikiIndexDocument）；`prefer-const` ×2；uniprot 函数内 `require('node:crypto')` 提升为顶部 import + 死变量 `digest`/`status` 删除。**接受债务（行内 disable + 理由）**：SubAgentCard computed 锁存写、FeatureMapViewer computed 解析旁路同步——语义刻意，重构风险大于收益。**插曲**：`workspace-snapshot-policy.ts` 注释曾以 ZWSP 阻止 `*/` 提前终止 JSDoc，机械清除 ZWSP 即触发解析错误（`**/results/**` 含 `*/`）；并行会话已将注释改为行注释根治——隐形字符依赖不健壮，教训记档。
- **H3 ✅（2026-09-13，阶段 3.3）**：ci.yml 新增 `rust-kernel` job（`cargo fmt --check` + `clippy -D warnings` + `cargo test --workspace`，rust-cache 加速；fixtures 已 git 跟踪故测试可跑）。为使门禁真实可绿，内核存量 31 个 clippy 警告清零：`clippy --fix` 自动项 + 7 处机械手修（数字分组/doc 缩进/identity map/let-else 改 `?`），行为保持由 cargo test 201 用例全绿证实（子模块 `f841c1c`，仅含 `rust/` 路径——子模块内并行会话的 skill 文档在途改动未触碰）。4 类科学计算惯用 lint（`type_complexity`/`too_many_arguments`/`needless_range_loop`/`neg_cmp_op_on_partial_ord`）在 CI 按**类别**豁免并在 workflow 注释写明理由，新增警告类别仍会红灯。
- **H5 ✅（2026-09-13，阶段 3.4）**：tdease-backend 子模块 dev 组增 `ruff>=0.16` + `[tool.ruff]`（88 列对齐 black 默认）。**规则集显式钉死 `select = ["E4","E7","E9","F"]`，绝不继承 ruff 默认值的未来演变——第一轮踩雷实证**：默认规则集的 import 排序重排了 `engine_runner.main()` 内**刻意声明**的 snakemake 导入顺序（api 必须先于 workflow），触发 snakemake 自身循环导入，13 个真实引擎测试红灯；回滚重做后钉死规则集，根因注释写进 pyproject。豁免 BLE001/S110/TRY004 三类并注明理由（引擎/worker 边界**有意**宽捕获遏制失败（BACKEND-HARDENING）；TypeError 会改变 failure contract 线上行为）；mypy 按计划 deferred。存量：`ruff format` 26 文件（纯排版）+ `check --fix` + 手修 E402×2（execution.py 的延迟导入同属导入时序控制，noqa 注明）+ 死变量 `rule_indent` ×2；uv.lock 同步。CI backend job 增 `ruff check` + `format --check` 两步（`uv run --frozen` 防漂移）。**后端全量 327 passed / 1 skipped，与历史基线一致**（子模块 `a78193c`）。
- **H31 ✅（2026-09-13，测试删繁就简）**：按用户裁决执行"成熟功能去单测，聚焦关键数据管道 + E2E + beta"。**删除 34 文件 / 约 178 测试**（vitest 207→173 文件），全部满足"成熟 + 桌面 E2E 旅程已覆盖"或"纯表现组件"：Agent 表现层 17 文件（工具链块/转录块切片/活动胶囊/权限卡/Markdown 内容/过程折叠/转录/HUD/流式分段/阻断卡/会话待办/空态/导出序列化/结局卡/数据卡/工件列表/Composer 浅测）+ 工作台外壳 3 文件（ActivityDock/StatusBar/WorkspaceRailButton）+ 通用原语与小部件 14 文件（primitives×9 含 SchemaForm、LangSwitcher、PermissionsSettings、CanvasGallery、ViewerNode、CanvasDocument 浅测）。**有意保留并记录理由**：CommandPalette(24 测试，E2E 旅程未覆盖，删了就没网)；FileDocument(24)/MsAlign/Result/RunDocument/科学查看器簇（关键数据管道阅读面）；mention 管道(39)/markdown-workspace-image(30)/markdown-blocks（Agent 输入与引用渲染管道）；全部 stores/services/studio/agent-events（数据流）；contracts/agent-runtime + prompt-contract（CI 点名的契约锚点）；ai/core（beta 成本账本）；并行会话 WIP 测试（sash/tabDrag/dockLayout/editorLayout/pageTrackCore/uiLayout/ResizableSplit/DocumentTabs/SlashInput）。**验证**：vitest 173 文件/1384 测试全绿；reachability 361/361；`pnpm run build` 全链绿。**插曲**：H31a 首次提交被自家 pre-commit 钩子拒绝——`git add -A` 误捎带了同目录下并行会话的 WIP .vue（含已知 no-dupe-keys），改为精确路径暂存后通过；门禁首日拦下门禁建设者本人，按设计工作。

## 2. 阶段拆解

### 前置决策（与计划评审一并确认）

- **D1 分支制度**：`AGENTS.md` 铁律 1 规定"只在 main 开发，不开分支"，本次按指示使用 `harnessing` 分支。落地期间所有改造提交进 `harnessing`，完成后合回 main 并删分支。需确认这是一次性豁免（不改 AGENTS.md），还是修订铁律 1。
  - **决议（2026-09-10）：一次性豁免。** 计划 commit 做出后当日 fast-forward 合回 main 并删除分支；此后全部施工直接在 main，AGENTS.md 不改。
- **D2 在途变更落账（H4，阻塞项）**：当前 65 项未提交变更是 2026-09-10 契约对齐 + Agent 侧栏在途工作，其中 `docs/STATUS.md` 等 4 个文档文件是阶段 2/4 必然要改的文件，不落账必然缠线。建议：阶段 1 开工前先把这些 WIP 按既有工作主题提交（约 2-3 个 commit，落在本分支），使其与 harness 改造历史可区分。**未经确认不代为提交。**
  - **进展（2026-09-10）：主仓库落账暂停，子模块已落账**（tdease-backend `d7f865f` bearer 鉴权/加固/包络，tdease-ai-capability `d7d99c0` 提示词修订，两仓内部工作区已干净；指针更新随主仓库后续落账）。暂停原因：提交前健康检查发现工作区正被并行会话实时施工（shell 复合模型重写：`viewDrag.ts`、`ActivityRail.vue`、`CompositeViewHost.vue` 等新文件持续写入），健康检查的 type/test 失败是移动目标的快照不作数，为避免把半成品快照进 main，主仓库文件待该会话收尾后分组落账。已代修一处机械性破坏：`uiLayout.ts` 注释中的字面 `*/` 提前终结了块注释（vue-tsc 级联报错），仅改写注释措辞。

### 阶段 1：全量扫描与问题清单 —— ✅ 已完成（本文档 §1）

- 产出物：本文档（含台账）、`docs/README.md` 登记。
- 验收标准：计划文档评审通过；台账 `H<n>` 编号可被后续 commit 引用。

### 阶段 2：文档对齐与保鲜

> 进展（2026-09-11）：2.1 ✅、2.2 ✅（验证后关闭，无需改动）、2.3 ✅；2.4（doc 链接检查脚本）未做，可选，并入阶段 3 门禁批次一并评估。

子任务：

- 2.1（H14）`docs/README.md` 中 CORE-ARCHITECTURE 条目的 "failure contract (§7)" 改为指向 `spec/FAILURE-CONTRACT.md` 的引用，恢复一事一权。
- 2.2（H21）为 5 个 STATUS 零提及的 design 文档补状态行（按 `docs/README.md` § Status vocabulary 标 `partial`/`deferred`/`stale`，或在 STATUS.md 相应条目中挂链）。
- 2.3（H22）CLAUDE.md Commands 补 `test:e2e:desktop`、`check:*` 门禁命令（逐条实跑验证后写入）；根 README clone URL 与仓库实际名对齐。
- 2.4（可选，文章 doc-gardening 实践）新增 `scripts/check-docs.mjs`：校验 `docs/**/*.md` 内部相对链接指向存在的文件，加入门禁。

产出物：按主题分组的小粒度文档 commit（2.1/2.2/2.3 各自独立）。
验收标准：`docs/README.md` 无同一事实双登记；5 个文档均有显式状态；CLAUDE.md 每条命令实测可跑；（若做 2.4）故意改坏一个链接能红灯。

### 阶段 3：提交门禁与自动化质量校验

子任务（顺序即依赖序）：

- 3.1（H6 前置）eslint 一次清零：跑 `eslint.config.js` 全量，自动修复 + 手工收敛存量错误，`package.json` 增 `lint` script。**必须先做**，否则 hook 上线即红海。
- 3.2（H2）本地 pre-commit 门禁：仓库根建 `githooks/`（纯 sh + node 脚本，**不引入 husky/lint-staged 依赖**），`git config core.hooksPath githooks`。内容：staged `.cjs/.mjs` 逐个 `node --check`；staged `.ts/.vue` 增量 eslint。目标秒级完成。
- 3.3（H3）CI 增加 `rust-kernel` job：`dtolnay/rust-toolchain` + `cargo fmt --check` + `cargo clippy -- -D warnings`（警告存量先豁免为基线清单）+ `cargo test`（lib + cli_contract；数据依赖的 E2E 超预算则分层为标记，不进提交门禁）。
- 3.4（H5）后端门禁：`tdease-backend/pyproject.toml` 增 `[tool.ruff]`（line-length 对齐 black 默认），CI 增 `uv run ruff check` + `ruff format --check`；mypy 显式标记 deferred（存量类型债一次清不动）。**此改动属子模块仓库，在子模块内提交，主仓库随附指针更新。**
- 3.5（H7）`check:contrast` 进 `build` 链（置于 `check:bundle` 旁）。
- 3.6（H23 可选）`tests/e2e` 渲染器套件进 CI；若 runtime 超预算则记录并 deferred。

产出物：`githooks/` + `ci.yml` 修订 + 子模块 pyproject 提交 + `package.json` scripts。
验收标准：

1. 注入含语法错误的 `.cjs` 提交 → hook 拒绝，秒级返回；
2. 注入 eslint 错误的 `.ts` 提交 → hook 拒绝；
3. 推送分支 + draft PR（或 workflow_dispatch）触发 CI，全部 job 绿（给出 run 链接）；
4. `pnpm run build` 全链绿（含新并入的 contrast）。

### 阶段 4：重构与问题修复（行为保持）

原则：每子任务独立小 commit；vitest 全量 + desktop e2e + `pnpm run build` 全绿才进下一个；不引入新依赖；同步更新 `docs/`（FILE-LAYOUT/CORE-ARCHITECTURE 涉及新目录）与本文档台账。

子任务：

- 4.1（H1，本期最大项）`electron/main.ts` 按域拆分：`electron/ipc/{workspace,system-data,result-cache,share,watcher}.ts` 各自导出 `register<Domain>()`，`window-manager.ts`/`boot.ts` 承接窗口与启动编排；main.ts 只留生命周期组装（目标 ≤300 行、零 IPC 注册）。`check:reachability` 天然看护新模块可达性。
- 4.2（H11 前半）随 4.1 每拆一个域，补该域 IPC 契约测试（沿用 `electron/*.test.cjs` node:test 既有模式）。
- 4.3（H12）workspace 注册表读取加缓存 + 写路径失效（对外行为不变）。
- 4.4（H16）统一走 `atomic-write.ts` + 提取 `hashFile` 公共 helper，删除三处手写模式。
- 4.5（H13）MarkdownContent 双懒加载合并为 `useLazyMedia(kind)` 单实现。
- 4.6（H17）`scripts/lib/gate.mjs` 收敛三个 check 脚本公共脚手架。
- 4.7（H15）splash 窗口对齐主窗口加固配置（行为变更：安全加固，台账标注）。
- 4.8（后批，视评审意见取舍）H18 FileTree 虚拟化 + dragend 清理；H19 documents.ts 布局算法抽纯函数；H20 agent-runtime 工厂拆分。

产出物：上述每项一个 commit + 台账勾销 + 受影响文档同步。
验收标准：`electron/main.ts` ≤300 行且零 `ipcMain` 注册；73 个 IPC channel 全部保留且行为等价（契约测试证明）；测试全绿、`check:bundle` 体积不回退；除 H15 外无任何行为变更（H15 在 commit message 与台账显式标注）。

### 阶段 5：测试补缺（克制补测，e2e 优先原则不变）

按 `AGENTS.md` 铁律 2，不追组件覆盖率，只补"安全边界 + 拆分产物 + 既有缺口中的高危项"：

- 5.1（H10）`markdown-html-sanitizer.test.ts`：XSS 样本表驱动（script/style/iframe 注入、事件属性、`javascript:` href、UNSAFE CSS 值），并做"移除防线测试即红"的自证。
- 5.2（H8/H9）主进程安全回归测试（node:test 模式）：watch-start 必须拒绝非注册表成员路径；print-pdf 窗口必须带导航锁。**行为变更项，台账显式标注。**
- 5.3（H25）`markdown.ts` 插件组合边界测试（CRLF、wikilink 四语法、图片尺寸标签、sanitizer 交互）。
- 5.4（H11 后半）阶段 4 未覆盖域的 IPC 契约测试收尾。

产出物：4 个测试文件 + 台账勾销。
验收标准：安全边界类别（H8/H9/H10）全部有直接测试且注入样本在防线缺失时红灯；全量测试绿；新增测试均挂进门禁（vitest/CI 自动覆盖，无需额外接线）。

## 3. 提交与追溯规范

- commit 格式：`[harness] H<n>[+H<m>]: <一句变更描述>`；纯阶段杂项用 `[harness] 阶段<n>: …`。
- 一个子任务一个 commit；台账状态勾销随对应 commit 同文件更新。
- 阶段完成时在 `docs/STATUS.md` 同步一行门禁/结构现状（快照制，不写过程叙事；过程记录由 git history 承担）。
- 分支边界：无——全部施工直接在 main（D1 决议：一次性豁免已结束）。

## 4. 边界（明确不做）

- 不改产品行为；缺陷修复仅 H8/H9/H15 三项且显式标注。
- 子模块内部代码不重构（H24 只记录）；子模块门禁配置（3.4）是唯一子模块改动，独立提交。
- 不引入 husky/lint-staged/新测试框架等重依赖；hooks 用零依赖脚本。
- 在 D2 落账前，不触碰 65 项在途变更涉及的文件。
- 不动 `docs/paper/`、`EXPLORATION-LOG.md` 等流程记录（README 已界定其角色）。
