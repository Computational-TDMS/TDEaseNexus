---
type: design
title: Backend rainy-day attack — 起底记录与加固决策
description: 2026-09-10 对 tdease-backend 的对抗性生产化审计:命中清单、已落地修复、接受的风险、后续对策。
status: partially-implemented (see STATUS.md)
---

# Backend 雨天攻击记录(2026-09-10)

> 方法:三路并行攻击(崩溃恢复/并发重复、安全越界/身份迁移、容量/可观测性/AI 专项),
> 每个命中必须有具体场景 + file:line 证据;所有 P0/P1 由人工对源码复核后才动手修。
> 未命中的面也已核对并有覆盖证据(见测试与各节"已覆盖"注)。

> Pruned 2026-10-12: the 2026-09-10 fix table and the verified-clean surfaces
> (both fully landed, evidence in the root test suite) are archived at
> `archive/docs-prune-2026-10-12/docs/design/BACKEND-HARDENING-archived-sections.md`.
> This document keeps only the declared acceptances and the ranked follow-ups.

## 残留风险(已声明的接受项)

- ~~**Origin "null" 仍放行**~~ — **已收口(2026-09-10 同日)**:每启动随机 token 的
  bearer 模式已端到端接通(spec §2 Exposure rule;详见 STATUS.md Backend 节)。沙箱
  iframe 没有 launch token,即使 Origin 为 "null" 也进不来;Origin 门卫保留为纵深防御。
- **`run:`/`shell:` = 同 OS 用户任意代码**:Snakefile 是任意代码,信任模型是"用户/AI 提交的
  工作流与本进程同权"。`profile_validator` 只用于节点目录,不 gate 提交(设计如此,spec
  未写明——见后续 #5)。
- ~~**单机桌面部署的 LAN 暴露**~~ — **已规则化**:后端只以 loopback+token 形态存在,
  对外分享只经 share-server(spec §2 Exposure rule);`auth.mode: local` 降级为 dev/test
  配置。

## 后续对策(未落地,按价值排序)

1. ~~**每启动随机 token 接通 bearer 模式**~~ — **已完成(2026-09-10)**:launcher 铸 secret →
   env 传入 → 单次交换出 owner/agent 双 token;agent 无 `run:purge`
   (`AUTH_SCOPE_DENIED`),AI 爆炸半径有天花板。bearer 死线(硬编码 None)已移除。
2. **请求体大小上限**:dry-run `inline_blobs` 与 `blob_get` 全量进 RAM,10GB blob 即 OOM
   (runs_v2.py 干跑路径);`Content-Length` 预检 + CAS 流式 `atomic_copy`。
3. **submit 侧 OSError 结构化**:journal 追加遇磁盘满 → 裸 500 + 同 key 重试被
   RUN_NOT_FOUND 卡死;`_create_run`/`cancel_run` 捕获映射为存储域错误。
4. **purge 审计**:scope 门已挡住 agent 侧误删(2026-09-10),但 owner 侧 purge 仍连同
   events.jsonl 一起销毁、不可追溯;purge 前在 data-root 级 `audit.jsonl` 追加一行
   (principal、run_id、时间)。`X-TDEase-Actor` 降级为纯展示(事件应记 principal)。
5. **`run:` gate 决策**:对提交的 Snakefile 跑 `profile_validator` 拒绝 `run:`/
   `conda`/`wrapper`/`container`(后三者会拉取并执行远端代码),或在 spec 明文接受
   同权信任模型。二选一,现状是最差的"没人写过"。
6. **引擎活性心跳**:挂死引擎 7 天才被发现;轮询循环里加"引擎 pid 存活 + 最近 N 小时
   无日志行"看门狗,超限升级为杀树终态。(2026-10-13 注:worker 已死且引擎残留的孤儿树
   已由执行租约的 reconcile 收口——`BACKEND-RUN-SERVICE.md` §2.5;本项残留在"worker 活着
   但引擎挂死"的看门狗。)
7. **workspace grants 的 DB 丢失不可恢复**:grants 只在 SQLite,DB 删后所有本地
   hardlink Run 死亡;启动时与 Desktop 重新配对,或按卷相对形态存储。
8. **journal 全文件重读优化**:SSE 500ms 轮询 × 全量 `read_events`,大 journal 下
   N 连接 × 2 次/秒全量解析;按 `recover_seq`/字节游标做增量投影缓存。
9. **健康端点信息收敛**:`/health`/`/ready` 返回 environment/instance_id,配合无鉴权
   可被指纹;非鉴权响应去掉部署细节。
