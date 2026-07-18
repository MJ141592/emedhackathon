from __future__ import annotations

import sqlite3
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from app.domain import routes as domain_routes
from app.domain.models import patient_calendar_date
from app.domain.store import SQLiteDemoStore, get_demo_store
from app.main import app


@pytest.fixture
def domain_client(tmp_path: Path) -> tuple[TestClient, SQLiteDemoStore]:
    store = SQLiteDemoStore(tmp_path / "domain.sqlite3")
    previous = dict(app.dependency_overrides)
    app.dependency_overrides[get_demo_store] = lambda: store
    with TestClient(app) as client:
        yield client, store
    app.dependency_overrides.clear()
    app.dependency_overrides.update(previous)


def _bootstrap(client: TestClient) -> tuple[dict[str, Any], str]:
    response = client.get("/api/demo")
    assert response.status_code == 200
    state = response.json()
    scheduled_today = next(
        (day for day in state["taper"]["days"] if day["date"] == date.today().isoformat()),
        None,
    )
    if scheduled_today is not None and state["taper"]["verified"]:
        # Mirrors the browser repository's calendar normalization before a complete snapshot.
        state["taper"]["currentDay"] = scheduled_today["day"]
    return state, response.headers["etag"]


def _sqlite_artifacts(path: Path) -> list[Path]:
    return sorted(path.parent.glob(f"{path.name}*"))


def _confirm_watchful_state(client: TestClient) -> None:
    response = client.post("/api/lifecycle/confirm")
    assert response.status_code == 200
    assert response.json()["phase"] == "watch"
    assert response.json()["phaseConfirmed"] is True


def _prepare_confirmed_stable_fixture(store: SQLiteDemoStore) -> None:
    store.mutate(
        lambda state: state.update(
            {"phase": "stable", "pendingPhase": None, "phaseConfirmed": True}
        ),
        "Prepared confirmed stable test fixture",
        actor="test",
    )


def _prepare_unstarted_experiment_fixture(store: SQLiteDemoStore) -> None:
    def apply(state: dict[str, Any]) -> None:
        experiment_id = state["experiment"]["id"]
        state["entries"] = [
            entry
            for entry in state["entries"]
            if entry.get("structured", {}).get("experimentId") != experiment_id
        ]
        state["experiment"].update(
            {
                "status": "suggested",
                "day": 0,
                "startDate": "",
                "observations": [],
                "reviewRequestMessageId": None,
                "reviewApprovedAt": None,
                "reviewApprovedBy": None,
            }
        )

    store.mutate(apply, "Prepared unstarted experiment test fixture", actor="test")


def _experiment_review_body(client: TestClient) -> str:
    experiment = client.get("/api/experiment").json()
    definition = " ".join(
        (
            f"candidate id {experiment['id']}",
            f"title {experiment['title']}",
            f"variable {experiment['variable']}",
            f"goal {experiment['goal']}",
            f"baseline {experiment['baseline']}",
            f"outcome {experiment['outcome']}",
            f"duration {experiment['durationDays']} days",
        )
    )
    return f"Dietitian experiment review request for this exact unchanged definition. {definition}"


def _complete_clean_stable_onboarding(client: TestClient) -> dict[str, Any]:
    cleared = client.delete("/api/data")
    assert cleared.status_code == 200
    assert cleared.json()["phase"] == "stable"
    contact = client.post(
        "/api/contacts",
        json={
            "id": "ibd-team",
            "initials": "IB",
            "name": "IBD advice line",
            "role": "IBD team",
            "organisation": "Example Hospital",
            "phone": "020 7000 0000",
        },
    )
    assert contact.status_code == 201
    profile = client.patch(
        "/api/profile",
        json={
            "name": "Sam Rivera",
            "dateOfBirth": "1990-04-12",
            "diagnosis": "Crohn's disease",
            "usualBowel": "1-2 formed bowel movements/day",
            "usualPain": "0-1/10",
            "usualHeartRate": "62 bpm resting",
            "usualSleep": "7.5 hours",
            "carePlan": "Contact the IBD advice line if symptoms change.",
            "address": "10 Example Road, London",
            "postcode": "W1 1AA",
            "adultEligibilityConfirmed": True,
            "healthDataConsent": True,
            "consentVersion": "demo-v1",
            "consentRecordedAt": "2026-07-18T08:00:00+00:00",
            "onboardingComplete": True,
        },
    )
    assert profile.status_code == 200
    return _bootstrap(client)[0]


def test_bootstrap_is_canonical_and_persists(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    state, etag = _bootstrap(client)

    assert state["version"] == 2
    assert state["profile"]["name"] == "Matthew Johnson"
    assert state["profile"]["usualBowel"] == "2–3 formed bowel movements/day (2.8 average)"
    assert state["testOrder"]["status"] == "prepared"
    assert state["teamMessage"]["status"] == "draft"
    assert state["trustedSupporter"]["enabled"] is False
    assert state["taper"]["days"][11]["doseMg"] == 25
    assert not any(day["taken"] for day in state["taper"]["days"])
    assert state["taper"]["missedDays"] == []
    assert "six-day" not in state["teamMessage"]["body"].lower()
    assert "5.1/day" not in state["clinicianSummary"]
    assert "two included bowel records across 16–17 July" in state["teamMessage"]["body"]
    assert [source["entryId"] for source in state["messages"][2]["sources"]] == [1, 5, 6, 2]
    assert state["taper"]["days"][14] == {
        "day": 15,
        "doseMg": 20,
        "date": "2026-07-20",
        "taken": False,
    }
    assert etag == '"1"'

    response = client.patch("/api/profile", json={"dietaryNeeds": "Vegetarian"})
    assert response.status_code == 200
    assert response.json()["dietaryNeeds"] == "Vegetarian"

    reopened = SQLiteDemoStore(store.path)
    assert reopened.get().profile.dietaryNeeds == "Vegetarian"
    assert reopened.get().version == 2


def test_sensitive_aggregate_responses_forbid_http_caching(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client

    response = client.get("/api/demo")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["pragma"] == "no-cache"


def test_health_aggregate_is_encrypted_at_rest_and_reopens(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    _client, store = domain_client

    with sqlite3.connect(store.path) as connection:
        stored = connection.execute(
            "SELECT state_json FROM demo_snapshots WHERE patient_id = 'matthew'"
        ).fetchone()[0]

    assert stored.startswith("enc:v1:")
    assert "Matthew Johnson" not in stored
    for artifact in _sqlite_artifacts(store.path):
        assert b"Matthew Johnson" not in artifact.read_bytes(), artifact.name
    assert "ulcerative colitis" not in stored.lower()
    assert SQLiteDemoStore(store.path).get().profile.name == "Matthew Johnson"


def test_revision_details_are_encrypted_and_sqlite_artifacts_are_private(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    _client, store = domain_client
    store.mutate(
        lambda state: state["profile"].update({"dietaryNeeds": "Sensitive audit value"}),
        "Patient recorded sensitive audit action",
        actor="sensitive-patient-actor",
        metadata={"resource": "profile", "detail": "Sensitive audit metadata"},
    )

    with sqlite3.connect(store.path) as connection:
        stored = connection.execute(
            """
            SELECT action, actor, metadata_json
            FROM domain_revisions
            ORDER BY id DESC
            LIMIT 1
            """
        ).fetchone()

    assert stored is not None
    assert all(str(value).startswith("enc:v1:") for value in stored)
    assert "Sensitive audit" not in " ".join(str(value) for value in stored)
    revision = store.revisions(limit=1)[0]
    assert revision["action"] == "Patient recorded sensitive audit action"
    assert revision["actor"] == "sensitive-patient-actor"
    assert revision["metadata"] == {
        "resource": "profile",
        "detail": "Sensitive audit metadata",
    }
    for artifact in _sqlite_artifacts(store.path):
        assert artifact.stat().st_mode & 0o777 == 0o600, artifact.name


def test_regenerated_summary_does_not_imply_pre_collection_taper_progress(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client

    regenerated = client.post("/api/summary/regenerate")

    assert regenerated.status_code == 200
    summary = regenerated.json()["clinicianSummary"]
    assert "schedule prepared; dose support is not active; 0 doses marked taken" in summary
    assert "day 12 of 42" not in summary


def test_plaintext_legacy_snapshot_is_transparently_migrated(tmp_path: Path) -> None:
    path = tmp_path / "legacy-plaintext.sqlite3"
    key = Fernet.generate_key()
    store = SQLiteDemoStore(path, encryption_key=key)
    plaintext = store.get().model_dump_json(by_alias=True)
    with sqlite3.connect(path) as connection:
        connection.execute(
            "UPDATE demo_snapshots SET state_json = ? WHERE patient_id = 'matthew'",
            (plaintext,),
        )
        connection.execute(
            """
            UPDATE domain_revisions
            SET action = 'Legacy plaintext audit action',
                actor = 'legacy-actor',
                metadata_json = '{"detail":"Legacy plaintext audit metadata"}'
            """
        )

    migrated = SQLiteDemoStore(path, encryption_key=key)
    assert migrated.get().profile.name == "Matthew Johnson"
    with sqlite3.connect(path) as connection:
        stored = connection.execute(
            "SELECT state_json FROM demo_snapshots WHERE patient_id = 'matthew'"
        ).fetchone()[0]
        revision = connection.execute(
            "SELECT action, actor, metadata_json FROM domain_revisions LIMIT 1"
        ).fetchone()
    assert stored.startswith("enc:v1:")
    assert revision is not None
    assert all(str(value).startswith("enc:v1:") for value in revision)
    assert "Matthew Johnson" not in stored
    for artifact in _sqlite_artifacts(path):
        assert b"Matthew Johnson" not in artifact.read_bytes(), artifact.name
        assert b"Legacy plaintext audit" not in artifact.read_bytes(), artifact.name


def test_snapshot_sync_uses_monotonic_etag_and_rejects_stale_after_reset(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    state, etag = _bootstrap(client)
    state["clinicianSummary"] = "Patient-reviewed update"

    synced = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert synced.status_code == 200
    assert synced.json()["version"] == 2
    assert synced.json()["clinicianSummary"] == "Patient-reviewed update"
    assert synced.headers["etag"] != etag

    missing_precondition = client.put("/api/demo", json=synced.json())
    assert missing_precondition.status_code == 428

    pre_reset_etag = synced.headers["etag"]
    reset = client.post("/api/demo/reset")
    assert reset.status_code == 200
    assert reset.json()["profile"]["name"] == "Matthew Johnson"
    assert reset.headers["etag"] != pre_reset_etag

    stale = client.put("/api/demo", headers={"If-Match": pre_reset_etag}, json=synced.json())
    assert stale.status_code == 409


def test_snapshot_sync_preserves_api_audit_events_missing_from_the_browser_copy(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    browser_state, etag = _bootstrap(client)
    browser_state["clinicianSummary"] = "First patient edit"
    first = client.put("/api/demo", headers={"If-Match": etag}, json=browser_state)
    assert first.status_code == 200
    first_api_event = first.json()["audit"][0]

    # The browser has not rehydrated the API-appended event, but a later complete snapshot
    # must not erase it from the persisted, patient-visible audit.
    browser_state["clinicianSummary"] = "Second patient edit"
    second = client.put(
        "/api/demo",
        headers={"If-Match": first.headers["etag"]},
        json=browser_state,
    )
    assert second.status_code == 200
    assert first_api_event in second.json()["audit"]


def test_profile_history_contacts_and_adult_onboarding(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client

    child = client.patch("/api/profile", json={"dateOfBirth": "2015-01-01"})
    assert child.status_code == 422
    assert "adults" in str(child.json()).lower()

    incomplete = client.patch(
        "/api/profile",
        json={"onboardingComplete": False, "dateOfBirth": "2015-01-01"},
    )
    assert incomplete.status_code == 200
    assert incomplete.json()["onboardingComplete"] is False

    history = client.put("/api/profile/history/surgeries", json={"value": "None"})
    assert history.status_code == 200
    assert history.json()["value"] == "None"
    assert any(
        item == {"field": "surgeries", "value": "None"}
        for item in client.get("/api/profile/history").json()
    )

    created = client.post(
        "/api/contacts",
        json={
            "id": "gp",
            "initials": "GP",
            "name": "Dr Green",
            "role": "GP",
            "organisation": "Marikina Practice",
            "phone": "020 7000 0000",
        },
    )
    assert created.status_code == 201
    assert client.patch("/api/contacts/gp", json={"phone": "020 7000 0001"}).status_code == 200
    assert client.delete("/api/contacts/gp").status_code == 204


def test_consent_version_and_timestamp_are_server_authored_across_transitions(
    domain_client: tuple[TestClient, SQLiteDemoStore], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, _ = domain_client
    first_recorded_at = "2026-07-18T10:15:00+00:00"
    monkeypatch.setattr(domain_routes, "utc_now", lambda: first_recorded_at)

    state = _complete_clean_stable_onboarding(client)
    assert state["profile"]["consentVersion"] == domain_routes.CONSENT_VERSION
    assert state["profile"]["consentRecordedAt"] == first_recorded_at

    tampered = client.patch(
        "/api/profile",
        json={
            "consentVersion": "caller-controlled-version",
            "consentRecordedAt": "1999-01-01T00:00:00+00:00",
        },
    )
    assert tampered.status_code == 200
    assert tampered.json()["consentVersion"] == domain_routes.CONSENT_VERSION
    assert tampered.json()["consentRecordedAt"] == first_recorded_at

    revoked = client.patch(
        "/api/profile",
        json={"healthDataConsent": False, "onboardingComplete": False},
    )
    assert revoked.status_code == 200
    assert revoked.json()["consentRecordedAt"] is None

    second_recorded_at = "2026-07-18T11:45:00+00:00"
    monkeypatch.setattr(domain_routes, "utc_now", lambda: second_recorded_at)
    restored = client.patch(
        "/api/profile",
        json={
            "healthDataConsent": True,
            "onboardingComplete": True,
            "consentVersion": "forged-v99",
            "consentRecordedAt": "2001-02-03T04:05:06+00:00",
        },
    )
    assert restored.status_code == 200
    assert restored.json()["consentVersion"] == domain_routes.CONSENT_VERSION
    assert restored.json()["consentRecordedAt"] == second_recorded_at

    snapshot, etag = _bootstrap(client)
    snapshot["profile"]["consentVersion"] = "snapshot-forgery"
    snapshot["profile"]["consentRecordedAt"] = "2002-02-02T02:02:02+00:00"
    synced = client.put("/api/demo", headers={"If-Match": etag}, json=snapshot)
    assert synced.status_code == 200
    assert synced.json()["profile"]["consentVersion"] == domain_routes.CONSENT_VERSION
    assert synced.json()["profile"]["consentRecordedAt"] == second_recorded_at


def test_consent_withdrawal_pauses_ingestion_and_disconnects_wearable(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    existing_entry_id = _bootstrap(client)[0]["entries"][0]["id"]

    revoked = client.patch(
        "/api/profile",
        json={"healthDataConsent": False, "onboardingComplete": False},
    )
    assert revoked.status_code == 200
    assert revoked.json()["healthDataConsent"] is False
    wearable = client.get("/api/wearable").json()
    assert wearable["connected"] is False
    assert wearable["lastSync"] is None

    journal = client.post(
        "/api/journal",
        json={"kind": "WELLBEING", "body": "Should not persist", "source": "manual"},
    )
    assert journal.status_code == 403
    assert "tracking is paused" in journal.json()["detail"].lower()
    assert client.post("/api/chat", json={"text": "I feel worse"}).status_code == 403
    assert client.post("/api/wearable/connect", json={}).status_code == 403
    assert client.patch("/api/wearable", json={"heartRate": False}).status_code == 200
    assert client.patch("/api/wearable", json={"heartRate": True}).status_code == 403
    for method, path, payload in (
        ("post", "/api/lifecycle/evaluate", None),
        (
            "post",
            "/api/care/test-order/confirm",
            {"addressConfirmed": True, "consent": True},
        ),
        ("post", "/api/care/team-message/send", None),
        ("post", "/api/care/prescription/request", None),
        ("post", "/api/taper/dose/taken", None),
        ("post", "/api/experiment/start", None),
    ):
        response = (
            getattr(client, method)(path, json=payload)
            if payload
            else getattr(client, method)(path)
        )
        assert response.status_code == 403, (path, response.text)
    assert (
        client.post(
            "/api/wearable/simulate-sync",
            json={"restingHeartRate": 70},
        ).status_code
        == 403
    )

    # Existing records remain available for correction, exclusion, export and deletion.
    corrected = client.patch(
        f"/api/journal/{existing_entry_id}",
        json={"excluded": True},
    )
    assert corrected.status_code == 200
    assert corrected.json()["excluded"] is True

    restored = client.patch(
        "/api/profile",
        json={"healthDataConsent": True, "onboardingComplete": True},
    )
    assert restored.status_code == 200
    assert client.post("/api/wearable/connect", json={}).status_code == 200


def test_closed_page_background_endpoint_prepares_one_editable_evening_draft(
    domain_client: tuple[TestClient, SQLiteDemoStore], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, store = domain_client
    monkeypatch.setattr(
        domain_routes,
        "_background_now",
        # 19:05 on 18 July in Los Angeles, but already 19 July in UTC.
        lambda: datetime(2026, 7, 19, 2, 5, tzinfo=UTC),
    )
    store.mutate(
        lambda state: (
            state.update({"phase": "flare", "pendingPhase": None, "phaseConfirmed": True}),
            state["profile"].update({"timeZone": "America/Los_Angeles"}),
            state["teamMessage"].update(
                {"status": "replied", "reply": "Please send an evening update."}
            ),
        ),
        "Prepared replied flare thread for patient-local background test",
        actor="test",
    )

    created = client.post("/api/background/run")
    assert created.status_code == 200
    assert created.json() == {"created": True}
    state, _ = _bootstrap(client)
    assert state["teamMessage"]["id"] == "EVENING-2026-07-18"
    assert state["teamMessage"]["status"] == "draft"
    assert state["teamMessageHistory"][0]["status"] == "replied"
    assert state["teamMessageStale"] is False

    repeated = client.post("/api/background/run")
    assert repeated.status_code == 200
    assert repeated.json()["created"] is False
    assert len(_bootstrap(client)[0]["teamMessageHistory"]) == 1


def test_evening_background_rechecks_consent_inside_the_write_transaction(
    domain_client: tuple[TestClient, SQLiteDemoStore], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, store = domain_client
    monkeypatch.setattr(
        domain_routes,
        "_background_now",
        lambda: datetime(2026, 7, 19, 2, 5, tzinfo=UTC),
    )
    store.mutate(
        lambda state: (
            state.update({"phase": "flare", "pendingPhase": None, "phaseConfirmed": True}),
            state["profile"].update({"timeZone": "America/Los_Angeles"}),
            state["teamMessage"].update(
                {"status": "replied", "reply": "Please send an evening update."}
            ),
        ),
        "Prepared background consent-race fixture",
        actor="test",
    )
    original_mutate = store.mutate

    def revoke_before_background_write(mutator, action, **kwargs):
        original_mutate(
            lambda state: state["profile"].update(
                {"healthDataConsent": False, "onboardingComplete": False}
            ),
            "Patient withdrew consent during background scheduling",
            actor="test",
        )
        return original_mutate(mutator, action, **kwargs)

    monkeypatch.setattr(store, "mutate", revoke_before_background_write)
    response = client.post("/api/background/run")

    assert response.status_code == 403
    state = store.get()
    assert state.profile.healthDataConsent is False
    assert state.teamMessage.status == "replied"
    assert not any(message.id.startswith("EVENING-") for message in state.teamMessageHistory)


def test_evening_background_requires_a_confirmed_flare_without_a_pending_transition(
    domain_client: tuple[TestClient, SQLiteDemoStore], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, store = domain_client
    monkeypatch.setattr(
        domain_routes,
        "_background_now",
        lambda: datetime(2026, 7, 18, 20, 0, tzinfo=UTC),
    )
    store.mutate(
        lambda state: (
            state.update({"phase": "flare", "phaseConfirmed": False, "pendingPhase": None}),
            state["teamMessage"].update(
                {"status": "replied", "reply": "Please send an evening update."}
            ),
        ),
        "Prepared unconfirmed flare background fixture",
        actor="test",
    )

    unconfirmed = client.post("/api/background/run")
    assert unconfirmed.status_code == 200
    assert unconfirmed.json()["created"] is False
    assert store.get().teamMessage.status == "replied"

    store.mutate(
        lambda state: state.update(
            {"phase": "flare", "phaseConfirmed": True, "pendingPhase": "stable"}
        ),
        "Prepared pending phase-transition background fixture",
        actor="test",
    )
    pending = client.post("/api/background/run")
    assert pending.status_code == 200
    assert pending.json()["created"] is False
    assert store.get().teamMessage.status == "replied"
    assert store.get().teamMessageHistory == []


def test_reminder_suppression_cookie_short_circuits_worker_endpoints_before_state_access(
    domain_client: tuple[TestClient, SQLiteDemoStore], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, store = domain_client
    original_get = store.get
    before_state = original_get().model_dump(mode="json", by_alias=True)
    before_revisions = store.revisions()
    client.cookies.set(domain_routes.REMINDER_SUPPRESSION_COOKIE, "1")

    def unexpected_background(_store: SQLiteDemoStore) -> tuple[bool, object]:
        raise AssertionError("suppressed background work must not inspect or mutate patient state")

    monkeypatch.setattr(domain_routes, "run_evening_background", unexpected_background)
    background = client.post("/api/background/run")
    assert background.status_code == 200
    assert background.json() == {"created": False}

    def unexpected_get() -> object:
        raise AssertionError("suppressed reminder reads must not access patient state")

    monkeypatch.setattr(store, "get", unexpected_get)
    reminder = client.get("/api/reminders/current")
    assert reminder.status_code == 204
    assert reminder.headers["cache-control"] == "no-store"
    assert reminder.content == b""
    assert original_get().model_dump(mode="json", by_alias=True) == before_state
    assert store.revisions() == before_revisions


def test_worker_reminder_endpoint_returns_only_a_minimal_consent_bound_payload(
    domain_client: tuple[TestClient, SQLiteDemoStore], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, store = domain_client
    monkeypatch.setattr(
        domain_routes,
        "_background_now",
        lambda: datetime(2026, 7, 18, 20, 0, tzinfo=UTC),
    )

    response = client.get("/api/reminders/current")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert set(response.json()) == {"marker", "title", "body"}
    assert response.json()["marker"].startswith("2026-07-18:daily-check-in:")
    assert response.json()["title"] == "You have a Gutsy check-in"
    assert "Matthew" not in response.text
    assert "messages" not in response.text
    assert "entries" not in response.text
    assert "previewUrl" not in response.text

    store.mutate(
        lambda state: (
            state.update({"phase": "flare", "phaseConfirmed": False, "pendingPhase": None}),
            state["profile"].update({"currentMedicines": ""}),
            state["privacy"].update(
                {"notificationBudget": "low", "discreetNotifications": False}
            ),
            state["prescription"].update({"status": "prepared"}),
            state["taper"].update({"verified": False}),
            state["teamMessage"].update(
                {"status": "draft", "sentAt": None, "reply": None}
            ),
            state["entries"].clear(),
        ),
        "Prepared presentation-only Flare reminder fixture",
        actor="test",
    )
    assert client.get("/api/reminders/current").status_code == 204

    store.mutate(
        lambda state: state.update(
            {"phase": "flare", "phaseConfirmed": True, "pendingPhase": None}
        ),
        "Prepared confirmed Flare reminder fixture",
        actor="test",
    )
    confirmed = client.get("/api/reminders/current")
    assert confirmed.status_code == 200
    assert set(confirmed.json()) == {"marker", "title", "body"}
    assert confirmed.json()["title"] == "Flare check-in: can you safely wait?"

    store.mutate(
        lambda state: state.update(
            {"phase": "flare", "phaseConfirmed": True, "pendingPhase": "watch"}
        ),
        "Prepared pending phase reminder fixture",
        actor="test",
    )
    assert client.get("/api/reminders/current").status_code == 204

    store.mutate(
        lambda state: state["profile"].update(
            {"healthDataConsent": False, "onboardingComplete": False}
        ),
        "Prepared withdrawn reminder-consent fixture",
        actor="test",
    )
    assert client.get("/api/reminders/current").status_code == 204


def test_patient_time_zone_is_validated_and_changes_calendar_boundaries(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    invalid = client.patch("/api/profile", json={"timeZone": "Mars/Olympus_Mons"})
    assert invalid.status_code == 422

    instant = datetime(2026, 7, 18, 0, 30, tzinfo=UTC)
    assert domain_routes._patient_date({"timeZone": "Europe/London"}, instant) == date(
        2026, 7, 18
    )
    assert domain_routes._patient_date(
        {"timeZone": "America/Los_Angeles"}, instant
    ) == date(2026, 7, 17)
    assert patient_calendar_date("Europe/London", instant) == date(2026, 7, 18)
    assert patient_calendar_date("America/Los_Angeles", instant) == date(2026, 7, 17)


def test_snapshot_sync_cannot_leave_ingestion_connected_or_add_records_after_revocation(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    state, etag = _bootstrap(client)
    state["profile"].update({"healthDataConsent": False, "onboardingComplete": False})

    still_connected = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert still_connected.status_code == 409
    assert "disconnect wearable" in still_connected.json()["detail"].lower()

    state["wearable"].update({"connected": False, "lastSync": None})
    revoked = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert revoked.status_code == 200

    inactive = revoked.json()
    existing = dict(inactive["entries"][0])
    existing.update(
        {
            "id": max(entry["id"] for entry in inactive["entries"]) + 1,
            "kind": "WELLBEING",
            "body": "Attempted record after consent withdrawal",
            "structured": {"wellbeing": "worse"},
        }
    )
    inactive["entries"].append(existing)
    blocked = client.put(
        "/api/demo",
        headers={"If-Match": revoked.headers["etag"]},
        json=inactive,
    )
    assert blocked.status_code == 403


def test_wearable_sync_respects_each_signal_permission(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    assert client.patch("/api/wearable", json={"heartRate": False}).status_code == 200
    denied = client.post(
        "/api/wearable/simulate-sync",
        json={"restingHeartRate": 70},
    )
    assert denied.status_code == 403
    assert "resting heart rate" in denied.json()["detail"].lower()

    permitted = client.post(
        "/api/wearable/simulate-sync",
        json={"sleepHours": 6.5},
    )
    assert permitted.status_code == 200

    assert client.patch("/api/wearable", json={"hrv": False}).status_code == 200
    denied_hrv = client.post(
        "/api/wearable/simulate-sync",
        json={"heartRateVariabilityMs": 36.5},
    )
    assert denied_hrv.status_code == 403
    assert "heart-rate variability" in denied_hrv.json()["detail"].lower()


def test_dashboard_food_episode_cites_exact_correctable_sources_without_causal_claim(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    dashboard = client.get("/api/dashboard")
    assert dashboard.status_code == 200
    pattern = dashboard.json()["personalPatterns"][0]
    assert pattern["kind"] == "food-symptom-episode"
    assert pattern["sourceEntryIds"] == [4, 6, 5]
    assert "2026-07-16 19:30" in pattern["summary"]
    assert "correlation is not proof" in pattern["disclaimer"].lower()

    excluded = client.patch("/api/journal/4", json={"excluded": True})
    assert excluded.status_code == 200
    assert client.get("/api/dashboard").json()["personalPatterns"] == []


def test_dashboard_trend_uses_explicit_current_day_bowel_count(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    tracked_day = patient_calendar_date(store.get().profile.timeZone).isoformat()

    def add_count(state: dict[str, Any]) -> None:
        for entry in state["entries"]:
            if entry["kind"] == "BOWEL MOVEMENT" and entry["date"] == tracked_day:
                entry["excluded"] = True
        next_id = max(entry["id"] for entry in state["entries"]) + 1
        state["entries"].extend(
            [
                {
                    "id": next_id,
                    "date": tracked_day,
                    "time": "10:00",
                    "kind": "BOWEL MOVEMENT",
                    "body": "Individual bowel log",
                    "source": "manual",
                    "structured": {},
                },
                {
                    "id": next_id + 1,
                    "date": tracked_day,
                    "time": "11:00",
                    "kind": "BOWEL MOVEMENT",
                    "body": "Individual bowel log",
                    "source": "manual",
                    "structured": {},
                },
                {
                    "id": next_id + 2,
                    "date": tracked_day,
                    "time": "12:00",
                    "kind": "BOWEL MOVEMENT",
                    "body": "Five bowel movements today",
                    "source": "manual",
                    "structured": {"bowelMovements24h": 5},
                },
            ]
        )

    store.mutate(add_count, "Prepared explicit bowel-count dashboard fixture", actor="test")

    dashboard = client.get("/api/dashboard")
    assert dashboard.status_code == 200
    point = next(item for item in dashboard.json()["trend"] if item["day"] == tracked_day)
    assert point["bowel"] == 5


def test_missed_dose_guidance_uses_official_source_and_named_pharmacy_route(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    assert client.delete("/api/contacts/pharmacy").status_code == 204
    created = client.post(
        "/api/contacts",
        json={
            "id": "medicine-help",
            "initials": "CP",
            "name": "Community Medicines Desk",
            "role": "Clinical pharmacist",
            "organisation": "Example Health Centre",
            "phone": "020 7000 1234",
        },
    )
    assert created.status_code == 201
    guidance = client.get("/api/taper/missed-dose-guidance")
    assert guidance.status_code == 200
    assert guidance.json()["pharmacy"] == "Community Medicines Desk"
    assert guidance.json()["phone"] == "020 7000 1234"
    assert guidance.json()["source"].startswith("NHS:")
    assert guidance.json()["sourceUrl"].startswith("https://www.nhs.uk/")


def test_lifecycle_and_dashboard_use_the_maintained_personal_baseline(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    updated = client.patch(
        "/api/profile",
        json={
            "name": "Beatrice Jones",
            "usualBowel": "4 formed bowel movements/day",
            "usualPain": "5/10",
            "usualHeartRate": "80 bpm resting",
        },
    )
    assert updated.status_code == 200

    lifecycle = client.get("/api/lifecycle").json()
    signal_keys = {signal["key"] for signal in lifecycle["signals"]}
    assert "pain" not in signal_keys
    assert "resting_heart_rate" not in signal_keys
    assert "Matthew" not in lifecycle["explanation"]

    dashboard = client.get("/api/dashboard").json()
    comparisons = {metric["key"]: metric["comparison"] for metric in dashboard["metrics"]}
    assert comparisons["bowel"] == "Personal baseline: 4 formed bowel movements/day"
    assert comparisons["pain"] == "Personal baseline: 5/10"


def test_baseline_patch_invalidates_confirmation_and_persists_recomputed_proposal(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    _confirm_watchful_state(client)
    assert _bootstrap(client)[0]["phaseConfirmed"] is True

    updated = client.patch("/api/profile", json={"usualPain": "5/10"})
    assert updated.status_code == 200
    state, _ = _bootstrap(client)
    evaluation = client.get("/api/lifecycle").json()
    assert state["phaseConfirmed"] is False
    assert state["pendingPhase"] == evaluation["proposedPhase"]

    _prepare_confirmed_stable_fixture(store)
    store.mutate(
        lambda value: value["experiment"].update({"status": "active"}),
        "Prepared active experiment baseline fixture",
        actor="test",
    )
    changed_again = client.patch("/api/profile", json={"usualHeartRate": "62 bpm resting"})
    assert changed_again.status_code == 200
    after, _ = _bootstrap(client)
    assert after["phaseConfirmed"] is False
    assert after["experiment"]["status"] == "paused"
    assert after["pendingPhase"] == client.get("/api/lifecycle").json()["proposedPhase"]

    _confirm_watchful_state(client)
    forged, etag = _bootstrap(client)
    forged["profile"]["usualPain"] = "7/10"
    rejected = client.put("/api/demo", headers={"If-Match": etag}, json=forged)
    assert rejected.status_code == 409
    assert "personal baseline invalidates" in rejected.json()["detail"]


def test_trusted_supporter_requires_identity_and_explicit_scope(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    invalid = client.patch("/api/trusted-supporter", json={"enabled": True})
    assert invalid.status_code == 422

    enabled = client.patch(
        "/api/trusted-supporter",
        json={
            "enabled": True,
            "name": "Nia Johnson",
            "relationship": "Sister",
            "canViewSummary": True,
        },
    )
    assert enabled.status_code == 200
    assert enabled.json()["canViewSummary"] is True
    assert enabled.json()["canHelpLog"] is False

    disabled = client.patch("/api/trusted-supporter", json={"enabled": False})
    assert disabled.status_code == 200
    assert not any(
        disabled.json()[key] for key in ("canViewSummary", "canSeeReminders", "canHelpLog")
    )

    state, etag = _bootstrap(client)
    state["trustedSupporter"].update(
        {
            "enabled": True,
            "name": "",
            "relationship": "",
            "canViewSummary": False,
        }
    )
    invalid_snapshot = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert invalid_snapshot.status_code == 422


def test_capture_parser_does_not_fabricate_or_log_questions(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client

    question = client.post("/api/capture/parse", json={"text": "What does urgency mean?"})
    assert question.status_code == 200
    assert question.json()["entries"] == []

    loose = client.post("/api/capture/parse", json={"text": "Loose stool with blood"})
    assert loose.status_code == 200
    structured = loose.json()["entries"][0]["structured"]
    assert structured["consistency"] == "loose"
    assert structured["blood"] == "reported"
    assert structured["needsClarification"] == "bloodAmount"
    assert "bristol" not in structured
    assert "Amount of blood" in loose.json()["missing"]

    pain = client.post(
        "/api/capture/parse",
        json={"text": "Pain’s about a 6 and I’m shattered"},
    )
    assert pain.status_code == 200
    assert pain.json()["entries"][0]["structured"]["pain"] == 6
    assert pain.json()["entries"][0]["structured"]["fatigue"] == "high"


def test_chat_blood_clarification_updates_original_grounded_record_and_derivations(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    before, _ = _bootstrap(client)

    first_turn = client.post("/api/chat", json={"text": "Loose stool with blood"})

    assert first_turn.status_code == 200
    assert "how much blood did you notice" in first_turn.json()["messages"][-1]["text"].lower()
    pending = first_turn.json()["entries"][0]
    pending_id = pending["id"]
    assert pending["structured"]["needsClarification"] == "bloodAmount"
    assert pending["structured"]["blood"] == "reported"

    clarified = client.post("/api/chat", json={"text": "just a small amount"})

    assert clarified.status_code == 200
    payload = clarified.json()
    assert [entry["id"] for entry in payload["entries"]] == [pending_id]
    assert payload["entries"][0]["structured"]["blood"] == "small"
    assert "needsClarification" not in payload["entries"][0]["structured"]
    assert payload["safety"] is None
    assert payload["messages"][-1]["category"] == "recorded fact"
    assert payload["messages"][-1]["sources"][0]["entryId"] == pending_id

    after, _ = _bootstrap(client)
    assert len(after["entries"]) == len(before["entries"]) + 1
    corrected = next(entry for entry in after["entries"] if entry["id"] == pending_id)
    assert "follow-up clarification: small blood" in corrected["body"]
    linked_sources = [
        source
        for message in after["messages"]
        for source in message.get("sources", [])
        if source.get("entryId") == pending_id
    ]
    assert len(linked_sources) == 2
    assert all(source["detail"] == corrected["body"] for source in linked_sources)
    assert corrected["body"] in after["clinicianSummary"]
    assert "linked evidence" in after["audit"][0]["action"]
    assert "deterministic safety" in after["audit"][0]["action"]


@pytest.mark.parametrize(
    ("answer", "expected_amount", "expected_level"),
    [
        ("none", "none", None),
        ("small", "small", None),
        ("a moderate amount", "moderate", "same-day"),
        ("a large amount", "heavy", "emergency"),
        ("I am unsure", "reported; amount not specified", None),
    ],
)
def test_chat_blood_clarification_variants_rerun_deterministic_safety(
    domain_client: tuple[TestClient, SQLiteDemoStore],
    answer: str,
    expected_amount: str,
    expected_level: str | None,
) -> None:
    client, _ = domain_client
    pending = client.post("/api/chat", json={"text": "There was blood"}).json()["entries"][0]

    response = client.post("/api/chat", json={"text": answer})

    assert response.status_code == 200
    result = response.json()
    assert result["entries"][0]["id"] == pending["id"]
    assert result["entries"][0]["structured"]["blood"] == expected_amount
    assert "needsClarification" not in result["entries"][0]["structured"]
    assert (result["safety"] or {}).get("level") == expected_level
    if expected_level is not None:
        state, _ = _bootstrap(client)
        assert state["safetyAlert"]["level"] == expected_level
        assert result["messages"][-1]["category"] == "general information"


def test_pending_chat_clarification_respects_assistant_journal_access(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    pending = client.post("/api/chat", json={"text": "Loose stool and blood"}).json()["entries"][0]
    assert client.patch("/api/privacy", json={"assistantJournalAccess": False}).status_code == 200

    blocked = client.post("/api/chat", json={"text": "moderate"})

    assert blocked.status_code == 403
    state, _ = _bootstrap(client)
    unchanged = next(entry for entry in state["entries"] if entry["id"] == pending["id"])
    assert unchanged["structured"]["needsClarification"] == "bloodAmount"
    assert unchanged["structured"]["blood"] == "reported"


def test_chat_conversation_retrieval_uses_its_independent_permission(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    assert client.patch("/api/privacy", json={"assistantJournalAccess": False}).status_code == 200
    retrieved = client.post("/api/chat", json={"text": "What did I tell you earlier?"})
    assert retrieved.status_code == 200
    assert retrieved.json()["messages"][-1]["sources"][0]["messageId"] == 2

    assert (
        client.patch("/api/privacy", json={"assistantConversationAccess": False}).status_code == 200
    )
    refused = client.post("/api/chat", json={"text": "What did I say earlier?"})
    assert refused.status_code == 200
    assert "access is off" in refused.json()["messages"][-1]["text"].lower()
    assert refused.json()["messages"][-1]["sources"] == []


def test_chat_uses_a_varied_provider_reply_for_an_ordinary_question(
    domain_client: tuple[TestClient, SQLiteDemoStore], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, _ = domain_client

    context: dict[str, str | None] = {}

    async def varied_reply(*_args: object, **kwargs: object) -> str:
        grounded_context = kwargs.get("grounded_context")
        context["grounded_context"] = (
            grounded_context if isinstance(grounded_context, str) else None
        )
        return "I’m here with you — what would feel most useful to talk through?"

    monkeypatch.setattr(domain_routes, "_varied_chat_reply", varied_reply)
    response = client.post("/api/chat", json={"text": "Can we just talk for a moment?"})

    assert response.status_code == 200
    assert response.json()["messages"][-1]["text"].startswith("I’m here with you")
    assert "Watchful demo scenario" in context["grounded_context"]


def test_chat_persists_only_the_active_scenario_thread(
    domain_client: tuple[TestClient, SQLiteDemoStore], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, store = domain_client

    def prepare_flare_scenario(state: dict[str, Any]) -> None:
        state["phase"] = "flare"
        state["messages"] = []
        state["profileProposals"] = []
        state["chatHistories"]["flare"] = []
        state["profileProposalsByPhase"]["flare"] = []

    store.mutate(prepare_flare_scenario, "Prepared independent flare chat", actor="test")
    stable_before = [
        message.model_dump(mode="json", by_alias=True)
        for message in store.get().chatHistories["stable"]
    ]

    async def varied_reply(*_args: object, **_kwargs: object) -> str:
        return "Let’s take this one step at a time."

    monkeypatch.setattr(domain_routes, "_varied_chat_reply", varied_reply)
    response = client.post("/api/chat", json={"text": "Can we talk about today?"})

    assert response.status_code == 200
    saved = store.get()
    assert [
        message.model_dump(mode="json", by_alias=True) for message in saved.chatHistories["stable"]
    ] == stable_before
    assert len(saved.chatHistories["flare"]) == 2
    assert [message.id for message in saved.messages] == [
        message.id for message in saved.chatHistories["flare"]
    ]


def test_snapshot_switch_restores_each_saved_scenario_chat(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    state, etag = _bootstrap(client)
    watch_messages = list(state["messages"])
    stable_messages = list(state["chatHistories"]["stable"])

    state.update({"phase": "stable", "pendingPhase": None, "phaseConfirmed": False})
    state["chatHistories"]["watch"] = watch_messages
    state["profileProposalsByPhase"]["watch"] = list(state["profileProposals"])
    state["messages"] = stable_messages
    state["profileProposals"] = list(
        state["profileProposalsByPhase"].get("stable", [])
    )

    opened_stable = client.put("/api/demo", headers={"If-Match": etag}, json=state)

    assert opened_stable.status_code == 200, opened_stable.text
    stable_state = opened_stable.json()
    assert stable_state["phase"] == "stable"
    assert stable_state["messages"] == stable_messages
    assert stable_state["chatHistories"]["stable"] == stable_messages
    assert stable_state["chatHistories"]["watch"] == watch_messages

    stable_state.update({"phase": "watch", "pendingPhase": None, "phaseConfirmed": False})
    stable_state["chatHistories"]["stable"] = list(stable_state["messages"])
    stable_state["profileProposalsByPhase"]["stable"] = list(
        stable_state["profileProposals"]
    )
    stable_state["messages"] = list(stable_state["chatHistories"]["watch"])
    stable_state["profileProposals"] = list(
        stable_state["profileProposalsByPhase"].get("watch", [])
    )

    reopened_watch = client.put(
        "/api/demo",
        headers={"If-Match": opened_stable.headers["etag"]},
        json=stable_state,
    )

    assert reopened_watch.status_code == 200, reopened_watch.text
    assert reopened_watch.json()["phase"] == "watch"
    assert reopened_watch.json()["messages"] == watch_messages
    assert reopened_watch.json()["chatHistories"]["stable"] == stable_messages
    assert reopened_watch.json()["chatHistories"]["watch"] == watch_messages


def test_snapshot_cannot_rewrite_an_inactive_scenario_chat(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    state, etag = _bootstrap(client)
    state["chatHistories"]["stable"][0]["text"] = "Forged inactive conversation"

    rejected = client.put("/api/demo", headers={"If-Match": etag}, json=state)

    assert rejected.status_code == 409
    assert "inactive demo conversations" in rejected.json()["detail"].lower()


def test_chat_uses_highest_safety_level_across_all_parsed_entries(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client

    response = client.post(
        "/api/chat",
        json={"text": "There was a moderate amount of blood. My pain is 9/10."},
    )

    assert response.status_code == 200
    safety = response.json()["safety"]
    assert safety["level"] == "emergency"
    assert "Moderate bleeding" in safety["triggers"]
    assert "Severe abdominal pain (8/10 or higher)" in safety["triggers"]


def test_journal_crud_runs_deterministic_safety(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    response = client.post(
        "/api/journal",
        json={
            "kind": "BOWEL MOVEMENT",
            "body": "Heavy continuous bleeding and severe pain",
            "source": "manual",
            "structured": {"blood": "continuous", "pain": 9},
        },
    )
    assert response.status_code == 201
    entry_id = response.json()["id"]

    state, _ = _bootstrap(client)
    assert state["safetyAlert"]["level"] == "emergency"
    assert state["safetyAlert"]["triggers"] == [
        "Heavy or continuous bleeding",
        "Severe abdominal pain (8/10 or higher)",
    ]

    corrected = client.patch(
        f"/api/journal/{entry_id}",
        json={"excluded": True, "body": "Incorrect entry — excluded"},
    )
    assert corrected.status_code == 200
    assert corrected.json()["excluded"] is True
    assert client.delete(f"/api/journal/{entry_id}").status_code == 204
    assert client.get(f"/api/journal/{entry_id}").status_code == 404


def test_stale_photo_removal_cannot_revert_a_concurrent_correction_or_its_sources(
    domain_client: tuple[TestClient, SQLiteDemoStore],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, store = domain_client
    entry_id = 1

    def attach_photo(state: dict[str, Any]) -> None:
        entry = next(item for item in state["entries"] if item["id"] == entry_id)
        entry["photo"] = {
            "name": "meal.jpg",
            "previewUrl": "data:image/jpeg;base64,YQ==",
            "purpose": "meal",
            "retentionDays": 30,
            "consented": True,
            "derivedObservation": None,
        }

    store.mutate(attach_photo, "Attached concurrency-test photo", actor="test")
    original_mutate = store.mutate
    raced = False
    concurrent_body = "Concurrent correction retained in entry and linked sources"

    def racing_mutate(mutator: Any, action: str, **kwargs: Any) -> Any:
        nonlocal raced
        if not raced and action.startswith(f"Corrected journal entry {entry_id}"):
            raced = True

            def apply_concurrent_correction(state: dict[str, Any]) -> None:
                entry = next(item for item in state["entries"] if item["id"] == entry_id)
                entry["body"] = concurrent_body
                for message in state["messages"]:
                    for source in message.get("sources", []):
                        if source.get("entryId") == entry_id:
                            source["detail"] = concurrent_body

            original_mutate(
                apply_concurrent_correction,
                "Committed a concurrent journal correction",
                actor="test",
            )
        return original_mutate(mutator, action, **kwargs)

    monkeypatch.setattr(store, "mutate", racing_mutate)

    stale_removal = client.patch(f"/api/journal/{entry_id}", json={"photo": None})

    assert stale_removal.status_code == 409
    assert "journal changed" in stale_removal.json()["detail"].lower()
    conflicted = client.get("/api/demo").json()
    retained = next(item for item in conflicted["entries"] if item["id"] == entry_id)
    assert retained["body"] == concurrent_body
    assert retained["photo"]["name"] == "meal.jpg"
    linked = [
        source
        for message in conflicted["messages"]
        for source in message.get("sources", [])
        if source.get("entryId") == entry_id
    ]
    assert linked
    assert all(source["detail"] == concurrent_body for source in linked)

    retried = client.patch(f"/api/journal/{entry_id}", json={"photo": None})
    assert retried.status_code == 200
    assert retried.json()["body"] == concurrent_body
    assert retried.json()["photo"] is None
    after_retry = client.get("/api/demo").json()
    assert all(
        source["detail"] == concurrent_body
        for message in after_retry["messages"]
        for source in message.get("sources", [])
        if source.get("entryId") == entry_id
    )


def test_stale_journal_delete_conflicts_before_removing_a_concurrently_corrected_entry(
    domain_client: tuple[TestClient, SQLiteDemoStore],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, store = domain_client
    entry_id = 5
    original_mutate = store.mutate
    raced = False
    concurrent_body = "Concurrent pain correction remains reviewable"

    def racing_mutate(mutator: Any, action: str, **kwargs: Any) -> Any:
        nonlocal raced
        if not raced and action.startswith(f"Deleted journal entry {entry_id}"):
            raced = True

            def apply_concurrent_correction(state: dict[str, Any]) -> None:
                entry = next(item for item in state["entries"] if item["id"] == entry_id)
                entry["body"] = concurrent_body
                for message in state["messages"]:
                    for source in message.get("sources", []):
                        if source.get("entryId") == entry_id:
                            source["detail"] = concurrent_body

            original_mutate(
                apply_concurrent_correction,
                "Committed a concurrent correction before deletion",
                actor="test",
            )
        return original_mutate(mutator, action, **kwargs)

    monkeypatch.setattr(store, "mutate", racing_mutate)

    stale_delete = client.delete(f"/api/journal/{entry_id}")

    assert stale_delete.status_code == 409
    conflicted = client.get("/api/demo").json()
    retained = next(item for item in conflicted["entries"] if item["id"] == entry_id)
    assert retained["body"] == concurrent_body
    assert any(
        source["detail"] == concurrent_body
        for message in conflicted["messages"]
        for source in message.get("sources", [])
        if source.get("entryId") == entry_id
    )

    assert client.delete(f"/api/journal/{entry_id}").status_code == 204
    deleted = client.get("/api/demo").json()
    assert all(item["id"] != entry_id for item in deleted["entries"])
    tombstones = [
        source
        for message in deleted["messages"]
        for source in message.get("sources", [])
        if source.get("entryId") == entry_id
    ]
    assert tombstones
    assert all(source["excluded"] is True for source in tombstones)


def test_generic_journal_cannot_forge_workflow_provenance_or_adherence(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    for source in ("chat", "care", "wearable", "penny"):
        forged_source = client.post(
            "/api/journal",
            json={"kind": "WELLBEING", "body": "Forged source", "source": source},
        )
        assert forged_source.status_code == 403

    forged_adherence = client.post(
        "/api/journal",
        json={
            "kind": "MEDICATION",
            "body": "Forged taper adherence",
            "source": "manual",
            "flagged": False,
            "structured": {"taperDay": 12, "taken": True, "doseMg": 25},
        },
    )
    assert forged_adherence.status_code == 403

    ordinary = client.post(
        "/api/journal",
        json={
            "kind": "MEDICATION",
            "body": "Patient-recorded regular medicine",
            "source": "manual",
            "structured": {"taken": True, "doseMg": 100},
        },
    )
    assert ordinary.status_code == 201
    forged_patch = client.patch(
        f"/api/journal/{ordinary.json()['id']}",
        json={"structured": {"taken": True, "doseMg": 100, "taperDay": 12}},
    )
    assert forged_patch.status_code == 409


def test_body_correction_refreshes_structured_evidence_links_and_summary(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client

    corrected = client.patch(
        "/api/journal/6",
        json={
            "body": ("Bristol type 4, no blood, no urgency, no mucus, no night waking, pain 1/10")
        },
    )

    assert corrected.status_code == 200
    assert corrected.json()["structured"] == {
        "bristol": 4,
        "urgency": False,
        "blood": "none",
        "mucus": False,
        "nightWaking": False,
        "pain": 1,
    }
    state, _ = _bootstrap(client)
    source = next(
        source
        for message in state["messages"]
        for source in message.get("sources", [])
        if source.get("entryId") == 6
    )
    assert source["detail"].startswith("Bristol type 4")
    assert "Bristol type 4" in state["clinicianSummary"]
    assert state["phaseConfirmed"] is False

    relabelled = client.patch(
        "/api/journal/6",
        json={
            "kind": "WELLBEING",
            "body": "Feeling same as usual",
            "date": "2026-07-18",
            "time": "09:15",
        },
    )
    assert relabelled.status_code == 200
    state, _ = _bootstrap(client)
    source = next(
        source
        for message in state["messages"]
        for source in message.get("sources", [])
        if source.get("entryId") == 6
    )
    assert source["label"] == "WELLBEING"
    assert source["date"] == "2026-07-18, 09:15"


def test_corrections_rebuild_wellbeing_wearable_and_medication_structure(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    wellbeing = client.post(
        "/api/journal",
        json={
            "kind": "WELLBEING",
            "body": "Old note",
            "source": "manual",
            "structured": {"wellbeing": "same", "weightKg": 99},
        },
    ).json()
    corrected = client.patch(
        f"/api/journal/{wellbeing['id']}",
        json={
            "body": (
                "Feeling worse, high fatigue, slept 4.5 hours, weight 62 kg, "
                "mood anxious, appetite poor"
            )
        },
    )
    assert corrected.status_code == 200
    assert corrected.json()["structured"] == {
        "wellbeing": "worse",
        "weightKg": 62.0,
        "fatigue": "high",
        "sleepHours": 4.5,
        "mood": "anxious",
        "appetite": "poor",
    }
    assert corrected.json()["flagged"] is True

    changed_kind = client.patch(
        f"/api/journal/{wellbeing['id']}",
        json={"kind": "FATIGUE", "body": "Fatigue moderate, slept 6 hours"},
    )
    assert changed_kind.status_code == 200
    assert changed_kind.json()["structured"] == {"fatigue": "moderate", "sleepHours": 6.0}
    assert changed_kind.json()["flagged"] is False

    wearable = client.patch(
        "/api/journal/2",
        json={"body": "Resting heart rate 59 bpm · HRV 45.5 ms · sleep 7 hours"},
    )
    assert wearable.status_code == 200
    assert wearable.json()["structured"]["restingHeartRate"] == 59
    assert wearable.json()["structured"]["heartRateVariabilityMs"] == 45.5
    assert wearable.json()["structured"]["sleepHours"] == 7.0
    assert wearable.json()["structured"]["softSignal"] is True

    medication = client.post(
        "/api/journal",
        json={
            "kind": "MEDICATION",
            "body": "Azathioprine 100 mg taken",
            "source": "manual",
            "structured": {"taken": True, "doseMg": 100},
        },
    ).json()
    missed = client.patch(
        f"/api/journal/{medication['id']}",
        json={"body": "Azathioprine 100 mg not taken — missed"},
    )
    assert missed.json()["structured"]["taken"] is False
    assert missed.json()["structured"]["doseMg"] == 100
    assert missed.json()["flagged"] is True


def test_moderate_bleeding_surfaces_same_day_not_emergency_guidance(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client

    created = client.post(
        "/api/journal",
        json={
            "kind": "BOWEL MOVEMENT",
            "body": "Moderate amount of blood",
            "source": "manual",
            "structured": {"blood": "moderate"},
        },
    )

    assert created.status_code == 201
    state, _ = _bootstrap(client)
    assert state["safetyAlert"]["level"] == "same-day"
    assert state["safetyAlert"]["triggers"] == ["Moderate bleeding"]


def test_photo_consent_cannot_be_bypassed_by_create_patch_or_snapshot(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    photo = {
        "name": "toilet.jpg",
        "previewUrl": "data:image/jpeg;base64,YQ==",
        "purpose": "toilet",
        "retentionDays": 7,
        "consented": True,
    }
    denied = client.post(
        "/api/journal",
        json={
            "date": "2026-07-17",
            "time": "09:00",
            "kind": "BOWEL MOVEMENT",
            "body": "Optional photo",
            "source": "manual",
            "photo": photo,
        },
    )
    assert denied.status_code == 403

    entry_id = _bootstrap(client)[0]["entries"][0]["id"]
    assert client.patch(f"/api/journal/{entry_id}", json={"photo": photo}).status_code == 403

    assert client.patch("/api/privacy", json={"toiletPhotoConsent": True}).status_code == 200
    attached = client.patch(f"/api/journal/{entry_id}", json={"photo": photo})
    assert attached.status_code == 200
    assert attached.json()["photo"]["previewUrl"].startswith("data:")
    removed = client.patch(f"/api/journal/{entry_id}", json={"photo": None})
    assert removed.status_code == 200
    assert removed.json()["photo"] is None

    state, etag = _bootstrap(client)
    bad_entry = dict(state["entries"][0])
    bad_entry["id"] = max(item["id"] for item in state["entries"]) + 1
    bad_entry["photo"] = {**photo, "purpose": "meal", "consented": False}
    state["entries"].append(bad_entry)
    bypass = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert bypass.status_code == 422


def test_toilet_photo_consent_withdrawal_deletes_attachment_but_keeps_health_record(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    assert client.patch("/api/privacy", json={"toiletPhotoConsent": True}).status_code == 200
    entry_id = _bootstrap(client)[0]["entries"][0]["id"]
    original_body = client.get(f"/api/journal/{entry_id}").json()["body"]
    marker = "GUTSY_WITHDRAWN_TOILET_MEDIA_7f32"
    attached = client.patch(
        f"/api/journal/{entry_id}",
        json={
            "photo": {
                "name": "private-toilet.jpg",
                "previewUrl": "data:image/jpeg;base64,YQ==",
                "purpose": "toilet",
                "retentionDays": 7,
                "consented": True,
                "derivedObservation": marker,
            }
        },
    )
    assert attached.status_code == 200

    withdrawn = client.patch("/api/privacy", json={"toiletPhotoConsent": False})

    assert withdrawn.status_code == 200
    assert withdrawn.json()["toiletPhotoConsent"] is False
    retained = client.get(f"/api/journal/{entry_id}").json()
    assert retained["body"] == original_body
    assert retained["photo"] is None
    assert retained["structured"]["mediaRemovedAfterConsentWithdrawal"] is True
    for artifact in _sqlite_artifacts(store.path):
        assert marker.encode() not in artifact.read_bytes(), artifact.name


def test_media_retention_removes_payload_not_health_entry(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    marker = "GUTSY_RETENTION_PURGE_PROBE_4df91"
    created = client.post(
        "/api/journal",
        json={
            "date": "2026-01-01",
            "time": "12:00",
            "kind": "MEAL",
            "body": "Soup and bread",
            "source": "manual",
            "photo": {
                "name": "meal.jpg",
                "previewUrl": "data:image/jpeg;base64,YQ==",
                "purpose": "meal",
                "retentionDays": 7,
                "consented": True,
                "derivedObservation": marker,
            },
        },
    )
    assert created.status_code == 201
    entry_id = created.json()["id"]

    cleanup = client.post("/api/privacy/media/cleanup?as_of=2026-07-17")
    assert cleanup.status_code == 200
    assert cleanup.json()["removedEntryIds"] == [entry_id]
    retained = client.get(f"/api/journal/{entry_id}").json()
    assert retained["body"] == "Soup and bread"
    assert retained["photo"]["previewUrl"] == ""
    assert retained["photo"]["derivedObservation"] is None
    assert retained["structured"]["mediaRetentionExpired"] is True
    for artifact in _sqlite_artifacts(store.path):
        assert marker.encode() not in artifact.read_bytes(), artifact.name

    revision = client.get("/api/demo").headers["etag"]
    repeat = client.post("/api/privacy/media/cleanup?as_of=2026-07-17")
    assert repeat.json()["removedCount"] == 0
    assert client.get("/api/demo").headers["etag"] == revision


def test_app_lifespan_automatically_cleans_expired_media(tmp_path: Path) -> None:
    store = SQLiteDemoStore(tmp_path / "retention-lifespan.sqlite3")

    def attach_expired_photo(state: dict[str, Any]) -> None:
        entry = state["entries"][0]
        entry["date"] = "2000-01-01"
        entry["photo"] = {
            "name": "expired-meal.jpg",
            "previewUrl": "data:image/jpeg;base64,YXV0b21hdGljLXJldGVudGlvbg==",
            "purpose": "meal",
            "retentionDays": 7,
            "consented": True,
            "derivedObservation": "Sensitive model observation",
        }

    store.mutate(attach_expired_photo, "Attached expired media test fixture")
    entry_id = store.get().entries[0].id
    previous = dict(app.dependency_overrides)
    app.dependency_overrides[get_demo_store] = lambda: store
    try:
        with TestClient(app) as client:
            retained = client.get(f"/api/journal/{entry_id}").json()
            assert retained["photo"]["previewUrl"] == ""
            assert retained["photo"]["derivedObservation"] is None
            assert retained["structured"]["mediaRetentionExpired"] is True
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)


@pytest.mark.parametrize(
    ("payload", "level", "trigger"),
    [
        ({"feverC": 38.4}, "same-day", "Fever (38.4°C)"),
        ({"pain": 9}, "emergency", "Severe abdominal pain (8/10 or higher)"),
        (
            {"vomiting": True, "cannotPassStoolOrGas": True},
            "emergency",
            "Vomiting with inability to pass stool or gas (possible obstruction)",
        ),
    ],
)
def test_safety_rules_are_deterministic(
    domain_client: tuple[TestClient, SQLiteDemoStore],
    payload: dict[str, Any],
    level: str,
    trigger: str,
) -> None:
    client, _ = domain_client
    response = client.post("/api/safety/evaluate", json=payload)
    assert response.status_code == 200
    assert response.json()["evaluation"]["level"] == level
    assert trigger in response.json()["evaluation"]["triggers"]
    assert response.json()["evaluation"]["source"] == "deterministic-rules-v1"


def test_safety_screen_uses_recorded_immunosuppression_context(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    contextual = client.post("/api/safety/evaluate", json={"feverC": 37.6})
    assert contextual.status_code == 200
    assert contextual.json()["evaluation"]["level"] == "same-day"
    assert "immunosuppressed" in contextual.json()["evaluation"]["triggers"][0]

    assert client.patch("/api/profile", json={"immunosuppressed": False}).status_code == 200
    ordinary = client.post("/api/safety/evaluate", json={"feverC": 37.6})
    assert ordinary.json()["evaluation"]["level"] == "routine"


def test_lifecycle_uses_recent_window_and_wearable_cannot_trigger_alone(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    store.mutate(
        lambda state: state.update(
            {"phase": "stable", "pendingPhase": None, "phaseConfirmed": False}
        ),
        "Prepared stable lifecycle-window fixture",
        actor="test",
    )
    entries = [
        {
            "id": 1,
            "date": "2026-01-01",
            "time": "08:00",
            "kind": "BOWEL MOVEMENT",
            "body": "Old loose stool with blood",
            "source": "manual",
            "flagged": True,
            "excluded": False,
            "structured": {"bristol": 7, "blood": "small", "urgency": True},
            "photo": None,
        },
        {
            "id": 2,
            "date": "2026-07-17",
            "time": "08:00",
            "kind": "FROM YOUR WATCH",
            "body": "Resting HR 68 bpm · HRV 34 ms · sleep 4 h · activity 900 steps",
            "source": "wearable",
            "flagged": False,
            "excluded": False,
            "structured": {
                "restingHeartRate": 68,
                "heartRateVariabilityMs": 34,
                "sleepHours": 4,
                "activitySteps": 900,
                "softSignal": True,
            },
            "photo": None,
        },
    ]
    store.mutate(
        lambda state: state.update({"entries": entries}),
        "Installed server-sourced wearable lifecycle fixture",
        actor="test",
    )

    evaluation = client.get("/api/lifecycle")
    assert evaluation.status_code == 200
    assert evaluation.json()["proposedPhase"] is None
    assert {signal["key"] for signal in evaluation.json()["signals"]} == {
        "resting_heart_rate",
        "sleep_context",
        "hrv_context",
        "activity_context",
    }
    assert all(signal["clinical"] is False for signal in evaluation.json()["signals"])
    assert (
        f"seven-day window {(date.today() - timedelta(days=6)).isoformat()} "
        f"to {date.today().isoformat()}"
    ) in evaluation.json()["explanation"]


def test_repeated_one_tap_worse_checkins_persist_a_watchful_proposal(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    store.mutate(
        lambda state: state.update(
            {"phase": "stable", "pendingPhase": None, "phaseConfirmed": False}
        ),
        "Prepared stable one-tap fixture",
        actor="test",
    )
    store.mutate(
        lambda state: state.update({"entries": []}),
        "Cleared journal for one-tap lifecycle fixture",
        actor="test",
    )

    for body, recorded_date in (
        ("Feeling worse than usual", (date.today() - timedelta(days=1)).isoformat()),
        ("Still feeling worse than usual", date.today().isoformat()),
    ):
        saved = client.post(
            "/api/journal",
            json={
                "kind": "WELLBEING",
                "body": body,
                "date": recorded_date,
                "source": "manual",
                "structured": {"wellbeing": "worse", "oneTap": True},
            },
        )
        assert saved.status_code == 201

    state, _ = _bootstrap(client)
    assert state["phase"] == "stable"
    assert state["pendingPhase"] == "watch"
    assert state["phaseConfirmed"] is False
    evaluation = client.get("/api/lifecycle").json()
    assert evaluation["proposedPhase"] == "watch"
    assert next(signal for signal in evaluation["signals"] if signal["key"] == "wellbeing_worse")[
        "evidenceEntryIds"
    ]


def test_workflow_changes_persist_recovery_and_stable_proposals(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    today = date.today()

    def prepare_objective_flare(value: dict[str, Any]) -> None:
        value.update({"phase": "flare", "pendingPhase": None, "phaseConfirmed": True})
        for entry in value["entries"]:
            if entry["kind"] != "TEST RESULT":
                entry["excluded"] = True
        value["testOrder"].update(
            {"status": "result", "result": 420, "resultNote": "Raised; clinical review required"}
        )
        value["entries"].append(
            {
                "id": 980,
                "date": today.isoformat(),
                "time": "07:00",
                "kind": "TEST RESULT",
                "body": "Faecal calprotectin 420 µg/g — clinical interpretation required",
                "source": "care",
                "flagged": True,
                "excluded": False,
                "structured": {"calprotectin": 420, "diagnostic": False},
            }
        )

    store.mutate(prepare_objective_flare, "Prepared objective flare fixture", actor="test")
    for path in (
        "/api/care/prescription/request",
        "/api/care/prescription/simulate-approve",
        "/api/care/prescription/simulate-ready",
        "/api/care/prescription/collect",
    ):
        assert client.post(path).status_code == 200
    state, _ = _bootstrap(client)
    assert state["pendingPhase"] is None

    def prepare_response_window(value: dict[str, Any]) -> None:
        value["prescription"]["treatmentStartedAt"] = (
            f"{(today - timedelta(days=3)).isoformat()}T08:00:00+00:00"
        )
        for offset, entry_id, kind, structured in (
            (2, 981, "WELLBEING", {"wellbeing": "better"}),
            (1, 982, "PAIN", {"pain": 2}),
        ):
            value["entries"].append(
                {
                    "id": entry_id,
                    "date": (today - timedelta(days=offset)).isoformat(),
                    "time": "09:00",
                    "kind": kind,
                    "body": "Symptoms settling toward the recorded baseline",
                    "source": "manual",
                    "flagged": False,
                    "excluded": False,
                    "structured": structured,
                }
            )

    store.mutate(prepare_response_window, "Prepared elapsed response window", actor="test")
    assert client.post("/api/lifecycle/evaluate").json()["proposedPhase"] == "recovery"
    state, _ = _bootstrap(client)
    assert state["pendingPhase"] == "recovery"
    assert state["phaseConfirmed"] is False

    def prepare_final_day(value: dict[str, Any]) -> None:
        value.update({"phase": "recovery", "pendingPhase": None, "phaseConfirmed": True})
        start = today - timedelta(days=41)
        for index, day in enumerate(value["taper"]["days"]):
            day["date"] = (start + timedelta(days=index)).isoformat()
            day["taken"] = day["day"] != 42
        value["taper"].update({"verified": True, "currentDay": 42, "missedDays": []})

    store.mutate(prepare_final_day, "Prepared final-day lifecycle fixture", actor="test")
    assert client.post("/api/taper/dose/taken").status_code == 200
    state, _ = _bootstrap(client)
    assert state["pendingPhase"] == "stable"
    assert state["phaseConfirmed"] is False


def test_repeated_worsening_taper_checkins_feed_recovery_relapse_evidence(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    today = date.today()

    def prepare_recovery(value: dict[str, Any]) -> None:
        value.update({"phase": "recovery", "pendingPhase": None, "phaseConfirmed": True})
        for entry in value["entries"]:
            entry["excluded"] = True
        value["prescription"].update(
            {
                "status": "collected",
                "treatmentStartedAt": f"{(today - timedelta(days=4)).isoformat()}T08:00:00+00:00",
            }
        )
        value["entries"].append(
            {
                "id": 990,
                "date": (today - timedelta(days=2)).isoformat(),
                "time": "08:00",
                "kind": "WELLBEING",
                "body": "Symptoms initially settling",
                "source": "manual",
                "flagged": False,
                "excluded": False,
                "structured": {"wellbeing": "better"},
            }
        )

    store.mutate(prepare_recovery, "Prepared recovery relapse fixture", actor="test")
    for _ in range(2):
        checked = client.post(
            "/api/taper/check-in",
            json={"symptomsWorse": True, "notes": "Symptoms worsened again"},
        )
        assert checked.status_code == 200

    state, _ = _bootstrap(client)
    relapse_entries = [
        entry
        for entry in state["entries"]
        if entry["structured"].get("taperCheckIn")
        and entry["structured"].get("wellbeing") == "worse"
    ]
    assert len(relapse_entries) == 2
    assert state["pendingPhase"] == "recovery"
    assert state["safetyAlert"]["level"] == "same-day"

    def put_changes_on_distinct_days(value: dict[str, Any]) -> None:
        matches = [
            entry
            for entry in value["entries"]
            if entry.get("structured", {}).get("taperCheckIn")
            and entry.get("structured", {}).get("wellbeing") == "worse"
        ]
        matches[0]["date"] = (today - timedelta(days=1)).isoformat()

    store.mutate(
        put_changes_on_distinct_days,
        "Prepared distinct-day recovery relapse fixture",
        actor="test",
    )
    assert client.post("/api/lifecycle/evaluate").json()["proposedPhase"] == "flare"
    assert _bootstrap(client)[0]["pendingPhase"] == "flare"


def test_demo_phase_switch_cannot_confer_test_order_eligibility(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    before, _ = _bootstrap(client)
    switched = client.post(
        "/api/demo/phase", json={"phase": "stable", "reason": "Presentation-only demo switch"}
    )
    assert switched.status_code == 200
    assert switched.json()["phase"] == before["phase"]
    assert switched.json()["pendingPhase"] == before["pendingPhase"]
    assert switched.json()["phaseConfirmed"] == before["phaseConfirmed"]

    blocked = client.post(
        "/api/care/test-order/confirm",
        json={"addressConfirmed": True, "consent": True},
    )
    assert blocked.status_code == 409
    assert "confirm" in blocked.json()["detail"].lower()


def test_generic_stable_confirmation_and_manual_proposal_cannot_launder_demo_state(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    store.mutate(
        lambda state: (
            state.update({"phase": "stable", "pendingPhase": None, "phaseConfirmed": False}),
            state.update({"entries": []}),
        ),
        "Prepared presentation-only stable fixture",
        actor="test",
    )

    confirmed = client.post("/api/lifecycle/confirm")
    assert confirmed.status_code == 409
    assert "evidence-governed" in confirmed.json()["detail"]
    proposed = client.post("/api/lifecycle/propose", json={"phase": "watch"})
    assert proposed.status_code == 409
    assert "governed lifecycle rule" in proposed.json()["detail"]
    assert client.post("/api/experiment/start").status_code == 409


def test_clean_onboarded_stable_baseline_can_be_confirmed_and_reaches_experiments(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    state = _complete_clean_stable_onboarding(client)
    assert state["phase"] == "stable"
    assert state["phaseConfirmed"] is False
    assert state["pendingPhase"] is None
    assert client.get("/api/lifecycle").json()["proposedPhase"] is None
    assert client.post("/api/experiment/start").status_code == 409

    confirmed = client.post("/api/lifecycle/confirm")
    assert confirmed.status_code == 200
    assert confirmed.json()["phase"] == "stable"
    assert confirmed.json()["phaseConfirmed"] is True
    assert confirmed.json()["pendingPhase"] is None

    candidate = client.patch(
        "/api/experiment",
        json={
            "title": "Oat milk instead of dairy milk",
            "variable": "Milk choice only",
            "goal": "Observe morning urgency",
            "baseline": "Morning urgency 2/10 before day 1",
            "outcome": "Morning urgency score",
            "durationDays": 7,
        },
    )
    assert candidate.status_code == 200
    assert client.post("/api/experiment/start").json()["status"] == "active"


def test_clean_stable_confirmation_rejects_safety_instability_and_paused_consent(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    _complete_clean_stable_onboarding(client)
    store.mutate(
        lambda state: state.update(
            {
                "safetyAlert": {
                    "id": 1,
                    "level": "same-day",
                    "triggers": ["Fever"],
                    "message": "Contact the clinical team today.",
                    "createdAt": "2026-07-18T08:30:00+00:00",
                }
            }
        ),
        "Prepared unresolved safety instability fixture",
        actor="test",
    )
    unsafe = client.post("/api/lifecycle/confirm")
    assert unsafe.status_code == 409
    assert "eligible clean Stable baseline" in unsafe.json()["detail"]

    store.mutate(
        lambda state: (
            state.update({"safetyAlert": None}),
            state["profile"].update({"healthDataConsent": False, "onboardingComplete": False}),
        ),
        "Prepared paused-consent Stable fixture",
        actor="test",
    )
    paused = client.post("/api/lifecycle/confirm")
    assert paused.status_code == 403
    assert "Health-data tracking is paused" in paused.json()["detail"]


def test_source_correction_invalidates_review_and_order_rechecks_current_evidence(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    _confirm_watchful_state(client)

    for entry_id in (1, 5, 6):
        response = client.patch(f"/api/journal/{entry_id}", json={"excluded": True})
        assert response.status_code == 200

    state, _ = _bootstrap(client)
    assert state["phaseConfirmed"] is False
    assert state["pendingPhase"] == "watch"

    reconfirm = client.post("/api/lifecycle/confirm")
    assert reconfirm.status_code == 409
    assert "no current evidence-governed phase proposal" in reconfirm.json()["detail"]

    # Defence in depth: even a corrupted/sticky flag cannot bypass re-evaluation at submission.
    store.mutate(
        lambda value: value.update({"phaseConfirmed": True}),
        "Test fixture simulated a stale confirmation flag",
        actor="test",
    )
    order = client.post(
        "/api/care/test-order/confirm",
        json={"addressConfirmed": True, "consent": True},
    )
    assert order.status_code == 409
    assert "no longer meet" in order.json()["detail"]


def test_test_order_requires_evidence_confirmation_and_advances_idempotently(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    prepared = client.get("/api/care/test-order").json()
    assert prepared["clinicalOwner"] == "St Mary’s IBD service (simulated clinical owner)"
    assert prepared["eligibilityRule"] == "IBD-WATCH-CALPROTECTIN-DEMO-v1"
    assert "never an LLM- or image-only decision" in prepared["eligibilityReason"]
    blocked = client.post(
        "/api/care/test-order/confirm",
        json={"addressConfirmed": True, "consent": True},
    )
    assert blocked.status_code == 409

    _confirm_watchful_state(client)
    ordered = client.post(
        "/api/care/test-order/confirm",
        json={"addressConfirmed": True, "consent": True},
    )
    assert ordered.status_code == 200
    assert ordered.json()["status"] == "ordered"
    assert ordered.json()["statusUpdatedAt"]
    assert ordered.json()["statusUpdatedAt"] != prepared["statusUpdatedAt"]
    assert ordered.json()["clinicalOwner"] == prepared["clinicalOwner"]
    duplicate = client.post(
        "/api/care/test-order/confirm",
        json={"addressConfirmed": True, "consent": True},
    )
    assert duplicate.status_code == 409

    for expected in ("shipped", "delivered", "sampled", "posted", "lab"):
        advanced = client.post("/api/care/test-order/simulate-advance", json={})
        assert advanced.status_code == 200
        assert advanced.json()["status"] == expected
    result = client.post("/api/care/test-order/simulate-result", json={"result": 480})
    assert result.status_code == 200
    assert result.json()["status"] == "result"
    assert "IBD team" in result.json()["resultNote"]
    assert client.post("/api/care/test-order/share").json()["status"] == "shared"


def test_snapshot_cannot_rewrite_test_governance_or_status_clocks(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    state, etag = _bootstrap(client)
    state["testOrder"]["clinicalOwner"] = "Penny"
    rejected = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert rejected.status_code == 409
    assert "clinical owner" in rejected.json()["detail"].lower()

    state, etag = _bootstrap(client)
    state["teamMessage"]["notificationRule"] = "PENNY-DECIDES-v1"
    rejected = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert rejected.status_code == 409
    assert "notification" in rejected.json()["detail"].lower()

    state, etag = _bootstrap(client)
    state["prescription"]["clinicalOwner"] = "Penny"
    rejected = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert rejected.status_code == 409
    assert "rescue-plan ownership" in rejected.json()["detail"].lower()

    state, etag = _bootstrap(client)
    original_test_clock = state["testOrder"]["statusUpdatedAt"]
    original_message_clock = state["teamMessage"]["statusUpdatedAt"]
    state["testOrder"]["statusUpdatedAt"] = "2099-01-01T00:00:00Z"
    state["teamMessage"]["statusUpdatedAt"] = "2099-01-01T00:00:00Z"
    state["teamMessage"]["sentAt"] = "2099-01-01T00:00:00Z"
    synced = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert synced.status_code == 200
    assert synced.json()["testOrder"]["statusUpdatedAt"] == original_test_clock
    assert synced.json()["teamMessage"]["statusUpdatedAt"] == original_message_clock
    assert synced.json()["teamMessage"]["sentAt"] is None


def test_test_consent_locks_after_ordering_and_is_rechecked_before_every_result_step(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    _confirm_watchful_state(client)
    ordered = client.post(
        "/api/care/test-order/confirm",
        json={"addressConfirmed": True, "consent": True},
    )
    assert ordered.status_code == 200

    withdrawn = client.patch("/api/care/test-order", json={"consent": False})
    assert withdrawn.status_code == 409
    assert client.get("/api/care/test-order").json()["consent"] is True

    snapshot, etag = _bootstrap(client)
    snapshot["testOrder"]["consent"] = False
    blocked_snapshot = client.put("/api/demo", headers={"If-Match": etag}, json=snapshot)
    assert blocked_snapshot.status_code == 409
    assert "lock" in blocked_snapshot.json()["detail"].lower()

    store.mutate(
        lambda state: state["testOrder"].update({"consent": False}),
        "Prepared corrupted withdrawn-consent fulfilment fixture",
        actor="test",
    )
    assert client.post("/api/care/test-order/simulate-advance", json={}).status_code == 409

    store.mutate(
        lambda state: state["testOrder"].update({"status": "lab"}),
        "Prepared corrupted lab fixture with withdrawn consent",
        actor="test",
    )
    assert (
        client.post("/api/care/test-order/simulate-result", json={"result": 420}).status_code
        == 409
    )

    store.mutate(
        lambda state: state["testOrder"].update(
            {"status": "result", "result": 420, "resultNote": "Test fixture"}
        ),
        "Prepared corrupted result fixture with withdrawn consent",
        actor="test",
    )
    assert client.post("/api/care/test-order/share").status_code == 409


def test_excluding_or_deleting_a_result_removes_it_from_derived_evidence(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    _confirm_watchful_state(client)
    assert (
        client.post(
            "/api/care/test-order/confirm",
            json={"addressConfirmed": True, "consent": True},
        ).status_code
        == 200
    )
    for _ in ("shipped", "delivered", "sampled", "posted", "lab"):
        assert client.post("/api/care/test-order/simulate-advance", json={}).status_code == 200
    assert (
        client.post("/api/care/test-order/simulate-result", json={"result": 420}).status_code == 200
    )

    result_entry = client.get("/api/journal?kind=TEST%20RESULT").json()[0]
    assert client.get("/api/lifecycle").json()["proposedPhase"] == "flare"

    excluded = client.patch(f"/api/journal/{result_entry['id']}", json={"excluded": True})
    assert excluded.status_code == 200
    assert client.get("/api/lifecycle").json()["proposedPhase"] != "flare"
    summary = client.get("/api/summary").json()["clinicianSummary"]
    assert "Faecal calprotectin: 420" not in summary
    assert "journal evidence is excluded or deleted" in summary

    assert client.delete(f"/api/journal/{result_entry['id']}").status_code == 204
    assert client.get("/api/lifecycle").json()["proposedPhase"] != "flare"
    summary = client.get("/api/summary").json()["clinicianSummary"]
    assert "Faecal calprotectin: 420" not in summary


def test_patient_journal_cannot_forge_or_rewrite_objective_test_evidence(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    forged = client.post(
        "/api/journal",
        json={
            "kind": "TEST RESULT",
            "body": "Forged calprotectin result",
            "source": "care",
            "structured": {"calprotectin": 999},
        },
    )
    assert forged.status_code == 403

    ordinary_id = _bootstrap(client)[0]["entries"][0]["id"]
    converted = client.patch(
        f"/api/journal/{ordinary_id}",
        json={"kind": "TEST RESULT", "structured": {"calprotectin": 999}},
    )
    assert converted.status_code == 403


def test_objective_care_result_is_immutable_but_remains_excludable_and_deletable(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    _confirm_watchful_state(client)
    assert (
        client.post(
            "/api/care/test-order/confirm",
            json={"addressConfirmed": True, "consent": True},
        ).status_code
        == 200
    )
    for _ in ("shipped", "delivered", "sampled", "posted", "lab"):
        assert client.post("/api/care/test-order/simulate-advance", json={}).status_code == 200
    assert (
        client.post("/api/care/test-order/simulate-result", json={"result": 420}).status_code == 200
    )

    state, etag = _bootstrap(client)
    assert state["teamMessageStale"] is True
    result = next(entry for entry in state["entries"] if entry["kind"] == "TEST RESULT")
    for patch in (
        {"body": "Patient-overwritten result"},
        {"kind": "LIFE EVENT"},
        {"structured": {"calprotectin": 12}},
        {"source": "manual"},
    ):
        blocked = client.patch(f"/api/journal/{result['id']}", json=patch)
        assert blocked.status_code == 409
        assert "cannot be rewritten" in blocked.json()["detail"]

    rewritten = state
    rewritten_result = next(entry for entry in rewritten["entries"] if entry["id"] == result["id"])
    rewritten_result["body"] = "Snapshot-overwritten result"
    blocked_snapshot = client.put("/api/demo", headers={"If-Match": etag}, json=rewritten)
    assert blocked_snapshot.status_code == 409
    assert "cannot be rewritten" in blocked_snapshot.json()["detail"]

    excluded = client.patch(f"/api/journal/{result['id']}", json={"excluded": True})
    assert excluded.status_code == 200
    assert excluded.json()["excluded"] is True
    assert client.delete(f"/api/journal/{result['id']}").status_code == 204


def test_changed_evidence_preserves_and_blocks_stale_team_draft_until_refresh(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    before = _bootstrap(client)[0]
    patient_words = "My reviewed wording must not be overwritten automatically."
    assert client.patch("/api/care/team-message", json={"body": patient_words}).status_code == 200

    corrected = client.patch(
        "/api/journal/1",
        json={"body": "Bristol type 4, no blood and no urgency"},
    )
    assert corrected.status_code == 200
    changed = _bootstrap(client)[0]
    assert changed["teamMessage"]["body"] == patient_words
    assert changed["teamMessageStale"] is True
    blocked = client.post("/api/care/team-message/send")
    assert blocked.status_code == 409
    assert "Refresh and review" in blocked.json()["detail"]

    # Editing the preserved wording cannot silently clear the source-integrity warning.
    assert (
        client.patch(
            "/api/care/team-message", json={"body": f"{patient_words} Updated."}
        ).status_code
        == 200
    )
    assert client.post("/api/care/team-message/send").status_code == 409

    refreshed = client.post("/api/care/team-message/refresh")
    assert refreshed.status_code == 200
    after = _bootstrap(client)[0]
    assert after["teamMessageStale"] is False
    assert after["teamMessage"]["body"] != before["teamMessage"]["body"]
    assert "Bristol type 4" in after["teamMessage"]["body"]
    assert client.post("/api/care/team-message/send").status_code == 200

    state, etag = _bootstrap(client)
    state["entries"].append(
        {
            "id": max(entry["id"] for entry in state["entries"]) + 1,
            "date": "2026-07-17",
            "time": "12:00",
            "kind": "TEST RESULT",
            "body": "Forged through snapshot",
            "source": "care",
            "flagged": True,
            "excluded": False,
            "structured": {"calprotectin": 999},
            "photo": None,
        }
    )
    assert client.put("/api/demo", headers={"If-Match": etag}, json=state).status_code == 409


def test_message_and_prescription_simulations_enforce_humans_in_loop(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    assert client.patch("/api/care/team-message", json={"subject": "Edited"}).status_code == 200
    sent = client.post("/api/care/team-message/send").json()
    assert sent["status"] == "sent"
    assert sent["sentAt"] == sent["statusUpdatedAt"]
    read = client.post("/api/care/team-message/simulate-read").json()
    assert read["status"] == "read"
    assert read["sentAt"] == sent["sentAt"]
    assert read["statusUpdatedAt"]
    replied = client.post(
        "/api/care/team-message/simulate-reply",
        json={"reply": "Please call if bleeding increases."},
    )
    assert replied.json()["status"] == "replied"
    follow_up = client.post("/api/care/team-message/new")
    assert follow_up.status_code == 200
    assert follow_up.json()["status"] == "draft"
    assert follow_up.json()["id"] != "MSG-104"

    watchful_request = client.post("/api/care/prescription/request")
    assert watchful_request.status_code == 409
    assert (
        phase_response := client.post(
            "/api/demo/phase",
            json={"phase": "flare", "reason": "Explicit demo scenario"},
        )
    ).status_code == 200
    assert phase_response.json()["phaseConfirmed"] is False
    presentation_only = client.post("/api/care/prescription/request")
    assert presentation_only.status_code == 409

    def establish_objective_context(value: dict[str, Any]) -> None:
        value.update({"phase": "flare", "pendingPhase": None, "phaseConfirmed": True})
        value["testOrder"].update({"status": "result", "result": 420})
        value["entries"].append(
            {
                "id": 991,
                "date": date.today().isoformat(),
                "time": "10:00",
                "kind": "TEST RESULT",
                "body": "Faecal calprotectin 420 µg/g — clinical interpretation required",
                "source": "care",
                "flagged": True,
                "excluded": False,
                "structured": {"calprotectin": 420, "diagnostic": False},
            }
        )

    store.mutate(
        establish_objective_context,
        "Prepared objective prescription fixture",
        actor="test",
    )
    requested = client.post("/api/care/prescription/request")
    assert requested.status_code == 200
    assert requested.json()["status"] == "requested"
    assert client.post("/api/care/prescription/simulate-ready").status_code == 409
    assert client.post("/api/care/prescription/simulate-approve").json()["status"] == "approved"
    assert client.post("/api/care/prescription/simulate-ready").json()["status"] == "ready"
    assert client.post("/api/care/prescription/collect").json()["status"] == "collected"
    collected = client.get("/api/taper").json()
    assert collected["verified"] is False
    assert collected["currentDay"] == 1
    assert collected["days"][0]["date"] == date.today().isoformat()
    assert collected["days"][-1]["date"] == (date.today() + timedelta(days=41)).isoformat()
    assert not any(day["taken"] for day in collected["days"])
    assert collected["missedDays"] == []
    assert client.post("/api/taper/dose/taken").status_code == 409
    assert client.post("/api/taper/verify").json()["verified"] is True


def test_snapshot_collection_allows_only_the_exact_reanchored_schedule(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client

    def prepare_ready_legacy_state(value: dict[str, Any]) -> None:
        value.update({"phase": "flare", "pendingPhase": None, "phaseConfirmed": True})
        value["testOrder"].update({"status": "result", "result": 420})
        value["entries"].append(
            {
                "id": 992,
                "date": date.today().isoformat(),
                "time": "10:00",
                "kind": "TEST RESULT",
                "body": "Faecal calprotectin 420 µg/g — clinical interpretation required",
                "source": "care",
                "flagged": True,
                "excluded": False,
                "structured": {"calprotectin": 420, "diagnostic": False},
            }
        )
        value["prescription"].update({"status": "ready", "treatmentStartedAt": None})
        value["taper"]["days"][0]["taken"] = True
        value["taper"].update(
            {
                "verified": True,
                "currentDay": 12,
                "snoozedUntil": "2026-07-18T12:00:00+00:00",
                "missedDays": [2],
                "sideEffects": ["Poor sleep"],
                "checkInComplete": True,
            }
        )

    store.mutate(
        prepare_ready_legacy_state,
        "Prepared legacy ready-to-collect fixture",
        actor="test",
    )
    state, etag = _bootstrap(client)
    state["prescription"].update(
        {
            "status": "collected",
            "treatmentStartedAt": f"{date.today().isoformat()}T09:00:00+00:00",
        }
    )
    unanchored = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert unanchored.status_code == 409
    assert "anchor" in unanchored.json()["detail"].lower()

    for index, day in enumerate(state["taper"]["days"]):
        day["date"] = (date.today() + timedelta(days=index)).isoformat()
        day["taken"] = False
    state["taper"].update(
        {
            "verified": False,
            "currentDay": 1,
            "snoozedUntil": None,
            "missedDays": [],
            "sideEffects": [],
            "checkInComplete": False,
        }
    )

    collected = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert collected.status_code == 200, collected.text
    assert collected.json()["taper"]["days"][0] == {
        "day": 1,
        "doseMg": 30,
        "date": date.today().isoformat(),
        "taken": False,
    }
    assert collected.json()["taper"]["verified"] is False

    rewritten = collected.json()
    rewritten["taper"]["days"][0]["doseMg"] = 35
    blocked = client.put(
        "/api/demo",
        headers={"If-Match": collected.headers["etag"]},
        json=rewritten,
    )
    assert blocked.status_code == 409
    assert "immutable" in blocked.json()["detail"].lower()


def test_clinician_message_thread_is_preserved_and_sent_content_is_immutable(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    assert client.post("/api/care/team-message/send").status_code == 200

    sent, sent_etag = _bootstrap(client)
    sent["teamMessage"]["body"] = "Rewritten after sending"
    rewritten = client.put("/api/demo", headers={"If-Match": sent_etag}, json=sent)
    assert rewritten.status_code == 409
    assert "immutable" in rewritten.json()["detail"].lower()

    assert client.post("/api/care/team-message/simulate-read").status_code == 200
    reply = "Please call if bleeding increases."
    assert (
        client.post("/api/care/team-message/simulate-reply", json={"reply": reply}).status_code
        == 200
    )
    assert client.post("/api/care/team-message/new").status_code == 200

    threaded, etag = _bootstrap(client)
    assert threaded["teamMessage"]["status"] == "draft"
    assert threaded["teamMessageHistory"][0]["id"] == "MSG-104"
    assert threaded["teamMessageHistory"][0]["reply"] == reply

    threaded["teamMessageHistory"][0]["reply"] = "Rewritten reply"
    history_rewrite = client.put("/api/demo", headers={"If-Match": etag}, json=threaded)
    assert history_rewrite.status_code == 409
    assert "history" in history_rewrite.json()["detail"].lower()


def test_patient_edited_summary_is_preserved_until_explicit_regeneration(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    patient_words = "My own reviewed wording for the appointment."
    edited = client.patch("/api/summary", json={"clinicianSummary": patient_words})
    assert edited.status_code == 200
    assert edited.json() == {
        "clinicianSummary": patient_words,
        "clinicianSummaryEdited": True,
        "clinicianSummaryStale": False,
    }

    snapshot, etag = _bootstrap(client)
    snapshot["entries"].append(
        {
            "id": max(entry["id"] for entry in snapshot["entries"]) + 1,
            "date": "2026-07-17",
            "time": "12:30",
            "kind": "PAIN",
            "body": "New pain record",
            "source": "manual",
            "flagged": False,
            "excluded": False,
            "structured": {"pain": 6},
            "photo": None,
        }
    )
    snapshot.update(
        {
            "clinicianSummary": "Silently replaced generated wording",
            "clinicianSummaryEdited": False,
            "clinicianSummaryStale": False,
            "phaseConfirmed": False,
        }
    )
    overwrite = client.put("/api/demo", headers={"If-Match": etag}, json=snapshot)
    assert overwrite.status_code == 409
    assert "patient-edited summary" in overwrite.json()["detail"].lower()

    created = client.post(
        "/api/journal",
        json={
            "kind": "PAIN",
            "body": "New patient-recorded pain 6/10",
            "source": "manual",
            "structured": {"pain": 6},
        },
    )
    assert created.status_code == 201
    stale = client.get("/api/summary").json()
    assert stale["clinicianSummary"] == patient_words
    assert stale["clinicianSummaryEdited"] is True
    assert stale["clinicianSummaryStale"] is True

    regenerated = client.post("/api/summary/regenerate")
    assert regenerated.status_code == 200
    assert "New patient-recorded pain 6/10" in regenerated.json()["clinicianSummary"]
    assert regenerated.json()["clinicianSummaryEdited"] is False
    assert regenerated.json()["clinicianSummaryStale"] is False


def test_taper_is_exact_and_experiment_is_stable_only(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    today = client.get("/api/taper/today")
    assert today.status_code == 200
    assert today.json()["status"] == "review-only"
    assert today.json()["available"] is False
    assert today.json()["today"] is None
    assert today.json()["nextChange"] is None
    assert "Dose support is unavailable" in today.json()["message"]
    schedule = client.get("/api/taper")
    assert schedule.status_code == 200
    assert schedule.json()["days"][11]["doseMg"] == 25
    blocked = client.post("/api/taper/dose/taken")
    assert blocked.status_code == 409
    assert "clinician-issued treatment" in blocked.json()["detail"]
    store.mutate(
        lambda state: state["prescription"].update(
            {"status": "collected", "treatmentStartedAt": "2026-07-17T08:00:00+00:00"}
        ),
        "Prepared collected-treatment taper fixture",
        actor="test",
    )
    active_today = client.get("/api/taper/today")
    assert active_today.status_code == 200
    assert active_today.json()["status"] == "active"
    assert active_today.json()["available"] is True
    assert active_today.json()["today"]["doseMg"] == 25
    assert active_today.json()["nextChange"] == {
        "day": 15,
        "doseMg": 20,
        "date": "2026-07-20",
        "taken": False,
    }
    assert active_today.json()["canEditDose"] is False
    taken = client.post("/api/taper/dose/taken")
    assert taken.status_code == 200
    assert (
        next(day for day in taken.json()["days"] if day["day"] == taken.json()["currentDay"])[
            "taken"
        ]
        is True
    )

    assert client.post("/api/experiment/start").status_code == 409
    _prepare_confirmed_stable_fixture(store)
    _prepare_unstarted_experiment_fixture(store)
    assert client.patch("/api/experiment", json={"durationDays": 1}).status_code == 200
    assert (
        client.patch(
            "/api/experiment",
            json={"baseline": "I will record morning urgency before day 1"},
        ).status_code
        == 200
    )
    future_intent = client.post("/api/experiment/start")
    assert future_intent.status_code == 422
    assert "actually recorded" in future_intent.json()["detail"]
    assert (
        client.patch(
            "/api/experiment",
            json={"baseline": "Morning urgency was 3/10 before day 1"},
        ).status_code
        == 200
    )
    active = client.post("/api/experiment/start")
    assert active.status_code == 200
    assert active.json()["status"] == "active"
    assert client.post("/api/experiment/start").status_code == 409
    observed = client.post(
        "/api/experiment/observation",
        json={"observation": "No clear personal change today."},
    )
    assert observed.status_code == 200
    assert observed.json()["day"] == 1
    duplicate = client.post(
        "/api/experiment/observation",
        json={"observation": "A second same-day note must not advance progress."},
    )
    assert duplicate.status_code == 409
    assert "already recorded" in duplicate.json()["detail"]
    completed = client.post(
        "/api/experiment/complete",
        json={"review": "No clear personal difference was noticed."},
    )
    assert completed.json()["status"] == "complete"
    assert client.post("/api/experiment/pause").status_code == 409
    state, _ = _bootstrap(client)
    assert any("Diet experiment completed" in entry["body"] for entry in state["entries"])
    assert "No clear personal difference" in state["clinicianSummary"]


def test_clean_profile_can_import_and_verify_a_named_clinician_plan(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client

    def clear_seeded_plan(value: dict[str, Any]) -> None:
        value["prescription"] = {
            "status": "not-started",
            "medicine": "",
            "prescriber": "",
            "pharmacy": "",
            "rescuePlanEligible": False,
            "treatmentStartedAt": None,
            "reviewAfterHours": 24,
        }
        value["taper"] = {
            "verified": False,
            "medicine": "",
            "prescribedBy": "",
            "currentDay": 1,
            "snoozedUntil": None,
            "days": [],
            "missedDays": [],
            "sideEffects": [],
            "checkInComplete": False,
        }

    store.mutate(clear_seeded_plan, "Prepared clean-profile care fixture", actor="test")
    imported = client.post("/api/care/simulate-plan-import")
    assert imported.status_code == 200
    assert imported.headers["etag"]
    assert imported.json()["prescription"]["status"] == "prepared"
    assert imported.json()["prescription"]["rescuePlanEligible"] is True
    assert imported.json()["prescription"]["clinicalOwner"] == (
        "Dr Rui Ferreira (simulated prescribing owner)"
    )
    assert imported.json()["prescription"]["eligibilityRule"] == (
        "IBD-RESCUE-PRED-DEMO-v1"
    )
    assert imported.json()["taper"]["prescribedBy"] == "Dr Rui Ferreira"
    assert imported.json()["taper"]["verified"] is False
    assert len(imported.json()["taper"]["days"]) == 42
    assert imported.json()["taper"]["days"][0]["date"] == date.today().isoformat()
    assert client.post("/api/taper/verify").json()["verified"] is True
    assert client.post("/api/care/simulate-plan-import").status_code == 409


def test_clean_profile_messaging_waits_for_governed_pathway_import(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    state = _complete_clean_stable_onboarding(client)
    assert state["teamMessage"]["notificationRule"] == "Not configured"
    assert client.post("/api/care/team-message/refresh").status_code == 200

    blocked = client.post("/api/care/team-message/send")
    assert blocked.status_code == 409
    assert "named owner" in blocked.json()["detail"].lower()

    imported = client.post("/api/care/simulate-plan-import")
    assert imported.status_code == 200
    message = imported.json()["teamMessage"]
    assert message["clinicalOwner"] == "Example Hospital (simulated clinical owner)"
    assert message["notificationRule"] == "IBD-CHANGE-NOTIFY-DEMO-v1"
    assert message["expectedResponse"] == "Within one working day"
    assert client.post("/api/care/team-message/send").status_code == 200


def test_taper_actions_and_snapshot_mutations_wait_for_active_treatment(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client

    for method, path, payload in (
        ("post", "/api/taper/dose/taken", None),
        ("post", "/api/taper/dose/reconcile-missed", {"day": 12}),
        ("post", "/api/taper/dose/snooze", {"minutes": 30}),
        ("post", "/api/taper/check-in", {"symptomsWorse": False}),
        ("patch", "/api/taper", {"sideEffects": ["Headache"]}),
    ):
        response = (
            getattr(client, method)(path, json=payload)
            if payload is not None
            else getattr(client, method)(path)
        )
        assert response.status_code == 409, (path, response.text)
        assert "clinician-issued treatment" in response.json()["detail"]

    def mark_current_dose_taken(state: dict[str, Any]) -> None:
        current_day = state["taper"]["currentDay"]
        next(day for day in state["taper"]["days"] if day["day"] == current_day)["taken"] = True

    for mutate in (
        mark_current_dose_taken,
        lambda state: state["taper"].update({"snoozedUntil": "2026-07-18T12:00:00+00:00"}),
        lambda state: state["taper"].update({"checkInComplete": True}),
        lambda state: state["taper"].update({"sideEffects": ["Headache"]}),
    ):
        state, etag = _bootstrap(client)
        mutate(state)
        response = client.put("/api/demo", headers={"If-Match": etag}, json=state)
        assert response.status_code == 409
        assert "cannot be synced" in response.json()["detail"]

    store.mutate(
        lambda state: state["prescription"].update(
            {"status": "collected", "treatmentStartedAt": "2026-07-17T08:00:00+00:00"}
        ),
        "Prepared collected-treatment action fixture",
        actor="test",
    )
    assert client.post("/api/taper/dose/snooze", json={"minutes": 30}).status_code == 200
    assert client.post("/api/taper/check-in", json={"symptomsWorse": False}).status_code == 200


def test_past_taper_dose_can_be_reconciled_once_without_changing_schedule(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client

    def make_past_day_unresolved(value: dict[str, Any]) -> None:
        value["taper"]["days"][0]["taken"] = False
        value["prescription"].update(
            {"status": "collected", "treatmentStartedAt": "2026-07-17T08:00:00+00:00"}
        )

    store.mutate(make_past_day_unresolved, "Prepared missed-dose fixture", actor="test")
    before = _bootstrap(client)[0]["taper"]["days"]
    reconciled = client.post("/api/taper/dose/reconcile-missed", json={"day": 1})
    assert reconciled.status_code == 200
    assert reconciled.json()["missedDays"] == [1]
    assert [(item["day"], item["doseMg"], item["date"]) for item in reconciled.json()["days"]] == [
        (item["day"], item["doseMg"], item["date"]) for item in before
    ]
    state, etag = _bootstrap(client)
    missed_entry = next(
        entry
        for entry in state["entries"]
        if entry.get("structured", {}).get("taperDay") == 1
        and entry.get("structured", {}).get("missed") is True
    )
    assert missed_entry["structured"]["taken"] is False
    assert "explicitly reconciled as not taken" in state["clinicianSummary"]
    assert client.post("/api/taper/dose/reconcile-missed", json={"day": 1}).status_code == 409
    today_day = next(
        day["day"] for day in state["taper"]["days"] if day["date"] == date.today().isoformat()
    )
    assert (
        client.post("/api/taper/dose/reconcile-missed", json={"day": today_day}).status_code == 409
    )

    state["taper"]["missedDays"] = []
    cleared = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert cleared.status_code == 409

    corrected = client.post("/api/taper/dose/correct", json={"day": 1, "fact": "missed"})
    assert corrected.status_code == 200
    assert corrected.json()["missedDays"] == []
    after = _bootstrap(client)[0]
    assert (
        next(entry for entry in after["entries"] if entry["id"] == missed_entry["id"])["excluded"]
        is True
    )
    correction = next(
        entry
        for entry in after["entries"]
        if entry.get("structured", {}).get("adherenceCorrection") is True
    )
    assert correction["structured"]["correctedFact"] == "missed"
    assert "marked not taken by mistake" in correction["body"]
    assert "no past doses explicitly reconciled as not taken" in after["clinicianSummary"]
    assert (
        client.post("/api/taper/dose/correct", json={"day": 1, "fact": "missed"}).status_code == 409
    )


def test_taken_dose_can_be_retracted_with_audited_timeline_correction(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    store.mutate(
        lambda state: state["prescription"].update(
            {"status": "collected", "treatmentStartedAt": "2026-07-17T08:00:00+00:00"}
        ),
        "Prepared collected-treatment correction fixture",
        actor="test",
    )
    before = _bootstrap(client)[0]
    schedule = [(day["day"], day["doseMg"], day["date"]) for day in before["taper"]["days"]]
    marked = client.post("/api/taper/dose/taken")
    assert marked.status_code == 200
    day_number = marked.json()["currentDay"]
    marked_state = _bootstrap(client)[0]
    marked_entry = next(
        entry
        for entry in marked_state["entries"]
        if not entry["excluded"]
        and entry.get("structured", {}).get("taperDay") == day_number
        and entry.get("structured", {}).get("taken") is True
    )
    assert (
        client.patch(
            f"/api/journal/{marked_entry['id']}", json={"body": "Rewritten adherence"}
        ).status_code
        == 409
    )
    assert client.delete(f"/api/journal/{marked_entry['id']}").status_code == 409

    corrected = client.post("/api/taper/dose/correct", json={"day": day_number, "fact": "taken"})
    assert corrected.status_code == 200
    assert (
        next(day for day in corrected.json()["days"] if day["day"] == day_number)["taken"] is False
    )
    assert [
        (day["day"], day["doseMg"], day["date"]) for day in corrected.json()["days"]
    ] == schedule

    state = _bootstrap(client)[0]
    originals = [
        entry
        for entry in state["entries"]
        if entry.get("structured", {}).get("taperDay") == day_number
        and entry.get("structured", {}).get("taken") is True
    ]
    assert originals and all(entry["excluded"] for entry in originals)
    correction = next(
        entry
        for entry in state["entries"]
        if entry.get("structured", {}).get("correctedFact") == "taken"
    )
    assert correction["excluded"] is False
    assert "marked taken by mistake" in correction["body"]
    assert (
        client.patch(f"/api/journal/{correction['id']}", json={"excluded": True}).status_code == 409
    )
    assert client.delete(f"/api/journal/{correction['id']}").status_code == 409
    assert any("marked by mistake" in event["action"] for event in state["audit"])


def test_snapshot_adherence_reversal_requires_one_matching_correction_record(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    store.mutate(
        lambda state: state["prescription"].update(
            {"status": "collected", "treatmentStartedAt": "2026-07-17T08:00:00+00:00"}
        ),
        "Prepared collected-treatment snapshot-correction fixture",
        actor="test",
    )
    marked = client.post("/api/taper/dose/taken")
    assert marked.status_code == 200
    day_number = marked.json()["currentDay"]
    assert client.post("/api/care/team-message/refresh").status_code == 200
    state, etag = _bootstrap(client)
    scheduled = next(day for day in state["taper"]["days"] if day["day"] == day_number)
    original = next(
        entry
        for entry in state["entries"]
        if not entry["excluded"]
        and entry.get("structured", {}).get("taperDay") == day_number
        and entry.get("structured", {}).get("taken") is True
    )
    scheduled["taken"] = False

    missing_correction = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert missing_correction.status_code == 409
    assert "audited correction record" in missing_correction.json()["detail"]

    original["excluded"] = True
    state["entries"].append(
        {
            "id": max(entry["id"] for entry in state["entries"]) + 1,
            "date": date.today().isoformat(),
            "time": "12:00",
            "kind": "MEDICATION",
            "body": (
                f"Correction: prescribed taper day {day_number} was marked taken by mistake; "
                "that patient-entered adherence fact is retracted. The prescribed schedule is "
                "unchanged."
            ),
            "source": "manual",
            "flagged": False,
            "excluded": False,
            "structured": {
                "adherenceCorrection": True,
                "correctedFact": "taken",
                "doseMg": scheduled["doseMg"],
                "taperDay": day_number,
                "scheduledDate": scheduled["date"],
            },
            "photo": None,
        }
    )
    state["clinicianSummary"] = domain_routes.build_clinician_summary(
        domain_routes.DemoState.model_validate(state)
    )
    accepted = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["teamMessageStale"] is True
    assert any("marked by mistake" in event["action"] for event in accepted.json()["audit"])
    erased_audit = accepted.json()
    erased_audit["entries"] = [
        entry
        for entry in erased_audit["entries"]
        if entry.get("structured", {}).get("adherenceCorrection") is not True
    ]
    immutable = client.put(
        "/api/demo", headers={"If-Match": accepted.headers["etag"]}, json=erased_audit
    )
    assert immutable.status_code == 409
    assert "cannot be deleted" in immutable.json()["detail"]


def test_restrictive_experiment_review_cannot_be_cleared_by_the_client(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    _prepare_unstarted_experiment_fixture(store)
    updated = client.patch(
        "/api/experiment",
        json={
            "title": "Restrictive elimination trial",
            "variable": "Remove a whole food group",
            "goal": "Explore symptoms",
            "outcome": "Daily wellbeing",
            "reviewRequired": False,
        },
    )
    assert updated.status_code == 200
    assert updated.json()["reviewRequired"] is True
    _prepare_confirmed_stable_fixture(store)
    assert client.post("/api/experiment/start").status_code == 409

    assert client.post("/api/care/team-message/refresh").status_code == 200
    message = client.patch(
        "/api/care/team-message",
        json={
            "body": _experiment_review_body(client),
        },
    )
    assert message.status_code == 200
    linked = client.post("/api/experiment/request-review")
    assert linked.status_code == 200
    assert linked.json()["reviewRequestMessageId"] == message.json()["id"]
    assert client.post("/api/experiment/simulate-clinical-review").status_code == 409
    assert client.post("/api/care/team-message/send").status_code == 200
    replied = client.post(
        "/api/care/team-message/simulate-reply",
        json={"reply": "Reviewed and approved: this candidate may start while stable."},
    )
    assert replied.status_code == 200
    approved = client.post("/api/experiment/simulate-clinical-review")
    assert approved.status_code == 200
    assert approved.json()["reviewApprovedBy"] == "IBD team (simulated)"
    assert client.post("/api/experiment/start").status_code == 200

    state, etag = _bootstrap(client)
    state["experiment"].update({"status": "active", "reviewRequired": False})
    bypass = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert bypass.status_code == 409


def test_experiment_requires_baseline_and_uses_nutritional_pmh_for_review(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    _prepare_confirmed_stable_fixture(store)
    _prepare_unstarted_experiment_fixture(store)
    assert client.patch("/api/experiment", json={"baseline": ""}).status_code == 200
    missing_baseline = client.post("/api/experiment/start")
    assert missing_baseline.status_code == 422
    assert "baseline" in missing_baseline.json()["detail"].lower()

    assert (
        client.patch(
            "/api/experiment", json={"baseline": "Record morning urgency before day 1"}
        ).status_code
        == 200
    )
    instruction_only = client.post("/api/experiment/start")
    assert instruction_only.status_code == 422
    assert "not an instruction" in instruction_only.json()["detail"].lower()

    assert (
        client.patch(
            "/api/experiment", json={"baseline": "My baseline will be urgency 3/10"}
        ).status_code
        == 200
    )
    future_baseline = client.post("/api/experiment/start")
    assert future_baseline.status_code == 422
    assert "actually recorded" in future_baseline.json()["detail"]

    state, etag = _bootstrap(client)
    state["experiment"]["status"] = "active"
    bypass = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert bypass.status_code == 409
    assert "not an instruction" in bypass.json()["detail"].lower()

    assert (
        client.patch(
            "/api/profile", json={"conditions": "Short bowel syndrome with prior malnutrition"}
        ).status_code
        == 200
    )
    governed = client.patch(
        "/api/experiment",
        json={"baseline": "Morning urgency 3/10", "reviewRequired": False},
    )
    assert governed.status_code == 200
    assert governed.json()["reviewRequired"] is True


def test_experiment_definition_edit_invalidates_linked_clinical_approval(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    _prepare_unstarted_experiment_fixture(store)
    assert (
        client.patch(
            "/api/experiment",
            json={"title": "Elimination candidate", "variable": "Remove a whole food group"},
        ).status_code
        == 200
    )
    assert client.post("/api/care/team-message/refresh").status_code == 200
    assert (
        client.patch(
            "/api/care/team-message",
            json={"body": _experiment_review_body(client)},
        ).status_code
        == 200
    )
    assert client.post("/api/experiment/request-review").status_code == 200
    assert client.post("/api/care/team-message/send").status_code == 200
    assert (
        client.post(
            "/api/care/team-message/simulate-reply",
            json={"reply": "Reviewed and approved; the unchanged candidate may proceed."},
        ).status_code
        == 200
    )
    assert client.post("/api/experiment/simulate-clinical-review").status_code == 200

    revised = client.patch(
        "/api/experiment", json={"goal": "A revised question requires a new review"}
    )
    assert revised.status_code == 200
    assert revised.json()["reviewApprovedAt"] is None
    assert revised.json()["reviewApprovedBy"] is None
    assert revised.json()["reviewRequestMessageId"] is None
    assert client.post("/api/experiment/simulate-clinical-review").status_code == 409


def test_experiment_rejects_a_negative_clinical_review_reply(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    _prepare_unstarted_experiment_fixture(store)
    assert (
        client.patch(
            "/api/experiment",
            json={"title": "Elimination candidate", "variable": "Remove a whole food group"},
        ).status_code
        == 200
    )
    assert client.post("/api/care/team-message/refresh").status_code == 200
    assert (
        client.patch(
            "/api/care/team-message",
            json={"body": _experiment_review_body(client)},
        ).status_code
        == 200
    )
    assert client.post("/api/experiment/request-review").status_code == 200
    assert client.post("/api/care/team-message/send").status_code == 200
    assert (
        client.post(
            "/api/care/team-message/simulate-reply",
            json={"reply": "Approved, but this plan is dangerous and contraindicated."},
        ).status_code
        == 200
    )
    rejected = client.post("/api/experiment/simulate-clinical-review")
    assert rejected.status_code == 409
    assert "explicitly say" in rejected.json()["detail"]


@pytest.mark.parametrize(
    "title",
    [
        "Eat only white rice",
        "Try a juice cleanse",
        "Use a liquid-only diet",
        "Try a carnivore plan",
        "Skip one meal each day",
        "No food for 48 hours",
    ],
)
def test_common_restrictive_experiment_wording_requires_review(
    domain_client: tuple[TestClient, SQLiteDemoStore], title: str
) -> None:
    _, store = domain_client
    state = store.get()
    candidate = state.experiment.model_copy(update={"title": title})
    assert domain_routes.experiment_requires_review(candidate, state.profile)


def test_experiment_that_mentions_a_recorded_allergy_requires_review(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    _, store = domain_client
    state = store.get()
    profile = state.profile.model_copy(update={"allergies": "Peanuts"})
    candidate = state.experiment.model_copy(
        update={"variable": "Add peanut butter at breakfast"}
    )
    assert domain_routes.experiment_requires_review(candidate, profile)


def test_snapshot_records_only_linked_review_approval_and_invalidates_it_on_edit(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    _prepare_unstarted_experiment_fixture(store)
    assert (
        client.patch(
            "/api/experiment",
            json={"title": "Elimination candidate", "variable": "Remove a whole food group"},
        ).status_code
        == 200
    )
    assert client.post("/api/care/team-message/refresh").status_code == 200
    assert (
        client.patch(
            "/api/care/team-message",
            json={"body": _experiment_review_body(client)},
        ).status_code
        == 200
    )
    assert client.post("/api/experiment/request-review").status_code == 200
    assert client.post("/api/care/team-message/send").status_code == 200
    assert (
        client.post(
            "/api/care/team-message/simulate-reply",
            json={"reply": "Reviewed and approved; this unchanged candidate may proceed."},
        ).status_code
        == 200
    )

    state, etag = _bootstrap(client)
    state["experiment"].update(
        {
            "reviewApprovedAt": "2026-07-17T12:00:00+00:00",
            "reviewApprovedBy": "IBD team (simulated)",
        }
    )
    approved = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert approved.status_code == 200

    retained = approved.json()
    retained["experiment"]["goal"] = "A materially revised experiment question"
    rejected = client.put(
        "/api/demo", headers={"If-Match": approved.headers["etag"]}, json=retained
    )
    assert rejected.status_code == 409
    assert "linked replied team thread" in rejected.json()["detail"]

    revised = approved.json()
    revised["experiment"].update(
        {
            "goal": "A materially revised experiment question",
            "reviewRequestMessageId": None,
            "reviewApprovedAt": None,
            "reviewApprovedBy": None,
        }
    )
    accepted = client.put(
        "/api/demo", headers={"If-Match": approved.headers["etag"]}, json=revised
    )
    assert accepted.status_code == 200


def test_snapshot_cannot_forge_experiment_progress_without_one_new_dated_event(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    _prepare_confirmed_stable_fixture(store)
    assert client.post("/api/experiment/start").status_code == 200

    state, etag = _bootstrap(client)
    state["experiment"]["day"] += 1
    state["experiment"]["observations"].append("Day 10: forged without timeline evidence")
    forged = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert forged.status_code == 409
    assert "calendar day" in forged.json()["detail"]

    state, etag = _bootstrap(client)
    state["experiment"]["day"] += 1
    state["experiment"]["observations"].append("Day 10: valid dated observation")
    state["entries"].insert(
        0,
        {
            "id": max(entry["id"] for entry in state["entries"]) + 1,
            "date": date.today().isoformat(),
            "time": "12:00",
            "kind": "LIFE EVENT",
            "body": "Diet experiment check-in — day 10 of 14: valid dated observation",
            "source": "manual",
            "flagged": False,
            "excluded": False,
            "structured": {
                "experimentEvent": "check-in",
                "experimentId": state["experiment"]["id"],
                "experimentObservation": "valid dated observation",
                "day": 10,
                "durationDays": 14,
            },
        },
    )
    valid = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert valid.status_code == 200, valid.text

    duplicate = valid.json()
    duplicate["experiment"]["day"] += 1
    duplicate["experiment"]["observations"].append("Day 11: duplicate same-date note")
    duplicate["entries"].insert(
        0,
        {
            **duplicate["entries"][0],
            "id": max(entry["id"] for entry in duplicate["entries"]) + 1,
            "body": "Diet experiment check-in — day 11 of 14: duplicate same-date note",
            "structured": {
                **duplicate["entries"][0]["structured"],
                "experimentObservation": "duplicate same-date note",
                "day": 11,
            },
        },
    )
    duplicate_result = client.put(
        "/api/demo", headers={"If-Match": valid.headers["etag"]}, json=duplicate
    )
    assert duplicate_result.status_code == 409

    premature = client.post(
        "/api/experiment/complete",
        json={"review": "This must wait for every configured daily check-in."},
    )
    assert premature.status_code == 409
    assert "every configured distinct daily check-in" in premature.json()["detail"]


def test_pending_blood_clarification_cannot_silence_a_new_emergency_report(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    pending = client.post("/api/chat", json={"text": "Loose stool with blood"})
    assert pending.status_code == 200
    assert pending.json()["entries"][0]["structured"]["needsClarification"] == "bloodAmount"
    assert (
        client.patch("/api/privacy", json={"assistantJournalAccess": False}).status_code
        == 200
    )

    emergency = client.post("/api/chat", json={"text": "I feel faint and may pass out"})
    assert emergency.status_code == 200
    assert emergency.json()["safety"]["level"] == "emergency"
    alert = client.get("/api/demo").json()["safetyAlert"]
    assert alert["level"] == "emergency"
    assert "Faintness or collapse" in alert["triggers"]
    assert alert["unlinkedTriggers"] == ["Faintness or collapse"]


def test_unresolved_emergency_alert_is_not_downgraded_by_later_same_day_input(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    emergency = client.post("/api/safety/evaluate", json={"faint": True})
    assert emergency.json()["alert"]["level"] == "emergency"

    later = client.post("/api/safety/evaluate", json={"feverC": 38.2})
    assert later.status_code == 200
    assert later.json()["alert"]["level"] == "emergency"
    assert set(later.json()["alert"]["triggers"]) == {
        "Faintness or collapse",
        "Fever (38.2°C)",
    }


def test_correcting_an_evidence_kind_invalidates_prior_lifecycle_confirmation(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    created = client.post(
        "/api/journal",
        json={
            "kind": "PAIN",
            "body": "Pain 4/10",
            "source": "manual",
            "structured": {"pain": 4},
        },
    )
    assert created.status_code == 201
    store.mutate(
        lambda state: state.update({"phaseConfirmed": True, "pendingPhase": None}),
        "Prepared confirmed evidence correction fixture",
        actor="test",
    )

    corrected = client.patch(
        f"/api/journal/{created.json()['id']}",
        json={"kind": "LIFE EVENT", "body": "Travel day only"},
    )
    assert corrected.status_code == 200
    state = client.get("/api/demo").json()
    assert state["phaseConfirmed"] is False


def test_consent_withdrawal_revokes_supporter_and_unsubmitted_test_consent(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    assert (
        client.patch(
            "/api/care/test-order",
            json={"addressConfirmed": True, "consent": True},
        ).status_code
        == 200
    )
    assert (
        client.patch(
            "/api/trusted-supporter",
            json={
                "name": "Alex",
                "relationship": "Partner",
                "enabled": True,
                "canViewSummary": True,
            },
        ).status_code
        == 200
    )

    withdrawn = client.patch("/api/profile", json={"healthDataConsent": False})
    assert withdrawn.status_code == 200
    state = client.get("/api/demo").json()
    assert state["trustedSupporter"]["enabled"] is False
    assert not any(
        state["trustedSupporter"][key]
        for key in ("canViewSummary", "canSeeReminders", "canHelpLog")
    )
    assert state["testOrder"]["addressConfirmed"] is False
    assert state["testOrder"]["consent"] is False
    assert (
        client.patch(
            "/api/trusted-supporter",
            json={"enabled": True, "canViewSummary": True},
        ).status_code
        == 403
    )

    assert (
        client.patch(
            "/api/profile",
            json={"healthDataConsent": True, "onboardingComplete": True},
        ).status_code
        == 200
    )
    stale = client.post("/api/care/test-order/confirm", json={})
    assert stale.status_code == 422
    assert "Earlier prepared values cannot be reused" in stale.json()["detail"]


def test_snapshot_rejects_forged_care_provenance_and_urgent_alert_suppression(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    state, etag = _bootstrap(client)
    next_id = max(entry["id"] for entry in state["entries"]) + 1
    state["entries"].append(
        {
            "id": next_id,
            "date": date.today().isoformat(),
            "time": "12:00",
            "kind": "WELLBEING",
            "body": "Care says everything is fine",
            "source": "care",
            "flagged": False,
            "excluded": False,
            "structured": {},
            "photo": None,
        }
    )
    state["phaseConfirmed"] = False
    forged = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert forged.status_code == 409
    assert "provenance" in forged.json()["detail"]

    state, etag = _bootstrap(client)
    state["entries"].append(
        {
            "id": next_id,
            "date": date.today().isoformat(),
            "time": "12:01",
            "kind": "WELLBEING",
            "body": "I collapsed",
            "source": "manual",
            "flagged": False,
            "excluded": False,
            "structured": {"faint": True},
            "photo": None,
        }
    )
    state["phaseConfirmed"] = False
    state["safetyAlert"] = None
    suppressed = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert suppressed.status_code == 200
    accepted = suppressed.json()
    saved = next(entry for entry in accepted["entries"] if entry["id"] == next_id)
    assert saved["flagged"] is True
    assert accepted["safetyAlert"]["level"] == "emergency"
    assert next_id in accepted["safetyAlert"]["sourceEntryIds"]


def test_snapshot_rejects_ungrounded_penny_safety_reassurance(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    state, etag = _bootstrap(client)
    next_id = max(message["id"] for message in state["messages"]) + 1
    created_at = datetime.now(UTC).isoformat()
    state["messages"].extend(
        [
            {"id": next_id, "from": "me", "text": "Am I okay?", "createdAt": created_at},
            {
                "id": next_id + 1,
                "from": "penny",
                "text": "You are safe and there is nothing to worry about.",
                "createdAt": created_at,
                "category": "general information",
                "sources": [],
            },
        ]
    )
    rejected = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert rejected.status_code == 409
    assert "server-authored" in rejected.json()["detail"]


def test_experiment_observation_correction_and_deletion_reconcile_all_consumers(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    corrected = client.patch(
        "/api/journal/28",
        json={
            "body": "Diet experiment check-in — day 9 of 14: Corrected urgency was 2/10"
        },
    )
    assert corrected.status_code == 200, corrected.text
    state, _ = _bootstrap(client)
    assert state["experiment"]["observations"][-1] == "Day 9: Corrected urgency was 2/10"
    assert "Corrected urgency was 2/10" in state["clinicianSummary"]

    deleted = client.delete("/api/journal/28")
    assert deleted.status_code == 204
    state, _ = _bootstrap(client)
    assert state["experiment"]["day"] == 8
    assert all(
        "Corrected urgency was 2/10" not in item
        for item in state["experiment"]["observations"]
    )
    assert "Corrected urgency was 2/10" not in state["clinicianSummary"]


def test_snapshot_sync_enforces_experiment_definition_and_phase_confirmation_governance(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client

    # A forged pending value cannot turn symptom evidence into a confirmed Flare state.
    state, etag = _bootstrap(client)
    state["pendingPhase"] = "flare"
    proposed = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert proposed.status_code == 200, proposed.text
    forged = proposed.json()
    forged.update({"phase": "flare", "pendingPhase": None, "phaseConfirmed": True})
    confirmed = client.put(
        "/api/demo",
        headers={"If-Match": proposed.headers["etag"]},
        json=forged,
    )
    assert confirmed.status_code == 409
    assert "evidence-governed proposal" in confirmed.json()["detail"].lower()

    _prepare_confirmed_stable_fixture(store)
    assert client.post("/api/experiment/start").status_code == 200
    active, active_etag = _bootstrap(client)
    active["experiment"]["variable"] = "A different variable while already active"
    changed_definition = client.put(
        "/api/demo",
        headers={"If-Match": active_etag},
        json=active,
    )
    assert changed_definition.status_code == 409
    assert "predefined question" in changed_definition.json()["detail"].lower()


def test_recovery_requires_collection_and_settling_then_detects_relapse(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    today = date.today()

    def prepare_objective_flare(value: dict[str, Any]) -> None:
        value.update({"phase": "flare", "pendingPhase": None, "phaseConfirmed": True})
        for entry in value["entries"]:
            entry["excluded"] = True
        value["testOrder"].update({"status": "result", "result": 420})
        value["entries"].append(
            {
                "id": 995,
                "date": today.isoformat(),
                "time": "07:00",
                "kind": "TEST RESULT",
                "body": "Faecal calprotectin 420 µg/g — clinical interpretation required",
                "source": "care",
                "flagged": True,
                "excluded": False,
                "structured": {"calprotectin": 420, "diagnostic": False},
            }
        )

    store.mutate(prepare_objective_flare, "Prepared objective recovery fixture", actor="test")
    assert client.post("/api/care/prescription/request").status_code == 200
    assert client.post("/api/care/prescription/simulate-approve").status_code == 200
    assert client.post("/api/care/prescription/simulate-ready").status_code == 200
    assert client.post("/api/care/prescription/collect").status_code == 200
    assert client.get("/api/lifecycle").json()["proposedPhase"] is None

    store.mutate(
        lambda value: value["prescription"].update(
            {"treatmentStartedAt": (f"{(today - timedelta(days=4)).isoformat()}T08:00:00+00:00")}
        ),
        "Elapsed the response-review window",
        actor="test",
    )
    for recorded_date, kind, structured in (
        ((today - timedelta(days=3)).isoformat(), "WELLBEING", {"wellbeing": "better"}),
        ((today - timedelta(days=2)).isoformat(), "PAIN", {"pain": 2}),
    ):
        settling = client.post(
            "/api/journal",
            json={
                "date": recorded_date,
                "time": "09:00",
                "kind": kind,
                "body": "Symptoms are settling toward baseline",
                "source": "manual",
                "structured": structured,
            },
        )
        assert settling.status_code == 201
    assert client.post("/api/lifecycle/evaluate").json()["proposedPhase"] == "recovery"
    confirmed = client.post("/api/lifecycle/confirm")
    assert confirmed.status_code == 200
    assert confirmed.json()["phase"] == "recovery"

    for recorded_date, kind, body, structured in (
        (
            (today - timedelta(days=1)).isoformat(),
            "PAIN",
            "Pain has returned at 7/10",
            {"pain": 7},
        ),
        (
            today.isoformat(),
            "BOWEL MOVEMENT",
            "Loose stool with urgency",
            {"bristol": 7, "urgency": True},
        ),
    ):
        assert (
            client.post(
                "/api/journal",
                json={
                    "date": recorded_date,
                    "time": "12:00",
                    "kind": kind,
                    "body": body,
                    "source": "manual",
                    "structured": structured,
                },
            ).status_code
            == 201
        )
    relapse = client.get("/api/lifecycle").json()
    assert relapse["proposedPhase"] == "flare"
    assert "returned during recovery" in relapse["explanation"]


def test_snapshot_sync_rejects_consequential_bypasses(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client

    state, etag = _bootstrap(client)
    state["testOrder"]["status"] = "shipped"
    state["testOrder"].update({"addressConfirmed": True, "consent": True})
    state["phaseConfirmed"] = True
    skipped_test = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert skipped_test.status_code == 409

    state, etag = _bootstrap(client)
    state["experiment"]["status"] = "active"
    active_while_watchful = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert active_while_watchful.status_code == 409

    state, etag = _bootstrap(client)
    state.update({"phase": "stable", "pendingPhase": None, "phaseConfirmed": False})
    state["experiment"].update({"status": "active", "reviewRequired": True})
    unreviewed_experiment = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert unreviewed_experiment.status_code == 409

    state, etag = _bootstrap(client)
    state["taper"]["days"][11]["doseMg"] = 99
    changed_dose = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert changed_dose.status_code == 409

    for mutate in (
        lambda snapshot: snapshot["taper"].update({"verified": False}),
        lambda snapshot: snapshot["taper"].update({"medicine": "Different medicine"}),
        lambda snapshot: snapshot["taper"].update({"prescribedBy": "Different clinician"}),
        lambda snapshot: snapshot["taper"].update({"currentDay": 99}),
        lambda snapshot: snapshot["taper"]["days"][12].update({"taken": True}),
        lambda snapshot: snapshot["prescription"].update({"rescuePlanEligible": False}),
    ):
        state, etag = _bootstrap(client)
        mutate(state)
        bypass = client.put("/api/demo", headers={"If-Match": etag}, json=state)
        assert bypass.status_code == 409, bypass.text

    state, etag = _bootstrap(client)
    state["taper"]["days"][11]["taken"] = True
    state["taper"]["days"][12]["taken"] = True
    mass_taken = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert mass_taken.status_code == 409

    state, etag = _bootstrap(client)
    state["prescription"]["status"] = "requested"
    rescue_from_watchful = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert rescue_from_watchful.status_code == 409

    state, etag = _bootstrap(client)
    state["testOrder"].update({"result": 420, "resultNote": "Forged result"})
    forged_result = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert forged_result.status_code == 409

    state, etag = _bootstrap(client)
    state["testOrder"].update({"result": 420, "resultNote": "Forged result"})
    state["prescription"]["status"] = "requested"
    forged_rescue = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert forged_rescue.status_code == 409

    state, etag = _bootstrap(client)
    state.update({"phase": "stable", "pendingPhase": None, "phaseConfirmed": True})
    demo_confirmation = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert demo_confirmation.status_code == 409

    state, etag = _bootstrap(client)
    state["phaseConfirmed"] = True
    state["entries"][0]["excluded"] = True
    sticky_evidence = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert sticky_evidence.status_code == 409


def test_wearable_is_a_soft_signal_and_disconnect_stops_sync(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    synced = client.post(
        "/api/wearable/simulate-sync",
        json={
            "restingHeartRate": 70,
            "heartRateVariabilityMs": 32.5,
            "sleepHours": 4.5,
            "activitySteps": 1200,
        },
    )
    assert synced.status_code == 200
    latest = client.get("/api/journal?kind=FROM%20YOUR%20WATCH").json()[0]
    assert latest["structured"]["softSignal"] is True
    assert latest["structured"]["heartRateVariabilityMs"] == 32.5
    assert "HRV 32.5 ms" in latest["body"]
    assert "supporting context only" in latest["body"]

    assert client.post("/api/wearable/disconnect").status_code == 200
    blocked = client.post("/api/wearable/simulate-sync", json={"restingHeartRate": 65})
    assert blocked.status_code == 409


def test_export_delete_and_reset_are_private_and_recoverable(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    exported = client.get("/api/export")
    assert exported.status_code == 200
    assert exported.json()["data"]["profile"]["name"] == "Matthew Johnson"
    assert "attachment" in exported.headers["content-disposition"]

    client.patch("/api/profile", json={"conditions": "Private pre-delete note"})
    before_delete_etag = client.get("/api/demo").headers["etag"]
    deleted = client.delete("/api/data")
    assert deleted.status_code == 200
    empty = deleted.json()
    assert empty["profile"]["name"] == ""
    assert empty["profile"]["immunosuppressed"] is False
    assert empty["contacts"] == []
    assert empty["taper"]["days"] == []
    assert empty["prescription"]["rescuePlanEligible"] is False

    after_export = client.get("/api/export").json()
    assert "Matthew" not in str(after_export)
    assert "Private pre-delete note" not in str(after_export)
    assert len(after_export["domainRevisions"]) == 1

    stale = client.put(
        "/api/demo",
        headers={"If-Match": before_delete_etag},
        json=_bootstrap(client)[0],
    )
    assert stale.status_code == 409

    reset = client.post("/api/demo/reset")
    assert reset.status_code == 200
    assert reset.json()["profile"]["name"] == "Matthew Johnson"
    assert len(client.get("/api/export").json()["domainRevisions"]) == 1


def test_sensitive_bytes_never_reach_sqlite_artifacts_and_delete_compacts_wal(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    marker = "GUTSY_PHYSICAL_DELETE_PROBE_7c13e9b4"
    marker_fragments = (b"GUTSY_PHYSICAL", b"e9b4")

    saved = client.patch("/api/profile", json={"conditions": marker})
    assert saved.status_code == 200
    artifacts_before = _sqlite_artifacts(store.path)
    assert artifacts_before
    for artifact in artifacts_before:
        for fragment in marker_fragments:
            assert fragment not in artifact.read_bytes(), artifact.name

    deleted = client.delete("/api/data")
    assert deleted.status_code == 200

    artifacts_after = _sqlite_artifacts(store.path)
    assert artifacts_after
    for artifact in artifacts_after:
        for fragment in marker_fragments:
            assert fragment not in artifact.read_bytes(), artifact.name

    wal = store.path.with_name(f"{store.path.name}-wal")
    assert not wal.exists() or wal.stat().st_size == 0
    with store._connect() as connection:
        assert connection.execute("PRAGMA secure_delete").fetchone()[0] == 1


@pytest.mark.parametrize("schedule_start_offset", [1, -42])
def test_taken_dose_requires_an_exact_patient_local_scheduled_date(
    domain_client: tuple[TestClient, SQLiteDemoStore],
    schedule_start_offset: int,
) -> None:
    client, store = domain_client
    today = date.today()

    def prepare_out_of_course_schedule(state: dict[str, Any]) -> None:
        start = today + timedelta(days=schedule_start_offset)
        state["prescription"].update(
            {"status": "collected", "treatmentStartedAt": f"{today.isoformat()}T08:00:00+00:00"}
        )
        for index, day in enumerate(state["taper"]["days"]):
            day["date"] = (start + timedelta(days=index)).isoformat()
            day["taken"] = False
        state["taper"].update({"verified": True, "currentDay": 1, "missedDays": []})

    store.mutate(
        prepare_out_of_course_schedule,
        "Prepared out-of-course exact-date adherence fixture",
        actor="test",
    )
    response = client.post("/api/taper/dose/taken")

    assert response.status_code == 404
    assert "scheduled for today" in response.json()["detail"]
    assert not any(day["taken"] for day in client.get("/api/taper").json()["days"])


def test_snapshot_cannot_mark_display_fallback_taper_day_as_taken(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client
    today = date.today()

    def prepare_future_course(state: dict[str, Any]) -> None:
        state["prescription"].update(
            {"status": "collected", "treatmentStartedAt": f"{today.isoformat()}T08:00:00+00:00"}
        )
        for index, day in enumerate(state["taper"]["days"]):
            day["date"] = (today + timedelta(days=index + 1)).isoformat()
            day["taken"] = False
        state["taper"].update({"verified": True, "currentDay": 1, "missedDays": []})

    store.mutate(prepare_future_course, "Prepared future taper fixture", actor="test")
    state, etag = _bootstrap(client)
    scheduled = state["taper"]["days"][0]
    scheduled["taken"] = True
    state["taper"]["currentDay"] = scheduled["day"]
    state["entries"].append(
        {
            "id": max(entry["id"] for entry in state["entries"]) + 1,
            "date": today.isoformat(),
            "time": "09:00",
            "kind": "MEDICATION",
            "body": "Patient marked the first future taper dose taken",
            "source": "manual",
            "flagged": False,
            "excluded": False,
            "structured": {
                "doseMg": scheduled["doseMg"],
                "taken": True,
                "taperDay": scheduled["day"],
                "scheduledDate": scheduled["date"],
            },
            "photo": None,
        }
    )

    response = client.put("/api/demo", headers={"If-Match": etag}, json=state)

    assert response.status_code == 409
    assert "exact patient-local date" in response.json()["detail"]


def test_prescription_request_requires_confirmed_flare_without_pending_phase(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client

    def add_objective_context(state: dict[str, Any]) -> None:
        state["testOrder"].update({"status": "result", "result": 420})
        state["entries"].append(
            {
                "id": 98_100,
                "date": date.today().isoformat(),
                "time": "10:00",
                "kind": "TEST RESULT",
                "body": "Faecal calprotectin 420 µg/g — clinical interpretation required",
                "source": "care",
                "flagged": True,
                "excluded": False,
                "structured": {"calprotectin": 420, "diagnostic": False},
            }
        )

    store.mutate(add_objective_context, "Prepared objective rescue fixture", actor="test")
    for phase, confirmed, pending in (
        ("watch", True, None),
        ("flare", False, None),
        ("flare", True, "recovery"),
    ):
        store.mutate(
            lambda state, phase=phase, confirmed=confirmed, pending=pending: state.update(
                {"phase": phase, "phaseConfirmed": confirmed, "pendingPhase": pending}
            ),
            "Prepared ineligible lifecycle rescue fixture",
            actor="test",
        )
        response = client.post("/api/care/prescription/request")
        assert response.status_code == 409
        assert "confirmed Flare" in response.json()["detail"]

    store.mutate(
        lambda state: state.update(
            {"phase": "flare", "phaseConfirmed": True, "pendingPhase": None}
        ),
        "Prepared eligible confirmed Flare fixture",
        actor="test",
    )
    assert client.post("/api/care/prescription/request").status_code == 200


def test_snapshot_prescription_request_requires_confirmed_flare(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, store = domain_client

    def prepare_watchful_objective_context(state: dict[str, Any]) -> None:
        state.update({"phase": "watch", "phaseConfirmed": True, "pendingPhase": None})
        state["testOrder"].update({"status": "result", "result": 420})
        state["entries"].append(
            {
                "id": 98_101,
                "date": date.today().isoformat(),
                "time": "10:00",
                "kind": "TEST RESULT",
                "body": "Faecal calprotectin 420 µg/g — clinical interpretation required",
                "source": "care",
                "flagged": True,
                "excluded": False,
                "structured": {"calprotectin": 420, "diagnostic": False},
            }
        )

    store.mutate(
        prepare_watchful_objective_context,
        "Prepared watchful objective snapshot fixture",
        actor="test",
    )
    state, etag = _bootstrap(client)
    state["prescription"]["status"] = "requested"
    response = client.put("/api/demo", headers={"If-Match": etag}, json=state)

    assert response.status_code == 409
    assert "confirmed Flare" in response.json()["detail"]


def test_outstanding_clinician_thread_cannot_be_archived_for_a_new_draft(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    assert client.post("/api/care/team-message/send").status_code == 200
    sent, etag = _bootstrap(client)
    assert client.post("/api/care/team-message/new").status_code == 409

    previous = dict(sent["teamMessage"])
    sent["teamMessageHistory"].insert(0, previous)
    sent["teamMessage"] = {
        **previous,
        "id": "MSG-FORGED-FOLLOW-UP",
        "subject": "Forged follow-up",
        "body": "This must not replace an outstanding response.",
        "status": "draft",
        "sentAt": None,
        "reply": None,
    }
    snapshot = client.put("/api/demo", headers={"If-Match": etag}, json=sent)
    assert snapshot.status_code == 409
    assert "received a reply" in snapshot.json()["detail"]

    assert client.post("/api/care/team-message/simulate-read").status_code == 200
    assert client.post("/api/care/team-message/new").status_code == 409
    assert (
        client.post(
            "/api/care/team-message/simulate-reply",
            json={"reply": "Please send a reviewed follow-up."},
        ).status_code
        == 200
    )
    assert client.post("/api/care/team-message/new").status_code == 200


def test_evening_background_preserves_an_outstanding_read_thread(
    domain_client: tuple[TestClient, SQLiteDemoStore], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, store = domain_client
    monkeypatch.setattr(
        domain_routes,
        "_background_now",
        lambda: datetime(2026, 7, 18, 20, 0, tzinfo=UTC),
    )
    store.mutate(
        lambda state: (
            state.update({"phase": "flare", "phaseConfirmed": True, "pendingPhase": None}),
            state["teamMessage"].update({"status": "read", "reply": None}),
        ),
        "Prepared outstanding read thread fixture",
        actor="test",
    )

    response = client.post("/api/background/run")

    assert response.status_code == 200
    assert response.json()["created"] is False
    state, _ = _bootstrap(client)
    assert state["teamMessage"]["status"] == "read"
    assert state["teamMessageHistory"] == []


def test_order_records_delivery_snapshot_and_profile_edits_do_not_rewrite_it(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    _confirm_watchful_state(client)
    profile = client.get("/api/profile").json()
    ordered = client.post(
        "/api/care/test-order/confirm",
        json={"addressConfirmed": True, "consent": True},
    )

    assert ordered.status_code == 200
    assert ordered.json()["deliveryAddress"] == profile["address"]
    assert ordered.json()["deliveryPostcode"] == profile["postcode"]
    assert ordered.json()["confirmedAt"] == ordered.json()["statusUpdatedAt"]

    changed_profile = client.patch(
        "/api/profile",
        json={"address": "99 New Address, London", "postcode": "N1 9ZZ"},
    )
    assert changed_profile.status_code == 200
    retained = client.get("/api/care/test-order").json()
    assert retained["deliveryAddress"] == profile["address"]
    assert retained["deliveryPostcode"] == profile["postcode"]

    state, etag = _bootstrap(client)
    state["testOrder"]["deliveryAddress"] = "Attacker-controlled destination"
    rewritten = client.put("/api/demo", headers={"If-Match": etag}, json=state)
    assert rewritten.status_code == 409
    assert "immutable" in rewritten.json()["detail"]


def test_snapshot_order_transition_server_authors_delivery_confirmation(
    domain_client: tuple[TestClient, SQLiteDemoStore],
) -> None:
    client, _ = domain_client
    _confirm_watchful_state(client)
    state, etag = _bootstrap(client)
    expected_address = state["profile"]["address"]
    expected_postcode = state["profile"]["postcode"]
    state["testOrder"].update(
        {
            "status": "ordered",
            "addressConfirmed": True,
            "consent": True,
            "deliveryAddress": "Client supplied address",
            "deliveryPostcode": "BAD 1",
            "confirmedAt": "2099-01-01T00:00:00Z",
        }
    )

    response = client.put("/api/demo", headers={"If-Match": etag}, json=state)

    assert response.status_code == 200, response.text
    order = response.json()["testOrder"]
    assert order["deliveryAddress"] == expected_address
    assert order["deliveryPostcode"] == expected_postcode
    assert order["confirmedAt"] == order["statusUpdatedAt"]
