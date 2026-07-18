import type { DemoState, JournalEntry } from "../types";
import { experimentTimelineObservations } from "./experimentSafety";
import { extractStructuredSafetyDetails, screenStructuredEntry } from "./captureService";
import { dateInTimeZone } from "./patientTime";

type StructuredRecord = NonNullable<JournalEntry["structured"]>;

function withoutFields(structured: JournalEntry["structured"], fields: string[]): StructuredRecord {
  const next = { ...(structured ?? {}) };
  fields.forEach((field) => delete next[field]);
  return next;
}

function parseFatigue(lower: string): string | undefined {
  if (/\b(?:no fatigue|not fatigued)\b/.test(lower)) return "none";
  const severity = lower.match(/\b(?:fatigue|tiredness)\s*(?:is|was|:|-)?\s*(none|low|mild|moderate|high|severe)\b/)?.[1]
    ?? lower.match(/\b(none|low|mild|moderate|high|severe)\s+(?:fatigue|tiredness)\b/)?.[1];
  if (severity) return severity === "mild" ? "low" : severity;
  if (/\b(?:exhausted|shattered)\b/.test(lower)) return "high";
  return undefined;
}

function parseSleepHours(lower: string): number | undefined {
  const forward = lower.match(/\b(?:sleep(?:ing)?|slept|got)\s*(?:was|is|for|:|-)?\s*(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b(?:\s*(\d{1,2})\s*(?:minutes?|mins?|m)\b)?/);
  const reverse = lower.match(/\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b(?:\s*(\d{1,2})\s*(?:minutes?|mins?|m)\b)?\s+(?:of\s+)?sleep\b/);
  const match = forward ?? reverse;
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours < 0 || hours > 24 || minutes < 0 || minutes >= 60) return undefined;
  return Math.round((hours + minutes / 60) * 100) / 100;
}

function parseWellbeing(lower: string): string | undefined {
  if (/\b(?:back|returned?)\s+to\s+(?:my\s+)?(?:usual|baseline)|\bat\s+(?:my\s+)?baseline\b/.test(lower)) return "baseline";
  if (/\bsettling\b/.test(lower)) return "settling";
  return lower.match(/\b(?:feel(?:ing)?\s+)?(better|same|worse)\s+(?:than|as)\s+(?:usual|normal)\b/)?.[1]
    ?? lower.match(/\bwellbeing\s*(?:is|was|:|-)?\s*(better|same|worse)\b/)?.[1];
}

function parseMood(lower: string): string | undefined {
  return lower.match(/\bmood\s*(?:is|was|:|-)?\s*(good|low|anxious|irritable)\b/)?.[1];
}

function parseAppetite(lower: string): string | undefined {
  if (/\b(?:no appetite|without an appetite)\b/.test(lower)) return "none";
  const appetite = lower.match(/\bappetite\s*(?:is|was|:|-)?\s*(usual|reduced|low|poor|increased)\b/)?.[1];
  if (appetite === "low" || appetite === "poor") return "reduced";
  return appetite;
}

function parseWeightKg(lower: string): number | undefined {
  const match = lower.match(/\b(?:weight\s*(?:is|was|:|-)?|weigh(?:ed|s|ing)?\s*)\s*(\d+(?:\.\d+)?)\s*(?:kg|kilograms?)\b/);
  if (!match) return undefined;
  const weight = Number(match[1]);
  return Number.isFinite(weight) && weight >= 20 && weight <= 400 ? weight : undefined;
}

function firstNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const number = Number(value.match(/\d+(?:\.\d+)?/)?.[0]);
  return Number.isFinite(number) ? number : undefined;
}

export function applyExplicitRecordCorrections(entry: JournalEntry, body: string): JournalEntry["structured"] {
  const lower = body.toLowerCase();
  let structured = { ...(entry.structured ?? {}) };

  if (entry.kind === "BOWEL MOVEMENT") {
    const bristol = lower.match(/(?:bristol(?:\s+type)?|stool\s+type|type)\s*([1-7])/);
    if (bristol) structured.bristol = Number(bristol[1]);
    if (/\b(?:no|without)\s+(?:visible\s+)?blood\b/.test(lower)) structured.blood = "none";
    else if (/\b(?:heavy|continuous)\b.{0,18}\b(?:blood|bleeding)\b|\b(?:blood|bleeding)\b.{0,18}\b(?:heavy|continuous)\b/.test(lower)) structured.blood = "heavy";
    else if (/\bmoderate\b.{0,18}\b(?:blood|bleeding)\b/.test(lower)) structured.blood = "moderate";
    else if (/\b(?:trace|small|tiny|little)\b.{0,22}\bblood\b/.test(lower)) structured.blood = lower.match(/\b(trace|small|tiny|little)\b/)?.[1] ?? "small";
    if (/\b(?:no|without)\s+urgency\b/.test(lower)) structured.urgency = false;
    else if (/\burgency|\burgent\b/.test(lower)) structured.urgency = true;
    if (/\b(?:no|without)\s+mucus\b/.test(lower)) structured.mucus = false;
    else if (/\bmucus\b/.test(lower)) structured.mucus = true;
    if (/\b(?:no|without)\s+(?:night\s+waking|waking\s+at\s+night)\b/.test(lower)) structured.nightWaking = false;
    else if (/\bnight\s+waking|\bwoke\b.{0,12}\bnight\b/.test(lower)) structured.nightWaking = true;
    const pain = lower.match(/\bpain\D{0,12}(10|[0-9])\s*(?:\/\s*10)?/);
    if (pain) structured.pain = Number(pain[1]);
  }

  if (entry.kind === "PAIN") {
    const pain = lower.match(/(?:\bpain\D{0,12})?\b(10|[0-9])\s*\/\s*10\b/);
    if (pain) structured.pain = Number(pain[1]);
    if (/\bno\s+pain\b/.test(lower)) structured.pain = 0;
  }

  if (entry.kind === "WELLBEING") {
    structured = withoutFields(structured, [
      "wellbeing", "fatigue", "mood", "appetite", "sleepHours", "weightKg",
      "blood", "pain", "severePain", "fever", "feverC", "faint", "dehydration",
      "vomiting", "persistentVomiting", "possibleObstruction", "cannotPassStoolOrGas",
      "abdominalDistension", "infectionConcern", "moodConcern", "seriousMoodConcern",
      "newSwellingConcern", "symptomsWorse",
    ]);
    const wellbeing = parseWellbeing(lower);
    const fatigue = parseFatigue(lower);
    const mood = parseMood(lower);
    const appetite = parseAppetite(lower);
    const sleepHours = parseSleepHours(lower);
    const weightKg = parseWeightKg(lower);
    if (wellbeing) structured.wellbeing = wellbeing;
    if (fatigue) structured.fatigue = fatigue;
    if (mood) structured.mood = mood;
    if (appetite) structured.appetite = appetite;
    if (sleepHours != null) structured.sleepHours = sleepHours;
    if (weightKg != null) structured.weightKg = weightKg;
    structured = { ...structured, ...extractStructuredSafetyDetails(body) };
    if (/\b(?:possible\s+)?infection\s+(?:concern|while\s+taking\s+steroids?)\b/.test(lower)) structured.infectionConcern = true;
    if (/\bserious\s+mood\s+(?:change|concern)\b/.test(lower)) structured.seriousMoodConcern = true;
    if (/\bnew\s+swelling\b/.test(lower)) structured.newSwellingConcern = true;
    if (/\bsymptoms?\s+(?:are\s+|is\s+)?wors(?:e|ening)(?:\s+again)?\b/.test(lower) && structured.taperCheckIn === true) structured.symptomsWorse = true;
  }

  if (entry.kind === "FATIGUE") {
    structured = withoutFields(structured, ["fatigue", "sleepHours", "reportedText"]);
    const fatigue = parseFatigue(lower);
    const sleepHours = parseSleepHours(lower);
    if (fatigue) structured.fatigue = fatigue;
    if (sleepHours != null) structured.sleepHours = sleepHours;
    structured.reportedText = body.trim();
  }

  if (entry.kind === "FROM YOUR WATCH") {
    structured = withoutFields(structured, ["restingHeartRate", "heartRateVariabilityMs", "sleepHours"]);
    const heartRateMatch = lower.match(/\b(?:resting\s+(?:heart\s+rate|hr)|rhr)\s*(?:was|is|:|-)?\s*(\d{2,3})\s*(?:bpm)?\b/);
    const hrvMatch = lower.match(/\b(?:hrv|heart[- ]rate variability)\s*(?:was|is|:|-)?\s*(\d+(?:\.\d+)?)\s*(?:ms|milliseconds?)\b/);
    const restingHeartRate = Number(heartRateMatch?.[1]);
    const heartRateVariabilityMs = Number(hrvMatch?.[1]);
    const sleepHours = parseSleepHours(lower);
    if (Number.isFinite(restingHeartRate) && restingHeartRate >= 20 && restingHeartRate <= 250) structured.restingHeartRate = restingHeartRate;
    if (Number.isFinite(heartRateVariabilityMs) && heartRateVariabilityMs >= 1 && heartRateVariabilityMs <= 500) structured.heartRateVariabilityMs = heartRateVariabilityMs;
    if (sleepHours != null) structured.sleepHours = sleepHours;
  }

  if (entry.kind === "MEDICATION") {
    structured = withoutFields(structured, ["taken", "doseMg", "taperDay", "reportedText"]);
    const notTaken = /\b(?:did\s+not\s+take|didn't\s+take|not\s+taken|haven't\s+taken|hasn't\s+been\s+taken|missed|skipped|forgot(?:ten)?\s+to\s+take)\b/.test(lower);
    const taken = /\b(?:took|taken)\b/.test(lower);
    const doseMatch = lower.match(/\b(\d+(?:\.\d+)?)\s*mg\b/);
    const taperDayMatch = lower.match(/\btaper\s+day\s*(\d+)\b/);
    if (notTaken) structured.taken = false;
    else if (taken) structured.taken = true;
    if (doseMatch) structured.doseMg = Number(doseMatch[1]);
    if (taperDayMatch) structured.taperDay = Number(taperDayMatch[1]);
    structured.reportedText = body.trim();
  }

  return structured;
}

export function deriveEntryFlagged(entry: JournalEntry, profile?: DemoState["profile"]): boolean {
  const structured = entry.structured ?? {};
  if (entry.kind === "BOWEL MOVEMENT") {
    const blood = String(structured.blood ?? "none").toLowerCase();
    return !["", "none", "false"].includes(blood) || (firstNumber(structured.pain) ?? -1) >= 7;
  }
  if (entry.kind === "PAIN") return (firstNumber(structured.pain) ?? -1) >= 7;
  if (entry.kind === "WELLBEING") {
    return String(structured.wellbeing ?? "").toLowerCase() === "worse"
      || ["high", "severe"].includes(String(structured.fatigue ?? "").toLowerCase())
      || screenStructuredEntry(entry, profile).length > 0;
  }
  if (entry.kind === "FATIGUE") return ["high", "severe"].includes(String(structured.fatigue ?? "").toLowerCase());
  if (entry.kind === "MEDICATION") return structured.taken === false;
  if (entry.kind === "FROM YOUR WATCH") {
    const heartRate = firstNumber(structured.restingHeartRate);
    const sleepHours = firstNumber(structured.sleepHours);
    const heartRateBaseline = firstNumber(profile?.usualHeartRate);
    const sleepBaseline = firstNumber(profile?.usualSleep);
    return (heartRate != null && heartRateBaseline != null && heartRate >= heartRateBaseline + 5)
      || (sleepHours != null && sleepBaseline != null && sleepHours <= sleepBaseline - 1);
  }
  return Boolean(entry.flagged);
}

export function buildClinicianSummary(state: DemoState, entries = state.entries): string {
  const allIncluded = entries
    .filter((entry) => !entry.excluded && entry.kind !== "Penny noticed")
    .sort((a, b) => `${b.date}T${b.time}`.localeCompare(`${a.date}T${a.time}`));
  const included = allIncluded.slice(0, 10);
  const patient = state.profile.name.trim() || "The patient";
  const baseline = [state.profile.usualBowel, state.profile.usualPain, state.profile.usualHeartRate, state.profile.usualSleep].filter(Boolean).join("; ");
  const lines = included.map((entry) => `- ${entry.date} ${entry.time} — ${entry.kind}: ${entry.body}`);
  const includedTest = allIncluded.find((entry) => entry.kind === "TEST RESULT" && entry.source === "care" && ["result", "shared"].includes(state.testOrder.status) && typeof entry.structured?.calprotectin === "number" && entry.structured.calprotectin === state.testOrder.result);
  const includedResult = includedTest?.structured?.calprotectin;
  const result = typeof includedResult === "number"
    ? `Faecal calprotectin: ${includedResult} µg/g; clinical interpretation is required.`
    : state.testOrder.result == null
      ? "No test result is recorded."
      : "A test result exists in the care workflow, but its journal evidence is excluded or deleted and is not used in this summary.";
  const taperTaken = state.taper.days.filter((day) => day.taken).length;
  const taperMissed = state.taper.missedDays.length
    ? `; ${state.taper.missedDays.length} past doses explicitly reconciled as not taken (days ${state.taper.missedDays.join(", ")})`
    : "; no past doses explicitly reconciled as not taken";
  const taperActive = state.prescription.status === "collected"
    || (state.phase === "recovery" && state.phaseConfirmed && !state.pendingPhase);
  const scheduledToday = state.taper.days.find((day) => day.date === dateInTimeZone(new Date(), state.profile.timeZone));
  const taperPosition = taperActive
    ? scheduledToday
      ? `day ${scheduledToday.day} of ${state.taper.days.length || "an incomplete schedule"}`
      : "no dose row on today’s patient-local calendar date"
    : "schedule prepared; dose support is not active";
  const taperSummary = state.taper.medicine || state.taper.days.length
    ? [
        `Patient-recorded prescribed course: ${state.taper.medicine || "medicine not recorded"}; ${state.taper.verified ? `verified from ${state.taper.prescribedBy || "the recorded prescriber"}` : "not yet verified"}; ${taperPosition}; ${taperTaken} dose${taperTaken === 1 ? "" : "s"} marked taken${taperMissed}.`,
        state.taper.checkInComplete ? "The latest recovery side-effect check-in is marked complete." : "The latest recovery side-effect check-in is not marked complete.",
        state.taper.sideEffects.length ? `Patient-recorded recovery observations: ${state.taper.sideEffects.join(", ")}.` : "No recovery side effects are currently recorded.",
      ].join(" ")
    : "No prescribed recovery course is recorded.";
  const experimentObservations = experimentTimelineObservations(state).slice(-6).map((item) => item.label);
  const experimentSummary = state.experiment.title
    ? [
        `Diet experiment: ${state.experiment.title}; status ${state.experiment.status}; ${state.experiment.day} of ${state.experiment.durationDays} planned days recorded.`,
        `One variable: ${state.experiment.variable || "not defined"}. Goal: ${state.experiment.goal || "not defined"}. Pre-start baseline: ${state.experiment.baseline || "not recorded"}. Outcome defined before starting: ${state.experiment.outcome || "not defined"}.`,
        state.experiment.reviewApprovedAt
          ? `Clinical-team approval was recorded for this unchanged candidate by ${state.experiment.reviewApprovedBy}.`
          : state.experiment.reviewRequired
            ? "Dietitian or IBD-team review is required before this candidate can start."
            : "No pre-start clinical review is recorded as required for this candidate.",
        experimentObservations.length ? `Personal observations (not causal conclusions):\n${experimentObservations.map((observation) => `- ${observation}`).join("\n")}` : "No personal experiment observations are recorded.",
      ].join("\n")
    : "No diet experiment is recorded.";
  return [
    `${patient}’s editable Gutsy summary, rebuilt from currently included records.`,
    baseline ? `Personal baseline: ${baseline}.` : "Personal baseline has not been completed.",
    state.profile.currentMedicines ? `Patient-recorded current medicines: ${state.profile.currentMedicines}.` : "No current medicine list is recorded.",
    result,
    taperSummary,
    experimentSummary,
    lines.length ? `Recent included records:\n${lines.join("\n")}` : "No included journal records are available.",
    "This is a patient-reviewed record, not a diagnosis or medication instruction. No medication change has been made by Gutsy.",
  ].join("\n\n");
}
