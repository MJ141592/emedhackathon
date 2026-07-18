import { expect, test } from "@playwright/test";
import { openFreshDemo } from "./support";

test.beforeEach(async ({ page }) => {
  await openFreshDemo(page);
});

test("the adaptive home screen exposes all four supported phases", async ({ page }) => {
  const phases = [
    ["Steady", "Steady — at your baseline"],
    ["Watchful", "Watchful — symptoms rising"],
    ["Flare", "Flare — extra support active"],
    ["Recovery", "Recovery demo — treatment not active"],
  ] as const;

  for (const [button, summary] of phases) {
    await page.getByRole("button", { name: button, exact: true }).click();
    await expect(page.getByText(summary, { exact: true })).toBeVisible();
  }
  await expect(page.locator(".toast[role=status]")).toHaveCSS("pointer-events", "none");
  await expect.poll(async () => (await (await page.request.get("/api/demo")).json()).phase).toBe("recovery");
});

test("natural-language capture creates a correctable journal record", async ({ page }) => {
  await page.getByRole("button", { name: "Journal" }).click();
  const editButtons = page.getByRole("button", { name: "Edit BOWEL MOVEMENT entry" });
  const originalCount = await editButtons.count();

  await page
    .getByRole("textbox", { name: "Message Penny" })
    .fill("Loose stool with urgency and a small amount of blood this morning");
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(page.getByText(/I logged the bowel movement in your journal/)).toBeVisible();
  await expect(editButtons).toHaveCount(originalCount + 1);
  await editButtons.first().click();

  const editor = page.getByRole("dialog", { name: "Edit journal entry" });
  await expect(editor).toBeVisible();
  await editor
    .getByRole("textbox", { name: "What should the record say?" })
    .fill("Bristol type 6, urgency, trace blood — corrected by Matthew");
  await editor.getByRole("button", { name: "Save correction" }).click();

  await expect(page.getByText("Bristol type 6, urgency, trace blood — corrected by Matthew", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const state = await (await page.request.get("/api/demo")).json();
    return state.entries.find((entry: { body: string }) => entry.body === "Bristol type 6, urgency, trace blood — corrected by Matthew")?.structured;
  }).toMatchObject({ bristol: 6, urgency: true, blood: "trace" });
});

test("urgent help stays visible and red-flag wording bypasses conversational reassurance", async ({ page }) => {
  await page.getByRole("button", { name: "Urgent help", exact: true }).click();
  const urgent = page.getByRole("alertdialog", { name: "Urgent symptoms need urgent care", exact: true });
  await expect(urgent).toBeVisible();
  await expect(urgent.getByText(/111/)).toBeVisible();
  await expect(urgent.getByText(/999/)).toBeVisible();
  await urgent.getByRole("button", { name: "Close urgent help" }).click();

  await page
    .getByRole("textbox", { name: "Message Penny" })
    .fill("I have heavy bleeding and feel faint");
  await page.getByRole("button", { name: "Send message" }).click();

  const screened = page.getByRole("alertdialog", { name: "Urgent symptoms need urgent care", exact: true });
  await expect(screened).toContainText(/Separate rules-based safety screen matched/i);
  await expect(screened).toContainText(/heavy or continuous bleeding/i);
  await expect(screened).toContainText(/faintness/i);
  await expect.poll(async () => ((await (await page.request.get("/api/demo")).json()).safetyAlert?.triggers ?? []).map((trigger: string) => trigger.toLowerCase())).toEqual(
    expect.arrayContaining(["heavy or continuous bleeding", "faintness or collapse"]),
  );
});

test("profile and onboarding remain reachable at a phone viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open feature menu" }).click();

  const profileButton = page.getByRole("button", { name: "Profile", exact: true });
  await expect(profileButton).toBeVisible();
  await profileButton.click();
  await expect(page.getByRole("dialog", { name: "Profile & past medical history" })).toBeVisible();
});

test("modal focus is trapped and returns to a visible opener", async ({ page }) => {
  const careTrigger = page.getByRole("button", { name: "Care", exact: true });
  await careTrigger.click();
  const care = page.getByRole("dialog", { name: "Care", exact: true });
  const closeCare = care.getByRole("button", { name: "Close Care" });
  await expect(closeCare).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  await expect(care.locator(":focus")).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect(closeCare).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(care).toBeHidden();
  await expect(careTrigger).toBeFocused();

  const urgentTrigger = page.getByRole("button", { name: "Urgent help", exact: true });
  await urgentTrigger.click();
  const urgent = page.getByRole("alertdialog", { name: "Urgent symptoms need urgent care", exact: true });
  await expect(urgent.getByRole("button", { name: "Close urgent help" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(urgent).toBeHidden();
  await expect(urgentTrigger).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.getByRole("button", { name: "Open feature menu" });
  await menu.click();
  await expect(page.getByRole("button", { name: "Trends & evidence", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();
  await menu.click();
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  const profile = page.getByRole("dialog", { name: "Profile & past medical history" });
  await expect(profile.getByRole("button", { name: "Close Profile & past medical history" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(profile).toBeHidden();
  await expect(menu).toBeFocused();
});
