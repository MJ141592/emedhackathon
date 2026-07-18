import { describe, expect, test } from "vitest";
import { INITIAL_STATE } from "../data";
import { alignTaperToCalendar, applyScheduledBackgroundWork, preferredPromptHour, scheduledNotification } from "./backgroundAgent";

describe("bounded background agent", () => {
  test("learns a prompt hour from manual entries and emits discreet deduplicatable work", () => {
    const state = structuredClone(INITIAL_STATE);
    expect(preferredPromptHour(state)).toBeGreaterThanOrEqual(9);
    const notification = scheduledNotification(state, new Date("2026-07-17T20:00:00.000Z"));
    expect(notification?.key).toMatch(/^2026-07-17:/);
    expect(notification?.key).toBe("2026-07-17:daily-check-in:0");
    expect(notification?.key).not.toMatch(/dose|medicine|symptom|taper/i);
    expect(notification?.title).toBe("You have a Gutsy check-in");
    expect(notification?.body).not.toMatch(/steroid|bowel|symptom/i);
  });

  test("prepares but never sends the next evening flare update", () => {
    const state = structuredClone(INITIAL_STATE);
    state.phase = "flare";
    state.phaseConfirmed = true;
    state.pendingPhase = undefined;
    state.teamMessage.status = "replied";
    state.teamMessage.reply = "Please keep us updated.";
    const next = applyScheduledBackgroundWork(state, new Date("2026-07-17T19:00:00.000Z"));
    expect(next.teamMessage).toMatchObject({ id: "EVENING-2026-07-17", status: "draft" });
    expect(next.teamMessageHistory[0]).toMatchObject({ id: "MSG-104", status: "replied", reply: "Please keep us updated." });
    expect(next.teamMessage.body).toContain("editable Gutsy summary");
    expect(next.audit[0].action).toContain("nothing was sent");
  });

  test("moves the verified taper focus to the clinician-authored calendar day", () => {
    const state = structuredClone(INITIAL_STATE);
    state.taper.currentDay = 1;
    const next = alignTaperToCalendar(state, new Date("2026-07-17T12:00:00.000Z"));
    expect(next.taper.currentDay).toBe(12);
    expect(next.taper.days).toEqual(state.taper.days);
  });

  test("uses the patient zone for the taper day and evening boundary", () => {
    const state = structuredClone(INITIAL_STATE);
    state.profile.timeZone = "Europe/London";
    state.taper.currentDay = 1;
    const london = alignTaperToCalendar(state, new Date("2026-07-17T23:30:00.000Z"));
    expect(london.taper.currentDay).toBe(13);

    state.profile.timeZone = "America/Los_Angeles";
    const losAngeles = alignTaperToCalendar(state, new Date("2026-07-17T23:30:00.000Z"));
    expect(losAngeles.taper.currentDay).toBe(12);
  });

  test("uses opaque progressive stages and permits one bounded post-snooze retry", () => {
    const state = structuredClone(INITIAL_STATE);
    state.prescription.status = "collected";
    state.taper.verified = true;
    state.taper.days.forEach((day) => { day.taken = day.day < 12; });

    const morning = scheduledNotification(state, new Date("2026-07-17T09:00:00.000Z"));
    const afternoon = scheduledNotification(state, new Date("2026-07-17T12:00:00.000Z"));
    const evening = scheduledNotification(state, new Date("2026-07-17T18:00:00.000Z"));
    expect([morning?.key, afternoon?.key, evening?.key]).toEqual([
      "2026-07-17:daily-check-in:1",
      "2026-07-17:daily-check-in:2",
      "2026-07-17:daily-check-in:3",
    ]);
    expect([morning?.key, afternoon?.key, evening?.key].join(" ")).not.toMatch(/dose|medicine|taper|steroid/i);

    state.taper.snoozedUntil = "2026-07-17T09:30:00.000Z";
    const duringSnooze = scheduledNotification(state, new Date("2026-07-17T09:15:00.000Z"));
    expect(duringSnooze?.key).toBe("2026-07-17:daily-check-in:0");
    const postSnooze = scheduledNotification(state, new Date("2026-07-17T10:00:00.000Z"));
    expect(postSnooze?.key).toMatch(/^2026-07-17:daily-check-in:1r[0-9a-z]+$/);
    expect(postSnooze?.key).not.toBe(morning?.key);
  });

  test("keeps unrelated governed reminders available while a dose reminder is snoozed", () => {
    const state = structuredClone(INITIAL_STATE);
    state.phase = "stable";
    state.prescription.status = "collected";
    state.taper.verified = true;
    state.taper.days.forEach((day) => { day.taken = day.day < 12; });
    state.taper.snoozedUntil = "2026-07-17T22:00:00.000Z";
    state.testOrder.status = "delivered";
    state.testOrder.statusUpdatedAt = "2026-07-17T17:00:00.000Z";
    state.privacy.discreetNotifications = false;

    const notification = scheduledNotification(state, new Date("2026-07-17T20:00:00.000Z"));
    expect(notification?.title).toBe("Your home test kit has arrived");
    expect(notification?.body).toMatch(/will not infer a sample/i);
    expect(notification?.key).toBe("2026-07-17:daily-check-in:0");
  });

  test("preserves an outstanding read thread until the clinical team replies", () => {
    const state = structuredClone(INITIAL_STATE);
    state.phase = "flare";
    state.phaseConfirmed = true;
    state.pendingPhase = undefined;
    state.teamMessage.status = "read";
    const outstanding = applyScheduledBackgroundWork(state, new Date("2026-07-17T19:00:00.000Z"));
    expect(outstanding.teamMessage).toEqual(state.teamMessage);
    expect(outstanding.teamMessageHistory).toEqual(state.teamMessageHistory);

    state.experiment.reviewRequestMessageId = state.teamMessage.id;
    state.experiment.reviewApprovedAt = undefined;
    const protectedThread = applyScheduledBackgroundWork(state, new Date("2026-07-17T19:00:00.000Z"));
    expect(protectedThread.teamMessage).toEqual(state.teamMessage);
    expect(protectedThread.teamMessageHistory).toEqual(state.teamMessageHistory);
  });

  test("requires a patient-confirmed flare with no pending phase transition", () => {
    const state = structuredClone(INITIAL_STATE);
    state.phase = "flare";
    state.phaseConfirmed = false;
    state.pendingPhase = undefined;
    state.teamMessage.status = "replied";

    const unconfirmed = applyScheduledBackgroundWork(state, new Date("2026-07-17T19:00:00.000Z"));
    expect(unconfirmed.teamMessage).toEqual(state.teamMessage);
    expect(unconfirmed.teamMessageHistory).toEqual(state.teamMessageHistory);

    state.phaseConfirmed = true;
    state.pendingPhase = "stable";
    const pending = applyScheduledBackgroundWork(state, new Date("2026-07-17T19:00:00.000Z"));
    expect(pending.teamMessage).toEqual(state.teamMessage);
    expect(pending.teamMessageHistory).toEqual(state.teamMessageHistory);
  });
});
