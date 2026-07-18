import { describe, expect, test } from "vitest";
import { INITIAL_STATE } from "../data";
import { answerFromPermittedRecords } from "./groundedAssistant";

describe("permission-aware grounded Penny answers", () => {
  test("retrieves prior patient messages only with the separate conversation permission", () => {
    const allowed = answerFromPermittedRecords(INITIAL_STATE, "What did I tell you earlier?");
    expect(allowed?.text).toContain("earlier message");
    expect(allowed?.sources?.every((source) => source.messageId)).toBe(true);

    const state = structuredClone(INITIAL_STATE);
    state.privacy.assistantConversationAccess = false;
    const refused = answerFromPermittedRecords(state, "What did I say in our previous conversation?");
    expect(refused?.text).toContain("access is off");
    expect(refused?.sources).toBeUndefined();
  });

  test("retrieves dated food and event source records without claiming causation", () => {
    const reply = answerFromPermittedRecords(INITIAL_STATE, "What did I eat before that bad weekend?");
    expect(reply?.category).toBe("recorded fact");
    expect(reply?.text).toContain("not proof");
    expect(reply?.sources?.some((source) => source.entryId === 4)).toBe(true);
  });

  test("grounds medicine questions in profile plus an approved-content boundary", () => {
    const reply = answerFromPermittedRecords(INITIAL_STATE, "Can I drink alcohol on azathioprine?");
    expect(reply?.category).toBe("general information");
    expect(reply?.text).toMatch(/pharmacist or IBD team/i);
    expect(reply?.sources?.map((source) => source.type)).toEqual(["fact", "guidance"]);
  });

  test("does not retrieve a record when its permission is disabled", () => {
    const state = { ...INITIAL_STATE, privacy: { ...INITIAL_STATE.privacy, assistantCareAccess: false } };
    const reply = answerFromPermittedRecords(state, "What is my calprotectin test status?");
    expect(reply?.text).toMatch(/access is off/i);
    expect(reply?.sources).toBeUndefined();
  });

  test("uses PMH as cited context for steroid-safety questions without prescribing", () => {
    const reply = answerFromPermittedRecords(INITIAL_STATE, "What steroid side-effect risks matter with my osteoporosis?");
    expect(reply?.category).toBe("general information");
    expect(reply?.text).toMatch(/cannot decide.*safe|cannot.*change its dose/i);
    expect(reply?.text).toContain("Osteopenia");
    expect(reply?.sources?.some((source) => source.label === "Relevant PMH context")).toBe(true);
    expect(reply?.sources?.at(-1)?.type).toBe("guidance");
  });

  test("does not reveal an exact taper dose before treatment is active", () => {
    const reply = answerFromPermittedRecords(INITIAL_STATE, "What is today's steroid dose?");
    expect(reply?.category).toBe("general information");
    expect(reply?.text).toMatch(/Dose support is not active/i);
    expect(reply?.text).not.toContain("25 mg");
    expect(reply?.sources).toBeUndefined();
  });

  test("returns the verified exact dose once clinician-issued treatment is active", () => {
    const state = structuredClone(INITIAL_STATE);
    state.prescription.status = "collected";
    state.prescription.treatmentStartedAt = "2026-07-17T08:00:00.000Z";
    const reply = answerFromPermittedRecords(state, "What is today's steroid dose?");
    expect(reply?.category).toBe("recorded fact");
    expect(reply?.text).toContain("25 mg");
    expect(reply?.sources?.[0]?.label).toBe("Verified prescribed taper");
  });
});

describe("food–symptom grounding", () => {
  test("answers with a bounded episode, exact sources and an explicit non-causal caveat", () => {
    const state = structuredClone(INITIAL_STATE);
    const answer = answerFromPermittedRecords(state, "Did that meal cause my symptom pattern?");

    expect(answer?.category).toBe("possible pattern");
    expect(answer?.text).toMatch(/correlation is not proof/i);
    expect(answer?.sources?.map((source) => source.entryId)).toEqual([4, 6, 5]);
    expect(answer?.sources?.every((source) => source.type === "pattern")).toBe(true);
  });

  test("does not derive a food episode when journal access is off", () => {
    const state = structuredClone(INITIAL_STATE);
    state.privacy.assistantJournalAccess = false;

    const answer = answerFromPermittedRecords(state, "Could food be a symptom trigger?");
    expect(answer?.category).toBe("general information");
    expect(answer?.text).toMatch(/journal access is off/i);
    expect(answer?.sources).toBeUndefined();
  });
});

describe("approved fixed Penny education", () => {
  test.each([
    ["What signs can happen in an IBD flare-up?", "flare", /signs vary|changes can include/i],
    ["What food should I eat with Crohn's?", "food", /no single diet/i],
    ["What does faecal calprotectin measure?", "calprotectin", /stool marker/i],
    ["Why do steroids need a taper?", "steroid", /not stopped suddenly/i],
    ["Can stress prove what triggered my symptoms?", "flare", /does not prove cause/i],
  ])("answers the fixed category for: %s", (question, sourceLabel, copy) => {
    const reply = answerFromPermittedRecords(INITIAL_STATE, question);
    expect(reply?.category).toBe("general information");
    expect(reply?.text).toMatch(copy as RegExp);
    expect(reply?.sources?.every((source) => source.type === "guidance")).toBe(true);
    expect(reply?.sources?.some((source) => `${source.label} ${source.detail}`.toLowerCase().includes(String(sourceLabel)))).toBe(true);
  });

  test("keeps personal meal retrieval separate from general diet education", () => {
    expect(answerFromPermittedRecords(INITIAL_STATE, "What did I eat before that bad weekend?")?.category).toBe("recorded fact");
    const education = answerFromPermittedRecords(INITIAL_STATE, "Which diet should someone with IBD follow?");
    expect(education?.category).toBe("general information");
    expect(education?.sources?.[0]?.type).toBe("guidance");
  });
});
