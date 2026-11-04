# topindex

TopIndex is the database-indexing stage of the deployed TopPIC 1.8.0 suite.
It turns one FASTA file into the adjacent `<fasta>_idx/` directory before any
sample-level TopPIC search starts.

This is a separate Node because the index belongs to the Run-wide protein
database, while TopPIC jobs belong to individual samples. With the dependency
made explicit, Snakemake schedules one `topindex` job and then fans out to all
sample-level `toppic` jobs. TopPIC is no longer allowed to race while implicitly
creating the same directory from several processes.

## Runtime asset

The executable is part of the server's deployed `toppic` runtime suite and is
resolved relative to the Run root: `nodes/toppic/topindex.exe` on Windows,
`nodes/toppic/topindex` on Linux (the same rule file picks by host). A workflow
using this Node binds both `topindex` and `toppic`, so the runtime suite and
this rule contract are both pinned by Backend Node digests.

## Parameters

The rule reads the Run's `toppic:` config block for the search-space keys —
the index must be built over the SAME space the toppic jobs search, which is
why the keys are shared rather than duplicated:

| key (block) | 含义 | 默认 | 建议 |
|---|---|---|---|
| `toppic.fixed_mod` | 固定修饰定义文件 | 无（不加） | 仅在鉴定流程同样使用时设置 |
| `toppic.n_terminal_form` | 蛋白 N 端形式集合 | `NONE,NME,NME_ACETYLATION,M_ACETYLATION` | 与 toppic 作业保持一致 |
| `toppic.decoy` | 同时构建 decoy 索引 | `false` | 仅 decoy 检索流程开启 |
| `toppic.mass_error_tolerance` | 前驱质量误差 (PPM，裸整数) | `10` | 顶层常规 `10`；勿写 `"10ppm"` |
| `topindex.extra` | 直通 `topindex.exe` 的额外旗标 | 空 | 记录进 Run 证据 |
| `topindex.bin_dir` | topindex.exe 所在目录覆盖 | 绑定的 toppic 包目录 | host 安装时显式指定 |

## Disk budget

`<fasta>_idx/` ≈ **2 × FASTA 大小**（内含 `_standard` + `_target` 两份完整
数据库拷贝）+ 随蛋白数缩放的变换块文件。实测锚点：40 蛋白 / 6,201 残基 /
9.7 KiB FASTA → 30 KiB（≈5 字节/残基，3.1×）。规划按 **4 × FASTA** 预算每
Run；66 MB 库（13.4 万蛋白）≈ 250 MB。索引随触及 FASTA 或上述搜索空间键
的修订而重建，不复用。内存下限 `mem_mb = 2048`（下限不钳制，Run 预算不足
时 dry-run 具名失败）。

## Contract

- Input: the Run's configured FASTA (`config.fasta`, default `database.fasta`).
- Native output: `<fasta>_idx/`.
- Declared completion output: `.tdease/topindex/<fasta>.complete`.
- Shared parameters: `toppic.fixed_mod`, `toppic.n_terminal_form`,
  `toppic.decoy`, and `toppic.mass_error_tolerance`.
- Node-only escape hatch: `topindex.extra`.

The completion marker is written only after `topindex.exe` exits successfully.
TopPIC consumes that marker as a normal Snakemake input, so filesystem state
remains the execution authority.

If a previous attempt stopped before writing the marker, the next attempt
removes the incomplete `<fasta>_idx/` and rebuilds it. The cleanup is scoped to
the Backend Run snapshot and never touches the Client Workspace FASTA.
