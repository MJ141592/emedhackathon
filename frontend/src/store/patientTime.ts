const FALLBACK_TIME_ZONE = "UTC";

/** The device zone is used only as the initial choice for a new patient profile. */
export function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(zone) ? zone : FALLBACK_TIME_ZONE;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

export function isValidTimeZone(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimeZone(value: string | undefined, fallback = browserTimeZone()): string {
  return isValidTimeZone(value) ? value!.trim() : isValidTimeZone(fallback) ? fallback : FALLBACK_TIME_ZONE;
}

function calendarParts(now: Date, timeZone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    calendar: "gregory",
    numberingSystem: "latn",
    timeZone: normalizeTimeZone(timeZone, FALLBACK_TIME_ZONE),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
}

export function dateInTimeZone(now = new Date(), timeZone = FALLBACK_TIME_ZONE): string {
  const parts = calendarParts(now, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function hourInTimeZone(now = new Date(), timeZone = FALLBACK_TIME_ZONE): number {
  return Number(calendarParts(now, timeZone).hour);
}

export function timeInTimeZone(now = new Date(), timeZone = FALLBACK_TIME_ZONE): string {
  const parts = calendarParts(now, timeZone);
  return `${parts.hour}:${parts.minute}`;
}

/** Comparable key for a real instant expressed on the patient's local calendar. */
export function dateTimeKeyInTimeZone(now: Date, timeZone = FALLBACK_TIME_ZONE): string | undefined {
  if (Number.isNaN(now.getTime())) return undefined;
  return `${dateInTimeZone(now, timeZone)}T${timeInTimeZone(now, timeZone)}`;
}

/** Calendar-date arithmetic that is deliberately independent of UTC offsets and DST. */
export function addCalendarDays(dateKey: string, days: number): string {
  const parsed = new Date(`${dateKey}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return dateKey;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function formatTimeInTimeZone(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: normalizeTimeZone(timeZone, FALLBACK_TIME_ZONE),
  }).format(now);
}

export function formatDateInTimeZone(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: normalizeTimeZone(timeZone, FALLBACK_TIME_ZONE),
  }).format(now);
}
