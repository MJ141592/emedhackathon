import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { INITIAL_STATE } from "../data";
import { DemoStoreProvider, useDemoStore } from "../store/DemoStore";
import { configureDemoSyncAdapter } from "../store/demoRepository";
import type { DemoState, JournalEntry } from "../types";
import { JournalPanel } from "./JournalPanel";

let observedState: DemoState | undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

afterEach(() => configureDemoSyncAdapter(null));

function StateObserver() {
  observedState = useDemoStore().state;
  return null;
}

function renderSeededEntry(entry: JournalEntry) {
  const state: DemoState = structuredClone(INITIAL_STATE);
  state.entries = [entry, ...state.entries];
  render(
    <DemoStoreProvider initialState={state}>
      <StateObserver />
      <JournalPanel notify={vi.fn()} onOpenCare={vi.fn()} trackingEnabled />
    </DemoStoreProvider>,
  );
}

test("removes only an attached photo and retains its journal text", async () => {
  const entry: JournalEntry = {
    id: 501,
    date: "2026-07-17",
    time: "10:00",
    kind: "MEAL",
    body: "Porridge and banana — patient-authored meal note",
    source: "manual",
    structured: { description: "Porridge and banana" },
    photo: {
      name: "breakfast.jpg",
      previewUrl: "data:image/jpeg;base64,YQ==",
      purpose: "meal",
      retentionDays: 30,
      consented: true,
      derivedObservation: "Porridge and sliced banana",
    },
  };
  renderSeededEntry(entry);

  expect(screen.getByRole("img", { name: "meal photo preview uploaded by the patient" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Remove photo from MEAL entry" }));

  expect(screen.queryByRole("img", { name: "meal photo preview uploaded by the patient" })).not.toBeInTheDocument();
  expect(screen.getByText(entry.body)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Remove photo from MEAL entry" })).not.toBeInTheDocument();
  await waitFor(() => {
    expect(observedState?.entries.find((item) => item.id === entry.id)?.photo).toBeUndefined();
    expect(observedState?.entries.find((item) => item.id === entry.id)?.body).toBe(entry.body);
  });
});

test("keeps a persisted photo visible until its narrow deletion is acknowledged", async () => {
  const entry: JournalEntry = {
    id: 506,
    date: "2026-07-17",
    time: "10:00",
    kind: "MEAL",
    body: "Keep this journal wording",
    source: "manual",
    photo: {
      name: "pending-delete.jpg",
      previewUrl: "data:image/jpeg;base64,YQ==",
      purpose: "meal",
      retentionDays: 30,
      consented: true,
    },
  };
  const state = structuredClone(INITIAL_STATE);
  state.entries = [entry, ...state.entries];
  const accepted = structuredClone(state);
  const acceptedEntry = accepted.entries.find((item) => item.id === entry.id)!;
  delete acceptedEntry.photo;
  const pendingRemoval = deferred<DemoState>();
  const notify = vi.fn();
  configureDemoSyncAdapter({
    hydrate: () => new Promise<DemoState | null>(() => undefined),
    sync: async (candidate) => candidate,
    updateJournal: () => pendingRemoval.promise,
  });
  render(
    <DemoStoreProvider initialState={state}>
      <StateObserver />
      <JournalPanel notify={notify} onOpenCare={vi.fn()} trackingEnabled />
    </DemoStoreProvider>,
  );

  const remove = screen.getByRole("button", { name: "Remove photo from MEAL entry" });
  fireEvent.click(remove);

  expect(screen.getByRole("img", { name: "meal photo preview uploaded by the patient" })).toBeInTheDocument();
  expect(remove).toBeDisabled();
  expect(remove).toHaveTextContent("Removing photo…");
  expect(notify).not.toHaveBeenCalledWith(expect.stringMatching(/Photo deleted/i));

  await act(async () => pendingRemoval.resolve(accepted));
  await waitFor(() => expect(screen.queryByRole("img", { name: "meal photo preview uploaded by the patient" })).not.toBeInTheDocument());
  expect(screen.getByText(entry.body)).toBeInTheDocument();
  expect(notify).toHaveBeenCalledWith(expect.stringMatching(/Photo deleted/i));
});

test("saving corrected wellbeing wording refreshes structure and the visible flag", async () => {
  const entry: JournalEntry = {
    id: 502,
    date: "2026-07-17",
    time: "10:05",
    kind: "WELLBEING",
    body: "Feeling worse than usual · fatigue high · appetite reduced",
    source: "manual",
    flagged: true,
    structured: { wellbeing: "worse", fatigue: "high", appetite: "reduced" },
  };
  renderSeededEntry(entry);

  const originalRow = screen.getByText(entry.body).closest("article");
  expect(originalRow).not.toBeNull();
  expect(within(originalRow as HTMLElement).getByText("Flagged")).toBeInTheDocument();
  fireEvent.click(within(originalRow as HTMLElement).getByRole("button", { name: "Edit WELLBEING entry" }));

  const editor = screen.getByRole("dialog", { name: "Edit journal entry" });
  fireEvent.change(within(editor).getByRole("textbox", { name: /What should the record say/ }), {
    target: { value: "Feeling better than usual · fatigue low · sleep 7 h 30 m" },
  });
  fireEvent.click(within(editor).getByRole("button", { name: "Save correction" }));

  const correctedRow = screen.getByText("Feeling better than usual · fatigue low · sleep 7 h 30 m").closest("article");
  expect(correctedRow).not.toBeNull();
  expect(within(correctedRow as HTMLElement).queryByText("Flagged")).not.toBeInTheDocument();
  await waitFor(() => {
    const corrected = observedState?.entries.find((item) => item.id === entry.id);
    expect(corrected?.structured).toMatchObject({ wellbeing: "better", fatigue: "low", sleepHours: 7.5 });
    expect(corrected?.structured).not.toHaveProperty("appetite");
    expect(corrected?.flagged).toBe(false);
  });
});

test("objective care test results expose only exclude and delete correction paths", async () => {
  const entry: JournalEntry = {
    id: 503,
    date: "2026-07-17",
    time: "10:10",
    kind: "TEST RESULT",
    body: "Faecal calprotectin 420 µg/g — clinical interpretation required",
    source: "care",
    flagged: true,
    structured: { calprotectin: 420, diagnostic: false },
  };
  renderSeededEntry(entry);

  const row = screen.getByText(entry.body).closest("article");
  expect(row).not.toBeNull();
  expect(within(row as HTMLElement).getByText("Objective care record")).toBeInTheDocument();
  expect(within(row as HTMLElement).queryByRole("button", { name: "Edit TEST RESULT entry" })).not.toBeInTheDocument();
  expect(within(row as HTMLElement).getByRole("button", { name: "Exclude TEST RESULT entry" })).toBeInTheDocument();
  expect(within(row as HTMLElement).getByRole("button", { name: "Delete TEST RESULT entry" })).toBeInTheDocument();

  fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Exclude TEST RESULT entry" }));
  await waitFor(() => expect(observedState?.entries.find((item) => item.id === entry.id)?.excluded).toBe(true));
  expect(observedState?.entries.find((item) => item.id === entry.id)?.body).toBe(entry.body);
  expect(observedState?.entries.find((item) => item.id === entry.id)?.structured).toEqual(entry.structured);
});

test("moves focus to an adjacent journal action after confirming deletion", async () => {
  const entry: JournalEntry = {
    id: 505,
    date: "2026-07-18",
    time: "10:15",
    kind: "MEAL",
    body: "Temporary meal record to delete",
    source: "manual",
  };
  renderSeededEntry(entry);

  const row = screen.getByText(entry.body).closest("article") as HTMLElement;
  const target = within(row).getByRole("button", { name: "Delete MEAL entry" });
  const adjacent = screen.getAllByRole("button", { name: /^Delete .* entry$/ })
    .find((button) => button !== target);
  expect(adjacent).toBeDefined();

  fireEvent.click(target);
  fireEvent.click(within(screen.getByRole("alertdialog", { name: "Delete this journal entry?" })).getByRole("button", { name: "Delete entry" }));

  await waitFor(() => expect(screen.queryByText(entry.body)).not.toBeInTheDocument());
  await waitFor(() => expect(adjacent).toHaveFocus());
});

test("retains the delete confirmation and source record when the persisted deletion fails", async () => {
  const entry: JournalEntry = {
    id: 507,
    date: "2026-07-18",
    time: "10:20",
    kind: "MEAL",
    body: "Deletion must be acknowledged",
    source: "manual",
  };
  const state = structuredClone(INITIAL_STATE);
  state.entries = [entry, ...state.entries];
  const pendingDeletion = deferred<DemoState>();
  const notify = vi.fn();
  configureDemoSyncAdapter({
    hydrate: () => new Promise<DemoState | null>(() => undefined),
    sync: async (candidate) => candidate,
    deleteJournal: () => pendingDeletion.promise,
  });
  render(
    <DemoStoreProvider initialState={state}>
      <StateObserver />
      <JournalPanel notify={notify} onOpenCare={vi.fn()} trackingEnabled />
    </DemoStoreProvider>,
  );

  const row = screen.getByText(entry.body).closest("article") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Delete MEAL entry" }));
  const dialog = screen.getByRole("alertdialog", { name: "Delete this journal entry?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete entry" }));

  expect(dialog).toHaveAttribute("aria-busy", "true");
  expect(within(dialog).getByRole("button", { name: "Deleting entry…" })).toBeDisabled();
  expect(screen.getByText(entry.body)).toBeInTheDocument();
  expect(notify).not.toHaveBeenCalledWith(expect.stringMatching(/Entry deleted/i));

  await act(async () => pendingDeletion.reject(new Error("API unavailable")));
  await waitFor(() => expect(dialog).toHaveAttribute("aria-busy", "false"));
  expect(screen.getByText(entry.body)).toBeInTheDocument();
  expect(screen.getByRole("alertdialog", { name: "Delete this journal entry?" })).toBeInTheDocument();
  expect(notify).toHaveBeenCalledWith(expect.stringMatching(/was not deleted/i));
});

test("taper adherence sources cannot bypass the audited correction path in Journal", () => {
  const entry: JournalEntry = {
    id: 504,
    date: "2026-07-17",
    time: "08:00",
    kind: "MEDICATION",
    body: "25 mg Prednisolone taken — prescribed taper day 12",
    source: "manual",
    structured: { doseMg: 25, taken: true, taperDay: 12 },
  };
  renderSeededEntry(entry);

  const row = screen.getByText(entry.body).closest("article");
  expect(row).not.toBeNull();
  expect(within(row as HTMLElement).getByText("Adherence source · correct in Care")).toBeInTheDocument();
  expect(within(row as HTMLElement).queryByRole("button", { name: "Edit MEDICATION entry" })).not.toBeInTheDocument();
  expect(within(row as HTMLElement).queryByRole("button", { name: "Exclude MEDICATION entry" })).not.toBeInTheDocument();
  expect(within(row as HTMLElement).queryByRole("button", { name: "Delete MEDICATION entry" })).not.toBeInTheDocument();
});

test("keeps a journal draft open and locked until an explicit API save is acknowledged", async () => {
  const pendingSave = deferred<never>();
  const notify = vi.fn();
  configureDemoSyncAdapter({
    hydrate: () => new Promise<DemoState | null>(() => undefined),
    sync: async (state) => state,
    addJournal: () => pendingSave.promise,
  });
  render(
    <DemoStoreProvider initialState={structuredClone(INITIAL_STATE)}>
      <JournalPanel notify={notify} onOpenCare={vi.fn()} trackingEnabled />
    </DemoStoreProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Meal photo" }));
  const dialog = screen.getByRole("dialog", { name: "Meal or hydration" });
  const description = within(dialog).getByRole("textbox", { name: /Meal description or likely ingredients/ });
  fireEvent.change(description, { target: { value: "Draft that must survive an outage" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add to journal" }));

  expect(dialog).toHaveAttribute("aria-busy", "true");
  expect(within(dialog).getByRole("button", { name: "Saving securely…" })).toBeDisabled();
  expect(within(dialog).getByRole("button", { name: "Close capture" })).toBeDisabled();
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect(within(dialog).getByRole("status")).toHaveTextContent(/Capture controls are temporarily unavailable/i);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.getByRole("dialog", { name: "Meal or hydration" })).toBeInTheDocument();

  await act(async () => pendingSave.reject(new Error("API unavailable")));
  await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringMatching(/was not saved/i)));
  expect(screen.getByRole("dialog", { name: "Meal or hydration" })).toBeInTheDocument();
  expect(description).toHaveValue("Draft that must survive an outage");
  expect(dialog).toHaveAttribute("aria-busy", "false");
  expect(within(dialog).getByRole("button", { name: "Add to journal" })).toBeEnabled();
  expect(within(dialog).getByRole("button", { name: "Close capture" })).toBeEnabled();
});

test("does not claim a quick photo was saved before the API acknowledges it", async () => {
  const pendingSave = deferred<never>();
  const notify = vi.fn();
  const addJournal = vi.fn(() => pendingSave.promise);
  configureDemoSyncAdapter({
    hydrate: () => new Promise<DemoState | null>(() => undefined),
    sync: async (state) => state,
    addJournal,
  });
  render(
    <DemoStoreProvider initialState={structuredClone(INITIAL_STATE)}>
      <StateObserver />
      <JournalPanel notify={notify} onOpenCare={vi.fn()} trackingEnabled />
    </DemoStoreProvider>,
  );

  const input = screen.getByLabelText("Choose a quick meal photo");
  fireEvent.change(input, {
    target: { files: [new File(["meal"], "unacknowledged.jpg", { type: "image/jpeg" })] },
  });

  expect(await screen.findByRole("status")).toHaveTextContent(/Reading and saving your meal photo securely/i);
  expect(input).toBeDisabled();
  expect(screen.getByRole("button", { name: "Saving meal photo…" })).toBeDisabled();
  expect(notify).not.toHaveBeenCalledWith(expect.stringMatching(/photo saved/i));

  await waitFor(() => expect(addJournal).toHaveBeenCalledTimes(1));
  await act(async () => pendingSave.reject(new Error("API unavailable")));
  await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringMatching(/photo was not saved/i)));
  expect(observedState?.entries.some((entry) => entry.photo?.name === "unacknowledged.jpg")).toBe(false);
  expect(input).toBeEnabled();
  expect(screen.queryByText(/Reading and saving your meal photo securely/i)).not.toBeInTheDocument();
});

test("quick meal camera is fire-and-forget while retaining a correctable image record", async () => {
  const notify = vi.fn();
  render(
    <DemoStoreProvider initialState={structuredClone(INITIAL_STATE)}>
      <StateObserver />
      <JournalPanel notify={notify} onOpenCare={vi.fn()} trackingEnabled />
    </DemoStoreProvider>,
  );

  fireEvent.change(screen.getByLabelText("Choose a quick meal photo"), {
    target: { files: [new File(["meal"], "quick-breakfast.jpg", { type: "image/jpeg" })] },
  });

  await waitFor(() => expect(observedState?.entries.some((entry) => entry.photo?.name === "quick-breakfast.jpg")).toBe(true));
  const captured = observedState?.entries.find((entry) => entry.photo?.name === "quick-breakfast.jpg");
  expect(captured).toMatchObject({
    kind: "MEAL",
    body: "Meal photo captured — description optional",
    structured: { quickPhoto: true },
    photo: { purpose: "meal", retentionDays: 30, consented: true },
  });
  expect(screen.queryByRole("dialog", { name: "Meal or hydration" })).not.toBeInTheDocument();
  expect(notify).toHaveBeenCalledWith(expect.stringMatching(/You can close MeMed or edit it later/i));
});

test("stages a meal photo until explicit save and preserves all meal fields", async () => {
  const notify = vi.fn();
  render(
    <DemoStoreProvider initialState={structuredClone(INITIAL_STATE)}>
      <StateObserver />
      <JournalPanel notify={notify} onOpenCare={vi.fn()} trackingEnabled />
    </DemoStoreProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Meal photo" }));
  const dialog = screen.getByRole("dialog", { name: "Meal or hydration" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: /Meal description or likely ingredients/ }), { target: { value: "Porridge and banana" } });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Portion (optional)" }), { target: { value: "medium bowl" } });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Hydration (optional)" }), { target: { value: "300 ml water" } });
  const file = new File(["meal"], "breakfast.jpg", { type: "image/jpeg" });
  fireEvent.change(screen.getByLabelText("Choose meal photo"), { target: { files: [file] } });

  expect(await screen.findByRole("img", { name: "meal photo preview: breakfast.jpg" })).toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "Meal or hydration" })).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(/not been added to your journal yet/i);
  expect(observedState?.entries.some((entry) => entry.photo?.name === "breakfast.jpg")).toBe(false);
  fireEvent.change(screen.getByRole("combobox", { name: "Keep photo for" }), { target: { value: "90" } });
  fireEvent.click(screen.getByRole("button", { name: "Add to journal" }));

  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Meal or hydration" })).not.toBeInTheDocument());
  expect(await screen.findByText("Porridge and banana")).toBeInTheDocument();
  expect(notify).toHaveBeenCalledWith(expect.stringMatching(/until you choose add to journal/i));
  await waitFor(() => {
    const captured = observedState?.entries.find((entry) => entry.photo?.name === "breakfast.jpg");
    expect(captured?.kind).toBe("MEAL");
    expect(captured?.photo?.consented).toBe(true);
    expect(captured?.photo?.retentionDays).toBe(90);
    expect(captured?.structured).toMatchObject({
      description: "Porridge and banana",
      portion: "medium bowl",
      hydration: "300 ml water",
    });
  });
});

test("removes and reselects a staged photo without calling model APIs when access is off", async () => {
  const state = structuredClone(INITIAL_STATE);
  state.privacy.assistantJournalAccess = false;
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const notify = vi.fn();
  render(
    <DemoStoreProvider initialState={state}>
      <StateObserver />
      <JournalPanel notify={notify} onOpenCare={vi.fn()} trackingEnabled />
    </DemoStoreProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Meal photo" }));
  const file = new File(["meal"], "private.jpg", { type: "image/jpeg" });
  fireEvent.change(screen.getByLabelText("Choose meal photo"), {
    target: { files: [file] },
  });

  expect(await screen.findByRole("img", { name: "meal photo preview: private.jpg" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Remove selected meal photo" }));
  expect(screen.queryByRole("img", { name: "meal photo preview: private.jpg" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Take or choose a photo" })).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Choose meal photo"), { target: { files: [file] } });
  expect(await screen.findByRole("img", { name: "meal photo preview: private.jpg" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Optionally describe meal with Runware/i }));

  expect(notify).toHaveBeenCalledWith(expect.stringMatching(/access is off/i));
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(observedState?.entries.some((entry) => entry.photo?.name === "private.jpg")).toBe(false);
});

test("keeps an optional Runware observation editable and staged until save", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({ configured: true, models: { image: "test-model" } }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ text: "A bowl of porridge with sliced banana", model: "test-model" }), { status: 200 }));
  render(
    <DemoStoreProvider initialState={structuredClone(INITIAL_STATE)}>
      <StateObserver />
      <JournalPanel notify={vi.fn()} onOpenCare={vi.fn()} trackingEnabled />
    </DemoStoreProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Meal photo" }));
  fireEvent.change(screen.getByLabelText("Choose meal photo"), {
    target: { files: [new File(["meal"], "analysis.jpg", { type: "image/jpeg" })] },
  });
  await screen.findByRole("img", { name: "meal photo preview: analysis.jpg" });
  fireEvent.click(screen.getByRole("button", { name: /Optionally describe meal with Runware/i }));

  const observation = await screen.findByRole("textbox", { name: /Review or replace the image observation/i });
  await waitFor(() => expect(observation).toHaveValue("A bowl of porridge with sliced banana"));
  expect(observedState?.entries.some((entry) => entry.photo?.name === "analysis.jpg")).toBe(false);
  fireEvent.change(observation, { target: { value: "Porridge, banana and cinnamon" } });
  fireEvent.click(screen.getByRole("button", { name: "Add to journal" }));

  await waitFor(() => {
    expect(observedState?.entries.find((entry) => entry.photo?.name === "analysis.jpg")?.photo?.derivedObservation)
      .toBe("Porridge, banana and cinnamon");
  });
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

test("keeps recent journal days scannable while earlier history remains available", () => {
  render(
    <DemoStoreProvider initialState={structuredClone(INITIAL_STATE)}>
      <JournalPanel notify={vi.fn()} onOpenCare={vi.fn()} trackingEnabled />
    </DemoStoreProvider>,
  );

  const summaryLabel = screen.getByText("Earlier journal history");
  const archive = summaryLabel.closest("details");
  expect(archive).not.toBeNull();
  expect(archive).not.toHaveAttribute("open");
  expect(within(archive as HTMLElement).getByText(/earlier days · \d+ entries/i)).toBeInTheDocument();

  fireEvent.click(summaryLabel);
  expect(archive).toHaveAttribute("open");
});
