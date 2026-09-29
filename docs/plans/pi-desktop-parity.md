# Plan: PI-Desktop 对照分析 → TDEase Settings 生产级优化

## Goal
对照 `C:\Users\ray\Desktop\PI-Desktop-main`，找出 TDEase 在 Settings（统计、API 配置、token 用量）的缺失，
择优复刻其设计精华，使相关页面达到生产级优雅。

## Phase 1 — 调研结论（done）

### PI-Desktop 值得借鉴的精华（已核实）
1. turn 粒度用量存储 + day/week/month 分桶聚合（SQLite turns 表）
2. 模型发现竞态守卫（requestSeq）+ TTL 缓存
3. 密钥与配置分离（DB 只存 secret_ref；API 回 hasSecret 布尔）
4. 幂等 turn 结束 + 停止补偿
5. 预置服务商 Preset 表（选完自动填 baseUrl/协议）
6. arm-then-confirm 两步删除
7. models.dev 双源目录（bundled 兜底 + 远程刷新）
8. 统计后端返回空桶补零的时间序列（PI 后端已实现、UI 未接）

### TDEase 现状（已精读源码核实）
- **已经很好、无需改动**：凭据脱敏纪律（apiKey 只进不出 + 指纹）、typed 连接测试 verdict（9 种失败码）、
  两步删除、TTL 双源模型发现（主进程 inflight 合并 = PI requestSeq 等价物）、主进程全量聚合、
  SettingsNav 搜索、ContextUsagePanel。
- **真实缺口（按严重度）**：
  - P0 账本 5000 条 FIFO 截断：重度使用（每天数百次 LLM 调用）下 30d/all 统计静默失真，且无任何提示
  - P0 账本每次 append 全量 pretty-print 重写 JSON（IO 放大，也堵死了加大容量）
  - P0 自定义端点费用恒为 null（无计价录入；schema `providers.<id>.models.<modelId>.cost` 已支持，
    仅缺 UI 入口与 IPC 写路径）→ 费用统计对自定义端点失明
  - P1 趋势图只有 tokens 一个维度；无 CSV 导出
  - P1 自定义 provider 创建无预置端点（DeepSeek/Kimi/SiliconFlow… 每次手填 baseUrl）

## Phase 2 — 择优复刻清单

| # | 项 | 来源/思想 | TDEase 落点 | 优先级 | 状态 |
|---|---|---|---|---|---|
| A1 | 账本容量 5k→20k + 防抖批量落盘（合流写突发，clear 即时，退出 flush）+ 去 pretty-print | PI turns 表 bounded 设计的 JSON 等价 | `src/ai/core/usage-ledger.ts` + `electron/main.ts` before-quit | P0 | done |
| A2 | UsageStats 增 `oldestAt`（全账本最老条目），面板显示"数据自 X 起"覆盖线，截断不再静默 | PI 空桶补零的诚实性思路 | `src/ai/core/usage-stats.ts` + `StatisticsPanel.vue` | P0 | done |
| B1 | `settings:set-provider-model-pricing` IPC：per-model cost 字段级合并写（sibling-safe），空值=移除 | PI 密钥/配置分离的写路径纪律 | `electron/main.ts` | P0 | done |
| B2 | pricing 读取 IPC + preload/bridge/store 通道 | 同上 | `preload.cjs` `desktopBridge.ts` `stores/settings.ts` | P0 | done |
| B3 | ProviderDetail 自定义 provider「模型定价」区：每行 4 个 $/Mtok 输入，dirty-guard 保存/清除 | Cherry 计价 UX，PI schema | `ProviderDetail.vue` | P0 | done |
| C1 | 趋势图指标切换 tokens/cost/requests | Cherry 看板深度 | `StatisticsPanel.vue` | P1 | done |
| C2 | CSV 导出（BOM，Excel 友好） | 成熟产品标配 | `StatisticsPanel.vue` | P1 | done |
| D1 | 自定义端点预置表 provider-presets.ts + 对话框预置选择（自动填 name/baseUrl） | PI NAMED_ENDPOINT_PRESETS | `services/catalog/provider-presets.ts` + `CustomProviderDialog.vue` | P1 | done |

### 不复刻（及理由）
- SQLite 迁移：Electron 单进程 JSON 账本在 20k + 防抖下足够，引入 SQLite 是垃圾层（AGENTS 规则 3/5）
- PI 的 OAuth 厂商区/网络代理/定时任务：TDEase 已有等价物或不在本次范围
- 预算告警/多 key 池：无真实需求信号，不做投机性功能

## Phase 3 — 实现（见上表状态列）
关键链路事实（实现依据）：
- cost 链路：`settings.json providers.<id>.models.<modelId>.cost` → `NodeProviderRegistry.resolve().modelMeta`
  → `observers.toCostRates()` → `ledger.start({costRates})` → costTotal → 统计/面板。schema 已通，仅缺写入口。
- 账本读取走主进程内存（list/stats 即时反映 append），防抖只影响落盘时机，读永远新鲜。
- `mergeProviderConfig` 会整块保 `models`（credential 写不清空 capability digest）；
  pricing 写必须走自己的 per-model field-merge（不能整块替换 models，会抹掉冻结 digest）。

## Phase 4 — 验证
- [x] vitest：usage-ledger / usage-stats / atomic-write 相关用例通过（含新增防抖/oldestAt 用例）
- [x] pnpm build（vue-tsc）通过
- [x] i18n 三语言（en/zh-CN/de-DE）key 齐全

## 约束（来自 AGENTS.md）
- 直接在 main 上开发；端到端优先；不引入垃圾层；第一性原理；最短路径。
