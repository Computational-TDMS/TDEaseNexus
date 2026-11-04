"""Tests for the Snakefile Profile validator (§4.3).

These use the REAL deployed node rules.smk files as fixtures — the §10.1
regression bar. If any deployed node's rules.smk stops passing the Profile,
the frontend DAG can no longer draw it, which is a release blocker.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from src.execution_runtime.profile_validator import validate_snakefile_profile

NODES = Path(__file__).resolve().parent.parent / "data" / "backend" / "nodes"


def _node_rules(node_id: str) -> str:
    return (NODES / node_id / "rules.smk").read_text(encoding="utf-8")


# ── Real deployed nodes ───────────────────────────────────────────────────────

@pytest.mark.parametrize("node_id", [
    "msconvert",
    "topindex",
    "toppic",
    "informed-proteomics",
])
def test_deployed_node_rules_pass_profile(node_id: str) -> None:
    """Every deployed node's rules.smk MUST be inside the static Profile.

    params/threads lambdas and wildcard_constraints are tolerated because
    they do not affect DAG topology. Only input/output literal-ness and the
    presence of a shell directive matter.
    """
    report = validate_snakefile_profile(_node_rules(node_id))
    assert report.valid, (
        f"{node_id}/rules.smk failed Profile (frontend DAG would be unavailable):\n  - " +
        "\n  - ".join(report.errors())
    )


# ── Constructed cases ─────────────────────────────────────────────────────────

def _wrap(shell_body: str = 'echo {input}', **sections: str) -> str:
    """Build a minimal Snakefile rule with the given directive bodies."""
    parts = ["rule synthetic:", "    input:", "        \"in/{sample}.txt\""]
    if shell_body is not None:
        parts += ["    shell:", f"        \"{shell_body}\""]
    return "\n".join(parts) + "\n"


def test_named_io_accepted() -> None:
    snakefile = '''
rule x:
    input:
        mzml = "results/{sample}.mzML",
        fasta = "data/{sample}.fa",
    output:
        out = "results/{sample}.tsv",
    shell:
        """
        cp {input.mzml} {output.out}
        """
'''
    assert validate_snakefile_profile(snakefile).valid


def test_params_lambda_accepted() -> None:
    """params lambda must NOT be a violation — it does not affect topology."""
    snakefile = '''
rule x:
    input:
        "a/{sample}.txt",
    output:
        "b/{sample}.txt",
    params:
        outdir = lambda w: str(Path(w.output[0]).parent),
        fmt = lambda w, cfg=config: cfg.get("x", "mzML"),
    shell:
        """
        tool -o {params.outdir} {input}
        """
'''
    assert validate_snakefile_profile(snakefile).valid


def test_resources_and_threads_lambda_accepted() -> None:
    snakefile = '''
rule x:
    input:
        "a/{sample}.txt",
    output:
        "b/{sample}.txt",
    threads: lambda w, cfg=config: cfg.get("x", 8)
    resources:
        mem_mb = 2048,
    shell:
        """
        tool {input}
        """
'''
    assert validate_snakefile_profile(snakefile).valid


def test_wildcard_constraints_accepted() -> None:
    """Design §4.3 explicitly allows wildcard_constraints."""
    snakefile = '''
wildcard_constraints:
    sample = "[a-z0-9_]+"

rule x:
    input:
        "a/{sample}.txt",
    output:
        "b/{sample}.txt",
    shell:
        """
        cp {input} {output}
        """
'''
    assert validate_snakefile_profile(snakefile).valid


def test_checkpoint_rejected() -> None:
    snakefile = '''
checkpoint gather:
    input:
        "a.txt",
    output:
        "b.txt",
    shell:
        """
        cp {input} {output}
        """
'''
    report = validate_snakefile_profile(snakefile)
    assert not report.valid
    assert any(v.kind == "checkpoint" for v in report.violations)


def test_run_directive_rejected() -> None:
    snakefile = '''
rule x:
    input:
        "a.txt",
    output:
        "b.txt",
    run:
        with open(output[0], "w") as f:
            f.write("hi")
'''
    report = validate_snakefile_profile(snakefile)
    assert not report.valid
    assert any("run" in v.message for v in report.violations)


def test_lambda_in_input_rejected() -> None:
    snakefile = '''
rule x:
    input:
        lambda wildcards: expand("a/{s}.txt", s=SAMPLES),
    output:
        "b.txt",
    shell:
        """
        cat {input} > {output}
        """
'''
    report = validate_snakefile_profile(snakefile)
    assert not report.valid
    assert any(v.kind == "dynamic-input" for v in report.violations)


def test_missing_shell_rejected() -> None:
    snakefile = '''
rule x:
    input:
        "a.txt",
    output:
        "b.txt",
'''
    report = validate_snakefile_profile(snakefile)
    assert not report.valid
    assert any(v.kind == "no-shell" for v in report.violations)


def test_no_rules_rejected() -> None:
    report = validate_snakefile_profile("# just a comment\n")
    assert not report.valid


def test_report_rule_count() -> None:
    snakefile = '''
rule a:
    input: "x"
    output: "y"
    shell: "cp {input} {output}"

rule b:
    input: "y"
    output: "z"
    shell: "cp {input} {output}"
'''
    report = validate_snakefile_profile(snakefile)
    assert report.rule_count == 2
