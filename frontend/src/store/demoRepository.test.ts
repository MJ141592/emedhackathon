import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { INITIAL_STATE } from "../data";
import { applyPhotoRetention, configureDemoSyncAdapter, demoRepository, emptyDemoState } from "./demoRepository";
import { browserTimeZone, isValidTimeZone } from "./patientTime";

describe("demo repository privacy behavior", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => configureDemoSyncAdapter(null));

  test("delete-all state contains no seeded sensitive records", () => {
    const empty = emptyDemoState();
    expect(empty.entries).toEqual([]);
    expect(empty.messages).toEqual([]);
    expect(empty.contacts).toEqual([]);
    expect(empty.taper.days).toEqual([]);
    expect(empty.experiment.observations).toEqual([]);
    expect(empty.teamMessage).toMatchObject({ id: "No message", subject: "No clinician message", body: "No draft has been prepared." });
    expect(empty.teamMessageHistory).toEqual([]);
    expect(empty.clinicianSummaryEdited).toBe(false);
    expect(empty.clinicianSummaryStale).toBe(false);
    expect(empty.prescription).toMatchObject({ medicine: "", prescriber: "", pharmacy: "", rescuePlanEligible: false });
    expect(empty.privacy.assistantProfileAccess).toBe(false);
    expect(empty.profile.immunosuppressed).toBe(false);
    expect(empty.profile.timeZone).toBe(browserTimeZone());
    expect(isValidTimeZone(empty.profile.timeZone)).toBe(true);
  });

  test("purges and ignores a legacy plaintext browser aggregate", () => {
    const state = structuredClone(INITIAL_STATE);
    state.profile.name = "Sensitive legacy name";
    localStorage.setItem("memed.persisted-demo.v2", JSON.stringify(state));

    const loaded = demoRepository.load();
    expect(loaded.profile.name).toBe(INITIAL_STATE.profile.name);
    expect(localStorage.getItem("memed.persisted-demo.v2")).toBeNull();
    demoRepository.save(state);
    expect(localStorage.getItem("memed.persisted-demo.v2")).toBeNull();
  });

  test("expired server-backed photos are removed during hydration without a browser copy", async () => {
    const remote = structuredClone(INITIAL_STATE);
    remote.entries[0].date = "2020-01-01";
    remote.entries[0].photo = { name: "expired.jpg", previewUrl: "data:image/jpeg;base64,secret", purpose: "meal", retentionDays: 7, consented: true };
    const sync = vi.fn();
    configureDemoSyncAdapter({ hydrate: async () => remote, sync });

    const hydrated = await demoRepository.hydrateRemote(INITIAL_STATE);

    expect(hydrated?.entries[0].photo).toBeUndefined();
    expect(hydrated?.audit[0].action).toMatch(/expired photo/);
    expect(localStorage.getItem("memed.persisted-demo.v2")).toBeNull();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0][0].entries[0].photo).toBeUndefined();
  });

  test("live-session cleanup removes a newly expired payload without reloading", () => {
    const state = structuredClone(INITIAL_STATE);
    state.entries[0].date = "2026-07-01";
    state.entries[0].photo = { name: "live.jpg", previewUrl: "data:image/jpeg;base64,secret", purpose: "meal", retentionDays: 7, consented: true };

    const retained = applyPhotoRetention(state, new Date("2026-07-07T12:00:00.000Z").getTime());
    expect(retained.entries[0].photo).toBeDefined();
    const expired = applyPhotoRetention(retained, new Date("2026-07-09T00:00:00.000Z").getTime());
    expect(expired.entries[0].photo).toBeUndefined();
    expect(expired.audit[0].action).toMatch(/expired photo/);
  });

  test("expires photos on the patient’s calendar even across UTC midnight and DST", () => {
    const state = structuredClone(INITIAL_STATE);
    state.profile.timeZone = "America/Los_Angeles";
    state.entries[0].date = "2026-03-01";
    state.entries[0].photo = { name: "calendar.jpg", previewUrl: "data:image/jpeg;base64,secret", purpose: "meal", retentionDays: 7, consented: true };

    expect(applyPhotoRetention(state, new Date("2026-03-08T07:30:00Z")).entries[0].photo).toBeDefined();
    expect(applyPhotoRetention(state, new Date("2026-03-08T08:30:00Z")).entries[0].photo).toBeUndefined();
  });

  test("failed remote deletion stays tombstoned and retries before any hydration", async () => {
    const failedDelete = vi.fn().mockRejectedValue(new Error("offline"));
    configureDemoSyncAdapter({
      hydrate: vi.fn(async () => structuredClone(INITIAL_STATE)),
      sync: vi.fn(),
      deleteAll: failedDelete,
    });
    demoRepository.beginDeletion();

    expect(await demoRepository.deleteAllRemote()).toBe(false);
    expect(demoRepository.load().profile.name).toBe("");

    const order: string[] = [];
    const cleared = emptyDemoState();
    cleared.profile.timeZone = "UTC";
    configureDemoSyncAdapter({
      deleteAll: async () => { order.push("delete"); },
      hydrate: async () => { order.push("hydrate"); return cleared; },
      sync: vi.fn(),
    });
    const hydrated = await demoRepository.hydrateRemote(INITIAL_STATE);

    expect(order).toEqual(["delete", "hydrate"]);
    expect(hydrated?.profile.name).toBe("");
    expect(hydrated?.profile.timeZone).toBe(browserTimeZone());
    expect(demoRepository.load().profile.name).toBe("");
  });

  test("reports sync rejection instead of silently claiming persistence", async () => {
    configureDemoSyncAdapter({
      hydrate: vi.fn(async () => null),
      sync: vi.fn(async () => { throw new Error("409 governed workflow rejection"); }),
    });

    const result = await demoRepository.syncRemote(INITIAL_STATE);

    expect(result).toEqual({ ok: false, error: "409 governed workflow rejection" });
  });

  test("returns the server-accepted aggregate so governed clocks replace browser clocks", async () => {
    const accepted = structuredClone(INITIAL_STATE);
    accepted.teamMessage.sentAt = "2026-07-18T09:30:00.000Z";
    accepted.teamMessage.statusUpdatedAt = accepted.teamMessage.sentAt;
    configureDemoSyncAdapter({
      hydrate: vi.fn(async () => accepted),
      sync: vi.fn(async () => accepted),
    });

    const result = await demoRepository.syncRemote(INITIAL_STATE);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state?.teamMessage.sentAt).toBe(accepted.teamMessage.sentAt);
  });

  test("fails closed when initial remote hydration fails and clears notification remnants", async () => {
    const sync = vi.fn();
    configureDemoSyncAdapter({
      hydrate: vi.fn(async () => { throw new Error("temporary read failure"); }),
      sync,
    });
    await expect(demoRepository.hydrateRemote(INITIAL_STATE)).rejects.toThrow(/temporary read failure/);
    expect(sync).not.toHaveBeenCalled();

    localStorage.setItem("memed.notification.2026-07-17:taper:sensitive", "shown");
    demoRepository.beginDeletion();
    expect(localStorage.getItem("memed.notification.2026-07-17:taper:sensitive")).toBeNull();
    expect(localStorage.getItem("memed.delete-pending.v2")).toBe("1");
  });

  test("bounds opaque page-notification markers to the current patient day", () => {
    localStorage.setItem("memed.notification.2026-07-16:daily-check-in:3", "shown");
    localStorage.setItem("memed.notification.2026-07-17:daily-check-in:1", "shown");
    localStorage.setItem("memed.notification.2026-07-17:daily-check-in:2", "shown");
    localStorage.setItem("unrelated.preference", "keep");

    demoRepository.pruneNotificationMarkers("2026-07-17");

    expect(localStorage.getItem("memed.notification.2026-07-16:daily-check-in:3")).toBeNull();
    expect(localStorage.getItem("memed.notification.2026-07-17:daily-check-in:1")).toBe("shown");
    expect(localStorage.getItem("memed.notification.2026-07-17:daily-check-in:2")).toBe("shown");
    expect(localStorage.getItem("unrelated.preference")).toBe("keep");
  });
});
