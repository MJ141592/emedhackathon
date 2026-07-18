import { expect, test, type Page } from "@playwright/test";
import { openDrawer, openFreshDemo } from "./support";

test.beforeEach(async ({ page }) => {
  await openFreshDemo(page);
});

async function advanceCalprotectinToResult(page: Page) {
  let trends = await openDrawer(page, "Trends & evidence");
  await trends.getByRole("button", { name: "Confirm Watchful support mode" }).click();
  await trends.getByRole("button", { name: "Close Trends & evidence" }).click();

  const care = await openDrawer(page, "Care");
  await care.getByRole("button", { name: "Review test order" }).click();
  const order = page.getByRole("alertdialog", { name: "Place this home-test order?" });
  await order.getByRole("checkbox", { name: /confirm this delivery address/i }).check();
  await order.getByRole("checkbox", { name: /consent to this order/i }).check();
  await order.getByRole("button", { name: "Confirm and order kit" }).click();
  for (const name of [
    "Simulate kit shipped",
    "Simulate kit delivered",
    "I collected the sample",
    "I posted the sample",
    "Simulate lab receipt",
    "Simulate result available",
  ]) await care.getByRole("button", { name }).click();
  await expect(care.getByText("result", { exact: true })).toBeVisible();
  await care.getByRole("button", { name: "Close Care" }).click();

  trends = await openDrawer(page, "Trends & evidence");
  await trends.getByRole("button", { name: "Confirm Flare support mode" }).click();
  await trends.getByRole("button", { name: "Close Trends & evidence" }).click();
}

test("a patient confirms a calprotectin order before fulfilment can advance", async ({ page }) => {
  let care = await openDrawer(page, "Care");
  await care.getByRole("button", { name: "Confirm governed Watchful evidence" }).click();
  await expect(page.getByRole("status")).toContainText(/confirm the governed Watchful observations/i);
  await care.getByRole("button", { name: "Close Care" }).click();

  const trends = await openDrawer(page, "Trends & evidence");
  await trends.getByRole("button", { name: "Confirm Watchful support mode" }).click();
  await trends.getByRole("button", { name: "Close Trends & evidence" }).click();

  care = await openDrawer(page, "Care");
  await care.getByRole("button", { name: "Review test order" }).click();

  const confirmation = page.getByRole("alertdialog", { name: "Place this home-test order?" });
  await confirmation.getByRole("checkbox", { name: /confirm this delivery address/i }).check();
  await confirmation.getByRole("checkbox", { name: /consent to this order/i }).check();
  await confirmation.getByRole("button", { name: "Confirm and order kit" }).click();

  await expect(care.getByText("ordered", { exact: true })).toBeVisible();
  await care.getByRole("button", { name: "Simulate kit shipped" }).click();
  await expect(care.getByText("shipped", { exact: true })).toBeVisible();

  await care.getByRole("button", { name: "Simulate kit delivered" }).click();
  await care.getByRole("button", { name: "I collected the sample" }).click();
  await care.getByRole("button", { name: "I posted the sample" }).click();
  await care.getByRole("button", { name: "Simulate lab receipt" }).click();
  await care.getByRole("button", { name: "Simulate result available" }).click();
  await expect(care.getByText("result", { exact: true })).toBeVisible();
  await care.getByRole("button", { name: "Review result sharing" }).click();
  const sharing = page.getByRole("alertdialog", { name: "Share this result with your IBD team?" });
  await expect(care.getByText("result", { exact: true })).toBeVisible();
  await sharing.getByRole("button", { name: "Confirm result sharing" }).click();
  await expect(care.getByText("Loop complete", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const persisted = await (await page.request.get("/api/demo")).json();
    return {
      status: persisted.testOrder.status,
      resultInSummary: persisted.clinicianSummary.includes("Faecal calprotectin: 420 µg/g"),
    };
  }).toEqual({ status: "shared", resultInSummary: true });
});

test("the clinician message remains editable and requires explicit approval", async ({ page }) => {
  const care = await openDrawer(page, "Care");
  const draft = care.getByRole("textbox", { name: "Patient-approved message" });
  await draft.fill(`${await draft.inputValue()}\n\nPatient note: please call after 15:00.`);
  await care.getByRole("button", { name: "Review team message" }).click();

  const confirmation = page.getByRole("alertdialog", { name: "Send this message to your IBD team?" });
  await expect(confirmation).toContainText("please call after 15:00");
  await confirmation.getByRole("checkbox", { name: /I reviewed the message/i }).check();
  await confirmation.getByRole("button", { name: "Approve and send" }).click();

  await expect(care.getByText("sent", { exact: true })).toBeVisible();
  await expect(care.getByRole("button", { name: "Simulate team read" })).toBeVisible();
  await expect.poll(async () => (await (await page.request.get("/api/demo")).json()).teamMessage.status).toBe("sent");
});

test("the rescue pathway stays unavailable until Flare and remains prescriber-owned", async ({ page }) => {
  let care = await openDrawer(page, "Care");
  await expect(care.getByText(/available only in Flare support/i)).toBeVisible();
  await expect(care.getByRole("button", { name: "Prepare prescriber request" })).toHaveCount(0);
  await care.getByRole("button", { name: "Close Care" }).click();

  // The presentation-only phase switch cannot authorise care. Build objective
  // evidence, then explicitly confirm the governed support-mode proposal.
  await advanceCalprotectinToResult(page);
  care = await openDrawer(page, "Care");
  await care.getByRole("button", { name: "Prepare prescriber request" }).click();
  const request = page.getByRole("alertdialog", { name: "Ask the prescriber to review the rescue plan?" });
  await expect(request).toContainText(/does not issue medicine/i);
  await request.getByRole("button", { name: "Send request for prescriber review" }).click();
  await care.getByRole("button", { name: "Simulate clinician approval" }).click();
  await expect(care.locator(".status", { hasText: /^approved$/ })).toBeVisible();
  await care.getByRole("button", { name: "Mark ready at named pharmacy" }).click();
  await expect(care.getByText(/clinician-approved prescription is ready/i)).toBeVisible();
  await care.getByRole("button", { name: "I collected it" }).click();
  await expect(care.locator(".status", { hasText: /^collected$/ })).toBeVisible();
  await expect.poll(async () => (await (await page.request.get("/api/demo")).json()).prescription.status).toBe("collected");
});

test("collected clinician-issued treatment unlocks the re-verified anchored dose", async ({ page }) => {
  await advanceCalprotectinToResult(page);
  const care = await openDrawer(page, "Care");
  await care.getByRole("button", { name: "Prepare prescriber request" }).click();
  await page.getByRole("alertdialog", { name: "Ask the prescriber to review the rescue plan?" }).getByRole("button", { name: "Send request for prescriber review" }).click();
  await care.getByRole("button", { name: "Simulate clinician approval" }).click();
  await care.getByRole("button", { name: "Mark ready at named pharmacy" }).click();
  await care.getByRole("button", { name: "I collected it" }).click();
  await care.getByRole("button", { name: "I verified this schedule against the label" }).click();

  await care.getByRole("button", { name: "Mark today’s dose as taken" }).click();
  const confirmation = page.getByRole("alertdialog", { name: /Confirm 30 mg was taken/ });
  await expect(confirmation).toContainText(/does not change today’s or any future dose/i);
  await confirmation.getByRole("button", { name: "Mark today’s dose as taken" }).click();

  await expect(care.getByText("Taken", { exact: true })).toBeVisible();
  await expect(care.getByText(/Next prescribed change:.*25 mg/s)).toBeVisible();
  await expect.poll(async () => {
    const state = await (await page.request.get("/api/demo")).json();
    return {
      currentDay: state.taper.currentDay,
      taken: state.taper.days.find((day: { day: number }) => day.day === 1)?.taken,
    };
  }).toEqual({ currentDay: 1, taken: true });
});

test("diet experiments run from stable start through daily check-in and reviewed completion", async ({ page }) => {
  await page.request.delete("/api/data");
  await page.request.post("/api/contacts", { data: { id: "team", initials: "IB", name: "Example IBD advice line", role: "IBD team", organisation: "Example Hospital", phone: "020 7000 0000" } });
  await page.request.patch("/api/profile", { data: {
    name: "Sam Rivera", dateOfBirth: "1990-04-12", diagnosis: "Crohn’s disease",
    usualBowel: "1–2 formed bowel movements/day", usualPain: "0–1/10",
    usualHeartRate: "62 bpm resting", usualSleep: "7.5 hours",
    carePlan: "Contact the IBD advice line if symptoms change.",
    address: "10 Example Road, London", postcode: "W1 1AA",
    adultEligibilityConfirmed: true, healthDataConsent: true,
    onboardingComplete: true,
  } });
  await page.reload();
  const trends = await openDrawer(page, "Trends & evidence");
  await trends.getByRole("button", { name: "Confirm Stable baseline" }).click();
  await trends.getByRole("button", { name: "Close Trends & evidence" }).click();

  const experiments = await openDrawer(page, "Experiments");
  await experiments.getByRole("button", { name: /Edit candidate|Create a new candidate/ }).click();
  await experiments.getByLabel("Candidate name").fill("Consistent morning hydration");
  await experiments.getByLabel("One main variable").fill("One glass of water with breakfast");
  await experiments.getByLabel("Your goal").fill("Observe morning wellbeing");
  await experiments.getByLabel("Pre-start baseline").fill("Morning wellbeing was the same as usual before day 1");
  await experiments.getByLabel("Outcome to track").fill("Morning wellbeing");
  await experiments.getByLabel("Planned duration (days)").fill("1");
  await experiments.getByRole("button", { name: "Save candidate" }).click();

  await experiments.getByRole("button", { name: "Start experiment" }).click();
  const confirmation = page.getByRole("alertdialog", { name: "Start this one-variable experiment?" });
  await confirmation.getByRole("button", { name: "Start experiment" }).click();
  await expect(experiments.getByText("active", { exact: true })).toBeVisible();

  await experiments.getByRole("button", { name: "Pause experiment" }).click();
  await expect(experiments.getByText("paused", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const state = await (await page.request.get("/api/demo")).json();
    return {
      pauseAudited: state.audit.some((event: { action: string }) => event.action.includes("updated: paused")),
      pauseIsNotClinicalEvidence: state.experiment.observations.some((item: string) => /paused by/i.test(item)),
    };
  }).toEqual({ pauseAudited: true, pauseIsNotClinicalEvidence: false });

  await experiments.getByRole("button", { name: "Resume experiment" }).click();
  await page.getByRole("alertdialog", { name: "Start this one-variable experiment?" }).getByRole("button", { name: "Start experiment" }).click();
  await experiments.getByRole("textbox", { name: /Today’s neutral observation/ }).fill("Morning wellbeing was unchanged today.");
  await experiments.getByRole("button", { name: "Save day 1 check-in" }).click();
  await expect(experiments.getByRole("progressbar", { name: "Experiment progress" })).toHaveAttribute("aria-valuenow", "1");

  await experiments.getByRole("textbox", { name: "Review the outcome before completing" }).fill("I did not notice a clear difference in morning wellbeing.");
  await experiments.getByRole("button", { name: "Review and complete experiment" }).click();
  await page.getByRole("alertdialog", { name: "Complete and save this personal review?" }).getByRole("button", { name: "Complete experiment" }).click();
  await expect(experiments.getByText("complete", { exact: true })).toBeVisible();

  await experiments.getByRole("button", { name: "Close Experiments" }).click();
  await expect(page.getByText(/Diet experiment check-in — day 1 of 1: Morning wellbeing was unchanged today/)).toBeVisible();
  await expect(page.getByText(/Diet experiment completed: Consistent morning hydration/)).toBeVisible();
  await expect.poll(async () => {
    const state = await (await page.request.get("/api/demo")).json();
    return {
      status: state.experiment.status,
      day: state.experiment.day,
      hasReview: state.clinicianSummary.includes("I did not notice a clear difference in morning wellbeing"),
    };
  }).toEqual({ status: "complete", day: 1, hasReview: true });
});
