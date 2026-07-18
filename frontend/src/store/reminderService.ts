import type { DemoState } from "../types";
import { addCalendarDays, dateInTimeZone, dateTimeKeyInTimeZone, hourInTimeZone, timeInTimeZone } from "./patientTime";
import { taperTreatmentActive } from "./recoveryGovernance";

export type DerivedReminder = {
  id: "taper" | "medicine" | "wellbeing" | "meal" | "wearable" | "test-delivery" | "team-response" | "phase-watch" | "phase-flare" | "phase-recovery";
  title: string;
  detail: string;
};

function countFromText(value: string): number | undefined {
  const count = ({ one: 1, two: 2, three: 3 } as Record<string, number>)[value.toLowerCase()] ?? Number(value);
  return Number.isFinite(count) && count > 0 ? count : undefined;
}

function addWorkingDays(date: string, count: number): string {
  let candidate = date;
  let remaining = count;
  while (remaining > 0) {
    candidate = addCalendarDays(candidate, 1);
    const day = new Date(`${candidate}T12:00:00.000Z`).getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return candidate;
}

function responseWindowPassed(value: string, sentAt: Date, now: Date, timeZone: string): boolean {
  const workingDay = value.match(/\b(\d+|one|two|three)\s*working\s*days?\b/i);
  if (workingDay) {
    const count = countFromText(workingDay[1]);
    const nowKey = dateTimeKeyInTimeZone(now, timeZone);
    if (count == null || !nowKey) return false;
    const deadline = `${addWorkingDays(dateInTimeZone(sentAt, timeZone), count)}T${timeInTimeZone(sentAt, timeZone)}`;
    return nowKey >= deadline;
  }

  const hour = value.match(/\b(\d+)\s*(?:working\s*)?hours?\b/i);
  if (hour) return now.getTime() >= sentAt.getTime() + Number(hour[1]) * 3_600_000;
  const day = value.match(/\b(\d+|one|two|three)\s*days?\b/i);
  const count = day ? countFromText(day[1]) : undefined;
  return count == null ? false : now.getTime() >= sentAt.getTime() + count * 86_400_000;
}

function governedTestReminder(state: DemoState): boolean {
  return Boolean(
    state.testOrder.clinicalOwner.trim()
    && !state.testOrder.clinicalOwner.startsWith("Not configured")
    && state.testOrder.eligibilityRule.trim()
    && state.testOrder.eligibilityRule !== "Not configured"
    && state.testOrder.statusUpdatedAt
    && Number.isFinite(new Date(state.testOrder.statusUpdatedAt).getTime()),
  );
}

function governedTeamReminder(state: DemoState): boolean {
  return Boolean(
    state.teamMessage.clinicalOwner.trim()
    && !state.teamMessage.clinicalOwner.startsWith("Not configured")
    && state.teamMessage.notificationRule.trim()
    && state.teamMessage.notificationRule !== "Not configured",
  );
}

function dailyMedicationRegimens(value: string): string[] {
  return value
    .split(/[;\n]+/)
    .map((item) => item.trim())
    .filter((item) => /\b(daily|each day|once a day|twice a day|morning|nightly|every night)\b/i.test(item));
}

function regimenRecordedToday(regimen: string, state: DemoState, date: string): boolean {
  const medicineName = regimen.match(/[a-z][a-z'-]+/i)?.[0]?.toLowerCase();
  if (!medicineName) return false;
  return state.entries.some((entry) => (
    !entry.excluded
    && entry.date === date
    && entry.kind === "MEDICATION"
    && entry.structured?.taken === true
    && entry.body.toLowerCase().includes(medicineName)
  ));
}

export function deriveReminders(state: DemoState, now = new Date()): DerivedReminder[] {
  if (!state.profile.onboardingComplete
    || !state.profile.adultEligibilityConfirmed
    || !state.profile.healthDataConsent) return [];
  const date = dateInTimeZone(now, state.profile.timeZone);
  const hour = hourInTimeZone(now, state.profile.timeZone);
  const todayEntries = state.entries.filter((entry) => !entry.excluded && entry.date === date);
  const highFatigue = todayEntries.some((entry) => ["high", "severe"].includes(String(entry.structured?.fatigue ?? "").toLowerCase()));
  const phaseConfirmed = state.phaseConfirmed && !state.pendingPhase;
  const suppressLowValue = highFatigue || (phaseConfirmed && state.phase === "flare");
  const reminders: DerivedReminder[] = [];
  const snoozeUntil = state.taper.snoozedUntil ? new Date(state.taper.snoozedUntil).getTime() : 0;
  const doseSnoozed = Number.isFinite(snoozeUntil) && snoozeUntil > now.getTime();
  const taperDay = state.taper.days.find((day) => day.date === date);
  const earlierUnconfirmed = state.taper.days.filter((day) => day.date < date && !day.taken && !state.taper.missedDays.includes(day.day));

  const taperSupportActive = taperTreatmentActive(state);
  if (!doseSnoozed && taperSupportActive && state.taper.verified && taperDay && !state.taper.missedDays.includes(taperDay.day) && (earlierUnconfirmed.length > 0 || !taperDay.taken)) {
    const title = earlierUnconfirmed.length
      ? "Prescribed dose record needs review"
      : hour >= 18
        ? "Dose still unconfirmed — check today"
        : hour >= 12
          ? "Prescribed dose still unconfirmed"
          : "Prescribed dose check";
    const detail = earlierUnconfirmed.length
      ? `${earlierUnconfirmed.length} earlier prescribed dose ${earlierUnconfirmed.length === 1 ? "confirmation is" : "confirmations are"} missing. Do not double a dose or change the taper; check the label and contact your pharmacist or IBD team if unsure.`
      : `Taper day ${taperDay.day}: ${taperDay.doseMg} mg ${state.taper.medicine}. ${hour >= 18 ? "If you may have missed it, do not double or stop suddenly—check the leaflet and contact your pharmacist or IBD team." : "Confirm only in Care after taking it."}`;
    reminders.push({ id: "taper", title, detail });
  }

  const sentAt = state.teamMessage.sentAt ? new Date(state.teamMessage.sentAt) : undefined;
  if (
    (state.teamMessage.status === "sent" || state.teamMessage.status === "read")
    && governedTeamReminder(state)
    && sentAt
    && Number.isFinite(sentAt.getTime())
    && responseWindowPassed(state.teamMessage.expectedResponse, sentAt, now, state.profile.timeZone)
  ) {
    reminders.push({
      id: "team-response",
      title: "The stated team response window has passed",
      detail: `${state.teamMessage.expectedResponse} was the recorded expectation, not a guarantee. Open Care to follow your personal pathway; if symptoms are worsening or you cannot safely wait, do not rely on this message—use same-day or urgent care.`,
    });
  }

  const hasWellbeingToday = todayEntries.some((entry) => entry.kind === "WELLBEING");
  const hasSafetyCheckToday = todayEntries.some((entry) => entry.structured?.safetyCheck === true);
  if (state.phase === "flare" && phaseConfirmed && !hasWellbeingToday && !hasSafetyCheckToday) {
    reminders.push({
      id: "phase-flare",
      title: "Flare check-in: can you safely wait?",
      detail: "A short safety and symptom check is enough. Heavy bleeding, severe pain, fever, faintness, dehydration or obstruction symptoms need the care route shown in Gutsy, not a routine team reply.",
    });
  }

  if (state.privacy.notificationBudget !== "low") {
    if (governedTestReminder(state) && state.testOrder.status === "delivered") {
      reminders.push({ id: "test-delivery", title: "Your home test kit has arrived", detail: "Open Care for the fixed collection guide. Record collection only after it happens; Gutsy will not infer a sample from delivery." });
    } else if (governedTestReminder(state) && state.testOrder.status === "shipped" && state.privacy.notificationBudget === "supportive") {
      reminders.push({ id: "test-delivery", title: "Your home test kit is on its way", detail: "Delivery tracking is simulated in this demo. When it arrives, Care will guide the patient-confirmed collection step." });
    }

    if (state.phase === "watch" && phaseConfirmed && !hasWellbeingToday) {
      reminders.push({
        id: "phase-watch",
        title: "Watchful check-in: what changed today?",
        detail: "Bowel frequency, urgency, blood, night waking, pain and fatigue are most useful now. Add only what you know; one brief record is enough.",
      });
    }
    if (state.phase === "recovery" && phaseConfirmed && taperSupportActive && !hasWellbeingToday) {
      reminders.push({
        id: "phase-recovery",
        title: "Recovery check-in: symptoms and side effects",
        detail: "A brief check on symptoms, sleep, mood, infection concerns or swelling helps the recovery summary. It never changes the clinician-authored schedule.",
      });
    }
  }

  const missingDailyMedicines = dailyMedicationRegimens(state.profile.currentMedicines)
    .filter((regimen) => !regimenRecordedToday(regimen, state, date));
  if (missingDailyMedicines.length) {
    const late = hour >= 18;
    reminders.push({ id: "medicine", title: late ? "Daily medicine record still unconfirmed" : "Daily medicine check", detail: `${missingDailyMedicines.join("; ")} is recorded as a daily regimen in your patient-maintained profile, with no matching taken record today. Record only what you actually took; Gutsy does not infer adherence.${late ? " Check the medicine label or contact your pharmacist if you are unsure—do not take an extra dose based on this reminder." : ""}` });
  }
  if (!highFatigue && state.phase === "stable" && phaseConfirmed && state.privacy.notificationBudget !== "low" && !hasWellbeingToday) {
    reminders.push({ id: "wellbeing", title: "Optional one-tap check-in", detail: "Better, same or worse is enough. Missing it does not reset progress." });
  }
  if (!suppressLowValue && state.phase === "stable" && phaseConfirmed && state.privacy.notificationBudget === "supportive" && !todayEntries.some((entry) => entry.kind === "MEAL")) {
    reminders.push({ id: "meal", title: "Optional meal or hydration note", detail: "A photo or a few words is enough; no calories or scores." });
  }
  if (!suppressLowValue && state.phase === "stable" && phaseConfirmed && state.privacy.notificationBudget === "supportive" && state.wearable.connected && state.wearable.lastSync !== "Today, 08:00" && state.wearable.lastSync !== "Just now") {
    reminders.push({ id: "wearable", title: "Wearable connection check", detail: "Passive signals appear out of date. Manual tracking still works fully." });
  }
  const lowBudgetIds = new Set<DerivedReminder["id"]>(["taper", "medicine", "team-response", "phase-flare"]);
  const permitted = state.privacy.notificationBudget === "low"
    ? reminders.filter((reminder) => lowBudgetIds.has(reminder.id))
    : reminders;
  const cap = state.privacy.notificationBudget === "low" ? 2 : state.privacy.notificationBudget === "balanced" ? 4 : 6;
  return permitted.slice(0, cap);
}
