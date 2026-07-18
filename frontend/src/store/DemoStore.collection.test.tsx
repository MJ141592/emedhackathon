import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { INITIAL_STATE } from "../data";
import type { DemoState } from "../types";
import { DemoStoreProvider, useDemoStore } from "./DemoStore";
import { addCalendarDays, dateInTimeZone } from "./patientTime";

function CollectionHarness() {
  const { state, updatePrescription } = useDemoStore();
  return <>
    <button onClick={() => updatePrescription({ status: "collected" })}>Collect</button>
    <output data-testid="state">{JSON.stringify(state)}</output>
  </>;
}

function PhaseChatHarness() {
  const { state, setDemoPhase } = useDemoStore();
  return <>
    <button onClick={() => setDemoPhase("flare")}>Open flare scenario</button>
    <output data-testid="phase-chat-state">{JSON.stringify(state)}</output>
  </>;
}

test("collection reanchors the unchanged taper and clears unissued adherence for re-verification", () => {
  const ready: DemoState = structuredClone(INITIAL_STATE);
  ready.prescription.status = "ready";
  ready.taper.days[0].taken = true;
  ready.taper.missedDays = [2];
  ready.taper.snoozedUntil = "2026-07-18T12:00:00.000Z";
  ready.taper.sideEffects = ["Poor sleep"];
  ready.taper.checkInComplete = true;

  render(<DemoStoreProvider initialState={ready}><CollectionHarness /></DemoStoreProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Collect" }));
  const collected = JSON.parse(screen.getByTestId("state").textContent ?? "{}") as DemoState;
  const today = dateInTimeZone(new Date(), ready.profile.timeZone);

  expect(collected.prescription.status).toBe("collected");
  expect(collected.prescription.treatmentStartedAt?.slice(0, 10)).toBe(today);
  expect(collected.taper).toMatchObject({
    verified: false,
    currentDay: 1,
    missedDays: [],
    sideEffects: [],
    checkInComplete: false,
  });
  expect(collected.taper.snoozedUntil).toBeUndefined();
  expect(collected.taper.days[0].date).toBe(today);
  expect(collected.taper.days.at(-1)?.date).toBe(addCalendarDays(today, 41));
  expect(collected.taper.days.every((day) => !day.taken)).toBe(true);
  expect(collected.taper.days.map(({ day, doseMg }) => ({ day, doseMg }))).toEqual(
    ready.taper.days.map(({ day, doseMg }) => ({ day, doseMg })),
  );
  expect(collected.audit[0].action).toMatch(/anchored to collection day/i);
});

test("switching demo scenarios starts a separate empty Penny conversation", () => {
  render(<DemoStoreProvider initialState={INITIAL_STATE}><PhaseChatHarness /></DemoStoreProvider>);

  fireEvent.click(screen.getByRole("button", { name: "Open flare scenario" }));

  const switched = JSON.parse(screen.getByTestId("phase-chat-state").textContent ?? "{}") as DemoState;
  expect(switched.phase).toBe("flare");
  expect(switched.messages).toEqual([]);
  expect(switched.profileProposals).toEqual([]);
});
