import type { DemoState } from "../types";
import { buildClinicianSummary } from "./stateDerivations";
import { deriveReminders } from "./reminderService";
import { dateInTimeZone, hourInTimeZone } from "./patientTime";

export function alignTaperToCalendar(state: DemoState, now = new Date()): DemoState {
  if (!state.taper.verified || !state.taper.days.length) return state;
  const date = dateInTimeZone(now, state.profile.timeZone);
  const exact = state.taper.days.find((day) => day.date === date);
  const first = state.taper.days[0];
  const last = state.taper.days.at(-1);
  const scheduled = exact ?? (date < first.date ? first : last && date > last.date ? last : undefined);
  if (!scheduled || scheduled.day === state.taper.currentDay) return state;
  return { ...state, taper: { ...state.taper, currentDay: scheduled.day } };
}

export function preferredPromptHour(state: DemoState): number {
  const hours = state.entries
    .filter((entry) => entry.source === "manual" && /^\d{2}:\d{2}$/.test(entry.time))
    .map((entry) => Number(entry.time.slice(0, 2)))
    .filter((hour) => Number.isFinite(hour))
    .sort((a, b) => a - b);
  return hours.length ? Math.min(20, Math.max(9, hours[Math.floor(hours.length / 2)])) : 18;
}

export function scheduledNotification(state: DemoState, now = new Date()) {
  if (!state.profile.onboardingComplete
    || !state.profile.adultEligibilityConfirmed
    || !state.profile.healthDataConsent) return undefined;
  const snoozedUntil = state.taper.snoozedUntil ? new Date(state.taper.snoozedUntil).getTime() : 0;
  const reminder = deriveReminders(state, now)[0];
  if (!reminder) return undefined;
  const localHour = hourInTimeZone(now, state.profile.timeZone);
  const promptHour = reminder.id === "taper" ? Math.min(10, preferredPromptHour(state)) : preferredPromptHour(state);
  if (localHour < promptHour) return undefined;
  const date = dateInTimeZone(now, state.profile.timeZone);
  const baseStage = reminder.id === "taper" ? (localHour >= 18 ? 3 : localHour >= 12 ? 2 : 1) : 0;
  const postSnoozeToken = reminder.id === "taper" && snoozedUntil > 0 && snoozedUntil <= now.getTime()
    ? `r${Math.floor(snoozedUntil / 60_000).toString(36)}`
    : "";
  return {
    // The browser dedupe marker is intentionally opaque: localStorage must not reveal whether
    // the reminder concerned a medicine, symptom, wearable or photo.
    // Numeric stages allow bounded escalation and a stable post-snooze retry without putting
    // medicine names, doses, symptoms or reminder types into browser storage.
    key: `${date}:daily-check-in:${baseStage}${postSnoozeToken}`,
    title: state.privacy.discreetNotifications ? "You have a Gutsy check-in" : reminder.title,
    body: state.privacy.discreetNotifications ? "Open Gutsy when it suits you. Urgent help remains available." : reminder.detail,
  };
}

export function applyScheduledBackgroundWork(state: DemoState, now = new Date()): DemoState {
  if (!state.profile.onboardingComplete
    || !state.profile.adultEligibilityConfirmed
    || !state.profile.healthDataConsent) return state;
  const aligned = alignTaperToCalendar(state, now);
  const date = dateInTimeZone(now, aligned.profile.timeZone);
  const unresolvedExperimentReview = aligned.experiment.reviewRequestMessageId === aligned.teamMessage.id
    && !aligned.experiment.reviewApprovedAt
    && (aligned.teamMessage.status === "sent" || aligned.teamMessage.status === "read");
  if (aligned.phase !== "flare"
    || !aligned.phaseConfirmed
    || Boolean(aligned.pendingPhase)
    || hourInTimeZone(now, aligned.profile.timeZone) < 18
    || aligned.teamMessage.status !== "replied"
    || unresolvedExperimentReview
    || aligned.teamMessage.id === `EVENING-${date}`) return aligned;
  const auditId = Math.max(...aligned.audit.map((event) => event.id), 0) + 1;
  return {
    ...aligned,
    teamMessageHistory: [aligned.teamMessage, ...aligned.teamMessageHistory],
    teamMessage: {
      id: `EVENING-${date}`,
      subject: `Evening flare update from ${aligned.profile.name || "Gutsy patient"}`,
      body: buildClinicianSummary(aligned),
      status: "draft",
      statusUpdatedAt: now.toISOString(),
      clinicalOwner: aligned.teamMessage.clinicalOwner,
      notificationRule: aligned.teamMessage.notificationRule,
      notificationReason: "Phase-specific evening follow-up prepared from the current clinician-ready summary after the prior thread became archivable; patient review is still required before send.",
      expectedResponse: aligned.teamMessage.expectedResponse,
    },
    teamMessageStale: false,
    audit: [{ id: auditId, at: now.toISOString(), action: "Background agent prepared the next editable evening flare update after the prior team reply; nothing was sent." }, ...aligned.audit],
  };
}
