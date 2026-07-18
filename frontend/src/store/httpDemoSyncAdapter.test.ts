import { describe, expect, test, vi } from "vitest";
import { INITIAL_STATE } from "../data";
import { createHttpDemoSyncAdapter } from "./httpDemoSyncAdapter";

function jsonResponse(body: unknown, status = 200, etag?: string): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (etag) headers.set("ETag", etag);
  return new Response(JSON.stringify(body), { status, headers });
}

describe("HTTP demo sync adapter", () => {
  test("hydrates and carries the server ETag into the next snapshot write", async () => {
    const savedResponse = jsonResponse(INITIAL_STATE, 200, '"8"');
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(INITIAL_STATE, 200, '"7"'))
      .mockResolvedValueOnce(savedResponse);
    const adapter = createHttpDemoSyncAdapter(fetcher);

    await adapter.hydrate(INITIAL_STATE);
    const accepted = await adapter.sync({ ...INITIAL_STATE, phase: "stable" });

    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/demo", {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "/api/demo",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({ "If-Match": '"7"' }),
      }),
    );
    expect(accepted).toEqual(INITIAL_STATE);
    expect(savedResponse.bodyUsed).toBe(true);
  });

  test("surfaces an optimistic conflict without overwriting the newer snapshot", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(INITIAL_STATE, 200, '"2"'))
      .mockResolvedValueOnce(jsonResponse({ detail: "conflict" }, 409));
    const adapter = createHttpDemoSyncAdapter(fetcher);

    await adapter.hydrate(INITIAL_STATE);
    await expect(adapter.sync({ ...INITIAL_STATE, phase: "flare" })).rejects.toThrow(
      /Saving the persisted demo failed \(409\)/,
    );

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({ "If-Match": '"2"' });
  });

  test("queues reset before a following snapshot write", async () => {
    const callOrder: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      callOrder.push(`${method} ${path}`);
      if (path.endsWith("/reset")) return jsonResponse(INITIAL_STATE, 200, '"10"');
      return jsonResponse(INITIAL_STATE, 200, '"11"');
    });
    const adapter = createHttpDemoSyncAdapter(fetcher);

    const reset = adapter.reset!();
    const sync = adapter.sync({ ...INITIAL_STATE, phase: "recovery" });
    await Promise.all([reset, sync]);

    expect(callOrder).toEqual(["POST /api/demo/reset", "PUT /api/demo"]);
    expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({ "If-Match": '"10"' });
  });

  test("waits for the narrow journal write and refreshes the accepted aggregate", async () => {
    const entry = {
      id: 901,
      kind: "WELLBEING" as const,
      body: "Feeling better than usual",
      date: "Today, 09:30",
      createdAt: "2026-07-18T08:30:00.000Z",
      source: "manual" as const,
      flagged: false,
    };
    const accepted = { ...INITIAL_STATE, entries: [entry, ...INITIAL_STATE.entries] };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(entry))
      .mockResolvedValueOnce(jsonResponse(accepted, 200, '"12"'));
    const adapter = createHttpDemoSyncAdapter(fetcher);

    const result = await adapter.addJournal!({
      kind: "WELLBEING",
      body: "Feeling better than usual",
      source: "manual",
      flagged: false,
    });

    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/journal", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        kind: "WELLBEING",
        body: "Feeling better than usual",
        source: "manual",
        flagged: false,
      }),
    }));
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/demo", {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    expect(result).toEqual({ state: accepted, entry });
  });

  test("serializes an explicit photo removal as null with unload-safe keepalive", async () => {
    const accepted = structuredClone(INITIAL_STATE);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 1 }))
      .mockResolvedValueOnce(jsonResponse(accepted, 200, '"13"'));
    const adapter = createHttpDemoSyncAdapter(fetcher);

    await adapter.updateJournal!(1, { photo: undefined });

    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/journal/1", expect.objectContaining({
      method: "PATCH",
      keepalive: true,
      body: JSON.stringify({ photo: null }),
    }));
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/demo", expect.objectContaining({ cache: "no-store" }));
  });

  test("does not use keepalive for a journal patch carrying a large image payload", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 1 }))
      .mockResolvedValueOnce(jsonResponse(INITIAL_STATE, 200, '"14"'));
    const adapter = createHttpDemoSyncAdapter(fetcher);

    await adapter.updateJournal!(1, {
      photo: {
        name: "large.jpg",
        previewUrl: `data:image/jpeg;base64,${"A".repeat(70_000)}`,
        purpose: "meal",
        retentionDays: 30,
        consented: true,
      },
    });

    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "PATCH", keepalive: false });
  });

  test("returns the authoritative aggregate after an unload-safe consent withdrawal", async () => {
    const accepted = structuredClone(INITIAL_STATE);
    accepted.profile.healthDataConsent = false;
    accepted.profile.onboardingComplete = false;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(accepted.profile))
      .mockResolvedValueOnce(jsonResponse(accepted, 200, '"15"'));
    const adapter = createHttpDemoSyncAdapter(fetcher);

    const result = await adapter.withdrawHealthConsent!({
      healthDataConsent: false,
      onboardingComplete: false,
    });

    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/profile", expect.objectContaining({
      method: "PATCH",
      keepalive: true,
      body: JSON.stringify({ healthDataConsent: false, onboardingComplete: false }),
    }));
    expect(result).toEqual(accepted);
  });

  test("uses narrow unload-safe writes for privacy changes and journal deletion", async () => {
    const privacyAccepted = structuredClone(INITIAL_STATE);
    privacyAccepted.privacy.toiletPhotoConsent = false;
    const deletedAccepted = { ...privacyAccepted, entries: privacyAccepted.entries.slice(1) };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(privacyAccepted.privacy))
      .mockResolvedValueOnce(jsonResponse(privacyAccepted, 200, '"16"'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse(deletedAccepted, 200, '"17"'));
    const adapter = createHttpDemoSyncAdapter(fetcher);

    expect(await adapter.updatePrivacy!({ toiletPhotoConsent: false })).toEqual(privacyAccepted);
    expect(await adapter.deleteJournal!(privacyAccepted.entries[0].id)).toEqual(deletedAccepted);

    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/privacy", expect.objectContaining({ method: "PATCH", keepalive: true }));
    expect(fetcher).toHaveBeenNthCalledWith(3, `/api/journal/${privacyAccepted.entries[0].id}`, expect.objectContaining({ method: "DELETE", keepalive: true }));
  });
});
