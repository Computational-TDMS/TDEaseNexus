---
title: chart-forge --example 静默丢弃组件依赖导致 forgeMs2 is not defined
date: 2026-08-31
module: ai-harness
problem_type: runtime_error
component: chart-forge
symptoms:
  - 生成的图表 HTML 打开即报 "Uncaught ReferenceError: forgeMs2 is not defined"
  - 页面部分渲染(坐标轴/峰线在)但碎片注释组件全部缺失
  - build.py 构建过程零告警,manifest 正常写出
root_cause: missing_dependency_declaration
resolution_type: guard_added
severity: medium
tags: [chart-forge, build-pipeline, ms2-annotation, components, tooltip, verdict-card]
---

# chart-forge --example 静默丢弃组件依赖导致 forgeMs2 is not defined

## Problem

runtime 会话用单行式 `build.py --example copilot-spectrum-evidence --data x.json
-o fig.html` 构建双脂质 MS2 证据图,产物打开即崩:`forgeMs2 is not defined`。
同一 incident 还牵出两个连带缺陷:裁决卡对 null 统计值直接 `.toFixed()` 崩页;
多张保留集模板的 hover 用旧版 micro.js API 调用约定,重建即失效。

## Symptoms

- `Uncaught ReferenceError: forgeMs2 is not defined (fig_cf_scan10876_duallipid.html:427)`
- 构建日志完全干净(0 告警),manifest 正常产出 —— 静默失败
- 修复组件后又暴露 `Cannot read properties of null (reading 'toFixed')`(裁决卡)

## What Didn't Work

- 只修用户报告的那一张图 —— 同批另一张(10876)带着同样的潜伏 null 崩溃,
  错误横幅(页面自报错)在复验时立刻把它揪了出来
- 正则宽匹配改源码 —— 曾把三份脚本粘连损坏,被迫 `git checkout` 回滚,
  连带丢掉了同文件里未提交的其他改动(教训:大改用落盘补丁脚本 + Write 工具,
  不用 heredoc;checkout 前先确认该文件没有别的未提交工作)

## Solution

三层修复,全部落在 chart-forge 内:

1. **每个示例目录声明自己的依赖** —— `build.json`:
   ```json
   {"bundle": "d3", "scripts": ["../../components/ms2-annotation.js"]}
   ```
   `--example NAME` 解析它并自动注入 `--script`。已为全部 8 个有外部依赖的
   示例补齐(ms2-annotation 组件 / crameri 色阶 / nature 预设 / 3dmol bundle)。

2. **build.py 缺提供者守卫** —— 拼装 chart 代码后,若引用了已知伴随全局
   (`forgeMs2`/`batlow`/`vik`/…) 而提供脚本未注入,构建当场失败并指明补救:
   ```
   chart references 'forgeMs2' but its provider was not injected —
   add --script <path> or a build.json scripts entry
   ```
   负向测试实测通过。守卫前先剥离 JS 注释,避免头注释误报。

3. **裁决卡容错** —— `copilot-spectrum-evidence` 的 verdict card 对缺失统计
   显示 "—"(缺失统计诚实可见),不再 `.toFixed()` 崩整页。

连带清偿:hover 旧 API 债。`micro.js` 的 `showTip(tip选集, event, html)` 签名
变更后,两棵树(system 16 模板 + .agents 50 模板)共 9 个 chart.js 仍用旧
约定(`showTip(目标元素, x, y, html)` + 裸 `hideTip`),重建即 hover 全灭。
全量审计(含 `e.target` 模式,第一轮扫描曾漏)后统一迁移,双树 old-API 调用
归零。

## Why This Works

- `build.json` 让依赖声明与示例同目录共存,单行构建不再有信息缺口;
- 守卫把"静默产出坏图"变成"构建即报错并给出补救",失败前移到成本最低的点;
- 错误横幅(base.html 的 window.onerror → 页面红条)让运行期崩溃在打开瞬间
  可见 —— 本次第二个 bug(裁决卡 null)正是靠它在复验时现形。

## Follow-up (same day): lookalike contracts mislead

The runtime session ALSO built `fig_cf_scan*` figures against the
copilot-spectrum-evidence example with a **partial hand-rolled contract** —
right keys ({peaks, residues, tolerance_ppm, evidence}), wrong depth: stems
fell back to grey (no ion fields), annotation labels did not track zoom,
hover linkages (component 3-way sync) were absent. It looked close enough to
be mistaken for the real template. **A lookalike that renders similarly but
loses function is worse than not building** — users trust a broken figure.

Rule: reuse must be FUNCTIONAL. For annotated MS2 from the kernel, the
correct adapter is `fragment_spectrum_html.py` (kernel match -> full IPSA
contract, wheel/drag zoom re-renders annotations, tokens lineage). The
misleading `fig_cf_*` files were deleted; the v3 fragment_spectrum_html
outputs are the deliverables.

## Prevention

- 新增示例若引用组件/色阶,必须写 `build.json`(build.py 守卫会兜底报错);
- 模板对契约中的可缺字段一律 `null → "—"`,不允许裸 `.toFixed()`/`.slice()`;
- 改 micro.js 公共 API 时,必须全量 grep 两棵树的调用方并同步迁移;
- 用 `git checkout --` 丢弃文件前,确认该文件没有其他未提交改动 —— 先
  `git diff` 后再决定是 checkout 还是落盘补丁。
