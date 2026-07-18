import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { INITIAL_STATE } from "../data";
import type { DemoState } from "../types";
import { DemoStoreProvider, useDemoStore } from "./DemoStore";

let observedState: DemoState;

function IntegrityHarness() {
  const store = useDemoStore();
  observedState = store.state;
  return <>
    <button onClick={() => store.updateEntry(1, { body: "Bristol type 4, no blood and no urgency" })}>Correct evidence</button>
    <button onClick={() => store.updateEntry(1, { kind: "WELLBEING", body: "Feeling same as usual", date: "2026-07-18", time: "09:15" })}>Correct evidence kind</button>
    <button onClick={() => store.updateTeamMessage({ status: "sent" })}>Send draft</button>
    <button onClick={store.refreshTeamMessage}>Refresh draft</button>
    <button onClick={store.markDoseTaken}>Mark dose taken</button>
    <button onClick={() => store.correctDoseRecord(store.state.taper.currentDay, "taken")}>Correct taken fact</button>
    <button onClick={() => store.updateEntry(28, { body: "Diet experiment check-in — day 9 of 14: Corrected urgency was 2/10" })}>Correct experiment observation</button>
    <button onClick={() => store.deleteEntry(28)}>Delete experiment observation</button>
    <button onClick={() => store.deleteEntry(1)}>Delete linked evidence</button>
    <button onClick={() => store.updateProfile({ healthDataConsent: false, onboardingComplete: false })}>Withdraw tracking consent</button>
    <button onClick={() => store.updateProfile({ healthDataConsent: true, onboardingComplete: true })}>Restore tracking consent</button>
    <button onClick={() => store.updateTrustedSupporter({ enabled: true, canViewSummary: true })}>Expand supporter access</button>
    <button onClick={() => store.updateTest({ status: "ordered" })}>Reuse old order consent</button>
  </>;
}

function renderState(state: DemoState) {
  render(<DemoStoreProvider initialState={state}><IntegrityHarness /></DemoStoreProvider>);
}

beforeEach(() => {
  observedState = structuredClone(INITIAL_STATE);
});

test("evidence correction preserves and blocks a stale clinician draft until regeneration", async () => {
  const state = structuredClone(INITIAL_STATE);
  state.teamMessage.body = "My own reviewed wording for the IBD team.";
  state.teamMessageStale = false;
  renderState(state);

  fireEvent.click(screen.getByRole("button", { name: "Correct evidence" }));
  await waitFor(() => expect(observedState.teamMessageStale).toBe(true));
  expect(observedState.teamMessage.body).toBe("My own reviewed wording for the IBD team.");

  fireEvent.click(screen.getByRole("button", { name: "Send draft" }));
  expect(observedState.teamMessage.status).toBe("draft");

  fireEvent.click(screen.getByRole("button", { name: "Refresh draft" }));
  await waitFor(() => expect(observedState.teamMessageStale).toBe(false));
  expect(observedState.teamMessage.body).toContain("Bristol type 4");
  fireEvent.click(screen.getByRole("button", { name: "Send draft" }));
  await waitFor(() => expect(observedState.teamMessage.status).toBe("sent"));
});

test("a kind correction updates every linked evidence-source label", async () => {
  renderState(structuredClone(INITIAL_STATE));
  fireEvent.click(screen.getByRole("button", { name: "Correct evidence kind" }));
  await waitFor(() => expect(observedState.entries.find((entry) => entry.id === 1)?.kind).toBe("WELLBEING"));
  const linked = observedState.messages.flatMap((message) => message.sources ?? []).filter((source) => source.entryId === 1);
  expect(linked.length).toBeGreaterThan(0);
  expect(linked.every((source) => source.label === "WELLBEING")).toBe(true);
  expect(linked.every((source) => source.date === "2026-07-18, 09:15")).toBe(true);
});

test("taken-dose correction excludes its source and appends an audited timeline retraction", async () => {
  const state = structuredClone(INITIAL_STATE);
  state.prescription.status = "collected";
  state.prescription.treatmentStartedAt = "2026-07-17T08:00:00.000Z";
  state.taper.verified = true;
  state.taper.days = state.taper.days.map((day) => ({ ...day, taken: false }));
  state.taper.missedDays = [];
  renderState(state);

  fireEvent.click(screen.getByRole("button", { name: "Mark dose taken" }));
  await waitFor(() => {
    const current = observedState.taper.days.find((day) => day.day === observedState.taper.currentDay);
    expect(current?.taken).toBe(true);
  });
  const dayNumber = observedState.taper.currentDay;
  const schedule = observedState.taper.days.map(({ day, doseMg, date }) => ({ day, doseMg, date }));
  const original = observedState.entries.find((entry) => entry.structured?.taperDay === dayNumber && entry.structured.taken === true);
  expect(original).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "Correct taken fact" }));
  await waitFor(() => {
    expect(observedState.taper.days.find((day) => day.day === dayNumber)?.taken).toBe(false);
  });
  expect(observedState.taper.days.map(({ day, doseMg, date }) => ({ day, doseMg, date }))).toEqual(schedule);
  expect(observedState.entries.find((entry) => entry.id === original?.id)?.excluded).toBe(true);
  const correction = observedState.entries.find((entry) => entry.structured?.adherenceCorrection === true);
  expect(correction).toMatchObject({
    kind: "MEDICATION",
    source: "manual",
    excluded: false,
    structured: { correctedFact: "taken", taperDay: dayNumber },
  });
  expect(correction?.body).toContain("marked taken by mistake");
  expect(observedState.clinicianSummary).toContain("0 doses marked taken");
  expect(observedState.teamMessageStale).toBe(true);
  expect(observedState.audit[0].action).toContain("marked by mistake");
});

test("experiment corrections and deletions reconcile the source-of-truth timeline", async () => {
  renderState(structuredClone(INITIAL_STATE));

  fireEvent.click(screen.getByRole("button", { name: "Correct experiment observation" }));
  await waitFor(() => expect(observedState.experiment.observations.at(-1)).toBe("Day 9: Corrected urgency was 2/10"));
  expect(observedState.clinicianSummary).toContain("Corrected urgency was 2/10");

  fireEvent.click(screen.getByRole("button", { name: "Delete experiment observation" }));
  await waitFor(() => expect(observedState.entries.some((entry) => entry.id === 28)).toBe(false));
  expect(observedState.experiment.day).toBe(8);
  expect(observedState.experiment.observations).not.toContain("Day 9: Corrected urgency was 2/10");
  expect(observedState.clinicianSummary).not.toContain("Corrected urgency was 2/10");
});

test("deleting a cited source leaves an explicit retraction on the historical reply", async () => {
  renderState(structuredClone(INITIAL_STATE));
  fireEvent.click(screen.getByRole("button", { name: "Delete linked evidence" }));
  await waitFor(() => expect(observedState.entries.some((entry) => entry.id === 1)).toBe(false));
  const tombstones = observedState.messages
    .flatMap((message) => message.sources ?? [])
    .filter((source) => source.entryId === 1);
  expect(tombstones.length).toBeGreaterThan(0);
  expect(tombstones.every((source) => source.excluded)).toBe(true);
  expect(tombstones.every((source) => source.detail.includes("deleted by the patient"))).toBe(true);
});

test("withdrawing consent revokes optional access and prevents stale order consent reuse", async () => {
  const state = structuredClone(INITIAL_STATE);
  state.trustedSupporter = {
    ...state.trustedSupporter,
    name: "Alex",
    relationship: "Partner",
    enabled: true,
    canViewSummary: true,
  };
  state.testOrder.addressConfirmed = true;
  state.testOrder.consent = true;
  renderState(state);

  fireEvent.click(screen.getByRole("button", { name: "Withdraw tracking consent" }));
  await waitFor(() => expect(observedState.profile.healthDataConsent).toBe(false));
  expect(observedState.trustedSupporter.enabled).toBe(false);
  expect(observedState.trustedSupporter.canViewSummary).toBe(false);
  expect(observedState.testOrder.addressConfirmed).toBe(false);
  expect(observedState.testOrder.consent).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Expand supporter access" }));
  expect(observedState.trustedSupporter.enabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Restore tracking consent" }));
  await waitFor(() => expect(observedState.profile.healthDataConsent).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Reuse old order consent" }));
  expect(observedState.testOrder.status).toBe("prepared");
});
