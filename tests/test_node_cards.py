"""Node cards and the catalog index follow the skill design.

A skill's essence: a one-line description for CHOOSING (the discovery layer)
plus a structured body for USING (the parameter card). The node catalog
mirrors it — `nodes/README.md` is the skill-list equivalent (id + role +
when-to-use per node), each package README carries a `## Parameters` card
(meaning / default / recommendation), and `rules.smk` stays the flag
authority. These tests pin that structure so a node added without its card
or index line fails here, not in a user session.
"""

from __future__ import annotations

from pathlib import Path

from src.services.node_catalog import scan_nodes

ROOT = Path(__file__).resolve().parent.parent
NODES = ROOT / "data" / "backend" / "nodes"
INDEX = NODES / "README.md"


def _live_nodes() -> list[str]:
    nodes, _errors = scan_nodes(NODES)
    return sorted(node["id"] for node in nodes)


def test_catalog_index_lists_every_deployed_node() -> None:
    """The index table (discovery layer) must cover every scanned package."""
    text = INDEX.read_text(encoding="utf-8")
    for node_id in _live_nodes():
        assert f"`{node_id}`" in text, (
            f"node {node_id} is deployed but has no line in nodes/README.md — "
            "add its id/role/use-when row in the same change that adds the package"
        )


def test_every_live_node_has_a_parameter_card() -> None:
    """Each package README must carry the `## Parameters` card."""
    for node_id in _live_nodes():
        readme = (NODES / node_id / "README.md").read_text(encoding="utf-8")
        assert "## Parameters" in readme, (
            f"node {node_id}: README lacks a '## Parameters' card "
            "(meaning / default / recommendation per key)"
        )


def test_index_points_at_live_documents_only() -> None:
    """docs/NODES.md was archived 2026-09-29; the index must not link to it."""
    text = INDEX.read_text(encoding="utf-8")
    assert "](../../../docs/NODES.md)" not in text, (
        "nodes/README.md still links the archived docs/NODES.md "
        "(now at archive/docs-cleanup-2026-09-29/docs/NODES.md)"
    )
