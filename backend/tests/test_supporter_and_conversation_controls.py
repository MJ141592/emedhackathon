from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.domain.store import SQLiteDemoStore, get_demo_store
from app.main import app


@pytest.fixture
def control_client(tmp_path: Path) -> tuple[TestClient, SQLiteDemoStore]:
    store = SQLiteDemoStore(tmp_path / "supporter-conversation.sqlite3")
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


def _enable_supporter(client: TestClient, **permissions: bool) -> dict[str, Any]:
    response = client.patch(
        "/api/trusted-supporter",
        json={
            "enabled": True,
            "name": "Maya Johnson",
            "relationship": "Sister",
            "canViewSummary": permissions.get("canViewSummary", False),
            "canSeeReminders": permissions.get("canSeeReminders", False),
            "canHelpLog": permissions.get("canHelpLog", False),
        },
    )
    assert response.status_code == 200
    return response.json()


def test_supporter_code_is_revocable_and_view_omits_disallowed_scopes(
    control_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = control_client
    _enable_supporter(client, canSeeReminders=True)

    invitation = client.post("/api/trusted-supporter/invitation")
    assert invitation.status_code == 200
    assert invitation.headers["etag"]
    code = invitation.json()["accessCode"]
    assert len(code) >= 8

    wrong = client.post(
        "/api/trusted-supporter/access", json={"accessCode": "wrong-code"}
    )
    assert wrong.status_code == 403

    access = client.post(
        "/api/trusted-supporter/access", json={"accessCode": code}
    )
    assert access.status_code == 200
    scoped = access.json()
    assert scoped["simulation"] is True
    assert scoped["supporterName"] == "Maya Johnson"
    assert scoped["permissions"] == {
        "canViewSummary": False,
        "canSeeReminders": True,
        "canHelpLog": False,
    }
    assert "summary" not in scoped
    assert "reviewableLogs" not in scoped
    assert scoped["reminders"]

    forbidden_log = client.post(
        "/api/trusted-supporter/log",
        json={"accessCode": code, "text": "Matthew had pain 5 out of 10 after lunch."},
    )
    assert forbidden_log.status_code == 403

    revoked = client.delete("/api/trusted-supporter/invitation")
    assert revoked.status_code == 200
    assert revoked.headers["etag"]
    assert revoked.json()["accessCode"] is None
    assert client.post(
        "/api/trusted-supporter/access", json={"accessCode": code}
    ).status_code == 403


def test_supporter_log_is_attributed_excluded_and_requires_patient_inclusion(
    control_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = control_client
    _enable_supporter(client, canHelpLog=True)
    invitation = client.post("/api/trusted-supporter/invitation")
    code = invitation.json()["accessCode"]
    before = _state(client)[0]

    logged = client.post(
        "/api/trusted-supporter/log",
        json={"accessCode": code, "text": "Matthew had cramping pain 5 out of 10 after lunch."},
    )
    assert logged.status_code == 200, logged.text
    assert logged.headers["etag"]
    entry = logged.json()["entries"][0]
    assert entry["source"] == "supporter"
    assert entry["excluded"] is True
    assert entry["structured"]["supporterName"] == "Maya Johnson"
    assert entry["structured"]["supporterRelationship"] == "Sister"
    assert entry["structured"]["supporterReviewStatus"] == "needs patient review"
    assert any(
        item["id"] == entry["id"]
        for item in logged.json()["view"]["reviewableLogs"]
    )

    after = _state(client)[0]
    assert after["clinicianSummary"] == before["clinicianSummary"]
    included = client.patch(
        f"/api/journal/{entry['id']}", json={"excluded": False}
    )
    assert included.status_code == 200, included.text
    assert included.json()["excluded"] is False
    assert (
        included.json()["structured"]["supporterReviewStatus"]
        == "included by patient"
    )


def test_withdrawing_consent_disables_supporter_and_invalidates_code(
    control_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = control_client
    _enable_supporter(client, canViewSummary=True)
    code = client.post("/api/trusted-supporter/invitation").json()["accessCode"]

    withdrawn = client.patch("/api/profile", json={"healthDataConsent": False})
    assert withdrawn.status_code == 200
    supporter = client.get("/api/trusted-supporter").json()
    assert supporter["enabled"] is False
    assert supporter["accessCode"] is None
    assert client.post(
        "/api/trusted-supporter/access", json={"accessCode": code}
    ).status_code == 403


def test_patient_message_correction_retracts_proposals_and_reply_evidence(
    control_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = control_client
    sent = client.post(
        "/api/chat",
        json={
            "text": "I had cramping pain 4 out of 10 and I am allergic to sulfasalazine"
        },
    )
    assert sent.status_code == 200, sent.text
    patient_message, penny_reply = sent.json()["messages"]
    created_entries = sent.json()["entries"]
    proposal = sent.json()["profileProposals"][0]

    accepted = client.patch(
        f"/api/profile/proposals/{proposal['id']}", json={"status": "accepted"}
    )
    assert accepted.status_code == 200
    accepted_value = proposal["value"]

    corrected = client.patch(
        f"/api/chat/{patient_message['id']}",
        json={"text": "Correction: that allergy statement was about someone else."},
    )
    assert corrected.status_code == 200
    assert corrected.headers["etag"]
    assert corrected.json()["text"].startswith("Correction:")

    state = _state(client)[0]
    assert not any(
        item["sourceMessageId"] == patient_message["id"]
        for item in state["profileProposals"]
    )
    assert accepted_value.casefold() in state["profile"]["allergies"].casefold()
    assert all(
        any(entry["id"] == created["id"] for entry in state["entries"])
        for created in created_entries
    )
    historical_reply = next(
        message for message in state["messages"] if message["id"] == penny_reply["id"]
    )
    assert historical_reply["sources"]
    assert all(source["excluded"] for source in historical_reply["sources"])
    assert any(
        source["label"] == "Original patient wording"
        for source in historical_reply["sources"]
    )

    linked_entry = created_entries[0]
    journal_correction = client.patch(
        f"/api/journal/{linked_entry['id']}",
        json={"body": "Corrected pain record, still separate from the retracted chat wording."},
    )
    assert journal_correction.status_code == 200, journal_correction.text
    state = _state(client)[0]
    historical_reply = next(
        message for message in state["messages"] if message["id"] == penny_reply["id"]
    )
    refreshed_source = next(
        source
        for source in historical_reply["sources"]
        if source.get("entryId") == linked_entry["id"]
    )
    assert refreshed_source["detail"] == journal_correction.json()["body"]
    assert refreshed_source["excluded"] is True
    assert client.patch(
        f"/api/chat/{penny_reply['id']}", json={"text": "Rewritten reply"}
    ).status_code == 409


def test_individual_chat_deletion_preserves_journal_and_works_while_paused(
    control_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = control_client
    sent = client.post("/api/chat", json={"text": "I had pain 4 out of 10."})
    assert sent.status_code == 200
    patient_message, penny_reply = sent.json()["messages"]
    entry_id = sent.json()["entries"][0]["id"]

    assert client.patch("/api/profile", json={"healthDataConsent": False}).status_code == 200
    correction = client.patch(
        f"/api/chat/{patient_message['id']}",
        json={"text": "I need to correct this message while tracking is paused."},
    )
    assert correction.status_code == 200
    deleted_reply = client.delete(f"/api/chat/{penny_reply['id']}")
    assert deleted_reply.status_code == 204
    assert deleted_reply.headers["etag"]
    deleted_patient = client.delete(f"/api/chat/{patient_message['id']}")
    assert deleted_patient.status_code == 204

    state = _state(client)[0]
    assert not any(
        message["id"] in {patient_message["id"], penny_reply["id"]}
        for message in state["messages"]
    )
    assert any(entry["id"] == entry_id for entry in state["entries"])


def test_snapshot_cannot_forge_code_or_rewrite_individual_conversation_records(
    control_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = control_client
    state, etag = _state(client)
    state["trustedSupporter"].update(
        {
            "enabled": True,
            "name": "Attacker",
            "relationship": "Unknown",
            "canViewSummary": True,
            "accessCode": "FORGED-CODE",
            "accessCreatedAt": "2026-07-18T12:00:00Z",
        }
    )
    forged = client.put("/api/demo", json=state, headers={"If-Match": etag})
    assert forged.status_code == 409
    assert "generated" in forged.json()["detail"].lower()

    state, etag = _state(client)
    patient_message = next(message for message in state["messages"] if message["from"] == "me")
    patient_message["text"] = "Silently rewritten"
    rewritten = client.put("/api/demo", json=state, headers={"If-Match": etag})
    assert rewritten.status_code == 409
    assert "per-message" in rewritten.json()["detail"]

    state, etag = _state(client)
    state["messages"] = state["messages"][1:]
    individually_deleted = client.put(
        "/api/demo", json=state, headers={"If-Match": etag}
    )
    assert individually_deleted.status_code == 409


def test_snapshot_correction_regenerates_only_linked_evidence_display_fields(
    control_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = control_client
    sent = client.post(
        "/api/chat",
        json={"text": "Loose stool with urgency and a small amount of blood this morning"},
    )
    assert sent.status_code == 200, sent.text
    entry_id = sent.json()["entries"][0]["id"]
    reply_id = sent.json()["messages"][1]["id"]

    state, etag = _state(client)
    entry = next(item for item in state["entries"] if item["id"] == entry_id)
    entry.update(
        {
            "body": "Bristol type 6, urgency, trace blood — corrected by Matthew",
            "structured": {"bristol": 6, "urgency": True, "blood": "trace"},
        }
    )
    reply = next(message for message in state["messages"] if message["id"] == reply_id)
    source = next(source for source in reply["sources"] if source["entryId"] == entry_id)
    # These are browser display hints only. The API must derive them from the journal record.
    source.update(
        {
            "label": "FORGED LABEL",
            "date": "FORGED DATE",
            "detail": "FORGED DETAIL",
            "excluded": True,
        }
    )

    corrected = client.put("/api/demo", json=state, headers={"If-Match": etag})
    assert corrected.status_code == 200, corrected.text
    saved_entry = next(item for item in corrected.json()["entries"] if item["id"] == entry_id)
    saved_reply = next(
        message for message in corrected.json()["messages"] if message["id"] == reply_id
    )
    saved_source = next(
        source for source in saved_reply["sources"] if source["entryId"] == entry_id
    )
    assert saved_entry["body"] == entry["body"]
    assert saved_source == {
        "entryId": entry_id,
        "messageId": None,
        "url": None,
        "target": None,
        "label": saved_entry["kind"],
        "date": f"{saved_entry['date']}, {saved_entry['time']}",
        "detail": saved_entry["body"],
        "type": "fact",
        "excluded": saved_entry["excluded"],
    }

    for field, forged_value in (
        ("text", "Silently rewritten reply"),
        ("createdAt", "2000-01-01T00:00:00Z"),
    ):
        candidate, candidate_etag = _state(client)
        candidate_reply = next(
            message for message in candidate["messages"] if message["id"] == reply_id
        )
        candidate_reply[field] = forged_value
        rejected = client.put(
            "/api/demo", json=candidate, headers={"If-Match": candidate_etag}
        )
        assert rejected.status_code == 409
        assert "per-message" in rejected.json()["detail"]

    for field, forged_value in (("type", "guidance"), ("entryId", entry_id - 1)):
        candidate, candidate_etag = _state(client)
        candidate_reply = next(
            message for message in candidate["messages"] if message["id"] == reply_id
        )
        candidate_source = next(
            source for source in candidate_reply["sources"] if source["entryId"] == entry_id
        )
        candidate_source[field] = forged_value
        rejected = client.put(
            "/api/demo", json=candidate, headers={"If-Match": candidate_etag}
        )
        assert rejected.status_code == 409
        assert "per-message" in rejected.json()["detail"]


def test_snapshot_deletion_tombstones_detail_even_after_reply_retraction(
    control_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = control_client
    sent = client.post("/api/chat", json={"text": "I had pain 4 out of 10."})
    assert sent.status_code == 200, sent.text
    patient_message, penny_reply = sent.json()["messages"]
    entry_id = sent.json()["entries"][0]["id"]
    assert client.patch(
        f"/api/chat/{patient_message['id']}",
        json={"text": "That wording needs correcting."},
    ).status_code == 200

    state, etag = _state(client)
    state["entries"] = [entry for entry in state["entries"] if entry["id"] != entry_id]
    historical_reply = next(
        message for message in state["messages"] if message["id"] == penny_reply["id"]
    )
    linked_source = next(
        source for source in historical_reply["sources"] if source.get("entryId") == entry_id
    )
    sensitive_detail = linked_source["detail"]
    assert linked_source["excluded"] is True

    deleted = client.put("/api/demo", json=state, headers={"If-Match": etag})
    assert deleted.status_code == 200, deleted.text
    saved_reply = next(
        message for message in deleted.json()["messages"] if message["id"] == penny_reply["id"]
    )
    tombstone = next(
        source for source in saved_reply["sources"] if source.get("entryId") == entry_id
    )
    assert tombstone["excluded"] is True
    assert sensitive_detail not in tombstone["detail"]
    assert tombstone["detail"].startswith("Source record deleted by the patient")
