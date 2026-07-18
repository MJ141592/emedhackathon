import { describe, expect, test } from "vitest";
import { parseBloodAmountClarification, screenForUrgency, screenStructuredEntry, structureUtterance } from "./captureService";

describe("deterministic safety screen", () => {
  test("returns an openable approved source for medicine guidance", () => {
    const result = structureUtterance("Can I take ibuprofen?");

    expect(result.reply.sources?.[0]).toMatchObject({
      type: "guidance",
      url: expect.stringMatching(/^https:\/\/www\.crohnsandcolitis\.org\.uk\//),
    });
  });

  test("returns approved flare guidance for the built-in blood question", () => {
    const result = structureUtterance("Is the blood something to panic about?");
    expect(result.reply.sources?.[0]).toMatchObject({
      label: expect.stringMatching(/Flare-ups/),
      type: "guidance",
      url: expect.stringMatching(/^https:\/\/www\.crohnsandcolitis\.org\.uk\//),
    });
  });

  test.each([
    ["heavy bleeding that will not stop", "heavy or continuous bleeding"],
    ["my pain is 9/10", "severe abdominal pain"],
    ["I have a high temperature", "fever"],
    ["I feel faint", "faintness"],
    ["I cannot keep water down and feel dehydrated", "possible dehydration"],
    ["repeated vomiting and not passing gas", "vomiting or possible obstruction"],
  ])("screens %s", (utterance, trigger) => {
    expect(screenForUrgency(utterance)).toContain(trigger);
  });

  test("urgent results pre-empt normal parsing", () => {
    const result = structureUtterance("severe stomach pain after dinner");
    expect(result.safetyAlert).toBeDefined();
    expect(result.reply.text).toMatch(/urgent care now/i);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].flagged).toBe(true);
    expect(result.safetyAlert?.level).toBe("emergency");
  });

  test("screens red flags from manual structured capture", () => {
    expect(screenStructuredEntry({ kind: "BOWEL MOVEMENT", body: "Patient entry", source: "manual", structured: { blood: "heavy", pain: 8 } })).toEqual([
      "heavy or continuous bleeding",
      "severe abdominal pain",
    ]);
  });

  test("routes moderate bleeding and very high output to same-day guidance", () => {
    expect(screenStructuredEntry({ kind: "BOWEL MOVEMENT", body: "Patient entry", source: "manual", structured: { blood: "moderate", dailyCount: 10 } })).toEqual([
      "moderate bleeding",
      "very high bowel output",
    ]);
  });

  test("routes conversational moderate bleeding through the same-day screen", () => {
    const result = structureUtterance("moderate amount of blood in my stool");
    expect(result.entries[0].structured?.blood).toBe("moderate");
    expect(result.safetyAlert).toMatchObject({ level: "same-day", triggers: ["moderate bleeding"] });
    expect(result.reply.text).toMatch(/same-day clinical advice/i);
  });

  test("recognises a numeric cramp score as severe pain", () => {
    const result = structureUtterance("my cramps are 10/10");
    expect(result.safetyAlert?.triggers).toContain("severe abdominal pain");
    expect(result.safetyAlert?.level).toBe("emergency");
  });

  test("uses recorded immunosuppression in the deterministic fever threshold", () => {
    const entry = { kind: "WELLBEING" as const, body: "Temperature 37.6", source: "manual" as const, structured: { feverC: 37.6 } };
    expect(screenStructuredEntry(entry, { immunosuppressed: true })).toContain("possible infection while immunosuppressed");
    expect(screenStructuredEntry(entry, { immunosuppressed: false })).toEqual([]);
  });

  test.each([
    ["I collapsed", "faintness"],
    ["I am vomiting and haven't passed wind", "vomiting or possible obstruction"],
    ["My bowel feels blocked", "vomiting or possible obstruction"],
    ["There was lots of blood", "heavy or continuous bleeding"],
    ["I have not peed all day", "possible dehydration"],
    ["I have been sick repeatedly", "persistent vomiting"],
    ["I blacked out", "faintness"],
    ["The stomach pain is unbearable", "severe abdominal pain"],
    ["I passed large blood clots", "heavy or continuous bleeding"],
    ["I have no stool or wind and keep throwing up", "vomiting or possible obstruction"],
    ["I can’t keep anything down", "possible dehydration"],
  ])("recognises common red-flag wording: %s", (utterance, trigger) => {
    expect(screenForUrgency(utterance)).toContain(trigger);
  });

  test.each([
    "12 bowel movements today",
    "diarrhea 12 times today",
    "12 stools in the last 24 hours",
    "Ten loose stools today",
    "I have had a dozen bowel movements today",
  ])("recognises very high current-day bowel output: %s", (utterance) => {
    expect(screenForUrgency(utterance)).toContain("very high bowel output");
    const result = structureUtterance(utterance);
    expect(result.entries[0]).toMatchObject({ kind: "BOWEL MOVEMENT", flagged: true });
    expect(result.entries[0].structured?.bowelMovements24h).toBeGreaterThanOrEqual(10);
  });

  test.each([
    ["The bleeding will not stop", "heavy or continuous bleeding", "BOWEL MOVEMENT"],
    ["I cannot stop being sick", "persistent vomiting", "WELLBEING"],
    ["I have been sick all day", "persistent vomiting", "WELLBEING"],
    ["I vomited six times today", "persistent vomiting", "WELLBEING"],
    ["I have severe bloating and cannot poo", "vomiting or possible obstruction", "BOWEL MOVEMENT"],
    ["My stomach pain is 9/10", "severe abdominal pain", "PAIN"],
    ["My pain is nine out of ten", "severe abdominal pain", "PAIN"],
    ["My stomach pain is eight out of ten", "severe abdominal pain", "PAIN"],
    ["I have 9 out of 10 stomach pain", "severe abdominal pain", "PAIN"],
    ["It is 9/10 abdominal pain", "severe abdominal pain", "PAIN"],
    ["I am vomiting and my belly is swollen", "vomiting or possible obstruction", "WELLBEING"],
    ["I am vomiting and my abdomen is swollen", "vomiting or possible obstruction", "WELLBEING"],
    ["My temperature is 102°F", "fever", "WELLBEING"],
    ["My temperature is 39 degrees", "fever", "WELLBEING"],
  ])("preserves the canonical record for urgent wording: %s", (utterance, trigger, kind) => {
    const result = structureUtterance(utterance);
    expect(result.safetyAlert?.triggers).toContain(trigger);
    expect(result.entries[0]).toMatchObject({ kind, flagged: true });
  });

  test.each([
    "I had 9 bowel movements today",
    "I had twelve bowel movements last month",
    "I had twelve bowel movements over 3 days",
    "What bowel movement count needs urgent advice?",
    "I did not have twelve bowel movements today",
    "My pain is not nine out of ten",
    "My temperature is not 102°F",
    "I am vomiting but my belly is not swollen",
  ])("does not over-alert on count wording outside the threshold or time window: %s", (utterance) => {
    expect(screenForUrgency(utterance)).toEqual([]);
  });

  test.each([
    "I didn't feel faint",
    "I do not have severe abdominal pain",
    "I don't feel dehydrated",
    "There was not a lot of blood",
    "My temperature is not 39°C",
    "I did not black out",
    "I have no large blood clots",
    "The pain is not unbearable",
  ])("does not treat a directly negated statement as positive: %s", (utterance) => {
    expect(screenForUrgency(utterance)).toEqual([]);
  });

  test("keeps a later positive clause after a directly negated value", () => {
    expect(screenForUrgency("My temperature is not 39°C; it is 38.5°C")).toContain("fever");
    expect(screenForUrgency("I didn't feel faint, but later I collapsed")).toContain("faintness");
  });

  test("screens explicit red-flag wording in a manual body without structured fields", () => {
    expect(screenStructuredEntry({
      kind: "WELLBEING",
      body: "I won’t stop bleeding and I feel faint",
      source: "manual",
    })).toEqual(expect.arrayContaining(["heavy or continuous bleeding", "faintness"]));
  });
});

describe("uncertainty-preserving capture", () => {
  test("does not invent stool type or blood amount", () => {
    const result = structureUtterance("loose stool with blood this morning");
    expect(result.entries[0].structured).toEqual({ consistency: "loose", blood: "reported; amount not specified", needsClarification: "bloodAmount" });
    expect(result.entries[0].body).toContain("Bristol type not confirmed");
    expect(result.entries[0].body).toContain("amount not specified");
    expect(result.reply.text).toMatch(/how much blood did you notice/i);
  });

  test("retains a non-urgent explicit current-day bowel count", () => {
    const result = structureUtterance("I had five bowel movements today");
    expect(result.safetyAlert).toBeUndefined();
    expect(result.entries[0]).toMatchObject({ kind: "BOWEL MOVEMENT", flagged: false });
    expect(result.entries[0].structured?.bowelMovements24h).toBe(5);
  });

  test("parses a short follow-up without inventing a blood amount", () => {
    expect(parseBloodAmountClarification("just a small amount")).toBe("small");
    expect(parseBloodAmountClarification("I am not sure")).toBe("unspecified");
    expect(parseBloodAmountClarification("it looked red")).toBeUndefined();
  });

  test("retains explicitly reported Bristol type and trace blood", () => {
    const result = structureUtterance("Bristol type 6 with trace blood and urgency");
    expect(result.entries[0].structured).toMatchObject({ bristol: 6, blood: "trace", urgency: true });
  });

  test("never produces calorie or diet scoring language", () => {
    const result = structureUtterance("porridge and coffee for breakfast");
    expect(JSON.stringify(result)).not.toMatch(/calor|macro|score/i);
  });

  test("structures conversational sleep, mood, appetite, weight and change from usual", () => {
    const result = structureUtterance("I am feeling worse, slept 5.5 hours, mood is anxious, appetite is reduced and weight is 68.4 kg");
    const wellbeing = result.entries.find((entry) => entry.kind === "WELLBEING");
    expect(wellbeing?.structured).toMatchObject({ wellbeing: "worse", sleepHours: 5.5, mood: "anxious", appetite: "reduced", weightKg: 68.4 });
    expect(wellbeing?.flagged).toBe(true);
  });
});
