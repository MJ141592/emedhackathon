import type { DemoState, JournalDraft, JournalEntry, PrivacySettings, Profile, SupporterView } from "../types";
import { INITIAL_STATE } from "../data";
import { addCalendarDays, browserTimeZone, dateInTimeZone, normalizeTimeZone } from "./patientTime";
import {
  REMINDER_DELETE_COMPLETE_KEY as DELETE_COMPLETE_KEY,
  REMINDER_DELETE_PENDING_KEY as DELETE_PENDING_KEY,
} from "./persistentNotifications";

const STORAGE_KEY = "gutsy.persisted-demo.v2";
const NOTIFICATION_KEY_PREFIX = "gutsy.notification.";

export interface DemoSyncAdapter {
  hydrate(localState: DemoState): Promise<DemoState | null>;
  sync(state: DemoState): Promise<DemoState | void>;
  sendChat?(text: string): Promise<DemoState>;
  addJournal?(draft: JournalDraft): Promise<{ state: DemoState; entry: JournalEntry }>;
  updateJournal?(id: number, patch: Partial<JournalEntry>): Promise<DemoState>;
  deleteJournal?(id: number): Promise<DemoState>;
  withdrawHealthConsent?(patch: Partial<Profile>): Promise<DemoState>;
  updatePrivacy?(patch: Partial<PrivacySettings>): Promise<DemoState>;
  acknowledgeSafetyAlert?(): Promise<DemoState>;
  reset?(): Promise<void>;
  deleteAll?(): Promise<void>;
  importClinicalPlan?(): Promise<DemoState>;
  createSupporterInvitation?(): Promise<DemoState>;
  revokeSupporterInvitation?(): Promise<DemoState>;
  supporterView?(accessCode: string): Promise<SupporterView>;
  supporterLog?(accessCode: string, text: string): Promise<{ state: DemoState; view: SupporterView }>;
  correctChatMessage?(id: number, text: string): Promise<DemoState>;
  deleteChatMessage?(id: number): Promise<DemoState>;
}

let syncAdapter: DemoSyncAdapter | null = null;

export type SyncResult = { ok: true; state?: DemoState } | { ok: false; error: string };

/** Backend integration seam: install an adapter without changing any UI/store calls. */
export function configureDemoSyncAdapter(adapter: DemoSyncAdapter | null): void {
  syncAdapter = adapter;
}

export function isDemoSyncConfigured(): boolean {
  return syncAdapter !== null;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function applyPhotoRetention(state: DemoState, now: Date | number = new Date()): DemoState {
  const instant = typeof now === "number" ? new Date(now) : now;
  const currentPatientDate = dateInTimeZone(instant, state.profile.timeZone);
  let expired = 0;
  const entries = state.entries.map((entry) => {
    if (!entry.photo) return entry;
    const expiresOn = addCalendarDays(entry.date, entry.photo.retentionDays);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || currentPatientDate < expiresOn) return entry;
    expired += 1;
    const { photo: _expiredPhoto, ...record } = entry;
    return record;
  });
  if (!expired) return state;
  return {
    ...state,
    entries,
    audit: [{ id: Date.now() * 1000 + 1, at: "On load", action: `${expired} expired photo${expired === 1 ? " was" : "s were"} removed under the patient’s retention setting; non-image records were preserved.` }, ...state.audit],
  };
}

function normalizePersistedState(state: DemoState): DemoState {
  const wasOnboarded = Boolean(state.profile.onboardingComplete);
  const timeZone = wasOnboarded ? normalizeTimeZone(state.profile.timeZone) : browserTimeZone();
  const today = dateInTimeZone(new Date(), timeZone);
  const scheduledToday = state.taper.days.find((day) => day.date === today);
  const firstDay = state.taper.days[0];
  const lastDay = state.taper.days.at(-1);
  const calendarDay = scheduledToday ?? (lastDay && today > lastDay.date ? lastDay : firstDay && today < firstDay.date ? firstDay : undefined);
  return {
    ...state,
    profileProposals: state.profileProposals ?? [],
    teamMessageHistory: state.teamMessageHistory ?? [],
    teamMessageStale: state.teamMessageStale ?? false,
    testOrder: {
      ...state.testOrder,
      clinicalOwner: state.testOrder.clinicalOwner ?? "Not configured",
      eligibilityRule: state.testOrder.eligibilityRule ?? "Not configured",
      eligibilityReason: state.testOrder.eligibilityReason ?? "No governed eligibility decision has been recorded.",
    },
    teamMessage: {
      ...state.teamMessage,
      clinicalOwner: state.teamMessage.clinicalOwner ?? "Not configured",
      notificationRule: state.teamMessage.notificationRule ?? "Not configured",
      notificationReason: state.teamMessage.notificationReason ?? "No governed notification rationale has been recorded.",
    },
    clinicianSummaryEdited: state.clinicianSummaryEdited ?? false,
    clinicianSummaryStale: state.clinicianSummaryStale ?? false,
    prescription: {
      ...state.prescription,
      clinicalOwner: state.prescription.clinicalOwner ?? "Not configured",
      eligibilityRule: state.prescription.eligibilityRule ?? "Not configured",
      eligibilityReason: state.prescription.eligibilityReason ?? "No governed rescue-pathway eligibility has been recorded.",
      reviewAfterHours: state.prescription.reviewAfterHours ?? 24,
    },
    taper: {
      ...state.taper,
      missedDays: state.taper.missedDays ?? [],
      ...(calendarDay && state.taper.verified ? { currentDay: calendarDay.day } : {}),
    },
    experiment: {
      ...state.experiment,
      baseline: state.experiment.baseline ?? "",
    },
    profile: {
      ...state.profile,
      timeZone,
      adultEligibilityConfirmed: state.profile.adultEligibilityConfirmed ?? wasOnboarded,
      healthDataConsent: state.profile.healthDataConsent ?? wasOnboarded,
      consentVersion: state.profile.consentVersion || "demo-v1",
    },
    privacy: {
      ...state.privacy,
      assistantConversationAccess: state.privacy.assistantConversationAccess ?? true,
    },
    wearable: {
      ...state.wearable,
      hrv: state.wearable.hrv ?? false,
    },
    safetyAlert: state.safetyAlert ? {
      ...state.safetyAlert,
      level: state.safetyAlert.level ?? "emergency",
    } : undefined,
  };
}

export const demoRepository = {
  load(): DemoState {
    if (typeof window === "undefined") return clone(INITIAL_STATE);
    // Remove the legacy plaintext aggregate if a previous build created one. Sensitive demo
    // state now lives only in React's live session and the API's encrypted SQLite record.
    window.localStorage.removeItem(STORAGE_KEY);
    if (window.localStorage.getItem(DELETE_PENDING_KEY) === "1"
      || window.localStorage.getItem(DELETE_COMPLETE_KEY) === "1") return emptyDemoState();
    return clone(INITIAL_STATE);
  },

  save(_state: DemoState): void {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(STORAGE_KEY);
  },

  deletionGateActive(): boolean {
    return typeof window !== "undefined" && (
      window.localStorage.getItem(DELETE_PENDING_KEY) === "1"
      || window.localStorage.getItem(DELETE_COMPLETE_KEY) === "1"
    );
  },

  releaseDeletionGateAfterRemoteConsent(state: DemoState): boolean {
    if (typeof window === "undefined"
      || window.localStorage.getItem(DELETE_PENDING_KEY) === "1"
      || window.localStorage.getItem(DELETE_COMPLETE_KEY) !== "1"
      || !state.profile.onboardingComplete
      || !state.profile.adultEligibilityConfirmed
      || !state.profile.healthDataConsent) return false;
    window.localStorage.removeItem(DELETE_COMPLETE_KEY);
    return true;
  },

  async hydrateRemote(localState: DemoState): Promise<DemoState | null> {
    if (!syncAdapter) return null;
    const deletionPending = typeof window !== "undefined" && window.localStorage.getItem(DELETE_PENDING_KEY) === "1";
    if (deletionPending) {
      if (!syncAdapter.deleteAll) return null;
      await syncAdapter.deleteAll();
    }
    const remote = await syncAdapter.hydrate(localState);
    if (remote?.version !== INITIAL_STATE.version) return null;
    const normalized = normalizePersistedState(remote);
    let retained = applyPhotoRetention(normalized);
    if (retained !== normalized) {
      // Retention is a deletion policy, not merely a display filter. Persist the scrubbed
      // aggregate so a refresh cannot resurrect an expired sensitive image payload.
      const accepted = await syncAdapter.sync(retained);
      if (accepted) retained = applyPhotoRetention(normalizePersistedState(accepted));
    }
    if (deletionPending && typeof window !== "undefined") {
      window.localStorage.setItem(DELETE_COMPLETE_KEY, "1");
      window.localStorage.removeItem(DELETE_PENDING_KEY);
    }
    return retained;
  },

  async syncRemote(state: DemoState): Promise<SyncResult> {
    if (!syncAdapter) return { ok: true };
    if (typeof window !== "undefined" && window.localStorage.getItem(DELETE_PENDING_KEY) === "1") return { ok: true };
    try {
      const accepted = await syncAdapter.sync(state);
      return accepted
        ? { ok: true, state: applyPhotoRetention(normalizePersistedState(accepted)) }
        : { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "The local API could not save this change.",
      };
    }
  },

  clear(): void {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(STORAGE_KEY);
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(NOTIFICATION_KEY_PREFIX)) window.localStorage.removeItem(key);
    }
  },

  pruneNotificationMarkers(currentPatientDate: string): void {
    if (typeof window === "undefined" || !/^\d{4}-\d{2}-\d{2}$/.test(currentPatientDate)) return;
    const currentPrefix = `${NOTIFICATION_KEY_PREFIX}${currentPatientDate}:`;
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(NOTIFICATION_KEY_PREFIX) && !key.startsWith(currentPrefix)) window.localStorage.removeItem(key);
    }
  },

  beginDeletion(): void {
    if (typeof window === "undefined") return;
    this.clear();
    window.localStorage.removeItem(DELETE_COMPLETE_KEY);
    window.localStorage.setItem(DELETE_PENDING_KEY, "1");
  },

  async resetRemote(): Promise<void> {
    if (this.deletionGateActive()) return;
    try {
      await syncAdapter?.reset?.();
    } catch {
      // Local deletion must never depend on network availability.
    }
  },

  async deleteAllRemote(): Promise<boolean> {
    if (!syncAdapter?.deleteAll) return false;
    try {
      await syncAdapter.deleteAll();
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(STORAGE_KEY);
        window.localStorage.setItem(DELETE_COMPLETE_KEY, "1");
        window.localStorage.removeItem(DELETE_PENDING_KEY);
      }
      return true;
    } catch {
      // The pending-deletion marker prevents remote data from being rehydrated and retries later.
      return false;
    }
  },

  async importClinicalPlan(): Promise<DemoState | null> {
    if (!syncAdapter?.importClinicalPlan) return null;
    return syncAdapter.importClinicalPlan();
  },

  async createSupporterInvitation(): Promise<DemoState | null> {
    return syncAdapter?.createSupporterInvitation?.() ?? null;
  },

  async revokeSupporterInvitation(): Promise<DemoState | null> {
    return syncAdapter?.revokeSupporterInvitation?.() ?? null;
  },

  async supporterView(accessCode: string): Promise<SupporterView | null> {
    return syncAdapter?.supporterView?.(accessCode) ?? null;
  },

  async supporterLog(accessCode: string, text: string): Promise<{ state: DemoState; view: SupporterView } | null> {
    return syncAdapter?.supporterLog?.(accessCode, text) ?? null;
  },

  async correctChatMessage(id: number, text: string): Promise<DemoState | null> {
    return syncAdapter?.correctChatMessage?.(id, text) ?? null;
  },

  async sendChat(text: string): Promise<DemoState | null> {
    return syncAdapter?.sendChat?.(text) ?? null;
  },

  async addJournal(draft: JournalDraft): Promise<{ state: DemoState; entry: JournalEntry } | null> {
    return syncAdapter?.addJournal?.(draft) ?? null;
  },

  async updateJournal(id: number, patch: Partial<JournalEntry>): Promise<DemoState | null> {
    return syncAdapter?.updateJournal?.(id, patch) ?? null;
  },

  async deleteJournal(id: number): Promise<DemoState | null> {
    return syncAdapter?.deleteJournal?.(id) ?? null;
  },

  async withdrawHealthConsent(patch: Partial<Profile>): Promise<DemoState | null> {
    return syncAdapter?.withdrawHealthConsent?.(patch) ?? null;
  },

  async updatePrivacy(patch: Partial<PrivacySettings>): Promise<DemoState | null> {
    return syncAdapter?.updatePrivacy?.(patch) ?? null;
  },

  async acknowledgeSafetyAlert(): Promise<DemoState | null> {
    return syncAdapter?.acknowledgeSafetyAlert?.() ?? null;
  },

  async deleteChatMessage(id: number): Promise<DemoState | null> {
    return syncAdapter?.deleteChatMessage?.(id) ?? null;
  },

  export(state: DemoState): string {
    return JSON.stringify({ exportedAt: new Date().toISOString(), product: "Gutsy demo", data: state }, null, 2);
  },
};

export function freshDemoState(): DemoState {
  return clone(INITIAL_STATE);
}

export function emptyDemoState(): DemoState {
  const state = freshDemoState();
  state.phase = "stable";
  state.pendingPhase = undefined;
  state.phaseConfirmed = false;
  state.messages = [];
  state.profileProposals = [];
  state.entries = [];
  state.audit = [{ id: Date.now() * 1000, at: "Just now", action: "All local demo data was deleted by the patient." }];
  state.profile = {
    ...state.profile,
    name: "",
    timeZone: browserTimeZone(),
    dateOfBirth: "",
    diagnosis: "",
    subtype: "",
    diagnosedYear: "",
    extent: "",
    surgeries: "",
    conditions: "",
    allergies: "",
    immunosuppressed: false,
    familyHistory: "",
    usualBowel: "",
    usualPain: "",
    usualHeartRate: "",
    usualSleep: "",
    dietaryNeeds: "",
    currentMedicines: "",
    pastMedicines: "",
    carePlan: "",
    address: "",
    postcode: "",
    adultEligibilityConfirmed: false,
    healthDataConsent: false,
    consentVersion: "demo-v1",
    consentRecordedAt: undefined,
    onboardingComplete: false,
  };
  state.contacts = [];
  // Keep the cleared care workflow empty while localising only the new profile's
  // initial calendar zone to this browser. The next onboarding edit mutates this
  // same draft/workflow rather than replacing an in-flight care record.
  state.testOrder = {
    id: "Not ordered",
    status: "prepared",
    clinicalOwner: "Not configured — test ordering is unavailable",
    eligibilityRule: "Not configured",
    eligibilityReason: "No governed eligibility decision has been recorded.",
    addressConfirmed: false,
    consent: false,
  };
  state.teamMessage = {
    id: "No message",
    subject: "No clinician message",
    body: "No draft has been prepared.",
    status: "draft",
    clinicalOwner: "Not configured — clinician messaging is unavailable",
    notificationRule: "Not configured",
    notificationReason: "No governed notification rationale has been recorded.",
    expectedResponse: "Not configured",
  };
  state.teamMessageHistory = [];
  state.teamMessageStale = false;
  state.prescription = {
    status: "not-started",
    medicine: "",
    prescriber: "",
    pharmacy: "",
    clinicalOwner: "Not configured — rescue prescribing is unavailable",
    eligibilityRule: "Not configured",
    eligibilityReason: "No governed rescue-pathway eligibility has been recorded.",
    rescuePlanEligible: false,
    reviewAfterHours: 24,
  };
  state.taper = { verified: false, medicine: "", prescribedBy: "", currentDay: 1, days: [], missedDays: [], sideEffects: [], checkInComplete: false };
  state.experiment = { id: "No experiment", title: "No active experiment", variable: "", goal: "", baseline: "", outcome: "", startDate: "", durationDays: 1, day: 0, status: "suggested", observations: [], reviewRequired: false };
  state.clinicianSummary = "";
  state.clinicianSummaryEdited = false;
  state.clinicianSummaryStale = false;
  state.wearable = { provider: "Apple Health", connected: false, heartRate: false, hrv: false, sleep: false, activity: false };
  state.privacy = { photoRetentionDays: 7, toiletPhotoConsent: false, assistantProfileAccess: false, assistantJournalAccess: false, assistantCareAccess: false, assistantConversationAccess: false, secondaryUseConsent: false, discreetNotifications: true, notificationBudget: "low" };
  state.trustedSupporter = { enabled: false, name: "", relationship: "", canViewSummary: false, canSeeReminders: false, canHelpLog: false, accessCode: undefined, accessCreatedAt: undefined };
  state.safetyAlert = undefined;
  return state;
}
