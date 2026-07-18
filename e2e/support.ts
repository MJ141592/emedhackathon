import { expect, type Page } from "@playwright/test";

export async function openFreshDemo(page: Page): Promise<void> {
  page.on("response", async (response) => {
    if (response.request().method() === "PUT" && response.url().endsWith("/api/demo") && !response.ok()) {
      const snapshot = response.request().postDataJSON() as {
        testOrder?: { status?: string };
        clinicianSummaryEdited?: boolean;
        clinicianSummaryStale?: boolean;
      } | null;
      console.error(
        `Rejected demo sync ${response.status()} `
        + `(test=${snapshot?.testOrder?.status ?? "unknown"}, edited=${String(snapshot?.clinicianSummaryEdited)}, stale=${String(snapshot?.clinicianSummaryStale)}): `
        + await response.text(),
      );
    }
  });
  const resetResponse = await page.request.post("/api/demo/reset");
  if (!resetResponse.ok()) {
    throw new Error(
      `Could not reset the persisted demo (${resetResponse.status()}): ${await resetResponse.text()}`,
    );
  }
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  // React StrictMode performs two development hydration effects. Waiting for the
  // fetches to settle prevents a click racing the active (second) remote hydrate.
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "Good morning, Matthew" })).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

export async function openDrawer(page: Page, buttonName: string, dialogName = buttonName) {
  await page.getByRole("button", { name: buttonName, exact: true }).click();
  const drawer = page.getByRole("dialog", { name: dialogName, exact: true });
  await expect(drawer).toBeVisible();
  return drawer;
}
