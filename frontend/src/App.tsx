import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, LockKeyhole, Menu, NotebookPen, Phone, UserRound } from "lucide-react";
import type { EvidenceSource, SuggestionKind } from "./types";
import { ONBOARDING_TODAY, PHASE_CHAT_PROMPTS, PHASE_LABELS } from "./data";
import { useDemoStore } from "./store/DemoStore";
import { deriveDashboard } from "./store/dashboardDerivations";
import { TodayHeader } from "./components/TodayHeader";
import { PennyChat } from "./components/PennyChat";
import { JournalPanel } from "./components/JournalPanel";
import { Drawer } from "./components/ui/Drawer";
import { UrgentHelpDialog } from "./components/ui/UrgentHelpDialog";
import { TrendsPanel } from "./components/panels/TrendsPanel";
import { CarePanel } from "./components/panels/CarePanel";
import { ExperimentsPanel } from "./components/panels/ExperimentsPanel";
import { ProfilePanel } from "./components/panels/ProfilePanel";
import { PrivacyPanel } from "./components/panels/PrivacyPanel";
import { ContactTeamPanel } from "./components/panels/ContactTeamPanel";
import { dateInTimeZone, formatDateInTimeZone } from "./store/patientTime";

type PanelId = "trends" | "care" | "team" | "experiments" | "profile" | "privacy" | null;

const PANEL_LABELS: Record<Exclude<PanelId, null>, { title: string; eyebrow: string }> = {
  trends: { title: "Trends & evidence", eyebrow: "Your personal evidence ledger" },
  care: { title: "Care", eyebrow: "Tests, team and prescribed treatment" },
  team: { title: "Contact my team", eyebrow: "Your IBD care team" },
  experiments: { title: "Experiments", eyebrow: "Careful personal learning" },
  profile: { title: "Profile & past medical history", eyebrow: "Baseline and onboarding" },
  privacy: { title: "Privacy & settings", eyebrow: "Permissions, connections and data rights" },
};

function syncErrorCopy(error?: string): string {
  if (error?.includes("(409")) return "A newer saved record or protected care change is already present. Reload the latest record before continuing.";
  if (error?.includes("[hydrate]")) return "The saved record could not be loaded safely. Reload to try again.";
  return "The local API could not save this change. Retry to apply it again when the API is available.";
}

function App() {
  const store = useDemoStore();
  const { state } = store;
  const [panel, setPanel] = useState<PanelId>(null);
  const [journalOpen, setJournalOpen] = useState(false);
  const [careFocus, setCareFocus] = useState<SuggestionKind>();
  const [urgentOpen, setUrgentOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const featureNavRef = useRef<HTMLElement | null>(null);
  const panelReturnFocusRef = useRef<HTMLElement | null>(null);
  const urgentReturnFocusRef = useRef<HTMLElement | null>(null);
  const openedSafetyAlertIdRef = useRef<number | null>(null);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4200);
  }, []);

  const openUrgent = useCallback(() => {
    urgentReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setUrgentOpen(true);
  }, []);

  const openUrgentFromDrawer = () => {
    // The drawer and its header trigger unmount before urgent help closes, so
    // return to the control that originally opened the drawer instead.
    urgentReturnFocusRef.current = panelReturnFocusRef.current?.isConnected
      ? panelReturnFocusRef.current
      : mobileMenuButtonRef.current;
    setPanel(null);
    setCareFocus(undefined);
    setUrgentOpen(true);
  };

  useEffect(() => {
    if (!state.safetyAlert) {
      openedSafetyAlertIdRef.current = null;
      return;
    }
    if (openedSafetyAlertIdRef.current === state.safetyAlert.id) return;
    openedSafetyAlertIdRef.current = state.safetyAlert.id;
    openUrgent();
  }, [openUrgent, state.safetyAlert]);

  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  useEffect(() => {
    if (!mobileMenu) return;
    featureNavRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMobileMenu(false);
      requestAnimationFrame(() => mobileMenuButtonRef.current?.focus());
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [mobileMenu]);

  const openPanel = (next: Exclude<PanelId, null>) => {
    if (!panel) {
      const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      panelReturnFocusRef.current = urgentOpen
        ? urgentReturnFocusRef.current
        : mobileMenu
          ? mobileMenuButtonRef.current ?? activeElement
          : activeElement;
    }
    setPanel(next);
    setMobileMenu(false);
  };

  const handleSuggestion = (kind: SuggestionKind) => {
    if (kind === "experiment") return openPanel("experiments");
    if (kind === "summary") return openPanel("trends");
    if (kind === "urgent") return openUrgent();
    setCareFocus(kind);
    openPanel("care");
  };

  const dashboard = useMemo(() => deriveDashboard(state), [state]);
  const content = dashboard.content;
  const displayName = state.profile.name.trim().split(" ")[0] || "there";
  const onboardingToday = {
    ...ONBOARDING_TODAY,
    sub: `${formatDateInTimeZone(new Date(), state.profile.timeZone)} · ${ONBOARDING_TODAY.sub}`,
  };
  const onboarded = state.profile.onboardingComplete;
  const trackingActive = onboarded && state.profile.adultEligibilityConfirmed && state.profile.healthDataConsent;
  const hasPatientRecord = onboarded || Boolean(state.profile.name.trim() || state.entries.length || state.messages.length || state.contacts.length);
  const suggestionEvidence = dashboard.evidence.map((entry) => ({
    entryId: entry.id,
    label: entry.kind,
    date: `${entry.date}, ${entry.time}`,
    detail: entry.body,
    type: "pattern" as const,
    excluded: entry.excluded,
  }));
  const careSuggestionSource = (kind: SuggestionKind): EvidenceSource => ({
    target: "care",
    label: kind === "test"
      ? "Home-test workflow"
      : kind === "team"
        ? "Clinician-message workflow"
        : kind === "prescription"
          ? "Prescriber-owned workflow"
          : "Clinician-authored schedule",
    date: "Current permitted Care record",
    detail: kind === "test"
      ? `Status: ${state.testOrder.status}`
      : kind === "team"
        ? `Status: ${state.teamMessage.status}`
        : `Treatment status: ${state.prescription.status}; open Care for the reviewable record`,
    type: "fact",
  });
  const pennySuggestions = (trackingActive ? content.suggestions : []).filter((suggestion) => {
    if (suggestion.kind === "urgent") return true;
    if (["test", "team", "prescription", "taper"].includes(suggestion.kind)) return state.privacy.assistantCareAccess;
    return state.privacy.assistantJournalAccess;
  }).map((suggestion) => {
    const usesCare = ["test", "team", "prescription", "taper"].includes(suggestion.kind);
    const journalSources = state.privacy.assistantJournalAccess ? suggestionEvidence : [];
    const safeSuggestion = suggestion.kind === "test" && !state.privacy.assistantJournalAccess
      ? {
          ...suggestion,
          title: `Home-test workflow: ${state.testOrder.status}`,
          desc: "Penny used only the Care record you permitted. Open Care to review the workflow; symptom evidence remains private.",
          cta: "Open Care",
        }
      : suggestion;
    return {
      ...safeSuggestion,
      sources: suggestion.kind === "urgent"
        ? undefined
        : usesCare
          ? [careSuggestionSource(suggestion.kind), ...journalSources]
          : journalSources,
    };
  });
  const patientToday = dateInTimeZone(new Date(), state.profile.timeZone);
  const flareTreatmentDay = state.phase === "flare" && state.prescription.status === "collected"
    ? state.taper.days.find((day) => day.date === patientToday)
    : undefined;
  const treatmentFocus = state.phase === "flare" && state.prescription.status === "collected"
    ? state.taper.verified && flareTreatmentDay
      ? {
          eyebrow: `Clinician-authored treatment · taper day ${flareTreatmentDay.day}`,
          title: `Today: ${flareTreatmentDay.doseMg} mg ${state.taper.medicine}`,
          detail: `Verified against the label from ${state.taper.prescribedBy}. Gutsy displays this exact prescribed dose and cannot change it.`,
          status: flareTreatmentDay.taken ? "Recorded as taken" : "Not yet confirmed taken",
        }
      : {
          eyebrow: "Clinician-authored treatment collected",
          title: "Verify the prescription schedule before dose support",
          detail: "Compare the imported schedule with the dispensing label in Care. Gutsy will not calculate or expose a dose until that review is complete.",
          status: "Verification needed",
        }
    : undefined;

  if (store.syncStatus === "loading") {
    return <div className="shell" aria-busy="true">
      <a href="#main-content" className="skip-link">Skip to loading status</a>
      <header className="topbar">
        <span className="brand"><span className="name">Gutsy</span></span>
      </header>
      <main className="hydration-screen" id="main-content" role="status" aria-live="polite" aria-atomic="true">
        <LockKeyhole aria-hidden="true" />
        <h1>Loading your encrypted demo record…</h1>
        <p>Health details stay hidden until the saved record is ready.</p>
      </main>
      <UrgentHelpDialog open={urgentOpen} contacts={[]} returnFocusRef={urgentReturnFocusRef} onClose={() => setUrgentOpen(false)} />
    </div>;
  }

  const reloadRequired = store.syncError?.includes("(409") || store.syncError?.includes("[hydrate]");

  return (
    <div className="shell">
      <a href="#main-content" className="skip-link">Skip to today</a>
      {store.syncStatus === "saving" && <div className="sync-banner saving" role="status" aria-atomic="true"><span><b>Saving securely…</b> Other changes pause until this one is confirmed.</span></div>}
      {store.syncStatus === "error" && <div className="sync-banner" role="alert" aria-atomic="true">
        <span><b>{store.syncError?.includes("[hydrate]") ? "Saved record unavailable." : store.retryAvailable ? "Change not saved yet; it remains queued." : "That action was not saved."}</b> {syncErrorCopy(store.syncError)}</span>
        {reloadRequired
          ? <button className="btn" onClick={() => window.location.reload()}>Reload latest</button>
          : store.retryAvailable
            ? <button className="btn" onClick={() => void store.retrySync()}>Retry change</button>
            : <span className="sync-next-step">Return to the open form and try again.</span>}
      </div>}
      <header className="topbar" inert={Boolean(panel || urgentOpen)} aria-hidden={panel || urgentOpen ? true : undefined}>
        <button className="brand" onClick={() => setPanel(null)} aria-label="Gutsy home"><span className="name">Gutsy</span></button>
        <nav ref={featureNavRef} className={mobileMenu ? "feature-nav open" : "feature-nav"} aria-label="Gutsy menu">
          <button disabled={!hasPatientRecord} onClick={() => openPanel("trends")} aria-expanded={panel === "trends"}><Activity /> Trends &amp; evidence</button>
          <button disabled={!hasPatientRecord} onClick={() => { setJournalOpen((value) => !value); setMobileMenu(false); }} aria-pressed={journalOpen}><NotebookPen /> Journal</button>
          <button disabled={!hasPatientRecord} onClick={() => openPanel("team")} aria-expanded={panel === "team"}><Phone /> Contact my team</button>
        </nav>
        <button ref={mobileMenuButtonRef} className="mobile-menu" onClick={() => setMobileMenu((value) => !value)} aria-expanded={mobileMenu} aria-label={`${mobileMenu ? "Close" : "Open"} menu`}><Menu /></button>
        {trackingActive && <div className="demo" aria-label="Demo lifecycle state"><span>Demo</span>{PHASE_LABELS.map((candidate) => <button key={candidate.id} disabled={store.mutationsBlocked} className={candidate.id === state.phase ? "demo-btn selected" : "demo-btn"} aria-pressed={candidate.id === state.phase} onClick={() => { store.setDemoPhase(candidate.id); notify(candidate.id === state.phase ? `${candidate.label} demo view selected.` : `${candidate.label} demo view selected. Penny opened that scenario's separate conversation.`); }}>{candidate.label}</button>)}</div>}
        <button className="me" onClick={() => openPanel("profile")} aria-label="Profile"><span className="avatar">{state.profile.name ? state.profile.name.split(" ").map((part) => part[0]).slice(0, 2).join("") : <UserRound />}</span><span><b>{state.profile.name || "Set up profile"}</b><small>{state.profile.diagnosis || "Onboarding needed"}</small></span></button>
      </header>

      {hasPatientRecord ? <div className={journalOpen ? "cols" : "cols solo"} id="main-content" inert={Boolean(panel || urgentOpen || store.mutationsBlocked)} aria-hidden={panel || urgentOpen ? true : undefined}>
        <main className="left">
          {!trackingActive && <section className="tracking-paused" role="status"><LockKeyhole /><div><b>Health-data tracking is paused</b><span>Existing records stay viewable and correctable. Re-enable consent in Profile to add new ones.</span></div><button className="btn" onClick={() => openPanel("profile")}>Review consent</button></section>}
          <TodayHeader content={content} phase={state.phase} pendingPhase={state.pendingPhase} phaseConfirmed={state.phaseConfirmed} firstName={displayName} onReviewEvidence={() => openPanel("trends")} treatmentFocus={treatmentFocus} onOpenTreatment={() => handleSuggestion("taper")} />
          <PennyChat messages={state.messages} suggestions={pennySuggestions} suggestionsNote={content.suggestionsNote} starterPrompts={PHASE_CHAT_PROMPTS[state.phase]} phaseLabel={PHASE_LABELS.find((candidate) => candidate.id === state.phase)?.label ?? "Current"} timeZone={state.profile.timeZone} trackingEnabled={trackingActive} journalInferenceEnabled={trackingActive && state.privacy.assistantJournalAccess} onSend={store.sendChat} onCorrectMessage={store.correctChatMessage} onDeleteMessage={store.deleteChatMessage} onSuggestion={handleSuggestion} onSourceTarget={(target) => openPanel(target === "care" ? "care" : target === "profile" ? "profile" : target === "privacy" ? "privacy" : "trends")} notify={notify} />

        </main>
        {journalOpen && <JournalPanel notify={notify} onClose={() => setJournalOpen(false)} onOpenCare={(focus = "taper") => handleSuggestion(focus)} onOpenSafetyCheck={() => { setCareFocus("urgent"); openPanel("care"); }} trackingEnabled={trackingActive} />}
      </div> : <main className="onboarding-gate" id="main-content" inert={Boolean(panel || urgentOpen || store.mutationsBlocked)} aria-hidden={panel || urgentOpen ? true : undefined}>
        <TodayHeader content={onboardingToday} phase="stable" phaseConfirmed={false} firstName={displayName} onReviewEvidence={() => undefined} />
        <section className="feature-card onboarding-callout"><UserRound /><div><p className="eyebrow">Before health tracking starts</p><h2>Complete adult onboarding and choose what Gutsy may store</h2><p>Tracking and care workflows stay off until identity, adult eligibility and consent are recorded.</p><div className="button-row"><button className="btn primary" onClick={() => openPanel("profile")}>Start onboarding</button><button className="btn" onClick={() => openPanel("privacy")}>Review privacy controls</button></div></div></section>
      </main>}

      {panel && <Drawer open title={PANEL_LABELS[panel].title} eyebrow={PANEL_LABELS[panel].eyebrow} wide={panel === "care" || panel === "trends" || panel === "profile"} contentInert={store.mutationsBlocked} contentStatus={store.mutationsBlocked ? store.syncStatus === "error" ? { tone: "error", text: "This change is queued but not saved. Close this panel to use Retry change; other controls remain paused." } : { tone: "saving", text: "Saving securely. Controls resume when the API confirms this change." } : undefined} returnFocusRef={panelReturnFocusRef} onClose={() => { setPanel(null); setCareFocus(undefined); }} onUrgent={openUrgentFromDrawer}>
        {panel === "trends" && <TrendsPanel notify={notify} />}
        {panel === "care" && <CarePanel focus={careFocus} notify={notify} openUrgent={openUrgent} />}
        {panel === "team" && <ContactTeamPanel contacts={state.contacts} notify={notify} />}
        {panel === "experiments" && <ExperimentsPanel notify={notify} />}
        {panel === "profile" && <ProfilePanel notify={notify} />}
        {panel === "privacy" && <PrivacyPanel notify={notify} onClose={() => setPanel(null)} />}
      </Drawer>}

      <UrgentHelpDialog open={urgentOpen} alert={state.safetyAlert} contacts={state.contacts} returnFocusRef={urgentReturnFocusRef} onClose={() => { setUrgentOpen(false); if (state.safetyAlert) void store.clearSafetyAlert(); }} onCare={() => { setCareFocus("urgent"); openPanel("care"); }} />
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

export default App;
