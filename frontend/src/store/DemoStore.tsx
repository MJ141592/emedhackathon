import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { parseBloodAmountClarification, safetyLevelForTriggers, screenStructuredEntry, structureUtterance } from "./captureService";
import { applyPhotoRetention, demoRepository, emptyDemoState, freshDemoState, isDemoSyncConfigured } from "./demoRepository";
import { applyExplicitRecordCorrections, buildClinicianSummary, deriveEntryFlagged } from "./stateDerivations";
import { answerFromPermittedRecords } from "./groundedAssistant";
import {
  canConfirmStableBaseline,
  clinicalEvidenceChanged,
  deriveLifecycleProposal,
  hasActiveTrackingConsent,
  hasGovernedWatchEvidence,
  hasIncludedRaisedTestEvidence,
} from "./dashboardDerivations";
import {
  experimentCheckInDates,
  experimentRequiresReview,
  experimentReviewRequestMessage,
  experimentReviewThread,
  experimentTimelineObservations,
  hasExperimentCheckInOnDate,
  SIMULATED_EXPERIMENT_REVIEWER,
} from "./experimentSafety";
import { applyScheduledBackgroundWork, scheduledNotification } from "./backgroundAgent";
import { addCalendarDays, browserTimeZone, dateInTimeZone, timeInTimeZone } from "./patientTime";
import { taperTreatmentActive } from "./recoveryGovernance";
import { resumePersistentReminders, suspendPersistentReminders } from "./persistentNotifications";
import type {
  DemoState,
  DemoStore,
  CareContact,
  Experiment,
  JournalDraft,
  JournalEntry,
  PhaseId,
  PrivacySettings,
  Profile,
  PrescriptionFlow,
  Taper,
  TeamMessage,
  TestOrder,
  TrustedSupporter,
  WearableSettings,
  SafetyAlert,
  SupporterView,
} from "../types";

const DemoStoreContext = createContext<DemoStore | null>(null);
let lastGeneratedId = Date.now() * 1000;

function nextIntegerId(): number {
  lastGeneratedId = Math.max(lastGeneratedId + 1, Date.now() * 1000);
  return lastGeneratedId;
}

function timeNow(timeZone: string): string {
  return timeInTimeZone(new Date(), timeZone);
}

function today(timeZone: string): string {
  return dateInTimeZone(new Date(), timeZone);
}

function anchorTaperAtCollection(taper: Taper, timeZone: string): Taper {
  const start = today(timeZone);
  return {
    ...taper,
    verified: false,
    currentDay: 1,
    snoozedUntil: undefined,
    missedDays: [],
    sideEffects: [],
    checkInComplete: false,
    days: taper.days.map((scheduled, index) => ({ ...scheduled, date: addCalendarDays(start, index), taken: false })),
  };
}

function trackingIsActive(state: DemoState): boolean {
  return state.profile.onboardingComplete
    && state.profile.adultEligibilityConfirmed
    && state.profile.healthDataConsent;
}

function audit(state: DemoState, action: string): DemoState["audit"] {
  return [{ id: nextIntegerId(), at: "Just now", action }, ...state.audit].slice(0, 100);
}

function entryFromDraft(draft: JournalDraft, id = nextIntegerId(), timeZone = browserTimeZone()): JournalEntry {
  return { ...draft, id, date: draft.date ?? today(timeZone), time: draft.time ?? timeNow(timeZone) };
}

function isTaperAdherenceRecord(entry: JournalEntry | undefined): boolean {
  return Boolean(
    entry?.kind === "MEDICATION"
    && entry.structured?.taperDay !== undefined
    && (
      entry.structured.adherenceCorrection === true
      || entry.structured.missed === true
      || entry.structured.taken === true
    ),
  );
}

function refreshedEvidenceReview(current: DemoState, entries: JournalEntry[], changed: boolean, overrides: Partial<DemoState> = {}) {
  if (!changed) return {};
  const candidate = { ...current, ...overrides, entries, phaseConfirmed: false };
  const proposedPhase = deriveLifecycleProposal(candidate).proposedPhase;
  const experiment = proposedPhase && candidate.experiment.status === "active"
    ? {
        ...candidate.experiment,
        status: "paused" as const,
      }
    : candidate.experiment;
  return {
    phaseConfirmed: false,
    pendingPhase: proposedPhase,
    experiment,
  };
}

function proposalAuditSuffix(state: DemoState): string {
  const proposal = deriveLifecycleProposal(state).proposedPhase;
  return proposal ? ` Evidence collation proposed ${proposal} support for patient review.` : " Evidence collation found no governed support-mode change.";
}

function refreshedClinicianSummary(current: DemoState, next: DemoState, sourceChanged = false) {
  const generated = buildClinicianSummary(next);
  const teamMessageStale = current.teamMessage.status === "draft"
    && (sourceChanged || generated !== buildClinicianSummary(current))
    ? true
    : current.teamMessageStale;
  if (current.clinicianSummaryEdited) {
    return {
      clinicianSummary: current.clinicianSummary,
      clinicianSummaryEdited: true,
      clinicianSummaryStale: current.clinicianSummaryStale || generated !== buildClinicianSummary(current),
      teamMessageStale,
    };
  }
  return {
    clinicianSummary: generated,
    clinicianSummaryEdited: false,
    clinicianSummaryStale: false,
    teamMessageStale,
  };
}

function reconcileExperimentEvidence(current: DemoState, entries: JournalEntry[]): Experiment {
  const candidate = { ...current, entries };
  const timeline = experimentTimelineObservations(candidate);
  const checkInCount = experimentCheckInDates(candidate).length;
  const completeEvidence = timeline.some((item) => item.event === "complete");
  const completionStillValid = completeEvidence && checkInCount >= current.experiment.durationDays;
  const status = current.experiment.status === "complete" && !completionStillValid
    ? "paused" as const
    : current.experiment.status;
  return {
    ...current.experiment,
    day: Math.min(current.experiment.durationDays, checkInCount),
    status,
    observations: timeline.map((item) => item.label),
  };
}

function mergeSafetyAlert(
  currentAlert: SafetyAlert | undefined,
  entries: JournalEntry[],
  profile: DemoState["profile"],
  newSourceEntryIds: number[],
  newUnlinkedTriggers: string[],
  message: string,
): SafetyAlert | undefined {
  const requestedSourceIds = [...new Set([...(currentAlert?.sourceEntryIds ?? []), ...newSourceEntryIds])];
  const sources = entries.filter((entry) => requestedSourceIds.includes(entry.id) && !entry.excluded);
  const sourceTriggers = sources.map((entry) => ({ entry, triggers: screenStructuredEntry(entry, profile) }));
  const linkedSources = sourceTriggers.filter((item) => item.triggers.length > 0);
  const unlinkedTriggers = [...new Set([...(currentAlert?.unlinkedTriggers ?? []), ...newUnlinkedTriggers])];
  const triggers = [...new Set([...unlinkedTriggers, ...linkedSources.flatMap((item) => item.triggers)])];
  if (!triggers.length) return undefined;
  return {
    id: nextIntegerId(),
    level: safetyLevelForTriggers(triggers),
    triggers,
    message,
    createdAt: new Date().toISOString(),
    sourceEntryIds: linkedSources.map((item) => item.entry.id),
    unlinkedTriggers,
  };
}

function withAddedEntry(current: DemoState, entry: JournalEntry): DemoState {
  if (!current.profile.onboardingComplete
    || !current.profile.adultEligibilityConfirmed
    || !current.profile.healthDataConsent) return current;
  const urgentTriggers = screenStructuredEntry(entry, current.profile);
  entry.flagged = urgentTriggers.length > 0 || deriveEntryFlagged(entry, current.profile);
  const entries = [entry, ...current.entries];
  const changed = clinicalEvidenceChanged(entry);
  const review = refreshedEvidenceReview(current, entries, changed);
  const next = { ...current, entries, ...review };
  return {
    ...next,
    ...refreshedClinicianSummary(current, next, changed),
    safetyAlert: urgentTriggers.length
      ? mergeSafetyAlert(
          current.safetyAlert,
          entries,
          current.profile,
          [entry.id],
          [],
          "This manual entry matched the app’s deterministic safety screen. This was not decided by Penny or AI.",
        )
      : current.safetyAlert,
    audit: audit(
      current,
      urgentTriggers.length
        ? `Deterministic safety screen matched manual capture: ${urgentTriggers.join(", ")}.`
        : `${entry.kind} entry added from ${entry.source}.${changed ? proposalAuditSuffix(next) : ""}`,
    ),
  };
}

function retractPatientMessageContext(
  messages: DemoState["messages"],
  messageId: number,
  reason: string,
): DemoState["messages"] {
  const orderedLater = messages.filter((message) => message.id > messageId).sort((a, b) => a.id - b.id);
  const pairedReply = orderedLater.find((message, index) => message.from === "penny"
    && !orderedLater.slice(0, index).some((candidate) => candidate.from === "me"));
  return messages.map((message) => {
    let sources = message.sources?.map((source) => source.messageId === messageId
      ? { ...source, excluded: true, detail: reason }
      : source);
    if (message.id === pairedReply?.id) {
      sources = (sources ?? []).map((source) => ({ ...source, excluded: true }));
      const existing = sources.findIndex((source) => source.messageId === messageId && source.label === "Original patient wording");
      const retraction = {
        messageId,
        label: "Original patient wording",
        date: messages.find((candidate) => candidate.id === messageId)?.createdAt ?? "Conversation record",
        detail: reason,
        type: "fact" as const,
        excluded: true,
      };
      if (existing >= 0) sources[existing] = retraction;
      else sources.push(retraction);
    }
    return { ...message, sources };
  });
}

export function DemoStoreProvider({ children, initialState }: { children: ReactNode; initialState?: DemoState }) {
  const [state, setRawState] = useState<DemoState>(() => initialState ? structuredClone(initialState) : demoRepository.load());
  const [syncStatus, setSyncStatus] = useState<DemoStore["syncStatus"]>(initialState ? "local" : "loading");
  const [syncError, setSyncError] = useState<string>();
  const remoteHydrated = useRef(false);
  const syncGeneration = useRef(0);
  const stateRef = useRef(state);
  const hydrationInvalidated = useRef(false);
  const skipRemoteSyncFor = useRef<DemoState | null>(null);
  const confirmedStateRef = useRef<DemoState | null>(null);
  const failedSnapshotRef = useRef<DemoState | null>(null);
  const persistedModeRef = useRef(isDemoSyncConfigured());
  const mutationLockRef = useRef(persistedModeRef.current && !initialState);
  const collectingSnapshotRef = useRef(false);
  const pendingDraftRef = useRef<DemoState | null>(null);
  stateRef.current = state;

  const setState = useCallback<Dispatch<SetStateAction<DemoState>>>((update) => {
    if (!persistedModeRef.current) {
      setRawState(update);
      return;
    }
    if (mutationLockRef.current && !collectingSnapshotRef.current) return;
    const base = pendingDraftRef.current ?? stateRef.current;
    const next = typeof update === "function" ? update(base) : update;
    if (next === base) return;
    // Claim the mutation slot synchronously. Same-handler generic mutations compose into this
    // eager draft; explicit endpoints see the lock and cannot race the pending snapshot.
    mutationLockRef.current = true;
    collectingSnapshotRef.current = true;
    pendingDraftRef.current = next;
    stateRef.current = next;
    setRawState(next);
  }, []);

  const acceptRemoteState = useCallback((remote: DemoState) => {
    confirmedStateRef.current = remote;
    failedSnapshotRef.current = null;
    pendingDraftRef.current = null;
    skipRemoteSyncFor.current = remote;
    stateRef.current = remote;
    setRawState(remote);
    if (demoRepository.releaseDeletionGateAfterRemoteConsent(remote)) {
      void resumePersistentReminders(true).catch(() => undefined);
    }
  }, []);

  const syncSnapshot = useCallback(async (snapshot: DemoState): Promise<boolean> => {
    const generation = ++syncGeneration.current;
    collectingSnapshotRef.current = false;
    pendingDraftRef.current = null;
    mutationLockRef.current = true;
    setSyncStatus("saving");
    const result = await demoRepository.syncRemote(snapshot);
    if (result.ok) {
      if (generation !== syncGeneration.current) return true;
      const accepted = result.state ?? snapshot;
      confirmedStateRef.current = accepted;
      failedSnapshotRef.current = null;
      acceptRemoteState(accepted);
      collectingSnapshotRef.current = false;
      mutationLockRef.current = false;
      setSyncStatus("saved");
      setSyncError(undefined);
    } else {
      if (generation !== syncGeneration.current) return false;
      failedSnapshotRef.current = snapshot;
      collectingSnapshotRef.current = false;
      mutationLockRef.current = true;
      setSyncStatus("error");
      setSyncError(result.error);
    }
    return result.ok;
  }, [acceptRemoteState]);

  const beginExplicitMutation = useCallback((): number | null => {
    if (mutationLockRef.current) return null;
    const generation = ++syncGeneration.current;
    if (!persistedModeRef.current) return generation;
    collectingSnapshotRef.current = false;
    pendingDraftRef.current = null;
    mutationLockRef.current = true;
    setSyncStatus("saving");
    return generation;
  }, []);

  const completeExplicitMutation = useCallback((generation: number, remote: DemoState) => {
    if (generation !== syncGeneration.current) return false;
    remoteHydrated.current = true;
    acceptRemoteState(remote);
    collectingSnapshotRef.current = false;
    pendingDraftRef.current = null;
    mutationLockRef.current = false;
    setSyncStatus("saved");
    setSyncError(undefined);
    return true;
  }, [acceptRemoteState]);

  const completeLocalExplicitMutation = useCallback((
    generation: number,
    update: SetStateAction<DemoState>,
  ) => {
    if (generation !== syncGeneration.current) return false;
    const base = stateRef.current;
    const next = typeof update === "function" ? update(base) : update;
    if (next === base) {
      collectingSnapshotRef.current = false;
      pendingDraftRef.current = null;
      mutationLockRef.current = false;
      setSyncStatus(persistedModeRef.current ? "saved" : "local");
      setSyncError(undefined);
      return true;
    }
    stateRef.current = next;
    setRawState(next);
    collectingSnapshotRef.current = false;
    pendingDraftRef.current = null;
    if (persistedModeRef.current) {
      // A missing narrow endpoint falls back to an aggregate write immediately. Mark this
      // render for effect-skipping so there is one attached request and no transient unlock.
      skipRemoteSyncFor.current = next;
      void syncSnapshot(next);
    } else {
      mutationLockRef.current = false;
      setSyncStatus("local");
    }
    setSyncError(undefined);
    return true;
  }, [syncSnapshot]);

  const failExplicitMutation = useCallback((
    generation: number,
    error: unknown,
    fallback: string,
  ) => {
    if (generation !== syncGeneration.current) return;
    collectingSnapshotRef.current = false;
    pendingDraftRef.current = null;
    mutationLockRef.current = false;
    setSyncStatus("error");
    setSyncError(error instanceof Error ? error.message : fallback);
  }, []);

  useEffect(() => {
    demoRepository.save(state);
    if (!remoteHydrated.current) return;
    if (skipRemoteSyncFor.current === state) {
      skipRemoteSyncFor.current = null;
      return;
    }
    void syncSnapshot(state);
  }, [state, syncSnapshot]);

  useEffect(() => {
    if (!persistedModeRef.current) {
      mutationLockRef.current = false;
      setSyncStatus("local");
      return;
    }
    let active = true;
    const hydrationBase = stateRef.current;
    void demoRepository.hydrateRemote(hydrationBase).then((remote) => {
      if (!active || hydrationInvalidated.current) return;
      remoteHydrated.current = true;
      const liveState = stateRef.current;
      if (liveState !== hydrationBase) {
        if (remote) confirmedStateRef.current = remote;
        void syncSnapshot(liveState);
      } else if (remote) {
        // Hydration is a read, not a mutation: do not PUT the unchanged response back.
        acceptRemoteState(remote);
        mutationLockRef.current = false;
        setSyncStatus("saved");
        setSyncError(undefined);
      } else {
        void syncSnapshot(liveState);
      }
    }).catch(() => {
      if (!active) return;
      remoteHydrated.current = false;
      mutationLockRef.current = true;
      setSyncStatus("error");
      setSyncError("[hydrate] The encrypted demo record could not be loaded safely. No session state was uploaded; reload to try the read again.");
    });
    return () => { active = false; };
    // Hydrate once; subsequent updates use the sync method above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceptRemoteState, syncSnapshot]);

  useEffect(() => {
    const runBackgroundWork = () => {
      if (!remoteHydrated.current) return;
      setState((current) => applyScheduledBackgroundWork(applyPhotoRetention(current)));
    };
    runBackgroundWork();
    const interval = window.setInterval(runBackgroundWork, 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const showScheduledNotification = () => {
      if (!remoteHydrated.current) return;
      demoRepository.pruneNotificationMarkers(dateInTimeZone(new Date(), state.profile.timeZone));
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
      const notification = scheduledNotification(state);
      if (!notification) return;
      const key = `gutsy.notification.${notification.key}`;
      if (window.localStorage.getItem(key)) return;
      try {
        new Notification(notification.title, { body: notification.body, tag: notification.key });
        window.localStorage.setItem(key, "shown");
      } catch {
        // In-app reminders remain available if the browser blocks device notifications.
      }
    };
    showScheduledNotification();
    const interval = window.setInterval(showScheduledNotification, 60_000);
    return () => window.clearInterval(interval);
  }, [state]);

  const value = useMemo<DemoStore>(() => ({
    state,
    syncStatus,
    syncError,
    // The saving status is React state and therefore the render-stable public lock signal.
    // Include it so a lock claimed just before setSyncStatus cannot render a transiently
    // interactive drawer while the ref/value memo are crossing an async boundary.
    mutationsBlocked: syncStatus === "saving" || mutationLockRef.current,
    retryAvailable: failedSnapshotRef.current !== null,
    retrySync() {
      const pending = failedSnapshotRef.current;
      return pending ? syncSnapshot(pending) : Promise.resolve(false);
    },
    reset() {
      if (demoRepository.deletionGateActive()) {
        setSyncStatus("error");
        setSyncError("Reset is unavailable while patient-requested deletion is pending or awaiting fresh consent.");
        return;
      }
      mutationLockRef.current = false;
      collectingSnapshotRef.current = false;
      pendingDraftRef.current = null;
      failedSnapshotRef.current = null;
      demoRepository.clear();
      void demoRepository.resetRemote();
      setRawState(freshDemoState());
      setSyncStatus("local");
      setSyncError(undefined);
    },
    setDemoPhase(phase: PhaseId) {
      setState((current) => ({
        ...current,
        phase,
        pendingPhase: undefined,
        phaseConfirmed: false,
        experiment: phase === "stable" ? current.experiment : { ...current.experiment, status: current.experiment.status === "active" ? "paused" : current.experiment.status },
        audit: audit(current, `Demo state changed to ${phase}; this explicit demo control is not a clinical decision.`),
      }));
    },
    proposePhase(phase: PhaseId) {
      setState((current) => ({ ...current, pendingPhase: phase, phaseConfirmed: false, audit: audit(current, `A ${phase} phase transition was proposed for patient review.`) }));
    },
    confirmPhase() {
      setState((current) => {
        if (!hasActiveTrackingConsent(current)) return current;
        const derivedPhase = deriveLifecycleProposal({ ...current, phaseConfirmed: false }).proposedPhase;
        const phase = current.pendingPhase ?? derivedPhase;
        if (!phase || phase !== derivedPhase) return current;
        return {
          ...current,
          phase,
          pendingPhase: undefined,
          phaseConfirmed: true,
          experiment: phase === "stable" ? current.experiment : { ...current.experiment, status: current.experiment.status === "active" ? "paused" : current.experiment.status },
          audit: audit(current, `Patient confirmed the evidence-backed transition to ${phase}.`),
        };
      });
    },
    confirmCurrentPhase() {
      setState((current) => {
        if (!hasActiveTrackingConsent(current)) return current;
        const stableBaseline = canConfirmStableBaseline(current);
        if (!stableBaseline && !hasGovernedWatchEvidence(current)) return current;
        return {
          ...current,
          phaseConfirmed: true,
          pendingPhase: undefined,
          audit: audit(current, stableBaseline
            ? "Patient explicitly confirmed the complete maintained baseline as the governed Stable starting point."
            : "Patient confirmed the governed observations supporting the current watch view."),
        };
      });
    },
    addEntry(draft: JournalDraft) {
      const entry = entryFromDraft(draft, nextIntegerId(), state.profile.timeZone);
      setState((current) => withAddedEntry(current, entry));
      return entry;
    },
    async saveEntry(draft: JournalDraft) {
      if (!trackingIsActive(state)) return undefined;
      const generation = beginExplicitMutation();
      if (generation === null) return undefined;
      try {
        const saved = await demoRepository.addJournal(draft);
        if (saved) {
          return completeExplicitMutation(generation, saved.state) ? saved.entry : undefined;
        }
        const entry = entryFromDraft(draft, nextIntegerId(), stateRef.current.profile.timeZone);
        return completeLocalExplicitMutation(
          generation,
          (current) => withAddedEntry(current, entry),
        ) ? entry : undefined;
      } catch (error) {
        failExplicitMutation(generation, error, "The journal entry could not be saved.");
        return undefined;
      }
    },
    async updateEntry(id: number, patch: Partial<JournalEntry>) {
      const applyLocally = (current: DemoState): DemoState => {
        const entry = current.entries.find((item) => item.id === id);
        if (!entry) return current;
        if (isTaperAdherenceRecord(entry)) return current;
        const objectiveCareResult = entry.kind === "TEST RESULT" && entry.source === "care";
        if (
          (objectiveCareResult && Object.keys(patch).some((key) => key !== "excluded"))
          || (entry.kind !== "TEST RESULT" && patch.kind === "TEST RESULT")
        ) return current;
        const photoRemoved = Boolean(entry?.photo)
          && Object.prototype.hasOwnProperty.call(patch, "photo")
          && patch.photo == null;
        const experimentEvidence = entry.structured?.experimentId === current.experiment.id
          && ["check-in", "complete"].includes(String(entry.structured?.experimentEvent));
        const safePatch = experimentEvidence && patch.kind && patch.kind !== "LIFE EVENT"
          ? Object.fromEntries(Object.entries(patch).filter(([key]) => key !== "kind")) as Partial<JournalEntry>
          : patch;
        const entries = current.entries.map((item) => {
          if (item.id !== id) return item;
          let updated = { ...item, ...safePatch };
          if (item.source === "supporter" && item.excluded && safePatch.excluded === false) {
            updated = {
              ...updated,
              structured: {
                ...updated.structured,
                supporterReviewStatus: "included by patient",
              },
            };
          }
          if (photoRemoved && updated.structured?.imageObservationUnconfirmed) {
            const structured = { ...updated.structured };
            delete structured.imageObservationUnconfirmed;
            updated = { ...updated, structured };
          }
          if (patch.body !== undefined || patch.kind !== undefined) {
            const structured = applyExplicitRecordCorrections(updated, updated.body) ?? {};
            if (experimentEvidence) {
              const event = structured?.experimentEvent;
              const note = event === "check-in"
                ? updated.body.match(/:\s*(.+)$/)?.[1]?.trim()
                : updated.body.match(/(?:personal\s+)?outcome review(?:\s*\([^)]*\))?\s*:\s*(.+?)(?:\s+This is an observation|$)/i)?.[1]?.trim();
              if (note) structured.experimentObservation = note;
            }
            updated = { ...updated, structured, flagged: deriveEntryFlagged({ ...updated, structured }, current.profile) };
          }
          return updated;
        });
        const corrected = entries.find((item) => item.id === id);
        const urgentTriggers = corrected ? screenStructuredEntry(corrected, current.profile) : [];
        const changed = clinicalEvidenceChanged(entry) || clinicalEvidenceChanged(corrected);
        const experiment = experimentEvidence ? reconcileExperimentEvidence(current, entries) : current.experiment;
        const review = refreshedEvidenceReview(current, entries, changed, { experiment });
        const next = { ...current, entries, experiment, ...review };
        const alertSources = urgentTriggers.length
          ? [id]
          : current.safetyAlert?.sourceEntryIds?.includes(id)
            ? current.safetyAlert.sourceEntryIds
            : undefined;
        const safetyAlert = alertSources
          ? mergeSafetyAlert(current.safetyAlert, entries, current.profile, urgentTriggers.length ? [id] : [], [], "Corrected source records were re-screened by deterministic safety rules.")
          : current.safetyAlert;
        return {
          ...next,
          messages: current.messages.map((message) => ({ ...message, sources: message.sources?.map((source) => source.entryId === id && corrected ? { ...source, label: corrected.kind, date: `${corrected.date}, ${corrected.time}`, detail: corrected.body, excluded: corrected.excluded } : source) })),
          ...refreshedClinicianSummary(current, next, changed),
          safetyAlert,
          audit: audit(current, photoRemoved
            ? `The attached photo on journal entry ${id} was deleted while its text record was retained; downstream evidence was refreshed.${changed ? proposalAuditSuffix(next) : ""}`
            : `Journal entry ${id} was corrected; evidence links and the derived summary were refreshed.${changed ? proposalAuditSuffix(next) : ""}`),
        };
      };
      const entry = stateRef.current.entries.find((item) => item.id === id);
      if (!entry || isTaperAdherenceRecord(entry)) return false;
      const objectiveCareResult = entry.kind === "TEST RESULT" && entry.source === "care";
      if (
        (objectiveCareResult && Object.keys(patch).some((key) => key !== "excluded"))
        || (entry.kind !== "TEST RESULT" && patch.kind === "TEST RESULT")
      ) return false;
      const removesPhoto = Object.prototype.hasOwnProperty.call(patch, "photo")
        && patch.photo == null;
      if (!persistedModeRef.current || !removesPhoto) {
        if (persistedModeRef.current && mutationLockRef.current && !collectingSnapshotRef.current) return false;
        setState(applyLocally);
        return true;
      }
      const generation = beginExplicitMutation();
      if (generation === null) return false;
      try {
        const remote = await demoRepository.updateJournal(id, patch);
        return remote
          ? completeExplicitMutation(generation, remote)
          : completeLocalExplicitMutation(generation, applyLocally);
      } catch (error: unknown) {
        failExplicitMutation(generation, error, "The journal photo could not be deleted.");
        return false;
      }
    },
    async deleteEntry(id: number) {
      const applyLocally = (current: DemoState): DemoState => {
        const entry = current.entries.find((item) => item.id === id);
        if (!entry) return current;
        if (isTaperAdherenceRecord(entry)) return current;
        const entries = current.entries.filter((item) => item.id !== id);
        const experimentEvidence = entry?.structured?.experimentId === current.experiment.id
          && ["check-in", "complete"].includes(String(entry.structured?.experimentEvent));
        const experiment = experimentEvidence ? reconcileExperimentEvidence(current, entries) : current.experiment;
        const changed = clinicalEvidenceChanged(entry);
        const review = refreshedEvidenceReview(current, entries, changed, { experiment });
        const next = { ...current, entries, experiment, ...review };
        const safetyAlert = current.safetyAlert?.sourceEntryIds?.includes(id)
          ? mergeSafetyAlert(current.safetyAlert, entries, current.profile, [], [], "Remaining source records were re-screened after deletion.")
          : current.safetyAlert;
        return {
          ...next,
          messages: current.messages.map((message) => ({
            ...message,
            sources: message.sources?.map((source) => source.entryId === id
              ? { ...source, excluded: true, detail: "Source record deleted by the patient; this earlier reply may no longer reflect the retained record." }
              : source),
          })),
          ...refreshedClinicianSummary(current, next, changed),
          safetyAlert,
          audit: audit(current, `Journal entry ${id}, its media and downstream evidence links were deleted; the derived summary was refreshed.${changed ? proposalAuditSuffix(next) : ""}`),
        };
      };
      if (!persistedModeRef.current) {
        setState(applyLocally);
        return true;
      }
      const entry = stateRef.current.entries.find((item) => item.id === id);
      if (!entry || isTaperAdherenceRecord(entry)) return false;
      const generation = beginExplicitMutation();
      if (generation === null) return false;
      try {
        const remote = await demoRepository.deleteJournal(id);
        return remote
          ? completeExplicitMutation(generation, remote)
          : completeLocalExplicitMutation(generation, applyLocally);
      } catch (error: unknown) {
        failExplicitMutation(generation, error, "The journal entry could not be deleted.");
        return false;
      }
    },
    async sendChat(text: string) {
      const trimmed = text.trim();
      if (!trimmed) return false;
      const generation = beginExplicitMutation();
      if (generation === null) return false;
      try {
        const remote = await demoRepository.sendChat(trimmed);
        if (remote) {
          return completeExplicitMutation(generation, remote);
        }
      } catch (error) {
        failExplicitMutation(generation, error, "The message could not be saved.");
        return false;
      }
      const result = structureUtterance(text, { immunosuppressed: state.profile.immunosuppressed });
      const timestamp = new Date().toISOString();
      const mine = { id: nextIntegerId(), from: "me" as const, text: text.trim(), createdAt: timestamp };
      const entries = result.entries.map((draft) => entryFromDraft(draft, nextIntegerId(), state.profile.timeZone));
      const profileProposals = result.profileProposals.map((proposal) => ({
        ...proposal,
        id: nextIntegerId(),
        sourceMessageId: mine.id,
        status: "pending" as const,
        createdAt: timestamp,
      }));
      return completeLocalExplicitMutation(generation, (current) => {
        if (!current.profile.onboardingComplete || !current.profile.adultEligibilityConfirmed || !current.profile.healthDataConsent) return current;
        const journalAllowed = current.privacy.assistantJournalAccess;
        const profileAllowed = current.privacy.assistantProfileAccess;
        const pendingBloodEntry = current.entries.find((entry) => entry.structured?.needsClarification === "bloodAmount" && !entry.excluded);
        const bloodAmount = pendingBloodEntry ? parseBloodAmountClarification(text) : undefined;
        if (pendingBloodEntry && bloodAmount && journalAllowed) {
          const label = bloodAmount === "none"
            ? "no blood noticed"
            : bloodAmount === "unspecified"
              ? "blood amount still not sure"
              : `${bloodAmount} blood`;
          const entriesAfterClarification = current.entries.map((entry) => {
            if (entry.id !== pendingBloodEntry.id) return entry;
            const structured: NonNullable<JournalEntry["structured"]> = { ...entry.structured, blood: bloodAmount === "unspecified" ? "reported; amount not specified" : bloodAmount };
            delete structured.needsClarification;
            return {
              ...entry,
              body: entry.body.includes("blood (amount not specified)")
                ? entry.body.replace("blood (amount not specified)", label)
                : `${entry.body} · ${label}`,
              structured,
              flagged: bloodAmount !== "none",
            };
          });
          const corrected = entriesAfterClarification.find((entry) => entry.id === pendingBloodEntry.id)!;
          const urgentTriggers = screenStructuredEntry(corrected, current.profile);
          const review = refreshedEvidenceReview(current, entriesAfterClarification, true);
          const next = { ...current, entries: entriesAfterClarification, ...review };
          const reply = {
            id: nextIntegerId(),
            from: "penny" as const,
            createdAt: timestamp,
            category: urgentTriggers.length ? "general information" as const : "recorded fact" as const,
            text: urgentTriggers.length
              ? `${label[0].toUpperCase()}${label.slice(1)} is now recorded. The separate rules-based screen says ${safetyLevelForTriggers(urgentTriggers) === "emergency" ? "to use urgent care now" : "to contact your IBD team or GP today"}; do not wait for Penny or a team message.`
              : `Thanks — I updated the original bowel record to say ${label}. You can still correct or exclude it from the journal.`,
            sources: [{ entryId: corrected.id, label: corrected.kind, date: `${corrected.date}, ${corrected.time}`, detail: corrected.body, type: "fact" as const }],
          };
          return {
            ...next,
            ...refreshedClinicianSummary(current, next, true),
            messages: [...current.messages, mine, reply],
            safetyAlert: urgentTriggers.length || current.safetyAlert?.sourceEntryIds?.includes(corrected.id)
              ? mergeSafetyAlert(current.safetyAlert, entriesAfterClarification, current.profile, urgentTriggers.length ? [corrected.id] : [], [], "A clarified symptom detail was re-screened by deterministic safety rules.")
              : current.safetyAlert,
            audit: audit(current, `Patient clarified a decision-relevant blood amount on journal entry ${corrected.id}; evidence and deterministic safety were recomputed.${proposalAuditSuffix(next)}`),
          };
        }
        const savedEntries = journalAllowed ? entries : [];
        const savedProfileProposals = profileAllowed ? profileProposals : [];
        const evidenceChanged = savedEntries.some((entry) => clinicalEvidenceChanged(entry));
        const groundedReply = !result.safetyAlert && result.entries.length === 0 && result.profileProposals.length === 0 ? answerFromPermittedRecords(current, text) : null;
        const reply = { ...(groundedReply ?? result.reply), id: nextIntegerId(), createdAt: timestamp };
        const journalWriteBlocked = result.entries.length > 0 && !journalAllowed;
        const profileWriteBlocked = result.profileProposals.length > 0 && !profileAllowed;
        const safeReply = result.safetyAlert || (!journalWriteBlocked && !profileWriteBlocked) ? reply : {
          ...reply,
          category: "general information" as const,
          sources: [],
          text: journalWriteBlocked
            ? "Penny’s journal access is off, so I did not read or add to your journal. You can still use the manual quick-entry buttons. The separate urgent-wording screen remains active for safety."
            : "Penny’s profile access is off, so I did not create a medical-history proposal or change your PMH. You can add the wording manually under Profile.",
        };
        const nextEntries = [...savedEntries, ...current.entries];
        const safetySourceEntryIds = savedEntries
          .filter((entry) => screenStructuredEntry(entry, current.profile).length > 0)
          .map((entry) => entry.id);
        const review = refreshedEvidenceReview(current, nextEntries, evidenceChanged);
        const next = { ...current, entries: nextEntries, ...review };
        return {
          ...next,
          messages: [...current.messages, mine, safeReply],
          profileProposals: [...current.profileProposals, ...savedProfileProposals],
          ...(savedEntries.length ? refreshedClinicianSummary(current, next, evidenceChanged) : {}),
          safetyAlert: result.safetyAlert ? mergeSafetyAlert(
            current.safetyAlert,
            nextEntries,
            current.profile,
            safetySourceEntryIds,
            safetySourceEntryIds.length ? [] : result.safetyAlert.triggers,
            result.safetyAlert.message,
          ) : current.safetyAlert,
          audit: audit(current, result.safetyAlert
            ? `Deterministic safety screen matched: ${result.safetyAlert.triggers.join(", ")}.`
            : profileWriteBlocked
              ? "Penny respected disabled profile access; no PMH proposal or profile change was created."
              : savedProfileProposals.length
                ? `Chat capture prepared ${savedProfileProposals.length} patient-reviewable PMH proposal${savedProfileProposals.length === 1 ? "" : "s"}; the profile was not changed.`
                : journalAllowed
                  ? `Chat capture produced ${savedEntries.length} structured journal entries.${evidenceChanged ? proposalAuditSuffix(next) : ""}`
                  : "Penny respected disabled journal access; no journal record was read or created."),
        };
      });
    },
    async correctChatMessage(id: number, text: string) {
      const corrected = text.trim();
      if (!corrected || state.messages.find((message) => message.id === id)?.from !== "me") return false;
      const generation = beginExplicitMutation();
      if (generation === null) return false;
      try {
        const remote = await demoRepository.correctChatMessage(id, corrected);
        if (remote) {
          return completeExplicitMutation(generation, remote);
        } else {
          return completeLocalExplicitMutation(generation, (current) => ({
            ...current,
            messages: retractPatientMessageContext(
              current.messages.map((message) => message.id === id ? { ...message, text: corrected } : message),
              id,
              "The patient corrected the original wording. Linked journal records remain separately correctable, while this historical reply is retracted.",
            ),
            profileProposals: current.profileProposals.filter((proposal) => proposal.sourceMessageId !== id),
            audit: audit(current, `Patient corrected conversation message ${id}; stale PMH proposals and reply evidence links were retracted.`),
          }));
        }
      } catch (error) {
        failExplicitMutation(generation, error, "The conversation correction could not be saved.");
        return false;
      }
    },
    async deleteChatMessage(id: number) {
      if (!state.messages.some((message) => message.id === id)) return false;
      const generation = beginExplicitMutation();
      if (generation === null) return false;
      try {
        const remote = await demoRepository.deleteChatMessage(id);
        if (remote) {
          return completeExplicitMutation(generation, remote);
        } else {
          return completeLocalExplicitMutation(generation, (current) => {
            const removed = current.messages.find((message) => message.id === id);
            const retracted = removed?.from === "me"
              ? retractPatientMessageContext(
                  current.messages,
                  id,
                  "The patient deleted this source message. Linked journal records remain separately correctable, while this historical reply is retracted.",
                )
              : current.messages;
            return {
              ...current,
              messages: retracted.filter((message) => message.id !== id),
              profileProposals: removed?.from === "me"
                ? current.profileProposals.filter((proposal) => proposal.sourceMessageId !== id)
                : current.profileProposals,
              audit: audit(current, `Patient deleted individual conversation ${removed?.from === "me" ? "message" : "reply"} ${id}; dependent provenance was retracted.`),
            };
          });
        }
      } catch (error) {
        failExplicitMutation(generation, error, "The conversation message could not be deleted.");
        return false;
      }
    },
    resolveProfileProposal(id: number, status: "accepted" | "dismissed") {
      setState((current) => {
        const proposal = current.profileProposals.find((item) => item.id === id);
        if (!proposal || proposal.status !== "pending") return current;
        if (status === "accepted" && !String(current.profile[proposal.field]).toLocaleLowerCase().includes(proposal.value.toLocaleLowerCase())) return current;
        return {
          ...current,
          profileProposals: current.profileProposals.map((item) => item.id === id ? { ...item, status } : item),
          audit: audit(current, status === "accepted"
            ? "A patient reviewed and accepted a conversation-derived PMH proposal."
            : "A patient dismissed a conversation-derived PMH proposal; the profile was not changed."),
        };
      });
    },
    async updateProfile(patch: Partial<Profile>) {
      const applyLocally = (current: DemoState): DemoState => {
        const next = { ...current, profile: { ...current.profile, ...patch } };
        const baselineChanged = (["usualBowel", "usualPain", "usualHeartRate", "usualSleep"] as const)
          .some((field) => Object.prototype.hasOwnProperty.call(patch, field) && patch[field] !== current.profile[field]);
        const trackingActive = next.profile.onboardingComplete
          && next.profile.adultEligibilityConfirmed
          && next.profile.healthDataConsent;
        const consentSafeNext = trackingActive ? next : {
          ...next,
          wearable: { ...next.wearable, connected: false, lastSync: undefined },
          trustedSupporter: {
            ...next.trustedSupporter,
            enabled: false,
            canViewSummary: false,
            canSeeReminders: false,
            canHelpLog: false,
            accessCode: undefined,
            accessCreatedAt: undefined,
          },
          testOrder: next.testOrder.status === "prepared"
            ? { ...next.testOrder, addressConfirmed: false, consent: false }
            : next.testOrder,
        };
        const evidenceReview = baselineChanged
          ? refreshedEvidenceReview(current, consentSafeNext.entries, true, { profile: consentSafeNext.profile })
          : {};
        const reviewedWithProposal = { ...consentSafeNext, ...evidenceReview };
        const reviewed = baselineChanged && reviewedWithProposal.experiment.status === "active"
          ? {
              ...reviewedWithProposal,
              experiment: {
                ...reviewedWithProposal.experiment,
                status: "paused" as const,
              },
            }
          : reviewedWithProposal;
        return {
          ...reviewed,
          ...refreshedClinicianSummary(current, reviewed, baselineChanged),
          audit: audit(current, !trackingActive
            ? "Health-data tracking was paused and wearable ingestion was disconnected."
            : baselineChanged
              ? `Patient baseline changed; prior evidence confirmation was invalidated and lifecycle evidence was recomputed.${proposalAuditSuffix(reviewed)}`
              : "Patient profile, PMH and the derived summary were updated."),
        };
      };
      const activeProfile = stateRef.current.profile;
      const withdrawsActiveConsent = (
        activeProfile.healthDataConsent && patch.healthDataConsent === false
      ) || (
        activeProfile.adultEligibilityConfirmed && patch.adultEligibilityConfirmed === false
      );
      if (persistedModeRef.current && withdrawsActiveConsent) {
        // Consent withdrawal is one authoritative narrow mutation. Its queued GET refreshes
        // both the aggregate and ETag, and no pre-withdrawal snapshot is PUT afterwards.
        const generation = beginExplicitMutation();
        if (generation === null) return false;
        try {
          const remote = await demoRepository.withdrawHealthConsent({
            ...patch,
            onboardingComplete: false,
          });
          return remote
            ? completeExplicitMutation(generation, remote)
            : completeLocalExplicitMutation(generation, applyLocally);
        } catch (error) {
          failExplicitMutation(generation, error, "Health-data consent could not be withdrawn.");
          return false;
        }
      }
      if (persistedModeRef.current && mutationLockRef.current && !collectingSnapshotRef.current) return false;
      setState(applyLocally);
      return true;
    },
    updateContacts(contacts: CareContact[]) {
      setState((current) => {
        return {
          ...current,
          contacts,
          audit: audit(current, "Patient-maintained care contact routes were updated without changing clinician-authored prescription provenance."),
        };
      });
    },
    updateTrustedSupporter(patch: Partial<TrustedSupporter>) {
      setState((current) => {
        const expandsAccess = patch.enabled === true
          || patch.canViewSummary === true
          || patch.canSeeReminders === true
          || patch.canHelpLog === true;
        if (!trackingIsActive(current) && expandsAccess) return current;
        const trustedSupporter = { ...current.trustedSupporter, ...patch };
        if (patch.enabled === false) {
          trustedSupporter.canViewSummary = false;
          trustedSupporter.canSeeReminders = false;
          trustedSupporter.canHelpLog = false;
          trustedSupporter.accessCode = undefined;
          trustedSupporter.accessCreatedAt = undefined;
        }
        return { ...current, trustedSupporter, audit: audit(current, `Optional trusted-supporter access ${patch.enabled === false ? "disabled" : "updated"}.`) };
      });
    },
    async generateSupporterInvitation(): Promise<SupporterView | undefined> {
      if (!trackingIsActive(state) || !state.trustedSupporter.enabled) return undefined;
      const generation = beginExplicitMutation();
      if (generation === null) return undefined;
      try {
        const remote = await demoRepository.createSupporterInvitation();
        const accessCode = remote?.trustedSupporter.accessCode;
        if (!remote || !accessCode) throw new Error("The persisted API did not create a supporter access code.");
        if (!completeExplicitMutation(generation, remote)) return undefined;
        const view = await demoRepository.supporterView(accessCode);
        return view ?? undefined;
      } catch (error) {
        failExplicitMutation(generation, error, "The supporter access code could not be created.");
        return undefined;
      }
    },
    async revokeSupporterInvitation() {
      const generation = beginExplicitMutation();
      if (generation === null) return false;
      try {
        const remote = await demoRepository.revokeSupporterInvitation();
        if (!remote) throw new Error("The persisted API is required to revoke the supporter access code.");
        return completeExplicitMutation(generation, remote);
      } catch (error) {
        failExplicitMutation(generation, error, "The supporter access code could not be revoked.");
        return false;
      }
    },
    async loadSupporterView(accessCode: string) {
      try {
        return (await demoRepository.supporterView(accessCode)) ?? undefined;
      } catch (error) {
        setSyncStatus("error");
        setSyncError(error instanceof Error ? error.message : "The supporter demo view could not be opened.");
        return undefined;
      }
    },
    async submitSupporterLog(accessCode: string, text: string) {
      if (!text.trim()) return undefined;
      const generation = beginExplicitMutation();
      if (generation === null) return undefined;
      try {
        const result = await demoRepository.supporterLog(accessCode, text.trim());
        if (!result) throw new Error("The persisted API is required for supporter-attributed logging.");
        return completeExplicitMutation(generation, result.state) ? result.view : undefined;
      } catch (error) {
        failExplicitMutation(generation, error, "The supporter log could not be saved.");
        return undefined;
      }
    },
    updateTest(patch: Partial<TestOrder>) {
      setState((current) => {
        if (!trackingIsActive(current)) return current;
        const { statusUpdatedAt: _ignoredStatusTime, ...requestedPatch } = patch;
        if (current.testOrder.status === "prepared" && requestedPatch.status === "ordered") {
          const order = { ...current.testOrder, ...requestedPatch };
          if (
            !hasGovernedWatchEvidence(current)
            || !current.phaseConfirmed
            || current.pendingPhase
            || requestedPatch.addressConfirmed !== true
            || requestedPatch.consent !== true
            || !order.addressConfirmed
            || !order.consent
          ) return current;
        }
        const statusChanged = Boolean(requestedPatch.status && requestedPatch.status !== current.testOrder.status);
        const governedPatch = {
          ...requestedPatch,
          ...(statusChanged ? { statusUpdatedAt: new Date().toISOString() } : {}),
        };
        const next = { ...current, testOrder: { ...current.testOrder, ...governedPatch } };
        const review = refreshedEvidenceReview(next, next.entries, requestedPatch.result !== undefined);
        const reviewed = { ...next, ...review };
        return {
          ...reviewed,
          ...refreshedClinicianSummary(current, reviewed, requestedPatch.result !== undefined),
          audit: audit(current, `Test workflow and derived summary updated: ${requestedPatch.status ?? "details confirmed"}.${requestedPatch.result !== undefined ? proposalAuditSuffix(reviewed) : ""}`),
        };
      });
    },
    updateTeamMessage(patch: Partial<TeamMessage>) {
      setState((current) => {
        if (!trackingIsActive(current)) return current;
        const { sentAt: _ignoredSentAt, statusUpdatedAt: _ignoredStatusTime, ...requestedPatch } = patch;
        const startsNewDraft = Boolean(requestedPatch.id && requestedPatch.id !== current.teamMessage.id);
        if (startsNewDraft) {
          const archivableStatus = (["sent", "read", "replied"] as const).includes(current.teamMessage.status as "sent" | "read" | "replied");
          const unresolvedExperimentReview = current.experiment.reviewRequestMessageId === current.teamMessage.id
            && !current.experiment.reviewApprovedAt
            && (current.teamMessage.status === "sent" || current.teamMessage.status === "read");
          if (!archivableStatus || unresolvedExperimentReview || requestedPatch.status !== "draft" || requestedPatch.reply) return current;
          return {
            ...current,
            teamMessage: {
              ...current.teamMessage,
              ...requestedPatch,
              sentAt: undefined,
              statusUpdatedAt: new Date().toISOString(),
              notificationReason: requestedPatch.notificationReason
                ?? "Patient explicitly prepared a follow-up draft from currently included records; nothing is sent until every word is reviewed.",
            },
            teamMessageHistory: [current.teamMessage, ...current.teamMessageHistory],
            teamMessageStale: false,
            audit: audit(current, "The prior sent clinician-message state was preserved and a new editable draft was prepared; nothing was sent."),
          };
        }
        const statuses: TeamMessage["status"][] = ["draft", "sent", "read", "replied"];
        const requestedStatus = requestedPatch.status ?? current.teamMessage.status;
        if (
          current.teamMessage.status === "draft"
          && requestedStatus === "sent"
          && (
            current.teamMessage.notificationRule === "Not configured"
            || current.teamMessage.clinicalOwner.startsWith("Not configured")
          )
        ) return current;
        const currentIndex = statuses.indexOf(current.teamMessage.status);
        const requestedIndex = statuses.indexOf(requestedStatus);
        if (requestedIndex < currentIndex || requestedIndex > currentIndex + 1) return current;
        if (current.teamMessageStale && requestedStatus !== "draft") return current;
        if (current.teamMessage.status !== "draft" && (requestedPatch.subject !== undefined || requestedPatch.body !== undefined || requestedPatch.expectedResponse !== undefined)) return current;
        if (current.teamMessage.reply && requestedPatch.reply !== undefined && requestedPatch.reply !== current.teamMessage.reply) return current;
        if (requestedPatch.reply !== undefined && requestedStatus !== "replied") return current;
        if (requestedStatus === "replied" && !(requestedPatch.reply ?? current.teamMessage.reply)) return current;
        const statusChanged = requestedStatus !== current.teamMessage.status;
        const transitionedAt = statusChanged ? new Date().toISOString() : current.teamMessage.statusUpdatedAt;
        const teamMessage = {
          ...current.teamMessage,
          ...requestedPatch,
          status: requestedStatus,
          ...(statusChanged ? { statusUpdatedAt: transitionedAt } : {}),
          ...(current.teamMessage.status === "draft" && requestedStatus === "sent"
            ? { sentAt: transitionedAt }
            : {}),
        };
        return {
          ...current,
          teamMessage,
          audit: audit(current, `Clinician message updated: ${requestedPatch.status ?? "draft edited"}.`),
        };
      });
    },
    refreshTeamMessage() {
      setState((current) => {
        if (!trackingIsActive(current) || current.teamMessage.status !== "draft") return current;
        return {
          ...current,
          teamMessage: { ...current.teamMessage, body: buildClinicianSummary(current) },
          teamMessageStale: false,
          audit: audit(current, "Patient explicitly refreshed the clinician-message draft from currently included records."),
        };
      });
    },
    updatePrescription(patch: Partial<PrescriptionFlow>) {
      setState((current) => {
        if (!trackingIsActive(current)) return current;
        if (current.prescription.status === "prepared" && patch.status === "requested" && !(
          current.phase === "flare"
          && current.phaseConfirmed
          && !current.pendingPhase
          && current.prescription.rescuePlanEligible
          && hasIncludedRaisedTestEvidence(current)
        )) return current;
        const collecting = patch.status === "collected";
        if (collecting && (
          current.prescription.status !== "ready"
          || current.prescription.treatmentStartedAt
          || !current.taper.days.length
        )) return current;
        const governedPatch = collecting
          ? { ...patch, treatmentStartedAt: new Date().toISOString() }
          : patch;
        const next: DemoState = {
          ...current,
          prescription: { ...current.prescription, ...governedPatch },
          ...(collecting ? { taper: anchorTaperAtCollection(current.taper, current.profile.timeZone) } : {}),
        };
        const proposedPhase = deriveLifecycleProposal(next).proposedPhase;
        return {
          ...next,
          ...(proposedPhase ? { pendingPhase: proposedPhase, phaseConfirmed: false } : {}),
          ...refreshedClinicianSummary(current, next),
          audit: audit(current, `Prescriber-owned workflow updated: ${patch.status ?? "details reviewed"}.${collecting ? " The unchanged schedule was anchored to collection day, prior adherence was cleared, and the patient must verify it again." : ""}${proposedPhase ? ` ${proposedPhase} support is ready for patient review.` : ""}`),
        };
      });
    },
    updateTaper(patch: Partial<Taper>) {
      setState((current) => {
        if (!trackingIsActive(current)) return current;
        const adherencePatch = patch.snoozedUntil !== undefined
          || patch.sideEffects !== undefined
          || patch.checkInComplete !== undefined;
        if (adherencePatch && !taperTreatmentActive(current)) return current;
        const recordedCheckIn = patch.checkInComplete === true && patch.sideEffects !== undefined;
        const worsening = recordedCheckIn && patch.sideEffects!.includes("Symptoms worsening again");
        const checkInEntry = recordedCheckIn ? entryFromDraft({
          kind: "WELLBEING",
          body: `Steroid recovery check-in: ${patch.sideEffects!.length ? patch.sideEffects!.join(", ") : "no side-effect concerns selected"}`,
          source: "manual",
          flagged: false,
          structured: {
            taperCheckIn: true,
            wellbeing: worsening ? "worse" : "same",
            infectionConcern: patch.sideEffects!.includes("Possible infection"),
            moodConcern: patch.sideEffects!.includes("Mood change"),
            newSwellingConcern: patch.sideEffects!.includes("New swelling"),
            symptomsWorse: Boolean(worsening),
          },
        }, nextIntegerId(), current.profile.timeZone) : undefined;
        const checkInTriggers = checkInEntry ? screenStructuredEntry(checkInEntry, current.profile) : [];
        if (checkInEntry) checkInEntry.flagged = checkInTriggers.length > 0;
        const entries = checkInEntry ? [checkInEntry, ...current.entries] : current.entries;
        const next = { ...current, entries, taper: { ...current.taper, ...patch } };
        const review = checkInEntry ? refreshedEvidenceReview(next, entries, true) : {};
        const reviewed = { ...next, ...review };
        return {
          ...reviewed,
          ...refreshedClinicianSummary(current, reviewed),
          safetyAlert: checkInEntry && checkInTriggers.length ? mergeSafetyAlert(
            current.safetyAlert,
            entries,
            current.profile,
            [checkInEntry.id],
            [],
            "A steroid check-in concern matched the deterministic same-day safety route. Contact your pharmacist, prescriber or IBD team today.",
          ) : current.safetyAlert,
          audit: audit(current, `Verified taper support and the derived recovery summary were updated without changing prescribed doses.${checkInEntry ? " The dated check-in was added to relapse evidence." : ""}`),
        };
      });
    },
    markDoseTaken() {
      setState((current) => {
        if (!trackingIsActive(current)) return current;
        const patientToday = today(current.profile.timeZone);
        const dose = current.taper.days.find((day) => day.date === patientToday);
        if (!taperTreatmentActive(current) || !current.taper.verified || !dose || dose.taken || current.taper.missedDays.includes(dose.day)) return current;
        const medicationEntry = entryFromDraft({ kind: "MEDICATION", body: `${dose.doseMg} mg ${current.taper.medicine} taken — prescribed taper day ${dose.day}`, source: "manual", structured: { doseMg: dose.doseMg, taken: true, taperDay: dose.day, scheduledDate: dose.date } }, nextIntegerId(), current.profile.timeZone);
        const next: DemoState = {
          ...current,
          taper: { ...current.taper, currentDay: dose.day, snoozedUntil: undefined, days: current.taper.days.map((day) => day.day === dose.day ? { ...day, taken: true } : day) },
          entries: [medicationEntry, ...current.entries],
          audit: audit(current, `Patient confirmed prescribed taper dose ${dose.doseMg} mg as taken.`),
        };
        const proposedPhase = deriveLifecycleProposal(next).proposedPhase;
        return {
          ...next,
          ...(proposedPhase ? { pendingPhase: proposedPhase, phaseConfirmed: false } : {}),
          ...refreshedClinicianSummary(current, next),
        };
      });
    },
    markDoseMissed(dayNumber: number) {
      setState((current) => {
        if (!trackingIsActive(current)) return current;
        const dose = current.taper.days.find((day) => day.day === dayNumber);
        if (!taperTreatmentActive(current) || !current.taper.verified || !dose || dose.taken || dose.date >= today(current.profile.timeZone) || current.taper.missedDays.includes(dayNumber)) return current;
        const medicationEntry = entryFromDraft({
          kind: "MEDICATION",
          body: `Prescribed taper day ${dose.day} (${dose.doseMg} mg ${current.taper.medicine}) reconciled as not taken`,
          source: "manual",
          flagged: true,
          structured: { doseMg: dose.doseMg, taken: false, missed: true, taperDay: dose.day, scheduledDate: dose.date },
        }, nextIntegerId(), current.profile.timeZone);
        const next: DemoState = {
          ...current,
          taper: {
            ...current.taper,
            missedDays: [...current.taper.missedDays, dose.day].sort((left, right) => left - right),
          },
          entries: [medicationEntry, ...current.entries],
          audit: audit(current, `Patient reconciled past prescribed taper day ${dose.day} as not taken; no dose or future schedule changed.`),
        };
        const proposedPhase = deriveLifecycleProposal(next).proposedPhase;
        return {
          ...next,
          ...(proposedPhase ? { pendingPhase: proposedPhase, phaseConfirmed: false } : {}),
          ...refreshedClinicianSummary(current, next),
        };
      });
    },
    correctDoseRecord(dayNumber: number, fact: "taken" | "missed") {
      setState((current) => {
        const dose = current.taper.days.find((day) => day.day === dayNumber);
        const factIsRecorded = fact === "taken"
          ? Boolean(dose?.taken)
          : current.taper.missedDays.includes(dayNumber);
        if (!dose || !factIsRecorded) return current;
        const matchesOriginal = (entry: JournalEntry) => (
          entry.kind === "MEDICATION"
          && !entry.excluded
          && entry.structured?.taperDay === dayNumber
          && (fact === "taken" ? entry.structured.taken === true : entry.structured.missed === true)
        );
        if (!current.entries.some(matchesOriginal)) return current;
        const correction = entryFromDraft({
          kind: "MEDICATION",
          body: `Correction: prescribed taper day ${dayNumber} was marked ${fact === "taken" ? "taken" : "not taken"} by mistake; that patient-entered adherence fact is retracted. The prescribed schedule is unchanged.`,
          source: "manual",
          flagged: false,
          excluded: false,
          structured: {
            adherenceCorrection: true,
            correctedFact: fact,
            doseMg: dose.doseMg,
            taperDay: dayNumber,
            scheduledDate: dose.date,
          },
        }, nextIntegerId(), current.profile.timeZone);
        const entries = [
          correction,
          ...current.entries.map((entry) => matchesOriginal(entry) ? { ...entry, excluded: true } : entry),
        ];
        const taper: Taper = fact === "taken"
          ? {
              ...current.taper,
              days: current.taper.days.map((day) => day.day === dayNumber ? { ...day, taken: false } : day),
            }
          : {
              ...current.taper,
              missedDays: current.taper.missedDays.filter((day) => day !== dayNumber),
            };
        const next: DemoState = { ...current, entries, taper };
        const proposedPhase = deriveLifecycleProposal(next).proposedPhase;
        return {
          ...next,
          ...(proposedPhase ? { pendingPhase: proposedPhase, phaseConfirmed: false } : {}),
          ...refreshedClinicianSummary(current, next),
          audit: audit(current, `Patient retracted taper day ${dayNumber} ${fact} adherence fact as marked by mistake; the clinician-authored schedule was unchanged.`),
        };
      });
    },
    async importClinicalPlan() {
      if (!trackingIsActive(state)) return false;
      const generation = beginExplicitMutation();
      if (generation === null) return false;
      try {
        const imported = await demoRepository.importClinicalPlan();
        if (!imported) {
          throw new Error("The clinician-plan simulation requires the persisted API.");
        }
        return completeExplicitMutation(generation, imported);
      } catch (error) {
        failExplicitMutation(generation, error, "The clinician plan could not be imported.");
        return false;
      }
    },
    updateExperiment(patch: Partial<Experiment>) {
      setState((current) => {
        if (!trackingIsActive(current)) return current;
        const requestedStatus = patch.status;
        const replacingCandidate = Boolean(patch.id && patch.id !== current.experiment.id);
        const definitionChanged = replacingCandidate || (["title", "variable", "goal", "baseline", "outcome", "durationDays"] as const)
          .some((key) => patch[key] !== undefined && patch[key] !== current.experiment[key]);
        const immutableDefinitionChange = definitionChanged && Boolean(
          current.experiment.status === "active"
          || current.experiment.status === "complete"
          || current.experiment.day > 0
          || current.experiment.startDate
          || current.experiment.observations.length,
        );
        const definitionSafePatch = immutableDefinitionChange
          ? Object.fromEntries(Object.entries(patch).filter(([key]) => !["id", "title", "variable", "goal", "baseline", "outcome", "durationDays"].includes(key))) as Partial<Experiment>
          : patch;
        const incomingCandidate = { ...current.experiment, ...definitionSafePatch };
        const incomingReviewRequired = (definitionSafePatch.reviewRequired ?? current.experiment.reviewRequired) || experimentRequiresReview(incomingCandidate, current.profile);
        const requestedReviewMessageId = definitionSafePatch.reviewRequestMessageId;
        const validReviewRequest = Boolean(
          requestedReviewMessageId
          && incomingReviewRequired
          && incomingCandidate.status !== "active"
          && incomingCandidate.status !== "complete"
          && experimentReviewRequestMessage(current, requestedReviewMessageId),
        );
        const retainedRequestMessageId = !incomingReviewRequired
          ? undefined
          : definitionChanged
          ? undefined
          : validReviewRequest
            ? requestedReviewMessageId
            : current.experiment.reviewRequestMessageId;
        const approvalCandidate: Experiment = {
          ...incomingCandidate,
          reviewRequired: incomingReviewRequired,
          reviewRequestMessageId: retainedRequestMessageId,
        };
        const validNewApproval = Boolean(
          definitionSafePatch.reviewApprovedAt
          && !definitionChanged
          && !current.experiment.reviewApprovedAt
          && incomingReviewRequired
          && incomingCandidate.status !== "active"
          && incomingCandidate.status !== "complete"
          && definitionSafePatch.reviewApprovedBy === SIMULATED_EXPERIMENT_REVIEWER
          && experimentReviewThread({ ...current, experiment: approvalCandidate }),
        );
        const reviewApprovedAt = !incomingReviewRequired || definitionChanged
          ? undefined
          : validNewApproval
            ? definitionSafePatch.reviewApprovedAt
            : current.experiment.reviewApprovedAt;
        const reviewApprovedBy = reviewApprovedAt
          ? (validNewApproval ? SIMULATED_EXPERIMENT_REVIEWER : current.experiment.reviewApprovedBy)
          : undefined;
        const validStartState = current.experiment.status === "suggested" || current.experiment.status === "paused";
        const blockedByPhase = requestedStatus === "active" && (current.phase !== "stable" || !current.phaseConfirmed || Boolean(current.pendingPhase));
        const blockedByReview = requestedStatus === "active" && incomingReviewRequired && !reviewApprovedAt;
        const blockedByStatus = requestedStatus === "active" && !validStartState;
        const blockedByDefinition = requestedStatus === "active" && ![incomingCandidate.title, incomingCandidate.variable, incomingCandidate.goal, incomingCandidate.baseline, incomingCandidate.outcome].every((value) => value.trim());
        const startBlocked = blockedByPhase || blockedByReview || blockedByStatus || blockedByDefinition;
        const observationsPreserveHistory = replacingCandidate
          || !definitionSafePatch.observations
          || (definitionSafePatch.observations.length >= current.experiment.observations.length
            && definitionSafePatch.observations.slice(0, current.experiment.observations.length)
              .every((item, index) => item === current.experiment.observations[index]));
        const addedObservations = observationsPreserveHistory
          ? definitionSafePatch.observations?.slice(current.experiment.observations.length).filter((item) => item.trim()) ?? []
          : [];
        const checkInDates = experimentCheckInDates(current);
        const requestedDay = definitionSafePatch.day ?? current.experiment.day;
        const attemptedAdvance = requestedDay > current.experiment.day;
        const validAdvance = attemptedAdvance
          && requestedDay === current.experiment.day + 1
          && current.experiment.status === "active"
          && current.experiment.day === checkInDates.length
          && addedObservations.length === 1
          && !hasExperimentCheckInOnDate(current, today(current.profile.timeZone))
          && requestedDay <= current.experiment.durationDays;
        const completionBlocked = requestedStatus === "complete" && (
          current.experiment.status !== "active"
          || current.experiment.day < current.experiment.durationDays
          || checkInDates.length < current.experiment.durationDays
          || addedObservations.length !== 1
        );
        const governedPatch: Partial<Experiment> = {
          ...definitionSafePatch,
          reviewRequired: incomingReviewRequired,
          reviewRequestMessageId: retainedRequestMessageId,
          reviewApprovedAt,
          reviewApprovedBy,
          ...(!observationsPreserveHistory || (attemptedAdvance && !validAdvance)
            ? { day: current.experiment.day, observations: current.experiment.observations }
            : {}),
        };
        const safePatch: Partial<Experiment> = startBlocked
          ? { ...governedPatch, status: current.experiment.status, startDate: current.experiment.startDate, day: current.experiment.day }
          : completionBlocked
            ? { ...governedPatch, status: current.experiment.status, observations: current.experiment.observations }
            : governedPatch;
        const durationDays = Number.isFinite(safePatch.durationDays) ? Math.max(1, Math.round(safePatch.durationDays!)) : current.experiment.durationDays;
        const safeRequestedDay = safePatch.day ?? current.experiment.day;
        const experiment: Experiment = {
          ...current.experiment,
          ...safePatch,
          durationDays,
          day: Math.max(0, Math.min(durationDays, Math.round(safeRequestedDay))),
        };
        if (experiment.status === "active" && experiment.reviewRequired && !experiment.reviewApprovedAt) experiment.status = "paused";

        const becameActive = experiment.status === "active" && current.experiment.status !== "active";
        const advancedDay = experiment.day > current.experiment.day;
        const becameComplete = experiment.status === "complete" && current.experiment.status !== "complete";
        const replacedCandidate = Boolean(definitionSafePatch.id && definitionSafePatch.id !== current.experiment.id && current.experiment.id);
        const eventEntries: JournalEntry[] = [];

        if (replacedCandidate) {
          eventEntries.push(entryFromDraft({
            kind: "LIFE EVENT",
            body: `Diet experiment archived: ${current.experiment.title} at day ${current.experiment.day} of ${current.experiment.durationDays}. Its personal observations remain in the journal and audit history.`,
            source: "manual",
            structured: { experimentEvent: "archived", experimentId: current.experiment.id },
          }, nextIntegerId(), current.profile.timeZone));
        }
        if (becameActive) {
          eventEntries.push(entryFromDraft({
            kind: "LIFE EVENT",
            body: `Diet experiment started: ${experiment.title}. ${current.experiment.status === "paused" ? `Resumed at day ${experiment.day}` : "Started at day 0"} of ${experiment.durationDays}; one variable is ${experiment.variable}; the recorded pre-start baseline is ${experiment.baseline}; the predefined outcome is ${experiment.outcome}.`,
            source: "manual",
            structured: { experimentEvent: "start", experimentId: experiment.id, day: experiment.day, durationDays: experiment.durationDays },
          }, nextIntegerId(), current.profile.timeZone));
        }
        if (advancedDay) {
          const checkIn = addedObservations.at(-1)?.replace(/^Day\s+\d+\s*:\s*/i, "") ?? "Daily observation recorded";
          eventEntries.push(entryFromDraft({
            kind: "LIFE EVENT",
            body: `Diet experiment check-in — day ${experiment.day} of ${experiment.durationDays}: ${checkIn}`,
            source: "manual",
            structured: { experimentEvent: "check-in", experimentId: experiment.id, experimentObservation: checkIn, day: experiment.day, durationDays: experiment.durationDays },
          }, nextIntegerId(), current.profile.timeZone));
        }
        if (becameComplete) {
          const review = addedObservations.at(-1)?.replace(/^Outcome review\s*\([^)]*\)\s*:\s*/i, "") ?? "Outcome review recorded";
          eventEntries.push(entryFromDraft({
            kind: "LIFE EVENT",
            body: `Diet experiment completed: ${experiment.title}. Personal outcome review: ${review} This is an observation for this person and period, not proof of cause or treatment.`,
            source: "manual",
            structured: { experimentEvent: "complete", experimentId: experiment.id, experimentObservation: review, day: experiment.day, durationDays: experiment.durationDays },
          }, nextIntegerId(), current.profile.timeZone));
        }

        const entries = [...eventEntries.reverse(), ...current.entries];
        const next = { ...current, experiment, entries };
        const auditAction = immutableDefinitionChange
          ? "Diet experiment definition edit was blocked while the candidate is active."
          : validNewApproval
            ? "Simulation: eligible IBD-team review approval was recorded for the unchanged experiment candidate."
            : attemptedAdvance && !validAdvance
              ? "A duplicate or out-of-sequence experiment check-in was blocked; progress advances once per calendar day."
              : startBlocked
          ? blockedByPhase
            ? "Diet experiment start was blocked because symptoms or treatment are changing."
            : blockedByReview
              ? "Diet experiment start was blocked pending dietitian or IBD-team review."
              : "Diet experiment start was blocked from its current workflow state."
          : completionBlocked
            ? "Diet experiment completion was blocked until every configured calendar-day check-in and a patient outcome review are recorded."
            : `Diet experiment updated: ${experiment.status}. Shared timeline and derived summary refreshed.`;
        return {
          ...next,
          ...refreshedClinicianSummary(current, next),
          audit: audit(current, auditAction),
        };
      });
    },
    updateWearable(patch: Partial<WearableSettings>) {
      setState((current) => {
        const startsIngestion = patch.connected === true
          || patch.heartRate === true
          || patch.hrv === true
          || patch.sleep === true
          || patch.activity === true;
        if (!trackingIsActive(current) && startsIngestion) return current;
        return { ...current, wearable: { ...current.wearable, ...patch }, audit: audit(current, `Wearable ${patch.connected === false ? "disconnected" : "settings updated"}.`) };
      });
    },
    updatePrivacy(patch: Partial<PrivacySettings>) {
      const applyLocally = (current: DemoState): DemoState => ({
        ...current,
        privacy: { ...current.privacy, ...patch },
        entries: patch.toiletPhotoConsent === false ? current.entries.map((entry) => {
          if (entry.photo?.purpose !== "toilet") return entry;
          const { photo: _removedPhoto, ...record } = entry;
          return { ...record, structured: { ...record.structured, mediaRemovedAfterConsentWithdrawal: true } };
        }) : current.entries,
        audit: audit(current, patch.toiletPhotoConsent === false ? "Toilet-photo consent was withdrawn and existing toilet image payloads were removed." : "Privacy or notification controls were updated."),
      });
      if (!persistedModeRef.current) {
        setState(applyLocally);
        return;
      }
      const generation = beginExplicitMutation();
      if (generation === null) return;
      void demoRepository.updatePrivacy(patch).then((remote) => {
        if (remote) completeExplicitMutation(generation, remote);
        else completeLocalExplicitMutation(generation, applyLocally);
      }).catch((error: unknown) => {
        failExplicitMutation(generation, error, "Privacy controls could not be saved.");
      });
    },
    updateSummary(clinicianSummary: string) {
      setState((current) => ({
        ...current,
        clinicianSummary,
        clinicianSummaryEdited: true,
        clinicianSummaryStale: false,
        audit: audit(current, "Clinician summary draft was edited by the patient."),
      }));
    },
    regenerateSummary() {
      setState((current) => ({
        ...current,
        clinicianSummary: buildClinicianSummary(current),
        clinicianSummaryEdited: false,
        clinicianSummaryStale: false,
        audit: audit(current, "Patient explicitly regenerated the clinician summary from currently included records."),
      }));
    },
    clearConversation() {
      setState((current) => ({ ...current, messages: [], profileProposals: [], audit: audit(current, "Conversation history and its PMH proposal drafts were deleted; accepted profile fields were retained.") }));
    },
    async clearSafetyAlert() {
      const generation = beginExplicitMutation();
      if (generation === null) return false;
      try {
        const remote = await demoRepository.acknowledgeSafetyAlert();
        if (remote) {
          return completeExplicitMutation(generation, remote);
        } else {
          return completeLocalExplicitMutation(
            generation,
            (current) => ({ ...current, safetyAlert: undefined }),
          );
        }
      } catch (error) {
        failExplicitMutation(generation, error, "The safety guidance could not be acknowledged.");
        return false;
      }
    },
    async clearAllData() {
      // Permanently tombstone the mount-time read before changing local state. Its response may
      // already be in flight and must never be allowed to resurrect the pre-deletion aggregate.
      hydrationInvalidated.current = true;
      remoteHydrated.current = false;
      syncGeneration.current += 1;
      mutationLockRef.current = true;
      collectingSnapshotRef.current = false;
      pendingDraftRef.current = null;
      failedSnapshotRef.current = null;
      const cleared = emptyDemoState();
      confirmedStateRef.current = cleared;
      skipRemoteSyncFor.current = cleared;
      stateRef.current = cleared;
      demoRepository.beginDeletion();
      const reminderSuspension = suspendPersistentReminders();
      setRawState(cleared);
      await reminderSuspension;
      const deleted = await demoRepository.deleteAllRemote();
      if (deleted) {
        // The empty aggregate was already accepted by DELETE. Keep the generic snapshot effect
        // dormant until the next explicit onboarding mutation so it cannot re-save the tombstone
        // state and leave the new onboarding form behind a permanent saving lock.
        remoteHydrated.current = false;
        acceptRemoteState(cleared);
        mutationLockRef.current = false;
        setSyncStatus("saved");
        setSyncError(undefined);
      } else {
        // The durable deletion tombstone keeps the empty state fail-closed and retries on load.
        mutationLockRef.current = false;
        setSyncStatus("error");
        setSyncError("Demo data is hidden locally and deletion is queued for retry.");
      }
      return deleted;
    },
    exportData() {
      return demoRepository.export(state);
    },
  }), [beginExplicitMutation, completeExplicitMutation, completeLocalExplicitMutation, failExplicitMutation, state, syncError, syncSnapshot, syncStatus]);

  return <DemoStoreContext.Provider value={value}>{children}</DemoStoreContext.Provider>;
}

export function useDemoStore(): DemoStore {
  const store = useContext(DemoStoreContext);
  if (!store) throw new Error("useDemoStore must be used inside DemoStoreProvider");
  return store;
}
