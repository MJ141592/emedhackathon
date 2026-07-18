import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { INITIAL_STATE } from "../data";
import type { DemoState } from "../types";
import { DemoStoreProvider, useDemoStore } from "./DemoStore";
import { configureDemoSyncAdapter } from "./demoRepository";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

let observedState: DemoState;

function HydrationHarness() {
  const store = useDemoStore();
  observedState = store.state;
  return <>
    <button onClick={() => store.updateProfile({ dietaryNeeds: "Locally edited during load" })}>Edit locally</button>
    <button onClick={() => { void store.clearAllData(); }}>Delete all</button>
    <output>{store.state.profile.name}</output>
  </>;
}

function SyncFailureHarness() {
  const store = useDemoStore();
  observedState = store.state;
  return <>
    <button onClick={() => store.updateTeamMessage({ status: "sent" })}>Send care message</button>
    <button onClick={() => store.updateTeamMessage({ status: "read" })}>Advance care message</button>
    <button onClick={() => { void store.sendChat("Can Penny save this?"); }}>Send Penny message</button>
    <button onClick={() => { void store.retrySync(); }}>Retry failed change</button>
    <output data-testid="team-status">{store.state.teamMessage.status}</output>
    <output data-testid="sync-status">{store.syncStatus}</output>
    <output data-testid="mutation-lock">{String(store.mutationsBlocked)}</output>
    <output data-testid="retry-available">{String(store.retryAvailable)}</output>
  </>;
}

function ConcurrencyHarness() {
  const store = useDemoStore();
  observedState = store.state;
  return <>
    <button onClick={() => store.updateProfile({ dietaryNeeds: "First local edit" })}>Edit profile</button>
    <button onClick={() => store.updateProfile({ dietaryNeeds: "Forbidden overlapping edit" })}>Edit while saving</button>
    <button onClick={() => { void store.sendChat("What signs happen in a flare?"); }}>Ask Penny</button>
    <button onClick={() => { void store.clearAllData(); }}>Force delete all</button>
    <output data-testid="dietary-needs">{store.state.profile.dietaryNeeds}</output>
    <output data-testid="patient-name">{store.state.profile.name}</output>
    <output data-testid="race-status">{store.syncStatus}</output>
    <output data-testid="race-lock">{String(store.mutationsBlocked)}</output>
    <output data-testid="race-retry">{String(store.retryAvailable)}</output>
  </>;
}

function ConsentAndCompositionHarness() {
  const store = useDemoStore();
  observedState = store.state;
  return <>
    <button onClick={() => { void store.updateProfile({ healthDataConsent: false, onboardingComplete: false }); }}>Withdraw consent narrowly</button>
    <button onClick={() => {
      void store.updateProfile({
        adultEligibilityConfirmed: true,
        healthDataConsent: true,
        onboardingComplete: true,
      });
      store.updateContacts([{
        id: "new-team",
        initials: "NT",
        name: "New IBD Team",
        role: "IBD advice line",
        organisation: "Patient hospital",
        phone: "020 7000 0000",
      }]);
    }}>Complete onboarding with contact</button>
    <output data-testid="consent-status">{store.syncStatus}</output>
    <output data-testid="consent-value">{String(store.state.profile.healthDataConsent)}</output>
    <output data-testid="contact-name">{store.state.contacts[0]?.name}</output>
  </>;
}

afterEach(() => {
  configureDemoSyncAdapter(null);
  window.localStorage.clear();
});

test("a slow startup hydration preserves and syncs an intervening local mutation", async () => {
  const pendingHydration = deferred<DemoState | null>();
  const sync = vi.fn(async (_state: DemoState) => undefined);
  const remote = structuredClone(INITIAL_STATE);
  remote.profile.dietaryNeeds = "Older remote value";
  configureDemoSyncAdapter({
    hydrate: () => pendingHydration.promise,
    sync,
  });

  render(<DemoStoreProvider initialState={INITIAL_STATE}><HydrationHarness /></DemoStoreProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Edit locally" }));
  expect(observedState.profile.dietaryNeeds).toBe("Locally edited during load");

  await act(async () => pendingHydration.resolve(remote));

  await waitFor(() => expect(sync).toHaveBeenCalled());
  expect(observedState.profile.dietaryNeeds).toBe("Locally edited during load");
  expect(sync.mock.calls.at(-1)?.[0].profile.dietaryNeeds).toBe("Locally edited during load");
});

test("delete-all invalidates a slow startup read and reasserts the empty state on success", async () => {
  const pendingHydration = deferred<DemoState | null>();
  const pendingDeletion = deferred<void>();
  const sync = vi.fn(async (_state: DemoState) => undefined);
  configureDemoSyncAdapter({
    hydrate: () => pendingHydration.promise,
    sync,
    deleteAll: () => pendingDeletion.promise,
  });

  render(<DemoStoreProvider initialState={INITIAL_STATE}><HydrationHarness /></DemoStoreProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Delete all" }));
  await waitFor(() => expect(observedState.profile.name).toBe(""));

  await act(async () => pendingHydration.resolve(structuredClone(INITIAL_STATE)));
  expect(observedState.profile.name).toBe("");

  await act(async () => pendingDeletion.resolve());
  await waitFor(() => expect(observedState.entries).toEqual([]));
  expect(observedState.profile.name).toBe("");
  expect(sync).not.toHaveBeenCalledWith(expect.objectContaining({
    profile: expect.objectContaining({ name: "Amara Okafor" }),
  }));
});

test("automatic calendar alignment waits for remote hydration instead of overwriting it", async () => {
  const pendingHydration = deferred<DemoState | null>();
  const sync = vi.fn(async (_state: DemoState) => undefined);
  const local = structuredClone(INITIAL_STATE);
  local.taper.currentDay = 1;
  const remote = structuredClone(INITIAL_STATE);
  remote.phase = "stable";
  configureDemoSyncAdapter({ hydrate: () => pendingHydration.promise, sync });

  render(<DemoStoreProvider initialState={local}><HydrationHarness /></DemoStoreProvider>);
  await act(async () => pendingHydration.resolve(remote));

  await waitFor(() => expect(observedState.phase).toBe("stable"));
  expect(sync).not.toHaveBeenCalled();
});

test("a failed consequential sync keeps one queued intent and blocks further advancement", async () => {
  const remote = structuredClone(INITIAL_STATE);
  let unavailable = true;
  const sendChat = vi.fn(async () => remote);
  const sync = vi.fn(async (candidate: DemoState) => {
    if (unavailable) {
      unavailable = false;
      throw new Error("simulated API outage");
    }
    return candidate;
  });
  configureDemoSyncAdapter({ hydrate: async () => remote, sync, sendChat });

  render(<DemoStoreProvider initialState={INITIAL_STATE}><SyncFailureHarness /></DemoStoreProvider>);
  await waitFor(() => expect(screen.getByTestId("sync-status")).toHaveTextContent("local"));
  fireEvent.click(screen.getByRole("button", { name: "Send care message" }));

  await waitFor(() => expect(screen.getByTestId("sync-status")).toHaveTextContent("error"));
  expect(screen.getByTestId("team-status")).toHaveTextContent("sent");
  expect(screen.getByTestId("mutation-lock")).toHaveTextContent("true");
  fireEvent.click(screen.getByRole("button", { name: "Advance care message" }));
  expect(screen.getByTestId("team-status")).toHaveTextContent("sent");
  fireEvent.click(screen.getByRole("button", { name: "Send Penny message" }));
  expect(sendChat).not.toHaveBeenCalled();
  expect(screen.getByTestId("retry-available")).toHaveTextContent("true");

  fireEvent.click(screen.getByRole("button", { name: "Retry failed change" }));
  await waitFor(() => expect(screen.getByTestId("sync-status")).toHaveTextContent("saved"));
  expect(screen.getByTestId("team-status")).toHaveTextContent("sent");
  expect(screen.getByTestId("mutation-lock")).toHaveTextContent("false");
  expect(sync).toHaveBeenLastCalledWith(expect.objectContaining({
    teamMessage: expect.objectContaining({ status: "sent" }),
  }));
});

test("snapshot and explicit endpoint mutations cannot overlap in either direction", async () => {
  const remote = structuredClone(INITIAL_STATE);
  const pendingSync = deferred<DemoState | void>();
  const pendingChat = deferred<DemoState>();
  let snapshot: DemoState | undefined;
  const sync = vi.fn((candidate: DemoState) => {
    snapshot = candidate;
    return pendingSync.promise;
  });
  const sendChat = vi.fn(() => pendingChat.promise);
  configureDemoSyncAdapter({ hydrate: async () => remote, sync, sendChat });

  render(<DemoStoreProvider initialState={INITIAL_STATE}><ConcurrencyHarness /></DemoStoreProvider>);
  await waitFor(() => expect(screen.getByTestId("race-status")).toHaveTextContent("saved"));

  fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));
  await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
  expect(screen.getByTestId("race-lock")).toHaveTextContent("true");
  fireEvent.click(screen.getByRole("button", { name: "Ask Penny" }));
  expect(sendChat).not.toHaveBeenCalled();

  await act(async () => pendingSync.resolve(snapshot));
  await waitFor(() => expect(screen.getByTestId("race-lock")).toHaveTextContent("false"));
  fireEvent.click(screen.getByRole("button", { name: "Ask Penny" }));
  await waitFor(() => expect(sendChat).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Edit while saving" }));
  expect(screen.getByTestId("dietary-needs")).toHaveTextContent("First local edit");
  expect(sync).toHaveBeenCalledTimes(1);

  const chatState = structuredClone(snapshot ?? remote);
  await act(async () => pendingChat.resolve(chatState));
  await waitFor(() => expect(screen.getByTestId("race-lock")).toHaveTextContent("false"));
  expect(screen.getByTestId("dietary-needs")).toHaveTextContent("First local edit");
});

test("void-returning retry confirms the retained optimistic state and unlocks the UI", async () => {
  const remote = structuredClone(INITIAL_STATE);
  let attempt = 0;
  const sync = vi.fn(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("temporary outage");
    return undefined;
  });
  configureDemoSyncAdapter({ hydrate: async () => remote, sync });

  render(<DemoStoreProvider initialState={INITIAL_STATE}><SyncFailureHarness /></DemoStoreProvider>);
  await waitFor(() => expect(screen.getByTestId("sync-status")).toHaveTextContent("saved"));
  fireEvent.click(screen.getByRole("button", { name: "Send care message" }));
  await waitFor(() => expect(screen.getByTestId("sync-status")).toHaveTextContent("error"));
  expect(screen.getByTestId("team-status")).toHaveTextContent("sent");

  fireEvent.click(screen.getByRole("button", { name: "Retry failed change" }));
  await waitFor(() => expect(screen.getByTestId("sync-status")).toHaveTextContent("saved"));
  expect(screen.getByTestId("team-status")).toHaveTextContent("sent");
  expect(screen.getByTestId("mutation-lock")).toHaveTextContent("false");
  expect(screen.getByTestId("retry-available")).toHaveTextContent("false");
});

test("delete-all ignores a successful pre-deletion snapshot even when deletion fails", async () => {
  const remote = structuredClone(INITIAL_STATE);
  const pendingSync = deferred<DemoState | void>();
  const pendingDeletion = deferred<void>();
  let snapshot: DemoState | undefined;
  configureDemoSyncAdapter({
    hydrate: async () => remote,
    sync: (candidate) => { snapshot = candidate; return pendingSync.promise; },
    deleteAll: () => pendingDeletion.promise,
  });

  render(<DemoStoreProvider initialState={INITIAL_STATE}><ConcurrencyHarness /></DemoStoreProvider>);
  await waitFor(() => expect(screen.getByTestId("race-status")).toHaveTextContent("saved"));
  fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));
  await waitFor(() => expect(snapshot).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Force delete all" }));
  await waitFor(() => expect(screen.getByTestId("patient-name")).toHaveTextContent(""));

  await act(async () => pendingSync.resolve(snapshot));
  await act(async () => pendingDeletion.reject(new Error("delete unavailable")));
  await waitFor(() => expect(screen.getByTestId("race-status")).toHaveTextContent("error"));
  expect(observedState.profile.name).toBe("");
  expect(observedState.entries).toEqual([]);
  expect(screen.getByTestId("race-retry")).toHaveTextContent("false");
});

test("a stale failed snapshot cannot repopulate retry refs owned by delete-all", async () => {
  const remote = structuredClone(INITIAL_STATE);
  const pendingSync = deferred<DemoState | void>();
  const pendingDeletion = deferred<void>();
  configureDemoSyncAdapter({
    hydrate: async () => remote,
    sync: () => pendingSync.promise,
    deleteAll: () => pendingDeletion.promise,
  });

  render(<DemoStoreProvider initialState={INITIAL_STATE}><ConcurrencyHarness /></DemoStoreProvider>);
  await waitFor(() => expect(screen.getByTestId("race-status")).toHaveTextContent("saved"));
  fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));
  await waitFor(() => expect(screen.getByTestId("race-lock")).toHaveTextContent("true"));
  fireEvent.click(screen.getByRole("button", { name: "Force delete all" }));
  await act(async () => pendingSync.reject(new Error("stale snapshot failed")));
  expect(screen.getByTestId("race-retry")).toHaveTextContent("false");
  expect(observedState.profile.name).toBe("");

  await act(async () => pendingDeletion.resolve());
  await waitFor(() => expect(screen.getByTestId("race-status")).toHaveTextContent("saved"));
  expect(screen.getByTestId("race-retry")).toHaveTextContent("false");
});

test("delete-all supersedes a stale explicit endpoint completion", async () => {
  const remote = structuredClone(INITIAL_STATE);
  const pendingChat = deferred<DemoState>();
  configureDemoSyncAdapter({
    hydrate: async () => remote,
    sync: async () => undefined,
    sendChat: () => pendingChat.promise,
    deleteAll: async () => undefined,
  });

  render(<DemoStoreProvider initialState={INITIAL_STATE}><ConcurrencyHarness /></DemoStoreProvider>);
  await waitFor(() => expect(screen.getByTestId("race-status")).toHaveTextContent("saved"));
  fireEvent.click(screen.getByRole("button", { name: "Ask Penny" }));
  await waitFor(() => expect(screen.getByTestId("race-lock")).toHaveTextContent("true"));
  fireEvent.click(screen.getByRole("button", { name: "Force delete all" }));
  await waitFor(() => expect(observedState.profile.name).toBe(""));

  await act(async () => pendingChat.resolve(remote));
  expect(observedState.profile.name).toBe("");
  expect(observedState.entries).toEqual([]);
  expect(screen.getByTestId("race-retry")).toHaveTextContent("false");
});

test("active consent withdrawal accepts the authoritative narrow response without a follow-up snapshot", async () => {
  const remote = structuredClone(INITIAL_STATE);
  const accepted = structuredClone(remote);
  accepted.profile.healthDataConsent = false;
  accepted.profile.onboardingComplete = false;
  accepted.profile.dietaryNeeds = "Concurrent server value retained";
  const pendingWithdrawal = deferred<DemoState>();
  const sync = vi.fn(async (candidate: DemoState) => candidate);
  const withdrawHealthConsent = vi.fn(() => pendingWithdrawal.promise);
  configureDemoSyncAdapter({ hydrate: async () => remote, sync, withdrawHealthConsent });

  render(<DemoStoreProvider initialState={remote}><ConsentAndCompositionHarness /></DemoStoreProvider>);
  await waitFor(() => expect(screen.getByTestId("consent-status")).toHaveTextContent("saved"));
  sync.mockClear();

  fireEvent.click(screen.getByRole("button", { name: "Withdraw consent narrowly" }));
  expect(withdrawHealthConsent).toHaveBeenCalledWith({ healthDataConsent: false, onboardingComplete: false });
  expect(screen.getByTestId("consent-status")).toHaveTextContent("saving");
  expect(screen.getByTestId("consent-value")).toHaveTextContent("true");

  await act(async () => pendingWithdrawal.resolve(accepted));
  await waitFor(() => expect(screen.getByTestId("consent-value")).toHaveTextContent("false"));
  expect(observedState.profile.dietaryNeeds).toBe("Concurrent server value retained");
  expect(sync).not.toHaveBeenCalled();
});

test("onboarding profile and contacts compose into one same-handler snapshot", async () => {
  const remote = structuredClone(INITIAL_STATE);
  remote.profile.adultEligibilityConfirmed = false;
  remote.profile.healthDataConsent = false;
  remote.profile.onboardingComplete = false;
  const sync = vi.fn(async (candidate: DemoState) => candidate);
  const withdrawHealthConsent = vi.fn(async () => remote);
  configureDemoSyncAdapter({ hydrate: async () => remote, sync, withdrawHealthConsent });

  render(<DemoStoreProvider initialState={remote}><ConsentAndCompositionHarness /></DemoStoreProvider>);
  await waitFor(() => expect(screen.getByTestId("consent-status")).toHaveTextContent("saved"));
  sync.mockClear();
  const originalPrescription = structuredClone(remote.prescription);

  fireEvent.click(screen.getByRole("button", { name: "Complete onboarding with contact" }));

  await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
  const snapshot = sync.mock.calls[0][0];
  expect(snapshot.profile).toMatchObject({
    adultEligibilityConfirmed: true,
    healthDataConsent: true,
    onboardingComplete: true,
  });
  expect(snapshot.contacts[0]).toMatchObject({ id: "new-team", name: "New IBD Team" });
  expect(snapshot.prescription).toEqual(originalPrescription);
  expect(withdrawHealthConsent).not.toHaveBeenCalled();
});
