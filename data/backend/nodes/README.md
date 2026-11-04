# Node packages (local deployment root)

This tree is **git-ignored by default** (`data/backend/*`): binaries stay out
of git, while the node definition layer (`rules.smk` / `README.md`, including
`_template/`) is tracked through explicit exceptions. Provenance lives in Run
records; the pre-cleanup inventory is archived at
`archive/docs-cleanup-2026-09-29/docs/NODES.md`; current deployment state is
recorded in [`docs/STATUS.md`](../../../docs/STATUS.md).

If this directory is lost or partially deleted, do not guess: redeploy from
the archived inventory and re-verify file counts and key executables before
running any workflow.

## Node catalog

One line per node, like a skill list — the id and role are enough to CHOOSE a
node; the package's README `## Parameters` section is the parameter card
(meaning, default, recommendation), and its `rules.smk` header is the flag
authority calibrated against the binary's own `-?`/`--help`.

| id | 作用 (role) | 何时用 (use when) | 注意 |
|---|---|---|---|
| `msconvert` | vendor raw → centroided mzML (ProteoWizard) | 任何厂商原始文件的入口转换 | 64-bit m/z 精度默认且不应降；host 安装仅经 `bin_dir` 显式选择 |
| `toppic` | TopPIC 1.8 套件：topfd 谱去卷积 + toppic 蛋白形式鉴定 | 现有主链（契约稳定，输出 `_ms2_toppic_*`） | 声明完整 MS1 输出集；MS2-only 数据配 `-o`/`-x`（见 README） |
| `toppic21` | TopPIC 2.1：greedy 去卷积、后质量匹配、ProForma 列 | 需要 2.x 算法时与 `toppic` 二选一绑定 | 输出改 `_post_ms2_toppic_*`；必须有 topfd 的 `.sqlite`；自带 topindex（勿再绑 `topindex` 节点）；无 Qt/GUI |
| `topindex` | 为 Run 级共享库建 TopPIC 查找索引（一次） | 多样本共享一个 FASTA 的批处理 | 磁盘 ≈ 2×FASTA（规划按 4×）；binary 借自 toppic 包 |
| `informed-proteomics` | PbfGen/ProMex/MSPathFinderT 定向交叉验证 | TopPIC 开放搜索后的靶向复核（非替代） | 输出名为经验证契约（`{sample}.ms1ft`、`_IcTarget.tsv`…） |
| `pride` | 从 PRIDE 拉取数据集并校验冻结清单 | 取公开数据进 Workspace | 仅声明文件可信；`files` 必须显式列出 |

Names starting with `_` are templates/drafts and are skipped by the catalog
scanner (`_template/` is the copyable starting point).

## Adding a node

Every directory here containing a `rules.smk` is a node package — the
directory name is the node id, and its content digest pins the node at bind
time. To wrap a tool that is already installed on the machine, copy
`_template/` to `<your-id>/` and follow its README. A new package is picked up
on the next catalog scan; add its line to the table above in the same change.
