const REMINDER_TAG = "memed-background-reminders";
const REMINDER_CACHE = "memed-reminder-dedupe-v2";
const REMINDER_CONTROL_CACHE = "memed-reminder-control-v1";
const REMINDER_SUSPENSION_PATH = "/__memed-reminders-suspended__";
const REMINDER_MARKER = /^\d{4}-\d{2}-\d{2}:daily-check-in:[a-z0-9]+$/;
let reminderSuppressed = false;

function isMeMedReminder(notification) {
  return typeof notification.tag === "string"
    && (notification.tag === REMINDER_TAG
      || notification.tag.startsWith(`${REMINDER_TAG}:`));
}

async function durableReminderSuppressionPresent() {
  if (reminderSuppressed) return true;
  try {
    const cache = await caches.open(REMINDER_CONTROL_CACHE);
    return Boolean(await cache.match(REMINDER_SUSPENSION_PATH));
  } catch {
    // If the worker cannot read its privacy control, fail closed for this execution.
    return true;
  }
}

async function suspendReminders() {
  // The synchronous assignment stops in-flight checks at their next guarded boundary while
  // CacheStorage carries the opaque control across worker restarts and closed-page execution.
  reminderSuppressed = true;
  try {
    const cache = await caches.open(REMINDER_CONTROL_CACHE);
    await cache.put(
      REMINDER_SUSPENSION_PATH,
      new Response("suspended", { headers: { "Content-Type": "text/plain" } }),
    );
  } catch {
    // The same-origin suppression cookie remains the server-side fail-closed boundary.
  }
  try {
    await caches.delete(REMINDER_CACHE);
  } catch {
    // Dedupe markers are opaque and can be retried on the next deletion/startup pass.
  }
  try {
    const notifications = await self.registration.getNotifications();
    notifications.filter(isMeMedReminder).forEach((notification) => notification.close());
  } catch {
    // Some browsers do not expose registration notifications outside an installed context.
  }
}

async function resumeReminders() {
  try {
    const cache = await caches.open(REMINDER_CONTROL_CACHE);
    await cache.delete(REMINDER_SUSPENSION_PATH);
    reminderSuppressed = false;
    return true;
  } catch {
    reminderSuppressed = true;
    return false;
  }
}

function markerPath(marker) {
  return `/__memed-reminder-marker__/${marker}`;
}

async function shownMarker(marker) {
  const cache = await caches.open(REMINDER_CACHE);
  return Boolean(await cache.match(markerPath(marker)));
}

async function markShown(marker, date) {
  const cache = await caches.open(REMINDER_CACHE);
  const path = markerPath(marker);
  await cache.put(path, new Response("shown", { headers: { "Content-Type": "text/plain" } }));
  const keys = await cache.keys();
  const currentDayPrefix = markerPath(`${date}:`);
  await Promise.all(keys
    .filter((request) => !new URL(request.url).pathname.startsWith(currentDayPrefix))
    .map((request) => cache.delete(request)));
}

function validReminderPayload(reminder) {
  if (!reminder || typeof reminder !== "object" || Array.isArray(reminder)) return false;
  const fields = Object.keys(reminder).sort();
  return fields.length === 3
    && fields[0] === "body"
    && fields[1] === "marker"
    && fields[2] === "title"
    && typeof reminder.marker === "string"
    && REMINDER_MARKER.test(reminder.marker)
    && typeof reminder.title === "string"
    && reminder.title.length > 0
    && reminder.title.length <= 200
    && typeof reminder.body === "string"
    && reminder.body.length > 0
    && reminder.body.length <= 1_000;
}

async function checkForReminder() {
  if (await durableReminderSuppressionPresent()) return;
  // Drafting remains a separate bounded mutation. Its response contains only `{ created }` and
  // is deliberately ignored; no clinical aggregate enters the worker execution context.
  try {
    await fetch("/api/background/run", { method: "POST", credentials: "same-origin" });
  } catch {
    // The next page or periodic event can retry; no care action depends on this request.
  }
  if (await durableReminderSuppressionPresent()) return;
  if (self.Notification?.permission !== "granted") return;

  let response;
  try {
    response = await fetch("/api/reminders/current", {
      cache: "no-store",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
  } catch {
    return;
  }
  if (await durableReminderSuppressionPresent()) return;
  if (response.status === 204 || !response.ok) return;

  let reminder;
  try {
    reminder = await response.json();
  } catch {
    return;
  }
  if (!validReminderPayload(reminder)) return;
  if (await durableReminderSuppressionPresent()) return;

  const marker = reminder.marker;
  const date = marker.slice(0, 10);
  if (await shownMarker(marker)) return;
  if (await durableReminderSuppressionPresent()) return;
  const tag = `${REMINDER_TAG}:${marker}`;
  const alreadyShown = await self.registration.getNotifications({ tag });
  if (alreadyShown.length) return;
  if (await durableReminderSuppressionPresent()) return;
  const earlierStages = await self.registration.getNotifications();
  earlierStages
    .filter((notification) => notification.tag.startsWith(`${REMINDER_TAG}:${date}:daily-check-in:`))
    .forEach((notification) => notification.close());
  if (await durableReminderSuppressionPresent()) return;
  await self.registration.showNotification(reminder.title, {
    body: reminder.body,
    tag,
    renotify: false,
    data: { url: "/" },
  });
  if (await durableReminderSuppressionPresent()) {
    const justShown = await self.registration.getNotifications({ tag });
    justShown.forEach((notification) => notification.close());
    return;
  }
  await markShown(marker, date);
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("message", (event) => {
  if (event.data?.type === "SUSPEND_MEMED_REMINDERS") {
    reminderSuppressed = true;
    event.waitUntil(suspendReminders());
  } else if (event.data?.type === "RESUME_MEMED_REMINDERS") {
    event.waitUntil((async () => {
      if (await resumeReminders()) await checkForReminder();
    })());
  } else if (event.data?.type === "CHECK_MEMED_REMINDERS") {
    event.waitUntil(checkForReminder());
  }
});
self.addEventListener("periodicsync", (event) => {
  if (event.tag === REMINDER_TAG) event.waitUntil(checkForReminder());
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = clients.find((client) => "focus" in client);
    if (existing) return existing.focus();
    return self.clients.openWindow(event.notification.data?.url || "/");
  })());
});
