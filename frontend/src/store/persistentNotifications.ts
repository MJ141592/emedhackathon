const PERIODIC_TAG = "memed-background-reminders";
const REMINDER_DEDUPE_CACHE = "memed-reminder-dedupe-v2";
const REMINDER_CONTROL_CACHE = "memed-reminder-control-v1";
const REMINDER_SUSPENSION_PATH = "/__memed-reminders-suspended__";

export const REMINDER_DELETE_PENDING_KEY = "memed.delete-pending.v2";
export const REMINDER_DELETE_COMPLETE_KEY = "memed.delete-complete.v2";
export const REMINDER_SUPPRESSION_COOKIE = "memed_reminders_suspended";

type PeriodicSyncRegistration = ServiceWorkerRegistration & {
  periodicSync?: {
    register(tag: string, options: { minInterval: number }): Promise<void>;
    unregister?(tag: string): Promise<boolean>;
  };
};

export type PersistentReminderMode = "unsupported" | "suppressed" | "page" | "periodic";

function serviceWorkers(): ServiceWorkerContainer | null {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  return navigator.serviceWorker;
}

function cacheStorage(): CacheStorage | null {
  return typeof caches === "undefined" ? null : caches;
}

function isGutsyReminder(notification: Notification): boolean {
  return notification.tag === PERIODIC_TAG || notification.tag.startsWith(`${PERIODIC_TAG}:`);
}

/** True while an offline delete is pending or the deleted profile awaits fresh remote consent. */
export function persistentReminderDeletionGateActive(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(REMINDER_DELETE_PENDING_KEY) === "1"
      || window.localStorage.getItem(REMINDER_DELETE_COMPLETE_KEY) === "1";
  } catch {
    // If browser privacy settings make the deletion ledger unreadable, do not start a worker.
    return true;
  }
}

/**
 * The cookie is an opaque control bit, not patient data. It lets the API fail closed even when
 * an older or already-running worker has not observed the CacheStorage control yet.
 */
export function setPersistentReminderSuppressionCookie(suspended: boolean): void {
  if (typeof document === "undefined") return;
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  try {
    document.cookie = suspended
      ? `${REMINDER_SUPPRESSION_COOKIE}=1; Max-Age=315360000; Path=/; SameSite=Strict${secure}`
      : `${REMINDER_SUPPRESSION_COOKIE}=; Max-Age=0; Path=/; SameSite=Strict${secure}`;
  } catch {
    // CacheStorage and the current worker's in-memory gate remain available when cookies are blocked.
  }
}

async function existingRegistration(container: ServiceWorkerContainer): Promise<PeriodicSyncRegistration | null> {
  try {
    const registration = await container.getRegistration("/");
    return registration as PeriodicSyncRegistration | undefined ?? null;
  } catch {
    return null;
  }
}

function postToWorker(worker: ServiceWorker | null | undefined, type: string): void {
  try {
    worker?.postMessage({ type });
  } catch {
    // The CacheStorage control and server-side cookie remain authoritative.
  }
}

async function persistSuppressionControl(): Promise<void> {
  const storage = cacheStorage();
  if (!storage) return;
  try {
    const control = await storage.open(REMINDER_CONTROL_CACHE);
    await control.put(
      REMINDER_SUSPENSION_PATH,
      new Response("suspended", { headers: { "Content-Type": "text/plain" } }),
    );
  } catch {
    // A same-origin cookie still suppresses both server endpoints when CacheStorage is blocked.
  }
  try {
    await storage.delete(REMINDER_DEDUPE_CACHE);
  } catch {
    // Opaque dedupe markers can be removed by a later startup/deletion pass.
  }
}

async function removeSuppressionControl(): Promise<void> {
  const storage = cacheStorage();
  if (!storage) return;
  try {
    const control = await storage.open(REMINDER_CONTROL_CACHE);
    await control.delete(REMINDER_SUSPENSION_PATH);
  } catch {
    // The worker also removes its own copy before it resumes checking.
  }
}

/** Immediately and durably suppress closed-page reminders without registering a new worker. */
export async function suspendPersistentReminders(): Promise<"suppressed"> {
  // This executes synchronously before the first await, so subsequent same-origin worker fetches
  // carry the fail-closed cookie even if the API deletion itself is currently unreachable.
  setPersistentReminderSuppressionCookie(true);
  const container = serviceWorkers();
  postToWorker(container?.controller, "SUSPEND_MEMED_REMINDERS");
  await persistSuppressionControl();
  if (!container) return "suppressed";

  const registration = await existingRegistration(container);
  if (!registration) return "suppressed";
  if (registration.active !== container.controller) {
    postToWorker(registration.active, "SUSPEND_MEMED_REMINDERS");
  }
  try {
    await registration.periodicSync?.unregister?.(PERIODIC_TAG);
  } catch {
    // Periodic wake-ups remain harmless because both the worker and API are suppressed.
  }
  try {
    const notifications = await registration.getNotifications();
    notifications.filter(isGutsyReminder).forEach((notification) => notification.close());
  } catch {
    // Installed/PWA notification enumeration varies; the worker repeats the same cleanup.
  }
  return "suppressed";
}

/** Resume only after the caller has a remotely accepted profile with fresh active consent. */
export async function resumePersistentReminders(requestPeriodic = false): Promise<PersistentReminderMode> {
  setPersistentReminderSuppressionCookie(false);
  await removeSuppressionControl();
  const container = serviceWorkers();
  if (!container) return "unsupported";

  const registered = await container.register("/memed-worker.js", { scope: "/" }) as PeriodicSyncRegistration;
  const ready = await container.ready as PeriodicSyncRegistration;
  const registration = ready.active ? ready : registered;
  postToWorker(registration.active, "RESUME_MEMED_REMINDERS");
  if (!requestPeriodic || !registration.periodicSync) return "page";
  try {
    await registration.periodicSync.register(PERIODIC_TAG, { minInterval: 6 * 60 * 60 * 1000 });
    return "periodic";
  } catch {
    // Installed/PWA and browser permission policies vary. Page and in-app checks remain active.
    return "page";
  }
}

/** Mount-time entry point: never starts or checks the worker while a deletion tombstone exists. */
export async function reconcilePersistentReminders(requestPeriodic = false): Promise<PersistentReminderMode> {
  if (persistentReminderDeletionGateActive()) return suspendPersistentReminders();
  return resumePersistentReminders(requestPeriodic);
}

/** Backwards-compatible name used by startup and the explicit notification-permission control. */
export async function registerPersistentReminders(requestPeriodic = false): Promise<PersistentReminderMode> {
  return reconcilePersistentReminders(requestPeriodic);
}
