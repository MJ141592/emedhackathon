import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { openDrawer, openFreshDemo } from "./support";

test.beforeEach(async ({ page }) => {
  await openFreshDemo(page);
});

test("a patient can export readable data and delete conversation history separately", async ({ page }) => {
  const privacy = await openDrawer(page, "Privacy", "Privacy & settings");

  const downloadPromise = page.waitForEvent("download");
  await privacy.getByRole("button", { name: "Export my data" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^gutsy-export-\d{4}-\d{2}-\d{2}\.json$/);
  const path = await download.path();
  expect(path).not.toBeNull();
  const exported = JSON.parse(await readFile(path!, "utf8")) as {
    product: string;
    data: { version: number; profile: { name: string }; entries: unknown[] };
  };
  expect(exported.product).toBe("Gutsy demo");
  expect(exported.data.version).toBe(2);
  expect(exported.data.profile.name).toBe("Matthew Johnson");
  expect(exported.data.entries.length).toBeGreaterThan(0);

  await privacy.getByRole("button", { name: "Delete conversation" }).click();
  const confirmation = page.getByRole("alertdialog", { name: "Delete your Penny conversation?" });
  await confirmation.getByRole("button", { name: "Delete conversation" }).click();
  await privacy.getByRole("button", { name: "Close Privacy" }).click();

  await expect(page.getByText("Your conversation is private and empty.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Journal" }).click();
  await expect(page.getByRole("heading", { name: "Journal" })).toBeVisible();
  await expect.poll(async () => (await (await page.request.get("/api/demo")).json()).messages).toEqual([]);
});

test("deleting all local health data returns the patient to onboarding", async ({ page }) => {
  const privacy = await openDrawer(page, "Privacy", "Privacy & settings");
  await privacy.getByRole("button", { name: "Delete all demo data" }).click();

  const confirmation = page.getByRole("alertdialog", { name: "Delete all demo health data?" });
  await confirmation.getByRole("textbox", { name: /Type DELETE to continue/ }).fill("DELETE");
  await confirmation.getByRole("button", { name: "Delete all demo data" }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(page.getByText(/All session and API demo data deleted/i)).toBeVisible();

  await page.getByRole("button", { name: "Profile", exact: true }).click();
  const profile = page.getByRole("dialog", { name: "Profile & past medical history" });
  await expect(profile).toBeVisible();
  await profile.getByRole("textbox", { name: "Full name" }).fill("Alex Morgan");
  await profile.getByLabel("Date of birth").fill("1990-05-20");
  await profile.getByRole("textbox", { name: "Diagnosis", exact: true }).fill("Crohn’s disease");
  await profile.getByRole("textbox", { name: "Usual bowel pattern" }).fill("2 formed bowel movements/day");
  await profile.getByRole("textbox", { name: "Usual pain" }).fill("1/10");
  await profile.getByRole("textbox", { name: "Personal care plan" }).fill("Call my IBD team if symptoms rise for three days.");
  await profile.getByRole("textbox", { name: "Home address" }).fill("10 Example Road, London");
  await profile.getByRole("textbox", { name: "Postcode" }).fill("W1 1AA");
  await profile.getByRole("button", { name: "Add care contact" }).click();
  const contact = profile.getByRole("group", { name: "Care contact" });
  await contact.getByRole("textbox", { name: "Name" }).fill("IBD Advice Line");
  await contact.getByRole("textbox", { name: "Organisation / pharmacy" }).fill("Example Hospital");
  await contact.getByRole("textbox", { name: "Phone" }).fill("020 7000 0000");
  await contact.getByRole("textbox", { name: "Role" }).fill("IBD nurse");
  await profile.getByRole("checkbox", { name: /I confirm I am 18 or older/ }).check();
  await profile.getByRole("checkbox", { name: /I consent to holding sensitive health information/ }).check();
  await profile.getByRole("button", { name: "Complete onboarding" }).click();

  await expect(profile.getByText("Baseline active", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const persisted = await (await page.request.get("/api/demo")).json();
    return {
      name: persisted.profile.name,
      onboardingComplete: persisted.profile.onboardingComplete,
      summaryUsesProfile: persisted.clinicianSummary.startsWith("Alex Morgan’s editable Gutsy summary"),
    };
  }).toEqual({ name: "Alex Morgan", onboardingComplete: true, summaryUsesProfile: true });
});

test("withdrawing toilet-photo consent removes the image but preserves the health record", async ({ page }) => {
  const initial = await page.request.get("/api/demo");
  const snapshot = await initial.json();
  const entryId = snapshot.entries[0].id;
  const originalBody = snapshot.entries[0].body;
  snapshot.privacy.toiletPhotoConsent = true;
  snapshot.entries[0].photo = {
    name: "toilet-photo.jpg",
    previewUrl: "data:image/jpeg;base64,YQ==",
    purpose: "toilet",
    retentionDays: 7,
    consented: true,
    derivedObservation: "Unconfirmed image observation",
  };
  const seeded = await page.request.put("/api/demo", {
    headers: { "If-Match": initial.headers().etag },
    data: snapshot,
  });
  expect(seeded.ok(), await seeded.text()).toBeTruthy();

  await page.reload();
  const privacy = await openDrawer(page, "Privacy", "Privacy & settings");
  await privacy.getByRole("checkbox", { name: /Optional toilet-photo consent/i }).click();

  await expect.poll(async () => {
    const persisted = await (await page.request.get("/api/demo")).json();
    const entry = persisted.entries.find((item: { id: number }) => item.id === entryId);
    return {
      body: entry?.body,
      photo: entry?.photo,
      removed: entry?.structured?.mediaRemovedAfterConsentWithdrawal,
    };
  }).toEqual({ body: originalBody, photo: null, removed: true });
});
