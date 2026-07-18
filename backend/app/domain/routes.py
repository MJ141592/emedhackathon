from __future__ import annotations

import re
import secrets
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Cookie, Depends, Header, HTTPException, Query, Response, status
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import ValidationError

from app.domain.grounded_assistant import answer_from_permitted_records
from app.domain.models import (
    CaptureDraft,
    CareContact,
    CareContactCreate,
    CareContactPatch,
    ChatInput,
    ChatMessage,
    ChatMessagePatch,
    DashboardResponse,
    DemoState,
    Experiment,
    ExperimentCompletion,
    ExperimentPatch,
    HistoryValue,
    JournalDraft,
    JournalEntry,
    JournalPatch,
    LifecycleEvaluation,
    ObservationInput,
    PhaseInput,
    PrescriptionFlow,
    PrivacyPatch,
    PrivacySettings,
    Profile,
    ProfilePatch,
    ProfileProposal,
    ProfileProposalResolution,
    ReplyInput,
    SafetyAlert,
    SafetyEvaluation,
    SafetyInput,
    SnoozeInput,
    SummaryPatch,
    SupporterAccessInput,
    SupporterLogInput,
    SupporterLogResult,
    SupporterView,
    Taper,
    TaperCheckIn,
    TaperDoseCorrection,
    TaperMissedDose,
    TaperPatch,
    TeamMessage,
    TeamMessagePatch,
    TestAdvanceInput,
    TestOrder,
    TestOrderPatch,
    TestResultInput,
    TrustedSupporter,
    TrustedSupporterPatch,
    WearablePatch,
    WearableSettings,
    WearableSync,
)
from app.domain.reminders import current_background_reminder
from app.domain.retention import cleanup_expired_media as run_media_retention_cleanup
from app.domain.rules import (
    SAME_DAY_MESSAGE,
    URGENT_MESSAGE,
    apply_explicit_record_corrections,
    build_clinician_summary,
    build_dashboard,
    derive_entry_flagged,
    evaluate_lifecycle,
    evaluate_safety,
    experiment_requires_review,
    extract_profile_proposals,
    extract_structured_safety_details,
    has_eligible_test_order_evidence,
    has_included_raised_test,
    parse_blood_amount_clarification,
    parse_capture,
    safety_input_from_entry,
    symptoms_settling,
    taper_course_complete,
)
from app.domain.store import SQLiteDemoStore, VersionConflictError, get_demo_store, utc_now

router = APIRouter(prefix="/api", tags=["persisted demo"])
Store = Annotated[SQLiteDemoStore, Depends(get_demo_store)]
REMINDER_SUPPRESSION_COOKIE = "gutsy_reminders_suspended"

HISTORY_FIELDS = {
    "subtype",
    "extent",
    "surgeries",
    "conditions",
    "allergies",
    "familyHistory",
    "currentMedicines",
    "pastMedicines",
}
TEST_SEQUENCE = ["ordered", "shipped", "delivered", "sampled", "posted", "lab"]
ALL_TEST_STATES = ["prepared", *TEST_SEQUENCE, "result", "shared"]
CONSENT_VERSION = "demo-v1"
PRESCRIPTION_STATES = ["not-started", "prepared", "requested", "approved", "ready", "collected"]
MESSAGE_STATES = ["draft", "sent", "read", "replied"]
EVIDENCE_ENTRY_KINDS = {
    "BOWEL MOVEMENT",
    "PAIN",
    "FATIGUE",
    "WELLBEING",
    "FROM YOUR WATCH",
    "TEST RESULT",
}
BASELINE_FIELDS = {"usualBowel", "usualPain", "usualHeartRate", "usualSleep"}
PHASE_TRANSITIONS = {
    "stable": {"watch"},
    "watch": {"stable", "flare"},
    "flare": {"watch", "recovery"},
    "recovery": {"flare", "stable"},
}
EXPERIMENT_TRANSITIONS = {
    "suggested": {"suggested", "active"},
    "active": {"active", "paused", "complete"},
    "paused": {"paused", "active"},
    "complete": {"complete"},
}
EXPERIMENT_REVIEW_REQUEST_PATTERN = re.compile(r"\b(diet|dietitian|nutrition|experiment)\b", re.I)
EXPERIMENT_REVIEW_REPLY_PATTERN = re.compile(
    r"\b(approv(?:e|ed)|appropriate|safe to|may (?:start|proceed)|can (?:start|proceed)|"
    r"proceed|okay to (?:start|proceed)|ok to (?:start|proceed))\b",
    re.I,
)
EXPERIMENT_REVIEW_REJECTION_PATTERN = re.compile(
    r"\b(not approved|not appropriate|do not (?:start|proceed)|should not|cannot|can't|"
    r"must not|unsafe|not safe|danger(?:ous)?|contraindicat(?:ed|ion)|avoid(?: this)?)\b",
    re.I,
)
SIMULATED_EXPERIMENT_REVIEWER = "IBD team (simulated)"
BASELINE_INSTRUCTION_PATTERN = re.compile(
    r"^(?:(?:please\s+)?(?:record|measure|track|enter|add|capture)\b|"
    r"to\s+(?:record|measure|track|enter|add|capture)\b|not recorded\b|tbd\b|pending\b)",
    re.I,
)
BASELINE_FUTURE_PATTERN = re.compile(
    r"\b(?:(?:i|we)\s+)?(?:will|shall|should|need to|plan to|intend to|"
    r"(?:am|are) going to)\s+(?:record|measure|track|enter|add|capture)\b",
    re.I,
)
BASELINE_GENERAL_FUTURE_PATTERN = re.compile(
    r"\b(?:will be|shall be|intend(?:ed)? to|plan(?:ned)? to|(?:am|are) going to|"
    r"expect(?:ed)? to)\b",
    re.I,
)


def _background_now() -> datetime:
    return datetime.now(UTC)


def _is_recorded_experiment_baseline(value: str) -> bool:
    baseline = value.strip()
    return (
        bool(baseline)
        and BASELINE_INSTRUCTION_PATTERN.search(baseline) is None
        and BASELINE_FUTURE_PATTERN.search(baseline) is None
        and BASELINE_GENERAL_FUTURE_PATTERN.search(baseline) is None
        and re.fullmatch(r"(?:baseline|usual|same)", baseline, re.I) is None
    )


def _patient_now(profile: Any, instant: datetime | None = None) -> datetime:
    """Return one absolute instant in the patient's configured home time zone."""

    value = instant or datetime.now(UTC)
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(ZoneInfo(str(_value(profile, "timeZone", "UTC"))))


def _patient_date(profile: Any, instant: datetime | None = None) -> date:
    return _patient_now(profile, instant).date()


def _patch(target: dict[str, Any], patch: dict[str, Any]) -> None:
    target.update({key: value for key, value in patch.items() if value is not None})


def _value(item: Any, key: str, default: Any = None) -> Any:
    if isinstance(item, dict):
        return item.get(key, default)
    return getattr(item, key, default)


def _experiment_check_in_dates(state: Any, experiment_id: str) -> set[str]:
    dates: set[str] = set()
    for entry in _value(state, "entries", []):
        structured = _value(entry, "structured", {})
        if (
            not _value(entry, "excluded", False)
            and _value(entry, "kind") == "LIFE EVENT"
            and _value(structured, "experimentEvent") == "check-in"
            and _value(structured, "experimentId") == experiment_id
        ):
            dates.add(str(_value(entry, "date")))
    return dates


def _experiment_timeline_observations(state: Any, experiment_id: str) -> list[str]:
    """Build conclusions only from included, correctable shared-timeline sources."""

    rows: list[tuple[int, int, str, int, str]] = []
    for entry in _value(state, "entries", []):
        structured = _value(entry, "structured", {}) or {}
        event = _value(structured, "experimentEvent")
        if (
            _value(entry, "excluded", False)
            or _value(entry, "kind") != "LIFE EVENT"
            or _value(structured, "experimentId") != experiment_id
            or event not in {"check-in", "complete"}
        ):
            continue
        try:
            day_number = int(_value(structured, "day", 0))
        except (TypeError, ValueError):
            day_number = 0
        body = str(_value(entry, "body", ""))
        recorded = str(_value(structured, "experimentObservation", "") or "").strip()
        if not recorded and event == "check-in":
            recorded = body.rsplit(":", 1)[-1].strip()
        if not recorded:
            match = re.search(
                r"(?:personal\s+)?outcome review(?:\s*\([^)]*\))?\s*:\s*"
                r"(.+?)(?:\s+This is an observation|$)",
                body,
                re.I,
            )
            recorded = match.group(1).strip() if match else body.strip()
        label = (
            f"Day {day_number}: {recorded}"
            if event == "check-in"
            else f"Outcome review (personal observation, not proof): {recorded}"
        )
        rows.append(
            (
                0 if event == "check-in" else 1,
                day_number,
                str(_value(entry, "date", "")),
                int(_value(entry, "id", 0)),
                label,
            )
        )
    rows.sort(key=lambda row: row[:4])
    return [row[4] for row in rows]


def _reconcile_experiment_evidence(state: dict[str, Any]) -> None:
    experiment = state["experiment"]
    experiment_id = str(experiment["id"])
    observations = _experiment_timeline_observations(state, experiment_id)
    check_in_count = len(_experiment_check_in_dates(state, experiment_id))
    completion_recorded = any(
        not entry.get("excluded", False)
        and entry.get("kind") == "LIFE EVENT"
        and entry.get("structured", {}).get("experimentId") == experiment_id
        and entry.get("structured", {}).get("experimentEvent") == "complete"
        for entry in state["entries"]
    )
    experiment["observations"] = observations
    experiment["day"] = min(int(experiment["durationDays"]), check_in_count)
    if experiment["status"] == "complete" and (
        not completion_recorded or check_in_count < int(experiment["durationDays"])
    ):
        experiment["status"] = "paused"


def _normalised_review_text(value: Any) -> str:
    return " ".join(str(value or "").casefold().split())


def _experiment_review_definition(experiment: Any) -> str:
    return _normalised_review_text(
        " ".join(
            (
                f"candidate id {_value(experiment, 'id', '')}",
                f"title {_value(experiment, 'title', '')}",
                f"variable {_value(experiment, 'variable', '')}",
                f"goal {_value(experiment, 'goal', '')}",
                f"baseline {_value(experiment, 'baseline', '')}",
                f"outcome {_value(experiment, 'outcome', '')}",
                f"duration {_value(experiment, 'durationDays', '')} days",
            )
        )
    )


def _eligible_experiment_review_thread(state: Any, experiment: Any) -> Any | None:
    request_id = _value(experiment, "reviewRequestMessageId")
    if not request_id:
        return None
    message = _experiment_review_request_message(state, str(request_id))
    if message is not None and (
        _value(message, "status") == "replied"
        and EXPERIMENT_REVIEW_REPLY_PATTERN.search(str(_value(message, "reply", "") or ""))
        and not EXPERIMENT_REVIEW_REJECTION_PATTERN.search(str(_value(message, "reply", "") or ""))
    ):
        return message
    return None


def _experiment_review_request_message(
    state: Any, request_id: str, experiment: Any | None = None
) -> Any | None:
    candidate = experiment or _value(state, "experiment")
    definition = _experiment_review_definition(candidate)
    messages = [
        _value(state, "teamMessage"),
        *(_value(state, "teamMessageHistory", []) or []),
    ]
    for message in messages:
        if message is None or _value(message, "id") != request_id:
            continue
        request_text = f"{_value(message, 'subject', '')} {_value(message, 'body', '')}"
        if (
            EXPERIMENT_REVIEW_REQUEST_PATTERN.search(request_text)
            and definition
            and definition in _normalised_review_text(request_text)
        ):
            return message
    return None


def _tracking_is_active(profile: Any) -> bool:
    def field(name: str) -> Any:
        return profile.get(name) if isinstance(profile, dict) else getattr(profile, name)

    return bool(
        field("onboardingComplete")
        and field("adultEligibilityConfirmed")
        and field("healthDataConsent")
    )


def _require_tracking_consent(profile: Any) -> None:
    if not _tracking_is_active(profile):
        raise HTTPException(
            status_code=403,
            detail=(
                "Health-data tracking is paused. Complete adult onboarding and provide current "
                "health-data consent before adding new health records."
            ),
        )


def _server_authored_consent_profile(current: Profile, incoming: Profile) -> Profile:
    if _tracking_is_active(incoming):
        recorded_at = (
            current.consentRecordedAt
            if _tracking_is_active(current) and current.consentRecordedAt
            else utc_now()
        )
    else:
        recorded_at = None
    return incoming.model_copy(
        update={
            "consentVersion": CONSENT_VERSION,
            "consentRecordedAt": recorded_at,
        }
    )


def _revoke_consent_bound_access(state: dict[str, Any]) -> None:
    """Close optional access grants and unsubmitted consent when tracking stops."""

    state["wearable"].update({"connected": False, "lastSync": None})
    state["trustedSupporter"].update(
        {
            "enabled": False,
            "canViewSummary": False,
            "canSeeReminders": False,
            "canHelpLog": False,
            "accessCode": None,
            "accessCreatedAt": None,
        }
    )
    if state["testOrder"]["status"] == "prepared":
        state["testOrder"].update(
            {
                "addressConfirmed": False,
                "consent": False,
                "deliveryAddress": None,
                "deliveryPostcode": None,
                "confirmedAt": None,
            }
        )


def _require_test_order_consent(order: Any) -> None:
    def field(name: str) -> Any:
        return order.get(name) if isinstance(order, dict) else getattr(order, name)

    if not field("addressConfirmed") or not field("consent"):
        raise HTTPException(
            status_code=409,
            detail=(
                "Delivery confirmation and test consent must remain active before fulfilment "
                "or result sharing can advance."
            ),
        )


def _raised_objective_result_present(state: DemoState) -> bool:
    if (
        state.testOrder.status in {"result", "shared"}
        and state.testOrder.result is not None
        and state.testOrder.result >= 250
    ):
        return True
    for entry in state.entries:
        if entry.excluded or entry.kind != "TEST RESULT" or entry.source != "care":
            continue
        value = entry.structured.get("calprotectin")
        try:
            if float(value) >= 250:
                return True
        except (TypeError, ValueError):
            continue
    return False


def _stable_baseline_confirmation_available(state: DemoState) -> bool:
    """Allow an explicit governed starting point only for a genuinely clean onboarding."""

    complete_baseline = all(str(getattr(state.profile, field)).strip() for field in BASELINE_FIELDS)
    if (
        state.phase != "stable"
        or state.phaseConfirmed
        or state.pendingPhase is not None
        or not _tracking_is_active(state.profile)
        or not complete_baseline
        or state.prescription.status != "not-started"
        or state.prescription.treatmentStartedAt is not None
        or state.safetyAlert is not None
        or _raised_objective_result_present(state)
    ):
        return False
    return evaluate_lifecycle(state).proposedPhase is None


def _taper_actions_available(state: Any) -> bool:
    """Return whether adherence actions belong to an active clinician-issued course."""

    prescription = _value(state, "prescription", {})
    return _value(prescription, "status") == "collected" or (
        _value(state, "phase") == "recovery"
        and bool(_value(state, "phaseConfirmed", False))
        and _value(state, "pendingPhase") is None
    )


def _require_taper_actions_available(state: Any) -> None:
    if not _taper_actions_available(state):
        raise HTTPException(
            status_code=409,
            detail=(
                "Taper adherence actions become available only after clinician-issued treatment "
                "is collected or governed Recovery support is confirmed. The imported schedule "
                "can still be reviewed and verified."
            ),
        )


def _next_id(items: list[dict[str, Any]]) -> int:
    return max((int(item["id"]) for item in items), default=0) + 1


def _now_parts(profile: Any | None = None) -> tuple[str, str, str]:
    instant = datetime.now(UTC).replace(microsecond=0)
    local = _patient_now(profile, instant) if profile is not None else instant
    return local.date().isoformat(), local.strftime("%H:%M"), instant.isoformat()


def _calendar_taper_day(days: list[Any], fallback_day: int, profile: Any = None) -> Any | None:
    def field(item: Any, key: str) -> Any:
        return item.get(key) if isinstance(item, dict) else getattr(item, key)

    today_value = _patient_date(profile or {"timeZone": "UTC"}).isoformat()
    exact = next((item for item in days if str(field(item, "date")) == today_value), None)
    if exact is not None:
        return exact
    if not days:
        return None
    first, last = days[0], days[-1]
    first_date = str(field(first, "date"))
    last_date = str(field(last, "date"))
    if today_value < first_date:
        return first
    if today_value > last_date:
        return last
    return next(
        (item for item in days if int(field(item, "day")) == fallback_day),
        None,
    )


def _exact_calendar_taper_day(days: list[Any], profile: Any = None) -> Any | None:
    """Return only the dose actually scheduled for today's patient-local date.

    `_calendar_taper_day` deliberately retains a first/last-day fallback for read-only display.
    Medication adherence, however, must never use that visual fallback as a dose target.
    """

    def field(item: Any, key: str) -> Any:
        return item.get(key) if isinstance(item, dict) else getattr(item, key)

    today_value = _patient_date(profile or {"timeZone": "UTC"}).isoformat()
    return next((item for item in days if str(field(item, "date")) == today_value), None)


def _collection_timestamp_is_today(value: str | None, profile: Any) -> bool:
    if not value:
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None and _patient_date(profile, parsed) == _patient_date(profile)


def _is_collection_anchor_transition(current: DemoState, incoming: DemoState) -> bool:
    """Recognise the sole patient-side mutation allowed to rewrite taper dates.

    Collection changes only calendar dates and clears unissued adherence state. Day
    numbers, prescribed doses, medicine and prescriber remain clinician-authored.
    """

    if (
        current.prescription.status != "ready"
        or incoming.prescription.status != "collected"
        or current.prescription.treatmentStartedAt is not None
        or not _collection_timestamp_is_today(
            incoming.prescription.treatmentStartedAt, current.profile
        )
        or not current.taper.days
        or len(incoming.taper.days) != len(current.taper.days)
        or incoming.taper.medicine != current.taper.medicine
        or incoming.taper.prescribedBy != current.taper.prescribedBy
        or incoming.taper.verified
        or incoming.taper.currentDay != 1
        or incoming.taper.missedDays
        or incoming.taper.snoozedUntil is not None
        or incoming.taper.sideEffects
        or incoming.taper.checkInComplete
    ):
        return False

    start = _patient_date(current.profile)
    for index, (before, after) in enumerate(
        zip(current.taper.days, incoming.taper.days, strict=True)
    ):
        if (
            before.day != after.day
            or before.doseMg != after.doseMg
            or after.day != index + 1
            or after.date != (start + timedelta(days=index)).isoformat()
            or after.taken
        ):
            return False
    return True


def _anchor_taper_at_collection(state: dict[str, Any]) -> None:
    schedule = state["taper"]["days"]
    if not schedule:
        raise HTTPException(
            status_code=409,
            detail="An authorised taper schedule is required before collection can be recorded.",
        )
    start = _patient_date(state["profile"])
    for index, scheduled in enumerate(schedule):
        scheduled.update(
            {
                "date": (start + timedelta(days=index)).isoformat(),
                "taken": False,
            }
        )
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


def _entry(state: dict[str, Any], entry_id: int) -> dict[str, Any]:
    entry = next((item for item in state["entries"] if item["id"] == entry_id), None)
    if entry is None:
        raise HTTPException(status_code=404, detail="Journal entry not found.")
    return entry


def _taper_adherence_record(entry: Any) -> tuple[str, str | None, int] | None:
    if _value(entry, "kind") != "MEDICATION":
        return None
    structured = _value(entry, "structured", {}) or {}
    day_value = _value(structured, "taperDay")
    try:
        day_number = int(day_value)
    except (TypeError, ValueError):
        return None
    if _value(structured, "adherenceCorrection") is True:
        return "correction", str(_value(structured, "correctedFact") or ""), day_number
    if _value(structured, "missed") is True:
        return "source", "missed", day_number
    if _value(structured, "taken") is True:
        return "source", "taken", day_number
    return None


PATIENT_JOURNAL_RESERVED_FIELDS = {
    "adherenceCorrection",
    "calprotectin",
    "correctedFact",
    "experimentEvent",
    "experimentId",
    "missed",
    "scheduledDate",
    "taperDay",
}


def _validate_patient_journal_create(payload: JournalDraft) -> None:
    """Keep workflow provenance and derived safety fields server-owned."""

    if payload.source != "manual":
        raise HTTPException(
            status_code=403,
            detail=(
                "The generic journal endpoint creates patient-authored manual records only; "
                "chat, wearable, care and assistant provenance belong to their governed flows."
            ),
        )
    reserved = PATIENT_JOURNAL_RESERVED_FIELDS.intersection(payload.structured)
    if reserved:
        raise HTTPException(
            status_code=403,
            detail=(
                "Taper, test and experiment provenance fields can only be created by their "
                f"governed workflows: {', '.join(sorted(reserved))}."
            ),
        )
    if payload.flagged or payload.excluded:
        raise HTTPException(
            status_code=422,
            detail="New journal safety and inclusion state is derived by the server.",
        )


def _validate_patient_journal_patch(
    original: JournalEntry, payload: JournalPatch, patch: dict[str, Any]
) -> None:
    if payload.source is not None and payload.source != original.source:
        raise HTTPException(status_code=409, detail="Journal source provenance is immutable.")
    if payload.flagged is not None:
        raise HTTPException(
            status_code=409,
            detail="Journal safety flags are recomputed from corrected patient evidence.",
        )
    if payload.structured is not None:
        for field in PATIENT_JOURNAL_RESERVED_FIELDS:
            if payload.structured.get(field) != original.structured.get(field):
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "Taper, test and experiment provenance cannot be added or rewritten "
                        "through a generic journal correction."
                    ),
                )
    patch.pop("source", None)
    patch.pop("flagged", None)


def _contact(state: dict[str, Any], contact_id: str) -> dict[str, Any]:
    contact = next((item for item in state["contacts"] if item["id"] == contact_id), None)
    if contact is None:
        raise HTTPException(status_code=404, detail="Care contact not found.")
    return contact


def _etag(revision: int) -> str:
    return f'"{revision}"'


def _parse_etag(raw: str | None) -> int:
    if raw is None:
        raise HTTPException(
            status_code=status.HTTP_428_PRECONDITION_REQUIRED,
            detail="If-Match with the latest demo ETag is required.",
        )
    token = raw.strip()
    if token.startswith("W/"):
        token = token[2:]
    token = token.strip('"')
    try:
        return int(token)
    except ValueError as error:
        raise HTTPException(
            status_code=400, detail="If-Match must contain a numeric ETag."
        ) from error


def _trigger_is_emergency(trigger: str) -> bool:
    lowered = trigger.casefold()
    return any(
        term in lowered
        for term in (
            "heavy or continuous bleeding",
            "severe abdominal pain",
            "faintness or collapse",
            "bowel obstruction",
            "inability to pass stool or gas",
            "abdominal distension",
        )
    )


def _safety_input_with_body(entry: JournalEntry) -> SafetyInput:
    """Screen structured fields plus explicit red-flag wording in every entry path."""

    text_details = extract_structured_safety_details(entry.body)
    if not text_details:
        return safety_input_from_entry(entry)
    probe = entry.model_copy(update={"structured": {**entry.structured, **text_details}})
    return safety_input_from_entry(probe)


def _set_safety_alert(
    state: dict[str, Any],
    evaluation: SafetyEvaluation,
    *,
    source_entry_ids: list[int] | None = None,
) -> None:
    previous = state.get("safetyAlert")
    next_id = int(previous["id"]) + 1 if previous else 1
    requested_ids = list(
        dict.fromkeys(
            [*(previous.get("sourceEntryIds", []) if previous else []), *(source_entry_ids or [])]
        )
    )
    linked_evaluations: list[tuple[int, SafetyEvaluation]] = []
    profile = Profile.model_validate(state["profile"])
    for entry in state["entries"]:
        if entry["id"] not in requested_ids or entry.get("excluded", False):
            continue
        result = evaluate_safety(
            _safety_input_with_body(JournalEntry.model_validate(entry)), profile
        )
        if result.urgent:
            linked_evaluations.append((int(entry["id"]), result))
    unlinked_triggers = list(previous.get("unlinkedTriggers", [])) if previous else []
    if not source_entry_ids:
        unlinked_triggers.extend(evaluation.triggers)
    unlinked_triggers = list(dict.fromkeys(unlinked_triggers))
    triggers = list(
        dict.fromkeys(
            [
                *unlinked_triggers,
                *(trigger for _, result in linked_evaluations for trigger in result.triggers),
            ]
        )
    )
    if not triggers:
        state["safetyAlert"] = None
        return
    level = (
        "emergency"
        if any(_trigger_is_emergency(trigger) for trigger in triggers)
        or any(result.level == "emergency" for _, result in linked_evaluations)
        else "same-day"
    )
    previous_level = previous.get("level") if previous else None
    message = (
        previous.get("message")
        if previous and previous_level == "emergency" and level == "emergency"
        else evaluation.message
    )
    state["safetyAlert"] = {
        "id": next_id,
        "level": level,
        "triggers": triggers,
        "message": message,
        "createdAt": utc_now(),
        "sourceEntryIds": [entry_id for entry_id, _ in linked_evaluations],
        "unlinkedTriggers": unlinked_triggers,
    }


def _recompute_safety_alert_after_source_change(
    state: dict[str, Any], source_entry_id: int
) -> None:
    alert = state.get("safetyAlert")
    if not alert or source_entry_id not in alert.get("sourceEntryIds", []):
        return
    routine = SafetyEvaluation(urgent=False, level="routine", triggers=[], message="")
    _set_safety_alert(state, routine, source_entry_ids=[])


def _server_authored_snapshot_safety(current: DemoState, incoming: DemoState) -> DemoState:
    """Re-screen changed records and author flags/alerts independently of browser claims.

    Complete-snapshot sync is convenient for the demo UI, but a client-provided `flagged` or
    `safetyAlert` value is never evidence. Only the explicit acknowledgement endpoint may clear
    an unlinked warning; linked warnings disappear when their source is corrected, excluded or
    deleted and no longer matches a deterministic rule.
    """

    current_by_id = {entry.id: entry for entry in current.entries}
    changed_ids: set[int] = set()
    canonical_entries: list[JournalEntry] = []
    for entry in incoming.entries:
        previous = current_by_id.get(entry.id)
        safety_fields_changed = previous is None or any(
            getattr(entry, field) != getattr(previous, field)
            for field in ("kind", "body", "structured", "excluded")
        )
        if safety_fields_changed:
            changed_ids.add(entry.id)
            evaluation = evaluate_safety(_safety_input_with_body(entry), incoming.profile)
            deterministic_flag = derive_entry_flagged(
                entry.model_copy(update={"flagged": False}), incoming.profile
            )
            entry = entry.model_copy(update={"flagged": deterministic_flag or evaluation.urgent})
        elif previous is not None:
            # A flag-only snapshot edit is not a patient correction; preserve the server fact.
            entry = entry.model_copy(update={"flagged": previous.flagged})
        canonical_entries.append(entry)

    previous_alert = current.safetyAlert
    candidate_ids = set(previous_alert.sourceEntryIds if previous_alert else []) | changed_ids
    linked: list[tuple[int, SafetyEvaluation]] = []
    for entry in canonical_entries:
        if entry.id not in candidate_ids or entry.excluded:
            continue
        evaluation = evaluate_safety(_safety_input_with_body(entry), incoming.profile)
        if evaluation.urgent:
            linked.append((entry.id, evaluation))

    unlinked = list(dict.fromkeys(previous_alert.unlinkedTriggers if previous_alert else []))
    triggers = list(
        dict.fromkeys(
            [
                *unlinked,
                *(trigger for _, evaluation in linked for trigger in evaluation.triggers),
            ]
        )
    )
    source_ids = list(dict.fromkeys(entry_id for entry_id, _ in linked))
    if not triggers:
        alert: SafetyAlert | None = None
    else:
        level = (
            "emergency"
            if any(evaluation.level == "emergency" for _, evaluation in linked)
            or any(_trigger_is_emergency(trigger) for trigger in triggers)
            else "same-day"
        )
        same_as_previous = bool(
            previous_alert
            and previous_alert.level == level
            and previous_alert.triggers == triggers
            and previous_alert.sourceEntryIds == source_ids
            and previous_alert.unlinkedTriggers == unlinked
        )
        alert = (
            previous_alert
            if same_as_previous
            else SafetyAlert(
                id=(previous_alert.id + 1 if previous_alert else 1),
                level=level,
                triggers=triggers,
                message=URGENT_MESSAGE if level == "emergency" else SAME_DAY_MESSAGE,
                createdAt=utc_now(),
                sourceEntryIds=source_ids,
                unlinkedTriggers=unlinked,
            )
        )
    return incoming.model_copy(update={"entries": canonical_entries, "safetyAlert": alert})


def _invalidate_evidence_confirmation(state: dict[str, Any]) -> None:
    evaluation = evaluate_lifecycle(DemoState.model_validate(state))
    proposal = evaluation.proposedPhase
    if proposal is None and state["phase"] == "stable":
        return
    state["phaseConfirmed"] = False
    state["pendingPhase"] = proposal or state["phase"]
    if proposal != "stable" and state["experiment"]["status"] == "active":
        state["experiment"]["status"] = "paused"


def _refresh_lifecycle_proposal(state: dict[str, Any]) -> None:
    """Persist a newly reachable governed transition after non-journal workflow changes."""

    proposal = evaluate_lifecycle(DemoState.model_validate(state)).proposedPhase
    if proposal is None:
        return
    state["pendingPhase"] = proposal
    state["phaseConfirmed"] = False
    if proposal != "stable" and state["experiment"]["status"] == "active":
        state["experiment"]["status"] = "paused"


def _recompute_lifecycle_after_baseline_change(state: dict[str, Any]) -> None:
    """Invalidate the old review and persist the proposal derived from the new baseline."""

    state["phaseConfirmed"] = False
    proposal = evaluate_lifecycle(DemoState.model_validate(state)).proposedPhase
    state["pendingPhase"] = proposal
    if state["experiment"]["status"] == "active":
        state["experiment"]["status"] = "paused"


def _refresh_clinician_summary(state: dict[str, Any]) -> None:
    regenerated = build_clinician_summary(DemoState.model_validate(state))
    if state["teamMessage"]["status"] == "draft" and state.get("clinicianSummary") != regenerated:
        # Never overwrite a patient-edited message when its supporting record changes. The
        # patient must explicitly refresh the draft before it can be sent.
        state["teamMessageStale"] = True
    if state.get("clinicianSummaryEdited", False):
        state["clinicianSummaryStale"] = True
        return
    state["clinicianSummary"] = regenerated
    state["clinicianSummaryStale"] = False


def _evidence_fingerprint(state: DemoState) -> dict[int, dict[str, Any]]:
    return {
        entry.id: {
            "date": entry.date,
            "time": entry.time,
            "kind": entry.kind,
            "body": entry.body,
            "excluded": entry.excluded,
            "structured": entry.structured,
        }
        for entry in state.entries
        if entry.kind in EVIDENCE_ENTRY_KINDS
    }


def _team_message_source_fingerprint(state: DemoState) -> dict[str, Any]:
    """Facts that make an existing clinician-message draft need explicit refresh.

    The calendar's display focus (`taper.currentDay`) is deliberately excluded: moving the
    highlight at midnight does not rewrite evidence or adherence history.
    """

    return {
        "entries": {
            entry.id: {
                "date": entry.date,
                "time": entry.time,
                "kind": entry.kind,
                "body": entry.body,
                "source": entry.source,
                "excluded": entry.excluded,
                "structured": entry.structured,
            }
            for entry in state.entries
            if entry.kind != "Penny noticed"
        },
        "profile": state.profile.model_dump(mode="json"),
        "testOrder": state.testOrder.model_dump(mode="json"),
        "prescription": state.prescription.model_dump(mode="json"),
        "taper": {
            "verified": state.taper.verified,
            "medicine": state.taper.medicine,
            "prescribedBy": state.taper.prescribedBy,
            "days": [(day.day, day.doseMg, day.date, day.taken) for day in state.taper.days],
            "missedDays": state.taper.missedDays,
            "sideEffects": state.taper.sideEffects,
            "checkInComplete": state.taper.checkInComplete,
        },
        "experiment": state.experiment.model_dump(mode="json"),
    }


def _validate_photo(draft: JournalDraft | JournalEntry, state: DemoState) -> None:
    if draft.photo is None or not draft.photo.previewUrl:
        return
    if not draft.photo.consented:
        raise HTTPException(status_code=422, detail="Photo consent must be explicit before upload.")
    if draft.photo.purpose == "toilet" and not state.privacy.toiletPhotoConsent:
        raise HTTPException(
            status_code=403,
            detail="Enable optional toilet-photo consent before adding this photo.",
        )


def _require_single_forward_step(
    resource: str,
    current_status: str,
    incoming_status: str,
    sequence: list[str],
) -> None:
    current_index = sequence.index(current_status)
    incoming_index = sequence.index(incoming_status)
    if incoming_index < current_index or incoming_index > current_index + 1:
        raise HTTPException(
            status_code=409,
            detail=f"{resource} status must advance exactly one governed step at a time.",
        )


def _snapshot_message_protected_shape(message: ChatMessage) -> dict[str, Any]:
    """Return the conversation fields a complete-snapshot client may not rewrite.

    Evidence-card display fields linked to a journal entry are deliberately omitted here. A
    patient correction changes those labels, dates and details, but the API regenerates them
    from the retained journal record before saving. Link identity and every non-journal source
    remain immutable through aggregate sync.
    """

    payload = message.model_dump(mode="json", by_alias=True)
    payload["sources"] = [
        (
            {
                key: value
                for key, value in source.model_dump(mode="json").items()
                if key not in {"label", "date", "detail", "excluded"}
            }
            if source.entryId is not None
            else source.model_dump(mode="json")
        )
        for source in message.sources
    ]
    return payload


def _server_authored_snapshot_conversation(
    current: DemoState, incoming: DemoState
) -> DemoState:
    """Regenerate journal-linked evidence cards without trusting browser display text."""

    # Clearing the complete conversation is an intentional privacy action. Individual removals
    # have already been rejected by transition validation.
    if not incoming.messages:
        return incoming

    current_entries = {entry.id: entry for entry in current.entries}
    incoming_entries = {entry.id: entry for entry in incoming.entries}
    canonical_messages: list[ChatMessage] = []
    for message in current.messages:
        reply_context_retracted = any(
            source.messageId is not None
            and source.label == "Original patient wording"
            and source.excluded
            for source in message.sources
        )
        canonical_sources = []
        for source in message.sources:
            if source.entryId is None:
                canonical_sources.append(source)
                continue
            entry = incoming_entries.get(source.entryId)
            previous_entry = current_entries.get(source.entryId)
            if entry is None:
                canonical_sources.append(
                    source.model_copy(
                        update={
                            "excluded": True,
                            "detail": (
                                "Source record deleted by the patient; this earlier reply may "
                                "no longer reflect the retained record."
                            ),
                        }
                    )
                )
            elif previous_entry == entry:
                # Overwrite browser display-field tampering with the current server source,
                # while avoiding unrelated churn in seeded human-friendly labels and dates.
                canonical_sources.append(source)
            else:
                canonical_sources.append(
                    source.model_copy(
                        update={
                            "label": entry.kind,
                            "date": f"{entry.date}, {entry.time}",
                            "detail": entry.body,
                            "excluded": entry.excluded or reply_context_retracted,
                        }
                    )
                )
        canonical_messages.append(message.model_copy(update={"sources": canonical_sources}))
    return incoming.model_copy(update={"messages": canonical_messages})


def _validate_snapshot_transition(current: DemoState, incoming: DemoState) -> None:
    supporter_access_changed = (
        incoming.trustedSupporter.accessCode != current.trustedSupporter.accessCode
        or incoming.trustedSupporter.accessCreatedAt
        != current.trustedSupporter.accessCreatedAt
    )
    if supporter_access_changed and incoming.trustedSupporter.accessCode is not None:
        raise HTTPException(
            status_code=409,
            detail="Supporter access codes can only be generated through their explicit endpoint.",
        )
    if not _tracking_is_active(incoming.profile):
        if incoming.wearable.connected:
            raise HTTPException(
                status_code=409,
                detail="Withdrawing health-data consent must disconnect wearable ingestion.",
            )
        if (
            incoming.trustedSupporter.enabled
            or incoming.trustedSupporter.canViewSummary
            or incoming.trustedSupporter.canSeeReminders
            or incoming.trustedSupporter.canHelpLog
        ):
            raise HTTPException(
                status_code=409,
                detail="Withdrawing health-data consent must disable trusted-supporter access.",
            )
        if incoming.testOrder.status == "prepared" and (
            incoming.testOrder.addressConfirmed or incoming.testOrder.consent
        ):
            raise HTTPException(
                status_code=409,
                detail=(
                    "Withdrawing health-data consent clears unsubmitted delivery confirmation "
                    "and test consent."
                ),
            )
        current_entry_ids = {entry.id for entry in current.entries}
        current_message_ids = {message.id for message in current.messages}
        if any(entry.id not in current_entry_ids for entry in incoming.entries) or any(
            message.id not in current_message_ids for message in incoming.messages
        ):
            raise HTTPException(
                status_code=403,
                detail=(
                    "New journal or conversation records cannot be added while tracking is paused."
                ),
            )
        consent_revoked_prepared_order = (
            current.testOrder.status == "prepared"
            and incoming.testOrder
            == current.testOrder.model_copy(
                update={"addressConfirmed": False, "consent": False}
            )
        )
        if (
            (incoming.testOrder != current.testOrder and not consent_revoked_prepared_order)
            or incoming.prescription != current.prescription
            or incoming.teamMessage.status != current.teamMessage.status
            or incoming.experiment.status != current.experiment.status
            or incoming.experiment.day != current.experiment.day
            or incoming.experiment.observations != current.experiment.observations
            or [day.taken for day in incoming.taper.days]
            != [day.taken for day in current.taper.days]
            or incoming.taper.missedDays != current.taper.missedDays
            or incoming.taper.checkInComplete != current.taper.checkInComplete
            or incoming.taper.snoozedUntil != current.taper.snoozedUntil
        ):
            raise HTTPException(
                status_code=403,
                detail=(
                    "Care, adherence and experiment workflows are paused after health-data "
                    "consent is withdrawn; existing text records may still be corrected or "
                    "deleted."
                ),
            )
    current_proposals = {proposal.id: proposal for proposal in current.profileProposals}
    incoming_proposals = {proposal.id: proposal for proposal in incoming.profileProposals}
    current_message_ids = {message.id for message in current.messages}
    incoming_messages = {message.id: message for message in incoming.messages}
    for proposal_id, proposal in current_proposals.items():
        candidate = incoming_proposals.get(proposal_id)
        if candidate is None:
            if proposal.sourceMessageId in incoming_messages:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "A PMH proposal can only be removed with its source conversation; "
                        "otherwise accept or dismiss it."
                    ),
                )
            continue
        if (
            candidate.field != proposal.field
            or candidate.value != proposal.value
            or candidate.sourceMessageId != proposal.sourceMessageId
            or candidate.createdAt != proposal.createdAt
        ):
            raise HTTPException(
                status_code=409,
                detail="Conversation-derived PMH proposal wording and provenance are immutable.",
            )
        if candidate.status != proposal.status:
            if proposal.status != "pending" or candidate.status not in {"accepted", "dismissed"}:
                raise HTTPException(
                    status_code=409,
                    detail="A PMH proposal can be accepted or dismissed exactly once.",
                )
            if (
                candidate.status == "accepted"
                and candidate.value.casefold()
                not in str(getattr(incoming.profile, candidate.field)).casefold()
            ):
                raise HTTPException(
                    status_code=409,
                    detail="Accepting a PMH proposal must save its exact wording to that field.",
                )
    for proposal_id, proposal in incoming_proposals.items():
        if proposal_id in current_proposals:
            continue
        source = incoming_messages.get(proposal.sourceMessageId)
        expected = extract_profile_proposals(source.text) if source and source.from_ == "me" else []
        if (
            proposal.sourceMessageId in current_message_ids
            or proposal.status != "pending"
            or source is None
            or source.from_ != "me"
            or proposal.createdAt != source.createdAt
            or not incoming.privacy.assistantProfileAccess
            or not any(
                draft.field == proposal.field and draft.value == proposal.value
                for draft in expected
            )
        ):
            raise HTTPException(
                status_code=409,
                detail=(
                    "A new PMH proposal must be a pending deterministic extraction from its "
                    "new patient message while profile access is enabled."
                ),
            )

    current_entries_by_id = {entry.id: entry for entry in current.entries}
    incoming_entry_ids = {entry.id for entry in incoming.entries}
    new_entries = [entry for entry in incoming.entries if entry.id not in current_entries_by_id]
    objective_result_transition = (
        current.testOrder.status == "lab"
        and incoming.testOrder.status == "result"
        and incoming.testOrder.result is not None
    )
    for entry in incoming.entries:
        previous = current_entries_by_id.get(entry.id)
        if previous is not None and entry.source != previous.source:
            raise HTTPException(
                status_code=409,
                detail="Journal source provenance is immutable through snapshot sync.",
            )
        if previous is None:
            governed_care_result = (
                objective_result_transition
                and entry.source == "care"
                and entry.kind == "TEST RESULT"
                and entry.structured.get("calprotectin") == incoming.testOrder.result
            )
            if (
                entry.source in {"care", "penny", "wearable", "supporter"}
                and not governed_care_result
            ):
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "Care, assistant and wearable provenance can only enter through their "
                        "governed source workflow."
                    ),
                )

    current_messages_by_id = {message.id: message for message in current.messages}
    incoming_messages_by_id = {message.id: message for message in incoming.messages}
    changed_existing_messages = [
        message_id
        for message_id, message in current_messages_by_id.items()
        if message_id in incoming_messages_by_id
        and _snapshot_message_protected_shape(incoming_messages_by_id[message_id])
        != _snapshot_message_protected_shape(message)
    ]
    removed_message_ids = set(current_messages_by_id) - set(incoming_messages_by_id)
    if changed_existing_messages:
        raise HTTPException(
            status_code=409,
            detail="Conversation records can only be corrected through the per-message endpoint.",
        )
    if removed_message_ids and incoming.messages:
        raise HTTPException(
            status_code=409,
            detail=(
                "Individual conversation records can only be deleted through the per-message "
                "endpoint."
            ),
        )
    new_messages = [
        message for message in incoming.messages if message.id not in current_messages_by_id
    ]
    if new_messages:
        raise HTTPException(
            status_code=409,
            detail=(
                "New patient messages, deterministic captures and Penny replies must be "
                "server-authored through the explicit chat endpoint."
            ),
        )

    referenced_entry_ids = {
        int(source.entryId)
        for message in incoming.messages
        for source in message.sources
        if source.entryId is not None and not source.excluded
    }
    if not referenced_entry_ids.issubset(incoming_entry_ids):
        raise HTTPException(
            status_code=409,
            detail="Conversation evidence links must resolve to retained journal records.",
        )

    new_patient_messages = [message for message in new_messages if message.from_ == "me"]
    expected_chat_drafts = [
        draft for message in new_patient_messages for draft in parse_capture(message.text).entries
    ]
    new_chat_entries = [entry for entry in new_entries if entry.source == "chat"]
    unmatched_chat_entries = list(new_chat_entries)
    for draft in expected_chat_drafts:
        match = next(
            (
                entry
                for entry in unmatched_chat_entries
                if entry.kind == draft.kind
                and entry.body == draft.body
                and entry.structured == draft.structured
            ),
            None,
        )
        if match is not None:
            unmatched_chat_entries.remove(match)
    if unmatched_chat_entries:
        raise HTTPException(
            status_code=409,
            detail=(
                "Chat-sourced journal records must be deterministic captures of the new "
                "patient message."
            ),
        )

    urgent_new_sources: list[tuple[JournalEntry, SafetyEvaluation]] = []
    for entry in new_entries:
        result = evaluate_safety(_safety_input_with_body(entry), incoming.profile)
        deterministically_flagged_kind = entry.kind in {
            "BOWEL MOVEMENT",
            "PAIN",
            "WELLBEING",
            "FATIGUE",
            "MEDICATION",
            "FROM YOUR WATCH",
        }
        expected_flag = (
            derive_entry_flagged(
                entry.model_copy(update={"flagged": False}), incoming.profile
            )
            if deterministically_flagged_kind
            else entry.flagged
        ) or result.urgent
        if entry.flagged != expected_flag:
            raise HTTPException(
                status_code=409,
                detail="New journal safety flags must match the deterministic server rules.",
            )
        if result.urgent and not entry.excluded:
            urgent_new_sources.append((entry, result))

    urgent_unlinked: list[SafetyEvaluation] = []
    for message in new_patient_messages:
        capture = parse_capture(message.text)
        for draft in capture.entries:
            probe = JournalEntry.model_validate(
                {
                    **draft.model_dump(mode="json", exclude_none=True),
                    "id": -1,
                    "date": _patient_date(incoming.profile).isoformat(),
                    "time": "00:00",
                }
            )
            result = evaluate_safety(_safety_input_with_body(probe), incoming.profile)
            if result.urgent and not any(
                entry.kind == draft.kind
                and entry.body == draft.body
                and entry.structured == draft.structured
                for entry in new_chat_entries
            ):
                urgent_unlinked.append(result)
    if urgent_new_sources or urgent_unlinked:
        alert = incoming.safetyAlert
        required_triggers = {
            trigger
            for _, result in urgent_new_sources
            for trigger in result.triggers
        } | {trigger for result in urgent_unlinked for trigger in result.triggers}
        required_source_ids = {entry.id for entry, _ in urgent_new_sources}
        required_level = "emergency" if (
            any(result.level == "emergency" for _, result in urgent_new_sources)
            or any(result.level == "emergency" for result in urgent_unlinked)
        ) else "same-day"
        if (
            alert is None
            or alert.level != required_level
            or not required_triggers.issubset(set(alert.triggers))
            or not required_source_ids.issubset(set(alert.sourceEntryIds))
            or (urgent_unlinked and not required_triggers.intersection(alert.unlinkedTriggers))
        ):
            raise HTTPException(
                status_code=409,
                detail=(
                    "A new urgent record must retain the highest unresolved safety route, its "
                    "deterministic triggers and source provenance."
                ),
            )
    evidence_changed = _evidence_fingerprint(current) != _evidence_fingerprint(incoming)
    baseline_changed = any(
        getattr(current.profile, field) != getattr(incoming.profile, field)
        for field in BASELINE_FIELDS
    )
    if evidence_changed and incoming.phaseConfirmed:
        raise HTTPException(
            status_code=409,
            detail=(
                "Changing a source observation invalidates its prior review. Save the correction "
                "with phaseConfirmed false, then review the current included evidence again."
            ),
        )
    if baseline_changed:
        expected_proposal = evaluate_lifecycle(incoming).proposedPhase
        if incoming.phaseConfirmed or incoming.pendingPhase != expected_proposal:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Changing a personal baseline invalidates lifecycle confirmation and must "
                    "persist the proposal recomputed from the updated baseline."
                ),
            )
    confirmation_added = incoming.phaseConfirmed and not current.phaseConfirmed
    if confirmation_added:
        expected_phase = evaluate_lifecycle(current).proposedPhase
        stable_baseline_confirmation = (
            incoming.phase == "stable"
            and incoming.pendingPhase is None
            and _stable_baseline_confirmation_available(current)
        )
        if not stable_baseline_confirmation and (
            expected_phase is None
            or incoming.phase != expected_phase
            or (current.pendingPhase is not None and current.pendingPhase != expected_phase)
        ):
            raise HTTPException(
                status_code=409,
                detail=(
                    "Lifecycle confirmation must match the current evidence-governed proposal; "
                    "a presentation choice or generic confirmation cannot authorise care."
                ),
            )
    if (
        incoming.phase != current.phase
        and incoming.phaseConfirmed
        and current.pendingPhase != incoming.phase
    ):
        raise HTTPException(
            status_code=409,
            detail=(
                "An explicit demo phase switch changes presentation only and cannot confirm "
                "clinical evidence."
            ),
        )
    if (
        incoming.phase != current.phase
        and incoming.phaseConfirmed
        and incoming.phase not in PHASE_TRANSITIONS[current.phase]
    ):
        raise HTTPException(
            status_code=409,
            detail="A confirmed lifecycle transition cannot skip a governed phase.",
        )
    if (
        incoming.phaseConfirmed
        and not current.phaseConfirmed
        and incoming.phase in {"watch", "flare"}
        and not has_eligible_test_order_evidence(incoming)
    ):
        raise HTTPException(
            status_code=409,
            detail="At least two current included clinical change signals must be reviewed.",
        )
    if incoming.phase != current.phase and incoming.phaseConfirmed and incoming.phase == "recovery":
        if incoming.prescription.status != "collected" or not symptoms_settling(incoming):
            raise HTTPException(
                status_code=409,
                detail=(
                    "Recovery support requires collected clinician-authorised treatment and an "
                    "included patient record that symptoms are settling."
                ),
            )
    if (
        incoming.phase != current.phase
        and incoming.phaseConfirmed
        and incoming.phase == "stable"
        and current.phase == "recovery"
        and (
            not incoming.taper.days
            or not taper_course_complete(incoming)
            or not symptoms_settling(incoming)
        )
    ):
        raise HTTPException(
            status_code=409,
            detail="Stable support requires course completion and return-to-baseline evidence.",
        )
    if (
        incoming.phaseConfirmed
        and incoming.phase == "flare"
        and not has_included_raised_test(incoming)
    ):
        raise HTTPException(
            status_code=409,
            detail=(
                "Confirming Flare support requires matching included objective test evidence; "
                "an explicit demo switch may change presentation without confirming it."
            ),
        )

    _require_single_forward_step(
        "Test order", current.testOrder.status, incoming.testOrder.status, ALL_TEST_STATES
    )
    test_status_changed = incoming.testOrder.status != current.testOrder.status
    if (
        incoming.testOrder.clinicalOwner != current.testOrder.clinicalOwner
        or incoming.testOrder.eligibilityRule != current.testOrder.eligibilityRule
        or incoming.testOrder.eligibilityReason != current.testOrder.eligibilityReason
    ):
        raise HTTPException(
            status_code=409,
            detail=(
                "The clinical owner and eligibility-rule provenance are configured by the "
                "care pathway and cannot be rewritten through snapshot sync."
            ),
        )
    if test_status_changed:
        if not incoming.testOrder.statusUpdatedAt:
            raise HTTPException(
                status_code=409,
                detail="A test workflow transition requires a new governed status timestamp.",
            )
    elif incoming.testOrder.statusUpdatedAt != current.testOrder.statusUpdatedAt:
        raise HTTPException(
            status_code=409,
            detail="The test status timestamp changes only with a governed status transition.",
        )
    if current.testOrder.status != "prepared" and (
        incoming.testOrder.addressConfirmed != current.testOrder.addressConfirmed
        or incoming.testOrder.consent != current.testOrder.consent
    ):
        raise HTTPException(
            status_code=409,
            detail="Test-order delivery confirmation and consent lock when fulfilment begins.",
        )
    delivery_confirmation_changed = any(
        getattr(incoming.testOrder, field) != getattr(current.testOrder, field)
        for field in ("deliveryAddress", "deliveryPostcode", "confirmedAt")
    )
    ordering_transition = (
        current.testOrder.status == "prepared" and incoming.testOrder.status == "ordered"
    )
    if ordering_transition:
        if not (
            incoming.testOrder.deliveryAddress
            and incoming.testOrder.deliveryPostcode
            and incoming.testOrder.confirmedAt
            and incoming.testOrder.deliveryAddress == incoming.profile.address.strip()
            and incoming.testOrder.deliveryPostcode == incoming.profile.postcode.strip()
        ):
            raise HTTPException(
                status_code=409,
                detail=(
                    "Ordering requires a server-recorded immutable copy of the confirmed "
                    "delivery address, postcode and confirmation time."
                ),
            )
    elif delivery_confirmation_changed:
        raise HTTPException(
            status_code=409,
            detail=(
                "The order's confirmed delivery address, postcode and confirmation time are "
                "server-authored and immutable after ordering."
            ),
        )
    if current.testOrder.status == "prepared" and incoming.testOrder.status == "ordered":
        if not (
            incoming.testOrder.addressConfirmed
            and incoming.testOrder.consent
            and incoming.phaseConfirmed
            and incoming.phase in {"watch", "flare"}
            and has_eligible_test_order_evidence(incoming)
        ):
            raise HTTPException(
                status_code=409,
                detail=(
                    "Ordering requires confirmed evidence, an eligible support phase, address "
                    "confirmation and explicit test consent."
                ),
            )
    if incoming.testOrder.status in {"result", "shared"} and incoming.testOrder.result is None:
        raise HTTPException(
            status_code=409, detail="A result value is required for this test state."
        )
    result_changed = (
        incoming.testOrder.result != current.testOrder.result
        or incoming.testOrder.resultNote != current.testOrder.resultNote
    )
    if result_changed and not (
        current.testOrder.status == "lab"
        and incoming.testOrder.status == "result"
        and incoming.testOrder.result is not None
    ):
        raise HTTPException(
            status_code=409,
            detail=(
                "A laboratory result can only enter the record through the governed "
                "lab-to-result transition."
            ),
        )
    objective_result_transition = (
        current.testOrder.status == "lab"
        and incoming.testOrder.status == "result"
        and incoming.testOrder.result is not None
    )
    current_entries = {entry.id: entry for entry in current.entries}
    for entry in incoming.entries:
        previous = current_entries.get(entry.id)
        if previous is not None and previous.kind == "TEST RESULT" and previous.source == "care":
            # Objective care results are source records, not free-text journal notes. The only
            # in-place correction supported here is inclusion/exclusion; deletion is handled by
            # the explicit journal-delete path.
            previous_payload = previous.model_dump(mode="json")
            incoming_payload = entry.model_dump(mode="json")
            previous_payload["excluded"] = incoming_payload["excluded"]
            if incoming_payload != previous_payload:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "An objective care test result cannot be rewritten. Exclude or delete "
                        "the source record instead."
                    ),
                )
        became_test_result = entry.kind == "TEST RESULT" and (
            previous is None or previous.kind != "TEST RESULT"
        )
        if became_test_result and not (
            objective_result_transition
            and entry.source == "care"
            and not entry.excluded
            and entry.structured.get("calprotectin") == incoming.testOrder.result
        ):
            raise HTTPException(
                status_code=409,
                detail="Objective test evidence can only be created with the governed lab result.",
            )
        if (
            previous is not None
            and previous.kind == "TEST RESULT"
            and entry.kind == "TEST RESULT"
            and (
                entry.source != previous.source
                or entry.structured.get("calprotectin") != previous.structured.get("calprotectin")
            )
        ):
            raise HTTPException(
                status_code=409,
                detail=(
                    "The laboratory source and numeric result are immutable; exclude or "
                    "delete the source instead."
                ),
            )
    if objective_result_transition and not any(
        not entry.excluded
        and entry.kind == "TEST RESULT"
        and entry.source == "care"
        and entry.structured.get("calprotectin") == incoming.testOrder.result
        for entry in incoming.entries
    ):
        raise HTTPException(
            status_code=409,
            detail="The governed lab transition must create its matching journal evidence.",
        )

    current_experiment = current.experiment
    incoming_experiment = incoming.experiment
    governed_review_required = bool(
        incoming_experiment.reviewRequired
        or experiment_requires_review(incoming_experiment, incoming.profile)
    )
    if (
        experiment_requires_review(incoming_experiment, incoming.profile)
        and not incoming_experiment.reviewRequired
    ):
        raise HTTPException(
            status_code=409,
            detail="This candidate must retain its clinically governed review requirement.",
        )
    if bool(incoming_experiment.reviewApprovedAt) != bool(incoming_experiment.reviewApprovedBy):
        raise HTTPException(
            status_code=409,
            detail="A clinical review approval must retain both its timestamp and reviewer.",
        )
    if incoming_experiment.reviewApprovedAt and (
        not governed_review_required
        or incoming_experiment.reviewApprovedBy != SIMULATED_EXPERIMENT_REVIEWER
        or _eligible_experiment_review_thread(incoming, incoming_experiment) is None
    ):
        raise HTTPException(
            status_code=409,
            detail=(
                "Experiment approval requires a linked replied team thread that explicitly "
                "supports proceeding with this reviewed candidate."
            ),
        )
    if incoming_experiment.status == "active" and (
        incoming.phase != "stable"
        or not incoming.phaseConfirmed
        or incoming.pendingPhase is not None
    ):
        raise HTTPException(
            status_code=409,
            detail=(
                "A diet experiment can only be active while stable with no support-mode change "
                "under review."
            ),
        )
    if incoming_experiment.status == "active" and (
        not all(
            value.strip()
            for value in (
                incoming_experiment.title,
                incoming_experiment.variable,
                incoming_experiment.goal,
                incoming_experiment.baseline,
                incoming_experiment.outcome,
            )
        )
        or not _is_recorded_experiment_baseline(incoming_experiment.baseline)
    ):
        raise HTTPException(
            status_code=409,
            detail=(
                "An active experiment requires its variable, goal, an actually recorded "
                "pre-start baseline (not an instruction), and outcome."
            ),
        )
    if (
        incoming_experiment.status == "active"
        and governed_review_required
        and not incoming_experiment.reviewApprovedAt
    ):
        raise HTTPException(
            status_code=409,
            detail=(
                "This diet experiment requires a linked dietitian or IBD-team approval before "
                "starting."
            ),
        )
    if incoming_experiment.id != current_experiment.id:
        if (
            incoming_experiment.status != "suggested"
            or incoming_experiment.day != 0
            or incoming_experiment.startDate
            or incoming_experiment.observations
            or incoming_experiment.reviewRequestMessageId
            or incoming_experiment.reviewApprovedAt
            or incoming_experiment.reviewApprovedBy
        ):
            raise HTTPException(
                status_code=409,
                detail="A replacement experiment must begin as a new, unstarted candidate.",
            )
    else:
        incoming_timeline_observations = _experiment_timeline_observations(
            incoming, incoming_experiment.id
        )
        incoming_check_in_count = len(
            _experiment_check_in_dates(incoming, incoming_experiment.id)
        )
        incoming_completion_recorded = any(
            not entry.excluded
            and entry.kind == "LIFE EVENT"
            and entry.structured.get("experimentEvent") == "complete"
            and entry.structured.get("experimentId") == incoming_experiment.id
            for entry in incoming.entries
        )
        reopening_invalidated_completion = (
            current_experiment.status == "complete"
            and incoming_experiment.status == "paused"
            and (
                not incoming_completion_recorded
                or incoming_check_in_count < incoming_experiment.durationDays
            )
        )
        if (
            incoming_experiment.status not in EXPERIMENT_TRANSITIONS[current_experiment.status]
            and not reopening_invalidated_completion
        ):
            raise HTTPException(
                status_code=409,
                detail="The diet experiment must follow its governed status sequence.",
            )
        definition_changed = any(
            getattr(incoming_experiment, key) != getattr(current_experiment, key)
            for key in ("title", "variable", "goal", "baseline", "outcome", "durationDays")
        )
        if definition_changed and (
            current_experiment.status in {"active", "complete"}
            or current_experiment.day > 0
            or bool(current_experiment.startDate)
            or bool(current_experiment.observations)
        ):
            raise HTTPException(
                status_code=409,
                detail=(
                    "A started experiment’s predefined question is immutable. Replace it with a "
                    "new candidate so prior observations retain their original definition."
                ),
            )
        if definition_changed and (
            incoming_experiment.reviewRequestMessageId
            or incoming_experiment.reviewApprovedAt
            or incoming_experiment.reviewApprovedBy
        ):
            raise HTTPException(
                status_code=409,
                detail=(
                    "Editing the experiment definition invalidates its linked review request "
                    "and approval. Request review again for the revised candidate."
                ),
            )
        request_changed = (
            incoming_experiment.reviewRequestMessageId != current_experiment.reviewRequestMessageId
        )
        if request_changed and not definition_changed:
            request_message = (
                _experiment_review_request_message(
                    incoming, str(incoming_experiment.reviewRequestMessageId)
                )
                if incoming_experiment.reviewRequestMessageId
                else None
            )
            if (
                current_experiment.reviewRequestMessageId is not None
                or not governed_review_required
                or incoming_experiment.status not in {"suggested", "paused"}
                or request_message is None
            ):
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "A review request can be linked once to an eligible diet or experiment "
                        "team thread while the candidate is not active."
                    ),
                )
        approval_changed = (
            incoming_experiment.reviewApprovedAt != current_experiment.reviewApprovedAt
            or incoming_experiment.reviewApprovedBy != current_experiment.reviewApprovedBy
        )
        if approval_changed and not definition_changed:
            if (
                current_experiment.reviewApprovedAt is not None
                or not incoming_experiment.reviewApprovedAt
                or incoming_experiment.status not in {"suggested", "paused"}
                or incoming_experiment.reviewRequestMessageId
                != current_experiment.reviewRequestMessageId
                or _eligible_experiment_review_thread(incoming, incoming_experiment) is None
            ):
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "Only an eligible replied clinical-review thread can add one immutable "
                        "approval to the unchanged candidate."
                    ),
                )
            try:
                approval_time = datetime.fromisoformat(
                    incoming_experiment.reviewApprovedAt.replace("Z", "+00:00")
                )
                if approval_time.tzinfo is None:
                    raise ValueError
            except ValueError as exc:
                raise HTTPException(
                    status_code=409,
                    detail="The simulated approval timestamp must be a timezone-aware ISO value.",
                ) from exc
        if incoming_experiment.observations != incoming_timeline_observations:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Experiment conclusions and calendar day progress must exactly match their "
                    "included, correctable shared-timeline sources."
                ),
            )
        observations_append_only = incoming_experiment.observations[
            : len(current_experiment.observations)
        ] == current_experiment.observations
        added_observations = (
            incoming_experiment.observations[len(current_experiment.observations) :]
            if observations_append_only
            else []
        )
        day_change = incoming_experiment.day - current_experiment.day
        current_entry_ids = {entry.id for entry in current.entries}
        incoming_entries_by_id = {entry.id: entry for entry in incoming.entries}
        current_experiment_entries = [
            entry
            for entry in current.entries
            if entry.kind == "LIFE EVENT"
            and entry.structured.get("experimentEvent") in {"check-in", "complete"}
            and entry.structured.get("experimentId") == current_experiment.id
        ]
        experiment_history_changed = any(
            incoming_entries_by_id.get(entry.id) != entry for entry in current_experiment_entries
        )
        new_check_ins = [
            entry
            for entry in incoming.entries
            if entry.id not in current_entry_ids
            and entry.kind == "LIFE EVENT"
            and entry.structured.get("experimentEvent") == "check-in"
            and entry.structured.get("experimentId") == incoming_experiment.id
        ]
        current_check_in_dates = _experiment_check_in_dates(current, current_experiment.id)
        incoming_check_in_dates = _experiment_check_in_dates(incoming, incoming_experiment.id)
        if experiment_history_changed:
            for original_entry in current_experiment_entries:
                candidate_entry = incoming_entries_by_id.get(original_entry.id)
                if candidate_entry is None:
                    continue
                original_structured = dict(original_entry.structured)
                candidate_structured = dict(candidate_entry.structured)
                original_structured.pop("experimentObservation", None)
                candidate_structured.pop("experimentObservation", None)
                if (
                    candidate_entry.id != original_entry.id
                    or candidate_entry.kind != "LIFE EVENT"
                    or candidate_entry.source != original_entry.source
                    or candidate_structured != original_structured
                    or candidate_entry.photo != original_entry.photo
                ):
                    raise HTTPException(
                        status_code=409,
                        detail=(
                            "An experiment correction may change or delete the patient’s "
                            "observation, date, time or inclusion state, but not workflow "
                            "provenance."
                        ),
                    )
            if (
                new_check_ins
                or incoming_experiment.day != len(incoming_check_in_dates)
                or incoming_experiment.day > incoming_experiment.durationDays
            ):
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "Correcting experiment evidence must reconcile progress to the remaining "
                        "distinct shared-timeline dates without adding another check-in."
                    ),
                )
        elif day_change not in {0, 1} or (
            day_change == 1
            and (
                current_experiment.status != "active"
                or len(added_observations) != 1
                or len(new_check_ins) != 1
                or new_check_ins[0].date != _patient_date(current.profile).isoformat()
                or new_check_ins[0].structured.get("day") != incoming_experiment.day
                or _patient_date(current.profile).isoformat() in current_check_in_dates
                or len(incoming_check_in_dates) != len(current_check_in_dates) + 1
                or current_experiment.day != len(current_check_in_dates)
                or incoming_experiment.day != len(incoming_check_in_dates)
                or incoming_experiment.day > incoming_experiment.durationDays
            )
        ):
            raise HTTPException(
                status_code=409,
                detail=(
                    "Experiment progress advances through one new shared-timeline check-in per "
                    "calendar day."
                ),
            )
        if not experiment_history_changed and day_change == 0 and new_check_ins:
            raise HTTPException(
                status_code=409,
                detail="A dated experiment check-in must advance governed progress exactly once.",
            )
        if (
            incoming_experiment.status == "complete"
            and current_experiment.status != "complete"
            and (
                current_experiment.status != "active"
                or len(added_observations) != 1
                or current_experiment.day < current_experiment.durationDays
                or len(current_check_in_dates) < current_experiment.durationDays
                or len(incoming_check_in_dates) < incoming_experiment.durationDays
                or not any(
                    entry.id not in current_entry_ids
                    and entry.kind == "LIFE EVENT"
                    and entry.structured.get("experimentEvent") == "complete"
                    and entry.structured.get("experimentId") == current_experiment.id
                    and entry.structured.get("day") == current_experiment.day
                    for entry in incoming.entries
                )
            )
        ):
            raise HTTPException(
                status_code=409,
                detail=(
                    "Completing an experiment requires every configured distinct daily check-in "
                    "and an appended patient outcome review in the shared timeline."
                ),
            )
        if incoming_experiment.startDate != current_experiment.startDate and not (
            current_experiment.status == "suggested"
            and incoming_experiment.status == "active"
            and bool(incoming_experiment.startDate)
        ):
            raise HTTPException(
                status_code=409,
                detail="The experiment start date is set only when an unstarted candidate begins.",
            )

    collection_anchor = _is_collection_anchor_transition(current, incoming)
    current_schedule = [(day.day, day.doseMg, day.date) for day in current.taper.days]
    incoming_schedule = [(day.day, day.doseMg, day.date) for day in incoming.taper.days]
    if incoming_schedule != current_schedule and not collection_anchor:
        raise HTTPException(
            status_code=409,
            detail=(
                "The clinician-authored taper day, dose and date schedule is immutable through "
                "snapshot sync."
            ),
        )
    taper_actions_changed = (
        [day.taken for day in incoming.taper.days] != [day.taken for day in current.taper.days]
        or incoming.taper.missedDays != current.taper.missedDays
        or incoming.taper.snoozedUntil != current.taper.snoozedUntil
        or incoming.taper.checkInComplete != current.taper.checkInComplete
        or incoming.taper.sideEffects != current.taper.sideEffects
    )
    if taper_actions_changed and not _taper_actions_available(incoming):
        raise HTTPException(
            status_code=409,
            detail=(
                "Taper adherence actions cannot be synced before clinician-issued treatment is "
                "collected or governed Recovery support is confirmed."
            ),
        )
    verification_cleared = current.taper.verified and not incoming.taper.verified
    verification_added_without_schedule = (
        incoming.taper.verified and not current.taper.verified and not incoming.taper.days
    )
    if (
        (verification_cleared and not collection_anchor)
        or verification_added_without_schedule
        or incoming.taper.medicine != current.taper.medicine
        or incoming.taper.prescribedBy != current.taper.prescribedBy
    ):
        raise HTTPException(
            status_code=409,
            detail=(
                "The medicine and prescriber are clinician-authored, and a completed taper "
                "verification cannot be cleared."
            ),
        )
    calendar_day = _calendar_taper_day(
        incoming.taper.days, current.taper.currentDay, current.profile
    )
    exact_calendar_day = _exact_calendar_taper_day(incoming.taper.days, current.profile)
    expected_day = int(calendar_day.day) if calendar_day is not None else current.taper.currentDay
    if incoming.taper.currentDay not in {current.taper.currentDay, expected_day}:
        raise HTTPException(
            status_code=409,
            detail=(
                "The active taper day is derived from the clinician-authored calendar; an "
                "otherwise unchanged snapshot may retain the persisted focus until it is "
                "calendar-aligned."
            ),
        )
    newly_taken: list[int] = []
    reversed_taken: list[int] = []
    for current_day, incoming_day in zip(current.taper.days, incoming.taper.days, strict=True):
        if current_day.taken and not incoming_day.taken and not collection_anchor:
            reversed_taken.append(current_day.day)
        if not current_day.taken and incoming_day.taken:
            newly_taken.append(incoming_day.day)
    exact_day_number = (
        int(exact_calendar_day.day) if exact_calendar_day is not None else None
    )
    if len(newly_taken) > 1 or (
        newly_taken
        and (
            exact_day_number is None
            or newly_taken[0] != exact_day_number
            or incoming.taper.currentDay != exact_day_number
        )
    ):
        raise HTTPException(
            status_code=409,
            detail=(
                "Only the single verified taper dose scheduled for today’s exact "
                "patient-local date can be marked taken."
            ),
        )
    current_missed = set(current.taper.missedDays)
    incoming_missed = set(incoming.taper.missedDays)
    reversed_missed = sorted(current_missed - incoming_missed)
    newly_missed = sorted(incoming_missed - current_missed)
    scheduled_by_day = {day.day: day for day in incoming.taper.days}
    if len(newly_missed) > 1 or any(
        day_number not in scheduled_by_day
        or scheduled_by_day[day_number].taken
        or scheduled_by_day[day_number].date >= _patient_date(current.profile).isoformat()
        for day_number in newly_missed
    ):
        raise HTTPException(
            status_code=409,
            detail="Only one unresolved past taper dose can be reconciled as not taken at a time.",
        )
    current_entry_ids = {entry.id for entry in current.entries}
    for day_number in newly_missed:
        scheduled = scheduled_by_day[day_number]
        if not any(
            entry.id not in current_entry_ids
            and entry.kind == "MEDICATION"
            and entry.structured.get("taperDay") == day_number
            and entry.structured.get("taken") is False
            and entry.structured.get("scheduledDate") == scheduled.date
            and entry.structured.get("doseMg") == scheduled.doseMg
            for entry in incoming.entries
        ):
            raise HTTPException(
                status_code=409,
                detail=(
                    "A missed-dose reconciliation requires a matching dated medication "
                    "timeline record."
                ),
            )

    for day_number in newly_taken:
        scheduled = scheduled_by_day[day_number]
        if not any(
            entry.id not in current_entry_ids
            and entry.kind == "MEDICATION"
            and entry.source == "manual"
            and not entry.excluded
            and entry.structured.get("taperDay") == day_number
            and entry.structured.get("taken") is True
            and entry.structured.get("scheduledDate") == scheduled.date
            and entry.structured.get("doseMg") == scheduled.doseMg
            for entry in incoming.entries
        ):
            raise HTTPException(
                status_code=409,
                detail=(
                    "A taken-dose confirmation requires one new matching dated medication "
                    "timeline record from the governed taper action."
                ),
            )

    correction_entries = [
        entry
        for entry in incoming.entries
        if entry.id not in current_entry_ids and entry.structured.get("adherenceCorrection") is True
    ]
    reversals = [
        *(("taken", day_number) for day_number in reversed_taken),
        *(("missed", day_number) for day_number in reversed_missed),
    ]
    if collection_anchor:
        # Collection re-anchors a not-yet-started imported course and is validated separately.
        reversals = []
    if (
        len(reversals) > 1
        or (reversals and newly_taken)
        or len(correction_entries) != len(reversals)
    ):
        raise HTTPException(
            status_code=409,
            detail=(
                "A recorded adherence fact can only be reversed one at a time with one matching "
                "audited correction record."
            ),
        )
    incoming_entries_by_id = {entry.id: entry for entry in incoming.entries}
    current_entries_by_id = {entry.id: entry for entry in current.entries}
    reversal_set = set(reversals)
    for original in current.entries:
        adherence_record = _taper_adherence_record(original)
        if adherence_record is None:
            continue
        record_type, fact, day_number = adherence_record
        candidate = incoming_entries_by_id.get(original.id)
        if candidate is None:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Taper adherence sources and their audited corrections cannot be deleted "
                    "through generic snapshot sync."
                ),
            )
        if candidate == original:
            continue
        if record_type == "correction" or original.excluded:
            raise HTTPException(
                status_code=409,
                detail="An audited adherence correction and its excluded source are immutable.",
            )
        expected = original.model_dump(mode="json")
        expected["excluded"] = True
        if (fact, day_number) not in reversal_set or candidate.model_dump(mode="json") != expected:
            raise HTTPException(
                status_code=409,
                detail=(
                    "An adherence source can only be excluded by its matching explicit "
                    "marked-by-mistake reversal."
                ),
            )
    for fact, day_number in reversals:
        scheduled = scheduled_by_day.get(day_number)
        correction = correction_entries[0] if correction_entries else None
        if (
            scheduled is None
            or correction is None
            or not (
                correction.kind == "MEDICATION"
                and correction.source == "manual"
                and not correction.excluded
                and "marked" in correction.body.casefold()
                and "by mistake" in correction.body.casefold()
                and correction.structured.get("correctedFact") == fact
                and correction.structured.get("taperDay") == day_number
                and correction.structured.get("scheduledDate") == scheduled.date
                and correction.structured.get("doseMg") == scheduled.doseMg
            )
        ):
            raise HTTPException(
                status_code=409,
                detail=(
                    "The adherence reversal requires a matching included medication correction "
                    "record with the original schedule provenance."
                ),
            )
        matching_originals = [
            entry
            for entry in current.entries
            if entry.kind == "MEDICATION"
            and not entry.excluded
            and entry.structured.get("taperDay") == day_number
            and (
                (fact == "taken" and entry.structured.get("taken") is True)
                or (fact == "missed" and entry.structured.get("missed") is True)
            )
        ]
        if not matching_originals:
            raise HTTPException(
                status_code=409,
                detail="The adherence fact has no matching timeline source to correct.",
            )
        for original in matching_originals:
            candidate = incoming_entries_by_id.get(original.id)
            if candidate is None:
                raise HTTPException(
                    status_code=409,
                    detail="The original adherence source must be retained as excluded.",
                )
            expected = current_entries_by_id[original.id].model_dump(mode="json")
            expected["excluded"] = True
            if candidate.model_dump(mode="json") != expected:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "An adherence reversal may only exclude the original source; it cannot "
                        "rewrite its recorded wording or provenance."
                    ),
                )

    for entry in new_entries:
        reserved = PATIENT_JOURNAL_RESERVED_FIELDS.intersection(entry.structured)
        if not reserved:
            continue
        adherence = _taper_adherence_record(entry)
        governed_adherence = bool(
            adherence
            and (
                (adherence[1] == "taken" and adherence[2] in newly_taken)
                or (adherence[1] == "missed" and adherence[2] in newly_missed)
                or (
                    adherence[0] == "correction"
                    and (adherence[1], adherence[2]) in reversal_set
                )
            )
        )
        event = str(entry.structured.get("experimentEvent", ""))
        experiment_id = entry.structured.get("experimentId")
        governed_experiment = bool(
            entry.kind == "LIFE EVENT"
            and entry.source == "manual"
            and (
                (
                    event == "archived"
                    and incoming_experiment.id != current_experiment.id
                    and experiment_id == current_experiment.id
                )
                or (
                    event == "start"
                    and experiment_id == incoming_experiment.id
                    and incoming_experiment.status == "active"
                    and current_experiment.status in {"suggested", "paused"}
                )
                or (
                    event == "check-in"
                    and experiment_id == incoming_experiment.id
                    and incoming_experiment.day == current_experiment.day + 1
                    and incoming_experiment.status in {"active", "complete"}
                )
                or (
                    event == "complete"
                    and experiment_id == incoming_experiment.id
                    and current_experiment.status == "active"
                    and incoming_experiment.status == "complete"
                )
            )
        )
        governed_care = bool(
            objective_result_transition
            and entry.source == "care"
            and entry.kind == "TEST RESULT"
            and entry.structured.get("calprotectin") == incoming.testOrder.result
        )
        if not (governed_adherence or governed_experiment or governed_care):
            raise HTTPException(
                status_code=409,
                detail=(
                    "Taper, test and experiment provenance fields require the matching governed "
                    "workflow transition."
                ),
            )

    if (
        incoming.prescription.medicine != current.prescription.medicine
        or incoming.prescription.prescriber != current.prescription.prescriber
        or incoming.prescription.pharmacy != current.prescription.pharmacy
        or incoming.prescription.rescuePlanEligible != current.prescription.rescuePlanEligible
        or incoming.prescription.reviewAfterHours != current.prescription.reviewAfterHours
        or incoming.prescription.clinicalOwner != current.prescription.clinicalOwner
        or incoming.prescription.eligibilityRule != current.prescription.eligibilityRule
        or incoming.prescription.eligibilityReason != current.prescription.eligibilityReason
    ):
        # These fields are clinician-authored. A stale browser snapshot must not block an
        # otherwise valid patient workflow transition, and it must never overwrite them.
        incoming.prescription.medicine = current.prescription.medicine
        incoming.prescription.prescriber = current.prescription.prescriber
        incoming.prescription.pharmacy = current.prescription.pharmacy
        incoming.prescription.rescuePlanEligible = current.prescription.rescuePlanEligible
        incoming.prescription.reviewAfterHours = current.prescription.reviewAfterHours
        incoming.prescription.clinicalOwner = current.prescription.clinicalOwner
        incoming.prescription.eligibilityRule = current.prescription.eligibilityRule
        incoming.prescription.eligibilityReason = current.prescription.eligibilityReason

    treatment_time_changed = (
        incoming.prescription.treatmentStartedAt != current.prescription.treatmentStartedAt
    )
    collecting_transition = (
        current.prescription.status == "ready" and incoming.prescription.status == "collected"
    )
    if collecting_transition and not collection_anchor:
        raise HTTPException(
            status_code=409,
            detail=(
                "Collection must anchor the unchanged authorised taper to today, clear unissued "
                "adherence state and require patient verification again."
            ),
        )
    if treatment_time_changed and not (
        collecting_transition
        and _collection_timestamp_is_today(
            incoming.prescription.treatmentStartedAt, current.profile
        )
    ):
        raise HTTPException(
            status_code=409,
            detail="Treatment start time is recorded only when the patient collects it.",
        )
    if incoming.prescription.status == "collected" and not incoming.prescription.treatmentStartedAt:
        raise HTTPException(
            status_code=409,
            detail="Collected treatment requires a recorded collection/start time.",
        )

    _require_single_forward_step(
        "Prescription",
        current.prescription.status,
        incoming.prescription.status,
        PRESCRIPTION_STATES,
    )
    rescue_advancing = PRESCRIPTION_STATES.index(
        incoming.prescription.status
    ) > PRESCRIPTION_STATES.index(current.prescription.status)
    rescue_context = has_included_raised_test(incoming)
    requesting_rescue = (
        current.prescription.status == "prepared"
        and incoming.prescription.status == "requested"
    )
    if requesting_rescue and not (
        incoming.phase == "flare"
        and incoming.phaseConfirmed
        and incoming.pendingPhase is None
    ):
        raise HTTPException(
            status_code=409,
            detail=(
                "Submitting a rescue-prescription request requires confirmed Flare support "
                "with no unresolved lifecycle proposal."
            ),
        )
    if rescue_advancing and incoming.prescription.status not in {"prepared"}:
        if not incoming.prescription.rescuePlanEligible or not rescue_context:
            raise HTTPException(
                status_code=409,
                detail=(
                    "A rescue-prescription workflow needs documented eligibility plus established "
                    "flare context or objective evidence."
                ),
            )

    if (
        incoming.teamMessage.clinicalOwner != current.teamMessage.clinicalOwner
        or incoming.teamMessage.notificationRule != current.teamMessage.notificationRule
        or (
            incoming.teamMessage.id == current.teamMessage.id
            and incoming.teamMessage.notificationReason
            != current.teamMessage.notificationReason
        )
    ):
        raise HTTPException(
            status_code=409,
            detail=(
                "Clinician-notification ownership and governed rule provenance cannot be "
                "rewritten through snapshot sync."
            ),
        )
    if current.teamMessageStale and incoming.teamMessage.id == current.teamMessage.id:
        if incoming.teamMessage.status != "draft":
            raise HTTPException(
                status_code=409,
                detail=(
                    "A stale clinician-message draft must be refreshed and reviewed before it "
                    "can be sent."
                ),
            )
        if not incoming.teamMessageStale and (
            incoming.teamMessage.body != build_clinician_summary(incoming)
        ):
            raise HTTPException(
                status_code=409,
                detail=(
                    "Clearing the stale marker requires explicit regeneration from the "
                    "currently included records."
                ),
            )
    if incoming.teamMessage.id != current.teamMessage.id:
        if current.teamMessage.status != "replied":
            raise HTTPException(
                status_code=409,
                detail=(
                    "A follow-up draft can only be prepared after the current clinician "
                    "thread has received a reply."
                ),
            )
        if incoming.teamMessage.status != "draft":
            raise HTTPException(
                status_code=409,
                detail="A new clinician message must begin as a patient-reviewable draft.",
            )
        if incoming.teamMessage.reply is not None:
            raise HTTPException(
                status_code=409, detail="A new draft cannot already contain a reply."
            )
        if incoming.teamMessage.sentAt is not None:
            raise HTTPException(
                status_code=409,
                detail="A new unsent draft cannot have a send time.",
            )
        if (
            not incoming.teamMessage.statusUpdatedAt
        ):
            raise HTTPException(
                status_code=409,
                detail="A new clinician-message draft requires a new governed status timestamp.",
            )
        if incoming.teamMessageStale:
            raise HTTPException(
                status_code=409,
                detail="A newly prepared clinician-message draft cannot already be stale.",
            )
        expected_history = [current.teamMessage, *current.teamMessageHistory]
        if incoming.teamMessageHistory != expected_history:
            raise HTTPException(
                status_code=409,
                detail="The prior clinician message must remain intact in message history.",
            )
    else:
        if incoming.teamMessageHistory != current.teamMessageHistory:
            raise HTTPException(
                status_code=409,
                detail="Clinician-message history is append-only and cannot be rewritten.",
            )
        _require_single_forward_step(
            "Clinician message",
            current.teamMessage.status,
            incoming.teamMessage.status,
            MESSAGE_STATES,
        )
        message_status_changed = incoming.teamMessage.status != current.teamMessage.status
        if message_status_changed:
            if not incoming.teamMessage.statusUpdatedAt:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "A clinician-message transition requires a new governed status timestamp."
                    ),
                )
        elif incoming.teamMessage.statusUpdatedAt != current.teamMessage.statusUpdatedAt:
            raise HTTPException(
                status_code=409,
                detail=(
                    "The clinician-message status timestamp changes only with a governed "
                    "workflow transition."
                ),
            )
        sending_transition = (
            current.teamMessage.status == "draft" and incoming.teamMessage.status == "sent"
        )
        if sending_transition:
            if (
                incoming.teamMessage.notificationRule == "Not configured"
                or incoming.teamMessage.clinicalOwner.startswith("Not configured")
            ):
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "Clinician messaging requires a named owner and configured notification "
                        "rule before anything can be sent."
                    ),
                )
            if not incoming.teamMessage.sentAt or (
                incoming.teamMessage.sentAt != incoming.teamMessage.statusUpdatedAt
            ):
                raise HTTPException(
                    status_code=409,
                    detail="Sending requires one immutable send-time and status-time anchor.",
                )
        elif incoming.teamMessage.sentAt != current.teamMessage.sentAt:
            raise HTTPException(
                status_code=409,
                detail="The clinician-message send time is immutable.",
            )
        if current.teamMessage.status != "draft" and (
            incoming.teamMessage.subject != current.teamMessage.subject
            or incoming.teamMessage.body != current.teamMessage.body
            or incoming.teamMessage.expectedResponse != current.teamMessage.expectedResponse
        ):
            raise HTTPException(
                status_code=409,
                detail="Sent clinician-message content is immutable.",
            )
        if current.teamMessage.reply is not None and (
            incoming.teamMessage.reply != current.teamMessage.reply
        ):
            raise HTTPException(status_code=409, detail="A clinician reply is immutable.")
        if incoming.teamMessage.status != "replied" and (
            incoming.teamMessage.reply != current.teamMessage.reply
        ):
            raise HTTPException(
                status_code=409,
                detail="A reply can only be added with the replied workflow transition.",
            )
        if incoming.teamMessage.status == "replied" and not incoming.teamMessage.reply:
            raise HTTPException(status_code=422, detail="A replied message requires reply content.")
    if (
        incoming.teamMessage.status in {"sent", "read", "replied"}
        and not incoming.teamMessage.sentAt
    ):
        raise HTTPException(
            status_code=409,
            detail="A sent clinician message requires its immutable send-time anchor.",
        )
    if incoming.teamMessage.status != "draft" and not incoming.teamMessage.body.strip():
        raise HTTPException(status_code=422, detail="A sent clinician message cannot be empty.")

    derived_summary_changed = build_clinician_summary(current) != build_clinician_summary(incoming)
    if current.clinicianSummaryEdited and derived_summary_changed:
        if incoming.clinicianSummary != current.clinicianSummary:
            raise HTTPException(
                status_code=409,
                detail="A patient-edited summary must be preserved when its source records change.",
            )
        if not incoming.clinicianSummaryEdited or not incoming.clinicianSummaryStale:
            raise HTTPException(
                status_code=409,
                detail="A patient-edited summary must be marked stale when source records change.",
            )
    if incoming.clinicianSummaryStale and not incoming.clinicianSummaryEdited:
        raise HTTPException(
            status_code=409,
            detail="Only a preserved patient-edited summary can be marked stale.",
        )
    if (
        current.clinicianSummaryEdited
        and not incoming.clinicianSummaryEdited
        and incoming.clinicianSummary != build_clinician_summary(incoming)
    ):
        raise HTTPException(
            status_code=409,
            detail="A patient-edited summary can only leave edit mode through regeneration.",
        )
    if (
        incoming.clinicianSummary != current.clinicianSummary
        and not incoming.clinicianSummaryEdited
        and incoming.clinicianSummary != build_clinician_summary(incoming)
    ):
        raise HTTPException(
            status_code=409,
            detail="Regeneration must use the currently included records exactly.",
        )


def _snapshot_revision_provenance(
    current: DemoState, incoming: DemoState
) -> tuple[str, str, dict[str, Any]]:
    metadata: dict[str, Any] = {"transport": "validated-complete-snapshot"}
    if incoming.testOrder.status != current.testOrder.status:
        status_value = incoming.testOrder.status
        simulated = status_value in {"shipped", "delivered", "lab", "result"}
        action_prefix = "Simulation advanced" if simulated else "Patient confirmed"
        return (
            f"{action_prefix} test workflow to {status_value}",
            "fulfilment-simulation" if simulated else "patient",
            {**metadata, "resource": "test-order", "status": status_value},
        )
    if incoming.prescription.status != current.prescription.status:
        status_value = incoming.prescription.status
        actor = {
            "approved": "prescriber-simulation",
            "ready": "pharmacy-simulation",
        }.get(status_value, "patient")
        return (
            f"Prescription workflow advanced to {status_value}",
            actor,
            {**metadata, "resource": "prescription", "status": status_value},
        )
    if incoming.teamMessage.id != current.teamMessage.id:
        return (
            "Prepared a new patient-reviewable clinician-message draft",
            "patient",
            {**metadata, "resource": "team-message", "status": "draft"},
        )
    if incoming.teamMessage.status != current.teamMessage.status:
        status_value = incoming.teamMessage.status
        actor = "care-team-simulation" if status_value in {"read", "replied"} else "patient"
        return (
            f"Clinician-message workflow advanced to {status_value}",
            actor,
            {**metadata, "resource": "team-message", "status": status_value},
        )
    if current.teamMessageStale and not incoming.teamMessageStale:
        return (
            "Patient explicitly refreshed the clinician-message draft from included records",
            "patient",
            {**metadata, "resource": "team-message", "status": "refreshed"},
        )
    reversed_taken = [
        day.day
        for day in current.taper.days
        if day.taken
        and not next((item.taken for item in incoming.taper.days if item.day == day.day), False)
    ]
    reversed_missed = sorted(set(current.taper.missedDays) - set(incoming.taper.missedDays))
    if (reversed_taken or reversed_missed) and not _is_collection_anchor_transition(
        current, incoming
    ):
        day_number = (reversed_taken or reversed_missed)[0]
        fact = "taken" if reversed_taken else "missed"
        return (
            f"Patient retracted taper day {day_number} {fact} adherence fact as marked by mistake",
            "patient",
            {
                **metadata,
                "resource": "taper-adherence-correction",
                "day": day_number,
                "correctedFact": fact,
            },
        )
    newly_taken = [
        day.day
        for day in incoming.taper.days
        if day.taken
        and not next((item.taken for item in current.taper.days if item.day == day.day), False)
    ]
    if newly_taken:
        return (
            f"Patient confirmed prescribed taper day {newly_taken[0]} as taken",
            "patient",
            {**metadata, "resource": "taper-adherence", "day": newly_taken[0]},
        )
    newly_missed = sorted(set(incoming.taper.missedDays) - set(current.taper.missedDays))
    if newly_missed:
        return (
            f"Patient reconciled prescribed taper day {newly_missed[0]} as not taken",
            "patient",
            {**metadata, "resource": "taper-adherence", "day": newly_missed[0], "taken": False},
        )
    if incoming.experiment.reviewApprovedAt != current.experiment.reviewApprovedAt:
        approval_added = bool(incoming.experiment.reviewApprovedAt)
        return (
            (
                "Simulation recorded clinical-team approval for the unchanged diet experiment"
                if approval_added
                else "Patient revised the diet experiment and invalidated its prior approval"
            ),
            "clinical-messaging-simulation" if approval_added else "patient",
            {
                **metadata,
                "resource": "diet-experiment-review",
                "experimentId": incoming.experiment.id,
                "reviewer": (
                    incoming.experiment.reviewApprovedBy
                    if approval_added
                    else current.experiment.reviewApprovedBy
                ),
            },
        )
    if incoming.experiment.reviewRequestMessageId != current.experiment.reviewRequestMessageId:
        return (
            "Patient linked the diet experiment to a clinical-review thread",
            "patient",
            {
                **metadata,
                "resource": "diet-experiment-review",
                "experimentId": incoming.experiment.id,
            },
        )
    if incoming.experiment.status != current.experiment.status:
        return (
            f"Diet experiment workflow changed to {incoming.experiment.status}",
            "patient",
            {
                **metadata,
                "resource": "diet-experiment",
                "experimentId": incoming.experiment.id,
                "status": incoming.experiment.status,
            },
        )
    if incoming.experiment.day != current.experiment.day:
        return (
            f"Patient recorded diet experiment day {incoming.experiment.day}",
            "patient",
            {
                **metadata,
                "resource": "diet-experiment",
                "experimentId": incoming.experiment.id,
                "day": incoming.experiment.day,
            },
        )
    if incoming.phase != current.phase:
        return (
            f"Patient changed support presentation to {incoming.phase}",
            "patient",
            {**metadata, "resource": "lifecycle", "phase": incoming.phase},
        )
    if len(incoming.entries) != len(current.entries):
        return (
            "Patient changed journal records and refreshed derived evidence",
            "patient",
            {**metadata, "resource": "journal"},
        )
    return "Synced a complete validated demo snapshot", "patient", metadata


@router.get("/demo", response_model=DemoState)
def get_demo(response: Response, store: Store) -> DemoState:
    state, revision = store.get_with_revision()
    response.headers["ETag"] = _etag(revision)
    response.headers["X-State-Revision"] = str(revision)
    return state


def run_evening_background(
    store: SQLiteDemoStore, instant: datetime | None = None
) -> tuple[bool, DemoState]:
    """Prepare at most one unsent flare update per patient-local evening.

    This is shared by the authenticated endpoint and the API-process scheduler. It
    deliberately never sends a message and never overwrites an unreviewed draft.
    """

    current = store.get()
    _require_tracking_consent(current.profile)
    now = _patient_now(current.profile, instant or _background_now())
    day = now.date().isoformat()
    draft_id = f"EVENING-{day}"
    unresolved_review = (
        current.teamMessage.status in {"sent", "read"}
        and current.experiment.reviewRequestMessageId == current.teamMessage.id
        and not current.experiment.reviewApprovedAt
    )
    if (
        current.phase != "flare"
        or not current.phaseConfirmed
        or current.pendingPhase is not None
        or now.hour < 18
        or current.teamMessage.status != "replied"
        or current.teamMessage.id == draft_id
        or unresolved_review
    ):
        return False, current

    created = {"value": False}

    def apply(state: dict[str, Any]) -> None:
        _require_tracking_consent(state["profile"])
        local_now = _patient_now(state["profile"], instant or _background_now())
        local_day = local_now.date().isoformat()
        local_draft_id = f"EVENING-{local_day}"
        unresolved_review = (
            state["teamMessage"]["status"] in {"sent", "read"}
            and state["experiment"].get("reviewRequestMessageId")
            == state["teamMessage"]["id"]
            and not state["experiment"].get("reviewApprovedAt")
        )
        if (
            state["phase"] != "flare"
            or not state["phaseConfirmed"]
            or state.get("pendingPhase") is not None
            or local_now.hour < 18
            or state["teamMessage"]["status"] != "replied"
            or state["teamMessage"]["id"] == local_draft_id
            or unresolved_review
        ):
            return
        previous = dict(state["teamMessage"])
        regenerated_body = build_clinician_summary(DemoState.model_validate(state))
        if not any(item.get("id") == previous.get("id") for item in state["teamMessageHistory"]):
            state["teamMessageHistory"].insert(0, previous)
        _, _, created_at = _now_parts()
        state["teamMessage"] = {
            "id": local_draft_id,
            "subject": (
                f"Evening flare update from {state['profile'].get('name') or 'Gutsy patient'}"
            ),
            "body": regenerated_body,
            "status": "draft",
            "sentAt": None,
            "statusUpdatedAt": created_at,
            "clinicalOwner": previous.get("clinicalOwner", "Not configured"),
            "notificationRule": previous.get("notificationRule", "Not configured"),
            "notificationReason": (
                "Phase-specific evening follow-up prepared from the current clinician-ready "
                "summary after the prior thread became archivable; patient review is still "
                "required before send."
            ),
            "expectedResponse": previous.get("expectedResponse", "Within one working day"),
        }
        state["teamMessageStale"] = False
        created["value"] = True

    saved, _ = store.mutate(
        apply,
        (
            "Background agent prepared the next editable patient-local evening flare update; "
            "the prior replied message was preserved and nothing was sent"
        ),
        actor="bounded-background-agent",
    )
    return created["value"], saved


@router.post("/background/run")
def run_bounded_background_work(
    store: Store,
    gutsy_reminders_suspended: Annotated[
        str | None, Cookie(alias=REMINDER_SUPPRESSION_COOKIE)
    ] = None,
) -> dict[str, bool]:
    """Run consent-bound, idempotent work that a service worker may request off-page."""

    if gutsy_reminders_suspended is not None:
        return {"created": False}
    created, _ = run_evening_background(store)
    return {"created": created}


@router.get("/reminders/current", response_model=None)
def get_current_background_reminder(
    store: Store,
    gutsy_reminders_suspended: Annotated[
        str | None, Cookie(alias=REMINDER_SUPPRESSION_COOKIE)
    ] = None,
) -> JSONResponse | Response:
    """Return only the already-approved notification payload needed by the worker."""

    if gutsy_reminders_suspended is not None:
        return Response(status_code=204, headers={"Cache-Control": "no-store"})
    reminder = current_background_reminder(store.get(), _background_now())
    if reminder is None:
        return Response(status_code=204)
    return JSONResponse(reminder, headers={"Cache-Control": "no-store"})


@router.put("/demo", response_model=DemoState)
def replace_demo_snapshot(
    snapshot: DemoState,
    response: Response,
    store: Store,
    if_match: Annotated[str | None, Header(alias="If-Match")] = None,
) -> DemoState:
    expected_revision = _parse_etag(if_match)
    current, current_revision = store.get_with_revision()
    if current_revision != expected_revision:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Expected revision {expected_revision}, but the current revision is "
                f"{current_revision}."
            ),
        )
    snapshot = snapshot.model_copy(
        update={
            "profile": _server_authored_consent_profile(current.profile, snapshot.profile)
        }
    )
    # Complete-snapshot clients describe workflow intent, but status clocks are server-authored.
    # This keeps reminder deadlines and care-pathway provenance independent of the browser clock.
    _, _, workflow_at = _now_parts()
    snapshot = snapshot.model_copy(
        update={
            "testOrder": snapshot.testOrder.model_copy(
                update={
                    "statusUpdatedAt": (
                        workflow_at
                        if snapshot.testOrder.status != current.testOrder.status
                        else current.testOrder.statusUpdatedAt
                    ),
                    "deliveryAddress": (
                        snapshot.profile.address.strip()
                        if (
                            current.testOrder.status == "prepared"
                            and snapshot.testOrder.status == "ordered"
                        )
                        else snapshot.testOrder.deliveryAddress
                    ),
                    "deliveryPostcode": (
                        snapshot.profile.postcode.strip()
                        if (
                            current.testOrder.status == "prepared"
                            and snapshot.testOrder.status == "ordered"
                        )
                        else snapshot.testOrder.deliveryPostcode
                    ),
                    "confirmedAt": (
                        workflow_at
                        if (
                            current.testOrder.status == "prepared"
                            and snapshot.testOrder.status == "ordered"
                        )
                        else snapshot.testOrder.confirmedAt
                    ),
                }
            ),
            "teamMessage": snapshot.teamMessage.model_copy(
                update={
                    "statusUpdatedAt": (
                        workflow_at
                        if (
                            snapshot.teamMessage.id != current.teamMessage.id
                            or snapshot.teamMessage.status != current.teamMessage.status
                        )
                        else current.teamMessage.statusUpdatedAt
                    ),
                    "sentAt": (
                        None
                        if snapshot.teamMessage.id != current.teamMessage.id
                        else (
                            workflow_at
                            if (
                                current.teamMessage.status == "draft"
                                and snapshot.teamMessage.status == "sent"
                            )
                            else current.teamMessage.sentAt
                        )
                    ),
                    "notificationReason": (
                        (
                            "Phase-specific evening follow-up prepared from the current "
                            "clinician-ready summary after the prior thread became archivable; "
                            "patient review is still required before send."
                            if snapshot.teamMessage.id.startswith("EVENING-")
                            else (
                                "Patient explicitly prepared a follow-up draft from currently "
                                "included records; nothing is sent until every word is reviewed."
                            )
                        )
                        if snapshot.teamMessage.id != current.teamMessage.id
                        else current.teamMessage.notificationReason
                    ),
                }
            ),
        }
    )
    # Backward-compatible complete-snapshot clients may not yet send the edit marker. A
    # non-derived summary-only change is still an explicit patient edit; automatic derived
    # changes remain unmarked and are validated below.
    if (
        snapshot.clinicianSummary != current.clinicianSummary
        and not snapshot.clinicianSummaryEdited
        and snapshot.clinicianSummary != build_clinician_summary(snapshot)
        and (
            not current.clinicianSummaryEdited
            or build_clinician_summary(current) == build_clinician_summary(snapshot)
        )
    ):
        snapshot = snapshot.model_copy(
            update={"clinicianSummaryEdited": True, "clinicianSummaryStale": False}
        )
    draft_sources_changed = _team_message_source_fingerprint(
        current
    ) != _team_message_source_fingerprint(snapshot)
    if (
        current.teamMessage.status == "draft"
        and snapshot.teamMessage.id == current.teamMessage.id
        and draft_sources_changed
    ):
        if snapshot.teamMessage.status != "draft":
            raise HTTPException(
                status_code=409,
                detail=(
                    "Included records changed after the clinician-message draft was prepared. "
                    "Refresh and review it before sending."
                ),
            )
        if snapshot.teamMessage.body != current.teamMessage.body:
            raise HTTPException(
                status_code=409,
                detail=(
                    "A source-record change must preserve the patient-edited clinician-message "
                    "draft until refresh is explicitly requested."
                ),
            )
        snapshot = snapshot.model_copy(update={"teamMessageStale": True})
    elif (
        current.teamMessageStale
        and not snapshot.teamMessageStale
        and snapshot.teamMessage.id == current.teamMessage.id
        and snapshot.teamMessage.body == current.teamMessage.body
    ):
        # A browser that has not yet rehydrated the server-owned stale marker cannot silently
        # clear it by sending an otherwise unchanged draft.
        snapshot = snapshot.model_copy(update={"teamMessageStale": True})
    snapshot = _server_authored_snapshot_safety(current, snapshot)
    _validate_snapshot_transition(current, snapshot)
    snapshot = _server_authored_snapshot_conversation(current, snapshot)
    revision_action, revision_actor, revision_metadata = _snapshot_revision_provenance(
        current, snapshot
    )
    incoming = snapshot.model_dump(mode="json", by_alias=True)
    current_audit = {event.id: event.model_dump(mode="json") for event in current.audit}
    incoming_audit = {event.id: event.model_dump(mode="json") for event in snapshot.audit}
    # The browser may append patient-visible events, but it cannot erase or rewrite events
    # already committed by the API. The append-only domain_revisions table remains canonical.
    incoming["audit"] = sorted(
        {**incoming_audit, **current_audit}.values(),
        key=lambda event: int(event["id"]),
        reverse=True,
    )

    def apply(state: dict[str, Any]) -> None:
        state.clear()
        state.update(incoming)

    try:
        saved, _, revision = store.mutate_with_revision(
            apply,
            revision_action,
            actor=revision_actor,
            expected_version=expected_revision,
            metadata=revision_metadata,
        )
    except VersionConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    # A complete aggregate replacement can correct or delete any sensitive text or media.
    # Compact every accepted snapshot so the superseded JSON cannot remain in SQLite/WAL pages.
    store.purge_deleted_payload_bytes()
    response.headers["ETag"] = _etag(revision)
    response.headers["X-State-Revision"] = str(revision)
    return saved


@router.post("/demo/reset", response_model=DemoState)
def reset_demo(response: Response, store: Store) -> DemoState:
    state, revision = store.reset_with_revision()
    response.headers["ETag"] = _etag(revision)
    response.headers["X-State-Revision"] = str(revision)
    return state


@router.post("/demo/phase", response_model=DemoState)
def switch_demo_phase(payload: PhaseInput, store: Store) -> DemoState:
    # Presentation scenarios belong to the client shell. Retaining this compatibility endpoint
    # as a read-only no-op ensures an old demo selector cannot rewrite governed clinical state.
    del payload
    return store.get()


@router.get("/profile", response_model=Profile)
def get_profile(store: Store) -> Profile:
    return store.get().profile


@router.patch("/profile", response_model=Profile)
def update_profile(payload: ProfilePatch, store: Store) -> Profile:
    patch = payload.model_dump(exclude_none=True)
    # These fields are evidence of the server-observed transition, never caller assertions.
    patch.pop("consentVersion", None)
    patch.pop("consentRecordedAt", None)
    if patch.get("healthDataConsent") is False or patch.get("adultEligibilityConfirmed") is False:
        patch["onboardingComplete"] = False
    current_state, expected_revision = store.get_with_revision()
    candidate = current_state.profile.model_dump(mode="json")
    candidate.update(patch)
    if candidate.get("onboardingComplete") and not any(
        contact.name.strip() and contact.role.strip() and contact.phone.strip()
        for contact in current_state.contacts
    ):
        raise HTTPException(
            status_code=422,
            detail=(
                "Add at least one named clinical contact with a phone route before completing "
                "onboarding."
            ),
        )
    try:
        Profile.model_validate(candidate)
    except ValidationError as error:
        raise HTTPException(status_code=422, detail=error.errors()[0]["msg"]) from error
    def apply(state: dict[str, Any]) -> None:
        current_profile = Profile.model_validate(state["profile"])
        candidate_data = current_profile.model_dump(mode="json")
        candidate_data.update(patch)
        try:
            candidate_profile = Profile.model_validate(candidate_data)
        except ValidationError as error:
            raise HTTPException(status_code=422, detail=error.errors()[0]["msg"]) from error
        if candidate_profile.onboardingComplete and not any(
            contact.get("name", "").strip()
            and contact.get("role", "").strip()
            and contact.get("phone", "").strip()
            for contact in state["contacts"]
        ):
            raise HTTPException(
                status_code=422,
                detail=(
                    "Add at least one named clinical contact with a phone route before "
                    "completing onboarding."
                ),
            )
        baseline_changed = any(
            field in patch and patch[field] != getattr(current_profile, field)
            for field in BASELINE_FIELDS
        )
        state["profile"] = _server_authored_consent_profile(
            current_profile, candidate_profile
        ).model_dump(mode="json")
        if not _tracking_is_active(state["profile"]):
            _revoke_consent_bound_access(state)
        if baseline_changed:
            _recompute_lifecycle_after_baseline_change(state)
        _refresh_clinician_summary(state)

    action = "Updated patient profile and history"
    if not _tracking_is_active(candidate):
        action += "; paused tracking and disconnected wearable ingestion"
    try:
        state, _ = store.mutate(apply, action, expected_version=expected_revision)
    except VersionConflictError as error:
        raise HTTPException(
            status_code=409,
            detail=(
                "The patient record changed while this profile update was being saved. Reload "
                "the current profile and retry."
            ),
        ) from error
    store.purge_deleted_payload_bytes()
    return state.profile


@router.get("/profile/proposals", response_model=list[ProfileProposal])
def list_profile_proposals(store: Store) -> list[ProfileProposal]:
    return store.get().profileProposals


@router.patch("/profile/proposals/{proposal_id}", response_model=ProfileProposal)
def resolve_profile_proposal(
    proposal_id: int, payload: ProfileProposalResolution, store: Store
) -> ProfileProposal:
    current = store.get()
    proposal = next((item for item in current.profileProposals if item.id == proposal_id), None)
    if proposal is None:
        raise HTTPException(status_code=404, detail="PMH proposal not found.")
    if proposal.status != "pending":
        raise HTTPException(status_code=409, detail="This PMH proposal has already been reviewed.")

    def apply(state: dict[str, Any]) -> None:
        target = next(item for item in state["profileProposals"] if item["id"] == proposal_id)
        if payload.status == "accepted":
            field = target["field"]
            existing = str(state["profile"][field]).strip()
            value = str(target["value"])
            if value.casefold() not in existing.casefold():
                state["profile"][field] = f"{existing}{'; ' if existing else ''}{value}"
            _refresh_clinician_summary(state)
        target["status"] = payload.status

    state, _ = store.mutate(
        apply,
        (
            "Patient accepted a conversation-derived PMH proposal"
            if payload.status == "accepted"
            else "Patient dismissed a conversation-derived PMH proposal without changing profile"
        ),
    )
    return next(item for item in state.profileProposals if item.id == proposal_id)


@router.get("/profile/history")
def get_history(store: Store) -> list[dict[str, str]]:
    profile = store.get().profile.model_dump()
    return [{"field": field, "value": str(profile[field])} for field in sorted(HISTORY_FIELDS)]


@router.put("/profile/history/{field_name}")
def update_history(field_name: str, payload: HistoryValue, store: Store) -> dict[str, str]:
    if field_name not in HISTORY_FIELDS:
        raise HTTPException(status_code=404, detail="Past-medical-history field not found.")

    def apply(state: dict[str, Any]) -> None:
        state["profile"][field_name] = payload.value
        _refresh_clinician_summary(state)

    store.mutate(apply, f"Updated history field {field_name}")
    store.purge_deleted_payload_bytes()
    return {"field": field_name, "value": payload.value}


@router.delete("/profile/history/{field_name}", status_code=204)
def delete_history(field_name: str, store: Store) -> Response:
    if field_name not in HISTORY_FIELDS:
        raise HTTPException(status_code=404, detail="Past-medical-history field not found.")

    def apply(state: dict[str, Any]) -> None:
        state["profile"][field_name] = ""
        _refresh_clinician_summary(state)

    store.mutate(apply, f"Deleted history field {field_name}")
    store.purge_deleted_payload_bytes()
    return Response(status_code=204)


@router.get("/contacts", response_model=list[CareContact])
def list_contacts(store: Store) -> list[CareContact]:
    return store.get().contacts


@router.post("/contacts", response_model=CareContact, status_code=201)
def create_contact(payload: CareContactCreate, store: Store) -> CareContact:
    contact = payload.model_dump()

    def apply(state: dict[str, Any]) -> None:
        if any(item["id"] == payload.id for item in state["contacts"]):
            raise HTTPException(status_code=409, detail="A contact with this id already exists.")
        state["contacts"].append(contact)

    state, _ = store.mutate(apply, f"Added care contact {payload.id}")
    return next(item for item in state.contacts if item.id == payload.id)


@router.patch("/contacts/{contact_id}", response_model=CareContact)
def update_contact(contact_id: str, payload: CareContactPatch, store: Store) -> CareContact:
    patch = payload.model_dump(exclude_none=True)

    def apply(state: dict[str, Any]) -> None:
        _patch(_contact(state, contact_id), patch)

    state, _ = store.mutate(apply, f"Updated care contact {contact_id}")
    store.purge_deleted_payload_bytes()
    return next(item for item in state.contacts if item.id == contact_id)


@router.delete("/contacts/{contact_id}", status_code=204)
def delete_contact(contact_id: str, store: Store) -> Response:
    current = store.get()
    remaining = [contact for contact in current.contacts if contact.id != contact_id]
    if current.profile.onboardingComplete and not any(
        contact.name.strip() and contact.role.strip() and contact.phone.strip()
        for contact in remaining
    ):
        raise HTTPException(
            status_code=409,
            detail="Keep at least one named clinical phone route while onboarding is active.",
        )

    def apply(state: dict[str, Any]) -> None:
        _contact(state, contact_id)
        state["contacts"] = [item for item in state["contacts"] if item["id"] != contact_id]

    store.mutate(apply, f"Deleted care contact {contact_id}")
    store.purge_deleted_payload_bytes()
    return Response(status_code=204)


@router.get("/trusted-supporter", response_model=TrustedSupporter)
def get_trusted_supporter(store: Store) -> TrustedSupporter:
    return store.get().trustedSupporter


def _supporter_with_access(state: DemoState, access_code: str) -> TrustedSupporter:
    supporter = state.trustedSupporter
    if not _tracking_is_active(state.profile) or not supporter.enabled or not supporter.accessCode:
        raise HTTPException(status_code=403, detail="This supporter access is not active.")
    if not secrets.compare_digest(supporter.accessCode, access_code.strip()):
        raise HTTPException(status_code=403, detail="This supporter access is not active.")
    return supporter


def _supporter_scoped_view(state: DemoState, access_code: str) -> SupporterView:
    supporter = _supporter_with_access(state, access_code)
    reminders: list[str] | None = None
    if supporter.canSeeReminders:
        reminders = []
        patient_today = _patient_date(state.profile).isoformat()
        scheduled = next((day for day in state.taper.days if day.date == patient_today), None)
        if state.taper.verified and scheduled is not None and not scheduled.taken:
            reminders.append("Today’s medicine check-in is still pending.")
        if state.testOrder.status not in {"prepared", "shared"}:
            reminders.append(
                f"The home-test workflow is currently marked {state.testOrder.status}."
            )
        if not reminders:
            reminders.append("There are no pending demo reminders currently visible to you.")
    reviewable_logs = (
        sorted(
            (entry for entry in state.entries if entry.source == "supporter"),
            key=lambda item: (item.date, item.time, item.id),
            reverse=True,
        )[:10]
        if supporter.canHelpLog
        else None
    )
    return SupporterView(
        patientFirstName=state.profile.name.strip().split(" ")[0] or "the patient",
        supporterName=supporter.name,
        relationship=supporter.relationship,
        permissions={
            "canViewSummary": supporter.canViewSummary,
            "canSeeReminders": supporter.canSeeReminders,
            "canHelpLog": supporter.canHelpLog,
        },
        summary=state.clinicianSummary if supporter.canViewSummary else None,
        reminders=reminders,
        reviewableLogs=reviewable_logs,
        notice=(
            "Transparent simulation only: no invitation was delivered and this view cannot "
            "order tests, message clinicians, change medicines or approve care. Supporter logs "
            "stay excluded until the patient reviews and includes them."
        ),
    )


@router.patch("/trusted-supporter", response_model=TrustedSupporter)
def update_trusted_supporter(payload: TrustedSupporterPatch, store: Store) -> TrustedSupporter:
    patch = payload.model_dump(exclude_none=True)

    expands_access = any(
        patch.get(key) is True
        for key in ("enabled", "canViewSummary", "canSeeReminders", "canHelpLog")
    )
    if expands_access:
        _require_tracking_consent(store.get().profile)

    def apply(state: dict[str, Any]) -> None:
        if expands_access:
            _require_tracking_consent(state["profile"])
        supporter = state["trustedSupporter"]
        _patch(supporter, patch)
        if supporter["enabled"]:
            if not supporter["name"].strip() or not supporter["relationship"].strip():
                raise HTTPException(
                    status_code=422,
                    detail="An enabled supporter needs a name and relationship.",
                )
            if not any(
                supporter[key] for key in ("canViewSummary", "canSeeReminders", "canHelpLog")
            ):
                raise HTTPException(
                    status_code=422,
                    detail="Select at least one explicit supporter permission.",
                )
        else:
            supporter.update(
                {
                    "canViewSummary": False,
                    "canSeeReminders": False,
                    "canHelpLog": False,
                    "accessCode": None,
                    "accessCreatedAt": None,
                }
            )

    state, _ = store.mutate(apply, "Updated tightly scoped trusted-supporter access")
    store.purge_deleted_payload_bytes()
    return state.trustedSupporter


@router.post("/trusted-supporter/invitation", response_model=TrustedSupporter)
def create_trusted_supporter_invitation(response: Response, store: Store) -> TrustedSupporter:
    current = store.get()
    _require_tracking_consent(current.profile)
    supporter = current.trustedSupporter
    if not supporter.enabled:
        raise HTTPException(status_code=409, detail="Enable scoped supporter access first.")
    if not supporter.name.strip() or not supporter.relationship.strip() or not any(
        (supporter.canViewSummary, supporter.canSeeReminders, supporter.canHelpLog)
    ):
        raise HTTPException(
            status_code=409,
            detail="Save a named supporter and at least one permission before creating a code.",
        )
    access_code = secrets.token_urlsafe(9).replace("-", "A").replace("_", "B")

    def apply(state: dict[str, Any]) -> None:
        _require_tracking_consent(state["profile"])
        if not state["trustedSupporter"]["enabled"]:
            raise HTTPException(status_code=409, detail="Supporter access was disabled.")
        state["trustedSupporter"].update(
            {"accessCode": access_code, "accessCreatedAt": utc_now()}
        )

    state, _, revision = store.mutate_with_revision(
        apply,
        "Generated a revocable trusted-supporter demo access code; no invitation was delivered",
        actor="patient",
        metadata={"resource": "trusted-supporter", "delivery": "simulation-only"},
    )
    response.headers["ETag"] = _etag(revision)
    return state.trustedSupporter


@router.delete("/trusted-supporter/invitation", response_model=TrustedSupporter)
def revoke_trusted_supporter_invitation(response: Response, store: Store) -> TrustedSupporter:
    def apply(state: dict[str, Any]) -> None:
        state["trustedSupporter"].update({"accessCode": None, "accessCreatedAt": None})

    state, _, revision = store.mutate_with_revision(
        apply,
        "Revoked the trusted-supporter demo access code",
        actor="patient",
        metadata={"resource": "trusted-supporter", "access": "revoked"},
    )
    response.headers["ETag"] = _etag(revision)
    store.purge_deleted_payload_bytes()
    return state.trustedSupporter


@router.post(
    "/trusted-supporter/access",
    response_model=SupporterView,
    response_model_exclude_none=True,
)
def get_trusted_supporter_view(payload: SupporterAccessInput, store: Store) -> SupporterView:
    return _supporter_scoped_view(store.get(), payload.accessCode)


@router.post(
    "/trusted-supporter/log",
    response_model=SupporterLogResult,
    response_model_exclude_none=True,
)
def create_trusted_supporter_log(
    payload: SupporterLogInput, response: Response, store: Store
) -> SupporterLogResult:
    current, expected_revision = store.get_with_revision()
    supporter = _supporter_with_access(current, payload.accessCode)
    if not supporter.canHelpLog:
        raise HTTPException(status_code=403, detail="This supporter cannot create reviewable logs.")
    capture = parse_capture(payload.text)
    if not capture.entries:
        raise HTTPException(
            status_code=422,
            detail="Describe a concrete meal, symptom or wellbeing observation for patient review.",
        )
    day, clock, _ = _now_parts(current.profile)
    next_id = max((entry.id for entry in current.entries), default=0) + 1
    entries: list[JournalEntry] = []
    evaluations: list[SafetyEvaluation] = []
    for draft in capture.entries[:5]:
        if draft.kind == "TEST RESULT":
            continue
        structured = {
            **draft.structured,
            "supporterName": supporter.name,
            "supporterRelationship": supporter.relationship,
            "supporterReviewStatus": "needs patient review",
        }
        candidate = JournalEntry.model_validate(
            {
                **draft.model_dump(mode="json", exclude_none=True),
                "id": next_id,
                "date": draft.date or day,
                "time": draft.time or clock,
                "source": "supporter",
                "flagged": False,
                "excluded": True,
                "structured": structured,
                "photo": None,
            }
        )
        candidate.flagged = derive_entry_flagged(candidate, current.profile)
        entries.append(candidate)
        evaluations.append(evaluate_safety(_safety_input_with_body(candidate), current.profile))
        next_id += 1
    if not entries:
        raise HTTPException(status_code=422, detail="No reviewable supporter log was created.")
    urgent = [evaluation for evaluation in evaluations if evaluation.urgent]

    def apply(state: dict[str, Any]) -> None:
        live_supporter = _supporter_with_access(
            DemoState.model_validate(state), payload.accessCode
        )
        if not live_supporter.canHelpLog:
            raise HTTPException(
                status_code=403, detail="This supporter can no longer create reviewable logs."
            )
        state["entries"].extend(
            entry.model_dump(mode="json", by_alias=True) for entry in entries
        )
        if urgent:
            highest = max(
                urgent,
                key=lambda item: {"routine": 0, "same-day": 1, "emergency": 2}[item.level],
            )
            merged = highest.model_copy(
                update={
                    "triggers": list(
                        dict.fromkeys(trigger for item in urgent for trigger in item.triggers)
                    )
                }
            )
            # The report is visible to the patient, but remains unlinked safety context because
            # the supporter-authored entries are excluded until the patient reviews them.
            _set_safety_alert(state, merged, source_entry_ids=[])

    try:
        state, _, revision = store.mutate_with_revision(
            apply,
            (
                f"Trusted supporter {supporter.name} created {len(entries)} excluded, "
                "patient-reviewable demo log"
            ),
            actor=f"trusted-supporter:{supporter.name}",
            expected_version=expected_revision,
            metadata={"resource": "journal", "provenance": "supporter", "included": False},
        )
    except VersionConflictError as error:
        raise HTTPException(
            status_code=409,
            detail="The journal changed while this supporter log was being saved. Retry it.",
        ) from error
    response.headers["ETag"] = _etag(revision)
    return SupporterLogResult(
        entries=[entry for entry in state.entries if entry.id in {item.id for item in entries}],
        view=_supporter_scoped_view(state, payload.accessCode),
    )


@router.get("/journal", response_model=list[JournalEntry])
def list_journal(
    store: Store,
    include_excluded: bool = Query(False),
    kind: str | None = Query(None),
) -> list[JournalEntry]:
    entries = store.get().entries
    if not include_excluded:
        entries = [entry for entry in entries if not entry.excluded]
    if kind:
        entries = [entry for entry in entries if entry.kind == kind]
    return sorted(entries, key=lambda item: (item.date, item.time, item.id), reverse=True)


@router.get("/journal/{entry_id}", response_model=JournalEntry)
def get_journal_entry(entry_id: int, store: Store) -> JournalEntry:
    entry = next((item for item in store.get().entries if item.id == entry_id), None)
    if entry is None:
        raise HTTPException(status_code=404, detail="Journal entry not found.")
    return entry


@router.post("/journal", response_model=JournalEntry, status_code=201)
def create_journal_entry(payload: JournalDraft, store: Store) -> JournalEntry:
    current, expected_revision = store.get_with_revision()
    _require_tracking_consent(current.profile)
    if payload.kind == "TEST RESULT":
        raise HTTPException(
            status_code=403,
            detail="Objective test results can only be recorded by the governed lab workflow.",
        )
    _validate_patient_journal_create(payload)
    _validate_photo(payload, current)
    day, clock, _ = _now_parts(current.profile)
    entry_data = payload.model_dump(mode="json", exclude_none=True)
    entry_data.update(
        {
            "id": max((entry.id for entry in current.entries), default=0) + 1,
            "date": payload.date or day,
            "time": payload.time or clock,
            "source": "manual",
            "flagged": False,
            "excluded": False,
        }
    )
    entry = JournalEntry.model_validate(entry_data)
    safety = evaluate_safety(_safety_input_with_body(entry), current.profile)
    entry.flagged = derive_entry_flagged(entry, current.profile) or safety.urgent

    def apply(state: dict[str, Any]) -> None:
        state["entries"].append(entry.model_dump(mode="json", by_alias=True))
        if entry.kind in EVIDENCE_ENTRY_KINDS:
            _invalidate_evidence_confirmation(state)
        if safety.urgent:
            _set_safety_alert(state, safety, source_entry_ids=[entry.id])
        _refresh_clinician_summary(state)

    action = f"Added {entry.kind.lower()} journal entry"
    if safety.urgent:
        action += "; deterministic safety rule surfaced urgent guidance"
    try:
        state, _ = store.mutate(apply, action, expected_version=expected_revision)
    except VersionConflictError as error:
        raise HTTPException(
            status_code=409,
            detail="The journal changed while this entry was being saved. Retry the entry.",
        ) from error
    return next(item for item in state.entries if item.id == entry.id)


@router.patch("/journal/{entry_id}", response_model=JournalEntry)
def update_journal_entry(entry_id: int, payload: JournalPatch, store: Store) -> JournalEntry:
    patch = payload.model_dump(mode="json", exclude_unset=True)
    current, expected_revision = store.get_with_revision()
    candidate_data = next(
        (
            item.model_dump(mode="json", by_alias=True)
            for item in current.entries
            if item.id == entry_id
        ),
        None,
    )
    if candidate_data is None:
        raise HTTPException(status_code=404, detail="Journal entry not found.")
    original = next(item for item in current.entries if item.id == entry_id)
    if _taper_adherence_record(original) is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                "A taper adherence source or correction cannot be generically rewritten. Use "
                "the explicit marked-by-mistake correction path."
            ),
        )
    if original.kind == "TEST RESULT" and original.source == "care":
        disallowed = set(patch) - {"excluded"}
        if disallowed:
            raise HTTPException(
                status_code=409,
                detail=(
                    "An objective care test result cannot be rewritten. Exclude or delete the "
                    "source record instead."
                ),
            )
    kind_changed = payload.kind is not None and payload.kind != original.kind
    if kind_changed:
        candidate_data["structured"] = {}
        patch["structured"] = {}
    candidate_data.update(patch)
    candidate = JournalEntry.model_validate(candidate_data)
    if original.source == "supporter" and original.excluded and payload.excluded is False:
        reviewed_structured = {
            **candidate.structured,
            "supporterReviewStatus": "included by patient",
        }
        patch["structured"] = reviewed_structured
        candidate_data["structured"] = reviewed_structured
        candidate = JournalEntry.model_validate(candidate_data)
    if original.kind != "TEST RESULT" and candidate.kind == "TEST RESULT":
        raise HTTPException(
            status_code=403,
            detail="A journal correction cannot create objective test evidence.",
        )
    _validate_patient_journal_patch(original, payload, patch)
    if (
        original.kind == "TEST RESULT"
        and candidate.kind == "TEST RESULT"
        and (
            candidate.source != original.source
            or candidate.structured.get("calprotectin") != original.structured.get("calprotectin")
        )
    ):
        raise HTTPException(
            status_code=409,
            detail="The lab source and numeric result are immutable; exclude or delete it instead.",
        )
    if payload.body is not None:
        corrected_structured = apply_explicit_record_corrections(candidate, payload.body)
        if (
            original.structured.get("experimentId") == current.experiment.id
            and original.structured.get("experimentEvent") in {"check-in", "complete"}
        ):
            if original.structured.get("experimentEvent") == "check-in":
                note = payload.body.rsplit(":", 1)[-1].strip()
            else:
                match = re.search(
                    r"(?:personal\s+)?outcome review(?:\s*\([^)]*\))?\s*:\s*"
                    r"(.+?)(?:\s+This is an observation|$)",
                    payload.body,
                    re.I,
                )
                note = match.group(1).strip() if match else payload.body.strip()
            corrected_structured["experimentObservation"] = note
        patch["structured"] = corrected_structured
        candidate_data["structured"] = corrected_structured
        candidate = JournalEntry.model_validate(candidate_data)
    _validate_photo(candidate, current)
    safety = evaluate_safety(_safety_input_with_body(candidate), current.profile)
    if payload.body is not None or payload.structured is not None or kind_changed:
        recomputed_flag = derive_entry_flagged(candidate, current.profile) or safety.urgent
        patch["flagged"] = recomputed_flag
        candidate_data["flagged"] = recomputed_flag
        candidate = JournalEntry.model_validate(candidate_data)

    def apply(state: dict[str, Any]) -> None:
        _entry(state, entry_id).update(patch)
        for message in state["messages"]:
            reply_context_retracted = any(
                source.get("messageId") is not None
                and source.get("label") == "Original patient wording"
                and source.get("excluded") is True
                for source in message.get("sources", [])
            )
            for source in message.get("sources", []):
                if source.get("entryId") == entry_id:
                    source["detail"] = candidate.body
                    source["label"] = candidate.kind
                    source["date"] = f"{candidate.date}, {candidate.time}"
                    source["excluded"] = candidate.excluded or reply_context_retracted
        if original.kind in EVIDENCE_ENTRY_KINDS or candidate.kind in EVIDENCE_ENTRY_KINDS:
            _invalidate_evidence_confirmation(state)
        if (
            original.structured.get("experimentId") == current.experiment.id
            and original.structured.get("experimentEvent") in {"check-in", "complete"}
        ):
            _reconcile_experiment_evidence(state)
        if safety.urgent:
            _set_safety_alert(state, safety, source_entry_ids=[entry_id])
        else:
            _recompute_safety_alert_after_source_change(state, entry_id)
        _refresh_clinician_summary(state)

    try:
        state, _ = store.mutate(
            apply,
            f"Corrected journal entry {entry_id}; derived patterns must be recomputed",
            expected_version=expected_revision,
        )
    except VersionConflictError as error:
        raise HTTPException(
            status_code=409,
            detail=(
                "The journal changed while this correction was being saved. Reload the "
                "current entry and retry the correction."
            ),
        ) from error
    store.purge_deleted_payload_bytes()
    return next(item for item in state.entries if item.id == entry_id)


@router.delete("/journal/{entry_id}", status_code=204)
def delete_journal_entry(entry_id: int, store: Store) -> Response:
    current, expected_revision = store.get_with_revision()
    removed_entry = next((entry for entry in current.entries if entry.id == entry_id), None)
    if removed_entry is None:
        raise HTTPException(status_code=404, detail="Journal entry not found.")
    if _taper_adherence_record(removed_entry) is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                "A taper adherence source or correction cannot be generically deleted. Use the "
                "explicit marked-by-mistake correction path."
            ),
        )

    def apply(state: dict[str, Any]) -> None:
        removed = _entry(state, entry_id)
        state["entries"] = [item for item in state["entries"] if item["id"] != entry_id]
        for message in state["messages"]:
            for source in message.get("sources", []):
                if source.get("entryId") == entry_id:
                    source.update(
                        {
                            "excluded": True,
                            "detail": (
                                "Source record deleted by the patient; this earlier reply may "
                                "no longer reflect the retained record."
                            ),
                        }
                    )
        if removed["kind"] in EVIDENCE_ENTRY_KINDS:
            _invalidate_evidence_confirmation(state)
        if (
            removed.get("structured", {}).get("experimentId")
            == state["experiment"]["id"]
            and removed.get("structured", {}).get("experimentEvent")
            in {"check-in", "complete"}
        ):
            _reconcile_experiment_evidence(state)
        _recompute_safety_alert_after_source_change(state, entry_id)
        _refresh_clinician_summary(state)

    try:
        store.mutate(
            apply,
            f"Deleted journal entry {entry_id} and retracted its evidence links",
            expected_version=expected_revision,
        )
    except VersionConflictError as error:
        raise HTTPException(
            status_code=409,
            detail=(
                "The journal changed while this entry was being deleted. Reload the current "
                "journal and retry deletion."
            ),
        ) from error
    store.purge_deleted_payload_bytes()
    return Response(status_code=204)


@router.post("/capture/parse", response_model=CaptureDraft)
def parse_conversational_capture(payload: ChatInput) -> CaptureDraft:
    return parse_capture(payload.text)


@router.get("/chat")
def get_chat(store: Store) -> list[dict[str, Any]]:
    return [message.model_dump(mode="json", by_alias=True) for message in store.get().messages]


def _pending_blood_amount_entry(state: DemoState) -> JournalEntry | None:
    pending = [
        entry
        for entry in state.entries
        if not entry.excluded
        and entry.kind == "BOWEL MOVEMENT"
        and entry.structured.get("needsClarification") == "bloodAmount"
    ]
    return max(pending, key=lambda entry: entry.id, default=None)


def _blood_amount_label(amount: str) -> str:
    if amount == "none":
        return "no blood noticed"
    if amount == "unspecified":
        return "the amount was not clear"
    return f"{amount} blood"


def _save_blood_amount_clarification(
    *,
    text: str,
    amount: str,
    pending: JournalEntry,
    current: DemoState,
    expected_revision: int,
    store: SQLiteDemoStore,
) -> dict[str, Any]:
    """Apply a short clarification to its source record and rerun derived rules."""

    _day, _clock, created_at = _now_parts()
    structured = dict(pending.structured)
    structured.pop("needsClarification", None)
    structured["blood"] = "reported; amount not specified" if amount == "unspecified" else amount
    label = _blood_amount_label(amount)
    suffix = f" · follow-up clarification: {label}"
    body = f"{pending.body[: 4_000 - len(suffix)]}{suffix}"
    corrected = JournalEntry.model_validate(
        {
            **pending.model_dump(mode="json", by_alias=True),
            "body": body,
            "structured": structured,
            "flagged": amount != "none",
        }
    )
    safety = evaluate_safety(_safety_input_with_body(corrected), current.profile)
    next_message_id = max((message.id for message in current.messages), default=0) + 1
    user_message = {
        "id": next_message_id,
        "from": "me",
        "text": text,
        "createdAt": created_at,
        "sources": [],
    }
    if safety.urgent:
        reply_text = (
            f"I updated the original bowel record to say {label}. "
            f"The separate deterministic safety screen says: {safety.message}"
        )
        category = "general information"
    else:
        reply_text = (
            f"Thanks — I updated the original bowel record to say {label}. "
            "You can still correct or exclude it from the journal."
        )
        category = "recorded fact"
    penny_message = {
        "id": next_message_id + 1,
        "from": "penny",
        "text": reply_text,
        "createdAt": utc_now(),
        "category": category,
        "sources": [
            {
                "entryId": corrected.id,
                "label": corrected.kind.title(),
                "date": f"{corrected.date}, {corrected.time}",
                "detail": corrected.body,
                "type": "fact",
            }
        ],
    }

    def apply(state: dict[str, Any]) -> None:
        _entry(state, corrected.id).update(corrected.model_dump(mode="json", by_alias=True))
        for message in state["messages"]:
            reply_context_retracted = any(
                source.get("messageId") is not None
                and source.get("label") == "Original patient wording"
                and source.get("excluded") is True
                for source in message.get("sources", [])
            )
            for source in message.get("sources", []):
                if source.get("entryId") == corrected.id:
                    source.update(
                        {
                            "label": corrected.kind.title(),
                            "date": f"{corrected.date}, {corrected.time}",
                            "detail": corrected.body,
                            "excluded": corrected.excluded or reply_context_retracted,
                        }
                    )
        state["messages"].extend([user_message, penny_message])
        _invalidate_evidence_confirmation(state)
        if safety.urgent:
            _set_safety_alert(state, safety, source_entry_ids=[corrected.id])
        else:
            _recompute_safety_alert_after_source_change(state, corrected.id)
        _refresh_clinician_summary(state)

    try:
        state, _ = store.mutate(
            apply,
            (
                f"Patient clarified the blood amount on journal entry {corrected.id}; linked "
                "evidence, lifecycle review, clinician summary and deterministic safety were "
                "recomputed"
            ),
            actor="patient-and-penny",
            expected_version=expected_revision,
        )
    except VersionConflictError as error:
        raise HTTPException(
            status_code=409,
            detail="The journal changed while this clarification was being saved. Retry it.",
        ) from error
    saved_entry = next(entry for entry in state.entries if entry.id == corrected.id)
    return {
        "messages": [
            state.messages[-2].model_dump(mode="json", by_alias=True),
            state.messages[-1].model_dump(mode="json", by_alias=True),
        ],
        "entries": [saved_entry.model_dump(mode="json", by_alias=True)],
        "profileProposals": [],
        "missing": [],
        "safety": safety.model_dump(mode="json") if safety.urgent else None,
    }


@router.post("/chat")
def send_chat(payload: ChatInput, store: Store) -> dict[str, Any]:
    current, expected_revision = store.get_with_revision()
    _require_tracking_consent(current.profile)
    pending_blood_entry = _pending_blood_amount_entry(current)
    clarified_amount = (
        parse_blood_amount_clarification(payload.text) if pending_blood_entry else None
    )
    if pending_blood_entry is not None and clarified_amount is not None:
        if not current.privacy.assistantJournalAccess:
            raise HTTPException(
                status_code=403,
                detail=(
                    "Assistant journal access is disabled. The pending record can still be "
                    "corrected manually."
                ),
            )
        return _save_blood_amount_clarification(
            text=payload.text,
            amount=clarified_amount,
            pending=pending_blood_entry,
            current=current,
            expected_revision=expected_revision,
            store=store,
        )
    capture = parse_capture(payload.text)
    journal_access = current.privacy.assistantJournalAccess
    day, clock, created_at = _now_parts(current.profile)
    next_message_id = max((message.id for message in current.messages), default=0) + 1
    next_entry_id = max((entry.id for entry in current.entries), default=0) + 1
    next_proposal_id = max((proposal.id for proposal in current.profileProposals), default=0) + 1
    new_entries: list[JournalEntry] = []
    safety_results: list[SafetyEvaluation] = []
    for draft in capture.entries:
        entry = JournalEntry.model_validate(
            {
                **draft.model_dump(mode="json", exclude_none=True),
                "id": next_entry_id,
                "date": draft.date or day,
                "time": draft.time or clock,
            }
        )
        next_entry_id += 1
        entry_safety = evaluate_safety(_safety_input_with_body(entry), current.profile)
        entry.flagged = derive_entry_flagged(entry, current.profile) or entry_safety.urgent
        safety_results.append(entry_safety)
        if journal_access:
            new_entries.append(entry)
    urgent_results = [result for result in safety_results if result.urgent]
    urgent = None
    if urgent_results:
        highest = max(
            urgent_results,
            key=lambda result: {"routine": 0, "same-day": 1, "emergency": 2}[result.level],
        )
        merged_triggers = list(
            dict.fromkeys(trigger for result in urgent_results for trigger in result.triggers)
        )
        urgent = highest.model_copy(update={"triggers": merged_triggers})
    new_profile_proposals = (
        [
            ProfileProposal.model_validate(
                {
                    **proposal.model_dump(mode="json"),
                    "id": next_proposal_id + index,
                    "sourceMessageId": next_message_id,
                    "status": "pending",
                    "createdAt": created_at,
                }
            )
            for index, proposal in enumerate(capture.profileProposals)
        ]
        if current.privacy.assistantProfileAccess
        else []
    )

    conversation_question = bool(
        re.search(
            r"\b(?:what did i (?:tell|say|mention)|what have i (?:told|said|mentioned)|"
            r"did i (?:tell|say|mention)|earlier (?:message|conversation)|"
            r"our (?:earlier |previous )?conversation)\b",
            payload.text,
            re.IGNORECASE,
        )
    )
    conversation_sources: list[dict[str, Any]] = []
    grounded_reply = (
        answer_from_permitted_records(current, payload.text)
        if urgent is None and not capture.entries and not capture.profileProposals
        else None
    )
    if urgent:
        reply_text = urgent.message
        category = "general information"
    elif capture.entries and not journal_access:
        reply_text = (
            "Penny’s journal access is off, so I did not add a health record. The separate "
            "deterministic safety screen still ran. You can use manual quick entry or change "
            "that permission in Privacy."
        )
        category = "general information"
    elif grounded_reply is not None:
        reply_text = grounded_reply["text"]
        category = grounded_reply["category"]
        conversation_sources = grounded_reply.get("sources", [])
    elif conversation_question and not current.privacy.assistantConversationAccess:
        reply_text = (
            "Earlier-conversation access is off, so I cannot retrieve what you previously "
            "told Penny. You can review the conversation yourself or enable that permission."
        )
        category = "general information"
    elif conversation_question:
        prior_messages = [message for message in current.messages if message.from_ == "me"][-5:]
        if prior_messages:
            reply_text = (
                "Your recent earlier patient messages were: "
                + "; ".join(f"“{message.text}”" for message in reversed(prior_messages))
                + ". These are conversation records, not independently verified facts."
            )
            conversation_sources = [
                {
                    "messageId": message.id,
                    "label": "Earlier patient message",
                    "date": message.createdAt,
                    "detail": message.text,
                    "type": "fact",
                }
                for message in reversed(prior_messages)
            ]
        else:
            reply_text = "There are no earlier patient messages in this conversation to retrieve."
        category = "recorded fact"
    elif capture.profileProposals and not current.privacy.assistantProfileAccess:
        reply_text = (
            "Penny’s profile access is off, so I did not create a medical-history proposal or "
            "change your PMH. You can add the wording manually under Profile."
        )
        category = "general information"
    elif any(entry.structured.get("needsClarification") == "bloodAmount" for entry in new_entries):
        reply_text = (
            f"I structured {len(new_entries)} editable journal "
            f"{'entry' if len(new_entries) == 1 else 'entries'}. One safety-relevant detail is "
            "missing: how much blood did you notice — trace or small, moderate, heavy or "
            "continuous, none, or not sure? A few words is enough."
        )
        category = "recorded fact"
    elif new_profile_proposals and not capture.entries:
        reply_text = (
            f"I prepared {len(new_profile_proposals)} reviewable profile "
            f"{'proposal' if len(new_profile_proposals) == 1 else 'proposals'} from that "
            "explicit history statement. Nothing has been added to your PMH."
        )
        category = "recorded fact"
    elif not capture.entries:
        reply_text = (
            "I’ve treated that as a question, so I did not add it to your journal. I can explain "
            "general information, and your IBD team remains the right route for personal advice."
        )
        category = "general information"
    else:
        capture_labels = {
            "BOWEL MOVEMENT": "the bowel movement",
            "MEAL": "the meal",
            "PAIN": "the pain rating",
            "FATIGUE": "the fatigue detail",
            "WELLBEING": "the wellbeing detail",
            "LIFE EVENT": "the life event",
            "MEDICATION": "the medication",
            "FROM YOUR WATCH": "the wearable observation",
            "TEST RESULT": "the test result",
            "Penny noticed": "the observation",
        }
        labels = [capture_labels[entry.kind] for entry in new_entries]
        joined_labels = (
            labels[0]
            if len(labels) == 1
            else f"{', '.join(labels[:-1])} and {labels[-1]}"
        )
        reply_text = (
            f"I logged {joined_labels} in your journal as "
            f"{len(new_entries)} editable journal "
            f"{'entry' if len(new_entries) == 1 else 'entries'}. Please correct anything I "
            "got wrong; no order, message or medication action was triggered."
            + (
                " I also prepared a separate PMH proposal for patient review; the profile was "
                "not changed."
                if new_profile_proposals
                else ""
            )
        )
        category = "recorded fact"

    user_message = {
        "id": next_message_id,
        "from": "me",
        "text": payload.text,
        "createdAt": created_at,
        "sources": [],
    }
    penny_message = {
        "id": next_message_id + 1,
        "from": "penny",
        "text": reply_text,
        "createdAt": utc_now(),
        "category": category,
        "sources": conversation_sources
        or [
            {
                "entryId": entry.id,
                "label": entry.kind.title(),
                "date": f"{entry.date}, {entry.time}",
                "detail": entry.body,
                "type": "fact",
            }
            for entry in new_entries
        ],
    }

    def apply(state: dict[str, Any]) -> None:
        state["messages"].extend([user_message, penny_message])
        state["profileProposals"].extend(
            proposal.model_dump(mode="json") for proposal in new_profile_proposals
        )
        state["entries"].extend(
            entry.model_dump(mode="json", by_alias=True) for entry in new_entries
        )
        if any(entry.kind in EVIDENCE_ENTRY_KINDS for entry in new_entries):
            _invalidate_evidence_confirmation(state)
        if urgent:
            _set_safety_alert(
                state,
                urgent,
                source_entry_ids=[entry.id for entry in new_entries],
            )

    try:
        state, _ = store.mutate(
            apply,
            (
                "Saved a patient message, editable deterministic capture drafts and reviewable "
                "PMH proposal metadata"
                if new_profile_proposals
                else "Saved a patient message and editable deterministic capture drafts"
            ),
            actor="patient-and-penny",
            expected_version=expected_revision,
        )
    except VersionConflictError as error:
        raise HTTPException(
            status_code=409,
            detail="The conversation changed while this message was being saved. Retry it.",
        ) from error
    return {
        "messages": [
            state.messages[-2].model_dump(mode="json", by_alias=True),
            state.messages[-1].model_dump(mode="json", by_alias=True),
        ],
        "entries": [entry.model_dump(mode="json", by_alias=True) for entry in new_entries],
        "profileProposals": [
            proposal.model_dump(mode="json") for proposal in new_profile_proposals
        ],
        "missing": capture.missing,
        "safety": urgent.model_dump(mode="json") if urgent else None,
    }


def _retract_reply_context_for_patient_message(
    state: dict[str, Any], patient_message: dict[str, Any], reason: str
) -> None:
    later = sorted(
        (message for message in state["messages"] if message["id"] > patient_message["id"]),
        key=lambda message: message["id"],
    )
    paired_reply = next(
        (
            message
            for message in later
            if message.get("from") == "penny"
            and not any(
                candidate.get("from") == "me"
                for candidate in later
                if candidate["id"] < message["id"]
            )
        ),
        None,
    )
    if paired_reply is not None:
        for source in paired_reply.get("sources", []):
            source["excluded"] = True
        retraction = next(
            (
                source
                for source in paired_reply.get("sources", [])
                if source.get("messageId") == patient_message["id"]
                and source.get("label") == "Original patient wording"
            ),
            None,
        )
        payload = {
            "messageId": patient_message["id"],
            "label": "Original patient wording",
            "date": patient_message["createdAt"],
            "detail": reason,
            "type": "fact",
            "excluded": True,
        }
        if retraction is None:
            paired_reply.setdefault("sources", []).append(payload)
        else:
            retraction.update(payload)


@router.patch("/chat/{message_id}", response_model=ChatMessage)
def correct_patient_chat_message(
    message_id: int, payload: ChatMessagePatch, response: Response, store: Store
) -> ChatMessage:
    corrected_text = payload.text.strip()
    if not corrected_text:
        raise HTTPException(status_code=422, detail="A corrected patient message cannot be empty.")
    current = store.get()
    original = next((message for message in current.messages if message.id == message_id), None)
    if original is None:
        raise HTTPException(status_code=404, detail="Conversation message not found.")
    if original.from_ != "me":
        raise HTTPException(
            status_code=409,
            detail="Penny replies cannot be rewritten. Delete the individual reply instead.",
        )

    def apply(state: dict[str, Any]) -> None:
        message = next(item for item in state["messages"] if item["id"] == message_id)
        message["text"] = corrected_text
        state["profileProposals"] = [
            proposal
            for proposal in state["profileProposals"]
            if proposal["sourceMessageId"] != message_id
        ]
        _retract_reply_context_for_patient_message(
            state,
            message,
            (
                "The patient corrected the original wording. Any journal records created from "
                "the earlier wording were preserved for separate correction or deletion, while "
                "this historical reply’s evidence links were retracted."
            ),
        )

    state, _, revision = store.mutate_with_revision(
        apply,
        (
            f"Corrected patient conversation message {message_id}; related PMH proposal records "
            "and historical reply evidence links were retracted while journal records were "
            "preserved"
        ),
        actor="patient",
        metadata={"resource": "conversation", "messageId": message_id, "operation": "correct"},
    )
    response.headers["ETag"] = _etag(revision)
    store.purge_deleted_payload_bytes()
    return next(message for message in state.messages if message.id == message_id)


@router.delete("/chat/{message_id}", status_code=204)
def delete_chat_message(message_id: int, response: Response, store: Store) -> None:
    current = store.get()
    original = next((message for message in current.messages if message.id == message_id), None)
    if original is None:
        raise HTTPException(status_code=404, detail="Conversation message not found.")

    def apply(state: dict[str, Any]) -> None:
        message = next(item for item in state["messages"] if item["id"] == message_id)
        if message.get("from") == "me":
            _retract_reply_context_for_patient_message(
                state,
                message,
                (
                    "The patient deleted the source message. Journal records created from it "
                    "remain separately correctable, but this historical reply is retracted."
                ),
            )
            state["profileProposals"] = [
                proposal
                for proposal in state["profileProposals"]
                if proposal["sourceMessageId"] != message_id
            ]
        for candidate in state["messages"]:
            for source in candidate.get("sources", []):
                if source.get("messageId") == message_id:
                    source.update(
                        {
                            "excluded": True,
                            "detail": "The patient deleted this source conversation message.",
                        }
                    )
        state["messages"] = [item for item in state["messages"] if item["id"] != message_id]

    _, _, revision = store.mutate_with_revision(
        apply,
        (
            f"Deleted individual {'patient message' if original.from_ == 'me' else 'Penny reply'} "
            f"{message_id} and retracted dependent conversation provenance"
        ),
        actor="patient",
        metadata={"resource": "conversation", "messageId": message_id, "operation": "delete"},
    )
    response.headers["ETag"] = _etag(revision)
    store.purge_deleted_payload_bytes()


@router.delete("/chat", status_code=204)
def clear_chat(store: Store) -> Response:
    current = store.get()
    had_conversation_payload = bool(current.messages or current.profileProposals)
    store.mutate(
        lambda state: state.update({"messages": [], "profileProposals": []}),
        "Deleted conversation history and its PMH proposal drafts",
    )
    if had_conversation_payload:
        store.purge_deleted_payload_bytes()
    return Response(status_code=204)


@router.post("/safety/evaluate")
def run_safety_check(payload: SafetyInput, store: Store) -> dict[str, Any]:
    current = store.get()
    evaluation = evaluate_safety(payload, current.profile)
    if evaluation.urgent and _tracking_is_active(current.profile):
        state, _ = store.mutate(
            lambda value: _set_safety_alert(value, evaluation),
            f"Deterministic safety check surfaced {evaluation.level} guidance",
            actor="deterministic-rules-v1",
        )
        alert = state.safetyAlert
    else:
        alert = current.safetyAlert
    return {"evaluation": evaluation.model_dump(mode="json"), "alert": alert}


@router.delete("/safety/alert", status_code=204)
def acknowledge_safety_alert(store: Store) -> Response:
    store.mutate(
        lambda state: state.update({"safetyAlert": None}),
        "Patient acknowledged the visible safety guidance",
    )
    store.purge_deleted_payload_bytes()
    return Response(status_code=204)


@router.get("/lifecycle", response_model=LifecycleEvaluation)
def get_lifecycle_evaluation(store: Store) -> LifecycleEvaluation:
    return evaluate_lifecycle(store.get())


@router.post("/lifecycle/evaluate", response_model=LifecycleEvaluation)
def run_lifecycle_evaluation(store: Store) -> LifecycleEvaluation:
    _require_tracking_consent(store.get().profile)
    evaluation = evaluate_lifecycle(store.get())
    phase = evaluation.proposedPhase

    def apply(state: dict[str, Any]) -> None:
        state["pendingPhase"] = phase
        if phase is not None:
            state["phaseConfirmed"] = False

    current = store.get()
    if current.pendingPhase != phase or (phase is not None and current.phaseConfirmed):
        store.mutate(
            apply,
            (
                f"Demo lifecycle rule proposed {phase}; patient confirmation still required"
                if phase is not None
                else "Demo lifecycle rule cleared a stale phase proposal"
            ),
            actor="demo-lifecycle-v1",
        )
    return evaluation


@router.post("/lifecycle/propose", response_model=DemoState)
def propose_lifecycle_phase(payload: PhaseInput, store: Store) -> DemoState:
    current = store.get()
    _require_tracking_consent(current.profile)
    if payload.phase != current.phase and payload.phase not in PHASE_TRANSITIONS[current.phase]:
        raise HTTPException(status_code=409, detail="Lifecycle phases cannot be skipped.")
    evaluation = evaluate_lifecycle(current)
    if evaluation.proposedPhase != payload.phase:
        raise HTTPException(
            status_code=409,
            detail="Only the phase currently proposed by the governed lifecycle rule can be saved.",
        )

    def apply(state: dict[str, Any]) -> None:
        state["pendingPhase"] = payload.phase
        state["phaseConfirmed"] = False

    state, _ = store.mutate(
        apply,
        f"Proposed {payload.phase} support mode; patient confirmation required",
    )
    return state


@router.post("/lifecycle/confirm", response_model=DemoState)
def confirm_lifecycle_phase(store: Store) -> DemoState:
    current = store.get()
    _require_tracking_consent(current.profile)
    evaluation = evaluate_lifecycle(current)
    proposed = evaluation.proposedPhase
    stable_baseline_confirmation = proposed is None and _stable_baseline_confirmation_available(
        current
    )
    if proposed is None and not stable_baseline_confirmation:
        raise HTTPException(
            status_code=409,
            detail=(
                "There is no current evidence-governed phase proposal or eligible clean Stable "
                "baseline to confirm; a presentation choice or generic confirmation cannot "
                "authorise care."
            ),
        )
    if current.pendingPhase is not None and current.pendingPhase != proposed:
        raise HTTPException(
            status_code=409,
            detail=(
                "The saved phase proposal is stale; evaluate the current included evidence again."
            ),
        )
    target = proposed or "stable"
    if target != current.phase and target not in PHASE_TRANSITIONS[current.phase]:
        raise HTTPException(status_code=409, detail="Lifecycle phases cannot be skipped.")
    if target == "watch" and not has_eligible_test_order_evidence(current):
        raise HTTPException(
            status_code=409,
            detail="The current included records no longer meet the governed watchful rule.",
        )
    if target == "flare" and not has_included_raised_test(current):
        raise HTTPException(
            status_code=409,
            detail=(
                "Demo clinical guard: flare support requires objective result or clinical "
                "establishment; "
                "use the explicit demo phase switch only for presentation."
            ),
        )
    if target == "recovery" and (
        current.prescription.status != "collected" or not symptoms_settling(current)
    ):
        raise HTTPException(
            status_code=409,
            detail=(
                "Recovery support requires collected clinician-authorised treatment and an "
                "included patient record that symptoms are settling."
            ),
        )
    if (
        target == "stable"
        and current.phase == "recovery"
        and (not taper_course_complete(current) or not symptoms_settling(current))
    ):
        raise HTTPException(
            status_code=409,
            detail="Confirm course completion and return to baseline before stable mode.",
        )

    def apply(state: dict[str, Any]) -> None:
        state["phase"] = target
        state["pendingPhase"] = None
        state["phaseConfirmed"] = True
        if target != "stable" and state["experiment"]["status"] == "active":
            state["experiment"]["status"] = "paused"

    action = (
        "Patient explicitly confirmed the complete maintained baseline as the governed Stable "
        "starting point"
        if stable_baseline_confirmation
        else f"Patient confirmed {target} support mode"
    )
    state, _ = store.mutate(apply, action)
    return state


@router.get("/dashboard", response_model=DashboardResponse)
def dashboard(store: Store) -> DashboardResponse:
    return build_dashboard(store.get())


@router.get("/timeline", response_model=list[JournalEntry])
def timeline(store: Store) -> list[JournalEntry]:
    return sorted(
        [entry for entry in store.get().entries if not entry.excluded],
        key=lambda item: (item.date, item.time, item.id),
        reverse=True,
    )


@router.get("/trends")
def trends(store: Store) -> list[dict[str, Any]]:
    return build_dashboard(store.get()).trend


@router.get("/evidence")
def evidence(store: Store) -> list[dict[str, Any]]:
    return [item.model_dump(mode="json") for item in build_dashboard(store.get()).evidence]


@router.get("/care/test-order", response_model=TestOrder)
def get_test_order(store: Store) -> TestOrder:
    return store.get().testOrder


@router.patch("/care/test-order", response_model=TestOrder)
def update_test_order(payload: TestOrderPatch, store: Store) -> TestOrder:
    _require_tracking_consent(store.get().profile)
    patch = payload.model_dump(exclude_none=True)
    def apply(state: dict[str, Any]) -> None:
        _require_tracking_consent(state["profile"])
        order = state["testOrder"]
        changed = any(key in patch and patch[key] != order[key] for key in patch)
        if order["status"] != "prepared" and changed:
            raise HTTPException(
                status_code=409,
                detail="Test-order delivery confirmation and consent lock when fulfilment begins.",
            )
        _patch(order, patch)

    state, _ = store.mutate(
        apply,
        "Updated prepared test-order delivery confirmation or consent",
    )
    return state.testOrder


@router.post("/care/test-order/confirm", response_model=TestOrder)
def confirm_test_order(payload: TestOrderPatch, store: Store) -> TestOrder:
    _require_tracking_consent(store.get().profile)
    patch = payload.model_dump(exclude_none=True)

    def apply(state: dict[str, Any]) -> None:
        _require_tracking_consent(state["profile"])
        order = state["testOrder"]
        if order["status"] != "prepared":
            raise HTTPException(status_code=409, detail="Only a prepared order can be confirmed.")
        if payload.addressConfirmed is not True or payload.consent is not True:
            raise HTTPException(
                status_code=422,
                detail=(
                    "Confirm the current delivery address and give explicit test consent in "
                    "this order action. Earlier prepared values cannot be reused."
                ),
            )
        _patch(order, patch)
        if not order["addressConfirmed"] or not order["consent"]:
            raise HTTPException(
                status_code=422,
                detail="Delivery address and test consent must both be confirmed.",
            )
        if not state["phaseConfirmed"]:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Review, correct and confirm the evidence-backed watchful state before "
                    "placing the test order."
                ),
            )
        current_state = DemoState.model_validate(state)
        if not has_eligible_test_order_evidence(current_state):
            raise HTTPException(
                status_code=409,
                detail=(
                    "The current included records no longer meet the governed test-order rule. "
                    "Review the evidence and contact the IBD team."
                ),
            )
        if state["phase"] not in {"watch", "flare"}:
            raise HTTPException(
                status_code=409,
                detail="The demo care plan only permits this test in watchful or flare support.",
            )
        delivery_address = str(state["profile"].get("address", "")).strip()
        delivery_postcode = str(state["profile"].get("postcode", "")).strip()
        if not delivery_address or not delivery_postcode:
            raise HTTPException(
                status_code=422,
                detail="A complete current delivery address and postcode are required.",
            )
        _, _, confirmed_at = _now_parts(state["profile"])
        order["status"] = "ordered"
        order["statusUpdatedAt"] = confirmed_at
        order["deliveryAddress"] = delivery_address
        order["deliveryPostcode"] = delivery_postcode
        order["confirmedAt"] = confirmed_at

    state, _ = store.mutate(
        apply,
        "Patient confirmed address and consent; simulation placed calprotectin order",
        actor="patient-and-gutsy-simulation",
    )
    return state.testOrder


@router.post("/care/test-order/simulate-advance", response_model=TestOrder)
def advance_test_order(payload: TestAdvanceInput | None, store: Store) -> TestOrder:
    _require_tracking_consent(store.get().profile)
    requested = payload.status if payload else None

    def apply(state: dict[str, Any]) -> None:
        _require_tracking_consent(state["profile"])
        order = state["testOrder"]
        _require_test_order_consent(order)
        current = order["status"]
        if current not in TEST_SEQUENCE:
            raise HTTPException(
                status_code=409,
                detail="This test is not in a fulfilment state that can advance.",
            )
        current_index = TEST_SEQUENCE.index(current)
        next_status = requested or (
            TEST_SEQUENCE[current_index + 1] if current_index + 1 < len(TEST_SEQUENCE) else None
        )
        if next_status is None or TEST_SEQUENCE.index(next_status) != current_index + 1:
            raise HTTPException(
                status_code=409,
                detail="Fulfilment simulation must advance exactly one step.",
            )
        order["status"] = next_status
        order["statusUpdatedAt"] = _now_parts()[2]

    state, _ = store.mutate(
        apply,
        "Simulation advanced calprotectin fulfilment by one state",
        actor="gutsy-fulfilment-simulation",
    )
    return state.testOrder


@router.post("/care/test-order/simulate-result", response_model=TestOrder)
def record_test_result(payload: TestResultInput, store: Store) -> TestOrder:
    _require_tracking_consent(store.get().profile)
    if payload.result < 100:
        note = "Lower range in this demo pathway; interpret with symptoms and the IBD team."
    elif payload.result < 250:
        note = "Intermediate range in this demo pathway; the IBD team should interpret it."
    else:
        note = "Raised result in this demo pathway; contact the IBD team for interpretation."

    def apply(state: dict[str, Any]) -> None:
        _require_tracking_consent(state["profile"])
        order = state["testOrder"]
        _require_test_order_consent(order)
        if order["status"] != "lab":
            raise HTTPException(
                status_code=409, detail="The simulated lab must receive the sample first."
            )
        order.update(
            {
                "status": "result",
                "statusUpdatedAt": _now_parts()[2],
                "result": payload.result,
                "resultNote": note,
            }
        )
        entry_id = _next_id(state["entries"])
        day, clock, _ = _now_parts(state["profile"])
        state["entries"].append(
            {
                "id": entry_id,
                "date": day,
                "time": clock,
                "kind": "TEST RESULT",
                "body": (
                    f"Faecal calprotectin {payload.result} µg/g — clinical interpretation required"
                ),
                "source": "care",
                "flagged": payload.result >= 250,
                "excluded": False,
                "structured": {"calprotectin": payload.result, "diagnostic": False},
            }
        )
        _invalidate_evidence_confirmation(state)
        _refresh_clinician_summary(state)

    state, _ = store.mutate(
        apply,
        "Simulation recorded lab result for patient and care-team review",
        actor="lab-simulation",
    )
    return state.testOrder


@router.post("/care/test-order/share", response_model=TestOrder)
def share_test_result(store: Store) -> TestOrder:
    _require_tracking_consent(store.get().profile)

    def apply(state: dict[str, Any]) -> None:
        _require_tracking_consent(state["profile"])
        _require_test_order_consent(state["testOrder"])
        if state["testOrder"]["status"] != "result":
            raise HTTPException(
                status_code=409, detail="A result must be available before sharing."
            )
        state["testOrder"]["status"] = "shared"
        state["testOrder"]["statusUpdatedAt"] = _now_parts()[2]

    state, _ = store.mutate(
        apply,
        "Patient confirmed sharing the calprotectin result with the IBD team",
    )
    return state.testOrder


@router.get("/care/team-message", response_model=TeamMessage)
def get_team_message(store: Store) -> TeamMessage:
    return store.get().teamMessage


@router.post("/care/team-message/new", response_model=TeamMessage)
def prepare_next_team_message(store: Store) -> TeamMessage:
    _require_tracking_consent(store.get().profile)

    def apply(state: dict[str, Any]) -> None:
        previous = state["teamMessage"]
        if previous["status"] != "replied":
            raise HTTPException(
                status_code=409,
                detail=(
                    "A follow-up draft can only be prepared after the current clinician "
                    "thread has received a reply."
                ),
            )
        state["teamMessageHistory"].insert(0, dict(previous))
        _, _, created_at = _now_parts()
        previous.update(
            {
                "id": f"MSG-{created_at}",
                "subject": f"Follow-up from {state['profile']['name'] or 'Gutsy patient'}",
                "body": state["clinicianSummary"] or "Patient follow-up — review before sending",
                "status": "draft",
                "sentAt": None,
                "statusUpdatedAt": created_at,
                "notificationReason": (
                    "Patient explicitly prepared a follow-up draft from currently included "
                    "records; nothing is sent until every word is reviewed."
                ),
                "expectedResponse": "Within one working day",
                "reply": None,
            }
        )
        state["teamMessageStale"] = False

    state, _ = store.mutate(
        apply,
        "Prepared a new editable follow-up draft; nothing was sent",
    )
    return state.teamMessage


@router.patch("/care/team-message", response_model=TeamMessage)
def edit_team_message(payload: TeamMessagePatch, store: Store) -> TeamMessage:
    _require_tracking_consent(store.get().profile)
    patch = payload.model_dump(exclude_none=True)

    def apply(state: dict[str, Any]) -> None:
        if state["teamMessage"]["status"] != "draft":
            raise HTTPException(status_code=409, detail="Only an unsent draft can be edited.")
        _patch(state["teamMessage"], patch)

    state, _ = store.mutate(apply, "Patient edited the clinician-message draft")
    store.purge_deleted_payload_bytes()
    return state.teamMessage


@router.post("/care/team-message/refresh", response_model=TeamMessage)
def refresh_team_message(store: Store) -> TeamMessage:
    _require_tracking_consent(store.get().profile)

    def apply(state: dict[str, Any]) -> None:
        if state["teamMessage"]["status"] != "draft":
            raise HTTPException(status_code=409, detail="Only an unsent draft can be refreshed.")
        state["teamMessage"]["body"] = build_clinician_summary(DemoState.model_validate(state))
        state["teamMessageStale"] = False

    state, _ = store.mutate(
        apply,
        "Patient explicitly refreshed the clinician-message draft from included records",
    )
    return state.teamMessage


@router.post("/care/team-message/send", response_model=TeamMessage)
def send_team_message(store: Store) -> TeamMessage:
    _require_tracking_consent(store.get().profile)

    def apply(state: dict[str, Any]) -> None:
        message = state["teamMessage"]
        if message["status"] != "draft":
            raise HTTPException(status_code=409, detail="Only a reviewed draft can be sent.")
        if state.get("teamMessageStale", False):
            raise HTTPException(
                status_code=409,
                detail=(
                    "Included records changed after this draft was prepared. Refresh and review "
                    "the draft before sending."
                ),
            )
        if not message["body"].strip():
            raise HTTPException(status_code=422, detail="The reviewed draft cannot be empty.")
        if (
            message.get("notificationRule") == "Not configured"
            or str(message.get("clinicalOwner", "")).startswith("Not configured")
        ):
            raise HTTPException(
                status_code=409,
                detail=(
                    "Clinician messaging requires a named owner and configured notification "
                    "rule before anything can be sent."
                ),
            )
        message["status"] = "sent"
        message["sentAt"] = message["statusUpdatedAt"] = _now_parts()[2]

    state, _ = store.mutate(
        apply,
        "Patient reviewed and sent clinician message through the secure-message simulation",
    )
    return state.teamMessage


@router.post("/care/team-message/simulate-read", response_model=TeamMessage)
def simulate_team_message_read(store: Store) -> TeamMessage:
    _require_tracking_consent(store.get().profile)

    def apply(state: dict[str, Any]) -> None:
        if state["teamMessage"]["status"] != "sent":
            raise HTTPException(status_code=409, detail="Only a sent message can be marked read.")
        state["teamMessage"]["status"] = "read"
        state["teamMessage"]["statusUpdatedAt"] = _now_parts()[2]

    state, _ = store.mutate(
        apply,
        "Simulation: IBD nurse read the patient-approved message",
        actor="clinical-messaging-simulation",
    )
    return state.teamMessage


@router.post("/care/team-message/simulate-reply", response_model=TeamMessage)
def simulate_team_message_reply(payload: ReplyInput, store: Store) -> TeamMessage:
    _require_tracking_consent(store.get().profile)

    def apply(state: dict[str, Any]) -> None:
        if state["teamMessage"]["status"] not in {"sent", "read"}:
            raise HTTPException(
                status_code=409, detail="The team can only reply to a sent message."
            )
        state["teamMessage"].update(
            {
                "status": "replied",
                "statusUpdatedAt": _now_parts()[2],
                "reply": payload.reply,
            }
        )

    state, _ = store.mutate(
        apply,
        "Simulation: IBD team reply received in the patient thread",
        actor="clinical-messaging-simulation",
    )
    return state.teamMessage


@router.post("/care/simulate-plan-import", response_model=DemoState)
def simulate_clinician_plan_import(response: Response, store: Store) -> DemoState:
    current = store.get()
    _require_tracking_consent(current.profile)

    def apply(state: dict[str, Any]) -> None:
        if state["prescription"]["status"] != "not-started" or state["taper"]["days"]:
            raise HTTPException(
                status_code=409,
                detail=(
                    "A clinician plan is already recorded; it cannot be overwritten by simulation."
                ),
            )
        if not state["profile"]["carePlan"].strip():
            raise HTTPException(
                status_code=409, detail="Record the personal care plan before importing it."
            )
        prescriber_contact = next(
            (
                contact
                for contact in state["contacts"]
                if any(
                    token in f"{contact['role']} {contact['name']}".lower()
                    for token in ("consultant", "gastro", "prescriber", "doctor", "dr ")
                )
            ),
            None,
        )
        pharmacy_contact = next(
            (
                contact
                for contact in state["contacts"]
                if "pharmac" in f"{contact['role']} {contact['organisation']}".lower()
            ),
            None,
        )
        prescriber = (
            prescriber_contact["name"]
            if prescriber_contact
            else "Configured gastroenterology prescriber"
        )
        pharmacy = pharmacy_contact["name"] if pharmacy_contact else "Configured nominated pharmacy"
        blocks = [30, 25, 20, 15, 10, 5]
        schedule_start = _patient_date(state["profile"])
        schedule = [
            {
                "day": index + 1,
                "doseMg": blocks[index // 7],
                "date": (schedule_start + timedelta(days=index)).isoformat(),
                "taken": False,
            }
            for index in range(42)
        ]
        state["prescription"].update(
            {
                "status": "prepared",
                "medicine": "Prednisolone course — dose set by prescriber",
                "prescriber": prescriber,
                "pharmacy": pharmacy,
                "clinicalOwner": f"{prescriber} (simulated prescribing owner)",
                "eligibilityRule": "IBD-RESCUE-PRED-DEMO-v1",
                "eligibilityReason": (
                    "A documented rescue pathway still requires confirmed Flare support, an "
                    "included raised objective result and explicit prescriber authorisation."
                ),
                "rescuePlanEligible": True,
                "treatmentStartedAt": None,
                "reviewAfterHours": 24,
            }
        )
        state["taper"] = {
            "verified": False,
            "medicine": "Prednisolone",
            "prescribedBy": prescriber,
            "currentDay": 1,
            "snoozedUntil": None,
            "days": schedule,
            "missedDays": [],
            "sideEffects": [],
            "checkInComplete": False,
        }
        _refresh_clinician_summary(state)
        if state["teamMessage"].get("notificationRule") == "Not configured":
            ibd_contact = next(
                (
                    contact
                    for contact in state["contacts"]
                    if any(
                        token in f"{contact['role']} {contact['organisation']}".lower()
                        for token in ("ibd", "gastro", "nurse")
                    )
                ),
                prescriber_contact,
            )
            owner = (
                (ibd_contact.get("organisation") or ibd_contact.get("name"))
                if ibd_contact
                else prescriber
            )
            state["teamMessage"].update(
                {
                    "subject": (
                        f"Patient-reviewed update from "
                        f"{state['profile'].get('name') or 'Gutsy patient'}"
                    ),
                    "body": state["clinicianSummary"] or "Review this draft before sending.",
                    "clinicalOwner": f"{owner} (simulated clinical owner)",
                    "notificationRule": "IBD-CHANGE-NOTIFY-DEMO-v1",
                    "notificationReason": (
                        "Patient-reviewed sustained-change evidence can prepare a contact-first "
                        "draft; nothing is sent until the patient approves every word."
                    ),
                    "expectedResponse": "Within one working day",
                    "statusUpdatedAt": _now_parts()[2],
                }
            )
            state["teamMessageStale"] = False

    state, _, revision = store.mutate_with_revision(
        apply,
        "Simulation: imported a named clinician-authored rescue plan and immutable taper",
        actor="clinician-plan-simulation",
        metadata={"resource": "clinician-care-plan", "simulation": True},
    )
    response.headers["ETag"] = _etag(revision)
    response.headers["X-State-Revision"] = str(revision)
    return state


@router.get("/care/prescription", response_model=PrescriptionFlow)
def get_prescription(store: Store) -> PrescriptionFlow:
    return store.get().prescription


@router.post("/care/prescription/request", response_model=PrescriptionFlow)
def request_prescription(store: Store) -> PrescriptionFlow:
    _require_tracking_consent(store.get().profile)

    def apply(state: dict[str, Any]) -> None:
        prescription = state["prescription"]
        if prescription["status"] != "prepared":
            raise HTTPException(status_code=409, detail="Only a prepared request can be submitted.")
        if not prescription["rescuePlanEligible"]:
            raise HTTPException(
                status_code=403,
                detail="No documented clinician-owned rescue pathway is available.",
            )
        if not (
            state["phase"] == "flare"
            and state["phaseConfirmed"]
            and state.get("pendingPhase") is None
        ):
            raise HTTPException(
                status_code=409,
                detail=(
                    "Submitting a rescue-prescription request requires confirmed Flare "
                    "support with no unresolved lifecycle proposal."
                ),
            )
        objective_context = has_included_raised_test(DemoState.model_validate(state))
        if not objective_context:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Submitting a rescue request requires matching included objective evidence "
                    "under the documented clinician-owned pathway. A demo switch is "
                    "presentation-only."
                ),
            )
        prescription["status"] = "requested"

    state, _ = store.mutate(
        apply,
        "Patient confirmed sending the prepared request to the named prescriber",
    )
    return state.prescription


@router.post("/care/prescription/simulate-approve", response_model=PrescriptionFlow)
def approve_prescription(store: Store) -> PrescriptionFlow:
    _require_tracking_consent(store.get().profile)

    def apply(state: dict[str, Any]) -> None:
        if state["prescription"]["status"] != "requested":
            raise HTTPException(status_code=409, detail="The prescriber needs a submitted request.")
        state["prescription"]["status"] = "approved"

    state, _ = store.mutate(
        apply,
        "Simulation: Dr Rui Ferreira authorised the prescription; Penny made no dose decision",
        actor="prescriber-simulation",
    )
    return state.prescription


@router.post("/care/prescription/simulate-ready", response_model=PrescriptionFlow)
def prescription_ready(store: Store) -> PrescriptionFlow:
    _require_tracking_consent(store.get().profile)

    def apply(state: dict[str, Any]) -> None:
        if state["prescription"]["status"] != "approved":
            raise HTTPException(status_code=409, detail="Clinician approval is required first.")
        state["prescription"]["status"] = "ready"

    state, _ = store.mutate(
        apply,
        "Simulation: Wellfield Pharmacy marked the authorised prescription ready",
        actor="pharmacy-simulation",
    )
    return state.prescription


@router.post("/care/prescription/collect", response_model=PrescriptionFlow)
def collect_prescription(store: Store) -> PrescriptionFlow:
    _require_tracking_consent(store.get().profile)

    def apply(state: dict[str, Any]) -> None:
        if state["prescription"]["status"] != "ready":
            raise HTTPException(status_code=409, detail="The pharmacy has not marked it ready.")
        _anchor_taper_at_collection(state)
        state["prescription"].update({"status": "collected", "treatmentStartedAt": utc_now()})
        _refresh_clinician_summary(state)
        _refresh_lifecycle_proposal(state)

    state, _ = store.mutate(
        apply,
        (
            "Patient confirmed collecting the authorised prescription; the unchanged taper "
            "was anchored to collection day, prior adherence was cleared and verification is "
            "required again"
        ),
    )
    return state.prescription


@router.get("/taper", response_model=Taper)
def get_taper(store: Store) -> Taper:
    return store.get().taper


@router.patch("/taper", response_model=Taper)
def update_taper_checklist(payload: TaperPatch, store: Store) -> Taper:
    _require_tracking_consent(store.get().profile)
    patch = payload.model_dump(exclude_none=True)

    def apply(state: dict[str, Any]) -> None:
        _require_taper_actions_available(state)
        _patch(state["taper"], patch)
        _refresh_clinician_summary(state)
        _refresh_lifecycle_proposal(state)

    state, _ = store.mutate(
        apply,
        "Patient corrected recorded steroid side effects; prescribed doses were unchanged",
    )
    store.purge_deleted_payload_bytes()
    return state.taper


@router.post("/taper/verify", response_model=Taper)
def verify_taper(store: Store) -> Taper:
    _require_tracking_consent(store.get().profile)

    def apply(state: dict[str, Any]) -> None:
        if not state["taper"]["days"] or not state["taper"]["prescribedBy"]:
            raise HTTPException(status_code=422, detail="An authorised schedule is required.")
        state["taper"]["verified"] = True
        _refresh_clinician_summary(state)

    state, _ = store.mutate(
        apply,
        "Patient verified the clinician-authored taper without changing any dose",
    )
    return state.taper


@router.get("/taper/today")
def get_today_taper_dose(store: Store) -> dict[str, Any]:
    state = store.get()
    if not _taper_actions_available(state):
        return {
            "status": "review-only",
            "available": False,
            "message": (
                "Dose support is unavailable until clinician-issued treatment is collected or "
                "governed Recovery support is confirmed. Review or verify the imported schedule "
                "separately under the taper endpoint."
            ),
            "today": None,
            "nextChange": None,
            "canEditDose": False,
        }
    taper = state.taper
    day = _calendar_taper_day(taper.days, taper.currentDay, state.profile)
    if day is None:
        raise HTTPException(
            status_code=404, detail="There is no scheduled dose for the current day."
        )
    next_change = next(
        (item for item in taper.days if item.day > day.day and item.doseMg != day.doseMg), None
    )
    return {
        "status": "active",
        "available": True,
        "today": day.model_dump(mode="json"),
        "nextChange": next_change.model_dump(mode="json") if next_change else None,
        "medicine": taper.medicine,
        "prescribedBy": taper.prescribedBy,
        "verified": taper.verified,
        "canEditDose": False,
    }


@router.post("/taper/dose/taken", response_model=Taper)
def mark_taper_dose_taken(store: Store) -> Taper:
    _require_tracking_consent(store.get().profile)

    def apply(state: dict[str, Any]) -> None:
        day_value, clock, _ = _now_parts(state["profile"])
        _require_taper_actions_available(state)
        taper = state["taper"]
        if not taper["verified"]:
            raise HTTPException(status_code=409, detail="Verify the authorised schedule first.")
        day = _exact_calendar_taper_day(taper["days"], state["profile"])
        if day is None:
            raise HTTPException(
                status_code=404,
                detail="There is no taper dose scheduled for today’s patient-local date.",
            )
        if day["day"] in taper["missedDays"]:
            raise HTTPException(
                status_code=409,
                detail=(
                    "This past dose is already reconciled as not taken and cannot also be "
                    "marked taken."
                ),
            )
        taper["currentDay"] = day["day"]
        day["taken"] = True
        taper["snoozedUntil"] = None
        if not any(
            entry.get("kind") == "MEDICATION"
            and entry.get("source") == "manual"
            and not entry.get("excluded", False)
            and entry.get("structured", {}).get("taperDay") == day["day"]
            and entry.get("structured", {}).get("taken") is True
            and entry.get("structured", {}).get("doseMg") == day["doseMg"]
            and entry.get("structured", {}).get("scheduledDate") == day["date"]
            for entry in state["entries"]
        ):
            state["entries"].append(
                {
                    "id": _next_id(state["entries"]),
                    "date": day_value,
                    "time": clock,
                    "kind": "MEDICATION",
                    "body": (
                        f"{day['doseMg']} mg {taper['medicine']} taken — prescribed taper "
                        f"day {day['day']}"
                    ),
                    "source": "manual",
                    "flagged": False,
                    "excluded": False,
                    "structured": {
                        "doseMg": day["doseMg"],
                        "taken": True,
                        "taperDay": day["day"],
                        "scheduledDate": day["date"],
                    },
                }
            )
        _refresh_clinician_summary(state)
        _refresh_lifecycle_proposal(state)

    state, _ = store.mutate(
        apply,
        "Patient confirmed today’s prescribed dose as taken; schedule remained unchanged",
    )
    return state.taper


@router.post("/taper/dose/reconcile-missed", response_model=Taper)
def reconcile_missed_taper_dose(payload: TaperMissedDose, store: Store) -> Taper:
    _require_tracking_consent(store.get().profile)

    def apply(state: dict[str, Any]) -> None:
        recorded_date, clock, _ = _now_parts(state["profile"])
        _require_taper_actions_available(state)
        taper = state["taper"]
        if not taper["verified"]:
            raise HTTPException(status_code=409, detail="Verify the authorised schedule first.")
        scheduled = next((item for item in taper["days"] if int(item["day"]) == payload.day), None)
        if scheduled is None:
            raise HTTPException(status_code=404, detail="Scheduled taper day not found.")
        if scheduled["date"] >= recorded_date:
            raise HTTPException(
                status_code=409,
                detail="Only a past prescribed dose can be reconciled as not taken.",
            )
        if scheduled["taken"]:
            raise HTTPException(
                status_code=409, detail="This prescribed dose is already recorded as taken."
            )
        if payload.day in taper["missedDays"]:
            raise HTTPException(status_code=409, detail="This missed dose was already reconciled.")
        taper["missedDays"].append(payload.day)
        taper["missedDays"].sort()
        state["entries"].append(
            {
                "id": _next_id(state["entries"]),
                "date": recorded_date,
                "time": clock,
                "kind": "MEDICATION",
                "body": (
                    f"Prescribed taper day {scheduled['day']} ({scheduled['doseMg']} mg "
                    f"{taper['medicine']}) reconciled as not taken"
                ),
                "source": "manual",
                "flagged": True,
                "excluded": False,
                "structured": {
                    "doseMg": scheduled["doseMg"],
                    "taken": False,
                    "missed": True,
                    "taperDay": scheduled["day"],
                    "scheduledDate": scheduled["date"],
                },
            }
        )
        _refresh_clinician_summary(state)
        _refresh_lifecycle_proposal(state)

    state, _ = store.mutate(
        apply,
        f"Patient reconciled past prescribed taper day {payload.day} as not taken; "
        "schedule unchanged",
    )
    return state.taper


@router.post("/taper/dose/correct", response_model=Taper)
def correct_taper_dose_record(payload: TaperDoseCorrection, store: Store) -> Taper:
    """Retract one patient-entered adherence fact without altering the prescription."""

    def apply(state: dict[str, Any]) -> None:
        recorded_date, clock, _ = _now_parts(state["profile"])
        taper = state["taper"]
        scheduled = next((item for item in taper["days"] if int(item["day"]) == payload.day), None)
        if scheduled is None:
            raise HTTPException(status_code=404, detail="Scheduled taper day not found.")
        if payload.fact == "taken":
            if not scheduled["taken"]:
                raise HTTPException(
                    status_code=409,
                    detail="This taper day is not currently recorded as taken.",
                )
            scheduled["taken"] = False
        else:
            if payload.day not in taper["missedDays"]:
                raise HTTPException(
                    status_code=409,
                    detail="This taper day is not currently reconciled as missed.",
                )
            taper["missedDays"] = [
                day_number for day_number in taper["missedDays"] if int(day_number) != payload.day
            ]

        matching_originals = [
            entry
            for entry in state["entries"]
            if entry["kind"] == "MEDICATION"
            and not entry.get("excluded", False)
            and entry.get("structured", {}).get("taperDay") == payload.day
            and (
                (payload.fact == "taken" and entry.get("structured", {}).get("taken") is True)
                or (payload.fact == "missed" and entry.get("structured", {}).get("missed") is True)
            )
        ]
        if not matching_originals:
            raise HTTPException(
                status_code=409,
                detail="The adherence fact has no matching timeline source to correct.",
            )
        for entry in matching_originals:
            entry["excluded"] = True

        label = "taken" if payload.fact == "taken" else "not taken"
        state["entries"].append(
            {
                "id": _next_id(state["entries"]),
                "date": recorded_date,
                "time": clock,
                "kind": "MEDICATION",
                "body": (
                    f"Correction: prescribed taper day {payload.day} was marked {label} by "
                    "mistake; that patient-entered adherence fact is retracted. The prescribed "
                    "schedule is unchanged."
                ),
                "source": "manual",
                "flagged": False,
                "excluded": False,
                "structured": {
                    "adherenceCorrection": True,
                    "correctedFact": payload.fact,
                    "doseMg": scheduled["doseMg"],
                    "taperDay": payload.day,
                    "scheduledDate": scheduled["date"],
                },
            }
        )
        _refresh_clinician_summary(state)
        _refresh_lifecycle_proposal(state)

    state, _ = store.mutate(
        apply,
        f"Patient retracted taper day {payload.day} {payload.fact} adherence fact as marked by "
        "mistake; clinician-authored schedule unchanged",
    )
    return state.taper


@router.post("/taper/dose/snooze", response_model=Taper)
def snooze_taper_dose(payload: SnoozeInput, store: Store) -> Taper:
    _require_tracking_consent(store.get().profile)
    until = (datetime.now(UTC) + timedelta(minutes=payload.minutes)).replace(microsecond=0)

    def apply(state: dict[str, Any]) -> None:
        _require_taper_actions_available(state)
        state["taper"]["snoozedUntil"] = until.isoformat()

    state, _ = store.mutate(
        apply,
        f"Patient snoozed the dose reminder for {payload.minutes} minutes",
    )
    return state.taper


@router.post("/taper/check-in", response_model=Taper)
def taper_check_in(payload: TaperCheckIn, store: Store) -> Taper:
    _require_tracking_consent(store.get().profile)
    concerns: list[str] = []
    if payload.infectionConcern:
        concerns.append("Infection concern while taking steroids")
    if payload.moodConcern:
        concerns.append("Mood concern while taking steroids")
    if payload.newSwellingConcern:
        concerns.append("New swelling while taking steroids")
    if payload.symptomsWorse:
        concerns.append("Symptoms worsening during taper")

    def apply(state: dict[str, Any]) -> None:
        day, clock, _ = _now_parts(state["profile"])
        _require_taper_actions_available(state)
        taper = state["taper"]
        taper["checkInComplete"] = True
        for concern in concerns:
            if concern not in taper["sideEffects"]:
                taper["sideEffects"].append(concern)
        details = concerns or ["No side-effect concerns selected"]
        entry_id = _next_id(state["entries"])
        state["entries"].append(
            {
                "id": entry_id,
                "date": day,
                "time": clock,
                "kind": "WELLBEING",
                "body": f"Steroid recovery check-in: {', '.join(details)}",
                "source": "manual",
                "flagged": bool(concerns),
                "excluded": False,
                "structured": {
                    "taperCheckIn": True,
                    "wellbeing": "worse" if payload.symptomsWorse else "same",
                    "sleepHours": payload.sleepHours if payload.sleepHours is not None else "",
                    "infectionConcern": payload.infectionConcern,
                    "moodConcern": payload.moodConcern,
                    "newSwellingConcern": payload.newSwellingConcern,
                    "symptomsWorse": payload.symptomsWorse,
                },
            }
        )
        _invalidate_evidence_confirmation(state)
        _refresh_clinician_summary(state)
        if concerns:
            evaluation = SafetyEvaluation(
                urgent=True,
                level="same-day",
                triggers=concerns,
                message=SAME_DAY_MESSAGE,
            )
            _set_safety_alert(state, evaluation, source_entry_ids=[entry_id])

    action = "Completed low-burden steroid safety check-in"
    if concerns:
        action += "; same-day care-team guidance surfaced"
    state, _ = store.mutate(apply, action)
    return state.taper


@router.get("/taper/missed-dose-guidance")
def missed_dose_guidance(store: Store) -> dict[str, str]:
    state = store.get()
    pharmacy = next(
        (
            contact
            for contact in state.contacts
            if re.search(
                r"\bpharmac(?:y|ist)\b",
                f"{contact.id} {contact.name} {contact.role} {contact.organisation}",
                re.IGNORECASE,
            )
        ),
        None,
    )
    return {
        "guidance": (
            "Gutsy does not calculate a replacement dose or change a taper. Follow the "
            "dispensing label and prescriber's plan, and contact your pharmacist or IBD team "
            "for advice specific to this course."
        ),
        "source": "NHS: How and when to take prednisolone tablets and liquid",
        "sourceUrl": (
            "https://www.nhs.uk/medicines/prednisolone/"
            "how-and-when-to-take-prednisolone-tablets-and-liquid/"
        ),
        "pharmacy": pharmacy.name if pharmacy else state.prescription.pharmacy,
        "phone": pharmacy.phone if pharmacy else "",
    }


@router.get("/experiment", response_model=Experiment)
def get_experiment(store: Store) -> Experiment:
    return store.get().experiment


@router.patch("/experiment", response_model=Experiment)
def update_experiment(payload: ExperimentPatch, store: Store) -> Experiment:
    _require_tracking_consent(store.get().profile)
    patch = payload.model_dump(exclude_none=True)

    def apply(state: dict[str, Any]) -> None:
        experiment = state["experiment"]
        definition_keys = ("title", "variable", "goal", "baseline", "outcome", "durationDays")
        definition_changed = any(
            key in patch and patch[key] != experiment[key] for key in definition_keys
        )
        has_progress = bool(
            experiment["status"] in {"active", "complete"}
            or experiment["day"] > 0
            or experiment.get("startDate")
            or experiment.get("observations")
        )
        if has_progress and definition_changed:
            label = "started"
            raise HTTPException(
                status_code=409,
                detail=(
                    f"The {label} experiment’s predefined question is immutable. Create a new "
                    "candidate so its prior observations keep their original meaning."
                ),
            )
        _patch(experiment, patch)
        if definition_changed:
            experiment.update(
                {
                    "reviewRequestMessageId": None,
                    "reviewApprovedAt": None,
                    "reviewApprovedBy": None,
                }
            )
        candidate = Experiment.model_validate(experiment)
        if experiment_requires_review(candidate, Profile.model_validate(state["profile"])):
            experiment["reviewRequired"] = True
        elif experiment.get("reviewRequired") is False:
            experiment.update(
                {
                    "reviewRequestMessageId": None,
                    "reviewApprovedAt": None,
                    "reviewApprovedBy": None,
                }
            )
        _refresh_clinician_summary(state)

    state, _ = store.mutate(
        apply,
        "Patient edited the one-variable experiment setup",
    )
    store.purge_deleted_payload_bytes()
    return state.experiment


@router.post("/experiment/request-review", response_model=Experiment)
def link_experiment_review_request(store: Store) -> Experiment:
    _require_tracking_consent(store.get().profile)

    def apply(state: dict[str, Any]) -> None:
        experiment = state["experiment"]
        candidate = Experiment.model_validate(experiment)
        if experiment_requires_review(candidate, Profile.model_validate(state["profile"])):
            experiment["reviewRequired"] = True
        if not experiment["reviewRequired"]:
            raise HTTPException(
                status_code=409,
                detail="This candidate does not currently require clinical review.",
            )
        if experiment["status"] not in {"suggested", "paused"}:
            raise HTTPException(
                status_code=409,
                detail="Link clinical review before the experiment is active or complete.",
            )
        if experiment.get("reviewApprovedAt"):
            raise HTTPException(
                status_code=409,
                detail=(
                    "The unchanged candidate is already approved; only a definition edit "
                    "invalidates that approval."
                ),
            )
        message = state["teamMessage"]
        if _experiment_review_request_message(state, str(message["id"])) is None:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Prepare a diet, nutrition or experiment review question in the current "
                    "team thread first."
                ),
            )
        if experiment.get("reviewRequestMessageId") not in {None, message["id"]}:
            raise HTTPException(
                status_code=409,
                detail="Edit the candidate definition before linking a different review thread.",
            )
        experiment["reviewRequestMessageId"] = message["id"]
        _refresh_clinician_summary(state)

    state, _ = store.mutate(
        apply,
        "Patient linked the unchanged diet-experiment candidate to a clinical review thread",
    )
    return state.experiment


@router.post("/experiment/simulate-clinical-review", response_model=Experiment)
def simulate_experiment_clinical_review(store: Store) -> Experiment:
    _require_tracking_consent(store.get().profile)
    _, _, approved_at = _now_parts()

    def apply(state: dict[str, Any]) -> None:
        experiment = state["experiment"]
        if not experiment["reviewRequired"]:
            raise HTTPException(status_code=409, detail="Clinical review is not required.")
        if experiment["status"] not in {"suggested", "paused"}:
            raise HTTPException(
                status_code=409,
                detail="Clinical approval is recorded before an experiment starts or resumes.",
            )
        if experiment.get("reviewApprovedAt"):
            raise HTTPException(
                status_code=409, detail="This unchanged candidate is already approved."
            )
        if _eligible_experiment_review_thread(state, experiment) is None:
            raise HTTPException(
                status_code=409,
                detail=(
                    "A linked team reply must explicitly say the reviewed candidate may proceed "
                    "before simulated approval is recorded."
                ),
            )
        experiment.update(
            {
                "reviewApprovedAt": approved_at,
                "reviewApprovedBy": SIMULATED_EXPERIMENT_REVIEWER,
            }
        )
        _refresh_clinician_summary(state)

    state, _ = store.mutate(
        apply,
        "Simulation: IBD-team approval recorded for the unchanged diet-experiment candidate",
        actor="clinical-messaging-simulation",
    )
    return state.experiment


@router.post("/experiment/start", response_model=Experiment)
def start_experiment(store: Store) -> Experiment:
    def apply(state: dict[str, Any]) -> None:
        day, clock, _ = _now_parts(state["profile"])
        _require_tracking_consent(state["profile"])
        experiment = state["experiment"]
        if experiment["status"] not in {"suggested", "paused"}:
            raise HTTPException(
                status_code=409,
                detail="Only an unstarted or paused experiment can be started.",
            )
        if (
            state["phase"] != "stable"
            or not state["phaseConfirmed"]
            or state.get("pendingPhase") is not None
        ):
            raise HTTPException(
                status_code=409,
                detail="Experiments pause while symptoms or treatment are changing.",
            )
        if (
            not all(
                str(experiment[key]).strip()
                for key in ("title", "variable", "goal", "baseline", "outcome")
            )
            or not _is_recorded_experiment_baseline(str(experiment["baseline"]))
        ):
            raise HTTPException(
                status_code=422,
                detail=(
                    "Define one variable, goal, an actually recorded pre-start baseline (not "
                    "an instruction), and outcome before starting the experiment."
                ),
            )
        candidate = Experiment.model_validate(experiment)
        if experiment_requires_review(candidate, Profile.model_validate(state["profile"])):
            experiment["reviewRequired"] = True
        if experiment["reviewRequired"] and (
            not experiment.get("reviewApprovedAt")
            or experiment.get("reviewApprovedBy") != SIMULATED_EXPERIMENT_REVIEWER
            or _eligible_experiment_review_thread(state, experiment) is None
        ):
            raise HTTPException(
                status_code=409,
                detail=(
                    "A linked dietitian or IBD-team reply and explicit simulated approval are "
                    "required before this candidate starts."
                ),
            )
        check_in_dates = _experiment_check_in_dates(state, experiment["id"])
        if experiment["day"] != len(check_in_dates):
            raise HTTPException(
                status_code=409,
                detail="Experiment progress must reconcile with its dated shared timeline.",
            )
        experiment["status"] = "active"
        if not experiment["startDate"]:
            experiment["startDate"] = day
        state["entries"].append(
            {
                "id": _next_id(state["entries"]),
                "date": day,
                "time": clock,
                "kind": "LIFE EVENT",
                "body": (
                    f"Diet experiment started: {experiment['title']}. One variable is "
                    f"{experiment['variable']}; pre-start baseline is {experiment['baseline']}; "
                    f"outcome is {experiment['outcome']}."
                ),
                "source": "manual",
                "flagged": False,
                "excluded": False,
                "structured": {
                    "experimentEvent": "start",
                    "experimentId": experiment["id"],
                    "day": experiment["day"],
                },
            }
        )
        _refresh_clinician_summary(state)

    state, _ = store.mutate(apply, "Patient started a stable-only one-variable diet experiment")
    return state.experiment


@router.post("/experiment/pause", response_model=Experiment)
def pause_experiment(store: Store) -> Experiment:
    _require_tracking_consent(store.get().profile)

    def apply(state: dict[str, Any]) -> None:
        if state["experiment"]["status"] != "active":
            raise HTTPException(status_code=409, detail="Only an active experiment can be paused.")
        state["experiment"]["status"] = "paused"
        _refresh_clinician_summary(state)

    state, _ = store.mutate(
        apply,
        "Paused diet experiment due to patient choice or confounding change",
    )
    return state.experiment


@router.post("/experiment/observation", response_model=Experiment)
def add_experiment_observation(payload: ObservationInput, store: Store) -> Experiment:
    _require_tracking_consent(store.get().profile)

    def apply(state: dict[str, Any]) -> None:
        day, clock, _ = _now_parts(state["profile"])
        experiment = state["experiment"]
        if experiment["status"] != "active":
            raise HTTPException(status_code=409, detail="Start the experiment before a check-in.")
        check_in_dates = _experiment_check_in_dates(state, experiment["id"])
        if day in check_in_dates:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Today’s experiment check-in is already recorded. The next check-in opens "
                    "on the next calendar day."
                ),
            )
        if experiment["day"] >= experiment["durationDays"]:
            raise HTTPException(status_code=409, detail="All planned experiment days are recorded.")
        if experiment["day"] != len(check_in_dates):
            raise HTTPException(
                status_code=409,
                detail="Experiment progress must reconcile with its dated shared timeline.",
            )
        experiment["day"] += 1
        observation = f"Day {experiment['day']}: {payload.observation}"
        experiment["observations"].append(observation)
        state["entries"].append(
            {
                "id": _next_id(state["entries"]),
                "date": day,
                "time": clock,
                "kind": "LIFE EVENT",
                "body": (
                    f"Diet experiment check-in — day {experiment['day']} of "
                    f"{experiment['durationDays']}: {payload.observation}"
                ),
                "source": "manual",
                "flagged": False,
                "excluded": False,
                "structured": {
                    "experimentEvent": "check-in",
                    "experimentId": experiment["id"],
                    "experimentObservation": payload.observation,
                    "day": experiment["day"],
                },
            }
        )
        _refresh_clinician_summary(state)

    state, _ = store.mutate(
        apply,
        "Added a personal experiment observation; no causal conclusion inferred",
    )
    return state.experiment


@router.post("/experiment/complete", response_model=Experiment)
def complete_experiment(payload: ExperimentCompletion, store: Store) -> Experiment:
    _require_tracking_consent(store.get().profile)

    def apply(state: dict[str, Any]) -> None:
        day, clock, _ = _now_parts(state["profile"])
        experiment = state["experiment"]
        check_in_dates = _experiment_check_in_dates(state, experiment["id"])
        if (
            experiment["status"] != "active"
            or experiment["day"] < experiment["durationDays"]
            or len(check_in_dates) < experiment["durationDays"]
            or experiment["day"] != len(check_in_dates)
        ):
            raise HTTPException(
                status_code=409,
                detail=(
                    "Complete every configured distinct daily check-in before recording the "
                    "personal outcome review."
                ),
            )
        review = f"Outcome review (personal observation, not proof): {payload.review}"
        experiment["observations"].append(review)
        experiment["status"] = "complete"
        state["entries"].append(
            {
                "id": _next_id(state["entries"]),
                "date": day,
                "time": clock,
                "kind": "LIFE EVENT",
                "body": f"Diet experiment completed: {experiment['title']}. {review}",
                "source": "manual",
                "flagged": False,
                "excluded": False,
                "structured": {
                    "experimentEvent": "complete",
                    "experimentId": experiment["id"],
                    "experimentObservation": payload.review,
                    "day": experiment["day"],
                },
            }
        )
        _refresh_clinician_summary(state)

    state, _ = store.mutate(
        apply,
        "Completed experiment; results remain personal observations, not proof",
    )
    return state.experiment


@router.get("/wearable", response_model=WearableSettings)
def get_wearable(store: Store) -> WearableSettings:
    return store.get().wearable


@router.patch("/wearable", response_model=WearableSettings)
def update_wearable(payload: WearablePatch, store: Store) -> WearableSettings:
    patch = payload.model_dump(exclude_none=True)
    if any(patch.get(field) is True for field in ("heartRate", "hrv", "sleep", "activity")):
        _require_tracking_consent(store.get().profile)
    state, _ = store.mutate(
        lambda value: _patch(value["wearable"], patch),
        "Updated optional wearable signal permissions",
    )
    return state.wearable


@router.post("/wearable/connect", response_model=WearableSettings)
def connect_wearable(payload: WearablePatch, store: Store) -> WearableSettings:
    patch = payload.model_dump(exclude_none=True)

    def apply(state: dict[str, Any]) -> None:
        _require_tracking_consent(state["profile"])
        _patch(state["wearable"], patch)
        state["wearable"]["connected"] = True

    state, _ = store.mutate(
        apply,
        "Patient connected the explicit wearable simulation",
        actor="wearable-simulation",
    )
    return state.wearable


@router.post("/wearable/simulate-sync", response_model=WearableSettings)
def sync_wearable(payload: WearableSync, store: Store) -> WearableSettings:
    def apply(state: dict[str, Any]) -> None:
        _require_tracking_consent(state["profile"])
        if not state["wearable"]["connected"]:
            raise HTTPException(status_code=409, detail="Connect the wearable simulation first.")
        denied_signals: list[str] = []
        if payload.restingHeartRate is not None and not state["wearable"]["heartRate"]:
            denied_signals.append("resting heart rate")
        if payload.heartRateVariabilityMs is not None and not state["wearable"]["hrv"]:
            denied_signals.append("heart-rate variability")
        if payload.sleepHours is not None and not state["wearable"]["sleep"]:
            denied_signals.append("sleep")
        if payload.activitySteps is not None and not state["wearable"]["activity"]:
            denied_signals.append("activity")
        if denied_signals:
            raise HTTPException(
                status_code=403,
                detail=f"Wearable permission is disabled for: {', '.join(denied_signals)}.",
            )
        day, clock, at = _now_parts(state["profile"])
        structured: dict[str, str | int | float | bool] = {"softSignal": True}
        body: list[str] = []
        if payload.restingHeartRate is not None:
            structured["restingHeartRate"] = payload.restingHeartRate
            body.append(f"resting HR {payload.restingHeartRate} bpm")
        if payload.heartRateVariabilityMs is not None:
            structured["heartRateVariabilityMs"] = payload.heartRateVariabilityMs
            body.append(f"HRV {payload.heartRateVariabilityMs:g} ms")
        if payload.sleepHours is not None:
            structured["sleepHours"] = payload.sleepHours
            body.append(f"sleep {payload.sleepHours:g} h")
        if payload.activitySteps is not None:
            structured["activitySteps"] = payload.activitySteps
            body.append(f"activity {payload.activitySteps} steps")
        if not body:
            raise HTTPException(status_code=422, detail="Provide at least one wearable signal.")
        state["entries"].append(
            {
                "id": _next_id(state["entries"]),
                "date": day,
                "time": clock,
                "kind": "FROM YOUR WATCH",
                "body": " · ".join(body) + " — supporting context only",
                "source": "wearable",
                "flagged": False,
                "excluded": False,
                "structured": structured,
            }
        )
        state["wearable"]["lastSync"] = at
        _invalidate_evidence_confirmation(state)
        _refresh_clinician_summary(state)

    state, _ = store.mutate(
        apply,
        "Simulation imported wearable soft signals; no standalone clinical trigger",
        actor="wearable-simulation",
    )
    return state.wearable


@router.post("/wearable/disconnect", response_model=WearableSettings)
def disconnect_wearable(store: Store) -> WearableSettings:
    def apply(state: dict[str, Any]) -> None:
        state["wearable"].update({"connected": False, "lastSync": None})

    state, _ = store.mutate(apply, "Patient disconnected wearable ingestion")
    return state.wearable


@router.get("/privacy", response_model=PrivacySettings)
def get_privacy(store: Store) -> PrivacySettings:
    return store.get().privacy


@router.patch("/privacy", response_model=PrivacySettings)
def update_privacy(payload: PrivacyPatch, store: Store) -> PrivacySettings:
    patch = payload.model_dump(exclude_none=True)
    current = store.get()
    removes_toilet_payload = patch.get("toiletPhotoConsent") is False and any(
        entry.photo and entry.photo.purpose == "toilet" and entry.photo.previewUrl
        for entry in current.entries
    )

    def apply(state: dict[str, Any]) -> None:
        _patch(state["privacy"], patch)
        if patch.get("toiletPhotoConsent") is False:
            for entry in state["entries"]:
                photo = entry.get("photo")
                if photo and photo["purpose"] == "toilet":
                    # Consent withdrawal deletes the attachment itself, not merely its bytes.
                    # Keeping an empty attachment would still expose the filename/metadata and
                    # cause browsers to render a broken empty-src image. The health record body
                    # remains, with an explicit marker explaining why media disappeared.
                    entry["photo"] = None
                    entry.setdefault("structured", {})["mediaRemovedAfterConsentWithdrawal"] = True

    state, _ = store.mutate(
        apply,
        "Updated privacy controls and applied consent withdrawal to toilet-photo payloads",
    )
    if removes_toilet_payload:
        store.purge_deleted_payload_bytes()
    return state.privacy


@router.post("/privacy/media/cleanup")
def cleanup_expired_media(
    store: Store,
    as_of: date | None = Query(default=None),
) -> dict[str, Any]:
    return run_media_retention_cleanup(
        store,
        as_of=as_of,
        actor="retention-job-simulation",
    )


@router.get("/summary")
def get_summary(store: Store) -> dict[str, Any]:
    state = store.get()
    return {
        "clinicianSummary": state.clinicianSummary,
        "clinicianSummaryEdited": state.clinicianSummaryEdited,
        "clinicianSummaryStale": state.clinicianSummaryStale,
    }


@router.patch("/summary")
def update_summary(payload: SummaryPatch, store: Store) -> dict[str, Any]:
    state, _ = store.mutate(
        lambda value: value.update(
            {
                "clinicianSummary": payload.clinicianSummary,
                "clinicianSummaryEdited": True,
                "clinicianSummaryStale": False,
            }
        ),
        "Patient edited the clinician-ready summary",
    )
    store.purge_deleted_payload_bytes()
    return {
        "clinicianSummary": state.clinicianSummary,
        "clinicianSummaryEdited": state.clinicianSummaryEdited,
        "clinicianSummaryStale": state.clinicianSummaryStale,
    }


@router.post("/summary/regenerate")
def regenerate_summary(store: Store) -> dict[str, Any]:
    def apply(state: dict[str, Any]) -> None:
        state["clinicianSummary"] = build_clinician_summary(DemoState.model_validate(state))
        state["clinicianSummaryEdited"] = False
        state["clinicianSummaryStale"] = False

    state, _ = store.mutate(
        apply,
        "Patient explicitly regenerated the clinician summary from included records",
    )
    store.purge_deleted_payload_bytes()
    return {
        "clinicianSummary": state.clinicianSummary,
        "clinicianSummaryEdited": state.clinicianSummaryEdited,
        "clinicianSummaryStale": state.clinicianSummaryStale,
    }


@router.get("/summary/export", response_class=PlainTextResponse)
def export_summary(store: Store) -> PlainTextResponse:
    summary = store.get().clinicianSummary
    return PlainTextResponse(
        summary,
        headers={"Content-Disposition": 'attachment; filename="gutsy-clinician-summary.txt"'},
    )


@router.get("/export")
def export_all_data(store: Store) -> JSONResponse:
    state = store.get()
    return JSONResponse(
        content={
            "exportedAt": utc_now(),
            "product": "Gutsy persisted demo",
            "schemaVersion": state.version,
            "data": state.model_dump(mode="json", by_alias=True),
            "domainRevisions": store.revisions(),
        },
        headers={"Content-Disposition": 'attachment; filename="gutsy-export.json"'},
    )


@router.get("/audit")
def audit(store: Store, limit: int = Query(100, ge=1, le=500)) -> dict[str, Any]:
    return {
        "patientVisible": [item.model_dump(mode="json") for item in store.get().audit],
        "domainRevisions": store.revisions(limit),
    }


@router.delete("/data", response_model=DemoState)
def delete_all_patient_data(store: Store) -> DemoState:
    return store.clear_patient_data()


@router.get("/integrations")
def integration_status(store: Store) -> dict[str, Any]:
    state = store.get()
    return {
        "runware": {
            "mode": "configured through /api/ai/status",
            "note": "All domain and safety paths function without a Runware key.",
        },
        "wearable": {
            "mode": "explicit simulation",
            "provider": state.wearable.provider,
            "connected": state.wearable.connected,
        },
        "calprotectinFulfilment": {
            "mode": "explicit simulation",
            "status": state.testOrder.status,
        },
        "clinicalMessaging": {
            "mode": "explicit simulation",
            "status": state.teamMessage.status,
        },
        "prescriberAndPharmacy": {
            "mode": "explicit simulation",
            "status": state.prescription.status,
        },
    }
