import { describe, expect, test } from "vitest";
import { INITIAL_STATE } from "../data";
import { applyExplicitRecordCorrections, buildClinicianSummary, deriveEntryFlagged } from "./stateDerivations";

describe("source-ledger derivations", () => {
  test("updates structured bowel evidence from explicit corrected wording", () => {
    const entry = structuredClone(INITIAL_STATE.entries[0]);

    const structured = applyExplicitRecordCorrections(
      entry,
      "Bristol type 6, urgency, trace blood — corrected by Amara",
    );

    expect(structured).toMatchObject({ bristol: 6, urgency: true, blood: "trace" });
  });

  test("replaces wellbeing detail and clears structured values omitted by a correction", () => {
    const entry = {
      id: 101,
      date: "2026-07-17",
      time: "09:00",
      kind: "WELLBEING" as const,
      body: "Feeling worse than usual · fatigue high · mood low · appetite reduced · sleep 4 h · weight 65 kg",
      source: "manual" as const,
      flagged: true,
      structured: { wellbeing: "worse", fatigue: "high", mood: "low", appetite: "reduced", sleepHours: 4, weightKg: 65, oneTap: true },
    };

    const body = "Feeling better than usual · fatigue low · mood good · sleep 7 h 30 m";
    const structured = applyExplicitRecordCorrections(entry, body)!;

    expect(structured).toMatchObject({ wellbeing: "better", fatigue: "low", mood: "good", sleepHours: 7.5, oneTap: true });
    expect(structured).not.toHaveProperty("appetite");
    expect(structured).not.toHaveProperty("weightKg");
    expect(deriveEntryFlagged({ ...entry, body, structured })).toBe(false);
  });

  test("updates and clears explicit fatigue severity", () => {
    const entry = {
      id: 102,
      date: "2026-07-17",
      time: "09:05",
      kind: "FATIGUE" as const,
      body: "Severe fatigue after 4 hours sleep",
      source: "chat" as const,
      flagged: true,
      structured: { fatigue: "severe", sleepHours: 4, reportedText: "old wording" },
    };

    const updatedBody = "Fatigue low; slept 7.5 hours";
    const updated = applyExplicitRecordCorrections(entry, updatedBody)!;
    expect(updated).toMatchObject({ fatigue: "low", sleepHours: 7.5, reportedText: updatedBody });
    expect(deriveEntryFlagged({ ...entry, body: updatedBody, structured: updated })).toBe(false);

    const unconfirmedBody = "Fatigue reported; severity and sleep were not confirmed";
    const unconfirmed = applyExplicitRecordCorrections(entry, unconfirmedBody)!;
    expect(unconfirmed).not.toHaveProperty("fatigue");
    expect(unconfirmed).not.toHaveProperty("sleepHours");
    expect(unconfirmed.reportedText).toBe(unconfirmedBody);
  });

  test("replaces or clears wearable heart-rate and sleep readings", () => {
    const entry = {
      id: 103,
      date: "2026-07-17",
      time: "09:10",
      kind: "FROM YOUR WATCH" as const,
      body: "Resting HR 64 bpm · HRV 38 ms · sleep 5 h 10 m",
      source: "wearable" as const,
      structured: { restingHeartRate: 64, heartRateVariabilityMs: 38, sleepHours: 5.17, steps: 8200 },
    };

    const updatedBody = "Resting heart rate 58 bpm · HRV 44.5 ms · sleep 7 h 30 m";
    const updated = applyExplicitRecordCorrections(entry, updatedBody)!;
    expect(updated).toMatchObject({ restingHeartRate: 58, heartRateVariabilityMs: 44.5, sleepHours: 7.5, steps: 8200 });
    expect(deriveEntryFlagged({ ...entry, body: updatedBody, structured: updated }, INITIAL_STATE.profile)).toBe(false);

    const cleared = applyExplicitRecordCorrections(entry, "Watch sync completed; measurements unavailable")!;
    expect(cleared).not.toHaveProperty("restingHeartRate");
    expect(cleared).not.toHaveProperty("heartRateVariabilityMs");
    expect(cleared).not.toHaveProperty("sleepHours");
    expect(cleared.steps).toBe(8200);
  });

  test("updates medication adherence and clears an unconfirmed dose", () => {
    const entry = {
      id: 104,
      date: "2026-07-17",
      time: "09:15",
      kind: "MEDICATION" as const,
      body: "Azathioprine 100 mg taken — taper day 12",
      source: "manual" as const,
      structured: { taken: true, doseMg: 100, taperDay: 12, reportedText: "old wording" },
    };

    const missedBody = "I missed azathioprine; dose not confirmed";
    const missed = applyExplicitRecordCorrections(entry, missedBody)!;
    expect(missed).toMatchObject({ taken: false, reportedText: missedBody });
    expect(missed).not.toHaveProperty("doseMg");
    expect(missed).not.toHaveProperty("taperDay");
    expect(deriveEntryFlagged({ ...entry, body: missedBody, structured: missed })).toBe(true);

    const takenBody = "Azathioprine 50 mg taken";
    const taken = applyExplicitRecordCorrections(entry, takenBody)!;
    expect(taken).toMatchObject({ taken: true, doseMg: 50, reportedText: takenBody });
    expect(deriveEntryFlagged({ ...entry, body: takenBody, structured: taken })).toBe(false);
  });

  test("rebuilds summaries only from currently included records", () => {
    const state = structuredClone(INITIAL_STATE);
    state.entries[0].body = "A record that must not remain in the summary";
    state.entries[0].excluded = true;

    const summary = buildClinicianSummary(state);

    expect(summary).not.toContain("A record that must not remain in the summary");
    expect(summary).toContain("rebuilt from currently included records");
    expect(summary).toContain("schedule prepared; dose support is not active; 0 doses marked taken");
    expect(summary).not.toContain("day 12 of 42");
  });

  test("includes recovery check-ins and non-causal experiment observations", () => {
    const state = structuredClone(INITIAL_STATE);
    state.taper.sideEffects = ["Poor sleep", "Mood change"];
    state.taper.checkInComplete = true;
    state.experiment.status = "complete";
    state.experiment.day = 14;
    state.experiment.observations = [
      "Day 14: Morning urgency was unchanged.",
      "Outcome review (personal observation, not proof): I did not notice a clear difference.",
    ];
    state.entries.unshift({
      id: 9999,
      date: "2026-07-17",
      time: "20:00",
      kind: "LIFE EVENT",
      body: "Diet experiment completed: Oat milk instead of dairy milk. Personal outcome review: I did not notice a clear difference.",
      source: "manual",
      structured: { experimentEvent: "complete", experimentId: state.experiment.id, experimentObservation: "I did not notice a clear difference.", day: 14 },
    });

    const summary = buildClinicianSummary(state);

    expect(summary).toContain("Patient-recorded recovery observations: Poor sleep, Mood change");
    expect(summary).toContain("latest recovery side-effect check-in is marked complete");
    expect(summary).toContain("Diet experiment: Oat milk instead of dairy milk; status complete; 14 of 14 planned days recorded");
    expect(summary).toContain("Personal observations (not causal conclusions)");
    expect(summary).toContain("I did not notice a clear difference");
  });

  test("does not reuse an excluded care-workflow result as clinical evidence", () => {
    const state = structuredClone(INITIAL_STATE);
    state.testOrder.result = 420;
    state.testOrder.status = "result";
    state.entries.unshift({
      id: 90,
      date: "2026-07-17",
      time: "10:00",
      kind: "TEST RESULT",
      body: "Faecal calprotectin 420 µg/g — clinical interpretation required",
      source: "care",
      excluded: true,
      structured: { calprotectin: 420, diagnostic: false },
    });

    const excluded = buildClinicianSummary(state);
    expect(excluded).not.toContain("Faecal calprotectin: 420 µg/g");
    expect(excluded).toContain("journal evidence is excluded or deleted");

    state.entries[0].excluded = false;
    expect(buildClinicianSummary(state)).toContain("Faecal calprotectin: 420 µg/g");
  });
});
