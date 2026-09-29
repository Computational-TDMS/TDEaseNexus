# PI-Desktop 对照复刻计划（planning-with-files）

> Process plan — **not product authority**. 按 `docs/README.md` 的迁移规则，
> 需要长期执行的结论毕业进 `spec/` / `design/` / `STATUS.md`，本文件只回答
> "这轮对照做了什么、为什么"。参照物：`C:\Users\ray\Desktop\PI-Desktop-main`
> （PI-Desktop v0.14.5，Electron + Rust host + Node sidecar）。
> 创建：2026-09-15。状态：**已完成**。

## Goal

与 PI-Desktop 对照，找出 TDEase 在 **Settings 统计 / API 配置页 / token 统计**
上缺失的生产级机制，择优复刻，保持生产化优雅（最短路径、不加垃圾层）。

## Findings — PI-Desktop 的可取机制（探查结论，含出处）

1. **两段式 Provider 连接测试**（`apps/desktop/electron/main/index.ts` providersTest
   ~L6404）：先本机配置校验，再真实 `GET {baseUrl}/models`（8s AbortController），
   错误映射为类型化代码：401/403→`PROVIDER_UNAUTHORIZED`、429→`PROVIDER_RATE_LIMITED`、
   abort→`TIMEOUT`。UI 有显式"测试连接"动作与明确反馈。
2. **用量聚合空桶补零**（`crates/host-core/src/sessions.rs:2790`）：
   day / ISO-week / month 桶，空桶补零，有总数与 turnCount，有单测。
3. **实时模型发现的陈旧响应守卫**（`useProviderModels.ts`）：防抖、cache-first、
   请求序号守卫。
4. **models.dev 富化目录**（bundled 快照 + 远程刷新 + 手动刷新按钮）。
5. **加密 secret store**（`secrets.rs`，AES-256-GCM + machine key + secret_ref）。
6. **SQLite 版本化迁移**（`db.rs` SCHEMA_VERSION=13，事务式链式迁移）。
7. **数据驱动的设置 IA 供全局搜索命中翻译后的行文本**（`settings-search.ts`）。
8. **每回合用量落库 + 子代理归因**（turns 表 + `turn_end.subagentUsage`）。
9. PI 自己的缺口：聚合历史 API 建好了却没有统计 UI、没有成本计算 —— TDEase 的
   StatisticsPanel 在这一层**领先** PI，无反向学习价值。

## Decisions — 复刻 / 不复刻（终局记录）

| # | 机制 | 决定 | 结果 |
|---|---|---|---|
| D1 | 显式连接测试 + 类型化错误 | **复刻** | ✅ `model-catalog-refresher.test()` + `settings:test-provider` IPC + ProviderDetail "测试连接"按钮；配置错误零流量即命名（no_key/no_config/unsupported），线上错误映射 unauthorized/rate_limited/not_found/server/timeout/network；8s 超时；不写缓存、不走 models.dev 回退（测的是用户的端点，不是聚合器）。 |
| D2 | 用量趋势空桶补零 | 无需复刻 | 精读发现 TDEase **已有**：`usage-stats.ts` 预建桶（"Buckets are pre-built so days with no traffic still draw as zero bars"），且 `usage-stats.test.ts` 已覆盖含 5h 在内的全部 range。 |
| D3 | 统计面板 5h 档 | **修自己的** | ✅ `StatisticsPanel` RANGES 增 `'5h'`（与 ContextUsagePanel 的 5h 窗口同一词汇），i18n ×3。 |
| D4 | ContextUsagePanel 实时刷新 | **修自己的** | ✅ 挂载一次性取数改为 `subscribeUsage` 防抖刷新（与 StatisticsPanel 同款 300ms 模式），长开面板不再陈旧。 |
| D5 | 发现模型的陈旧响应守卫 | 无需复刻 | 精读发现 refresher 已有 inflight 单飞合并（`inflight` Map 按 `providerId:force` 键合并并发），无竞态。 |
| D6 | 加密 secret store | **不取** | 威胁模型不同：TDEase 密钥只在主进程 settings.json 且 agent 全模式拒绝读取（STATUS 已钉）；引入 SQLite/加密层是无需求加层。 |
| D7 | SQLite 版本化迁移 | **不取** | settings.json + `atomic-write` 单写序列化 seam + schemaVersion 已覆盖。 |
| D8 | 设置行级搜索 IA | **不取（本轮）** | 命令面板已直达 8 个分区；行级搜索是另一个 feature。 |
| D9 | Transcript 每条消息 token 显示 | **不取（本轮）** | PI 在 ContextUsageInspector 展示；TDEase 的 composer 环 + ContextUsagePanel 已覆盖且更克制（产品原则：calm）。 |
| D10 | 成本"未知 vs 免费"区分 | **不取（本轮）** | custom 端点 rate 0 是既定策略；区分需 ledger 加字段，收益低。 |
| D11 | models.dev 富化目录 | 无需复刻 | TDEase 已有等价物（`modelCatalogRefresher` + TTL 缓存 + 强刷）。 |

## Tasks（全部完成）

- [x] T1 精读核实（D2/D5 推翻、D3/D4 证实；见上表）
- [x] T2 `usage-stats` 空桶补零 —— 已存在，无需改
- [x] T3 连接测试（refresher.test + IPC + preload/bridge + 按钮 + i18n ×3 +
      `model-catalog-refresher.test.ts` 类型化映射测试 ×3）
- [x] T4 StatisticsPanel 5h 档 + i18n ×3
- [x] T5 ContextUsagePanel 实时刷新
- [x] T6 SettingsDocument 过时注释修正（"Advanced gap" 已不成立，改为 8 分区清单）
- [x] T7 `tests/desktop/settings-usage.spec.ts`：连接测试两真实路径（:9 端口 →
      network verdict；fixture `/v1/models` → "Connection OK · 2 models"）+ 5h 档断言
- [x] T8 验证 + STATUS/README 更新

## 过程记录（对后续有用的坑）

- **TDZ 回归（本轮 e2e 抓住的真缺陷）**：`ProviderDetail` 的 `watch(immediate)`
  在 setup 期同步调 `loadCred`；把 `testVerdict` 的 ref 声明放在文件后部
  （onRefresh 段）而 `loadCred` 里先写它，构成暂时性死区 —— loadCred 在
  `await refreshAgentProviders()` 前同步抛错被 `void` 吞掉，整个凭证加载静默
  中断（名字已填、Key 框显示未配置、Base URL 空）。教训：**immediate watch
  调用的函数所触碰的 ref，必须声明在该调用点之前**；`void asyncFn` 会吞掉
  同步段异常， e2e 是唯一能抓住这类回归的网。已修：声明移到 loadCred 之前。
- **顺带修复**：`usage-stats.ts` 的 `bucketCount` 死初始化触发工作树新 eslint
  规则（`no-useless-assignment`，依赖升级后激活）—— 改为显式定值赋值。
- **调试方法**（可复用）：`page.evaluate` 直读 `window.tdeaseDesktop.*` IPC
  是主进程真值；pinia `state.value` 对 setup store 只含 return 的 ref，不能作
  判据；渲染端函数内临时 `console.log` + 测试里 `page.on('console')` 过滤可定位
  "静默中断"。

## 验证基线（本轮达到）

vitest 定向（refresher 13 / usage-stats 9 / settings 12）全绿；
`typecheck:electron` + `vue-tsc` 0 错误；`check:i18n` 1151 leaf keys ×3 parity；
lint 0 error（45 个既有警告）；settings-usage 桌面 e2e 全绿（含新增步骤）。
