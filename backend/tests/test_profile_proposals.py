from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.domain.store import SQLiteDemoStore, get_demo_store
from app.main import app


@pytest.fixture
def proposal_client(tmp_path: Path) -> tuple[TestClient, SQLiteDemoStore]:
    store = SQLiteDemoStore(tmp_path / "profile-proposals.sqlite3")
    previous = dict(app.dependency_overrides)
    app.dependency_overrides[get_demo_store] = lambda: store
    with TestClient(app) as client:
        yield client, store
    app.dependency_overrides.clear()
    app.dependency_overrides.update(previous)


def _state(client: TestClient) -> tuple[dict[str, Any], str]:
    response = client.get("/api/demo")
    assert response.status_code == 200
    return response.json(), response.headers["etag"]


def test_deterministic_capture_extracts_typed_pmh_proposals_without_journal_mutation(
    proposal_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = proposal_client
    parsed = client.post(
        "/api/capture/parse",
        json={
            "text": "I'm allergic to sulfasalazine and I was diagnosed with coeliac disease"
        },
    )
    assert parsed.status_code == 200
    assert parsed.json()["entries"] == []
    assert parsed.json()["profileProposals"] == [
        {"field": "allergies", "value": "sulfasalazine"},
        {"field": "conditions", "value": "coeliac disease"},
    ]
    explicit_condition = client.post(
        "/api/capture/parse", json={"text": "I have osteoporosis"}
    )
    assert explicit_condition.json()["profileProposals"] == [
        {"field": "conditions", "value": "osteoporosis"}
    ]


def test_chat_proposal_requires_patient_acceptance_before_updating_profile(
    proposal_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = proposal_client
    before, _ = _state(client)
    original_allergies = before["profile"]["allergies"]

    chatted = client.post("/api/chat", json={"text": "I'm allergic to sulfasalazine"})
    assert chatted.status_code == 200
    proposal = chatted.json()["profileProposals"][0]
    assert proposal["field"] == "allergies"
    assert proposal["value"] == "sulfasalazine"
    assert proposal["status"] == "pending"

    pending, _ = _state(client)
    assert pending["profile"]["allergies"] == original_allergies
    assert proposal["sourceMessageId"] in {
        message["id"] for message in pending["messages"] if message["from"] == "me"
    }

    accepted = client.patch(
        f"/api/profile/proposals/{proposal['id']}", json={"status": "accepted"}
    )
    assert accepted.status_code == 200
    assert accepted.json()["status"] == "accepted"
    after, _ = _state(client)
    assert after["profile"]["allergies"] == f"{original_allergies}; sulfasalazine"
    assert client.patch(
        f"/api/profile/proposals/{proposal['id']}", json={"status": "dismissed"}
    ).status_code == 409


def test_dismiss_and_disabled_profile_access_never_change_pmh(
    proposal_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = proposal_client
    original, _ = _state(client)
    original_conditions = original["profile"]["conditions"]
    proposal = client.post(
        "/api/chat", json={"text": "I was diagnosed with coeliac disease"}
    ).json()["profileProposals"][0]
    dismissed = client.patch(
        f"/api/profile/proposals/{proposal['id']}", json={"status": "dismissed"}
    )
    assert dismissed.status_code == 200
    after_dismissal, _ = _state(client)
    assert after_dismissal["profile"]["conditions"] == original_conditions

    privacy = client.patch("/api/privacy", json={"assistantProfileAccess": False})
    assert privacy.status_code == 200
    blocked = client.post("/api/chat", json={"text": "I used to take methotrexate"})
    assert blocked.status_code == 200
    assert blocked.json()["profileProposals"] == []
    assert "profile access is off" in blocked.json()["messages"][-1]["text"].lower()


def test_snapshot_rejects_forged_or_silently_accepted_pmh_proposals(
    proposal_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = proposal_client
    state, etag = _state(client)
    source_id = max(message["id"] for message in state["messages"]) + 1
    created_at = "2026-07-17T10:30:00.000Z"
    state["messages"].append(
        {
            "id": source_id,
            "from": "me",
            "text": "I'm allergic to sulfasalazine",
            "createdAt": created_at,
            "sources": [],
        }
    )
    state["profileProposals"].append(
        {
            "id": 991,
            "field": "allergies",
            "value": "forged different wording",
            "sourceMessageId": source_id,
            "status": "pending",
            "createdAt": created_at,
        }
    )
    forged = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert forged.status_code == 409
    assert "deterministic extraction" in forged.json()["detail"]

    state["profileProposals"][0]["value"] = "sulfasalazine"
    state["profileProposals"][0]["status"] = "accepted"
    silently_accepted = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert silently_accepted.status_code == 409
