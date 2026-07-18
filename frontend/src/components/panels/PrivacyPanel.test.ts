import { describe, expect, test } from "vitest";
import { formatSupporterTimestamp } from "./PrivacyPanel";

describe("supporter access timestamp", () => {
  test("uses and labels the patient's configured time zone", () => {
    expect(formatSupporterTimestamp("2026-07-18T08:00:00.000Z", "Europe/London")).toMatch(/18 Jul 2026.*09:00.*\(Europe\/London\)/);
    expect(formatSupporterTimestamp("2026-07-18T08:00:00.000Z", "America/Los_Angeles")).toMatch(/18 Jul 2026.*01:00.*\(America\/Los_Angeles\)/);
  });

  test("falls back safely and still labels an invalid configured zone", () => {
    expect(formatSupporterTimestamp("2026-07-18T08:00:00.000Z", "Not/AZone")).toMatch(/08:00.*\(UTC\)/);
  });
});
