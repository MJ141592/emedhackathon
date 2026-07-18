import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { INITIAL_STATE } from "../../data";
import { DemoStoreProvider, useDemoStore } from "../../store/DemoStore";
import { configureDemoSyncAdapter } from "../../store/demoRepository";
import type { DemoState } from "../../types";
import { ProfilePanel } from "./ProfilePanel";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function StateObserver() {
  const { state } = useDemoStore();
  return <output data-testid="stored-health-consent">{String(state.profile.healthDataConsent)}</output>;
}

afterEach(() => configureDemoSyncAdapter(null));

test("waits for consent withdrawal, then saves changed contacts from the accepted state", async () => {
  const remote = structuredClone(INITIAL_STATE);
  const accepted = structuredClone(remote);
  accepted.profile.healthDataConsent = false;
  accepted.profile.onboardingComplete = false;
  const pendingWithdrawal = deferred<DemoState>();
  const withdrawHealthConsent = vi.fn(() => pendingWithdrawal.promise);
  const sync = vi.fn(async (candidate: DemoState) => candidate);
  const notify = vi.fn();
  configureDemoSyncAdapter({
    hydrate: () => new Promise<DemoState | null>(() => undefined),
    sync,
    withdrawHealthConsent,
  });
  render(
    <DemoStoreProvider initialState={remote}>
      <StateObserver />
      <ProfilePanel notify={notify} />
    </DemoStoreProvider>,
  );

  fireEvent.click(screen.getByRole("checkbox", { name: /I consent to holding sensitive health information/i }));
  fireEvent.change(screen.getAllByRole("textbox", { name: "Name" })[0], { target: { value: "Changed IBD Team" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

  expect(withdrawHealthConsent).toHaveBeenCalledTimes(1);
  expect(screen.getAllByRole("button", { name: "Saving…" })).not.toHaveLength(0);
  expect(screen.getAllByRole("button", { name: "Saving…" }).every((button) => button.hasAttribute("disabled"))).toBe(true);
  expect(screen.getByTestId("stored-health-consent")).toHaveTextContent("true");
  expect(sync).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalledWith(expect.stringMatching(/consent withdrawn/i));

  await act(async () => pendingWithdrawal.resolve(accepted));

  await waitFor(() => expect(screen.getByTestId("stored-health-consent")).toHaveTextContent("false"));
  await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
  expect(sync.mock.calls[0][0].profile).toMatchObject({
    healthDataConsent: false,
    onboardingComplete: false,
  });
  expect(sync.mock.calls[0][0].contacts[0]).toMatchObject({ name: "Changed IBD Team" });
  expect(notify).toHaveBeenCalledWith(expect.stringMatching(/consent withdrawn/i));
});

test("keeps the prior consent state and avoids a success claim when withdrawal fails", async () => {
  const remote = structuredClone(INITIAL_STATE);
  const pendingWithdrawal = deferred<DemoState>();
  const sync = vi.fn(async (candidate: DemoState) => candidate);
  const notify = vi.fn();
  configureDemoSyncAdapter({
    hydrate: () => new Promise<DemoState | null>(() => undefined),
    sync,
    withdrawHealthConsent: () => pendingWithdrawal.promise,
  });
  render(
    <DemoStoreProvider initialState={remote}>
      <StateObserver />
      <ProfilePanel notify={notify} />
    </DemoStoreProvider>,
  );

  fireEvent.click(screen.getByRole("checkbox", { name: /I consent to holding sensitive health information/i }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await act(async () => pendingWithdrawal.reject(new Error("API unavailable")));

  await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled());
  expect(screen.getByTestId("stored-health-consent")).toHaveTextContent("true");
  expect(sync).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith(expect.stringMatching(/not saved/i));
  expect(notify).not.toHaveBeenCalledWith(expect.stringMatching(/^Health-data consent withdrawn/i));
});
