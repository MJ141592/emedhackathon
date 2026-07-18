import { describe, expect, test } from "vitest";
import { addCalendarDays, dateInTimeZone, dateTimeKeyInTimeZone, formatDateInTimeZone, hourInTimeZone, isValidTimeZone, normalizeTimeZone, timeInTimeZone } from "./patientTime";

describe("patient-local calendar utilities", () => {
  test("keeps two patients on their own calendar dates around UTC midnight", () => {
    const instant = new Date("2026-07-17T23:30:00.000Z");
    expect(dateInTimeZone(instant, "Europe/London")).toBe("2026-07-18");
    expect(hourInTimeZone(instant, "Europe/London")).toBe(0);
    expect(timeInTimeZone(instant, "Europe/London")).toBe("00:30");
    expect(dateInTimeZone(instant, "America/Los_Angeles")).toBe("2026-07-17");
    expect(hourInTimeZone(instant, "America/Los_Angeles")).toBe(16);
    expect(formatDateInTimeZone(instant, "Europe/London")).toBe("Saturday 18 July");
    expect(dateTimeKeyInTimeZone(instant, "Europe/London")).toBe("2026-07-18T00:30");
    expect(dateTimeKeyInTimeZone(instant, "America/Los_Angeles")).toBe("2026-07-17T16:30");
  });

  test("validates IANA zones and fails safely to a known zone", () => {
    expect(isValidTimeZone("Europe/London")).toBe(true);
    expect(isValidTimeZone("Not/A_Zone")).toBe(false);
    expect(normalizeTimeZone("Not/A_Zone", "America/New_York")).toBe("America/New_York");
  });

  test("does calendar arithmetic without DST changing the date sequence", () => {
    expect(addCalendarDays("2026-03-28", 1)).toBe("2026-03-29");
    expect(addCalendarDays("2026-03-29", 1)).toBe("2026-03-30");
    expect(addCalendarDays("2026-01-01", -1)).toBe("2025-12-31");
  });
});
