from __future__ import annotations

import re
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from app.domain.models import DemoState


def _parse_instant(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _count_from_text(value: str) -> int | None:
    words = {"one": 1, "two": 2, "three": 3}
    word_count = words.get(value.casefold())
    if word_count is not None:
        return word_count
    try:
        count = int(value)
    except ValueError:
        return None
    return count if count and count > 0 else None


def _add_working_days(day: datetime, count: int) -> datetime:
    candidate = day
    remaining = count
    while remaining:
        candidate += timedelta(days=1)
        if candidate.weekday() < 5:
            remaining -= 1
    return candidate


def _response_window_passed(value: str, sent_at: datetime, now: datetime) -> bool:
    working_days = re.search(r"\b(\d+|one|two|three)\s*working\s*days?\b", value, re.I)
    if working_days:
        count = _count_from_text(working_days.group(1))
        return bool(count and now >= _add_working_days(sent_at, count))
    hours = re.search(r"\b(\d+)\s*(?:working\s*)?hours?\b", value, re.I)
    if hours:
        return now >= sent_at + timedelta(hours=int(hours.group(1)))
    days = re.search(r"\b(\d+|one|two|three)\s*days?\b", value, re.I)
    count = _count_from_text(days.group(1)) if days else None
    return bool(count and now >= sent_at + timedelta(days=count))


def _daily_regimens(value: str) -> list[str]:
    return [
        item.strip()
        for item in re.split(r"[;\n]+", value)
        if item.strip()
        and re.search(
            r"\b(daily|each day|once a day|twice a day|morning|nightly|every night)\b",
            item,
            re.I,
        )
    ]


def _preferred_prompt_hour(state: DemoState) -> int:
    hours = sorted(
        int(entry.time[:2])
        for entry in state.entries
        if entry.source == "manual" and re.fullmatch(r"\d{2}:\d{2}", entry.time)
    )
    return min(20, max(9, hours[len(hours) // 2])) if hours else 18


def _base36(value: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    if value <= 0:
        return "0"
    result = ""
    while value:
        value, remainder = divmod(value, 36)
        result = digits[remainder] + result
    return result


def current_background_reminder(
    state: DemoState, instant: datetime
) -> dict[str, str] | None:
    """Return one minimal, consent-bound reminder payload for the service worker."""

    profile = state.profile
    if not (
        profile.onboardingComplete
        and profile.adultEligibilityConfirmed
        and profile.healthDataConsent
    ):
        return None
    zone = ZoneInfo(profile.timeZone)
    now = instant.astimezone(zone)
    day = now.date().isoformat()
    hour = now.hour
    entries = [entry for entry in state.entries if not entry.excluded and entry.date == day]
    has_wellbeing = any(entry.kind == "WELLBEING" for entry in entries)
    has_safety_check = any(entry.structured.get("safetyCheck") is True for entry in entries)
    high_fatigue = any(
        str(entry.structured.get("fatigue", "")).casefold() in {"high", "severe"}
        for entry in entries
    )
    phase_confirmed = state.phaseConfirmed and state.pendingPhase is None
    reminders: list[tuple[str, str, str]] = []

    snoozed_until = _parse_instant(state.taper.snoozedUntil)
    dose_snoozed = bool(snoozed_until and snoozed_until > instant)
    current_dose = next((dose for dose in state.taper.days if dose.date == day), None)
    missed = set(state.taper.missedDays)
    earlier_unconfirmed = [
        dose
        for dose in state.taper.days
        if dose.date < day and not dose.taken and dose.day not in missed
    ]
    taper_active = state.prescription.status == "collected" or (
        state.phase == "recovery" and phase_confirmed
    )
    if (
        not dose_snoozed
        and taper_active
        and state.taper.verified
        and current_dose
        and current_dose.day not in missed
        and (earlier_unconfirmed or not current_dose.taken)
    ):
        title = (
            "Prescribed dose record needs review"
            if earlier_unconfirmed
            else (
                "Dose still unconfirmed — check today"
                if hour >= 18
                else "Prescribed dose still unconfirmed" if hour >= 12 else "Prescribed dose check"
            )
        )
        detail = (
            f"{len(earlier_unconfirmed)} earlier prescribed dose "
            f"{'confirmation is' if len(earlier_unconfirmed) == 1 else 'confirmations are'} "
            "missing. Do not double a dose or change the taper; check the label and contact "
            "your pharmacist or IBD team if unsure."
            if earlier_unconfirmed
            else (
                f"Taper day {current_dose.day}: {current_dose.doseMg} mg "
                f"{state.taper.medicine}. "
                + (
                    "If you may have missed it, do not double or stop suddenly—check the "
                    "leaflet and contact your pharmacist or IBD team."
                    if hour >= 18
                    else "Confirm only after taking it exactly as prescribed."
                )
            )
        )
        reminders.append(("taper", title, detail))

    sent_at = _parse_instant(state.teamMessage.sentAt)
    governed_team = bool(
        state.teamMessage.clinicalOwner.strip()
        and not state.teamMessage.clinicalOwner.startswith("Not configured")
        and state.teamMessage.notificationRule.strip()
        and state.teamMessage.notificationRule != "Not configured"
    )
    if (
        state.teamMessage.status in {"sent", "read"}
        and governed_team
        and sent_at
        and _response_window_passed(
            state.teamMessage.expectedResponse, sent_at.astimezone(zone), now
        )
    ):
        reminders.append(
            (
                "team-response",
                "The stated team response window has passed",
                f"{state.teamMessage.expectedResponse} was the recorded expectation, not a "
                "guarantee. Open Care to follow your personal pathway; if symptoms are "
                "worsening or you cannot safely wait, do not rely on this message—use "
                "same-day or urgent care.",
            )
        )

    if state.phase == "flare" and phase_confirmed and not has_wellbeing and not has_safety_check:
        reminders.append(
            (
                "phase-flare",
                "Flare check-in: can you safely wait?",
                "A short safety and symptom check is enough. Heavy bleeding, severe pain, "
                "fever, faintness, dehydration or obstruction symptoms need the care route "
                "shown in MeMed, not a routine team reply.",
            )
        )

    governed_test = bool(
        state.testOrder.clinicalOwner.strip()
        and not state.testOrder.clinicalOwner.startswith("Not configured")
        and state.testOrder.eligibilityRule.strip()
        and state.testOrder.eligibilityRule != "Not configured"
        and _parse_instant(state.testOrder.statusUpdatedAt)
    )
    if state.privacy.notificationBudget != "low":
        if governed_test and state.testOrder.status == "delivered":
            reminders.append(
                (
                    "test-delivery",
                    "Your home test kit has arrived",
                    "Open Care for the fixed collection guide. Record collection only after "
                    "it happens; MeMed will not infer a sample from delivery.",
                )
            )
        elif (
            governed_test
            and state.testOrder.status == "shipped"
            and state.privacy.notificationBudget == "supportive"
        ):
            reminders.append(
                (
                    "test-delivery",
                    "Your home test kit is on its way",
                    "Delivery tracking is simulated in this demo. When it arrives, Care will "
                    "guide the patient-confirmed collection step.",
                )
            )
        if state.phase == "watch" and phase_confirmed and not has_wellbeing:
            reminders.append(
                (
                    "phase-watch",
                    "Watchful check-in: what changed today?",
                    "Bowel frequency, urgency, blood, night waking, pain and fatigue are most "
                    "useful now. Add only what you know; one brief record is enough.",
                )
            )
        if state.phase == "recovery" and phase_confirmed and taper_active and not has_wellbeing:
            reminders.append(
                (
                    "phase-recovery",
                    "Recovery check-in: symptoms and side effects",
                    "A brief check on symptoms, sleep, mood, infection concerns or swelling "
                    "helps the recovery summary. It never changes the clinician-authored schedule.",
                )
            )

    missing_regimens: list[str] = []
    for regimen in _daily_regimens(profile.currentMedicines):
        match = re.search(r"[a-z][a-z'-]+", regimen, re.I)
        medicine = match.group(0).casefold() if match else ""
        if medicine and not any(
            entry.kind == "MEDICATION"
            and entry.structured.get("taken") is True
            and medicine in entry.body.casefold()
            for entry in entries
        ):
            missing_regimens.append(regimen)
    if missing_regimens:
        reminders.append(
            (
                "medicine",
                "Daily medicine record still unconfirmed" if hour >= 18 else "Daily medicine check",
                f"{'; '.join(missing_regimens)} is recorded as a daily regimen in your "
                "patient-maintained profile, with no matching taken record today. Record only "
                "what you actually took; MeMed does not infer adherence."
                + (
                    " Check the medicine label or contact your pharmacist or IBD team if you "
                    "are unsure—do not take an extra dose based on this reminder."
                    if hour >= 18
                    else ""
                ),
            )
        )
    if (
        not high_fatigue
        and state.phase == "stable"
        and phase_confirmed
        and state.privacy.notificationBudget != "low"
        and not has_wellbeing
    ):
        reminders.append(
            (
                "wellbeing",
                "Optional one-tap check-in",
                "Better, same or worse is enough. Missing it does not reset progress.",
            )
        )
    if (
        not high_fatigue
        and state.phase == "stable"
        and phase_confirmed
        and state.privacy.notificationBudget == "supportive"
        and not any(entry.kind == "MEAL" for entry in entries)
    ):
        reminders.append(
            (
                "meal",
                "Optional meal or hydration note",
                "A photo or a few words is enough; no calories or scores.",
            )
        )
    if (
        not high_fatigue
        and state.phase == "stable"
        and phase_confirmed
        and state.privacy.notificationBudget == "supportive"
        and state.wearable.connected
        and state.wearable.lastSync not in {"Today, 08:00", "Just now"}
    ):
        reminders.append(
            (
                "wearable",
                "Wearable connection check",
                "Passive signals appear out of date. Manual tracking still works fully.",
            )
        )

    if state.privacy.notificationBudget == "low":
        allowed = {"taper", "medicine", "team-response", "phase-flare"}
        reminders = [reminder for reminder in reminders if reminder[0] in allowed]
    if not reminders:
        return None
    reminder_id, title, body = reminders[0]
    prompt_hour = (
        min(10, _preferred_prompt_hour(state))
        if reminder_id == "taper"
        else _preferred_prompt_hour(state)
    )
    if hour < prompt_hour:
        return None
    stage = "0"
    if reminder_id == "taper":
        stage = "3" if hour >= 18 else "2" if hour >= 12 else "1"
        if snoozed_until and snoozed_until <= instant:
            stage += f"r{_base36(int(snoozed_until.timestamp() // 60))}"
    marker = f"{day}:daily-check-in:{stage}"
    if state.privacy.discreetNotifications:
        title = "You have a MeMed check-in"
        body = "Open MeMed when it suits you. Urgent help remains available."
    return {"marker": marker, "title": title, "body": body}
