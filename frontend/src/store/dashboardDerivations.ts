import { TODAY } from "../data";
import type { DemoState, JournalEntry, Metric, PhaseContent, PhaseId, TrendPoint } from "../types";
import { addCalendarDays, dateInTimeZone, dateTimeKeyInTimeZone } from "./patientTime";
import { taperCourseComplete, taperTreatmentActive, treatmentReviewReady } from "./recoveryGovernance";

const CLINICAL_KINDS = new Set<JournalEntry["kind"]>([
  "BOWEL MOVEMENT",
  "PAIN",
  "FATIGUE",
  "WELLBEING",
  "FROM YOUR WATCH",
  "TEST RESULT",
]);

type DatedEntry = { entry: JournalEntry; at: Date };

export type LifecycleSignal = {
  key: string;
  label: string;
  detail: string;
  evidenceEntryIds: number[];
  clinical: boolean;
};

export type LifecycleProposal = {
  proposedPhase?: PhaseId;
  signals: LifecycleSignal[];
  evidence: JournalEntry[];
  windowStart?: string;
  windowEnd?: string;
  explanation: string;
};

export type PersonalPatternSummary = {
  id: string;
  kind: "food-symptom-episode";
  title: string;
  summary: string;
  sourceEntryIds: number[];
  sources: JournalEntry[];
  disclaimer: string;
};

export type DerivedDashboard = {
  content: PhaseContent;
  weeklyTrend: TrendPoint[];
  evidence: JournalEntry[];
  lifecycle: LifecycleProposal;
  personalPatterns: PersonalPatternSummary[];
  patternHeadline: string;
  patternExplanation: string;
  trendTitle: string;
  weeklyTrendTitle: string;
  lifeEventNote?: string;
};

function numberFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function firstNumber(value: string): number | undefined {
  const match = value.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : undefined;
}

function baselineAverage(value: string): number | undefined {
  const average = value.match(/(\d+(?:\.\d+)?)\s*(?:average|avg)/i);
  if (average) return Number(average[1]);
  const range = value.match(/(\d+(?:\.\d+)?)\s*[–-]\s*(\d+(?:\.\d+)?)/);
  if (range) return (Number(range[1]) + Number(range[2])) / 2;
  return firstNumber(value);
}

function baselineUpper(value: string): number | undefined {
  const range = value.match(/(\d+(?:\.\d+)?)\s*[–-]\s*(\d+(?:\.\d+)?)/);
  return range ? Number(range[2]) : firstNumber(value);
}

function validDate(entry: JournalEntry): Date | undefined {
  const at = new Date(`${entry.date}T${entry.time || "00:00"}:00.000Z`);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

function datedIncluded(state: DemoState): DatedEntry[] {
  return state.entries.flatMap((entry) => {
    if (entry.excluded) return [];
    const at = validDate(entry);
    return at ? [{ entry, at }] : [];
  });
}

function recentWindow(state: DemoState, days: number): { entries: DatedEntry[]; start?: Date; end?: Date } {
  const dated = datedIncluded(state).filter(({ entry }) => CLINICAL_KINDS.has(entry.kind));
  if (!dated.length) return { entries: [] };
  const endKey = dateInTimeZone(new Date(), state.profile.timeZone);
  const startKey = addCalendarDays(endKey, -(days - 1));
  const start = new Date(`${startKey}T00:00:00.000Z`);
  const end = new Date(`${endKey}T23:59:59.999Z`);
  return { entries: dated.filter(({ entry }) => entry.date >= startKey && entry.date <= endKey), start, end };
}

function uniqueEntries(ids: number[], state: DemoState): JournalEntry[] {
  const wanted = new Set(ids);
  return state.entries
    .filter((entry) => wanted.has(entry.id) && !entry.excluded)
    .sort((a, b) => `${b.date}T${b.time}`.localeCompare(`${a.date}T${a.time}`));
}

function signal(
  key: string,
  label: string,
  detail: string,
  entries: JournalEntry[],
  clinical = true,
): LifecycleSignal {
  return { key, label, detail, evidenceEntryIds: [...new Set(entries.map((entry) => entry.id))], clinical };
}

function signalsSpanRecordedDays(signals: LifecycleSignal[], state: DemoState): boolean {
  const ids = new Set(signals.flatMap((candidate) => candidate.evidenceEntryIds));
  const records = state.entries.filter((entry) => ids.has(entry.id) && !entry.excluded);
  return signals.length >= 2
    && records.length >= 2
    && new Set(records.map((entry) => entry.date)).size >= 2;
}

export function deriveFoodSymptomPatterns(
  state: DemoState,
  windowHours = 12,
  limit = 3,
): PersonalPatternSummary[] {
  const today = dateInTimeZone(new Date(), state.profile.timeZone);
  const oldest = addCalendarDays(today, -90);
  const included = datedIncluded(state).filter(({ entry }) => entry.date >= oldest && entry.date <= today);
  const meals = included.filter(({ entry }) => entry.kind === "MEAL");
  const symptoms = included.filter(({ entry }) => ["BOWEL MOVEMENT", "PAIN", "FATIGUE", "WELLBEING"].includes(entry.kind));
  const assigned = new Map<number, DatedEntry[]>(meals.map(({ entry }) => [entry.id, []]));
  const windowMs = windowHours * 60 * 60 * 1000;

  for (const symptom of symptoms) {
    const nearest = meals
      .filter((meal) => {
        const elapsed = symptom.at.getTime() - meal.at.getTime();
        return elapsed > 0 && elapsed <= windowMs;
      })
      .sort((a, b) => b.at.getTime() - a.at.getTime())[0];
    if (nearest) assigned.get(nearest.entry.id)?.push(symptom);
  }

  return meals
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .flatMap((meal): PersonalPatternSummary[] => {
      const following = [...(assigned.get(meal.entry.id) ?? [])]
        .sort((a, b) => a.at.getTime() - b.at.getTime() || a.entry.id - b.entry.id);
      if (!following.length) return [];
      const elapsedHours = Math.max(1, Math.round((following.at(-1)!.at.getTime() - meal.at.getTime()) / 3_600_000));
      const count = following.length;
      const sources = [meal.entry, ...following.map(({ entry }) => entry)];
      return [{
        id: `food-episode-${meal.entry.id}`,
        kind: "food-symptom-episode",
        title: `${count} symptom ${count === 1 ? "record followed" : "records followed"} a recorded meal`,
        summary: `Within about ${elapsedHours} hour${elapsedHours === 1 ? "" : "s"} after the ${meal.entry.date} ${meal.entry.time} meal “${meal.entry.body}”, ${count} included symptom ${count === 1 ? "entry was" : "entries were"} recorded.`,
        sourceEntryIds: sources.map((entry) => entry.id),
        sources,
        disclaimer: "Correlation is not proof that this meal caused the symptoms; other changes and unrecorded factors may explain the timing.",
      }];
    })
    .slice(0, limit);
}

export function deriveLifecycleProposal(state: DemoState): LifecycleProposal {
  const { entries: dated, start, end } = recentWindow(state, 7);
  const entries = dated.map(({ entry }) => entry);
  const bowel = entries.filter((entry) => entry.kind === "BOWEL MOVEMENT");
  const symptoms = entries.filter((entry) => ["PAIN", "FATIGUE", "WELLBEING"].includes(entry.kind));
  const wearables = entries.filter((entry) => entry.kind === "FROM YOUR WATCH");
  const tests = entries.filter((entry) => entry.kind === "TEST RESULT" && entry.source === "care" && ["result", "shared"].includes(state.testOrder.status) && state.testOrder.result != null && numberFrom(entry.structured?.calprotectin) === state.testOrder.result);
  const signals: LifecycleSignal[] = [];
  const painBaselineUpper = baselineUpper(state.profile.usualPain) ?? 2;
  const painThreshold = Math.min(10, Math.max(4, painBaselineUpper + 2));

  const loose = bowel.filter((entry) => (numberFrom(entry.structured?.bristol) ?? 0) >= 6);
  if (loose.length >= 2) signals.push(signal("loose_stools", "Looser stools", `${loose.length} included entries record Bristol type 6 or 7.`, loose));

  const blood = bowel.filter((entry) => !["", "none", "false"].includes(String(entry.structured?.blood ?? "").toLowerCase()));
  if (blood.length) signals.push(signal("blood", "Blood recorded", `${blood.length} included bowel ${blood.length === 1 ? "entry records" : "entries record"} blood.`, blood));

  const urgency = bowel.filter((entry) => entry.structured?.urgency === true);
  if (urgency.length >= 2) signals.push(signal("urgency", "Urgency recorded", `${urgency.length} included entries record urgency.`, urgency));

  const pain = [...bowel, ...symptoms].filter((entry) => (numberFrom(entry.structured?.pain) ?? -1) >= painThreshold);
  if (pain.length) {
    const highest = Math.max(...pain.map((entry) => numberFrom(entry.structured?.pain) ?? 0));
    signals.push(signal("pain", "Pain above usual", `Included pain ratings reach ${highest}/10; personal baseline is ${state.profile.usualPain || "not recorded"}.`, pain));
  }

  const nightWaking = bowel.filter((entry) => entry.structured?.nightWaking === true);
  if (nightWaking.length) signals.push(signal("night_waking", "Night waking", `${nightWaking.length} included bowel ${nightWaking.length === 1 ? "entry records" : "entries record"} waking at night.`, nightWaking));

  const highFatigue = [...bowel, ...symptoms].filter((entry) => ["high", "severe"].includes(String(entry.structured?.fatigue ?? "").toLowerCase()));
  if (highFatigue.length) signals.push(signal("fatigue", "High fatigue", "High fatigue is recorded against the patient’s personal baseline.", highFatigue));

  const worseWellbeing = symptoms.filter((entry) => entry.kind === "WELLBEING" && String(entry.structured?.wellbeing ?? "").toLowerCase() === "worse");
  const repeatedWorse = new Set(worseWellbeing.map((entry) => entry.date)).size >= 2;
  if (worseWellbeing.length) signals.push(signal("wellbeing_worse", "Feeling worse than usual", `${worseWellbeing.length} included one-tap or detailed wellbeing ${worseWellbeing.length === 1 ? "entry records" : "entries record"} feeling worse than the personal baseline.`, worseWellbeing));

  const heartRateBaseline = firstNumber(state.profile.usualHeartRate);
  if (heartRateBaseline != null) {
    const raised = wearables.filter((entry) => (numberFrom(entry.structured?.restingHeartRate) ?? -Infinity) >= heartRateBaseline + 5);
    if (raised.length) signals.push(signal("resting_heart_rate", "Resting heart-rate supporting signal", `Resting heart rate is at least 5 bpm above the recorded ${heartRateBaseline} bpm baseline.`, raised, false));
  }

  const sleepBaseline = firstNumber(state.profile.usualSleep);
  if (sleepBaseline != null) {
    const shortSleep = wearables.filter((entry) => (numberFrom(entry.structured?.sleepHours) ?? Infinity) <= sleepBaseline - 1);
    if (shortSleep.length) signals.push(signal("sleep_context", "Sleep supporting context", `An included passive sleep duration is at least one hour below the recorded ${sleepBaseline}-hour baseline. Sleep data is noisy and cannot trigger a lifecycle change by itself.`, shortSleep, false));
  }

  const hrvContext = wearables.filter((entry) => (numberFrom(entry.structured?.heartRateVariabilityMs) ?? 0) > 0);
  if (hrvContext.length) signals.push(signal("hrv_context", "HRV supporting context", "Heart-rate variability is recorded in milliseconds as noisy personal context only; no diagnostic threshold or standalone trigger is applied.", hrvContext, false));

  const activityContext = wearables.filter((entry) => numberFrom(entry.structured?.activitySteps) != null);
  if (activityContext.length) signals.push(signal("activity_context", "Activity supporting context", "Activity is retained as personal context only; no population step target or standalone lifecycle trigger is applied.", activityContext, false));

  const raisedTestEntries = tests.filter((entry) => (numberFrom(entry.structured?.calprotectin) ?? -Infinity) >= 250);
  const establishedTest = raisedTestEntries.length > 0;
  if (establishedTest) signals.push(signal("calprotectin", "Calprotectin result available", "A raised result is recorded for the patient and clinical team to interpret; it is not a diagnosis by the app.", raisedTestEntries));

  const clinicalSignals = signals.filter((candidate) => candidate.clinical && candidate.key !== "calprotectin");
  const sustainedChange = signalsSpanRecordedDays(clinicalSignals, state);
  const treatmentStartKey = state.prescription.treatmentStartedAt
    ? dateTimeKeyInTimeZone(
        new Date(state.prescription.treatmentStartedAt),
        state.profile.timeZone,
      )
    : undefined;
  const settling = entries.filter((entry) => {
    if (treatmentStartKey && `${entry.date}T${entry.time}` < treatmentStartKey) return false;
    if (entry.kind === "WELLBEING") return ["better", "settling", "baseline"].includes(String(entry.structured?.wellbeing ?? "").toLowerCase());
    if (entry.kind === "PAIN") {
      const painValue = numberFrom(entry.structured?.pain);
      return painValue != null && painValue <= painBaselineUpper + 1;
    }
    if (entry.kind === "BOWEL MOVEMENT") {
      const bristol = numberFrom(entry.structured?.bristol);
      const bloodValue = String(entry.structured?.blood ?? "none").toLowerCase();
      const painValue = numberFrom(entry.structured?.pain);
      return bristol != null
        && bristol <= 5
        && ["", "none", "false"].includes(bloodValue)
        && entry.structured?.urgency !== true
        && entry.structured?.nightWaking !== true
        && (painValue == null || painValue <= painBaselineUpper + 1);
    }
    return false;
  });
  const settlingReady = treatmentReviewReady(state)
    && settling.length >= 2
    && new Set(settling.map((entry) => entry.date)).size >= 2;
  let proposedPhase: PhaseId | undefined;
  let explanation = "No governed support-mode change is proposed from the currently included records.";

  if (state.phase === "stable" && (sustainedChange || repeatedWorse)) {
    proposedPhase = "watch";
    explanation = "Several patient-recorded signals differ from the personal baseline. MeMed proposes a watchful review; it does not diagnose a flare.";
  } else if (state.phase === "watch" && establishedTest) {
    proposedPhase = "flare";
    explanation = "Objective test evidence is recorded. A clinician still establishes and treats a flare; MeMed only proposes changing its support mode.";
  } else if (state.phase === "watch" && !state.phaseConfirmed && (sustainedChange || repeatedWorse)) {
    proposedPhase = "watch";
    explanation = "The watchful support mode is awaiting patient review of the cited records.";
  } else if (state.phase === "flare" && settlingReady) {
    proposedPhase = "recovery";
    signals.push(signal("settling", "Symptoms settling toward baseline", `${settling.length} included patient records are at or moving toward the recorded baseline.`, settling));
    explanation = "Clinician-authorised treatment is recorded as collected and included symptom records are settling. The patient must confirm recovery support; MeMed does not alter treatment.";
  } else if (state.phase === "recovery" && recoveryRelapseDetected(state, painThreshold, painBaselineUpper)) {
    proposedPhase = "flare";
    explanation = "Several new symptom records moved away from baseline after the latest settling record. MeMed proposes renewed flare support and does not alter the prescribed taper.";
  } else if (state.phase === "recovery" && taperCourseComplete(state) && settlingReady) {
    proposedPhase = "stable";
    signals.push(signal("returned_to_baseline", "Return-to-baseline records", `${settling.length} included patient records are at or moving toward the recorded baseline.`, settling));
    explanation = "The verified course is recorded complete. The patient must confirm that symptoms are back at baseline before stable support resumes.";
  }

  const evidenceIds = signals.flatMap((candidate) => candidate.evidenceEntryIds);
  return {
    proposedPhase,
    signals,
    evidence: uniqueEntries(evidenceIds, state),
    windowStart: start?.toISOString().slice(0, 10),
    windowEnd: end?.toISOString().slice(0, 10),
    explanation,
  };
}

/** Re-evaluate the current Watch state without trusting a prior confirmation bit. */
export function hasGovernedWatchEvidence(state: DemoState): boolean {
  if (state.phase !== "watch") return false;
  const evaluation = deriveLifecycleProposal({
    ...state,
    phaseConfirmed: false,
    pendingPhase: undefined,
  });
  return evaluation.proposedPhase === "watch" && evaluation.evidence.length >= 2;
}

export function hasIncludedRaisedTestEvidence(state: DemoState): boolean {
  if (!["result", "shared"].includes(state.testOrder.status)) return false;
  if (typeof state.testOrder.result !== "number" || state.testOrder.result < 250) return false;
  return state.entries.some((entry) => (
    !entry.excluded
    && entry.kind === "TEST RESULT"
    && entry.source === "care"
    && numberFrom(entry.structured?.calprotectin) === state.testOrder.result
  ));
}

export function hasActiveTrackingConsent(state: DemoState): boolean {
  return state.profile.onboardingComplete
    && state.profile.adultEligibilityConfirmed
    && state.profile.healthDataConsent;
}

function hasCompleteMaintainedBaseline(state: DemoState): boolean {
  return [
    state.profile.usualBowel,
    state.profile.usualPain,
    state.profile.usualHeartRate,
    state.profile.usualSleep,
  ].every((value) => value.trim().length > 0);
}

function hasRaisedObjectiveResult(state: DemoState): boolean {
  if (["result", "shared"].includes(state.testOrder.status)
    && typeof state.testOrder.result === "number"
    && state.testOrder.result >= 250) return true;
  return state.entries.some((entry) => (
    !entry.excluded
    && entry.kind === "TEST RESULT"
    && entry.source === "care"
    && (numberFrom(entry.structured?.calprotectin) ?? -Infinity) >= 250
  ));
}

/**
 * A clean, newly onboarded patient may explicitly establish Stable as their governed
 * starting point. This is deliberately narrower than a generic phase confirmation:
 * presentation scenarios with symptoms, an active care pathway, objective inflammation,
 * or an unresolved safety alert cannot use it.
 */
export function canConfirmStableBaseline(state: DemoState): boolean {
  if (state.phase !== "stable" || state.phaseConfirmed || state.pendingPhase) return false;
  if (!hasActiveTrackingConsent(state) || !hasCompleteMaintainedBaseline(state)) return false;
  if (state.prescription.status !== "not-started" || state.prescription.treatmentStartedAt) return false;
  if (state.safetyAlert || hasRaisedObjectiveResult(state)) return false;
  return deriveLifecycleProposal({ ...state, phaseConfirmed: false, pendingPhase: undefined }).proposedPhase === undefined;
}

function recoveryRelapseDetected(state: DemoState, painThreshold: number, painBaseline: number): boolean {
  const treatmentStartKey = state.prescription.treatmentStartedAt
    ? dateTimeKeyInTimeZone(
        new Date(state.prescription.treatmentStartedAt),
        state.profile.timeZone,
      )
    : undefined;
  const entries = datedIncluded(state)
    .filter(({ entry }) => !treatmentStartKey || `${entry.date}T${entry.time}` >= treatmentStartKey)
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.entry.id - b.entry.id)
    .map(({ entry }) => entry);
  let settlingIndex = -1;
  entries.forEach((entry, index) => {
    const wellbeing = String(entry.structured?.wellbeing ?? "").toLowerCase();
    const pain = numberFrom(entry.structured?.pain);
    if ((entry.kind === "WELLBEING" && ["better", "settling", "baseline"].includes(wellbeing)) || (entry.kind === "PAIN" && pain != null && pain <= painBaseline + 1)) settlingIndex = index;
  });
  if (settlingIndex < 0) return false;
  const changes = entries.slice(settlingIndex + 1).filter((entry) => {
    if (entry.kind === "WELLBEING") return String(entry.structured?.wellbeing ?? "").toLowerCase() === "worse";
    if (entry.kind === "PAIN") return (numberFrom(entry.structured?.pain) ?? -1) >= painThreshold;
    return entry.kind === "BOWEL MOVEMENT" && ((numberFrom(entry.structured?.bristol) ?? 0) >= 6 || !["", "none", "false"].includes(String(entry.structured?.blood ?? "none").toLowerCase()) || entry.structured?.urgency === true);
  });
  return changes.length >= 2 && new Set(changes.map((entry) => entry.date)).size >= 2;
}

function round(value: number, places = 1): string {
  const scale = 10 ** places;
  const rounded = Math.round(value * scale) / scale;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(places);
}

function compareClass(value: number | undefined, baseline: number | undefined): Metric["dClass"] {
  if (value == null || baseline == null) return "flat";
  if (value > baseline * 1.35) return "up";
  if (value > baseline * 1.1) return "warn";
  if (value <= baseline) return "ok";
  return "flat";
}

function deriveMetrics(state: DemoState): Metric[] {
  const { entries: dated } = recentWindow(state, 14);
  const entries = dated.map(({ entry }) => entry);
  const bowel = entries.filter((entry) => entry.kind === "BOWEL MOVEMENT");
  const bowelByDay = bowelCountsByDate(bowel);
  const bowelCounts = [...bowelByDay.values()];
  const bowelAverage = bowelCounts.length ? bowelCounts.reduce((sum, count) => sum + count, 0) / bowelCounts.length : undefined;
  const bowelBaseline = baselineAverage(state.profile.usualBowel);

  const painRatings = entries
    .filter((entry) => entry.kind === "PAIN" || entry.kind === "BOWEL MOVEMENT")
    .map((entry) => numberFrom(entry.structured?.pain))
    .filter((value): value is number => value != null);
  const painAverage = painRatings.length ? painRatings.reduce((sum, value) => sum + value, 0) / painRatings.length : undefined;
  const painBaseline = baselineAverage(state.profile.usualPain);

  const wearable = dated
    .filter(({ entry }) => entry.kind === "FROM YOUR WATCH")
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const latestHeartRate = wearable.map(({ entry }) => numberFrom(entry.structured?.restingHeartRate)).find((value) => value != null);
  const latestSleep = [...dated]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .map(({ entry }) => numberFrom(entry.structured?.sleepHours))
    .find((value) => value != null);
  const heartRateBaseline = firstNumber(state.profile.usualHeartRate);
  const sleepBaseline = firstNumber(state.profile.usualSleep);
  const highFatigue = entries.some((entry) => ["high", "severe"].includes(String(entry.structured?.fatigue ?? "").toLowerCase()));

  const heartComparison = latestHeartRate == null
    ? "No included wearable reading"
    : heartRateBaseline == null
      ? "Personal resting baseline not recorded"
      : `${round(Math.abs(latestHeartRate - heartRateBaseline), 0)} bpm ${latestHeartRate >= heartRateBaseline ? "above" : "below"} your ${heartRateBaseline} bpm baseline`;
  const sleepValue = latestSleep == null ? (highFatigue ? "High" : "—") : `${Math.floor(latestSleep)}h ${String(Math.round((latestSleep % 1) * 60)).padStart(2, "0")}m`;

  return [
    {
      k: "Bowel movements / recorded day",
      v: bowelAverage == null ? "—" : round(bowelAverage),
      d: bowelAverage == null ? "No included bowel logs" : `${bowel.length} included ${bowel.length === 1 ? "log" : "logs"} across ${bowelCounts.length} recorded ${bowelCounts.length === 1 ? "day" : "days"} · baseline ${state.profile.usualBowel || "not set"}`,
      dClass: compareClass(bowelAverage, bowelBaseline),
    },
    {
      k: "Average recorded pain",
      v: painAverage == null ? "—" : round(painAverage),
      unit: painAverage == null ? undefined : "/10",
      d: painAverage == null ? "No included pain rating" : `${painRatings.length} included ${painRatings.length === 1 ? "rating" : "ratings"} · usual ${state.profile.usualPain || "not set"}`,
      dClass: compareClass(painAverage, painBaseline),
    },
    {
      k: "Latest resting heart rate",
      v: latestHeartRate == null ? "—" : round(latestHeartRate, 0),
      unit: latestHeartRate == null ? undefined : " bpm",
      d: heartComparison,
      dClass: compareClass(latestHeartRate, heartRateBaseline),
    },
    {
      k: "Latest sleep & fatigue",
      v: sleepValue,
      d: latestSleep == null
        ? (highFatigue ? "High fatigue is recorded; no included sleep reading" : "No included sleep or fatigue record")
        : `${highFatigue ? "High fatigue recorded · " : ""}usual ${state.profile.usualSleep || "not set"}`,
      dClass: latestSleep != null && sleepBaseline != null && latestSleep < sleepBaseline - 1 ? "warn" : highFatigue ? "warn" : "flat",
    },
  ];
}

function bowelCountsByDate(entries: JournalEntry[]): Map<string, number> {
  const grouped = new Map<string, JournalEntry[]>();
  entries.filter((entry) => entry.kind === "BOWEL MOVEMENT").forEach((entry) => {
    grouped.set(entry.date, [...(grouped.get(entry.date) ?? []), entry]);
  });
  return new Map([...grouped].map(([date, records]) => {
    const explicit = records
      .map((entry) => numberFrom(entry.structured?.dailyCount) ?? numberFrom(entry.structured?.bowelMovements24h))
      .filter((value): value is number => value != null);
    return [date, explicit.length ? Math.max(...explicit) : records.length];
  }));
}

function deriveTrend(state: DemoState): TrendPoint[] {
  const all = datedIncluded(state);
  const endKey = dateInTimeZone(new Date(), state.profile.timeZone);
  const startKey = addCalendarDays(endKey, -13);
  const recent = all.filter(({ entry }) => entry.date >= startKey && entry.date <= endKey && (CLINICAL_KINDS.has(entry.kind) || entry.kind === "LIFE EVENT"));
  if (!recent.some(({ entry }) => CLINICAL_KINDS.has(entry.kind))) return [];
  const byDay = new Map<string, TrendPoint>();
  for (let offset = 0; offset < 14; offset += 1) {
    const key = addCalendarDays(startKey, offset);
    byDay.set(key, { day: key, bowel: 0 });
  }
  const bowelByDate = bowelCountsByDate(recent.map(({ entry }) => entry));
  for (const { entry } of recent) {
    const point = byDay.get(entry.date) ?? { day: entry.date, bowel: 0 };
    const pain = numberFrom(entry.structured?.pain);
    const heartRate = numberFrom(entry.structured?.restingHeartRate);
    if (pain != null) point.symptom = Math.max(point.symptom ?? 0, pain);
    if (heartRate != null) point.heartRate = Math.max(point.heartRate ?? 0, heartRate);
    if (entry.kind === "BOWEL MOVEMENT") point.bowel = bowelByDate.get(entry.date) ?? point.bowel;
    byDay.set(entry.date, point);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).map((point) => ({ ...point, day: formatShortDate(point.day) }));
}

function weekStart(value: string): string | undefined {
  const date = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return undefined;
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function average(values: number[], places = 1): number | undefined {
  if (!values.length) return undefined;
  const scale = 10 ** places;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * scale) / scale;
}

/** Eight patient-calendar weeks, aggregated only from recorded values (never imputed). */
function deriveWeeklyTrend(state: DemoState): TrendPoint[] {
  const currentWeek = weekStart(dateInTimeZone(new Date(), state.profile.timeZone));
  if (!currentWeek) return [];
  const firstWeek = addCalendarDays(currentWeek, -49);
  const recent = datedIncluded(state).filter(({ entry }) => (
    CLINICAL_KINDS.has(entry.kind)
    && entry.date >= firstWeek
    && entry.date <= addCalendarDays(currentWeek, 6)
  ));
  if (!recent.length) return [];
  const bowelByDate = bowelCountsByDate(recent.map(({ entry }) => entry));
  const weeks = new Map<string, { pain: number[]; heartRate: number[]; bowel: number[] }>();
  for (let offset = 0; offset < 8; offset += 1) {
    weeks.set(addCalendarDays(firstWeek, offset * 7), { pain: [], heartRate: [], bowel: [] });
  }
  for (const { entry } of recent) {
    const key = weekStart(entry.date);
    const bucket = key ? weeks.get(key) : undefined;
    if (!bucket) continue;
    const pain = numberFrom(entry.structured?.pain);
    const heartRate = numberFrom(entry.structured?.restingHeartRate);
    if (pain != null) bucket.pain.push(pain);
    if (heartRate != null) bucket.heartRate.push(heartRate);
  }
  for (const [date, count] of bowelByDate) {
    const key = weekStart(date);
    if (key && weeks.has(key)) weeks.get(key)!.bowel.push(count);
  }
  return [...weeks].map(([key, values]) => ({
    day: `w/c ${formatShortDate(key)}`,
    symptom: average(values.pain),
    heartRate: average(values.heartRate, 0),
    bowel: average(values.bowel) ?? 0,
  }));
}

function formatShortDate(value: string): string {
  const date = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(date);
}

function formatLongDate(value: string): string {
  const date = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(date);
}

function recoveryContent(state: DemoState, template: PhaseContent): Pick<PhaseContent, "pill" | "suggestions"> {
  if (state.phase !== "recovery") return { pill: template.pill, suggestions: template.suggestions };
  const treatmentActive = taperTreatmentActive(state);
  const patientToday = dateInTimeZone(new Date(), state.profile.timeZone);
  const scheduledToday = state.taper.days.find((day) => day.date === patientToday);
  const current = treatmentActive ? scheduledToday : state.taper.days.find((day) => day.day === state.taper.currentDay);
  const next = state.taper.days.find((day) => day.day > (current?.day ?? state.taper.currentDay) && day.doseMg !== current?.doseMg);
  const total = state.taper.days.length;
  const verifiedLabel = treatmentActive && state.taper.verified && current && total > 0
    ? `Recovering — taper day ${current.day} of ${total}`
    : treatmentActive && state.taper.verified
      ? "Recovery — no dose scheduled today"
    : treatmentActive
      ? "Recovery support — taper not verified"
      : "Recovery demo — treatment not active";
  return {
    pill: { ...template.pill, label: verifiedLabel },
    suggestions: template.suggestions.map((suggestion) => suggestion.kind !== "taper" ? suggestion : {
      ...suggestion,
      title: treatmentActive && current && state.taper.verified ? `Today’s prescribed dose: ${current.doseMg} mg` : "Dose support unavailable",
      desc: treatmentActive && current && state.taper.verified
        ? `${state.taper.medicine}, exactly as prescribed by ${state.taper.prescribedBy}.${next ? ` Next clinician-authored change is ${next.doseMg} mg on taper day ${next.day}.` : " No further step-down is recorded."}`
        : treatmentActive && state.taper.verified
          ? "No clinician-authored dose falls on the patient’s current local calendar date. Review the imported schedule or contact the named care team if this is unexpected."
        : treatmentActive
          ? "A clinician-authored, verified schedule is required. MeMed never calculates or changes a dose."
          : "The imported schedule remains reviewable, but dose actions start only after treatment is collected or Recovery is confirmed from governed evidence.",
    }),
  };
}

function dynamicSuggestions(state: DemoState, template: PhaseContent): PhaseContent["suggestions"] {
  if (state.phase === "stable") {
    const experimentTitle = state.experiment.title || "a one-variable experiment";
    const experimentSuggestion = state.experiment.status === "active"
      ? { kind: "experiment" as const, icon: "note" as const, title: `${experimentTitle} — day ${state.experiment.day} of ${state.experiment.durationDays}`, desc: "Add a neutral daily observation or pause whenever symptoms or treatment change.", cta: "Open experiment" }
      : state.experiment.status === "complete"
        ? { kind: "experiment" as const, icon: "note" as const, title: `Review completed experiment: ${experimentTitle}`, desc: "The result remains a personal observation, not proof of cause or treatment.", cta: "Review outcome" }
        : { kind: "experiment" as const, icon: "note" as const, title: `${state.experiment.status === "paused" ? "Review before resuming" : "Review candidate"}: ${experimentTitle}`, desc: state.phaseConfirmed ? "Confirm one variable, outcome and burden before anything starts." : "The top-bar demo switch is presentation-only; a governed Stable confirmation is required before starting.", cta: "Open experiment" };
    return [experimentSuggestion, template.suggestions.find((item) => item.kind === "summary")!];
  }
  if (state.phase === "watch") {
    const order = state.testOrder;
    const governedOrderReview = state.phaseConfirmed && !state.pendingPhase && hasGovernedWatchEvidence(state);
    const testSuggestion = order.status === "prepared"
      ? { kind: "test" as const, icon: "flask" as const, title: governedOrderReview ? "Review prepared calprotectin home test" : "Confirm sustained source observations first", desc: "The governed rule requires included change records across more than one day, followed by your delivery and consent review.", cta: governedOrderReview ? "Review test order" : "Review evidence" }
      : order.status === "result"
        ? { kind: "test" as const, icon: "flask" as const, title: `Review calprotectin result${typeof order.result === "number" ? `: ${order.result} µg/g` : ""}`, desc: "Your IBD team must interpret the result with symptoms; sharing still needs your confirmation.", cta: "Review result" }
        : order.status === "shared"
          ? { kind: "test" as const, icon: "flask" as const, title: "Calprotectin result shared", desc: "The objective result is now in the simulated care pathway; it is not an emergency message.", cta: "View care loop" }
          : { kind: "test" as const, icon: "flask" as const, title: `Home-test progress: ${order.status}`, desc: "Track delivery, collection, post-back and laboratory receipt without losing the symptom context.", cta: "Track home test" };
    const teamSuggestion = { kind: "team" as const, icon: "message" as const, title: state.teamMessage.status === "draft" ? "Review an update to your IBD team" : `IBD-team message: ${state.teamMessage.status}`, desc: state.teamMessage.status === "replied" ? "A reply is in the thread; prepare a new editable follow-up only if useful." : "The named advice line remains the first route, and every outgoing message is patient-approved.", cta: "Open message thread" };
    // Contact and the personal care pathway lead; home testing remains a guarded follow-on.
    return [teamSuggestion, testSuggestion];
  }
  if (state.phase === "flare") {
    const prescription = state.prescription;
    const prescriber = prescription.prescriber || "your named prescriber";
    const prescriptionSuggestion = { kind: "prescription" as const, icon: "message" as const, title: prescription.status === "ready" ? `Prescription ready at ${prescription.pharmacy || "your pharmacy"}` : `Prescriber pathway: ${prescription.status.replace("-", " ")}`, desc: `${prescriber} owns any medicine decision. A presentation-only demo switch cannot authorise a request or dose.`, cta: "View prescription flow" };
    return [template.suggestions.find((item) => item.kind === "urgent")!, prescriptionSuggestion];
  }
  return template.suggestions;
}

export function deriveDashboard(state: DemoState): DerivedDashboard {
  const template = TODAY[state.phase];
  const lifecycle = deriveLifecycleProposal(state);
  const recovery = recoveryContent(state, template);
  const suggestions = state.phase === "recovery" ? recovery.suggestions : dynamicSuggestions(state, template);
  const trend = deriveTrend(state);
  const weeklyTrend = deriveWeeklyTrend(state);
  const patientToday = dateInTimeZone(new Date(), state.profile.timeZone);
  const relevantDates = datedIncluded(state).filter(({ entry }) => CLINICAL_KINDS.has(entry.kind));
  const latestDate = relevantDates.length ? new Date(Math.max(...relevantDates.map(({ at }) => at.getTime()))).toISOString().slice(0, 10) : undefined;
  const lifeEvent = datedIncluded(state)
    .filter(({ entry }) => entry.kind === "LIFE EVENT")
    .sort((a, b) => b.at.getTime() - a.at.getTime())[0]?.entry;
  const count = lifecycle.evidence.length;
  const dateCount = new Set(lifecycle.evidence.map((entry) => entry.date)).size;
  const patternHeadline = count === 0
    ? "No included observations currently support a change review"
    : `${count} included ${count === 1 ? "observation supports" : "observations support"} this review across ${dateCount} recorded ${dateCount === 1 ? "day" : "days"}`;

  return {
    content: {
      ...template,
      pill: recovery.pill,
      sub: latestDate
        ? `${formatLongDate(patientToday)} · latest included records (${formatLongDate(latestDate)}) compared with your baseline`
        : `${formatLongDate(patientToday)} · no included health records yet`,
      metrics: deriveMetrics(state),
      trend,
      suggestions,
    },
    weeklyTrend,
    evidence: lifecycle.evidence,
    lifecycle,
    personalPatterns: deriveFoodSymptomPatterns(state),
    patternHeadline,
    patternExplanation: count
      ? `${lifecycle.explanation} This is a possible pattern and does not diagnose a flare. Every cited source can be corrected or excluded before confirmation.`
      : "No included record currently supports an early-change pattern. This absence is not proof that everything is safe; continue to follow the personal care plan.",
    trendTitle: trend.length ? `Included pain, bowel and wearable records · ${trend[0].day}–${trend.at(-1)?.day}` : "Included pain, bowel and wearable records",
    weeklyTrendTitle: weeklyTrend.length ? `Eight-week view · ${weeklyTrend[0].day}–${weeklyTrend.at(-1)?.day}` : "Eight-week included-record view",
    lifeEventNote: lifeEvent ? `A life event was logged on ${formatShortDate(lifeEvent.date)}. It remains context only; the app does not infer that it caused a symptom change.` : undefined,
  };
}

export function clinicalEvidenceChanged(entry: JournalEntry | undefined): boolean {
  return Boolean(entry && CLINICAL_KINDS.has(entry.kind));
}
