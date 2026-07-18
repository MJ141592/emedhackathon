import type { DemoState } from "../types";
import { dateInTimeZone } from "./patientTime";

/**
 * Dose adherence support is available only after the clinician-owned treatment
 * workflow has actually issued the medicine. A confirmed Recovery phase is an
 * equivalent governed signal, while a presentation-only Recovery demo is not.
 */
export function taperTreatmentActive(state: DemoState): boolean {
  return state.prescription.status === "collected"
    || (state.phase === "recovery" && state.phaseConfirmed && !state.pendingPhase);
}

export function treatmentReviewReady(state: DemoState, now = new Date()): boolean {
  if (state.prescription.status !== "collected" || !state.prescription.treatmentStartedAt) return false;
  const started = new Date(state.prescription.treatmentStartedAt).getTime();
  if (!Number.isFinite(started)) return false;
  return now.getTime() >= started + state.prescription.reviewAfterHours * 3_600_000;
}

export function taperCourseComplete(state: DemoState, now = new Date()): boolean {
  if (!state.taper.days.length) return false;
  const today = dateInTimeZone(now, state.profile.timeZone);
  const missed = new Set(state.taper.missedDays);
  return state.taper.days.at(-1)!.date <= today
    && state.taper.days.every((day) => day.taken || missed.has(day.day));
}
