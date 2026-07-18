import type { DemoState, Profile } from "../types";
import { taperCourseComplete } from "./recoveryGovernance";

type BaselineFields = Pick<Profile, "usualBowel" | "usualPain" | "usualHeartRate" | "usualSleep">;

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rounded(value: number, places = 1): string {
  const scale = 10 ** places;
  return String(Math.round(value * scale) / scale);
}

export function deriveRecoveredBaselineProposal(state: DemoState): { values: Partial<BaselineFields>; evidenceIds: number[] } | undefined {
  if (state.phase !== "stable" || !taperCourseComplete(state)) return undefined;
  const included = state.entries
    .filter((entry) => !entry.excluded)
    .sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
  let marker = -1;
  included.forEach((entry, index) => {
    if (entry.kind === "WELLBEING" && ["better", "settling", "baseline"].includes(String(entry.structured?.wellbeing ?? "").toLowerCase())) marker = index;
  });
  if (marker < 0) return undefined;
  const recovered = included.slice(marker);
  const values: Partial<BaselineFields> = {};
  const bowelRecordsByDay = new Map<string, typeof recovered>();
  recovered.filter((entry) => entry.kind === "BOWEL MOVEMENT").forEach((entry) => {
    bowelRecordsByDay.set(entry.date, [...(bowelRecordsByDay.get(entry.date) ?? []), entry]);
  });
  const bowelByDay = new Map([...bowelRecordsByDay].map(([day, records]) => {
    const explicit = records
      .map((entry) => numeric(entry.structured?.dailyCount) ?? numeric(entry.structured?.bowelMovements24h))
      .filter((value): value is number => value !== undefined);
    return [day, explicit.length ? Math.max(...explicit) : records.length];
  }));
  const bowelCounts = [...bowelByDay.values()];
  if (bowelCounts.length) values.usualBowel = `${rounded(bowelCounts.reduce((sum, value) => sum + value, 0) / bowelCounts.length)} recorded bowel movements per tracked day after recovery`;
  const pain = recovered.map((entry) => numeric(entry.structured?.pain)).filter((value): value is number => value != null);
  if (pain.length) values.usualPain = `${rounded(pain.reduce((sum, value) => sum + value, 0) / pain.length)}/10 across recovered records`;
  const heartRate = recovered.map((entry) => numeric(entry.structured?.restingHeartRate)).filter((value): value is number => value != null);
  if (heartRate.length) values.usualHeartRate = `${rounded(heartRate.reduce((sum, value) => sum + value, 0) / heartRate.length, 0)} bpm resting across recovered records`;
  const sleep = recovered.map((entry) => numeric(entry.structured?.sleepHours)).filter((value): value is number => value != null);
  if (sleep.length) values.usualSleep = `${rounded(sleep.reduce((sum, value) => sum + value, 0) / sleep.length)} hours across recovered records`;
  if (!Object.keys(values).length) return undefined;
  return { values, evidenceIds: recovered.map((entry) => entry.id) };
}
