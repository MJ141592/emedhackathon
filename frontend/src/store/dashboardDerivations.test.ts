import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { INITIAL_STATE } from "../data";
import { emptyDemoState } from "./demoRepository";
import { canConfirmStableBaseline, deriveDashboard, deriveLifecycleProposal } from "./dashboardDerivations";
import { addCalendarDays, dateInTimeZone } from "./patientTime";

function state() {
  return structuredClone(INITIAL_STATE);
}

function cleanStableState() {
  const current = emptyDemoState();
  current.profile = {
    ...current.profile,
    name: "Sam Rivera",
    dateOfBirth: "1990-04-12",
    diagnosis: "Crohn’s disease",
    usualBowel: "1–2 formed bowel movements/day",
    usualPain: "0–1/10",
    usualHeartRate: "62 bpm resting",
    usualSleep: "7.5 hours",
    carePlan: "Contact the IBD advice line if symptoms change.",
    address: "10 Example Road, London",
    postcode: "W1 1AA",
    adultEligibilityConfirmed: true,
    healthDataConsent: true,
    consentRecordedAt: "2026-07-18T08:00:00.000Z",
    onboardingComplete: true,
  };
  return current;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-17T12:00:00.000Z"));
});

afterEach(() => vi.useRealTimers());

describe("record-derived dashboard", () => {
  test("rebuilds metrics, trend and evidence count from included source records", () => {
    const dashboard = deriveDashboard(state());

    expect(dashboard.content.metrics.map((metric) => metric.v)).toEqual(["1", "4.5", "64", "5h 10m"]);
    expect(dashboard.content.metrics[0].d).toContain("2 logs over 2 days");
    expect(dashboard.content.trend).toHaveLength(14);
    expect(dashboard.content.trend[0].day).toBe("4 Jul");
    expect(dashboard.content.trend.at(-1)?.day).toBe("17 Jul");
    expect(dashboard.weeklyTrend).toHaveLength(8);
    expect(dashboard.weeklyTrend.at(-1)?.day).toBe("w/c 13 Jul");
    expect(dashboard.weeklyTrendTitle).toMatch(/Eight-week view/);
    expect(dashboard.evidence.map((entry) => entry.id)).toEqual([2, 1, 5, 6]);
    expect(dashboard.patternHeadline).toBe("4 included observations support this review across 2 recorded days");
    expect(dashboard.patternExplanation).toContain("does not diagnose a flare");
    expect(dashboard.content.suggestions.map((suggestion) => suggestion.kind)).toEqual(["team", "test"]);
  });

  test("corrections and exclusions remove stale values instead of retaining fixture metrics", () => {
    const current = state();
    current.entries[0].structured = { bristol: 4, urgency: false, blood: "none", nightWaking: false, pain: 0 };
    current.entries.forEach((entry) => {
      if ([2, 5, 6].includes(entry.id)) entry.excluded = true;
    });

    const dashboard = deriveDashboard(current);

    expect(dashboard.content.metrics.map((metric) => metric.v)).toEqual(["1", "0", "—", "—"]);
    expect(dashboard.evidence).toEqual([]);
    expect(dashboard.patternHeadline).toMatch(/^No included observations/);
    expect(dashboard.lifecycle.proposedPhase).toBeUndefined();
  });

  test("uses an explicit daily bowel total without double-counting individual logs", () => {
    const current = state();
    current.entries.forEach((entry) => {
      if (entry.kind === "BOWEL MOVEMENT") entry.excluded = true;
    });
    current.entries.push(
      { id: 301, date: "2026-07-17", time: "09:00", kind: "BOWEL MOVEMENT", body: "Individual log", source: "manual", structured: {} },
      { id: 302, date: "2026-07-17", time: "10:00", kind: "BOWEL MOVEMENT", body: "Five today", source: "manual", structured: { bowelMovements24h: 5 } },
      { id: 303, date: "2026-07-17", time: "11:00", kind: "BOWEL MOVEMENT", body: "Individual log", source: "manual", structured: {} },
    );

    const dashboard = deriveDashboard(current);

    expect(dashboard.content.metrics[0].v).toBe("5");
    expect(dashboard.content.trend.find((point) => point.day === "17 Jul")?.bowel).toBe(5);
  });

  test("uses the verified patient-local calendar day and dose in recovery content", () => {
    const current = state();
    current.phase = "recovery";
    current.phaseConfirmed = true;
    current.prescription.status = "collected";
    current.prescription.treatmentStartedAt = "2026-07-16T08:00:00.000Z";
    current.taper.currentDay = 20;
    const today = dateInTimeZone(new Date(), current.profile.timeZone);
    current.taper.days = current.taper.days.map((day, index) => ({ ...day, date: addCalendarDays(today, index - 19) }));

    const dashboard = deriveDashboard(current);

    expect(dashboard.content.pill.label).toBe("Recovering — taper day 20 of 42");
    expect(dashboard.content.suggestions.find((suggestion) => suggestion.kind === "taper")?.title).toBe("Today’s prescribed dose: 20 mg");
  });

  test("does not expose a dose from a presentation-only Recovery state", () => {
    const current = state();
    current.phase = "recovery";
    current.phaseConfirmed = false;
    current.prescription.status = "prepared";

    const dashboard = deriveDashboard(current);

    expect(dashboard.content.pill.label).toBe("Recovery demo — treatment not active");
    expect(dashboard.content.suggestions.find((suggestion) => suggestion.kind === "taper")?.title).toBe("Dose support unavailable");
  });

  test("uses patient-entered sleep in the current metric and preserves calendar gaps", () => {
    const current = state();
    current.entries.unshift({ id: 88, date: "2026-07-17", time: "12:00", kind: "WELLBEING", body: "Slept 6.5 hours", source: "manual", structured: { sleepHours: 6.5 } });
    const dashboard = deriveDashboard(current);
    expect(dashboard.content.metrics[3].v).toBe("6h 30m");
    expect(dashboard.content.trend.some((point) => point.day === "15 Jul" && point.bowel === 0)).toBe(true);
  });

  test("builds a food–symptom episode from exact included sources without claiming cause", () => {
    const current = state();
    const dashboard = deriveDashboard(current);
    const pattern = dashboard.personalPatterns[0];

    expect(pattern.kind).toBe("food-symptom-episode");
    expect(pattern.sourceEntryIds).toEqual([4, 6, 5]);
    expect(pattern.summary).toContain("2026-07-16 19:30");
    expect(pattern.disclaimer).toMatch(/correlation is not proof/i);

    current.entries.find((entry) => entry.id === 4)!.excluded = true;
    expect(deriveDashboard(current).personalPatterns).toEqual([]);
  });
});

describe("evidence-backed lifecycle proposals", () => {
  test("proposes watchful review from multiple patient-reported changes, never from a wearable alone", () => {
    const current = state();
    current.phase = "stable";
    current.phaseConfirmed = true;
    expect(deriveLifecycleProposal(current).proposedPhase).toBe("watch");

    current.entries.forEach((entry) => {
      if (entry.kind !== "FROM YOUR WATCH") entry.excluded = true;
    });
    const wearable = current.entries.find((entry) => entry.kind === "FROM YOUR WATCH")!;
    wearable.structured = { ...wearable.structured, activitySteps: 1_200 };
    const softOnly = deriveLifecycleProposal(current);
    expect(softOnly.proposedPhase).toBeUndefined();
    expect(new Set(softOnly.signals.map((signal) => signal.key))).toEqual(new Set([
      "resting_heart_rate",
      "sleep_context",
      "hrv_context",
      "activity_context",
    ]));
    expect(softOnly.signals.every((signal) => signal.clinical === false)).toBe(true);
  });

  test("only proposes flare support after objective test evidence is recorded", () => {
    const current = state();
    current.phase = "watch";
    current.phaseConfirmed = true;
    expect(deriveLifecycleProposal(current).proposedPhase).toBeUndefined();

    current.testOrder.status = "result";
    current.testOrder.result = 420;
    current.entries.unshift({ id: 90, date: "2026-07-17", time: "10:00", kind: "TEST RESULT", body: "Calprotectin 420 µg/g", source: "care", structured: { calprotectin: 420, diagnostic: false } });
    const proposal = deriveLifecycleProposal(current);
    expect(proposal.proposedPhase).toBe("flare");
    expect(proposal.explanation).toContain("clinician still establishes and treats a flare");

    current.entries[0].excluded = true;
    expect(deriveLifecycleProposal(current).proposedPhase).toBeUndefined();
  });

  test("does not reuse pre-treatment evidence as a recovery relapse", () => {
    const current = state();
    current.phase = "recovery";
    current.phaseConfirmed = true;

    const proposal = deriveLifecycleProposal(current);

    expect(proposal.proposedPhase).toBeUndefined();
  });

  test("requires settling after collection and detects only later relapse records", () => {
    const current = state();
    current.phase = "flare";
    current.prescription.status = "collected";
    current.prescription.treatmentStartedAt = "2026-07-14T08:00:00.000Z";
    current.entries.unshift(
      { id: 100, date: "2026-07-15", time: "11:00", kind: "WELLBEING", body: "Feeling better", source: "manual", structured: { wellbeing: "better" } },
      { id: 101, date: "2026-07-16", time: "12:00", kind: "PAIN", body: "Pain 2/10", source: "manual", structured: { pain: 2 } },
    );
    expect(deriveLifecycleProposal(current).proposedPhase).toBe("recovery");

    current.phase = "recovery";
    current.entries.unshift(
      { id: 103, date: "2026-07-17", time: "14:00", kind: "PAIN", body: "Pain 7/10", source: "manual", structured: { pain: 7 } },
      { id: 102, date: "2026-07-16", time: "13:00", kind: "BOWEL MOVEMENT", body: "Loose and urgent", source: "manual", structured: { bristol: 7, urgency: true } },
    );
    expect(deriveLifecycleProposal(current).proposedPhase).toBe("flare");
  });

  test("compares treatment instants with patient-local entry times across UTC midnight", () => {
    vi.setSystemTime(new Date("2026-07-19T08:00:00.000Z"));
    const current = state();
    current.profile.timeZone = "America/Los_Angeles";
    current.phase = "flare";
    current.prescription.status = "collected";
    // 23:30 on 17 July for this patient, although the UTC date is already 18 July.
    current.prescription.treatmentStartedAt = "2026-07-18T06:30:00.000Z";
    current.entries.forEach((entry) => { entry.excluded = true; });
    current.entries.unshift(
      { id: 130, date: "2026-07-17", time: "23:20", kind: "WELLBEING", body: "Better before collection", source: "manual", structured: { wellbeing: "better" } },
      { id: 131, date: "2026-07-17", time: "23:40", kind: "WELLBEING", body: "Better after collection", source: "manual", structured: { wellbeing: "better" } },
      { id: 132, date: "2026-07-18", time: "10:00", kind: "PAIN", body: "Pain 1/10", source: "manual", structured: { pain: 1 } },
    );

    const proposal = deriveLifecycleProposal(current);

    expect(proposal.proposedPhase).toBe("recovery");
    expect(proposal.signals.find((signal) => signal.key === "settling")?.evidenceEntryIds)
      .toEqual(expect.arrayContaining([131, 132]));
    expect(proposal.signals.find((signal) => signal.key === "settling")?.evidenceEntryIds)
      .not.toContain(130);
  });

  test("uses the maintained pain baseline rather than a fixed threshold", () => {
    const current = state();
    current.phase = "stable";
    current.profile.usualPain = "5/10";
    current.entries.forEach((entry) => {
      if (entry.kind === "BOWEL MOVEMENT") entry.structured = { bristol: 4, blood: "none", urgency: false };
      if (entry.kind === "PAIN") entry.structured = { pain: 6 };
    });
    expect(deriveLifecycleProposal(current).signals.some((candidate) => candidate.key === "pain")).toBe(false);
  });

  test("two one-tap worse check-ins on recorded days propose a watchful review", () => {
    const current = state();
    current.phase = "stable";
    current.entries.forEach((entry) => { entry.excluded = true; });
    current.entries.unshift(
      { id: 120, date: "2026-07-16", time: "11:00", kind: "WELLBEING", body: "Feeling worse than usual", source: "manual", structured: { wellbeing: "worse", oneTap: true } },
      { id: 121, date: "2026-07-17", time: "15:00", kind: "WELLBEING", body: "Still feeling worse than usual", source: "manual", structured: { wellbeing: "worse", oneTap: true } },
    );

    const proposal = deriveLifecycleProposal(current);
    expect(proposal.proposedPhase).toBe("watch");
    expect(proposal.signals.find((candidate) => candidate.key === "wellbeing_worse")?.evidenceEntryIds).toHaveLength(2);
  });
});

describe("governed Stable starting baseline", () => {
  test("allows a clean complete onboarding and rejects presentation or safety instability", () => {
    const clean = cleanStableState();
    expect(canConfirmStableBaseline(clean)).toBe(true);

    const presentation = state();
    presentation.phase = "stable";
    presentation.phaseConfirmed = false;
    presentation.pendingPhase = undefined;
    expect(canConfirmStableBaseline(presentation)).toBe(false);

    clean.safetyAlert = { id: 1, level: "same-day", triggers: ["Fever"], message: "Contact the clinical team today.", createdAt: "2026-07-18T08:30:00.000Z" };
    expect(canConfirmStableBaseline(clean)).toBe(false);
    clean.safetyAlert = undefined;
    clean.profile.healthDataConsent = false;
    expect(canConfirmStableBaseline(clean)).toBe(false);
  });
});
