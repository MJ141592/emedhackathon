import { describe, expect, test } from "vitest";
import { INITIAL_STATE } from "../data";
import { deriveReminders } from "./reminderService";

describe("adaptive low-burden reminders", () => {
  test("uses the notification budget and never invents adherence", () => {
    const state = structuredClone(INITIAL_STATE);
    state.privacy.notificationBudget = "low";
    const reminders = deriveReminders(state, new Date("2026-07-17T09:00:00.000Z"));
    expect(reminders.map((item) => item.id)).toEqual(["medicine"]);
    expect(reminders[0].detail).toMatch(/does not infer adherence/i);
  });

  test("honours a real snooze expiry and expands only at supportive cadence", () => {
    const state = structuredClone(INITIAL_STATE);
    state.phase = "stable";
    state.phaseConfirmed = true;
    state.pendingPhase = undefined;
    state.prescription.status = "collected";
    state.prescription.treatmentStartedAt = "2026-07-16T08:00:00.000Z";
    state.taper.verified = true;
    state.taper.days.forEach((day) => { day.taken = day.day < state.taper.currentDay; });
    state.privacy.notificationBudget = "supportive";
    state.taper.snoozedUntil = "2026-07-17T09:30:00.000Z";
    const before = deriveReminders(state, new Date("2026-07-17T09:00:00.000Z"));
    expect(before.some((item) => item.id === "taper")).toBe(false);
    expect(before.some((item) => item.id === "meal")).toBe(true);
    const after = deriveReminders(state, new Date("2026-07-17T10:00:00.000Z"));
    expect(after.some((item) => item.id === "taper")).toBe(true);
  });

  test("strengthens an unconfirmed dose prompt without recommending a dose change", () => {
    const state = structuredClone(INITIAL_STATE);
    state.prescription.status = "collected";
    state.prescription.treatmentStartedAt = "2026-07-16T08:00:00.000Z";
    state.taper.verified = true;
    state.taper.days.forEach((day) => { day.taken = day.day < state.taper.currentDay; });
    const evening = deriveReminders(state, new Date("2026-07-17T20:00:00.000Z"));
    const taper = evening.find((item) => item.id === "taper");
    expect(taper?.title).toMatch(/still unconfirmed/i);
    expect(taper?.detail).toMatch(/do not double or stop suddenly/i);

    state.taper.days[0].taken = false;
    const missed = deriveReminders(state, new Date("2026-07-17T09:00:00.000Z"));
    expect(missed.find((item) => item.id === "taper")?.detail).toMatch(/earlier prescribed dose confirmation is missing/i);

    state.taper.missedDays = [1];
    expect(deriveReminders(state, new Date("2026-07-17T09:00:00.000Z")).find((item) => item.id === "taper")?.detail).not.toMatch(/earlier prescribed dose/i);
  });

  test("does not schedule taper adherence from a presentation-only Recovery view", () => {
    const state = structuredClone(INITIAL_STATE);
    state.phase = "recovery";
    state.phaseConfirmed = false;
    state.prescription.status = "prepared";

    expect(deriveReminders(state, new Date("2026-07-17T20:00:00.000Z")).map((item) => item.id)).not.toContain("taper");
  });

  test("suppresses low-value prompts during a flare or high fatigue", () => {
    const state = structuredClone(INITIAL_STATE);
    state.phase = "flare";
    state.phaseConfirmed = true;
    state.pendingPhase = undefined;
    state.privacy.notificationBudget = "supportive";
    const reminders = deriveReminders(state, new Date("2026-07-17T20:00:00.000Z"));
    expect(reminders.map((item) => item.id)).not.toContain("meal");
    expect(reminders.map((item) => item.id)).not.toContain("wearable");
  });

  test("only reminds for an explicitly daily regimen and requires a matching taken record", () => {
    const state = structuredClone(INITIAL_STATE);
    state.profile.currentMedicines = "Infliximab infusion every 8 weeks";
    expect(deriveReminders(state, new Date("2026-07-17T20:00:00.000Z")).map((item) => item.id)).not.toContain("medicine");

    state.profile.currentMedicines = "Azathioprine 100 mg daily";
    state.entries.unshift({ id: 400, date: "2026-07-17", time: "09:00", kind: "MEDICATION", body: "Medication taken — details not specified", source: "manual", structured: { taken: true } });
    expect(deriveReminders(state, new Date("2026-07-17T20:00:00.000Z")).map((item) => item.id)).toContain("medicine");
    state.entries[0].body = "Azathioprine 100 mg taken";
    expect(deriveReminders(state, new Date("2026-07-17T20:00:00.000Z")).map((item) => item.id)).not.toContain("medicine");
  });

  test("selects the exact prescribed calendar day in the patient's zone", () => {
    const state = structuredClone(INITIAL_STATE);
    state.prescription.status = "collected";
    state.taper.verified = true;
    state.taper.days.forEach((day) => { day.taken = day.day < 12; });
    const instant = new Date("2026-07-17T23:30:00.000Z");

    state.profile.timeZone = "Europe/London";
    state.taper.days[11].taken = true;
    expect(deriveReminders(state, instant).find((item) => item.id === "taper")?.detail).toContain("Taper day 13");

    state.profile.timeZone = "America/Los_Angeles";
    state.taper.days[11].taken = false;
    expect(deriveReminders(state, instant).find((item) => item.id === "taper")?.detail).toContain("Taper day 12");
  });

  test("closes the test-delivery loop without inferring collection", () => {
    const state = structuredClone(INITIAL_STATE);
    state.testOrder.status = "delivered";
    state.privacy.notificationBudget = "balanced";

    const delivered = deriveReminders(state, new Date("2026-07-17T09:00:00.000Z"));
    const reminder = delivered.find((item) => item.id === "test-delivery");
    expect(reminder?.title).toMatch(/kit has arrived/i);
    expect(reminder?.detail).toMatch(/record collection only after it happens/i);

    state.testOrder.status = "sampled";
    expect(deriveReminders(state, new Date("2026-07-17T09:00:00.000Z")).map((item) => item.id)).not.toContain("test-delivery");

    state.testOrder.status = "delivered";
    state.testOrder.clinicalOwner = "Not configured — import a clinical plan";
    expect(deriveReminders(state, new Date("2026-07-17T09:00:00.000Z")).map((item) => item.id)).not.toContain("test-delivery");
  });

  test("uses the immutable send instant for an overdue care-team response", () => {
    const state = structuredClone(INITIAL_STATE);
    state.teamMessage.status = "read";
    state.teamMessage.expectedResponse = "Within one working day";
    state.teamMessage.sentAt = "2026-07-16T08:00:00.000Z";
    state.teamMessage.statusUpdatedAt = "2026-07-17T10:00:00.000Z";
    const now = new Date("2026-07-17T12:30:00.000Z");

    const reminder = deriveReminders(state, now).find((item) => item.id === "team-response");
    expect(reminder?.title).toMatch(/response window has passed/i);
    expect(reminder?.detail).toMatch(/not a guarantee|do not rely/i);

    state.teamMessage.status = "replied";
    expect(deriveReminders(state, now).map((item) => item.id)).not.toContain("team-response");
  });

  test("treats a working-day response window as patient-local business days", () => {
    const state = structuredClone(INITIAL_STATE);
    state.profile.timeZone = "Europe/London";
    state.teamMessage.status = "sent";
    state.teamMessage.expectedResponse = "Within one working day";
    state.teamMessage.sentAt = "2026-07-17T15:00:00.000Z"; // Friday 16:00 BST.

    expect(deriveReminders(state, new Date("2026-07-19T18:00:00.000Z")).map((item) => item.id)).not.toContain("team-response");
    expect(deriveReminders(state, new Date("2026-07-20T14:59:00.000Z")).map((item) => item.id)).not.toContain("team-response");
    expect(deriveReminders(state, new Date("2026-07-20T15:00:00.000Z")).map((item) => item.id)).toContain("team-response");
  });

  test("adapts check-in wording by lifecycle phase and honours the low budget", () => {
    const watch = structuredClone(INITIAL_STATE);
    watch.phaseConfirmed = true;
    watch.pendingPhase = undefined;
    watch.privacy.notificationBudget = "balanced";
    expect(deriveReminders(watch, new Date("2026-07-17T09:00:00.000Z")).find((item) => item.id === "phase-watch")?.detail).toMatch(/urgency.*blood.*night waking/i);

    const flare = structuredClone(watch);
    flare.phase = "flare";
    flare.privacy.notificationBudget = "low";
    expect(deriveReminders(flare, new Date("2026-07-17T09:00:00.000Z")).map((item) => item.id)).toContain("phase-flare");

    const recovery = structuredClone(watch);
    recovery.phase = "recovery";
    recovery.phaseConfirmed = true;
    recovery.prescription.status = "collected";
    recovery.prescription.treatmentStartedAt = "2026-07-16T08:00:00.000Z";
    expect(deriveReminders(recovery, new Date("2026-07-17T09:00:00.000Z")).find((item) => item.id === "phase-recovery")?.detail).toMatch(/never changes.*schedule/i);

    watch.testOrder.status = "delivered";
    watch.privacy.notificationBudget = "low";
    const low = deriveReminders(watch, new Date("2026-07-17T09:00:00.000Z"));
    expect(low).toHaveLength(1);
    expect(low[0].id).toBe("medicine");
  });

  test("never presents phase-specific claims before the current phase is confirmed", () => {
    const state = structuredClone(INITIAL_STATE);
    state.profile.currentMedicines = "";
    state.privacy.notificationBudget = "supportive";

    for (const phase of ["watch", "flare", "recovery", "stable"] as const) {
      state.phase = phase;
      state.phaseConfirmed = false;
      state.pendingPhase = undefined;
      const unconfirmed = deriveReminders(state, new Date("2026-07-17T20:00:00.000Z"));
      expect(unconfirmed.map((item) => item.id)).not.toContain(`phase-${phase}`);
      if (phase === "stable") {
        expect(unconfirmed.map((item) => item.id)).not.toContain("wellbeing");
        expect(unconfirmed.map((item) => item.id)).not.toContain("meal");
        expect(unconfirmed.map((item) => item.id)).not.toContain("wearable");
      }

      state.phaseConfirmed = true;
      state.pendingPhase = "stable";
      const pending = deriveReminders(state, new Date("2026-07-17T20:00:00.000Z"));
      expect(pending.map((item) => item.id)).not.toContain(`phase-${phase}`);
      if (phase === "stable") {
        expect(pending.map((item) => item.id)).not.toContain("wellbeing");
        expect(pending.map((item) => item.id)).not.toContain("meal");
        expect(pending.map((item) => item.id)).not.toContain("wearable");
      }
    }

    state.phase = "flare";
    state.phaseConfirmed = true;
    state.pendingPhase = undefined;
    expect(deriveReminders(state, new Date("2026-07-17T20:00:00.000Z")).map((item) => item.id)).toContain("phase-flare");
  });

  test("returns no reminders whenever adult eligibility or health-data consent is absent", () => {
    const state = structuredClone(INITIAL_STATE);
    state.profile.adultEligibilityConfirmed = false;
    expect(deriveReminders(state, new Date("2026-07-17T20:00:00.000Z"))).toEqual([]);

    state.profile.adultEligibilityConfirmed = true;
    state.profile.healthDataConsent = false;
    expect(deriveReminders(state, new Date("2026-07-17T20:00:00.000Z"))).toEqual([]);
  });
});
