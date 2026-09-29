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

## 修复一览(本轮已落地,均有测试)

| # | 命中 | 等级 | 场景(哪一行假设破裂) | 修复 |
|---|---|---|---|---|
| 1 | 浏览器 drive-by RCE | P0 | local 模式无鉴权 + CORS `allow_origins=["*"]`+credentials 反射任意 Origin(main.py 原 105-111):任意网页可 POST 带 `run:` 的 Snakefile,以后端用户身份执行任意代码 | Origin 门卫中间件(非回环 Origin 一律 403 `AUTH_ORIGIN_FORBIDDEN`)+ CORS 收紧为 loopback/null 白名单 |
| 2 | cancel/claim 窗口竞态毒化 journal | P0 | worker `claim_run` 后、projection 读取前,cancel 追加 `run.cancelled`;worker 兜底追加 `run.failed`,而 lifecycle `allowed_from` 不含 CANCELLED → `project_run` 永久 raise,Run 不可读 | `execute_run` 对 CANCELLED 投影做终态无操作(run_worker.py) |
| 3 | 存活孤儿引擎 wedge RUNNING | P1 | 重启瞬间引擎还活着 → reconcile 跳过且无人再管 → Run 永久 RUNNING | reconcile 对无槽主的存活引擎杀树并关闭 range;有活槽主则不动(防 API lifespan 误杀 worker 引擎) |
| 4 | reconcile 只杀 pid 不杀树 | P1 | `TerminateProcess` 引擎 pid,topfd/toppic 子进程继续无主运行、占文件锁 | `_kill_engine_pid` 改 `taskkill /T /F`(POSIX `killpg`,引擎本就 `start_new_session`) |
| 5 | drain 线程 OSError → 7 天占槽 | P1 | 磁盘满杀死输出线程 → 64KB 管道填满 → 引擎 print 阻塞 → 唯一执行槽挂到 7 天 deadline | drain 捕获 OSError 后**继续读管道丢弃**,防死锁 |
| 6 | files API 缺 `trash/` 前缀 | P1 | 通过无主 files API 读写 `trash/runs/<id>/`,可伪造 run.json 后 restore | `trash/` 加入保护前缀(files.py) |
| 7 | SSE 无心跳 | P1 | 长 job 静默一小时,代理/客户端空闲计时器掐线 | 15s 静默即发 `: ping` 注释行 |
| 8 | projection 半写 → dry-run 500 | P2 | 引擎 `write_text` 被杀中途,dry-run `read_json` 抛 JSONDecodeError | 引擎侧 tmp+`os.replace` 原子写;API 侧容错读(解析失败=无 projection,verdict 由 returncode 决定) |

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
   无日志行"看门狗,超限升级为杀树终态。
7. **workspace grants 的 DB 丢失不可恢复**:grants 只在 SQLite,DB 删后所有本地
   hardlink Run 死亡;启动时与 Desktop 重新配对,或按卷相对形态存储。
8. **journal 全文件重读优化**:SSE 500ms 轮询 × 全量 `read_events`,大 journal 下
   N 连接 × 2 次/秒全量解析;按 `recover_seq`/字节游标做增量投影缓存。
9. **健康端点信息收敛**:`/health`/`/ready` 返回 environment/instance_id,配合无鉴权
   可被指纹;非鉴权响应去掉部署细节。

## 已核对为干净的面(证据在测试)

claim 原子性(O_EXCL + 槽 pid 身份)、worker 崩溃必终态、事件追加原子性+fsync+半行修复、
SQLite WAL/busy_timeout、SSE 断连清理与 done 不越界、上传流式哈希、blob GC 可达性、
硬链接物化纪律、路径穿越核心(resolve+normcase 前缀比较,符号链接/UNC/8.3/尾点均覆盖)、
run 级所有权(全部路由过 `_owned_run`)、bearer 常数时间比较与 secret 不落日志。
