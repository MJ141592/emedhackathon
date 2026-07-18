import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { Camera, ChevronDown, Droplets, HeartPulse, LockKeyhole, Moon, Pill, Plus, Trash2, Utensils, X } from "lucide-react";
import type { EntryKind, JournalDraft, JournalEntry, PhaseId, PhotoAttachment } from "../types";
import { useDemoStore } from "../store/DemoStore";
import { aiClient } from "../api";
import { deriveReminders } from "../store/reminderService";
import { addCalendarDays, dateInTimeZone, timeInTimeZone } from "../store/patientTime";
import { taperTreatmentActive } from "../store/recoveryGovernance";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { useModalFocus } from "./ui/useModalFocus";

type CaptureKind = "bowel" | "meal" | "pain" | "life" | "medication" | "wellbeing" | "toilet-photo";

const captureLabels: Record<CaptureKind, string> = {
  bowel: "Bowel movement", meal: "Meal or hydration", pain: "Pain", life: "Life event", medication: "Medication", wellbeing: "How are you?", "toilet-photo": "Optional toilet photo",
};

const captureActions: Record<CaptureKind, { label: string; icon: typeof Camera }> = {
  bowel: { label: "Bowel", icon: Droplets },
  meal: { label: "Meal photo", icon: Camera },
  pain: { label: "Pain", icon: HeartPulse },
  medication: { label: "Medicine", icon: Pill },
  wellbeing: { label: "Detailed check-in", icon: ChevronDown },
  life: { label: "Life event", icon: Moon },
  "toilet-photo": { label: "Toilet photo", icon: Camera },
};

const phaseCaptureOrder: Record<PhaseId, CaptureKind[]> = {
  stable: ["meal", "bowel", "wellbeing", "medication", "pain", "life", "toilet-photo"],
  watch: ["bowel", "wellbeing", "pain", "toilet-photo", "medication", "meal", "life"],
  flare: ["bowel", "pain", "wellbeing", "toilet-photo", "medication", "meal", "life"],
  recovery: ["medication", "wellbeing", "pain", "bowel", "meal", "life", "toilet-photo"],
};

function journalDayLabel(dateKey: string, todayKey: string, yesterdayKey: string): string {
  const parsed = new Date(`${dateKey}T12:00:00.000Z`);
  const formatted = Number.isNaN(parsed.getTime())
    ? dateKey
    : new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(parsed);
  if (dateKey === todayKey) return `Today · ${formatted}`;
  if (dateKey === yesterdayKey) return `Yesterday · ${formatted}`;
  return formatted;
}

function fileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function EntryRow({ entry, onEdit, onDelete, notify, deleteButtonRef }: { entry: JournalEntry; onEdit: () => void; onDelete: () => void; notify: (text: string) => void; deleteButtonRef?: (element: HTMLButtonElement | null) => void }) {
  const { updateEntry } = useDemoStore();
  const [removingPhoto, setRemovingPhoto] = useState(false);
  const objectiveCareResult = entry.kind === "TEST RESULT" && entry.source === "care";
  const taperAdherenceRecord = entry.kind === "MEDICATION"
    && entry.structured?.taperDay !== undefined
    && (entry.structured.adherenceCorrection === true || entry.structured.missed === true || entry.structured.taken === true);
  const removePhoto = async () => {
    if (removingPhoto) return;
    setRemovingPhoto(true);
    try {
      const removed = await updateEntry(entry.id, { photo: undefined });
      notify(removed
        ? "Photo deleted. The journal text and refreshed evidence were retained."
        : "That photo was not deleted. It remains in your journal; try again when the API is available.");
    } finally {
      setRemovingPhoto(false);
    }
  };
  return (
    <article id={`entry-${entry.id}`} className={`entry ${entry.kind === "Penny noticed" ? "penny-note" : ""} ${entry.flagged ? "flagged" : ""} ${entry.excluded ? "excluded" : ""}`} aria-busy={removingPhoto}>
      <div className="entry-top">
        <p className="meta">{entry.kind === "Penny noticed" ? entry.kind : `${entry.time} · ${entry.kind}`}{entry.flagged && <span className="pill flag">Flagged</span>}{entry.excluded && <span className="pill muted">Excluded</span>}</p>
        <div className="entry-actions">
          {taperAdherenceRecord
            ? <span className="pill muted">{entry.structured?.adherenceCorrection === true ? "Audited adherence correction" : "Adherence source · correct in Care"}</span>
            : objectiveCareResult
            ? <span className="pill muted">Objective care record</span>
            : <button className="text-btn" onClick={onEdit} aria-label={`Edit ${entry.kind} entry`} disabled={removingPhoto}>Edit</button>}
          {!taperAdherenceRecord && <button className="text-btn" onClick={() => { void updateEntry(entry.id, { excluded: !entry.excluded }); }} aria-label={`${entry.excluded ? "Include" : "Exclude"} ${entry.kind} entry`} disabled={removingPhoto}>{entry.excluded ? "Include" : "Exclude"}</button>}
          {entry.photo && !taperAdherenceRecord && <button className="text-btn" onClick={() => { void removePhoto(); }} aria-label={`Remove photo from ${entry.kind} entry`} disabled={removingPhoto}>{removingPhoto ? "Removing photo…" : "Remove photo"}</button>}
          {!taperAdherenceRecord && <button ref={deleteButtonRef} className="icon-btn small" onClick={onDelete} aria-label={`Delete ${entry.kind} entry`} disabled={removingPhoto}><Trash2 aria-hidden="true" /></button>}
        </div>
      </div>
      {entry.photo?.previewUrl && <img className="entry-photo" src={entry.photo.previewUrl} alt={`${entry.photo.purpose} photo preview uploaded by the patient`} />}
      <p className="body">{entry.body}</p>
      {entry.photo?.derivedObservation && <p className="derived"><b>Background observation — reviewable:</b> {entry.photo.derivedObservation}</p>}
      <p className="entry-source">Source: {entry.source}{entry.photo?.previewUrl ? ` · kept for ${entry.photo.retentionDays} days` : entry.photo ? " · image payload removed under consent or retention controls" : ""}</p>
    </article>
  );
}

function CaptureDialog({ kind, onClose, notify }: { kind: CaptureKind; onClose: () => void; notify: (text: string) => void }) {
  const { saveEntry, state, updatePrivacy } = useDemoStore();
  const [bristol, setBristol] = useState<string>("");
  const [urgency, setUrgency] = useState(false);
  const [blood, setBlood] = useState("none");
  const [mucus, setMucus] = useState(false);
  const [nightWaking, setNightWaking] = useState(false);
  const [pain, setPain] = useState("");
  const [site, setSite] = useState("");
  const [description, setDescription] = useState("");
  const [portion, setPortion] = useState("");
  const [hydration, setHydration] = useState("");
  const [wellbeing, setWellbeing] = useState("same");
  const [fatigue, setFatigue] = useState("");
  const [mood, setMood] = useState("");
  const [appetite, setAppetite] = useState("");
  const [sleep, setSleep] = useState("");
  const [weight, setWeight] = useState("");
  const [photo, setPhoto] = useState<PhotoAttachment | undefined>();
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toiletConsent, setToiletConsent] = useState(state.privacy.toiletPhotoConsent);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const savingRef = useRef(false);
  const closeCapture = () => { if (!savingRef.current) onClose(); };
  useModalFocus(true, dialogRef, closeRef, closeCapture);

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const supportedImage = ["image/jpeg", "image/png", "image/heic"].includes(file.type.toLowerCase())
      || (/\.(?:jpe?g|png|heic)$/i.test(file.name) && !file.type);
    if (!supportedImage) {
      notify("Choose a JPEG, PNG or HEIC image.");
      event.target.value = "";
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      notify("Choose an image smaller than 8 MB.");
      event.target.value = "";
      return;
    }
    const purpose = kind === "toilet-photo" ? "toilet" : "meal";
    if (purpose === "toilet" && !toiletConsent) {
      notify("Confirm optional toilet-photo consent before capture.");
      event.target.value = "";
      return;
    }
    let previewUrl: string;
    try {
      previewUrl = await fileAsDataUrl(file);
    } catch {
      notify("That image could not be read. Choose another file.");
      event.target.value = "";
      return;
    }
    const attachment: PhotoAttachment = {
      name: file.name,
      previewUrl,
      purpose,
      retentionDays: state.privacy.photoRetentionDays,
      consented: true,
      derivedObservation: "No image-derived observation is currently recorded.",
    };
    setImageFile(file);
    setPhoto(attachment);
    // Clear the native selection so removing or replacing with the same file still fires onChange.
    event.target.value = "";
    notify("Photo ready to review. It is not in your journal until you choose Add to journal.");
  };

  const analyzePhoto = async () => {
    if (!photo || !imageFile) return;
    if (!state.privacy.assistantJournalAccess) return notify("Penny’s Journal and photos access is off. The image remains in your correctable record and will not be sent for model analysis.");
    if (photo.purpose === "toilet" && !toiletConsent) return notify("Confirm optional toilet-photo consent before sending the image for analysis.");
    setImageBusy(true);
    try {
      const status = await aiClient.status();
      if (!status.configured) {
        notify("Runware is not configured yet. The photo stays in the editable local record without model analysis.");
        return;
      }
      const result = await aiClient.describeImage(imageFile, photo.purpose === "meal" ? "meal_log" : "toilet_log", description);
      setPhoto((current) => current ? { ...current, consented: true, derivedObservation: result.text } : current);
      notify("Runware returned an editable observation. Review it before saving; it cannot trigger care.");
    } catch {
      notify("The optional image description could not run. You can still save or describe the record yourself.");
    } finally {
      setImageBusy(false);
    }
  };

  const submit = async () => {
    let draft: JournalDraft;
    if (kind === "bowel") {
      const parts = [bristol ? `Bristol type ${bristol}` : "Bristol type not recorded", urgency ? "urgency" : "", blood !== "none" ? `${blood === "unspecified" ? "blood (amount not specified)" : `${blood} blood`}` : "", mucus ? "mucus" : "", nightWaking ? "night waking" : "", pain ? `pain ${pain}/10` : ""].filter(Boolean);
      draft = { kind: "BOWEL MOVEMENT", body: parts.join(", "), source: "manual", flagged: blood !== "none" || Number(pain) >= 7, structured: { ...(bristol ? { bristol: Number(bristol) } : {}), urgency, blood, mucus, nightWaking, ...(pain ? { pain: Number(pain) } : {}) } };
    } else if (kind === "meal") {
      if (!description.trim() && !photo) return notify("Add a meal description or choose a photo before saving.");
      draft = { kind: "MEAL", body: description.trim() || "Meal photo captured — description optional", source: "manual", structured: { description: description.trim(), portion, hydration }, photo };
    } else if (kind === "toilet-photo") {
      if (!toiletConsent || !photo) return notify("Consent and a photo are required for optional toilet-photo capture.");
      draft = { kind: "BOWEL MOVEMENT", body: description.trim() || "Optional toilet photo captured; observations awaiting review", source: "manual", photo: { ...photo, consented: true }, structured: { imageObservationUnconfirmed: true } };
    } else if (kind === "pain") {
      if (!pain) return notify("Choose a pain score or cancel.");
      draft = { kind: "PAIN", body: `${pain}/10${site.trim() ? ` · ${site.trim()}` : ""}`, source: "manual", flagged: Number(pain) >= 7, structured: { pain: Number(pain), ...(site.trim() ? { site: site.trim() } : {}) } };
    } else if (kind === "medication") {
      draft = { kind: "MEDICATION", body: description.trim() || "Medication taken — details not specified", source: "manual", structured: { taken: true, reportedText: description.trim() } };
    } else if (kind === "wellbeing") {
      const details = [fatigue && `fatigue ${fatigue}`, mood && `mood ${mood}`, appetite && `appetite ${appetite}`, sleep && `sleep ${sleep} h`, weight && `weight ${weight} kg`].filter(Boolean);
      draft = { kind: "WELLBEING", body: `Feeling ${wellbeing} than usual${details.length ? ` · ${details.join(" · ")}` : ""}${description.trim() ? ` · ${description.trim()}` : ""}`, source: "manual", flagged: wellbeing === "worse", structured: { wellbeing, ...(fatigue ? { fatigue } : {}), ...(mood ? { mood } : {}), ...(appetite ? { appetite } : {}), ...(sleep ? { sleepHours: Number(sleep) } : {}), ...(weight ? { weightKg: Number(weight) } : {}) } };
    } else {
      draft = { kind: "LIFE EVENT", body: description.trim() || "Life event noted as context", source: "manual" };
    }
    savingRef.current = true;
    setSaving(true);
    let saved: JournalEntry | undefined;
    try {
      saved = await saveEntry(draft);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
    if (!saved) return notify("That entry was not saved. Keep MeMed open and try again when the API is available.");
    notify(kind.includes("photo") || kind === "meal" ? "Saved securely. You can close MeMed — background observations stay reviewable, and no calories are shown." : "Saved to your journal against your own baseline.");
    onClose();
  };

  return (
    <div className="modal-layer">
      <section ref={dialogRef} className="capture-dialog" role="dialog" aria-modal="true" aria-labelledby="capture-title" aria-busy={saving}>
        <button ref={closeRef} className="icon-btn close-corner" onClick={closeCapture} disabled={saving} aria-label="Close capture"><X aria-hidden="true" /></button>
        <p className="eyebrow">Quick capture · {timeInTimeZone(new Date(), state.profile.timeZone)}</p>
        <h2 id="capture-title">{captureLabels[kind]}</h2>
        {kind === "bowel" && <>
          <fieldset><legend>Bristol type <span>optional if you’re unsure</span></legend><div className="scale-row">{[1,2,3,4,5,6,7].map((value) => <button type="button" key={value} className={bristol === String(value) ? "scale selected" : "scale"} onClick={() => setBristol(String(value))}>{value}</button>)}</div></fieldset>
          <div className="check-grid"><label><input type="checkbox" checked={urgency} onChange={(e) => setUrgency(e.target.checked)} /> Urgency</label><label><input type="checkbox" checked={mucus} onChange={(e) => setMucus(e.target.checked)} /> Mucus</label><label><input type="checkbox" checked={nightWaking} onChange={(e) => setNightWaking(e.target.checked)} /> Woke at night</label></div>
          <label>Blood<select value={blood} onChange={(e) => setBlood(e.target.value)}><option value="none">None noticed</option><option value="unspecified">Present — amount not sure</option><option value="trace">Trace</option><option value="small">Small amount</option><option value="moderate">Moderate amount</option><option value="heavy">Heavy / continuous — urgent</option></select></label>
          {blood === "heavy" && <div className="inline-danger" role="alert">Heavy or continuous bleeding needs urgent care now. Use 111, or 999 / A&amp;E if severe.</div>}
          <label>Pain (optional)<input type="number" min="0" max="10" value={pain} onChange={(e) => setPain(e.target.value)} placeholder="0–10" /></label>
        </>}
        {(kind === "meal" || kind === "toilet-photo") && <>
          {kind === "toilet-photo" && <div className="consent-box"><label><input type="checkbox" checked={toiletConsent} onChange={(e) => { setToiletConsent(e.target.checked); updatePrivacy({ toiletPhotoConsent: e.target.checked }); }} /> I consent to discreet storage and understand I can delete this photo at any time.</label><p>Image observations are suggestions only and never trigger care. Consent is saved before optional provider analysis and can be withdrawn in Privacy.</p></div>}
          <input ref={fileRef} className="sr-only" type="file" accept="image/jpeg,image/png,image/heic,.heic" capture="environment" onChange={onFile} aria-label={`Choose ${kind === "meal" ? "meal" : "toilet"} photo`} />
          {photo ? <><div className="photo-review"><img src={photo.previewUrl} alt={`${photo.purpose} photo preview: ${photo.name}`}/><div><b>{photo.name}</b><p className="field-help" role="status">Photo ready to review; it has not been added to your journal yet.</p><label>Keep photo for<select value={photo.retentionDays} onChange={(e) => setPhoto({ ...photo, retentionDays: Number(e.target.value) as 7 | 30 | 90 })}><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></select></label><button type="button" className="text-btn" onClick={() => fileRef.current?.click()} aria-label={`Replace ${photo.purpose} photo`}>Replace photo</button><button type="button" className="text-btn" onClick={() => { setPhoto(undefined); setImageFile(null); if (fileRef.current) fileRef.current.value = ""; }} aria-label={`Remove selected ${photo.purpose} photo`}>Remove photo</button></div></div><button type="button" className="btn" onClick={analyzePhoto} disabled={imageBusy}>{imageBusy ? "Checking Runware…" : `Optionally describe ${photo.purpose === "meal" ? "meal" : "toilet image"} with Runware`}</button><label>Review or replace the image observation<textarea value={photo.derivedObservation ?? ""} onChange={(e) => setPhoto({ ...photo, derivedObservation: e.target.value })} /><span className="field-help">Model output is unconfirmed, never diagnostic, and cannot trigger tests, urgency or medicine.</span></label></> : <button type="button" className="upload-drop" onClick={() => fileRef.current?.click()} aria-label="Take or choose a photo"><Camera aria-hidden="true" /><b>Take or choose a photo</b><span>JPEG, PNG or HEIC · max 8 MB</span></button>}
          <label>{kind === "meal" ? "Meal description or likely ingredients (optional)" : "Your note (optional)"}<textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder={kind === "meal" ? "For example: porridge, banana and coffee" : "Only add what you want recorded"} /></label>
          {kind === "meal" && <div className="field-pair"><label>Portion (optional)<input value={portion} onChange={(e) => setPortion(e.target.value)} /></label><label>Hydration (optional)<input value={hydration} onChange={(e) => setHydration(e.target.value)} /></label></div>}
          <p className="privacy-note">MeMed never calculates calories, macros, meal scores or moral judgements.</p>
        </>}
        {kind === "pain" && <><fieldset><legend>Pain right now</legend><div className="scale-row pain-scale">{[0,2,4,6,8,10].map((value) => <button type="button" key={value} className={pain === String(value) ? "scale selected" : "scale"} onClick={() => setPain(String(value))}>{value}</button>)}</div></fieldset><label>Where? (optional)<input value={site} onChange={(e) => setSite(e.target.value)} placeholder="For example: lower right" /></label></>}
        {kind === "wellbeing" && <><fieldset><legend>Compared with your usual</legend><div className="segmented">{["better","same","worse"].map((value) => <button key={value} className={wellbeing === value ? "selected" : ""} onClick={() => setWellbeing(value)}>{value}</button>)}</div></fieldset><div className="field-pair"><label>Fatigue (optional)<select value={fatigue} onChange={(e) => setFatigue(e.target.value)}><option value="">Not recorded</option><option>low</option><option>moderate</option><option>high</option></select></label><label>Mood (optional)<select value={mood} onChange={(e) => setMood(e.target.value)}><option value="">Not recorded</option><option>good</option><option>low</option><option>anxious</option><option>irritable</option></select></label><label>Appetite (optional)<select value={appetite} onChange={(e) => setAppetite(e.target.value)}><option value="">Not recorded</option><option>usual</option><option>reduced</option><option>increased</option></select></label><label>Sleep hours (optional)<input type="number" min="0" max="24" step="0.5" value={sleep} onChange={(e) => setSleep(e.target.value)} /></label><label>Weight in kg (optional)<input type="number" min="20" max="400" step="0.1" value={weight} onChange={(e) => setWeight(e.target.value)} /></label></div><label>Anything to add? (optional)<textarea value={description} onChange={(e) => setDescription(e.target.value)} /></label></>}
        {(kind === "life" || kind === "medication") && <label>{kind === "life" ? "What happened?" : "What did you take?"}<textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder={kind === "life" ? "A night out, travel, stress, a celebration…" : "Medicine and dose, if known"} /></label>}
        <div className="button-row end"><button className="btn" onClick={closeCapture} disabled={saving}>Cancel</button><button className="btn primary" onClick={() => void submit()} disabled={saving || imageBusy}>{saving ? "Saving securely…" : "Add to journal"}</button></div>
        {saving && <span className="sr-only" role="status" aria-live="polite">Saving this journal entry securely. Capture controls are temporarily unavailable.</span>}
      </section>
    </div>
  );
}

function EditDialog({ entry, onClose }: { entry: JournalEntry; onClose: () => void }) {
  const { updateEntry } = useDemoStore();
  const [body, setBody] = useState(entry.body);
  const [derived, setDerived] = useState(entry.photo?.derivedObservation ?? "");
  const [kind, setKind] = useState<EntryKind>(entry.kind);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useModalFocus(true, dialogRef, closeRef, onClose);
  return <div className="modal-layer"><section ref={dialogRef} className="capture-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-title"><button ref={closeRef} className="icon-btn close-corner" onClick={onClose} aria-label="Close editor"><X /></button><p className="eyebrow">Correct the source record</p><h2 id="edit-title">Edit journal entry</h2><label>Entry type<select value={kind} onChange={(e) => setKind(e.target.value as EntryKind)}>{["BOWEL MOVEMENT","MEAL","PAIN","FATIGUE","WELLBEING","LIFE EVENT","MEDICATION","FROM YOUR WATCH","Penny noticed"].map((value) => <option key={value}>{value}</option>)}</select></label><label>What should the record say?<textarea value={body} onChange={(e) => setBody(e.target.value)} /><span className="field-help">Explicit details such as “Bristol type 4, no blood and no urgency” also correct the structured evidence used by patterns.</span></label>{entry.photo && <label>Correct the image-derived observation<textarea value={derived} onChange={(e) => setDerived(e.target.value)} /><span className="field-help">This remains an observation, not a diagnosis or trigger.</span></label>}<div className="button-row end"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => { if (!body.trim()) return; updateEntry(entry.id, { kind, body: body.trim(), ...(entry.photo ? { photo: { ...entry.photo, derivedObservation: derived.trim() } } : {}) }); onClose(); }}>Save correction</button></div></section></div>;
}

export function JournalPanel({ notify, onOpenCare, onOpenSafetyCheck = () => onOpenCare("taper"), trackingEnabled }: { notify: (text: string) => void; onOpenCare: (focus?: "test" | "team" | "taper") => void; onOpenSafetyCheck?: () => void; trackingEnabled: boolean }) {
  const { state, saveEntry, deleteEntry } = useDemoStore();
  const [capture, setCapture] = useState<CaptureKind | null>(null);
  const [editing, setEditing] = useState<JournalEntry | null>(null);
  const [deleting, setDeleting] = useState<JournalEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [quickAction, setQuickAction] = useState<"check-in" | "meal" | "toilet" | null>(null);
  const quickMealRef = useRef<HTMLInputElement | null>(null);
  const quickToiletRef = useRef<HTMLInputElement | null>(null);
  const journalHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const deleteActionRefs = useRef(new Map<number, HTMLButtonElement>());
  const reminders = useMemo(() => deriveReminders(state), [state]);
  const doseSupportActive = taperTreatmentActive(state);
  const todayKey = dateInTimeZone(new Date(), state.profile.timeZone);
  const currentDose = doseSupportActive
    ? state.taper.days.find((day) => day.date === todayKey)
    : state.taper.days.find((day) => day.day === state.taper.currentDay);
  const oneTapCheckIn = async (wellbeing: "better" | "same" | "worse") => {
    if (quickAction) return;
    setQuickAction("check-in");
    try {
      const saved = await saveEntry({ kind: "WELLBEING", body: `Feeling ${wellbeing} than usual — one-tap check-in`, source: "manual", flagged: wellbeing === "worse", structured: { wellbeing, oneTap: true } });
      notify(saved
        ? `${wellbeing[0].toUpperCase()}${wellbeing.slice(1)} check-in saved. Add detail only if it helps.`
        : "That check-in was not saved. Try again when the API is available.");
    } finally {
      setQuickAction(null);
    }
  };
  const quickPhoto = async (event: ChangeEvent<HTMLInputElement>, purpose: "meal" | "toilet") => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const supported = ["image/jpeg", "image/png", "image/heic"].includes(file.type.toLowerCase())
      || (/\.(?:jpe?g|png|heic)$/i.test(file.name) && !file.type);
    if (!supported) return notify("Choose a JPEG, PNG or HEIC image.");
    if (file.size > 8 * 1024 * 1024) return notify("Choose an image smaller than 8 MB.");
    if (purpose === "toilet" && !state.privacy.toiletPhotoConsent) {
      setCapture("toilet-photo");
      return notify("Review and confirm optional toilet-photo consent before quick capture.");
    }
    if (quickAction) return;
    setQuickAction(purpose);
    try {
      const previewUrl = await fileAsDataUrl(file);
      const photo: PhotoAttachment = {
        name: file.name,
        previewUrl,
        purpose,
        retentionDays: state.privacy.photoRetentionDays,
        consented: true,
        derivedObservation: "No image-derived observation is currently recorded.",
      };
      const saved = await saveEntry(purpose === "meal"
        ? { kind: "MEAL", body: "Meal photo captured — description optional", source: "manual", structured: { description: "", portion: "", hydration: "", quickPhoto: true }, photo }
        : { kind: "BOWEL MOVEMENT", body: "Optional toilet photo captured; observations awaiting review", source: "manual", structured: { imageObservationUnconfirmed: true, quickPhoto: true }, photo });
      notify(saved
        ? `${purpose === "meal" ? "Meal" : "Toilet"} photo saved with your ${state.privacy.photoRetentionDays}-day retention setting. You can close MeMed or edit it later; no calories or clinical action were inferred.`
        : "That photo was not saved. Keep MeMed open and try again when the API is available.");
    } catch {
      notify("That image could not be read. Choose another file.");
    } finally {
      setQuickAction(null);
    }
  };
  const groups = useMemo(() => {
    const visible = [...state.entries].sort((a, b) => `${b.date}T${b.time}`.localeCompare(`${a.date}T${a.time}`));
    const yesterdayKey = addCalendarDays(todayKey, -1);
    const byDate = new Map<string, JournalEntry[]>();
    visible.forEach((entry) => byDate.set(entry.date, [...(byDate.get(entry.date) ?? []), entry]));
    return [...byDate].map(([dateKey, entries]) => ({
      label: journalDayLabel(dateKey, todayKey, yesterdayKey),
      entries,
    }));
  }, [state.entries, todayKey]);
  const recentGroups = groups.slice(0, 4);
  const earlierGroups = groups.slice(4);
  const earlierEntryCount = earlierGroups.reduce((total, group) => total + group.entries.length, 0);
  const renderGroup = (group: (typeof groups)[number]) => (
    <section key={group.label}><p className="day">{group.label}</p><div className="tl">{group.entries.map((entry) => <EntryRow key={entry.id} entry={entry} onEdit={() => setEditing(entry)} onDelete={() => setDeleting(entry)} notify={notify} deleteButtonRef={(element) => { if (element) deleteActionRefs.current.set(entry.id, element); else deleteActionRefs.current.delete(entry.id); }} />)}</div></section>
  );

  const confirmEntryDeletion = async () => {
    if (!deleting || deleteBusy) return;
    const orderedEntries = groups.flatMap((group) => group.entries);
    const targetIndex = orderedEntries.findIndex((entry) => entry.id === deleting.id);
    const focusCandidates = targetIndex < 0
      ? []
      : [
          ...orderedEntries.slice(targetIndex + 1),
          ...orderedEntries.slice(0, targetIndex).reverse(),
        ].map((entry) => entry.id);
    setDeleteBusy(true);
    const deleted = await deleteEntry(deleting.id);
    setDeleteBusy(false);
    if (!deleted) {
      notify("That entry was not deleted. It remains in your journal; try again when the API is available.");
      return;
    }
    setDeleting(null);
    requestAnimationFrame(() => {
      const adjacentAction = focusCandidates
        .map((id) => deleteActionRefs.current.get(id))
        .find((element) => element?.isConnected && !element.closest("details:not([open])"));
      if (adjacentAction) adjacentAction.focus();
      else journalHeadingRef.current?.focus();
    });
    notify("Entry deleted and removed from Penny’s evidence.");
  };

  return (
    <aside className="journal" aria-labelledby="journal-heading">
      <div className="journalhead"><div><h2 ref={journalHeadingRef} id="journal-heading" tabIndex={-1}>Journal</h2><p className="sub">One correctable stream — this is what Penny reads.</p></div><button className="icon-btn add" disabled={!trackingEnabled || Boolean(quickAction)} onClick={() => setCapture("bowel")} aria-label="Add journal entry"><Plus /></button></div>
      {state.phase === "recovery" && currentDose && <section className="recovery-home-card"><Pill aria-hidden="true" /><div><span>{doseSupportActive ? `Prescribed recovery support · day ${currentDose.day}` : "Imported schedule · review only"}</span><b>{doseSupportActive ? `${currentDose.doseMg} mg ${state.taper.medicine}` : `${state.taper.medicine} schedule on file`}</b><small>{doseSupportActive ? (currentDose.taken ? "Recorded as taken" : "Confirm only after taking it exactly as prescribed.") : "Treatment is not active; no proactive dose detail or action is shown."}</small></div><button className={doseSupportActive ? "btn primary" : "btn"} onClick={() => onOpenCare("taper")}>{doseSupportActive ? "Open dose support" : "Review schedule"}</button></section>}
      {!trackingEnabled && <p className="quick-note"><LockKeyhole aria-hidden="true" /> New capture is paused. Existing entries below remain correctable, excludable and individually deletable.</p>}
      <div className="quickadd">
        {phaseCaptureOrder[state.phase].map((kind) => { const { label, icon: Icon } = captureActions[kind]; return <button key={kind} className="qbtn" disabled={!trackingEnabled || Boolean(quickAction)} onClick={() => setCapture(kind)}><Icon aria-hidden="true" />{label}</button>; })}
      </div>
      <div className="fast-photo-actions" aria-label="Fire-and-forget photo capture">
        <input ref={quickMealRef} className="sr-only" type="file" accept="image/jpeg,image/png,image/heic,.heic" capture="environment" disabled={!trackingEnabled || Boolean(quickAction)} onChange={(event) => void quickPhoto(event, "meal")} aria-label="Choose a quick meal photo" />
        <input ref={quickToiletRef} className="sr-only" type="file" accept="image/jpeg,image/png,image/heic,.heic" capture="environment" disabled={!trackingEnabled || Boolean(quickAction)} onChange={(event) => void quickPhoto(event, "toilet")} aria-label="Choose a quick toilet photo" />
        <button className="text-btn" disabled={!trackingEnabled || Boolean(quickAction)} onClick={() => quickMealRef.current?.click()}><Camera aria-hidden="true" /> {quickAction === "meal" ? "Saving meal photo…" : "Quick meal camera"}</button>
        <button className="text-btn" disabled={!trackingEnabled || Boolean(quickAction)} onClick={() => state.privacy.toiletPhotoConsent ? quickToiletRef.current?.click() : setCapture("toilet-photo")}><Camera aria-hidden="true" /> {quickAction === "toilet" ? "Saving toilet photo…" : `Quick toilet camera${!state.privacy.toiletPhotoConsent ? " · consent first" : ""}`}</button>
      </div>
      {quickAction && <p className="quick-save-status" role="status">{quickAction === "check-in" ? "Saving your check-in securely…" : `Reading and saving your ${quickAction} photo securely…`}</p>}
      <fieldset className="one-tap-checkin" disabled={!trackingEnabled || Boolean(quickAction)}><legend>Compared with your usual</legend><div className="segmented">{(["better", "same", "worse"] as const).map((value) => <button key={value} onClick={() => oneTapCheckIn(value)}>{value}</button>)}</div><span>One tap is enough. Use Detailed check-in only when you want to add more.</span></fieldset>
      {(state.phase === "watch" || state.phase === "flare") && <p className="quick-note"><HeartPulse aria-hidden="true" /> Bowel changes, pain and wellbeing are prioritised now; every other capture remains available.</p>}
      <p className="quick-note"><Utensils aria-hidden="true" /> Quick camera saves with your retention setting so you can move on. The full photo form lets you review details first; every background observation stays correctable.</p>
      {reminders.length > 0 && <section className="reminder-stack" aria-labelledby="reminders-heading"><p className="day" id="reminders-heading">Discreet reminders</p>{reminders.map((reminder) => <article key={reminder.id}><div><b>{reminder.title}</b><span>{reminder.detail}</span></div>{reminder.id === "taper" ? <button className="text-btn" onClick={() => onOpenCare("taper")}>Open Care</button> : reminder.id === "test-delivery" ? <button className="text-btn" onClick={() => onOpenCare("test")}>Open test</button> : reminder.id === "team-response" ? <button className="text-btn" onClick={() => onOpenCare("team")}>Open message</button> : reminder.id === "phase-flare" ? <button className="text-btn" onClick={onOpenSafetyCheck}>Safety check</button> : reminder.id === "phase-watch" ? <button className="text-btn" onClick={() => setCapture("bowel")}>Add change</button> : reminder.id === "phase-recovery" ? <button className="text-btn" onClick={() => onOpenCare("taper")}>Check in</button> : reminder.id === "medicine" ? <button className="text-btn" onClick={() => setCapture("medication")}>Record</button> : reminder.id === "wellbeing" ? <button className="text-btn" onClick={() => setCapture("wellbeing")}>Check in</button> : reminder.id === "meal" ? <button className="text-btn" onClick={() => setCapture("meal")}>Add</button> : null}</article>)}</section>}
      {recentGroups.map(renderGroup)}
      {earlierGroups.length > 0 && <details className="journal-archive"><summary><span><b>Earlier journal history</b><small>{earlierGroups.length} earlier {earlierGroups.length === 1 ? "day" : "days"} · {earlierEntryCount} {earlierEntryCount === 1 ? "entry" : "entries"}</small></span><ChevronDown aria-hidden="true" /></summary>{earlierGroups.map(renderGroup)}</details>}
      {groups.length === 0 && <div className="empty-state"><b>No journal entries</b><span>Add one with a quick action or by talking to Penny.</span></div>}
      {capture && <CaptureDialog kind={capture} onClose={() => setCapture(null)} notify={notify} />}
      {editing && <EditDialog entry={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={Boolean(deleting)} title="Delete this journal entry?" description="This removes the source record, attached image and its downstream evidence from this demo. This cannot be undone." confirmLabel={deleteBusy ? "Deleting entry…" : "Delete entry"} danger busy={deleteBusy} onCancel={() => setDeleting(null)} onConfirm={() => { void confirmEntryDeletion(); }}>{deleteBusy && <p role="status">Deleting the entry and refreshing its downstream evidence…</p>}</ConfirmDialog>
    </aside>
  );
}
