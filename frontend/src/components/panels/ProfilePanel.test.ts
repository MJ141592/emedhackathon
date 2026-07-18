import { describe, expect, test } from "vitest";
import { formatConsentTimestamp, isAdultDate } from "./ProfilePanel";

describe("adult onboarding validation", () => {
  const today = new Date("2026-07-17T12:00:00Z");

  test("accepts someone on their eighteenth birthday", () => {
    expect(isAdultDate("2008-07-17", today)).toBe(true);
  });

  test("rejects someone one day short of eighteen", () => {
    expect(isAdultDate("2008-07-18", today)).toBe(false);
  });

  test("rejects missing, invalid and future dates", () => {
    expect(isAdultDate("", today)).toBe(false);
    expect(isAdultDate("not-a-date", today)).toBe(false);
    expect(isAdultDate("2030-01-01", today)).toBe(false);
  });

  test("uses the patient’s calendar date at a UTC birthday boundary", () => {
    const instant = new Date("2026-07-18T00:30:00Z");
    expect(isAdultDate("2008-07-18", instant, "Europe/London")).toBe(true);
    expect(isAdultDate("2008-07-18", instant, "America/Los_Angeles")).toBe(false);
  });

  test("formats the consent instant in the labelled patient time zone", () => {
    expect(formatConsentTimestamp("2026-07-18T08:00:00.000Z", "Europe/London")).toMatch(/18 Jul 2026.*09:00.*\(Europe\/London\)/);
    expect(formatConsentTimestamp("2026-07-18T08:00:00.000Z", "America/Los_Angeles")).toMatch(/18 Jul 2026.*01:00.*\(America\/Los_Angeles\)/);
  });
});
