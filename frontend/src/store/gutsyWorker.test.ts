/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  persistentReminderDeletionGateActive,
  reconcilePersistentReminders,
  REMINDER_DELETE_COMPLETE_KEY,
  REMINDER_DELETE_PENDING_KEY,
  REMINDER_SUPPRESSION_COOKIE,
  resumePersistentReminders,
  setPersistentReminderSuppressionCookie,
} from "./persistentNotifications";

const REMINDER_TAG = "gutsy-background-reminders";
const DEDUPE_CACHE = "gutsy-reminder-dedupe-v2";
const CONTROL_CACHE = "gutsy-reminder-control-v1";
const SUSPENSION_PATH = "/__gutsy-reminders-suspended__";

type ReminderPayload = { marker: string; title: string; body: string };
type Notice = { title: string; options: Record<string, unknown> };
type RegistrationNotice = { tag: string; closed: boolean; close: () => void };
type WorkerEvent = {
  data?: unknown;
  tag?: string;
  waitUntil(promise: Promise<unknown>): void;
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function loadWorker(options: {
  payload?: unknown;
  status?: number;
  permission?: NotificationPermission;
  invalidJson?: boolean;
  suspended?: boolean;
  backgroundGate?: Promise<void>;
  registrationNotifications?: string[];
} = {}) {
  const source = readFileSync(resolve(process.cwd(), "public/gutsy-worker.js"), "utf8");
  const fetches: Array<{ url: string; init?: RequestInit }> = [];
  const notices: Notice[] = [];
  const stores = new Map<string, Set<string>>();
  const deletedCaches: string[] = [];
  const handlers = new Map<string, (event: WorkerEvent) => void>();
  if (options.suspended) stores.set(CONTROL_CACHE, new Set([SUSPENSION_PATH]));
  stores.set(DEDUPE_CACHE, stores.get(DEDUPE_CACHE) ?? new Set(["/__old-opaque-marker__"]));

  const keyFor = (input: string | { url: string }) => {
    if (typeof input === "string") return input;
    return new URL(input.url).pathname;
  };
  const cacheFor = (name: string) => {
    const entries = stores.get(name) ?? new Set<string>();
    stores.set(name, entries);
    return {
      async match(input: string | { url: string }) {
        const key = keyFor(input);
        return entries.has(key) ? { url: `https://gutsy.test${key}` } : undefined;
      },
      async put(input: string | { url: string }) { entries.add(keyFor(input)); },
      async keys() {
        return [...entries].map((key) => ({ url: `https://gutsy.test${key}` }));
      },
      async delete(input: string | { url: string }) { return entries.delete(keyFor(input)); },
    };
  };
  const cacheApi = {
    async open(name: string) { return cacheFor(name); },
    async delete(name: string) {
      deletedCaches.push(name);
      return stores.delete(name);
    },
  };

  const registrationNotifications: RegistrationNotice[] = (options.registrationNotifications ?? [])
    .map((tag) => {
      const notification: RegistrationNotice = {
        tag,
        closed: false,
        close: () => { notification.closed = true; },
      };
      return notification;
    });
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetches.push({ url, init });
    if (url === "/api/background/run") {
      await options.backgroundGate;
      return { status: 200, ok: true, json: async () => ({ created: false }) };
    }
    const status = options.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => {
        if (options.invalidJson) throw new SyntaxError("invalid JSON");
        return options.payload;
      },
    };
  };
  const workerSelf: {
    Notification: { permission: NotificationPermission };
    registration: {
      getNotifications: (filter?: { tag?: string }) => Promise<RegistrationNotice[]>;
      showNotification: (title: string, options: Record<string, unknown>) => Promise<void>;
    };
    clients: { claim: () => Promise<void>; matchAll: () => Promise<never[]>; openWindow: () => Promise<void> };
    skipWaiting: () => Promise<void>;
    addEventListener: (type: string, handler: (event: WorkerEvent) => void) => void;
    __testHooks?: {
      checkForReminder: () => Promise<void>;
      suspendReminders: () => Promise<void>;
      resumeReminders: () => Promise<boolean>;
    };
  } = {
    Notification: { permission: options.permission ?? "granted" },
    registration: {
      getNotifications: async (filter) => registrationNotifications
        .filter((notification) => !notification.closed && (!filter?.tag || notification.tag === filter.tag)),
      showNotification: async (title, noticeOptions) => {
        notices.push({ title, options: noticeOptions });
        const notification: RegistrationNotice = {
          tag: String(noticeOptions.tag ?? ""),
          closed: false,
          close: () => { notification.closed = true; },
        };
        registrationNotifications.push(notification);
      },
    },
    clients: { claim: async () => undefined, matchAll: async () => [], openWindow: async () => undefined },
    skipWaiting: async () => undefined,
    addEventListener: (type, handler) => { handlers.set(type, handler); },
  };
  class MarkerResponse {
    constructor(public readonly body: string, public readonly init?: unknown) {}
  }
  runInNewContext(
    `${source}\nself.__testHooks = { checkForReminder, suspendReminders, resumeReminders };`,
    { self: workerSelf, fetch: fetcher, caches: cacheApi, Response: MarkerResponse, URL },
  );

  const dispatchMessage = async (data: unknown) => {
    let completion: Promise<unknown> = Promise.resolve();
    handlers.get("message")?.({ data, waitUntil: (promise) => { completion = promise; } });
    await completion;
  };
  return {
    checkForReminder: workerSelf.__testHooks!.checkForReminder,
    dispatchMessage,
    fetches,
    notices,
    source,
    deletedCaches,
    registrationNotifications,
    cacheEntries: (name: string) => stores.get(name) ?? new Set<string>(),
  };
}

describe("closed-page reminder delivery", () => {
  const payload: ReminderPayload = {
    marker: "2026-07-18:daily-check-in:0",
    title: "You have a Gutsy check-in",
    body: "Open Gutsy when it suits you. Urgent help remains available.",
  };

  test("fetches and displays only the minimal server-authored payload", async () => {
    const worker = loadWorker({ payload });

    await worker.checkForReminder();

    expect(worker.fetches.map(({ url }) => url)).toEqual([
      "/api/background/run",
      "/api/reminders/current",
    ]);
    expect(worker.fetches[1].init).toMatchObject({ cache: "no-store", credentials: "same-origin" });
    expect(worker.notices).toEqual([{ title: payload.title, options: expect.objectContaining({ body: payload.body }) }]);
    expect(worker.cacheEntries(DEDUPE_CACHE)).toContain(`/__gutsy-reminder-marker__/${payload.marker}`);
  });

  test("contains no aggregate fetch or duplicate patient-state derivation", () => {
    const { source } = loadWorker({ payload });
    expect(source).not.toContain("/api/demo");
    expect(source).not.toContain("reminderFor");
    expect(source).not.toMatch(/state\.(?:entries|profile|taper|privacy|teamMessage)/);
    expect(source).toContain('fetch("/api/reminders/current"');
  });

  test("fails closed for no-content, malformed, or expanded payloads", async () => {
    const noContent = loadWorker({ status: 204 });
    await noContent.checkForReminder();
    expect(noContent.notices).toEqual([]);

    const malformed = loadWorker({ invalidJson: true });
    await expect(malformed.checkForReminder()).resolves.toBeUndefined();
    expect(malformed.notices).toEqual([]);

    const expanded = loadWorker({ payload: { ...payload, entries: [] } });
    await expanded.checkForReminder();
    expect(expanded.notices).toEqual([]);
  });

  test("does not request a reminder payload before notification permission", async () => {
    const worker = loadWorker({ payload, permission: "denied" });
    await worker.checkForReminder();
    expect(worker.fetches.map(({ url }) => url)).toEqual(["/api/background/run"]);
    expect(worker.notices).toEqual([]);
  });

  test("a durable suppression marker prevents every worker network request", async () => {
    const worker = loadWorker({ payload, suspended: true });

    await worker.checkForReminder();

    expect(worker.fetches).toEqual([]);
    expect(worker.notices).toEqual([]);
  });

  test("suspension during an in-flight background request prevents reminder fetch and display", async () => {
    const background = deferred<void>();
    const worker = loadWorker({ payload, backgroundGate: background.promise });
    const check = worker.checkForReminder();
    await vi.waitFor(() => expect(worker.fetches.map(({ url }) => url)).toEqual(["/api/background/run"]));

    await worker.dispatchMessage({ type: "SUSPEND_GUTSY_REMINDERS" });
    background.resolve();
    await check;

    expect(worker.fetches.map(({ url }) => url)).toEqual(["/api/background/run"]);
    expect(worker.notices).toEqual([]);
    expect(worker.cacheEntries(CONTROL_CACHE)).toContain(SUSPENSION_PATH);
  });

  test("suspension clears opaque dedupe state and closes only Gutsy notifications", async () => {
    const ownTag = `${REMINDER_TAG}:2026-07-18:daily-check-in:0`;
    const unrelatedTag = `${REMINDER_TAG}-other-product`;
    const worker = loadWorker({
      payload,
      registrationNotifications: [ownTag, unrelatedTag, "unrelated"],
    });

    await worker.dispatchMessage({ type: "SUSPEND_GUTSY_REMINDERS" });

    expect(worker.deletedCaches).toContain(DEDUPE_CACHE);
    expect(worker.registrationNotifications.find(({ tag }) => tag === ownTag)?.closed).toBe(true);
    expect(worker.registrationNotifications.find(({ tag }) => tag === unrelatedTag)?.closed).toBe(false);
    expect(worker.registrationNotifications.find(({ tag }) => tag === "unrelated")?.closed).toBe(false);
  });

  test("an explicit resume removes the durable gate before checking again", async () => {
    const worker = loadWorker({ payload, suspended: true });

    await worker.dispatchMessage({ type: "RESUME_GUTSY_REMINDERS" });

    expect(worker.cacheEntries(CONTROL_CACHE)).not.toContain(SUSPENSION_PATH);
    expect(worker.fetches.map(({ url }) => url)).toEqual([
      "/api/background/run",
      "/api/reminders/current",
    ]);
    expect(worker.notices).toHaveLength(1);
  });
});

function browserReminderHarness() {
  const cached = new Set<string>();
  const cache = {
    match: vi.fn(async (key: string) => cached.has(key) ? new Response("found") : undefined),
    put: vi.fn(async (key: string) => { cached.add(key); }),
    delete: vi.fn(async (key: string) => cached.delete(key)),
  };
  const storage = {
    open: vi.fn(async () => cache),
    delete: vi.fn(async (name: string) => name === DEDUPE_CACHE),
  };
  const ownNotification = {
    tag: `${REMINDER_TAG}:2026-07-18:daily-check-in:0`,
    close: vi.fn(),
  };
  const unrelatedNotification = { tag: "another-app", close: vi.fn() };
  const worker = { postMessage: vi.fn() };
  const periodicSync = { register: vi.fn(async () => undefined), unregister: vi.fn(async () => true) };
  const registration = {
    active: worker,
    periodicSync,
    getNotifications: vi.fn(async () => [ownNotification, unrelatedNotification]),
  };
  const container = {
    controller: worker,
    getRegistration: vi.fn(async () => registration),
    register: vi.fn(async () => registration),
    ready: Promise.resolve(registration),
  };
  vi.stubGlobal("caches", storage as unknown as CacheStorage);
  vi.stubGlobal("navigator", { serviceWorker: container });
  return {
    cached,
    cache,
    storage,
    worker,
    periodicSync,
    registration,
    container,
    ownNotification,
    unrelatedNotification,
  };
}

describe("persistent reminder startup control", () => {
  afterEach(() => {
    window.localStorage.clear();
    setPersistentReminderSuppressionCookie(false);
    vi.unstubAllGlobals();
  });

  test("a deletion tombstone suppresses startup without registering or checking", async () => {
    const browser = browserReminderHarness();
    window.localStorage.setItem(REMINDER_DELETE_PENDING_KEY, "1");

    const start = reconcilePersistentReminders(true);
    expect(document.cookie).toContain(`${REMINDER_SUPPRESSION_COOKIE}=1`);
    expect(persistentReminderDeletionGateActive()).toBe(true);
    await expect(start).resolves.toBe("suppressed");

    expect(browser.container.register).not.toHaveBeenCalled();
    expect(browser.worker.postMessage).toHaveBeenCalledWith({ type: "SUSPEND_GUTSY_REMINDERS" });
    expect(browser.periodicSync.unregister).toHaveBeenCalledWith(REMINDER_TAG);
    expect(browser.cache.put).toHaveBeenCalledWith(SUSPENSION_PATH, expect.any(Response));
    expect(browser.storage.delete).toHaveBeenCalledWith(DEDUPE_CACHE);
    expect(browser.ownNotification.close).toHaveBeenCalledOnce();
    expect(browser.unrelatedNotification.close).not.toHaveBeenCalled();
  });

  test("the completed-deletion tombstone remains a startup suppression gate", async () => {
    const browser = browserReminderHarness();
    window.localStorage.setItem(REMINDER_DELETE_COMPLETE_KEY, "1");

    await expect(reconcilePersistentReminders(true)).resolves.toBe("suppressed");

    expect(persistentReminderDeletionGateActive()).toBe(true);
    expect(browser.container.register).not.toHaveBeenCalled();
    expect(document.cookie).toContain(`${REMINDER_SUPPRESSION_COOKIE}=1`);
  });

  test("an explicit post-consent resume clears controls, checks, and restores periodic work", async () => {
    const browser = browserReminderHarness();
    browser.cached.add(SUSPENSION_PATH);
    setPersistentReminderSuppressionCookie(true);

    await expect(resumePersistentReminders(true)).resolves.toBe("periodic");

    expect(browser.cache.delete).toHaveBeenCalledWith(SUSPENSION_PATH);
    expect(browser.cached).not.toContain(SUSPENSION_PATH);
    expect(browser.container.register).toHaveBeenCalledWith("/gutsy-worker.js", { scope: "/" });
    expect(browser.worker.postMessage).toHaveBeenCalledWith({ type: "RESUME_GUTSY_REMINDERS" });
    expect(browser.periodicSync.register).toHaveBeenCalledWith(
      REMINDER_TAG,
      { minInterval: 6 * 60 * 60 * 1000 },
    );
    expect(document.cookie).not.toContain(`${REMINDER_SUPPRESSION_COOKIE}=`);
  });
});
