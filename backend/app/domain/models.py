from __future__ import annotations

import base64
import binascii
import re
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

PhaseId = Literal["stable", "watch", "flare", "recovery"]
EntrySource = Literal["manual", "chat", "wearable", "penny", "care", "supporter"]
EntryKind = Literal[
    "BOWEL MOVEMENT",
    "MEAL",
    "PAIN",
    "FATIGUE",
    "WELLBEING",
    "LIFE EVENT",
    "MEDICATION",
    "FROM YOUR WATCH",
    "TEST RESULT",
    "Penny noticed",
]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


_PHOTO_DATA_URL = re.compile(r"^data:image/(jpeg|png|heic);base64,([A-Za-z0-9+/]*={0,2})$")
_MAX_PHOTO_BYTES = 8 * 1024 * 1024


def _validate_journal_date(value: str | None) -> str | None:
    if value is None:
        return None
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("Journal dates must use YYYY-MM-DD.")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as error:
        raise ValueError("Journal dates must be valid calendar dates.") from error
    if parsed < date(1900, 1, 1) or parsed > date.today() + timedelta(days=1):
        raise ValueError("Journal dates must be between 1900-01-01 and tomorrow.")
    return value


def _validate_journal_time(value: str | None) -> str | None:
    if value is None:
        return None
    if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value):
        raise ValueError("Journal times must use 24-hour HH:MM.")
    return value


def patient_calendar_date(time_zone: str, instant: datetime | None = None) -> date:
    """Resolve eligibility and other date-only rules on the patient’s calendar."""

    value = instant or datetime.now(UTC)
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(ZoneInfo(time_zone)).date()


class PhotoAttachment(StrictModel):
    name: str = Field(min_length=1, max_length=200)
    # The demo frontend persists local photo previews as data URLs (up to an 8 MiB file).
    # Empty after retention cleanup; metadata remains so the base health entry stays useful.
    previewUrl: str = Field(max_length=12_000_000)
    purpose: Literal["meal", "toilet"]
    retentionDays: Literal[7, 30, 90] = 30
    consented: bool
    derivedObservation: str | None = Field(default=None, max_length=1_000)

    @field_validator("previewUrl")
    @classmethod
    def require_bounded_local_image_data(cls, value: str) -> str:
        # Retention cleanup deliberately keeps metadata with an empty payload. Live payloads
        # must stay local to the record: remote/SVG URLs could leak sensitive page visits.
        if value == "":
            return value
        match = _PHOTO_DATA_URL.fullmatch(value)
        if match is None:
            raise ValueError("Photos must be local JPEG, PNG or HEIC base64 data URLs.")
        try:
            decoded = base64.b64decode(match.group(2), validate=True)
        except (binascii.Error, ValueError) as error:
            raise ValueError("Photo data must contain valid base64.") from error
        if not decoded:
            raise ValueError("Photo data cannot be empty.")
        if len(decoded) > _MAX_PHOTO_BYTES:
            raise ValueError("Photos must be no larger than 8 MiB.")
        return value


class JournalEntry(StrictModel):
    id: int
    date: str
    time: str
    kind: EntryKind
    body: str = Field(min_length=1, max_length=4_000)
    source: EntrySource
    flagged: bool = False
    excluded: bool = False
    structured: dict[str, str | int | float | bool] = Field(default_factory=dict)
    photo: PhotoAttachment | None = None

    _date_is_valid = field_validator("date")(_validate_journal_date)
    _time_is_valid = field_validator("time")(_validate_journal_time)


class JournalDraft(StrictModel):
    date: str | None = None
    time: str | None = None
    kind: EntryKind
    body: str = Field(min_length=1, max_length=4_000)
    source: EntrySource = "manual"
    flagged: bool = False
    excluded: bool = False
    structured: dict[str, str | int | float | bool] = Field(default_factory=dict)
    photo: PhotoAttachment | None = None

    _date_is_valid = field_validator("date")(_validate_journal_date)
    _time_is_valid = field_validator("time")(_validate_journal_time)


class JournalPatch(StrictModel):
    date: str | None = None
    time: str | None = None
    kind: EntryKind | None = None
    body: str | None = Field(default=None, min_length=1, max_length=4_000)
    source: EntrySource | None = None
    flagged: bool | None = None
    excluded: bool | None = None
    structured: dict[str, str | int | float | bool] | None = None
    photo: PhotoAttachment | None = None

    _date_is_valid = field_validator("date")(_validate_journal_date)
    _time_is_valid = field_validator("time")(_validate_journal_time)


class EvidenceSource(StrictModel):
    entryId: int | None = None
    messageId: int | None = None
    url: str | None = Field(default=None, max_length=2_048, pattern=r"^https://")
    target: Literal["profile", "care", "trends", "privacy"] | None = None
    label: str
    date: str
    detail: str
    type: Literal["fact", "pattern", "guidance"]
    excluded: bool = False


class ChatMessage(StrictModel):
    id: int
    from_: Literal["penny", "me"] = Field(alias="from", serialization_alias="from")
    text: str = Field(min_length=1, max_length=8_000)
    createdAt: str
    sources: list[EvidenceSource] = Field(default_factory=list)
    category: Literal["recorded fact", "possible pattern", "general information"] | None = None


class ChatInput(StrictModel):
    text: str = Field(min_length=1, max_length=8_000)


class ChatMessagePatch(StrictModel):
    text: str = Field(min_length=1, max_length=8_000)


ProfileProposalField = Literal["surgeries", "conditions", "allergies", "pastMedicines"]


class ProfileProposalDraft(StrictModel):
    field: ProfileProposalField
    value: str = Field(min_length=1, max_length=4_000)


class ProfileProposal(ProfileProposalDraft):
    id: int
    sourceMessageId: int
    status: Literal["pending", "accepted", "dismissed"]
    createdAt: str


class ProfileProposalResolution(StrictModel):
    status: Literal["accepted", "dismissed"]


class Profile(StrictModel):
    name: str
    dateOfBirth: str
    diagnosis: str
    subtype: str
    diagnosedYear: str
    extent: str
    surgeries: str
    conditions: str
    allergies: str
    immunosuppressed: bool
    familyHistory: str
    usualBowel: str
    usualPain: str
    usualHeartRate: str
    usualSleep: str
    dietaryNeeds: str
    currentMedicines: str
    pastMedicines: str
    carePlan: str
    address: str
    postcode: str
    timeZone: str = "UTC"
    adultEligibilityConfirmed: bool = True
    healthDataConsent: bool = True
    consentVersion: str = "demo-v1"
    consentRecordedAt: str | None = None
    onboardingComplete: bool

    @field_validator("timeZone")
    @classmethod
    def require_iana_time_zone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as error:
            raise ValueError("timeZone must be a recognised IANA time-zone name.") from error
        return value

    @model_validator(mode="after")
    def require_adult_for_completed_onboarding(self) -> Profile:
        if not self.onboardingComplete:
            return self
        if not self.adultEligibilityConfirmed or not self.healthDataConsent:
            raise ValueError(
                "Completed onboarding requires recorded adult eligibility and health-data consent."
            )
        if not all(
            value.strip()
            for value in (
                self.name,
                self.diagnosis,
                self.usualBowel,
                self.usualPain,
                self.carePlan,
                self.address,
                self.postcode,
            )
        ):
            raise ValueError(
                "Completed onboarding requires identity, diagnosis, bowel and pain baselines, "
                "a care plan, and delivery address."
            )
        try:
            born = date.fromisoformat(self.dateOfBirth)
        except ValueError as error:
            raise ValueError("A valid date of birth is required for onboarding.") from error
        today = patient_calendar_date(self.timeZone)
        age = today.year - born.year - ((today.month, today.day) < (born.month, born.day))
        if age < 18:
            raise ValueError("Gutsy onboarding is currently for adults aged 18 or over.")
        return self


class ProfilePatch(StrictModel):
    name: str | None = None
    dateOfBirth: str | None = None
    diagnosis: str | None = None
    subtype: str | None = None
    diagnosedYear: str | None = None
    extent: str | None = None
    surgeries: str | None = None
    conditions: str | None = None
    allergies: str | None = None
    immunosuppressed: bool | None = None
    familyHistory: str | None = None
    usualBowel: str | None = None
    usualPain: str | None = None
    usualHeartRate: str | None = None
    usualSleep: str | None = None
    dietaryNeeds: str | None = None
    currentMedicines: str | None = None
    pastMedicines: str | None = None
    carePlan: str | None = None
    address: str | None = None
    postcode: str | None = None
    timeZone: str | None = None
    adultEligibilityConfirmed: bool | None = None
    healthDataConsent: bool | None = None
    consentVersion: str | None = None
    consentRecordedAt: str | None = None
    onboardingComplete: bool | None = None


class CareContact(StrictModel):
    id: str
    initials: str
    name: str
    role: str
    organisation: str
    phone: str


class CareContactCreate(StrictModel):
    id: str = Field(min_length=1, max_length=100, pattern=r"^[a-z0-9-]+$")
    initials: str = Field(min_length=1, max_length=4)
    name: str = Field(min_length=1, max_length=200)
    role: str = Field(min_length=1, max_length=200)
    organisation: str = Field(min_length=1, max_length=200)
    phone: str = Field(min_length=1, max_length=50)


class CareContactPatch(StrictModel):
    initials: str | None = Field(default=None, min_length=1, max_length=4)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    role: str | None = Field(default=None, min_length=1, max_length=200)
    organisation: str | None = Field(default=None, min_length=1, max_length=200)
    phone: str | None = Field(default=None, min_length=1, max_length=50)


class TrustedSupporter(StrictModel):
    enabled: bool
    name: str = Field(max_length=200)
    relationship: str = Field(max_length=100)
    canViewSummary: bool
    canSeeReminders: bool
    canHelpLog: bool
    accessCode: str | None = Field(default=None, min_length=8, max_length=64)
    accessCreatedAt: str | None = None


class TrustedSupporterPatch(StrictModel):
    enabled: bool | None = None
    name: str | None = Field(default=None, max_length=200)
    relationship: str | None = Field(default=None, max_length=100)
    canViewSummary: bool | None = None
    canSeeReminders: bool | None = None
    canHelpLog: bool | None = None


class SupporterAccessInput(StrictModel):
    accessCode: str = Field(min_length=8, max_length=64)


class SupporterLogInput(SupporterAccessInput):
    text: str = Field(min_length=1, max_length=4_000)


class SupporterPermissions(StrictModel):
    canViewSummary: bool
    canSeeReminders: bool
    canHelpLog: bool


class SupporterView(StrictModel):
    simulation: Literal[True] = True
    patientFirstName: str
    supporterName: str
    relationship: str
    permissions: SupporterPermissions
    summary: str | None = None
    reminders: list[str] | None = None
    reviewableLogs: list[JournalEntry] | None = None
    notice: str


class SupporterLogResult(StrictModel):
    entries: list[JournalEntry]
    view: SupporterView


class HistoryValue(StrictModel):
    value: str = Field(max_length=4_000)


class TestOrder(StrictModel):
    id: str
    status: Literal[
        "prepared",
        "ordered",
        "shipped",
        "delivered",
        "sampled",
        "posted",
        "lab",
        "result",
        "shared",
    ]
    addressConfirmed: bool
    consent: bool
    deliveryAddress: str | None = Field(default=None, max_length=500)
    deliveryPostcode: str | None = Field(default=None, max_length=100)
    confirmedAt: str | None = None
    clinicalOwner: str = Field(
        default="Not configured",
        min_length=1,
        max_length=300,
    )
    eligibilityRule: str = Field(
        default="Not configured",
        min_length=1,
        max_length=300,
    )
    eligibilityReason: str = Field(
        default="No governed eligibility decision has been recorded.",
        min_length=1,
        max_length=2_000,
    )
    statusUpdatedAt: str | None = None
    result: int | None = Field(default=None, ge=0)
    resultNote: str | None = Field(default=None, max_length=2_000)


class TestOrderPatch(StrictModel):
    addressConfirmed: bool | None = None
    consent: bool | None = None


class TestResultInput(StrictModel):
    result: int = Field(ge=0, le=10_000)


class TestAdvanceInput(StrictModel):
    status: Literal["shipped", "delivered", "sampled", "posted", "lab"] | None = None


class TeamMessage(StrictModel):
    id: str
    subject: str = Field(min_length=1, max_length=300)
    body: str = Field(min_length=1, max_length=8_000)
    status: Literal["draft", "sent", "read", "replied"]
    sentAt: str | None = None
    statusUpdatedAt: str | None = None
    clinicalOwner: str = Field(default="Not configured", min_length=1, max_length=300)
    notificationRule: str = Field(default="Not configured", min_length=1, max_length=300)
    notificationReason: str = Field(
        default="No governed notification rationale has been recorded.",
        min_length=1,
        max_length=2_000,
    )
    expectedResponse: str
    reply: str | None = Field(default=None, max_length=8_000)


class TeamMessagePatch(StrictModel):
    subject: str | None = Field(default=None, min_length=1, max_length=300)
    body: str | None = Field(default=None, min_length=1, max_length=8_000)


class ReplyInput(StrictModel):
    reply: str = Field(min_length=1, max_length=8_000)


class PrescriptionFlow(StrictModel):
    status: Literal["not-started", "prepared", "requested", "approved", "ready", "collected"]
    medicine: str
    prescriber: str
    pharmacy: str
    clinicalOwner: str = Field(default="Not configured", min_length=1, max_length=300)
    eligibilityRule: str = Field(default="Not configured", min_length=1, max_length=300)
    eligibilityReason: str = Field(
        default="No governed rescue-pathway eligibility has been recorded.",
        min_length=1,
        max_length=2_000,
    )
    rescuePlanEligible: bool
    treatmentStartedAt: str | None = None
    reviewAfterHours: int = Field(default=24, ge=1, le=168)


class TaperDay(StrictModel):
    day: int = Field(ge=1)
    doseMg: int = Field(ge=0, le=200)
    date: str
    taken: bool


class Taper(StrictModel):
    verified: bool
    medicine: str
    prescribedBy: str
    currentDay: int = Field(ge=1)
    snoozedUntil: str | None = None
    days: list[TaperDay]
    missedDays: list[int] = Field(default_factory=list)
    sideEffects: list[str]
    checkInComplete: bool

    @model_validator(mode="after")
    def validate_missed_dose_reconciliation(self) -> Taper:
        if len(set(self.missedDays)) != len(self.missedDays):
            raise ValueError("Reconciled missed taper days must be unique.")
        scheduled = {day.day: day for day in self.days}
        if any(day not in scheduled for day in self.missedDays):
            raise ValueError("A missed taper day must belong to the clinician-authored schedule.")
        if any(scheduled[day].taken for day in self.missedDays):
            raise ValueError("A taper day cannot be both taken and reconciled as missed.")
        return self


class TaperPatch(StrictModel):
    sideEffects: list[str] | None = None


class TaperMissedDose(StrictModel):
    day: int = Field(ge=1)


class TaperDoseCorrection(StrictModel):
    day: int = Field(ge=1)
    fact: Literal["taken", "missed"]


class SnoozeInput(StrictModel):
    minutes: int = Field(default=30, ge=5, le=240)


class TaperCheckIn(StrictModel):
    sleepHours: float | None = Field(default=None, ge=0, le=24)
    moodConcern: bool = False
    infectionConcern: bool = False
    newSwellingConcern: bool = False
    symptomsWorse: bool = False
    notes: str | None = Field(default=None, max_length=1_000)


class Experiment(StrictModel):
    id: str
    title: str
    variable: str
    goal: str
    baseline: str = ""
    outcome: str
    startDate: str
    durationDays: int = Field(ge=1, le=365)
    day: int = Field(ge=0)
    status: Literal["suggested", "active", "paused", "complete"]
    observations: list[str]
    reviewRequired: bool
    reviewRequestMessageId: str | None = Field(default=None, max_length=300)
    reviewApprovedAt: str | None = Field(default=None, max_length=100)
    reviewApprovedBy: str | None = Field(default=None, max_length=200)


class ExperimentPatch(StrictModel):
    title: str | None = None
    variable: str | None = None
    goal: str | None = None
    baseline: str | None = None
    outcome: str | None = None
    durationDays: int | None = Field(default=None, ge=1, le=365)
    reviewRequired: bool | None = None


class ObservationInput(StrictModel):
    observation: str = Field(min_length=1, max_length=1_000)


class ExperimentCompletion(StrictModel):
    review: str = Field(min_length=1, max_length=2_000)


class WearableSettings(StrictModel):
    provider: Literal["Apple Health", "Health Connect"]
    connected: bool
    heartRate: bool
    hrv: bool = False
    sleep: bool
    activity: bool
    lastSync: str | None = None


class WearablePatch(StrictModel):
    provider: Literal["Apple Health", "Health Connect"] | None = None
    heartRate: bool | None = None
    hrv: bool | None = None
    sleep: bool | None = None
    activity: bool | None = None


class WearableSync(StrictModel):
    restingHeartRate: int | None = Field(default=None, ge=20, le=250)
    heartRateVariabilityMs: float | None = Field(default=None, ge=1, le=500)
    sleepHours: float | None = Field(default=None, ge=0, le=24)
    activitySteps: int | None = Field(default=None, ge=0, le=200_000)


class PrivacySettings(StrictModel):
    photoRetentionDays: Literal[7, 30, 90]
    toiletPhotoConsent: bool
    assistantProfileAccess: bool
    assistantJournalAccess: bool
    assistantCareAccess: bool
    assistantConversationAccess: bool = True
    secondaryUseConsent: bool
    discreetNotifications: bool
    notificationBudget: Literal["low", "balanced", "supportive"]


class PrivacyPatch(StrictModel):
    photoRetentionDays: Literal[7, 30, 90] | None = None
    toiletPhotoConsent: bool | None = None
    assistantProfileAccess: bool | None = None
    assistantJournalAccess: bool | None = None
    assistantCareAccess: bool | None = None
    assistantConversationAccess: bool | None = None
    secondaryUseConsent: bool | None = None
    discreetNotifications: bool | None = None
    notificationBudget: Literal["low", "balanced", "supportive"] | None = None


class AuditEvent(StrictModel):
    id: int
    at: str
    action: str


class SafetyAlert(StrictModel):
    id: int
    level: Literal["same-day", "emergency"]
    triggers: list[str]
    message: str
    createdAt: str
    sourceEntryIds: list[int] = Field(default_factory=list)
    unlinkedTriggers: list[str] = Field(default_factory=list)


class DemoState(StrictModel):
    version: int = Field(ge=1)
    phase: PhaseId
    pendingPhase: PhaseId | None = None
    phaseConfirmed: bool
    messages: list[ChatMessage]
    profileProposals: list[ProfileProposal] = Field(default_factory=list)
    entries: list[JournalEntry]
    profile: Profile
    contacts: list[CareContact]
    trustedSupporter: TrustedSupporter
    testOrder: TestOrder
    teamMessage: TeamMessage
    teamMessageHistory: list[TeamMessage] = Field(default_factory=list)
    teamMessageStale: bool = False
    prescription: PrescriptionFlow
    taper: Taper
    experiment: Experiment
    wearable: WearableSettings
    privacy: PrivacySettings
    clinicianSummary: str
    clinicianSummaryEdited: bool = False
    clinicianSummaryStale: bool = False
    audit: list[AuditEvent]
    safetyAlert: SafetyAlert | None = None

    @model_validator(mode="after")
    def validate_unique_ids(self) -> DemoState:
        if len({entry.id for entry in self.entries}) != len(self.entries):
            raise ValueError("Journal entry ids must be unique.")
        if len({message.id for message in self.messages}) != len(self.messages):
            raise ValueError("Chat message ids must be unique.")
        if len({proposal.id for proposal in self.profileProposals}) != len(self.profileProposals):
            raise ValueError("Profile-proposal ids must be unique.")
        patient_message_ids = {message.id for message in self.messages if message.from_ == "me"}
        if any(
            proposal.sourceMessageId not in patient_message_ids
            for proposal in self.profileProposals
        ):
            raise ValueError(
                "Every conversation-derived profile proposal must retain its patient source."
            )
        thread = [self.teamMessage, *self.teamMessageHistory]
        if len({message.id for message in thread}) != len(thread):
            raise ValueError("Clinician-message thread ids must be unique.")
        if any(message.status == "draft" for message in self.teamMessageHistory):
            raise ValueError("Clinician-message history cannot contain unsent drafts.")
        if any(
            (message.status == "replied" and not message.reply)
            or (message.status != "replied" and message.reply is not None)
            for message in self.teamMessageHistory
        ):
            raise ValueError("Clinician-message history must preserve valid send/reply state.")
        if self.teamMessage.status == "replied" and not self.teamMessage.reply:
            raise ValueError("A replied clinician message requires reply content.")
        if self.teamMessage.status != "replied" and self.teamMessage.reply is not None:
            raise ValueError("Only a replied clinician message can contain reply content.")
        if self.teamMessageStale and self.teamMessage.status != "draft":
            raise ValueError("Only an unsent clinician-message draft can be stale.")
        if self.clinicianSummaryStale and not self.clinicianSummaryEdited:
            raise ValueError("Only a patient-edited clinician summary can be stale.")
        if self.profile.onboardingComplete and not any(
            contact.name.strip() and contact.role.strip() and contact.phone.strip()
            for contact in self.contacts
        ):
            raise ValueError(
                "Completed onboarding requires at least one named clinical contact with a "
                "phone route."
            )
        for entry in self.entries:
            photo = entry.photo
            if photo is None:
                continue
            if not photo.consented:
                raise ValueError("Every persisted photo requires explicit patient consent.")
            if (
                photo.purpose == "toilet"
                and photo.previewUrl
                and not self.privacy.toiletPhotoConsent
            ):
                raise ValueError(
                    "A retained toilet-photo payload requires current toilet-photo consent."
                )
        supporter = self.trustedSupporter
        if supporter.enabled:
            if not supporter.name.strip() or not supporter.relationship.strip():
                raise ValueError("An enabled trusted supporter requires a name and relationship.")
            if not any(
                (
                    supporter.canViewSummary,
                    supporter.canSeeReminders,
                    supporter.canHelpLog,
                )
            ):
                raise ValueError(
                    "An enabled trusted supporter requires at least one explicit permission."
                )
        if supporter.accessCode and (not supporter.enabled or not supporter.accessCreatedAt):
            raise ValueError(
                "A supporter access code requires active scoped access and a timestamp."
            )
        if supporter.accessCreatedAt and not supporter.accessCode:
            raise ValueError("Supporter access timestamps cannot outlive their revoked code.")
        return self


class PhaseInput(StrictModel):
    phase: PhaseId
    reason: str = Field(
        default="Patient confirmed the phase change.", min_length=1, max_length=1_000
    )


class SafetyInput(StrictModel):
    pain: int | None = Field(default=None, ge=0, le=10)
    severePain: bool = False
    bleeding: Literal["none", "small", "moderate", "heavy", "continuous"] | None = None
    feverC: float | None = Field(default=None, ge=30, le=45)
    fever: bool = False
    faint: bool = False
    dehydration: bool = False
    bowelMovements24h: int | None = Field(default=None, ge=0, le=100)
    vomiting: bool = False
    persistentVomiting: bool = False
    possibleObstruction: bool = False
    cannotPassStoolOrGas: bool = False
    abdominalDistension: bool = False
    infectionConcern: bool = False
    seriousMoodConcern: bool = False
    newSwellingConcern: bool = False
    symptomsWorse: bool = False


class SafetyEvaluation(StrictModel):
    urgent: bool
    level: Literal["routine", "same-day", "emergency"]
    triggers: list[str]
    message: str
    source: Literal["deterministic-rules-v1"] = "deterministic-rules-v1"


class LifecycleSignal(StrictModel):
    key: str
    label: str
    detail: str
    evidenceEntryIds: list[int]
    clinical: bool


class LifecycleEvaluation(StrictModel):
    currentPhase: PhaseId
    proposedPhase: PhaseId | None
    needsConfirmation: bool
    signals: list[LifecycleSignal]
    explanation: str
    ruleVersion: Literal["demo-lifecycle-v1"] = "demo-lifecycle-v1"


class SummaryPatch(StrictModel):
    clinicianSummary: str = Field(max_length=20_000)


class PersonalPatternSummary(StrictModel):
    id: str
    kind: Literal["food-symptom-episode"] = "food-symptom-episode"
    title: str
    summary: str
    sourceEntryIds: list[int]
    disclaimer: str


class DashboardResponse(StrictModel):
    phase: PhaseId
    phaseLabel: str
    gaugePercent: int
    metrics: list[dict[str, Any]]
    trend: list[dict[str, Any]]
    suggestions: list[dict[str, str]]
    evidence: list[EvidenceSource]
    personalPatterns: list[PersonalPatternSummary] = Field(default_factory=list)


class CaptureDraft(StrictModel):
    entries: list[JournalDraft]
    profileProposals: list[ProfileProposalDraft] = Field(default_factory=list)
    missing: list[str]
    note: str
