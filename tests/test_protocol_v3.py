from __future__ import annotations

import pytest
from pydantic import ValidationError

from src.contracts.event import Event
from src.contracts.enums import EventType
from src.contracts.lifecycle_declaration import LIFECYCLE_SCHEMA_VERSION
from src.execution_runtime.events import EventEmitter
from src.execution_runtime.storage import StorageLayout, set_storage


def test_event_contract_uses_the_shared_lifecycle_schema_version() -> None:
    event = Event(run_id="run-v3", seq=1, type=EventType.RUN_SUBMITTED)
    assert LIFECYCLE_SCHEMA_VERSION == 3
    assert event.schema_version == LIFECYCLE_SCHEMA_VERSION

    with pytest.raises(ValidationError):
        Event(
            schema_version=2,
            run_id="run-v3",
            seq=1,
            type=EventType.RUN_SUBMITTED,
        )


def test_event_emitter_persists_the_shared_lifecycle_schema_version(tmp_path) -> None:
    storage = StorageLayout(tmp_path / "backend")
    storage.bootstrap()
    set_storage(storage)

    EventEmitter("run-v3").run_submitted("revision-v3")

    [event] = storage.read_events("run-v3")
    assert event["schema_version"] == LIFECYCLE_SCHEMA_VERSION
