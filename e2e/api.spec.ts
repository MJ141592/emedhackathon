import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  const response = await request.post("/api/demo/reset");
  expect(response.ok(), await response.text()).toBeTruthy();
});

test("the full stack exposes a persisted Matthew aggregate and server-only AI status", async ({ request }) => {
  const health = await request.get("/api/health");
  expect(health.ok()).toBeTruthy();
  await expect(health.json()).resolves.toMatchObject({ status: "healthy" });

  const demo = await request.get("/api/demo");
  expect(demo.ok()).toBeTruthy();
  expect(demo.headers().etag).toMatch(/^"\d+"$/);
  const state = await demo.json();
  expect(state).toMatchObject({
    version: 2,
    phase: "watch",
    profile: { name: "Matthew Johnson" },
    testOrder: { status: "prepared" },
    taper: { currentDay: 12, missedDays: [] },
  });
  expect(state.taper.days.every((day: { taken: boolean }) => !day.taken)).toBe(true);

  const ai = await request.get("/api/ai/status");
  expect(ai.ok()).toBeTruthy();
  const aiStatus = await ai.json();
  expect(typeof aiStatus.configured).toBe("boolean");
  expect(aiStatus.models).toMatchObject({
    chat: expect.any(String),
    image_to_text: expect.any(String),
    speech_to_text: expect.any(String),
    text_to_speech: expect.any(String),
  });
});

test("every patient-facing read model is available through the frontend proxy", async ({ request }) => {
  const paths = [
    "/api/profile",
    "/api/profile/history",
    "/api/contacts",
    "/api/trusted-supporter",
    "/api/journal",
    "/api/chat",
    "/api/lifecycle",
    "/api/dashboard",
    "/api/timeline",
    "/api/trends",
    "/api/evidence",
    "/api/care/test-order",
    "/api/care/team-message",
    "/api/care/prescription",
    "/api/taper",
    "/api/taper/today",
    "/api/taper/missed-dose-guidance",
    "/api/experiment",
    "/api/wearable",
    "/api/privacy",
    "/api/summary",
    "/api/summary/export",
    "/api/export",
    "/api/audit",
    "/api/integrations",
  ];

  for (const path of paths) {
    const response = await request.get(path);
    expect(response.ok(), `${path} returned ${response.status()}: ${await response.text()}`).toBeTruthy();
  }
});

test("snapshot persistence uses ETags and rejects stale writes", async ({ request }) => {
  const initial = await request.get("/api/demo");
  const originalEtag = initial.headers().etag;
  const snapshot = await initial.json();
  snapshot.phase = "stable";

  const saved = await request.put("/api/demo", {
    headers: { "If-Match": originalEtag },
    data: snapshot,
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  expect(saved.headers().etag).not.toBe(originalEtag);

  snapshot.phase = "flare";
  const stale = await request.put("/api/demo", {
    headers: { "If-Match": originalEtag },
    data: snapshot,
  });
  expect(stale.status()).toBe(409);

  const persisted = await request.get("/api/demo");
  await expect(persisted.json()).resolves.toMatchObject({ phase: "stable" });
});

test("red-flag safety is deterministic and independent of the model provider", async ({ request }) => {
  const response = await request.post("/api/safety/evaluate", {
    data: { bleeding: "heavy", faint: true },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  await expect(response.json()).resolves.toMatchObject({
    evaluation: {
      urgent: true,
      level: "emergency",
      source: "deterministic-rules-v1",
      triggers: expect.arrayContaining(["Heavy or continuous bleeding", "Faintness or collapse"]),
    },
  });
});

test("browser changes survive local-storage loss by rehydrating from SQLite", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Good morning, Matthew" })).toBeVisible();

  await page.getByRole("button", { name: "Steady", exact: true }).click();
  await expect(page.getByText("Steady — at your baseline", { exact: true })).toBeVisible();

  await expect
    .poll(async () => {
      const response = await page.request.get("/api/demo");
      return (await response.json()).phase;
    })
    .toBe("stable");

  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(page.getByText("Steady — at your baseline", { exact: true })).toBeVisible();
});

test("remote hydration removes an expired photo payload from SQLite", async ({ page }) => {
  const initial = await page.request.get("/api/demo");
  const snapshot = await initial.json();
  snapshot.entries[0].date = "2020-01-01";
  snapshot.entries[0].photo = {
    name: "expired-meal.jpg",
    previewUrl: "data:image/jpeg;base64,YQ==",
    purpose: "meal",
    retentionDays: 7,
    consented: true,
  };
  const seeded = await page.request.put("/api/demo", {
    headers: { "If-Match": initial.headers().etag },
    data: snapshot,
  });
  expect(seeded.ok(), await seeded.text()).toBeTruthy();

  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Good morning, Matthew" })).toBeVisible();

  await expect
    .poll(async () => {
      const response = await page.request.get("/api/demo");
      return (await response.json()).entries[0].photo;
    })
    .toBeNull();
});
