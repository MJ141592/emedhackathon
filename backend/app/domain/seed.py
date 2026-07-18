from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from app.domain.models import DemoState


def _taper_days() -> list[dict[str, Any]]:
    # Mirrors the canonical frontend fixture exactly. A prepared-but-uncollected
    # prescription cannot contain implied adherence.
    days: list[dict[str, Any]] = []
    for index in range(42):
        block = index // 7
        prescribed_blocks = [30, 25, 20, 15, 10, 5]
        days.append(
            {
                "day": index + 1,
                "doseMg": prescribed_blocks[block],
                "date": (date(2026, 7, 6) + timedelta(days=index)).isoformat(),
                "taken": False,
            }
        )
    return days


def _demo_chat_histories() -> dict[str, list[dict[str, Any]]]:
    """Return Rob's authored demo chapters as four independent conversations."""

    return {
        "stable": [
            {
                "id": 9101,
                "from": "penny",
                "createdAt": "2026-07-10T08:30:00.000Z",
                "text": (
                    "Morning, Matthew. Nothing unusual in your logs this week — how are you "
                    "feeling today?"
                ),
            },
            {
                "id": 9102,
                "from": "me",
                "createdAt": "2026-07-10T08:42:00.000Z",
                "text": "Feeling good. Porridge and a coffee for breakfast.",
            },
            {
                "id": 9103,
                "from": "penny",
                "createdAt": "2026-07-10T08:42:20.000Z",
                "category": "recorded fact",
                "text": (
                    "Logged: porridge and coffee, 10 July. Have a good day — I’ll stay out of "
                    "your way."
                ),
            },
            {
                "id": 9104,
                "from": "me",
                "createdAt": "2026-07-12T13:05:00.000Z",
                "text": "Chicken salad for lunch, and I managed a 5k run this morning.",
            },
            {
                "id": 9105,
                "from": "penny",
                "createdAt": "2026-07-12T13:06:00.000Z",
                "category": "recorded fact",
                "text": (
                    "Both logged. Your resting heart rate is right on your 58 bpm baseline and "
                    "sleep is averaging 8h 30m — everything looks steady. Keep doing what "
                    "you’re doing."
                ),
            },
        ],
        "watch": [
            {
                "id": 9201,
                "from": "penny",
                "createdAt": "2026-07-16T08:05:00.000Z",
                "category": "possible pattern",
                "text": (
                    "Morning, Matthew. Your watch showed a raised overnight heart rate, and "
                    "yesterday you logged looser stools than usual. Any cramping or urgency "
                    "this morning?"
                ),
            },
            {
                "id": 9202,
                "from": "me",
                "createdAt": "2026-07-16T08:20:00.000Z",
                "text": (
                    "A bit crampy actually, and I’ve had to rush to the loo twice already."
                ),
            },
            {
                "id": 9203,
                "from": "penny",
                "createdAt": "2026-07-16T08:21:00.000Z",
                "text": (
                    "Thanks for telling me — I’ve recorded both. Two more questions: how would "
                    "you rate the pain out of 10, and have you noticed any blood?"
                ),
            },
            {
                "id": 9204,
                "from": "me",
                "createdAt": "2026-07-16T08:24:00.000Z",
                "text": "Pain’s about a 4. And yes, a small amount of blood this morning.",
            },
            {
                "id": 9205,
                "from": "penny",
                "createdAt": "2026-07-17T08:30:00.000Z",
                "category": "recorded fact",
                "text": (
                    "You’ve now had two days of change from your baseline, so under your care "
                    "plan I’ve ordered a calprotectin home test. It’s being delivered by Royal "
                    "Mail and should arrive tomorrow — post the sample back in the prepaid "
                    "envelope and I’ll share the result as soon as it’s in."
                ),
            },
        ],
        "flare": [
            {
                "id": 9301,
                "from": "penny",
                "createdAt": "2026-07-18T09:10:00.000Z",
                "category": "recorded fact",
                "text": (
                    "Your calprotectin result has come back raised at 410 µg/g, and your "
                    "symptoms haven’t settled. I’ve shared this week’s picture with your IBD "
                    "team at St Mary’s and asked them to review it today."
                ),
            },
            {
                "id": 9302,
                "from": "me",
                "createdAt": "2026-07-18T09:25:00.000Z",
                "text": "Ok. What happens now?",
            },
            {
                "id": 9303,
                "from": "penny",
                "createdAt": "2026-07-18T11:40:00.000Z",
                "category": "recorded fact",
                "text": (
                    "Jade from your IBD team has reviewed everything with Dr Ferreira. He’s "
                    "prescribed a course of prednisolone (a steroid) to settle things down, "
                    "following the rescue plan you agreed with him."
                ),
            },
            {
                "id": 9304,
                "from": "penny",
                "createdAt": "2026-07-18T15:20:00.000Z",
                "category": "recorded fact",
                "text": (
                    "Your prescription is ready to collect at Wellfield Pharmacy on Marikina "
                    "Road — they’re open until 6pm today. Start with 30 mg (6 × 5 mg tablets) "
                    "with breakfast tomorrow; I’ll remind you each morning."
                ),
            },
            {
                "id": 9305,
                "from": "me",
                "createdAt": "2026-07-18T17:05:00.000Z",
                "text": "Picked them up, thanks.",
            },
        ],
        "recovery": [
            {
                "id": 9401,
                "from": "penny",
                "createdAt": "2026-07-29T08:00:00.000Z",
                "category": "recorded fact",
                "text": (
                    "Morning, Matthew — taper day 12. Today’s dose steps down to 25 mg (5 × 5 "
                    "mg with breakfast). Next step: 20 mg on Monday."
                ),
            },
            {
                "id": 9402,
                "from": "me",
                "createdAt": "2026-07-29T08:15:00.000Z",
                "text": "Done. Is it normal to feel a bit wired on these?",
            },
            {
                "id": 9403,
                "from": "penny",
                "createdAt": "2026-07-29T08:16:00.000Z",
                "category": "general information",
                "text": (
                    "Yes — restlessness and lighter sleep are common on steroids, and they "
                    "usually ease as the dose steps down. Don’t stop suddenly, even on a good "
                    "day. The encouraging part: your bowel logs are back near baseline at 3 a "
                    "day and pain is down to 2/10."
                ),
            },
            {
                "id": 9404,
                "from": "me",
                "createdAt": "2026-07-29T08:18:00.000Z",
                "text": "When will I be off them completely?",
            },
            {
                "id": 9405,
                "from": "penny",
                "createdAt": "2026-07-29T08:19:00.000Z",
                "category": "general information",
                "text": (
                    "Your prescribed schedule steps down 5 mg each week and finishes on 16 "
                    "August — about two and a half weeks to go. If symptoms come back at any "
                    "step, tell me straight away and I’ll flag it to your team."
                ),
            },
        ],
    }


def build_demo_state() -> DemoState:
    """Return the canonical v2 Matthew fixture shared with the frontend."""

    state = DemoState.model_validate(
        {
            "version": 2,
            "phase": "watch",
            "phaseConfirmed": False,
            "messages": [],
            "profileProposals": [],
            "entries": [
                {
                    "id": 1,
                    "date": "2026-07-17",
                    "time": "07:40",
                    "kind": "BOWEL MOVEMENT",
                    "body": "Bristol type 6, urgency, small amount of blood",
                    "source": "manual",
                    "flagged": True,
                    "structured": {
                        "bristol": 6,
                        "urgency": True,
                        "blood": "small",
                        "mucus": False,
                        "nightWaking": True,
                        "pain": 4,
                    },
                },
                {
                    "id": 2,
                    "date": "2026-07-17",
                    "time": "08:00",
                    "kind": "FROM YOUR WATCH",
                    "body": (
                        "Resting HR 64 bpm · HRV 38 ms · sleep 5 h 10 m — supporting "
                        "context only"
                    ),
                    "source": "wearable",
                    "structured": {
                        "restingHeartRate": 64,
                        "heartRateVariabilityMs": 38,
                        "sleepHours": 5.17,
                        "softSignal": True,
                    },
                },
                {
                    "id": 3,
                    "date": "2026-07-17",
                    "time": "08:05",
                    "kind": "Penny noticed",
                    "body": (
                        "Several included records across 16–17 July differ from baseline: two "
                        "Bristol type 6 bowel logs with urgency, one with a small amount of blood, "
                        "pain up to 5/10 with high fatigue, and a resting heart rate of 64 bpm. "
                        "Confirm the source records before acting."
                    ),
                    "source": "penny",
                },
                {
                    "id": 4,
                    "date": "2026-07-16",
                    "time": "19:30",
                    "kind": "MEAL",
                    "body": "Lamb madras, naan, two beers — out with friends",
                    "source": "manual",
                    "structured": {"portion": "usual", "hydration": "two beers"},
                },
                {
                    "id": 5,
                    "date": "2026-07-16",
                    "time": "22:15",
                    "kind": "PAIN",
                    "body": "Cramping, lower right, 5/10 · fatigue high",
                    "source": "manual",
                    "structured": {"pain": 5, "site": "lower right", "fatigue": "high"},
                },
                {
                    "id": 6,
                    "date": "2026-07-16",
                    "time": "21:10",
                    "kind": "BOWEL MOVEMENT",
                    "body": "Bristol type 6 with urgency",
                    "source": "chat",
                    "structured": {"bristol": 6, "urgency": True},
                },
                {
                    "id": 7,
                    "date": "2026-07-13",
                    "time": "23:50",
                    "kind": "LIFE EVENT",
                    "body": "Night out — around six drinks, late night and takeaway",
                    "source": "manual",
                },
                {
                    "id": 8,
                    "date": "2026-07-12",
                    "time": "09:00",
                    "kind": "MEDICATION",
                    "body": "Azathioprine 100 mg taken",
                    "source": "manual",
                    "structured": {"taken": True, "doseMg": 100},
                },
                *[
                    {
                        "id": 20 + index,
                        "date": (date(2026, 7, 8) + timedelta(days=index)).isoformat(),
                        "time": "08:30",
                        "kind": "LIFE EVENT",
                        "body": (
                            f"Diet experiment check-in — day {index + 1} of 14: "
                            "Personal morning-urgency observation recorded."
                        ),
                        "source": "manual",
                        "structured": {
                            "experimentEvent": "check-in",
                            "experimentId": "EXP-12",
                            "experimentObservation": (
                                "Personal morning-urgency observation recorded."
                            ),
                            "day": index + 1,
                            "durationDays": 14,
                        },
                    }
                    for index in range(9)
                ],
            ],
            "profile": {
                "name": "Matthew Johnson",
                "dateOfBirth": "1992-03-18",
                "diagnosis": "Crohn’s disease",
                "subtype": "Ileocolonic",
                "diagnosedYear": "2016",
                "extent": "Terminal ileum and colon",
                "surgeries": "Ileocecal resection, 2019",
                "conditions": "Osteopenia; anxiety",
                "allergies": "Penicillin — rash",
                "immunosuppressed": True,
                "familyHistory": "Maternal aunt with Crohn’s",
                "usualBowel": "2–3 formed bowel movements/day (2.8 average)",
                "usualPain": "1–2/10",
                "usualHeartRate": "58 bpm resting",
                "usualSleep": "7 hours",
                "dietaryNeeds": "No formal exclusions; prefers oat milk",
                "currentMedicines": "Azathioprine 100 mg daily",
                "pastMedicines": "Mesalazine — stopped 2018, limited response",
                "carePlan": (
                    "Contact St Mary’s IBD advice line if symptoms rise for 3 days, blood "
                    "increases, or night waking begins."
                ),
                "address": "24 Marikina Road, London",
                "postcode": "W2 1NY",
                "timeZone": "Europe/London",
                "adultEligibilityConfirmed": True,
                "healthDataConsent": True,
                "consentVersion": "demo-v1",
                "consentRecordedAt": "2026-07-01T09:00:00+00:00",
                "onboardingComplete": True,
            },
            "contacts": [
                {
                    "id": "jade",
                    "initials": "JO",
                    "name": "Jade Johnson",
                    "role": "IBD Clinical Nurse Specialist",
                    "organisation": "St Mary’s IBD service",
                    "phone": "020 7946 0000",
                },
                {
                    "id": "rui",
                    "initials": "RF",
                    "name": "Dr Rui Ferreira",
                    "role": "Consultant gastroenterologist",
                    "organisation": "St Mary’s Hospital",
                    "phone": "020 7946 0100",
                },
                {
                    "id": "pharmacy",
                    "initials": "WP",
                    "name": "Wellfield Pharmacy",
                    "role": "Nominated pharmacy",
                    "organisation": "Marikina Road",
                    "phone": "020 7946 0200",
                },
            ],
            "trustedSupporter": {
                "enabled": False,
                "name": "",
                "relationship": "",
                "canViewSummary": False,
                "canSeeReminders": False,
                "canHelpLog": False,
            },
            "testOrder": {
                "id": "FC-2481",
                "status": "prepared",
                "addressConfirmed": False,
                "consent": False,
                "clinicalOwner": "St Mary’s IBD service (simulated clinical owner)",
                "eligibilityRule": "IBD-WATCH-CALPROTECTIN-DEMO-v1",
                "eligibilityReason": (
                    "Configured sustained-change rule: at least two current included clinical "
                    "signals across recorded days after patient evidence review; never an "
                    "LLM- or image-only decision."
                ),
                "statusUpdatedAt": "2026-07-17T08:05:00+00:00",
            },
            "teamMessage": {
                "id": "MSG-104",
                "subject": "Recent recorded symptoms for Matthew Johnson",
                "body": (
                    "Matthew has two included bowel records across 16–17 July; both record Bristol "
                    "type 6 with urgency, and one records a small amount of blood and night "
                    "waking. A separate record notes pain up to 5/10 with high fatigue. The "
                    "latest included watch record is resting heart rate 64 bpm versus a recorded "
                    "58 bpm baseline, with 5 h 10 m sleep versus a recorded usual 7 hours. These "
                    "records do not establish total daily bowel frequency. A home calprotectin "
                    "test is prepared but not yet ordered. Please review the attached entries "
                    "and advise on the agreed pathway."
                ),
                "status": "draft",
                "statusUpdatedAt": "2026-07-17T08:05:00+00:00",
                "clinicalOwner": "St Mary’s IBD service (simulated clinical owner)",
                "notificationRule": "IBD-CHANGE-NOTIFY-DEMO-v1",
                "notificationReason": (
                    "Patient-reviewed sustained-change evidence prepared a contact-first draft; "
                    "nothing is sent until the patient reviews and approves every word."
                ),
                "expectedResponse": "Within one working day",
            },
            "teamMessageHistory": [],
            "prescription": {
                "status": "prepared",
                "medicine": "Prednisolone course — dose set by prescriber",
                "prescriber": "Dr Rui Ferreira",
                "pharmacy": "Wellfield Pharmacy",
                "clinicalOwner": "Dr Rui Ferreira (simulated prescribing owner)",
                "eligibilityRule": "IBD-RESCUE-PRED-DEMO-v1",
                "eligibilityReason": (
                    "A documented rescue pathway still requires confirmed Flare support, an "
                    "included raised objective result and explicit prescriber authorisation."
                ),
                "rescuePlanEligible": True,
                "reviewAfterHours": 24,
            },
            "taper": {
                "verified": True,
                "medicine": "Prednisolone",
                "prescribedBy": "Dr Rui Ferreira",
                "currentDay": 12,
                "days": _taper_days(),
                "missedDays": [],
                "sideEffects": [],
                "checkInComplete": False,
            },
            "experiment": {
                "id": "EXP-12",
                "title": "Oat milk instead of dairy milk",
                "variable": "Milk choice only",
                "goal": "See whether morning urgency changes",
                "baseline": "Morning urgency score 3/10 before day 1 (patient-entered)",
                "outcome": "Morning urgency score",
                "startDate": "2026-07-08",
                "durationDays": 14,
                "day": 9,
                "status": "paused",
                "observations": [
                    f"Day {index + 1}: Personal morning-urgency observation recorded."
                    for index in range(9)
                ],
                "reviewRequired": False,
                "reviewRequestMessageId": None,
                "reviewApprovedAt": None,
                "reviewApprovedBy": None,
            },
            "wearable": {
                "provider": "Apple Health",
                "connected": True,
                "heartRate": True,
                "hrv": True,
                "sleep": True,
                "activity": True,
                "lastSync": "Today, 08:00",
            },
            "privacy": {
                "photoRetentionDays": 30,
                "toiletPhotoConsent": False,
                "assistantProfileAccess": True,
                "assistantJournalAccess": True,
                "assistantCareAccess": True,
                "assistantConversationAccess": True,
                "secondaryUseConsent": False,
                "discreetNotifications": True,
                "notificationBudget": "balanced",
            },
            "clinicianSummary": (
                "Matthew has two included bowel records across 16–17 July; both record "
                "Bristol type "
                "6 with urgency, and one records a small amount of blood and night waking. A "
                "separate record notes pain up to 5/10 with high fatigue. The latest included "
                "watch record is resting heart rate 64 bpm versus a recorded 58 bpm baseline, "
                "with 5 h 10 m sleep versus a recorded usual 7 hours. These records do not "
                "establish total daily bowel frequency. A home calprotectin test has been "
                "prepared but requires Matthew’s confirmation. Current treatment: azathioprine "
                "100 mg daily. The prepared prednisolone schedule has no doses marked taken or "
                "missed. No medication change has been made by Gutsy."
            ),
            "clinicianSummaryEdited": False,
            "clinicianSummaryStale": False,
            "audit": [
                {
                    "id": 1,
                    "at": "17 Jul, 08:05",
                    "action": (
                        "Penny surfaced several included records across two recorded days for "
                        "patient review."
                    ),
                }
            ],
        }
    )
    histories = _demo_chat_histories()
    snapshot = state.model_dump(mode="json", by_alias=True)
    snapshot.update({"messages": histories["watch"], "chatHistories": histories})
    return DemoState.model_validate(snapshot)


def build_empty_state() -> DemoState:
    state = build_demo_state().model_dump(mode="json", by_alias=True)
    state["version"] = 2
    state["phase"] = "stable"
    state["pendingPhase"] = None
    state["phaseConfirmed"] = False
    state["messages"] = []
    state["profileProposals"] = []
    state["chatHistories"] = {}
    state["profileProposalsByPhase"] = {}
    state["entries"] = []
    state["audit"] = [
        {
            "id": 1,
            "at": "Just now",
            "action": "All persisted demo data was deleted by the patient.",
        }
    ]
    state["profile"].update(
        {
            "name": "",
            "dateOfBirth": "",
            "diagnosis": "",
            "subtype": "",
            "diagnosedYear": "",
            "extent": "",
            "surgeries": "",
            "conditions": "",
            "allergies": "",
            "familyHistory": "",
            "usualBowel": "",
            "usualPain": "",
            "usualHeartRate": "",
            "usualSleep": "",
            "dietaryNeeds": "",
            "currentMedicines": "",
            "pastMedicines": "",
            "carePlan": "",
            "address": "",
            "postcode": "",
            "timeZone": "UTC",
            "adultEligibilityConfirmed": False,
            "healthDataConsent": False,
            "consentVersion": "demo-v1",
            "consentRecordedAt": None,
            "immunosuppressed": False,
            "onboardingComplete": False,
        }
    )
    state["contacts"] = []
    state["trustedSupporter"] = {
        "enabled": False,
        "name": "",
        "relationship": "",
        "canViewSummary": False,
        "canSeeReminders": False,
        "canHelpLog": False,
    }
    state["testOrder"] = {
        "id": "Not ordered",
        "status": "prepared",
        "addressConfirmed": False,
        "consent": False,
        "clinicalOwner": "Not configured — test ordering is unavailable",
        "eligibilityRule": "Not configured",
        "eligibilityReason": "No governed eligibility decision has been recorded.",
    }
    state["teamMessage"] = {
        "id": "No message",
        "subject": "No clinician message",
        "body": "No draft has been prepared.",
        "status": "draft",
        "clinicalOwner": "Not configured — clinician messaging is unavailable",
        "notificationRule": "Not configured",
        "notificationReason": "No governed notification rationale has been recorded.",
        "expectedResponse": "Not configured",
    }
    state["teamMessageHistory"] = []
    state["prescription"] = {
        "status": "not-started",
        "medicine": "",
        "prescriber": "",
        "pharmacy": "",
        "clinicalOwner": "Not configured — rescue prescribing is unavailable",
        "eligibilityRule": "Not configured",
        "eligibilityReason": "No governed rescue-pathway eligibility has been recorded.",
        "rescuePlanEligible": False,
        "reviewAfterHours": 24,
    }
    state["taper"] = {
        "verified": False,
        "medicine": "",
        "prescribedBy": "",
        "currentDay": 1,
        "days": [],
        "missedDays": [],
        "sideEffects": [],
        "checkInComplete": False,
    }
    state["experiment"] = {
        "id": "No experiment",
        "title": "No active experiment",
        "variable": "",
        "goal": "",
        "baseline": "",
        "outcome": "",
        "startDate": "",
        "durationDays": 1,
        "day": 0,
        "status": "suggested",
        "observations": [],
        "reviewRequired": False,
        "reviewRequestMessageId": None,
        "reviewApprovedAt": None,
        "reviewApprovedBy": None,
    }
    state["clinicianSummary"] = ""
    state["clinicianSummaryEdited"] = False
    state["clinicianSummaryStale"] = False
    state["wearable"].update(
        {
            "connected": False,
            "heartRate": False,
            "sleep": False,
            "activity": False,
            "lastSync": None,
        }
    )
    state["privacy"].update(
        {
            "toiletPhotoConsent": False,
            "assistantProfileAccess": False,
            "assistantJournalAccess": False,
            "assistantCareAccess": False,
            "assistantConversationAccess": False,
            "secondaryUseConsent": False,
            "notificationBudget": "low",
        }
    )
    state.pop("safetyAlert", None)
    return DemoState.model_validate(state)
