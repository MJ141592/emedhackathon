from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path
from threading import Barrier, Lock
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.domain.store import SQLiteDemoStore, get_demo_store
from app.main import app


@pytest.fixture
def client_and_store(tmp_path: Path) -> tuple[TestClient, SQLiteDemoStore]:
    store = SQLiteDemoStore(tmp_path / "adversarial-safety.sqlite3")
    previous = dict(app.dependency_overrides)
    app.dependency_overrides[get_demo_store] = lambda: store
    with TestClient(app) as client:
        yield client, store
    app.dependency_overrides.clear()
    app.dependency_overrides.update(previous)


def snapshot(client: TestClient) -> tuple[dict[str, Any], str]:
    response = client.get("/api/demo")
    assert response.status_code == 200
    return response.json(), response.headers["etag"]


@pytest.mark.parametrize(
    ("body", "trigger"),
    [
        ("I blacked out", "faintness or collapse"),
        ("The abdominal pain is unbearable", "severe abdominal pain"),
        ("I passed large blood clots", "heavy or continuous bleeding"),
        ("I have no stool or wind and keep throwing up", "bowel obstruction"),
        ("I can’t keep anything down", "dehydration"),
    ],
)
def test_manual_body_text_is_always_screened(
    client_and_store: tuple[TestClient, SQLiteDemoStore], body: str, trigger: str
) -> None:
    client, _ = client_and_store
    response = client.post(
        "/api/journal",
        json={"kind": "WELLBEING", "body": body, "source": "manual"},
    )

    assert response.status_code == 201, response.text
    assert response.json()["flagged"] is True
    state, _ = snapshot(client)
    assert any(trigger in item.casefold() for item in state["safetyAlert"]["triggers"])


@pytest.mark.parametrize(
    "body",
    [
        "I did not black out",
        "I have no large blood clots",
        "The pain is not unbearable",
        "I can pass stool and wind and I am not vomiting",
    ],
)
def test_direct_negations_do_not_create_false_alerts(
    client_and_store: tuple[TestClient, SQLiteDemoStore], body: str
) -> None:
    client, _ = client_and_store
    response = client.post(
        "/api/journal",
        json={"kind": "WELLBEING", "body": body, "source": "manual"},
    )

    assert response.status_code == 201, response.text
    assert response.json()["flagged"] is False
    state, _ = snapshot(client)
    assert state["safetyAlert"] is None


@pytest.mark.parametrize(
    ("body", "trigger"),
    [
        ("I've had 12 bowel movements today", "very high bowel output"),
        ("I've had diarrhoea 12 times today", "very high bowel output"),
        ("I've had 12 stools in 24 hours", "very high bowel output"),
        ("Ten loose stools today", "very high bowel output"),
        ("My bleeding will not stop", "heavy or continuous bleeding"),
        ("I cannot stop being sick", "persistent vomiting"),
        ("I have been sick all day", "persistent vomiting"),
        ("I have vomited six times today", "persistent vomiting"),
        ("I have severe bloating and cannot poo", "possible bowel obstruction"),
        ("I have had a dozen bowel movements today", "very high bowel output"),
        ("My pain is nine out of ten", "severe abdominal pain"),
        ("My stomach pain is eight out of ten", "severe abdominal pain"),
        ("I have 9 out of 10 stomach pain", "severe abdominal pain"),
        ("It is 9/10 abdominal pain", "severe abdominal pain"),
        ("I am vomiting and my belly is swollen", "possible bowel obstruction"),
        ("I am vomiting and my abdomen is swollen", "possible bowel obstruction"),
        ("My temperature is 102°F", "fever"),
        ("My temperature is 39 degrees", "fever"),
    ],
)
def test_natural_language_red_flags_reach_the_deterministic_screen(
    client_and_store: tuple[TestClient, SQLiteDemoStore], body: str, trigger: str
) -> None:
    client, _ = client_and_store

    response = client.post("/api/chat", json={"text": body})

    assert response.status_code == 200, response.text
    assert response.json()["safety"]["urgent"] is True
    state, _ = snapshot(client)
    assert any(trigger in item.casefold() for item in state["safetyAlert"]["triggers"])


@pytest.mark.parametrize(
    ("body", "expected_kind"),
    [
        ("I've had 12 bowel movements today", "BOWEL MOVEMENT"),
        ("I have heavy bleeding in my stool", "BOWEL MOVEMENT"),
        ("My abdominal pain is 9/10", "PAIN"),
        ("My stomach pain is nine out of ten", "PAIN"),
    ],
)
def test_red_flag_capture_keeps_the_canonical_symptom_series(
    client_and_store: tuple[TestClient, SQLiteDemoStore], body: str, expected_kind: str
) -> None:
    client, _ = client_and_store

    response = client.post("/api/chat", json={"text": body})

    assert response.status_code == 200, response.text
    assert response.json()["safety"]["urgent"] is True
    assert response.json()["entries"][0]["kind"] == expected_kind


@pytest.mark.parametrize(
    "body",
    [
        "I've had 9 bowel movements today",
        "I have not had 12 bowel movements today; I only had two",
        "Is 12 bowel movements in 24 hours dangerous?",
        "I have not vomited six times today; I was not sick",
        "I had diarrhoea 12 times last month",
        "I had diarrhoea 12 times over 3 days",
        "Last year I had diarrhoea 12 times during a bowel prep",
        "My pain is not nine out of ten",
        "My temperature is not 102°F",
        "I am vomiting but my belly is not swollen",
    ],
)
def test_bounded_counts_and_questions_do_not_become_false_red_flags(
    client_and_store: tuple[TestClient, SQLiteDemoStore], body: str
) -> None:
    client, _ = client_and_store

    response = client.post("/api/chat", json={"text": body})

    assert response.status_code == 200, response.text
    assert response.json()["safety"] is None
    state, _ = snapshot(client)
    assert state["safetyAlert"] is None


@pytest.mark.parametrize("field", ["medicine", "prescriber", "pharmacy"])
def test_snapshot_cannot_rewrite_clinician_authored_prescription_identity_or_routing(
    client_and_store: tuple[TestClient, SQLiteDemoStore], field: str
) -> None:
    client, _ = client_and_store
    state, etag = snapshot(client)
    original = state["prescription"][field]
    state["prescription"][field] = "Patient-supplied unverified replacement"

    response = client.put("/api/demo", headers={"If-Match": etag}, json=state)

    assert response.status_code == 200, response.text
    persisted, _ = snapshot(client)
    assert persisted["prescription"][field] == original


def test_concurrent_journal_creates_return_an_explicit_conflict_instead_of_losing_data(
    client_and_store: tuple[TestClient, SQLiteDemoStore], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, store = client_and_store
    original_get = store.get_with_revision
    barrier = Barrier(2)
    lock = Lock()
    calls = 0

    def synchronized_get() -> tuple[Any, int]:
        nonlocal calls
        result = original_get()
        with lock:
            calls += 1
            should_wait = calls <= 2
        if should_wait:
            barrier.wait(timeout=5)
        return result

    monkeypatch.setattr(store, "get_with_revision", synchronized_get)
    payloads = [
        {"kind": "WELLBEING", "body": "Concurrent entry A", "source": "manual"},
        {"kind": "WELLBEING", "body": "Concurrent entry B", "source": "manual"},
    ]
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(
            executor.map(
                lambda payload: client.post("/api/journal", json=payload), payloads
            )
        )

    assert sorted(response.status_code for response in responses) == [201, 409]
    assert all(response.status_code != 500 for response in responses)
    stored_bodies = {entry.body for entry in store.get().entries}
    assert len(stored_bodies.intersection({"Concurrent entry A", "Concurrent entry B"})) == 1


def test_profile_writer_paused_before_delete_all_cannot_resurrect_patient_data(
    client_and_store: tuple[TestClient, SQLiteDemoStore], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, store = client_and_store
    original_get = store.get_with_revision
    read_complete = Barrier(2)
    allow_profile_write = Barrier(2)
    lock = Lock()
    first_read = True

    def paused_profile_read() -> tuple[Any, int]:
        nonlocal first_read
        result = original_get()
        with lock:
            should_pause = first_read
            first_read = False
        if should_pause:
            read_complete.wait(timeout=5)
            allow_profile_write.wait(timeout=5)
        return result

    monkeypatch.setattr(store, "get_with_revision", paused_profile_read)
    with ThreadPoolExecutor(max_workers=1) as executor:
        stale_profile = executor.submit(
            client.patch,
            "/api/profile",
            json={"conditions": "This stale condition must never be resurrected"},
        )
        read_complete.wait(timeout=5)
        deleted = client.delete("/api/data")
        assert deleted.status_code == 200, deleted.text
        allow_profile_write.wait(timeout=5)
        stale_response = stale_profile.result(timeout=5)

    assert stale_response.status_code == 409, stale_response.text
    persisted, _ = snapshot(client)
    assert persisted["profile"]["name"] == ""
    assert persisted["profile"]["conditions"] == ""
    assert persisted["profile"]["onboardingComplete"] is False
    assert persisted["entries"] == []
    assert persisted["messages"] == []
    exported = client.get("/api/export")
    assert exported.status_code == 200
    exported_state = exported.json()["data"]
    assert exported_state["profile"]["conditions"] == ""
    assert exported_state["entries"] == []


def test_snapshot_cannot_downgrade_server_authored_safety(
    client_and_store: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = client_and_store
    created = client.post(
        "/api/journal",
        json={"kind": "WELLBEING", "body": "I collapsed", "source": "manual"},
    )
    assert created.status_code == 201
    state, etag = snapshot(client)
    source_id = created.json()["id"]
    next(entry for entry in state["entries"] if entry["id"] == source_id)["flagged"] = False
    state["safetyAlert"].update(
        {
            "level": "same-day",
            "triggers": [],
            "message": "No action is needed.",
            "sourceEntryIds": [],
            "unlinkedTriggers": [],
        }
    )

    response = client.put("/api/demo", headers={"If-Match": etag}, json=state)

    assert response.status_code == 200, response.text
    accepted = response.json()
    assert accepted["safetyAlert"]["level"] == "emergency"
    assert any(
        "faintness or collapse" in trigger.casefold()
        for trigger in accepted["safetyAlert"]["triggers"]
    )
    assert next(entry for entry in accepted["entries"] if entry["id"] == source_id)[
        "flagged"
    ] is True


def test_changed_existing_record_is_rescreened_by_server(
    client_and_store: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = client_and_store
    state, etag = snapshot(client)
    entry = next(
        item
        for item in state["entries"]
        if item["source"] == "manual" and item["kind"] in {"WELLBEING", "PAIN"}
    )
    entry.update(
        {
            "body": "Correction: I blacked out with unbearable abdominal pain",
            "structured": {},
            "flagged": False,
        }
    )
    state["phaseConfirmed"] = False
    state["safetyAlert"] = None

    response = client.put("/api/demo", headers={"If-Match": etag}, json=state)

    assert response.status_code == 200, response.text
    accepted = response.json()
    saved = next(item for item in accepted["entries"] if item["id"] == entry["id"])
    assert saved["flagged"] is True
    assert accepted["safetyAlert"]["level"] == "emergency"
    assert entry["id"] in accepted["safetyAlert"]["sourceEntryIds"]


@pytest.mark.parametrize("bad_date", ["not-a-date", "9999-01-01", "1899-12-31"])
def test_invalid_or_unbounded_journal_dates_are_rejected(
    client_and_store: tuple[TestClient, SQLiteDemoStore], bad_date: str
) -> None:
    client, _ = client_and_store
    response = client.post(
        "/api/journal",
        json={
            "date": bad_date,
            "time": "12:00",
            "kind": "MEAL",
            "body": "Date validation probe",
            "source": "manual",
        },
    )
    assert response.status_code == 422


@pytest.mark.parametrize(
    "preview_url",
    [
        "https://tracker.example/sensitive.png",
        "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
        "data:image/jpeg;base64,%%%not-base64%%%",
    ],
)
def test_photo_payload_rejects_remote_svg_and_invalid_data(
    client_and_store: tuple[TestClient, SQLiteDemoStore], preview_url: str
) -> None:
    client, _ = client_and_store
    response = client.post(
        "/api/journal",
        json={
            "date": date.today().isoformat(),
            "time": "12:00",
            "kind": "MEAL",
            "body": "Photo validation probe",
            "source": "manual",
            "photo": {
                "name": "probe.png",
                "previewUrl": preview_url,
                "purpose": "meal",
                "retentionDays": 7,
                "consented": True,
            },
        },
    )
    assert response.status_code == 422
