import { describe, expect, test } from "vitest";
import { freshDemoState } from "./demoRepository";
import {
  experimentCheckInDates,
  experimentRequiresReview,
  experimentReviewDefinition,
  experimentReviewThread,
  hasExperimentCheckInOnDate,
  isRecordedExperimentBaseline,
  rankLowBurdenExperiments,
  suggestLowBurdenExperiment,
} from "./experimentSafety";

describe("experiment calendar and review governance", () => {
  test("counts distinct included shared-timeline dates, not raw notes", () => {
    const state = freshDemoState();
    expect(experimentCheckInDates(state)).toHaveLength(9);
    state.entries.unshift({
      id: 9991,
      date: "2026-07-16",
      time: "22:00",
      kind: "LIFE EVENT",
      body: "Duplicate same-day experiment note",
      source: "manual",
      structured: { experimentEvent: "check-in", experimentId: state.experiment.id, day: 10 },
    });
    state.entries.unshift({
      id: 9992,
      date: "2026-07-17",
      time: "08:00",
      kind: "LIFE EVENT",
      body: "Excluded check-in",
      source: "manual",
      excluded: true,
      structured: { experimentEvent: "check-in", experimentId: state.experiment.id, day: 10 },
    });
    expect(experimentCheckInDates(state)).toHaveLength(9);
    expect(hasExperimentCheckInOnDate(state, "2026-07-17")).toBe(false);
  });

  test("accepts only the linked replied thread whose wording explicitly supports proceeding", () => {
    const state = freshDemoState();
    state.experiment.reviewRequired = true;
    state.experiment.reviewRequestMessageId = state.teamMessage.id;
    state.teamMessage.body = `Dietitian review request for this exact experiment candidate. ${experimentReviewDefinition(state.experiment)}`;
    state.teamMessage.status = "replied";
    state.teamMessage.reply = "Please call if bleeding changes.";
    expect(experimentReviewThread(state)).toBeUndefined();

    state.teamMessage.reply = "Reviewed, but this is not approved and you should not proceed.";
    expect(experimentReviewThread(state)).toBeUndefined();

    state.teamMessage.reply = "Reviewed and approved: this unchanged candidate may proceed.";
    expect(experimentReviewThread(state)?.id).toBe(state.teamMessage.id);

    state.teamMessage.reply = "Approved, but this plan is dangerous and contraindicated.";
    expect(experimentReviewThread(state)).toBeUndefined();
  });

  test("does not read meal or profile context that Penny is not permitted to use", () => {
    const state = freshDemoState();
    const lockedRanking = rankLowBurdenExperiments(state, { profile: false, journal: false });
    state.profile.dietaryNeeds = "Dairy-free";
    state.entries.unshift({ id: 9993, date: "2026-07-17", time: "09:00", kind: "MEAL", body: "Cow's milk", source: "manual" });

    expect(suggestLowBurdenExperiment(state, { profile: false, journal: false }).title).toBe("Consistent morning hydration");
    expect(suggestLowBurdenExperiment(state, { profile: true, journal: false }).title).toBe("Oat milk instead of dairy milk");
    expect(suggestLowBurdenExperiment(state, { profile: false, journal: true }).title).toBe("Oat milk instead of dairy milk");
    expect(rankLowBurdenExperiments(state, { profile: false, journal: false })).toEqual(lockedRanking);
  });

  test("returns competing choices ranked by permitted context, safety, effort and measurability", () => {
    const state = freshDemoState();
    state.profile.dietaryNeeds = "Prefers oat milk at breakfast";
    const ranked = rankLowBurdenExperiments(state, { profile: true, journal: false });

    expect(ranked.length).toBeGreaterThanOrEqual(3);
    expect(ranked[0].experiment.title).toBe("Oat milk instead of dairy milk");
    expect(ranked.every((candidate) => candidate.experiment.baseline === "")).toBe(true);
    expect(ranked.every((candidate) => Object.values(candidate.scores).every((score) => score >= 1 && score <= 5))).toBe(true);
    expect(ranked.map((candidate) => candidate.rankScore)).toEqual(
      [...ranked.map((candidate) => candidate.rankScore)].sort((left, right) => right - left),
    );
    expect(ranked[0].rationale.join(" ")).toMatch(/permitted patient goal|allowed to use/i);
  });

  test("uses a permitted patient goal to lift the most relevant low-burden option", () => {
    const state = freshDemoState();
    state.profile.dietaryNeeds = "";
    state.experiment.goal = "See whether earlier evening meals improve sleep";

    expect(rankLowBurdenExperiments(state, { profile: true, journal: false })[0].experiment.title)
      .toBe("Consistent evening meal timing");
    expect(rankLowBurdenExperiments(state, { profile: false, journal: false })[0].experiment.title)
      .toBe("Consistent morning hydration");
  });

  test("holds generated candidates for review when permitted PMH context shows nutritional vulnerability", () => {
    const state = freshDemoState();
    state.profile.conditions = "Short bowel syndrome with prior malnutrition";

    const hidden = rankLowBurdenExperiments(state, { profile: false, journal: false });
    expect(hidden.every((candidate) => candidate.risk === "Low")).toBe(true);

    const permitted = rankLowBurdenExperiments(state, { profile: true, journal: false });
    expect(permitted.every((candidate) => candidate.risk === "Clinical review")).toBe(true);
    expect(permitted.every((candidate) => candidate.experiment.reviewRequired)).toBe(true);
  });

  test("never treats a generated recording instruction as an actual pre-start baseline", () => {
    expect(isRecordedExperimentBaseline("")).toBe(false);
    expect(isRecordedExperimentBaseline("Record the morning urgency score immediately before day 1")).toBe(false);
    expect(isRecordedExperimentBaseline("To measure wellbeing before starting")).toBe(false);
    expect(isRecordedExperimentBaseline("I will record morning urgency before day 1")).toBe(false);
    expect(isRecordedExperimentBaseline("Not recorded yet")).toBe(false);
    expect(isRecordedExperimentBaseline("Morning urgency was 3/10 before day 1")).toBe(true);
    expect(isRecordedExperimentBaseline("Daily wellbeing was same as usual before day 1")).toBe(true);
  });

  test("uses recorded nutritional vulnerability when governing candidate review", () => {
    const state = freshDemoState();
    expect(experimentRequiresReview(state.experiment, state.profile)).toBe(false);
    state.profile.conditions = "Short bowel syndrome with prior malnutrition";
    expect(experimentRequiresReview(state.experiment, state.profile)).toBe(true);
  });

  test.each([
    "Eat only white rice",
    "Try a juice cleanse",
    "Use a liquid-only diet",
    "Try a carnivore plan",
    "Skip one meal each day",
    "No food for 48 hours",
  ])("holds restrictive candidate wording for review: %s", (title) => {
    const state = freshDemoState();
    expect(experimentRequiresReview({ ...state.experiment, title }, state.profile)).toBe(true);
  });

  test("holds a candidate that conflicts with a recorded allergy", () => {
    const state = freshDemoState();
    state.profile.allergies = "Peanuts";
    expect(experimentRequiresReview({ ...state.experiment, variable: "Add peanut butter at breakfast" }, state.profile)).toBe(true);
  });

  test.each(["My baseline will be urgency 3/10", "I intend to record urgency", "I am going to measure pain"])(
    "does not accept future intent as baseline: %s",
    (baseline) => expect(isRecordedExperimentBaseline(baseline)).toBe(false),
  );
});
