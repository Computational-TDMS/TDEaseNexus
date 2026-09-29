# TDEase node template — wrap a tool that is installed on this machine.
#
# A node is just this directory: `<dataRoot>/nodes/<id>/rules.smk`. Copy the
# folder, rename it to your tool's id, edit the marked constants, and the
# catalog picks the copy up on the next scan. A Run binds the node by id; the
# Backend injects the package's absolute path into config["nodes"]["<id>"] at
# execution time, and the recorded digest documents which catalog content the
# Run was authored against.
#
# This template covers the case the bundled nodes do not: the tool is already
# installed (vendor installer, site licence, too large or not redistributable),
# so the node packages NO binary — it calls the installed one from the install
# directory. The override key is the same for every node, bundled or not:
#
#   `<node-id>.bin_dir` in the Run's config.yaml — the directory the node's
#   executables are resolved from. Unset: `DEFAULT_BIN_DIR` below.
#
# Resolution happens once, at parse time, so the command line recorded in the
# Run log names the binary that actually ran.
#
# There is no other magic: `shell` is an ordinary command line and the binary
# path is substituted like any other param. Quote the path — install
# directories contain spaces.
#
# Compute declarations, if the tool cares (see docs/spec/WORKFLOW-RUN.md §1):
#   threads:  peak appetite, NOT a reservation. The engine clamps every job's
#             threads to the Run's core budget (min(declared, budget)) at DAG
#             build time — a 28-thread rule on an 8-core budget simply runs
#             with 8 and the resolved value is visible in the dry-run
#             projection. Declare what the tool can usefully consume.
#   resources: hard minima, NOT clamped. mem_mb (and any capped custom
#             resource) that exceeds the Run budget fails the dry-run with a
#             named rule — declare the floor the tool genuinely needs.
#
# Directory names starting with `_` are not nodes: this template and your
# drafts can live in the node root without appearing in the catalog. Rename the
# copy to a normal id (`mytool`, not `_mytool`) to make it live.

from pathlib import Path

# ── EDIT THESE THREE ─────────────────────────────────────────────────────────
# NODE_ID must equal the directory name of the copy.
NODE_ID = "mytool"
# The executable inside the install directory — the node owns the name, so a
# Run only has to name the install location.
EXE_NAME = "mytool.exe"
# Machine-wide default install directory; a Run overrides it with `bin_dir`.
DEFAULT_BIN_DIR = r"C:\Program Files\Vendor\mytool"
# ─────────────────────────────────────────────────────────────────────────────

BIN_DIR = Path((config.get(NODE_ID) or {}).get("bin_dir") or DEFAULT_BIN_DIR)
BINARY = str(BIN_DIR / EXE_NAME)


# Rename the rule too — rule names are the node's capability names and must not
# collide with another node's rules in the same Run.
rule mytool:
    input:
        raw = "{sample}.raw",
    output:
        out = "{sample}.mzML",
    threads:
        4  # appetite: engine clamps to the Run core budget, see header
    resources:
        mem_mb=512,  # hard floor: dry-run rejects a Run whose budget is below it
    params:
        # Inline # comments on params surface verbatim in the node digest the
        # Agent reads — document each knob where it is defined.
        binary = BINARY,
    shell:
        '("{params.binary}" "{input.raw}" --threads {threads} --outfile "{output.out}")'
