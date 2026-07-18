import { expect, test } from "vitest";
import { INITIAL_STATE } from "../data";
import { deriveRecoveredBaselineProposal } from "./baselineService";

test("prepares a patient-reviewable recovered baseline without silently applying it", () => {
  const state = structuredClone(INITIAL_STATE);
  state.phase = "stable";
  state.taper.days.forEach((day, index) => {
    day.taken = true;
    day.date = new Date(Date.UTC(2026, 5, 6 + index)).toISOString().slice(0, 10);
  });
  state.entries.push(
    { id: 201, date: "2026-07-17", time: "18:00", kind: "WELLBEING", body: "Back at baseline", source: "manual", structured: { wellbeing: "baseline", sleepHours: 7.5 } },
    { id: 202, date: "2026-07-17", time: "19:00", kind: "PAIN", body: "Pain 1/10", source: "manual", structured: { pain: 1 } },
    { id: 203, date: "2026-07-17", time: "20:00", kind: "BOWEL MOVEMENT", body: "Five today", source: "manual", structured: { bristol: 4, bowelMovements24h: 5 } },
    { id: 204, date: "2026-07-17", time: "20:30", kind: "BOWEL MOVEMENT", body: "Individual log", source: "manual", structured: { bristol: 4 } },
    { id: 205, date: "2026-07-17", time: "21:00", kind: "BOWEL MOVEMENT", body: "Individual log", source: "manual", structured: { bristol: 4 } },
  );
  const proposal = deriveRecoveredBaselineProposal(state);
  expect(proposal?.values).toMatchObject({ usualBowel: expect.stringContaining("5 recorded bowel movements"), usualPain: expect.stringContaining("1/10"), usualSleep: expect.stringContaining("7.5") });
  expect(state.profile.usualPain).toBe(INITIAL_STATE.profile.usualPain);
});
