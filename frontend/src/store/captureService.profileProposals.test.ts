import { describe, expect, test } from "vitest";
import { extractProfileProposals, structureUtterance } from "./captureService";

describe("conversation-derived profile proposals", () => {
  test("extracts explicit surgery, allergy, diagnosis-history and past-medicine statements", () => {
    expect(extractProfileProposals("I had an ileocecal resection in 2019")).toEqual([
      { field: "surgeries", value: "ileocecal resection in 2019" },
    ]);
    expect(extractProfileProposals("I'm allergic to penicillin and I was diagnosed with osteopenia")).toEqual([
      { field: "allergies", value: "penicillin" },
      { field: "conditions", value: "osteopenia" },
    ]);
    expect(extractProfileProposals("I used to take mesalazine because it had limited effect")).toEqual([
      { field: "pastMedicines", value: "mesalazine because it had limited effect" },
    ]);
    expect(extractProfileProposals("I have osteoporosis")).toEqual([
      { field: "conditions", value: "osteoporosis" },
    ]);
    expect(structureUtterance("I previously took mesalazine").entries).toEqual([]);
  });

  test("does not turn a question into a proposal or silently add a journal entry", () => {
    expect(extractProfileProposals("Am I allergic to penicillin?")).toEqual([]);
    const result = structureUtterance("I have been diagnosed with osteoporosis");
    expect(result.profileProposals).toEqual([{ field: "conditions", value: "osteoporosis" }]);
    expect(result.entries).toEqual([]);
    expect(result.reply.text).toMatch(/nothing has been added to your PMH/i);
  });
});
