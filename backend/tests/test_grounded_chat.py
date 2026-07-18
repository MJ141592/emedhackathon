from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from app.domain.store import SQLiteDemoStore, get_demo_store, utc_now
from app.main import app


@pytest.fixture
def grounded_client(tmp_path: Path) -> tuple[TestClient, SQLiteDemoStore]:
    store = SQLiteDemoStore(tmp_path / "grounded-chat.sqlite3")
    previous = dict(app.dependency_overrides)
    app.dependency_overrides[get_demo_store] = lambda: store
    with TestClient(app) as client:
        yield client, store
    app.dependency_overrides.clear()
    app.dependency_overrides.update(previous)


def _reply(response: object) -> dict[str, object]:
    payload = response.json()  # type: ignore[attr-defined]
    return payload["messages"][-1]


def test_chat_answers_flare_education_from_approved_fixed_guidance(
    grounded_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = grounded_client

    response = client.post("/api/chat", json={"text": "What signs happen in an IBD flare-up?"})

    assert response.status_code == 200
    assert response.json()["entries"] == []
    reply = _reply(response)
    assert reply["category"] == "general information"
    assert "signs vary" in str(reply["text"])
    sources = reply["sources"]
    assert isinstance(sources, list)
    assert sources[0]["type"] == "guidance"
    assert "crohnsandcolitis.org.uk" in sources[0]["url"]


def test_chat_explains_calprotectin_without_diagnosing_a_flare(
    grounded_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = grounded_client

    response = client.post("/api/chat", json={"text": "What does faecal calprotectin measure?"})

    assert response.status_code == 200
    reply = _reply(response)
    assert reply["category"] == "general information"
    assert "stool marker" in str(reply["text"])
    assert "does not diagnose a flare by itself" in str(reply["text"])
    assert reply["sources"][0]["label"] == "NICE: Faecal calprotectin diagnostic tests"


@pytest.mark.parametrize(
    ("permission", "question", "expected"),
    [
        ("assistantProfileAccess", "What medicines am I taking?", "Profile and PMH access is off"),
        ("assistantJournalAccess", "Did that meal cause my symptoms?", "Journal access is off"),
        ("assistantCareAccess", "What is today's steroid dose?", "Care-record access is off"),
        (
            "assistantConversationAccess",
            "What did I tell you earlier?",
            "Earlier-conversation access is off",
        ),
    ],
)
def test_chat_respects_each_grounding_permission(
    grounded_client: tuple[TestClient, SQLiteDemoStore],
    permission: str,
    question: str,
    expected: str,
) -> None:
    client, _ = grounded_client
    changed = client.patch("/api/privacy", json={permission: False})
    assert changed.status_code == 200

    response = client.post("/api/chat", json={"text": question})

    assert response.status_code == 200
    reply = _reply(response)
    assert expected in str(reply["text"])
    assert reply["category"] == "general information"
    assert reply["sources"] == []


def test_chat_returns_only_the_verified_patient_local_dose_when_treatment_is_active(
    grounded_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = grounded_client
    current = store.get()
    patient_today = datetime.now(UTC).astimezone(ZoneInfo(current.profile.timeZone)).date()

    def activate_treatment(state: dict[str, object]) -> None:
        prescription = state["prescription"]
        assert isinstance(prescription, dict)
        prescription.update(
            {
                "status": "collected",
                "treatmentStartedAt": utc_now(),
            }
        )
        taper = state["taper"]
        assert isinstance(taper, dict)
        taper["verified"] = True
        taper["currentDay"] = 13
        days = taper["days"]
        assert isinstance(days, list)
        for index, day in enumerate(days):
            assert isinstance(day, dict)
            day["date"] = (patient_today + timedelta(days=index - 12)).isoformat()

    store.mutate(activate_treatment, "Prepared active taper grounding fixture", actor="test")

    response = client.post("/api/chat", json={"text": "What is today's steroid dose?"})

    assert response.status_code == 200
    reply = _reply(response)
    assert reply["category"] == "recorded fact"
    assert "25 mg" in str(reply["text"])
    assert "prescribed by" in str(reply["text"])
    assert reply["sources"][0]["label"] == "Verified prescribed taper"


def test_chat_capture_takes_precedence_over_question_grounding(
    grounded_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = grounded_client

    response = client.post("/api/chat", json={"text": "I had a loose stool, Bristol 6"})

    assert response.status_code == 200
    assert len(response.json()["entries"]) == 1
    reply = _reply(response)
    assert reply["category"] == "recorded fact"
    assert "editable journal entry" in str(reply["text"])
    assert all(source["type"] == "fact" for source in reply["sources"])
