import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import App from "./App";
import { INITIAL_STATE } from "./data";
import { DemoStoreProvider } from "./store/DemoStore";
import { configureDemoSyncAdapter, emptyDemoState } from "./store/demoRepository";
import { dateInTimeZone } from "./store/patientTime";
import type { DemoState } from "./types";

function renderApp(initialState: DemoState = structuredClone(INITIAL_STATE)) {
  return render(<DemoStoreProvider initialState={initialState}><App /></DemoStoreProvider>);
}

// The journal panel is hidden until toggled from the top bar.
function openJournal() {
  fireEvent.click(screen.getByRole("button", { name: "Journal" }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

afterEach(() => configureDemoSyncAdapter(null));

function activeRecoveryState(): DemoState {
  const state = structuredClone(INITIAL_STATE);
  state.phase = "recovery";
  state.phaseConfirmed = true;
  state.pendingPhase = undefined;
  state.prescription.status = "collected";
  state.prescription.treatmentStartedAt = "2026-07-16T08:00:00.000Z";
  state.taper.verified = true;
  state.taper.days = state.taper.days.map((day) => ({
    ...day,
    taken: day.day < state.taper.currentDay,
  }));
  return state;
}

function governedStableState(): DemoState {
  const state = structuredClone(INITIAL_STATE);
  state.phase = "stable";
  state.phaseConfirmed = true;
  state.pendingPhase = undefined;
  state.entries = state.entries.map((entry) => ["BOWEL MOVEMENT", "PAIN", "FATIGUE", "WELLBEING", "FROM YOUR WATCH", "TEST RESULT"].includes(entry.kind) ? { ...entry, excluded: true } : entry);
  return state;
}

function cleanOnboardedStableState(): DemoState {
  const state = emptyDemoState();
  state.profile = {
    ...state.profile,
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
  state.contacts = [{ id: "team", initials: "IB", name: "IBD advice line", role: "IBD team", organisation: "Example Hospital", phone: "020 7000 0000" }];
  state.experiment = {
    ...state.experiment,
    id: "EXP-CLEAN",
    title: "Oat milk instead of dairy milk",
    variable: "Milk choice only",
    goal: "Observe morning urgency",
    baseline: "Morning urgency 2/10 before day 1",
    outcome: "Morning urgency score",
    durationDays: 7,
  };
  return state;
}

test("keeps private record data out of the DOM until remote hydration succeeds", async () => {
  const pendingHydration = deferred<DemoState | null>();
  const remote = structuredClone(INITIAL_STATE);
  remote.profile.name = "Loaded Patient";
  configureDemoSyncAdapter({
    hydrate: () => pendingHydration.promise,
    sync: async (state) => state,
  });

  render(<DemoStoreProvider><App /></DemoStoreProvider>);

  expect(screen.getByRole("heading", { name: "Loading your encrypted demo record…" })).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent("Amara Okafor");
  expect(document.body).not.toHaveTextContent(INITIAL_STATE.entries[0].body);
  expect(screen.queryByRole("heading", { name: "Penny" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Urgent help" }));
  const urgent = screen.getByRole("alertdialog", { name: "Urgent symptoms need urgent care" });
  expect(within(urgent).getByRole("link", { name: /NHS 111/ })).toHaveAttribute("href", "tel:111");
  expect(within(urgent).queryByRole("button", { name: "Open full safety check" })).not.toBeInTheDocument();
  fireEvent.click(within(urgent).getByRole("button", { name: "Close urgent help" }));

  await act(async () => pendingHydration.resolve(remote));
  expect(await screen.findByRole("heading", { name: "Good morning, Loaded" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: /Loading your encrypted demo record/ })).not.toBeInTheDocument();
});

test("shows save progress and a queued-error explanation inside an open locked drawer", async () => {
  const remote = structuredClone(INITIAL_STATE);
  const pendingHydration = deferred<DemoState | null>();
  const pendingSync = deferred<DemoState>();
  configureDemoSyncAdapter({
    hydrate: () => pendingHydration.promise,
    sync: () => pendingSync.promise,
  });
  renderApp(remote);
  await act(async () => pendingHydration.resolve(remote));

  fireEvent.click(screen.getByRole("button", { name: "Privacy" }));
  const drawer = screen.getByRole("dialog", { name: "Privacy & settings" });
  fireEvent.click(within(drawer).getByRole("checkbox", { name: /Secondary use/ }));

  expect(await within(drawer).findByRole("status")).toHaveTextContent(/Saving securely.*Controls resume/i);
  expect(drawer.querySelector(".drawer-body")).toHaveAttribute("inert");
  expect(screen.getByText(/Other changes pause until this one is confirmed/)).toBeInTheDocument();

  await act(async () => pendingSync.reject(new Error("simulated API outage")));
  expect(await within(drawer).findByRole("alert")).toHaveTextContent(/queued but not saved.*Close this panel/i);
  expect(screen.getByRole("button", { name: "Retry change" })).toBeInTheDocument();
  expect(drawer.querySelector(".drawer-body")).toHaveAttribute("inert");
});

test("renders the canonical MeMed home with Penny, trends and journal", () => {
  renderApp();
  openJournal();
  expect(screen.getByRole("button", { name: "MeMed home" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Good morning, Amara" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Penny" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Journal" })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: /Included pain, bowel and resting heart-rate records/ })).toBeInTheDocument();
});

test("offers an accessible daily and weekly trend timescale without imputing missing weeks", () => {
  renderApp();
  fireEvent.click(screen.getByRole("button", { name: "Trends & evidence" }));
  const drawer = screen.getByRole("dialog", { name: "Trends & evidence" });
  const daily = within(drawer).getByRole("button", { name: "Daily · 14 days" });
  const weekly = within(drawer).getByRole("button", { name: "Weekly · 8 weeks" });
  expect(daily).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(weekly);
  expect(weekly).toHaveAttribute("aria-pressed", "true");
  expect(within(drawer).getByRole("img", { name: /Eight-week view.*Missing values are not filled in/i })).toBeInTheDocument();
  expect(within(drawer).getByText(/Blank weeks stay blank/)).toBeInTheDocument();
});

test("puts the exact verified clinician-prescribed treatment first during an active flare", () => {
  const state = structuredClone(INITIAL_STATE);
  state.phase = "flare";
  state.phaseConfirmed = true;
  state.pendingPhase = undefined;
  state.prescription.status = "collected";
  state.prescription.treatmentStartedAt = new Date().toISOString();
  state.taper.verified = true;
  const today = dateInTimeZone(new Date(), state.profile.timeZone);
  state.taper.days = state.taper.days.map((day) => day.day === state.taper.currentDay ? { ...day, date: today } : day);

  renderApp(state);

  const treatment = screen.getByRole("heading", { name: `Today: 25 mg ${state.taper.medicine}` }).closest(".treatment-home-focus");
  expect(treatment).not.toBeNull();
  expect(within(treatment as HTMLElement).getByText(/cannot change it/i)).toBeInTheDocument();
  expect(within(treatment as HTMLElement).queryByRole("button", { name: /mark.*taken/i })).not.toBeInTheDocument();
  fireEvent.click(within(treatment as HTMLElement).getByRole("button", { name: "Open treatment record" }));
  expect(screen.getByRole("dialog", { name: "Care" })).toBeInTheDocument();
});

test("all four demo phases update the supported home coherently", () => {
  renderApp();
  openJournal();
  fireEvent.click(screen.getByRole("button", { name: "Steady" }));
  expect(screen.getByText("Steady — at your baseline")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Flare" }));
  expect(screen.getByText("Flare — extra support active")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Recovery" }));
  expect(screen.getByText("Recovery demo — treatment not active")).toBeInTheDocument();
  expect(screen.getByText("Dose support unavailable")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Review schedule" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Open dose support" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Watchful" }));
  expect(screen.getByText("Watchful — symptoms rising")).toBeInTheDocument();
});

test("chat capture leaves unspecified blood amount and Bristol type unconfirmed", async () => {
  renderApp();
  openJournal();
  const composer = screen.getByRole("textbox", { name: "Message Penny" });
  fireEvent.change(composer, { target: { value: "I had a loose stool with blood" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(await screen.findByText(/how much blood did you notice/i)).toBeInTheDocument();
  expect(screen.getByText(/Loose stool \(Bristol type not confirmed\), blood \(amount not specified\)/)).toBeInTheDocument();
  expect(screen.queryByText(/small amount of blood — logged from chat/)).not.toBeInTheDocument();
  fireEvent.change(composer, { target: { value: "a small amount" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(screen.getAllByText(/Loose stool \(Bristol type not confirmed\), small blood/).length).toBeGreaterThan(0));
  expect(screen.getByText(/updated the original bowel record/i)).toBeInTheDocument();
});

test("deterministic safety screening pre-empts an ordinary Penny response", async () => {
  renderApp();
  fireEvent.change(screen.getByRole("textbox", { name: "Message Penny" }), { target: { value: "I have heavy bleeding and feel faint" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  const urgent = await screen.findByRole("alertdialog", { name: "Urgent symptoms need urgent care" });
  expect(within(urgent).getByText("heavy or continuous bleeding")).toBeInTheDocument();
  expect(within(urgent).getByText("faintness")).toBeInTheDocument();
  expect(screen.getByText(/Please stop here and use urgent care now/)).toBeInTheDocument();
});

test("manual red-flag capture runs the same deterministic safety screen", async () => {
  renderApp();
  openJournal();
  fireEvent.click(screen.getByRole("button", { name: /^Pain$/ }));
  const capture = screen.getByRole("dialog", { name: "Pain" });
  fireEvent.click(within(capture).getByRole("button", { name: "8" }));
  fireEvent.click(within(capture).getByRole("button", { name: "Add to journal" }));
  const urgent = await screen.findByRole("alertdialog", { name: "Urgent symptoms need urgent care" });
  expect(within(urgent).getByText("severe abdominal pain")).toBeInTheDocument();
  expect(within(urgent).getByText(/manual entry matched/i)).toBeInTheDocument();
});

test("journal entries can be corrected, excluded and deleted", () => {
  renderApp();
  openJournal();
  fireEvent.click(screen.getAllByRole("button", { name: "Edit BOWEL MOVEMENT entry" })[0]);
  const dialog = screen.getByRole("dialog", { name: "Edit journal entry" });
  const body = within(dialog).getByRole("textbox", { name: /^What should the record say\?/ });
  fireEvent.change(body, { target: { value: "Bristol type 5, no blood" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save correction" }));
  expect(screen.getByText("Bristol type 5, no blood")).toBeInTheDocument();

  fireEvent.click(screen.getAllByRole("button", { name: "Exclude BOWEL MOVEMENT entry" })[0]);
  expect(screen.getByText("Excluded")).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole("button", { name: "Delete BOWEL MOVEMENT entry" })[0]);
  fireEvent.click(screen.getByRole("button", { name: "Delete entry" }));
  expect(screen.queryByText("Bristol type 5, no blood")).not.toBeInTheDocument();
  expect(screen.getByText(/A source used for this earlier reply was corrected, excluded or deleted/)).toBeInTheDocument();
});

test("urgent help remains directly available while a feature drawer is open", () => {
  renderApp();
  fireEvent.click(screen.getByRole("button", { name: "Trends & evidence" }));
  const drawer = screen.getByRole("dialog", { name: "Trends & evidence" });
  fireEvent.click(within(drawer).getByRole("button", { name: "Urgent help" }));
  expect(screen.getByRole("alertdialog", { name: "Urgent symptoms need urgent care" })).toBeInTheDocument();
});

test("closing urgent help opened from a drawer restores the original drawer opener", async () => {
  renderApp();
  const careTrigger = screen.getByRole("button", { name: "Care" });
  careTrigger.focus();
  fireEvent.click(careTrigger);
  const drawer = screen.getByRole("dialog", { name: "Care" });
  fireEvent.click(within(drawer).getAllByRole("button", { name: "Urgent help" })[0]);
  const urgent = screen.getByRole("alertdialog", { name: "Urgent symptoms need urgent care" });
  fireEvent.click(within(urgent).getByRole("button", { name: "Close urgent help" }));

  await waitFor(() => expect(careTrigger).toHaveFocus());
});

test("evidence-led change confirmation is explicit", () => {
  renderApp();
  fireEvent.click(screen.getByRole("button", { name: "Trends & evidence" }));
  const drawer = screen.getByRole("dialog", { name: "Trends & evidence" });
  expect(within(drawer).getByText("4 included observations support this review across 2 recorded days")).toBeInTheDocument();
  fireEvent.click(within(drawer).getByRole("button", { name: "Confirm Watchful support mode" }));
  expect(within(drawer).getByText("Confirmed by Amara")).toBeInTheDocument();
});

test("lab-authored objective evidence can be excluded but not given a dead correction action", () => {
  const current = structuredClone(INITIAL_STATE);
  current.testOrder = { ...current.testOrder, status: "result", result: 420 };
  current.entries.unshift({
    id: 99,
    date: "2026-07-17",
    time: "10:00",
    kind: "TEST RESULT",
    body: "Faecal calprotectin 420 µg/g — clinical interpretation required",
    source: "care",
    structured: { calprotectin: 420, diagnostic: false },
  });
  renderApp(current);

  fireEvent.click(screen.getByRole("button", { name: "Trends & evidence" }));
  const drawer = screen.getByRole("dialog", { name: "Trends & evidence" });

  expect(within(drawer).getByText("Lab-authored")).toBeInTheDocument();
  expect(within(drawer).queryByRole("button", { name: "Correct TEST RESULT evidence" }))
    .not.toBeInTheDocument();
  expect(within(drawer).getByRole("button", { name: "Exclude TEST RESULT evidence" }))
    .toBeInTheDocument();
});

test("new included records refresh metrics and create a reviewable phase proposal", async () => {
  renderApp();
  openJournal();
  fireEvent.click(screen.getByRole("button", { name: "Steady" }));
  fireEvent.click(screen.getByRole("button", { name: /^Pain$/ }));
  const capture = screen.getByRole("dialog", { name: "Pain" });
  fireEvent.click(within(capture).getByRole("button", { name: "6" }));
  fireEvent.click(within(capture).getByRole("button", { name: "Add to journal" }));

  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Pain" })).not.toBeInTheDocument());
  const painMetric = screen.getByText("Average pain").closest(".metric");
  expect(painMetric).not.toBeNull();
  expect(within(painMetric as HTMLElement).getByText("5")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Review proposed Watchful view/ })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /Review proposed Watchful view/ }));
  const drawer = screen.getByRole("dialog", { name: "Trends & evidence" });
  fireEvent.click(within(drawer).getByRole("button", { name: "Confirm Watchful support mode" }));
  expect(within(drawer).getByText("Confirmed by Amara")).toBeInTheDocument();
});

test("calprotectin order requires evidence, address and consent confirmation", () => {
  renderApp();
  fireEvent.click(screen.getByRole("button", { name: "Care" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm governed Watchful evidence" }));
  expect(screen.getByRole("status")).toHaveTextContent(/confirm the governed Watchful observations/i);
  fireEvent.click(screen.getByRole("button", { name: "Close Care" }));
  fireEvent.click(screen.getByRole("button", { name: "Trends & evidence" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm Watchful support mode" }));
  fireEvent.click(screen.getByRole("button", { name: "Close Trends & evidence" }));
  fireEvent.click(screen.getByRole("button", { name: "Care" }));
  fireEvent.click(screen.getByRole("button", { name: "Review test order" }));
  const confirm = screen.getByRole("alertdialog", { name: "Place this home-test order?" });
  fireEvent.click(within(confirm).getByRole("checkbox", { name: "I confirm this delivery address" }));
  fireEvent.click(within(confirm).getByRole("checkbox", { name: /I consent to this order/ }));
  fireEvent.click(within(confirm).getByRole("button", { name: "Confirm and order kit" }));
  expect(screen.getByText("Order confirmed")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Simulate kit shipped" })).toBeInTheDocument();
});

test("a presentation-only Flare view cannot be generically confirmed into care authority", () => {
  renderApp();
  fireEvent.click(screen.getByRole("button", { name: "Flare" }));
  fireEvent.click(screen.getByRole("button", { name: "Trends & evidence" }));
  const trends = screen.getByRole("dialog", { name: "Trends & evidence" });
  expect(within(trends).queryByRole("button", { name: /Confirm .* support mode/ })).not.toBeInTheDocument();
  fireEvent.click(within(trends).getByRole("button", { name: "Close Trends & evidence" }));

  fireEvent.click(screen.getByRole("button", { name: "Care" }));
  expect(screen.queryByRole("button", { name: "Prepare prescriber request" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Confirm governed Watchful evidence" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Simulate kit shipped" })).not.toBeInTheDocument();
});

test("a clean newly onboarded Stable patient can explicitly confirm the maintained baseline", () => {
  renderApp(cleanOnboardedStableState());
  fireEvent.click(screen.getByRole("button", { name: "Trends & evidence" }));
  const trends = screen.getByRole("dialog", { name: "Trends & evidence" });
  fireEvent.click(within(trends).getByRole("button", { name: "Confirm Stable baseline" }));
  expect(screen.getByRole("status")).toHaveTextContent(/Stable baseline confirmed/i);
  fireEvent.click(within(trends).getByRole("button", { name: "Close Trends & evidence" }));

  fireEvent.click(screen.getByRole("button", { name: "Experiments" }));
  expect(screen.getByText("Steady enough to learn")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Start experiment" }));
  expect(screen.getByRole("alertdialog", { name: "Start this one-variable experiment?" })).toBeInTheDocument();
});

test("a symptomatic presentation-only Stable view cannot confirm a clean baseline", () => {
  renderApp();
  fireEvent.click(screen.getByRole("button", { name: "Steady" }));
  fireEvent.click(screen.getByRole("button", { name: "Trends & evidence" }));
  const trends = screen.getByRole("dialog", { name: "Trends & evidence" });
  expect(within(trends).queryByRole("button", { name: "Confirm Stable baseline" })).not.toBeInTheDocument();
  expect(within(trends).getByRole("button", { name: "Confirm Watchful support mode" })).toBeInTheDocument();
});

test("editing a personal baseline invalidates the prior Watchful confirmation", () => {
  const current = structuredClone(INITIAL_STATE);
  current.phaseConfirmed = true;
  current.pendingPhase = undefined;
  renderApp(current);

  fireEvent.click(screen.getByRole("button", { name: "Care" }));
  expect(screen.getByRole("button", { name: "Review test order" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close Care" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Profile" })[0]);
  const profile = screen.getByRole("dialog", { name: "Profile & past medical history" });
  fireEvent.change(within(profile).getByRole("textbox", { name: "Usual pain" }), { target: { value: "4–5/10" } });
  fireEvent.click(within(profile).getByRole("button", { name: "Save changes" }));
  fireEvent.click(within(profile).getByRole("button", { name: "Close Profile & past medical history" }));

  fireEvent.click(screen.getByRole("button", { name: "Care" }));
  expect(screen.getByRole("button", { name: "Confirm governed Watchful evidence" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Review test order" })).not.toBeInTheDocument();
});

test("clinician update remains editable until the patient approves send", () => {
  renderApp();
  fireEvent.click(screen.getByRole("button", { name: "Care" }));
  const draft = screen.getByRole("textbox", { name: "Patient-approved message" });
  fireEvent.change(draft, { target: { value: "Please review my recent recorded symptoms and attached entries." } });
  fireEvent.click(screen.getByRole("button", { name: "Review team message" }));
  const confirm = screen.getByRole("alertdialog", { name: "Send this message to your IBD team?" });
  fireEvent.click(within(confirm).getByRole("button", { name: "Approve and send" }));
  expect(screen.getByRole("status")).toHaveTextContent(/confirm that you reviewed/i);
  fireEvent.click(within(confirm).getByRole("checkbox", { name: "I reviewed the message and want it sent" }));
  fireEvent.click(within(confirm).getByRole("button", { name: "Approve and send" }));
  expect(screen.getByRole("button", { name: "Simulate team read" })).toBeInTheDocument();
  expect(draft).toBeDisabled();
});

test("changed records preserve a stale team draft and require explicit refresh", () => {
  const state = structuredClone(INITIAL_STATE);
  state.teamMessage.body = "My patient-edited team update.";
  state.teamMessageStale = true;
  renderApp(state);
  fireEvent.click(screen.getByRole("button", { name: "Care" }));

  expect(screen.getByRole("alert")).toHaveTextContent(/this draft is preserved/i);
  expect(screen.getByRole("textbox", { name: "Patient-approved message" })).toHaveValue("My patient-edited team update.");
  expect(screen.getByRole("button", { name: "Review team message" })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Refresh from included records" }));
  expect(screen.queryByText(/this draft is preserved/i)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Review team message" })).not.toBeDisabled();
  expect(screen.getByRole("textbox", { name: "Patient-approved message" })).not.toHaveValue("My patient-edited team update.");
});

test("a mistaken taken-dose fact has an explicit audited correction confirmation", () => {
  const state = structuredClone(INITIAL_STATE);
  const dose = state.taper.days[11];
  dose.taken = true;
  state.prescription.status = "collected";
  state.prescription.treatmentStartedAt = "2026-07-17T08:00:00.000Z";
  state.entries.unshift({
    id: 990,
    date: dose.date,
    time: "08:00",
    kind: "MEDICATION",
    body: `${dose.doseMg} mg ${state.taper.medicine} taken — prescribed taper day ${dose.day}`,
    source: "manual",
    structured: { doseMg: dose.doseMg, taken: true, taperDay: dose.day },
  });
  renderApp(state);
  openJournal();
  fireEvent.click(screen.getByRole("button", { name: "Care" }));
  fireEvent.click(screen.getByText("Correct an adherence record"));
  fireEvent.click(screen.getByRole("button", { name: `Day ${dose.day} marked taken — I marked this by mistake` }));

  const confirmation = screen.getByRole("alertdialog", { name: `Mark taper day ${dose.day} taken record as a mistake?` });
  expect(confirmation).toHaveTextContent(/no prescribed day, dose or date changes/i);
  fireEvent.click(within(confirmation).getByRole("button", { name: "Yes, record the correction" }));

  expect(screen.getByRole("status")).toHaveTextContent(/clinician-authored schedule was unchanged/i);
  expect(screen.queryByRole("button", { name: `Day ${dose.day} marked taken — I marked this by mistake` })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close Care" }));
  expect(screen.getByText(/marked taken by mistake; that patient-entered adherence fact is retracted/i)).toBeInTheDocument();
});

test("a follow-up draft keeps the completed clinician exchange visible", () => {
  renderApp();
  fireEvent.click(screen.getByRole("button", { name: "Care" }));
  fireEvent.click(screen.getByRole("button", { name: "Review team message" }));
  const confirm = screen.getByRole("alertdialog", { name: "Send this message to your IBD team?" });
  fireEvent.click(within(confirm).getByRole("checkbox", { name: "I reviewed the message and want it sent" }));
  fireEvent.click(within(confirm).getByRole("button", { name: "Approve and send" }));
  fireEvent.click(screen.getByRole("button", { name: "Simulate team read" }));
  fireEvent.click(screen.getByRole("button", { name: "Simulate nurse reply" }));
  fireEvent.click(screen.getByRole("button", { name: "Prepare next follow-up draft" }));

  const history = screen.getByLabelText("Earlier clinician-message thread");
  expect(within(history).getByText("Recent recorded symptoms for Amara Okafor")).toBeInTheDocument();
  expect(within(history).getByText(/please complete the calprotectin test/i)).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Patient-approved message" })).not.toBeDisabled();
});

test("patient-edited Care summary survives new records until explicit regeneration", async () => {
  renderApp();
  openJournal();
  fireEvent.click(screen.getByRole("button", { name: "Care" }));
  const careSummary = screen.getByRole("textbox", { name: "Edit recovery summary" });
  fireEvent.change(careSummary, { target: { value: "My reviewed appointment wording." } });
  fireEvent.click(screen.getByRole("button", { name: "Save summary draft" }));
  fireEvent.click(screen.getByRole("button", { name: "Close Care" }));

  fireEvent.click(screen.getByRole("button", { name: /^Pain$/ }));
  const capture = screen.getByRole("dialog", { name: "Pain" });
  fireEvent.click(within(capture).getByRole("button", { name: "6" }));
  fireEvent.click(within(capture).getByRole("button", { name: "Add to journal" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Pain" })).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Care" }));

  expect(screen.getByRole("textbox", { name: "Edit recovery summary" })).toHaveValue("My reviewed appointment wording.");
  expect(screen.getByText("Your saved wording is preserved")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Regenerate from records" }));
  expect((screen.getByRole("textbox", { name: "Edit recovery summary" }) as HTMLTextAreaElement).value).toContain("PAIN");
});

test("recovery dose confirmation logs only the verified 25 mg taper dose", () => {
  renderApp(activeRecoveryState());
  fireEvent.click(screen.getByRole("button", { name: "Open taper" }));
  expect(screen.getByRole("heading", { name: "Today: 25 mg Prednisolone" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Mark today’s dose as taken" }));
  const confirm = screen.getByRole("alertdialog", { name: "Confirm 25 mg was taken?" });
  fireEvent.click(within(confirm).getByRole("button", { name: "Mark today’s dose as taken" }));
  expect(screen.getAllByText(/25 mg Prednisolone taken — prescribed taper day/).length).toBeGreaterThan(0);
});

test("presentation-only Recovery keeps the schedule reviewable but locks dose actions", () => {
  renderApp();
  fireEvent.click(screen.getByRole("button", { name: "Recovery" }));
  fireEvent.click(screen.getByRole("button", { name: "Open taper" }));
  expect(screen.getByRole("heading", { name: "Schedule review only — dose support is not active" })).toBeInTheDocument();
  expect(screen.getByText("Dose actions are locked")).toBeInTheDocument();
  expect(screen.getByText("Review the exact imported schedule")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Mark today’s dose as taken" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Snooze 30 minutes" })).not.toBeInTheDocument();
});

test("recovery side-effect check-ins refresh the clinician summary", async () => {
  renderApp(activeRecoveryState());
  fireEvent.click(screen.getByRole("button", { name: "Open taper" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Poor sleep" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Mood change" }));
  fireEvent.click(screen.getByRole("button", { name: "Save side-effect check-in" }));
  fireEvent.click(within(screen.getByRole("alertdialog", { name: "Get same-day clinical advice" })).getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: "Close Care" }));
  fireEvent.click(screen.getByRole("button", { name: "Trends & evidence" }));
  await waitFor(() => {
    const summary = (screen.getByRole("textbox", { name: "Only your approved words leave MeMed" }) as HTMLTextAreaElement).value;
    expect(summary).toContain("Patient-recorded recovery observations: Poor sleep, Mood change");
    expect(summary).toContain("latest recovery side-effect check-in is marked complete");
  });
});

test("diet experiment cannot resume outside Steady", () => {
  renderApp();
  fireEvent.click(screen.getByRole("button", { name: "Experiments" }));
  expect(screen.getByText("Experiments are paused in watchful mode")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Resume experiment" }));
  expect(screen.queryByRole("alertdialog", { name: /Start this one-variable experiment/ })).not.toBeInTheDocument();
});

test("diet experiment advances once per calendar day and holds completion until its duration", () => {
  renderApp(governedStableState());
  openJournal();
  fireEvent.click(screen.getByRole("button", { name: "Experiments" }));

  fireEvent.click(screen.getByRole("button", { name: "Resume experiment" }));
  fireEvent.click(screen.getByRole("button", { name: "Start experiment" }));
  expect(screen.getByText("active", { exact: true })).toBeInTheDocument();

  fireEvent.change(screen.getByRole("textbox", { name: /Today’s neutral observation/ }), { target: { value: "Morning urgency was unchanged today." } });
  fireEvent.click(screen.getByRole("button", { name: "Save day 10 check-in" }));
  expect(screen.getByRole("progressbar", { name: "Experiment progress" })).toHaveAttribute("aria-valuenow", "10");
  expect(screen.getByText("Day 10: Morning urgency was unchanged today.")).toBeInTheDocument();
  expect(screen.getByText(/Today’s dated check-in is already in the shared timeline/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save day 11 check-in" })).toBeDisabled();

  fireEvent.change(screen.getByRole("textbox", { name: "Review the outcome before completing" }), { target: { value: "I did not notice a clear difference in morning urgency." } });
  expect(screen.getByRole("button", { name: "Review and complete experiment" })).toBeDisabled();
  expect(screen.getByText("active", { exact: true })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Close Experiments" }));
  expect(screen.getByText(/Diet experiment started: Oat milk instead of dairy milk/)).toBeInTheDocument();
  expect(screen.getByText(/Diet experiment check-in — day 10 of 14: Morning urgency was unchanged today/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Trends & evidence" }));
  expect((screen.getByRole("textbox", { name: "Only your approved words leave MeMed" }) as HTMLTextAreaElement).value).toContain("Morning urgency was unchanged today");
});

test("a restrictive candidate starts only after a linked reviewed reply and explicit approval", () => {
  renderApp(governedStableState());
  fireEvent.click(screen.getByRole("button", { name: "Experiments" }));
  fireEvent.click(screen.getByRole("button", { name: "Create a new candidate" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Candidate name" }), { target: { value: "Restrictive elimination trial" } });
  fireEvent.change(screen.getByRole("textbox", { name: "One main variable" }), { target: { value: "Remove a whole food group" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Your goal" }), { target: { value: "Explore symptoms" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Pre-start baseline" }), { target: { value: "Daily wellbeing was same as usual before day 1" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Outcome to track" }), { target: { value: "Daily wellbeing" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /Clinical review required before starting/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save candidate" }));
  const replace = screen.getByRole("alertdialog", { name: "Replace the current experiment candidate?" });
  fireEvent.click(within(replace).getByRole("button", { name: "Save new candidate" }));

  fireEvent.click(screen.getByRole("button", { name: "Start experiment" }));
  expect(screen.getByRole("status")).toHaveTextContent(/needs a recorded dietitian or IBD-team approval/i);
  expect(screen.queryByRole("alertdialog", { name: "Start this one-variable experiment?" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Prepare a dietitian question" }));
  expect(screen.getByText(/Requested in team thread \(draft\)/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close Experiments" }));
  fireEvent.click(screen.getByRole("button", { name: "Care" }));
  fireEvent.click(screen.getByRole("button", { name: "Review team message" }));
  const send = screen.getByRole("alertdialog", { name: "Send this message to your IBD team?" });
  fireEvent.click(within(send).getByRole("checkbox", { name: "I reviewed the message and want it sent" }));
  fireEvent.click(within(send).getByRole("button", { name: "Approve and send" }));
  fireEvent.click(screen.getByRole("button", { name: "Simulate team read" }));
  fireEvent.click(screen.getByRole("button", { name: "Simulate reviewed team reply" }));
  fireEvent.click(screen.getByRole("button", { name: "Close Care" }));
  fireEvent.click(screen.getByRole("button", { name: "Experiments" }));
  expect(screen.getByText(/Eligible team reply received/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Record simulated team approval" }));
  expect(screen.getByText(/Approved by IBD team \(simulated\)/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Start experiment" }));
  fireEvent.click(within(screen.getByRole("alertdialog", { name: "Start this one-variable experiment?" })).getByRole("button", { name: "Start experiment" }));
  expect(screen.getByText("active", { exact: true })).toBeInTheDocument();
});

test("restrictive diet ideas prepare an editable care-team question without sending it", () => {
  renderApp();
  fireEvent.click(screen.getByRole("button", { name: "Experiments" }));
  fireEvent.click(screen.getByRole("button", { name: "Prepare a dietitian question" }));
  expect(screen.getByRole("status")).toHaveTextContent(/added to your editable care-team draft/i);
  fireEvent.click(screen.getByRole("button", { name: "Close Experiments" }));
  fireEvent.click(screen.getByRole("button", { name: "Care" }));
  expect((screen.getByRole("textbox", { name: "Patient-approved message" }) as HTMLTextAreaElement).value).toContain("Dietitian experiment question:");
});

test("privacy controls delete chat separately from journal", () => {
  renderApp();
  openJournal();
  fireEvent.click(screen.getByRole("button", { name: "Privacy" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete conversation" }));
  const confirm = screen.getByRole("alertdialog", { name: "Delete your Penny conversation?" });
  fireEvent.click(within(confirm).getByRole("button", { name: "Delete conversation" }));
  fireEvent.click(screen.getByRole("button", { name: "Close Privacy & settings" }));
  expect(screen.getByText("Your conversation is private and empty.")).toBeInTheDocument();
  expect(screen.getByText(/Bristol type 6, urgency, small amount of blood/)).toBeInTheDocument();
});

test("Penny cannot create journal entries when journal access is disabled", async () => {
  renderApp();
  openJournal();
  const existing = screen.getAllByRole("button", { name: /Edit .* entry/ }).length;
  fireEvent.click(screen.getByRole("button", { name: "Privacy" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Journal and photos/ }));
  fireEvent.click(screen.getByRole("button", { name: "Close Privacy & settings" }));
  expect(screen.getByRole("button", { name: "Add voice note" })).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox", { name: "Message Penny" }), { target: { value: "Loose stool with urgency this morning" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(await screen.findByText(/journal access is off/i)).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: /Edit .* entry/ })).toHaveLength(existing);
});

test("Penny keeps profile and care permissions independent from journal access", async () => {
  renderApp();
  fireEvent.click(screen.getByRole("button", { name: "Privacy" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Journal and photos/ }));
  fireEvent.click(screen.getByRole("button", { name: "Close Privacy & settings" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Message Penny" }), { target: { value: "What is my calprotectin test status?" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(screen.getAllByText(/Home-test status: prepared/).length).toBeGreaterThan(0));
  expect(screen.queryByText(/I did not read or add to your journal/)).not.toBeInTheDocument();
});

test("Penny retrieves earlier messages only with the separate conversation permission", async () => {
  renderApp();
  fireEvent.change(screen.getByRole("textbox", { name: "Message Penny" }), { target: { value: "What did I tell you earlier?" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(await screen.findByText(/conversation records, not independently verified facts/i)).toBeInTheDocument();
  fireEvent.click(screen.getAllByText(/sources used/i).at(-1)!);
  expect(screen.getAllByRole("link", { name: "Earlier patient message" }).length).toBeGreaterThan(0);

  fireEvent.click(screen.getByRole("button", { name: "Privacy" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Earlier Penny conversation/ }));
  fireEvent.click(screen.getByRole("button", { name: "Close Privacy & settings" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Message Penny" }), { target: { value: "What did I say in our previous conversation?" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(await screen.findByText(/Earlier-conversation access is off/i)).toBeInTheDocument();
});

test("withdrawing health-data consent pauses new capture but keeps correction and export controls", () => {
  renderApp();
  openJournal();
  fireEvent.click(screen.getAllByRole("button", { name: "Profile" })[0]);
  const profile = screen.getByRole("dialog", { name: "Profile & past medical history" });
  fireEvent.click(within(profile).getByRole("checkbox", { name: /I consent to holding sensitive health information/i }));
  fireEvent.click(within(profile).getByRole("button", { name: "Save changes" }));
  fireEvent.click(within(profile).getByRole("button", { name: "Close Profile & past medical history" }));

  expect(screen.getByText("Health-data tracking is paused")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Message Penny" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Add journal entry" })).toBeDisabled();
  expect(screen.getAllByRole("button", { name: /Edit .* entry/ })[0]).toBeEnabled();
  expect(screen.getByRole("button", { name: "Experiments" })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Care" }));
  expect(screen.getByText("New care workflow actions are paused")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Confirm governed Watchful evidence" })).toBeDisabled();
  expect(screen.getByRole("textbox", { name: "Edit recovery summary" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Close Care" }));
  fireEvent.click(screen.getByRole("button", { name: "Privacy" }));
  expect(screen.getByRole("button", { name: /Connect Apple Health/ })).toBeDisabled();
});

test("trusted supporter access requires identity and an explicit scope before save", () => {
  renderApp();
  fireEvent.click(screen.getByRole("button", { name: "Privacy" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Enable trusted supporter/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save supporter access" }));
  expect(screen.getByRole("status")).toHaveTextContent(/name and relationship/i);
  fireEvent.change(screen.getByRole("textbox", { name: "Supporter name" }), { target: { value: "Nia Okafor" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Relationship" }), { target: { value: "Sister" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /View patient-approved summaries/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save supporter access" }));
  expect(screen.getByRole("status")).toHaveTextContent(/scoped supporter access saved/i);
});
