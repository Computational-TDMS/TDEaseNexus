---
type: design
title: Hypothesis evidence lattice — the typed contract between mass, composition, and identity
status: accepted (2026-08-27, full lattice — option A; implemented same day)
---

# 假设证据格（Evidence Lattice）：质量 → 组成 → 身份

> 状态：**已接受（2026-08-27，全格方案 A）并当日落地**。内核：碎片类命令
> 恢复数值标签（`hypothesisType` 标记 + averagine 包络降级声明），
> `validate-precursor` 补上显式拒绝；quantify 以 `--delta` 为主入口；
> spec §Public operations 改为格表；守护测试新增
> `test_evidence_lattice_holds_on_the_live_binary` 行为断言。原始提案正文
> 保留在下方作为裁决依据。

## 0. 问题本质

两轮自动收敛（另一个会话与本会话）都在回答同一个问题——**"工具应当接受多么
完整的假设作为输入？"**——但都在用打补丁的方式裁决：审计发现一处就收紧一处，
另一处崩了就迁移一处。既视感循环的根源不是执行不力，而是**这个契约从未从
科学事实出发被推导过一次**。

成功判据：给定科学事实与数据处理目标，存在一个**无需再争论**的输入准入规则，
使得 (a) 每个科学有效的测量都能表达，(b) 每个"证据不足却下身份结论"的通道都
被类型系统挡住，(c) 守护测试断言的是不变式而非当时的裁决。

## 1. 科学事实（Ground Truths，不可违背）

**G1 — 质量永远不能唯一确定化学。** 一个 delta 质量对应无限多组元素组成；
数据库命中（UniMod）是候选生成，不是身份。这是全项目 "notIdentity" 纪律的
物理基础。

**G2 — 同位素包络形状只依赖元素组成。** M+1 比例 ∝ C/N/S 计数，M+2 特征
（O/S/Cl/Br）由重同位素丰度决定。Br/Cl 的 M+2 双峰判别之所以成立，正是因为
它读取的是**组成**而非质量。⇒ 任何以包络形状为输出的计算，最低输入是组成。

**G3 — 碎片离子 m/z 只依赖各位置上的 delta 质量之和，与修饰的元素组成无关。**
fragment m/z = Σ(残基) + Σ(该跨度内 delta) + 端基/电荷。一个 +42.0106 的
Acetyl（C2H2O）与任何同 delta 的组成，产生**完全相同**的 b/c/y/z 梯子。
⇒ 定位（localization）与位置异构体定量（positional-isomer quantification）
的最低输入是 **delta + 位点**，不是组成。

**G4 — 碎片的同位素精细结构依赖组成**（per-fragment BRAIN 包络）。用包络感知
匹配去聚碎片峰时，组成才成为必需；只用 M0 梯子时不需要。

**G5 — 中性丢失化学依赖位点上的修饰化学。** 质量标签不含可推断的化学，故
丢失要么来自组成/命名标签的门控，要么由调用方**显式声明**（site-scoped
named loss——现有设计，正确）。

**G6 — 位置异构体同组成、同 delta、不同位置。** 唯一可区分的证据是跨越位点
的碎片梯子（c/y ladder）；比例由相邻累积法（adjacent-cumulative ratios）从
位点跨越片段强度推出。定量对"是哪个化学"完全无感。

**G7 — 测量与裁决是两个动作。** 测量（某个 delta 在哪些位点、比例多少）可以
在化学未知时精确完成；裁决（这是 Acetyl 吗）需要组成 + 定位 + 定量 + 同源
证据的合取。把两者耦合，要么浪费证据，要么伪造结论。

## 2. 由此导出的证据格

```
身份 identity        ⊃ 组成 composition      ⊃ 质量 mass
(Acetyl)               (Formula:C2H2O)          (+42.010565)
命名标签               公式标签                  数值标签
```

- **能提出（generate）**：质量即可（UniMod/resolve-shift 候选，G1）。
- **能用包络判别（discriminate by shape）**：组成必需（G2）。
- **能定位/定量位置（localize & quantify positions）**：质量即可（G3/G6）。
- **能裁决身份（adjudicate identity）**：组成 + 定位 + 定量 + 佐证（G7），
  这是 Skill 层的判断原则，不是任何单一工具的输出。

**推论（本提案的核心）**：输入契约应当**跟随输出声明**，而不是全局一刀切：
- 输出只断言 m/z 梯子/位置比例 ⇒ 接受质量格输入，输出标记 `hypothesisType: "massDelta"`；
- 输出断言同位素形状 ⇒ 要求组成格（或显式降级为 averagine 近似并标记）；
- 输出断言身份 ⇒ 走裁决链，工具永不单独签发。

## 3. 对既有裁决的逐条检验

| 今晚落地的裁决 | 格检验 | 结论 |
|---|---|---|
| theory 拒绝数值标签 | theory 的产品是包络形状（G2） | **保留**，正确 |
| validate-precursor 要求完整 ProForma | MS1 前体验证是包络检验（G2） | **保留**，正确 |
| fit-envelope 无 offset 参数 | 拟合的是固定锚定模型，offset 是索引不是质量 | **保留**，正确 |
| fragment match/compare 拒绝数值标签（早于今晚） | 比较的输出是 m/z 匹配表（G3） | **翻案**：应接受数值标签，输出标记 massDelta；其 per-fragment 包络子输出在无组成时省略（`--no-envelope` 语义自动生效）或降级 averagine 并标记 |
| fragment-theoretical 拒绝数值标签（今晚新增） | 同上（G3/G4） | **翻案**：梯子只需 delta；同上处理包络子输出 |
| quantify 强制 `--mod-tag`（今晚） | 定量的最低输入是 delta（G6）；组成只是包络感知匹配的可选增强（G4） | **修订**：`--delta`（质量格）为主入口；`--mod-tag`（组成/命名格）可选，用于开启包络感知簇匹配；输出携带实际使用的格 |
| refine-shift 保留数值校准遗留路径 | 校准不是裁决（spec §Deprecated） | **保留**，正确 |
| 中性丢失 site-scoped 声明式设计 | G5 | **保留**，正确——spec §Neutral losses 里"mass-only tag 是比较的表示"那句 rationale 本来就是对的，被后来的收紧背叛了 |

## 4. AI 调用范式（与 Occam 边界对齐）

- **工具（Rust 内核）**：确定性计算 + **格准入校验**（稳定不变式 → 代码）。
  每个输出的 envelope 携带 `hypothesisType: massDelta | composition | named`
  与 `notIdentity`，让下游永远知道被检验的是哪一格。
- **Skill**：判断原则——**哪一格证据足以支撑哪一类结论**（时机性策略 → 提示词）。
  "异构体比例结论至少需要 massDelta 定量 + 组成判别"、"身份结论需要合取链"
  写在这里，不写进工具。
- **Agent**：注意力与阶段选择——按 证据格阶梯 推进
  census(质量) → 候选(质量) → 包络判别(组成) → 定位(质量) → 定量(质量)
  → 裁决(合取)。未知残差（+14/+16/+30 类）在质量格即可测量与排队，
  不再被迫先虚构一个组成。

**流程事实（今晚的教训）**：两个写者同时在一个工作树上收敛，是既视感循环的
放大器。运行规则应当是：一棵树同一时刻只有一个收敛写者；审计结果落
STATUS/solutions 后才轮到下一个会话。

## 5. 落地路径（若接受）

1. 内核：`fragment-theoretical` / `fragment` 恢复数值标签（warning +
   `hypothesisType: "massDelta"`；无组成时包络子输出按 `--no-envelope` 语义）。
   theory / validate-precursor / fit-envelope 的收紧不动。
2. quantify：`--delta` 主入口 + `--mod-tag` 增强；输出记录格。测试回迁
   （heavy_val 用例可回到纯 delta 形态）。
3. spec：§Public operations 表改为**格表**（每操作标注最低输入格），删除与
   §Neutral losses rationale 的矛盾；守护测试改为断言格不变式
   （"断言形状的操作不接受 massDelta"），而非全量禁令。
4. STATUS：裁决记录改为引用本格；open items 的守卫债务不变。

## 6. 已承认的权衡

- 数值标签重新入内意味着"agent 拿 delta 就能跑碎片"——滥用的风险由
  `hypothesisType` 标记 + Skill 层充分性原则承担，而不是由输入禁令承担。
- averagine 降级路径是近似，必须显著标记，防止被当作形状证据引用。
- 本提案部分推翻今晚已提交的行为（fragment 类两处 + quantify 接口），
  需要一轮小步回改与 spec/守护测试同步——代价明确且有界。
