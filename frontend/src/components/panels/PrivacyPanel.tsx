import { useEffect, useState } from "react";
import { Bell, Download, FileImage, HeartPulse, History, Link, LockKeyhole, ShieldCheck, Trash2, Unlink, UserRoundCheck, Watch } from "lucide-react";
import { useDemoStore } from "../../store/DemoStore";
import type { SupporterView, TrustedSupporter } from "../../types";
import { registerPersistentReminders } from "../../store/persistentNotifications";
import { dateInTimeZone, normalizeTimeZone } from "../../store/patientTime";
import { ConfirmDialog } from "../ui/ConfirmDialog";

function downloadExport(contents: string, date: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `gutsy-export-${date}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

type Confirm = "disconnect" | "conversation" | "all" | null;

export function formatSupporterTimestamp(value: string, timeZone: string): string {
  const zone = normalizeTimeZone(timeZone, "UTC");
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return `Unknown time (${zone})`;
  return `${new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: zone,
  }).format(instant)} (${zone})`;
}

export function PrivacyPanel({ notify, onClose }: { notify: (message: string) => void; onClose: () => void }) {
  const { state, updatePrivacy, updateWearable, updateTrustedSupporter, generateSupporterInvitation, revokeSupporterInvitation, loadSupporterView, submitSupporterLog, updateEntry, clearConversation, clearAllData, exportData } = useDemoStore();
  const trackingActive = state.profile.onboardingComplete && state.profile.adultEligibilityConfirmed && state.profile.healthDataConsent;
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [deletePhrase, setDeletePhrase] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [supporterDraft, setSupporterDraft] = useState<TrustedSupporter>(state.trustedSupporter);
  const [supporterView, setSupporterView] = useState<SupporterView>();
  const [supporterLog, setSupporterLog] = useState("");
  const [supporterBusy, setSupporterBusy] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState(() => typeof Notification === "undefined" ? "unsupported" : Notification.permission);

  useEffect(() => setSupporterDraft(state.trustedSupporter), [state.trustedSupporter]);

  const supporterField = <K extends keyof TrustedSupporter>(key: K, value: TrustedSupporter[K]) => {
    setSupporterDraft((current) => ({ ...current, [key]: value }));
  };

  const saveSupporter = () => {
    if (supporterDraft.enabled && (!supporterDraft.name.trim() || !supporterDraft.relationship.trim())) {
      notify("Add the supporter’s name and relationship before enabling access.");
      return;
    }
    if (supporterDraft.enabled && !supporterDraft.canViewSummary && !supporterDraft.canSeeReminders && !supporterDraft.canHelpLog) {
      notify("Choose at least one explicit supporter permission.");
      return;
    }
    const saved = supporterDraft.enabled ? supporterDraft : { ...supporterDraft, canViewSummary: false, canSeeReminders: false, canHelpLog: false };
    setSupporterDraft(saved);
    updateTrustedSupporter(saved);
    notify(saved.enabled ? "Scoped supporter access saved. No invitation was sent in this demo." : "Trusted supporter access disabled.");
  };

  const supporterConfigurationSaved = (["enabled", "name", "relationship", "canViewSummary", "canSeeReminders", "canHelpLog"] as const)
    .every((key) => supporterDraft[key] === state.trustedSupporter[key]);

  const createSupporterCode = async () => {
    setSupporterBusy(true);
    const view = await generateSupporterInvitation();
    setSupporterBusy(false);
    if (!view) return notify("The demo access code could not be created. Save the supporter permissions and check API sync.");
    setSupporterView(view);
    notify("A revocable demo access code was generated. No invitation or message was sent.");
  };

  const previewSupporterAccess = async () => {
    const code = state.trustedSupporter.accessCode;
    if (!code) return;
    setSupporterBusy(true);
    const view = await loadSupporterView(code);
    setSupporterBusy(false);
    if (!view) return notify("The supporter demo view could not be opened. The code may have been revoked.");
    setSupporterView(view);
  };

  const revokeSupporterCode = async () => {
    setSupporterBusy(true);
    const revoked = await revokeSupporterInvitation();
    setSupporterBusy(false);
    if (!revoked) return notify("The demo access code could not be revoked. Try again before sharing it.");
    setSupporterView(undefined);
    notify("The supporter demo access code was revoked immediately. Scoped settings remain saved.");
  };

  const createSupporterLog = async () => {
    const code = state.trustedSupporter.accessCode;
    if (!code || !supporterLog.trim()) return;
    setSupporterBusy(true);
    const view = await submitSupporterLog(code, supporterLog);
    setSupporterBusy(false);
    if (!view) return notify("The supporter observation could not be saved.");
    setSupporterView(view);
    setSupporterLog("");
    notify("Supporter-attributed observation saved as excluded and awaiting patient review.");
  };

  const enableDeviceNotifications = async () => {
    if (typeof Notification === "undefined") return notify("This browser does not expose device notifications. In-app reminders remain available.");
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    if (permission === "granted") {
      const mode = await registerPersistentReminders(true);
      notify(mode === "periodic" ? "Discreet background check-ins enabled. Timing follows your notification budget and usual logging times." : "Device check-ins enabled while the browser permits background work. In-app reminders remain the reliable fallback.");
    } else notify("Device notifications were not enabled. In-app reminders remain available.");
  };

  const applyRetention = () => {
    state.entries.filter((entry) => entry.photo).forEach((entry) => updateEntry(entry.id, { photo: entry.photo ? { ...entry.photo, retentionDays: state.privacy.photoRetentionDays } : undefined }));
    notify("Photo retention updated for current demo images and future captures.");
  };

  return <div className="panel-stack privacy-panel">
    <section className="panel-intro"><span className="pill ok"><ShieldCheck /> Patient controlled</span><h3>Nothing consequential is hidden</h3><p>This development prototype keeps demo data in live session memory and the local Gutsy API’s encrypted SQLite database; it does not write the health aggregate to browser storage. When Runware is configured, a photo the patient deliberately captures can be described in the background; toilet images additionally require explicit consent. Every observation remains visible, correctable and unable to trigger care.</p></section>

    <section className="feature-card">
      <div className="section-heading"><div><p className="eyebrow">Penny’s permissioned context</p><h3>Choose which records Penny can use</h3></div><LockKeyhole /></div>
      <label className="toggle-row"><span><b>Profile and PMH</b><small>Diagnosis, baseline, medicines, conditions and allergies</small></span><input type="checkbox" checked={state.privacy.assistantProfileAccess} onChange={(e) => updatePrivacy({ assistantProfileAccess: e.target.checked })} /></label>
      <label className="toggle-row"><span><b>Journal and photos</b><small>Logs, corrected observations and non-excluded entries</small></span><input type="checkbox" checked={state.privacy.assistantJournalAccess} onChange={(e) => updatePrivacy({ assistantJournalAccess: e.target.checked })} /></label>
      <label className="toggle-row"><span><b>Care records</b><small>Tests, prescriptions, contacts and clinician messages</small></span><input type="checkbox" checked={state.privacy.assistantCareAccess} onChange={(e) => updatePrivacy({ assistantCareAccess: e.target.checked })} /></label>
      <label className="toggle-row"><span><b>Earlier Penny conversation</b><small>Your prior messages, used only when a new question asks about them</small></span><input type="checkbox" checked={state.privacy.assistantConversationAccess} onChange={(e) => updatePrivacy({ assistantConversationAccess: e.target.checked })} /></label>
      <label className="toggle-row"><span><b>Secondary use</b><small>Optional use to improve the service; off by default</small></span><input type="checkbox" checked={state.privacy.secondaryUseConsent} onChange={(e) => updatePrivacy({ secondaryUseConsent: e.target.checked })} /></label>
    </section>

    <section className="feature-card">
      <div className="section-heading"><div><p className="eyebrow">Sensitive images</p><h3>Discreet capture and short retention</h3></div><FileImage /></div>
      <label>Default photo retention<select value={state.privacy.photoRetentionDays} onChange={(e) => updatePrivacy({ photoRetentionDays: Number(e.target.value) as 7 | 30 | 90 })}><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></select></label>
      <button className="btn" onClick={applyRetention}>Apply to existing photos</button>
      <label className="toggle-row"><span><b>Optional toilet-photo consent</b><small>Can be withdrawn; existing toilet-image payloads are then removed immediately</small></span><input type="checkbox" checked={state.privacy.toiletPhotoConsent} onChange={(e) => updatePrivacy({ toiletPhotoConsent: e.target.checked })} /></label>
      <p className="soft-signal">Image observations remain marked unconfirmed until reviewed. They never determine urgency, order a test or trigger a medicine workflow.</p>
    </section>

    <section className="feature-card">
      <div className="section-heading"><div><p className="eyebrow">Wearable controls</p><h3>{state.wearable.provider}</h3></div><Watch /></div>
      <p className="soft-signal">Development simulation only: no Apple or Google account is contacted. Imported resting heart rate, HRV, sleep and activity remain noisy supporting context and can never trigger a lifecycle change by themselves.</p>
      {!state.wearable.connected && <label>Simulated source<select value={state.wearable.provider} disabled={!trackingActive} onChange={(event) => updateWearable({ provider: event.target.value as typeof state.wearable.provider })}><option>Apple Health</option><option>Health Connect</option></select></label>}
      {state.wearable.connected ? <>
        <div className="connected-banner"><Link /><div><b>Connected</b><span>Last sync {state.wearable.lastSync}</span></div><button className="btn" onClick={() => setConfirm("disconnect")}><Unlink /> Disconnect</button></div>
        <label className="toggle-row"><span><b>Resting heart rate</b><small>A noisy supporting signal, never a standalone alert</small></span><input type="checkbox" checked={state.wearable.heartRate} disabled={!trackingActive && !state.wearable.heartRate} onChange={(e) => updateWearable({ heartRate: e.target.checked })}/></label>
        <label className="toggle-row"><span><b>Heart-rate variability (HRV)</b><small>Milliseconds where available; personal context only</small></span><input type="checkbox" checked={state.wearable.hrv} disabled={!trackingActive && !state.wearable.hrv} onChange={(e) => updateWearable({ hrv: e.target.checked })}/></label>
        <label className="toggle-row"><span><b>Sleep</b><small>Duration and interruptions where available</small></span><input type="checkbox" checked={state.wearable.sleep} disabled={!trackingActive && !state.wearable.sleep} onChange={(e) => updateWearable({ sleep: e.target.checked })}/></label>
        <label className="toggle-row"><span><b>Activity</b><small>Used only as personal context</small></span><input type="checkbox" checked={state.wearable.activity} disabled={!trackingActive && !state.wearable.activity} onChange={(e) => updateWearable({ activity: e.target.checked })}/></label>
      </> : <div className="empty-state"><HeartPulse /><b>No wearable connected</b><span>{trackingActive ? "Connecting is optional; manual tracking works fully without it." : "Tracking consent is paused. Re-enable it in Profile before connecting; existing privacy controls remain available."}</span><button className="btn primary" disabled={!trackingActive} onClick={() => { updateWearable({ connected: true, lastSync: "Just now" }); notify(`Simulated ${state.wearable.provider} connection enabled; no external account was contacted.`); }}>Connect {state.wearable.provider} simulation</button></div>}
    </section>

    <section className="feature-card">
      <div className="section-heading"><div><p className="eyebrow">Discreet support</p><h3>Notifications without nagging</h3></div><Bell /></div>
      <label className="toggle-row"><span><b>Discreet lock-screen wording</b><small>“You have a Gutsy check-in” without symptom details</small></span><input type="checkbox" checked={state.privacy.discreetNotifications} onChange={(e) => updatePrivacy({ discreetNotifications: e.target.checked })}/></label>
      <label>Notification budget<select value={state.privacy.notificationBudget} onChange={(e) => updatePrivacy({ notificationBudget: e.target.value as typeof state.privacy.notificationBudget })}><option value="low">Low — safety and medicine only</option><option value="balanced">Balanced — recommended</option><option value="supportive">Supportive — more check-ins</option></select></label>
      <button className="btn" onClick={() => void enableDeviceNotifications()} disabled={notificationPermission === "granted" || notificationPermission === "unsupported"}>{notificationPermission === "granted" ? "Device check-ins enabled" : notificationPermission === "unsupported" ? "Device notifications unavailable" : "Enable device check-ins"}</button>
      <p className="soft-signal">No streaks and no guilt. Missing an entry reduces low-value prompts rather than resetting progress. Installed browsers that support periodic background sync can check while the page is closed; other browsers use page and in-app reminders.</p>
    </section>

    <section className="feature-card">
      <div className="section-heading"><div><p className="eyebrow">Optional demo feature</p><h3>Trusted supporter</h3></div><UserRoundCheck /></div>
      <p>A named family member or carer can receive only the permissions you choose. They can never order tests, send clinical messages, confirm prescriptions or change medicine.</p>
      <label className="toggle-row"><span><b>Enable trusted supporter</b><small>Off by default; no invitation is sent in this demo</small></span><input type="checkbox" checked={supporterDraft.enabled} disabled={!trackingActive && !supporterDraft.enabled} onChange={(e) => supporterField("enabled", e.target.checked)} /></label>
      <div className="field-pair"><label>Supporter name<input value={supporterDraft.name} disabled={!supporterDraft.enabled} onChange={(e) => supporterField("name", e.target.value)}/></label><label>Relationship<input value={supporterDraft.relationship} disabled={!supporterDraft.enabled} onChange={(e) => supporterField("relationship", e.target.value)}/></label></div>
      <div className="check-grid supporter-permissions"><label><input type="checkbox" disabled={!supporterDraft.enabled} checked={supporterDraft.canViewSummary} onChange={(e) => supporterField("canViewSummary", e.target.checked)}/> View patient-approved summaries</label><label><input type="checkbox" disabled={!supporterDraft.enabled} checked={supporterDraft.canSeeReminders} onChange={(e) => supporterField("canSeeReminders", e.target.checked)}/> See reminder status</label><label><input type="checkbox" disabled={!supporterDraft.enabled} checked={supporterDraft.canHelpLog} onChange={(e) => supporterField("canHelpLog", e.target.checked)}/> Help create reviewable logs</label></div>
      <button className="btn" onClick={saveSupporter}>Save supporter access</button>
      <p className="privacy-note">Supporter logs are labelled with their source, excluded until patient review, and remain correctable. Consequential care actions always stay with the patient and clinician.</p>
      {state.trustedSupporter.enabled && <div className="supporter-access">
        <b>Invitation simulation</b>
        <p>No email, SMS or external invitation is delivered. Generate a revocable code to exercise the exact scoped view in this prototype.</p>
        {state.trustedSupporter.accessCode ? <>
          <div className="supporter-code"><span>One active demo code</span><strong>{state.trustedSupporter.accessCode}</strong><small>Created {state.trustedSupporter.accessCreatedAt ? formatSupporterTimestamp(state.trustedSupporter.accessCreatedAt, state.profile.timeZone) : "just now"}</small></div>
          <div className="button-row"><button className="btn" disabled={supporterBusy} onClick={() => void previewSupporterAccess()}>{supporterBusy ? "Opening…" : "Preview supporter view"}</button><button className="btn danger-outline" disabled={supporterBusy} onClick={() => void revokeSupporterCode()}>Revoke code</button></div>
        </> : <button className="btn" disabled={supporterBusy || !supporterConfigurationSaved} onClick={() => void createSupporterCode()}>{supporterBusy ? "Generating…" : "Generate demo access code"}</button>}
        {!supporterConfigurationSaved && <p className="inline-warning">Save the current name and permissions before generating a code.</p>}
      </div>}
      {supporterView && <section className="supporter-preview" aria-label="Simulated supporter-scoped view">
        <p className="eyebrow">Supporter view · simulation</p><h4>{supporterView.supporterName} supporting {supporterView.patientFirstName}</h4><p>{supporterView.notice}</p>
        <div className="supporter-scope" aria-label="Effective supporter permissions"><span className={supporterView.permissions.canViewSummary ? "status ok" : "status"}>Summary {supporterView.permissions.canViewSummary ? "visible" : "hidden"}</span><span className={supporterView.permissions.canSeeReminders ? "status ok" : "status"}>Reminders {supporterView.permissions.canSeeReminders ? "visible" : "hidden"}</span><span className={supporterView.permissions.canHelpLog ? "status ok" : "status"}>Logging {supporterView.permissions.canHelpLog ? "allowed" : "blocked"}</span></div>
        {supporterView.summary && <details><summary>Patient-approved summary</summary><p className="supporter-summary">{supporterView.summary}</p></details>}
        {supporterView.reminders && <div><b>Visible reminder status</b><ul>{supporterView.reminders.map((reminder) => <li key={reminder}>{reminder}</li>)}</ul></div>}
        {supporterView.permissions.canHelpLog && <div className="supporter-log"><label htmlFor="supporter-observation">Create a patient-reviewable observation<textarea id="supporter-observation" value={supporterLog} onChange={(event) => setSupporterLog(event.target.value)} placeholder="Example: Matthew had soup at lunch and felt crampy afterwards" /></label><button className="btn" disabled={supporterBusy || !supporterLog.trim()} onClick={() => void createSupporterLog()}>Add excluded reviewable log</button><small>This records the named supporter as the source. The patient must review and include it before trends or summaries can use it.</small></div>}
        {supporterView.reviewableLogs && supporterView.reviewableLogs.length > 0 && <div><b>Recent supporter logs</b><ul>{supporterView.reviewableLogs.map((entry) => <li key={entry.id}><span className={entry.excluded ? "status watch" : "status ok"}>{entry.excluded ? "Awaiting patient review" : "Included by patient"}</span> {entry.body}</li>)}</ul></div>}
      </section>}
    </section>

    <section className="feature-card">
      <div className="section-heading"><div><p className="eyebrow">Your data rights</p><h3>Export or delete</h3></div><Download /></div>
      <div className="button-grid"><button className="btn" onClick={() => { downloadExport(exportData(), dateInTimeZone(new Date(), state.profile.timeZone)); notify("A readable JSON export was created on this device."); }}><Download /> Export my data</button><button className="btn" onClick={() => setConfirm("conversation")}><Trash2 /> Delete conversation</button><button className="btn danger-outline" onClick={() => setConfirm("all")}><Trash2 /> Delete all demo data</button></div>
      <p className="privacy-note">Deleting an entry removes it from the evidence ledger and downstream summaries in this demo. Browser downloads remain under your device controls.</p>
    </section>

    <section className="feature-card">
      <div className="section-heading"><div><p className="eyebrow">Audit trail</p><h3>What used or changed your data</h3></div><History /></div>
      <div className="audit-list">{state.audit.slice(0, 12).map((event) => <article key={event.id}><time>{event.at}</time><p>{event.action}</p></article>)}</div>
    </section>

    <ConfirmDialog open={confirm === "disconnect"} title={`Disconnect ${state.wearable.provider}?`} description="Future simulated passive syncs will stop immediately. Existing entries stay visible and can be excluded or deleted individually." confirmLabel="Disconnect wearable" onCancel={() => setConfirm(null)} onConfirm={() => { updateWearable({ connected: false, lastSync: undefined }); setConfirm(null); notify("Wearable simulation disconnected. Manual tracking remains available."); }}/>
    <ConfirmDialog open={confirm === "conversation"} title="Delete your Penny conversation?" description="All chat messages and their pending or reviewed PMH proposal records will be removed from this session and API persistence. Journal entries created from chat and any wording already accepted into your profile remain separately controllable." confirmLabel="Delete conversation" danger onCancel={() => setConfirm(null)} onConfirm={() => { clearConversation(); setConfirm(null); notify("Conversation and its PMH proposals deleted."); }}/>
    <ConfirmDialog open={confirm === "all"} title="Delete all demo health data?" description="This clears profile, PMH, chat, journal, photos, test, medicine and wearable records from this session and the local API. This cannot be undone." confirmLabel={deleting ? "Deleting…" : "Delete all demo data"} danger onCancel={() => { if (deleting) return; setConfirm(null); setDeletePhrase(""); }} onConfirm={async () => { if (deletePhrase !== "DELETE") return notify("Type DELETE exactly to confirm."); if (deleting) return; setDeleting(true); const remoteDeleted = await clearAllData(); setDeleting(false); setConfirm(null); setDeletePhrase(""); onClose(); notify(remoteDeleted ? "All session and API demo data deleted. Onboarding is ready to start again." : "Session data was deleted. The local API could not be reached, so deletion is pending and remote data will stay hidden until the app can retry."); }}><label>Type <b>DELETE</b> to continue<input value={deletePhrase} onChange={(e) => setDeletePhrase(e.target.value)} autoComplete="off" disabled={deleting} /></label></ConfirmDialog>
  </div>;
}
