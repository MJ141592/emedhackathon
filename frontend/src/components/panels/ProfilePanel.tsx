import { useState } from "react";
import { Check, ClipboardList, HeartHandshake, LockKeyhole, Plus, Stethoscope, UserRound } from "lucide-react";
import { useDemoStore } from "../../store/DemoStore";
import { browserTimeZone, dateInTimeZone, isValidTimeZone, normalizeTimeZone } from "../../store/patientTime";
import type { CareContact, Profile, ProfileProposal, ProfileProposalField } from "../../types";

const proposalFieldLabels: Record<ProfileProposalField, string> = {
  surgeries: "Surgery / stoma history",
  conditions: "Other significant conditions",
  allergies: "Allergies and intolerances",
  pastMedicines: "Past medicines and why stopped",
};

export function isAdultDate(dateOfBirth: string, now = new Date(), timeZone = browserTimeZone()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth) || Number.isNaN(now.getTime())) return false;
  const today = dateInTimeZone(now, timeZone);
  const [birthYear, birthMonth, birthDay] = dateOfBirth.split("-").map(Number);
  const [year, month, day] = today.split("-").map(Number);
  const validBirth = new Date(Date.UTC(birthYear, birthMonth - 1, birthDay));
  if (validBirth.getUTCFullYear() !== birthYear || validBirth.getUTCMonth() !== birthMonth - 1 || validBirth.getUTCDate() !== birthDay || dateOfBirth > today) return false;
  let age = year - birthYear;
  if (month < birthMonth || (month === birthMonth && day < birthDay)) age -= 1;
  return age >= 18;
}

export function formatConsentTimestamp(value: string, timeZone: string): string {
  const zone = normalizeTimeZone(timeZone, "UTC");
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return `Unknown time (${zone})`;
  return `${new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: zone,
  }).format(instant)} (${zone})`;
}

export function ProfilePanel({ notify }: { notify: (message: string) => void }) {
  const { state, updateProfile, updateContacts, resolveProfileProposal } = useDemoStore();
  const [profile, setProfile] = useState<Profile>(state.profile);
  const [contacts, setContacts] = useState<CareContact[]>(state.contacts);
  const [adultConsent, setAdultConsent] = useState(state.profile.adultEligibilityConfirmed);
  const [healthConsent, setHealthConsent] = useState(state.profile.healthDataConsent);
  const [saving, setSaving] = useState(false);
  const [pmhField, setPmhField] = useState<"surgeries" | "conditions" | "allergies" | "familyHistory" | "pastMedicines">("conditions");
  const [pmhCandidate, setPmhCandidate] = useState("");
  const [pmhProposal, setPmhProposal] = useState<{ field: typeof pmhField; value: string }>();

  const field = <K extends keyof Profile>(key: K, value: Profile[K]) => setProfile((current) => ({ ...current, [key]: value }));
  const save = async (complete = false) => {
    if (saving) return;
    const hasCareRoute = contacts.some((contact) => contact.name.trim() && contact.role.trim() && contact.phone.trim());
    const requiredBaselineComplete = profile.usualBowel.trim() && profile.usualPain.trim() && profile.carePlan.trim();
    const deliveryComplete = profile.address.trim() && profile.postcode.trim();
    const consentActive = adultConsent && healthConsent;
    const keepingTrackingActive = consentActive && (complete || profile.onboardingComplete);
    if (keepingTrackingActive && (!profile.name.trim() || !profile.dateOfBirth || !profile.diagnosis.trim() || !requiredBaselineComplete || !deliveryComplete || !hasCareRoute)) {
      notify("Complete identity, diagnosis, bowel and pain baselines, care plan, delivery address, one clinical contact, and both consent statements.");
      return;
    }
    if (keepingTrackingActive && !isAdultDate(profile.dateOfBirth, new Date(), profile.timeZone)) {
      notify("Gutsy onboarding is currently for adults aged 18 or older.");
      return;
    }
    if (!isValidTimeZone(profile.timeZone)) {
      notify("Enter a valid IANA time zone, such as Europe/London. This keeps calendar days and reminders aligned with you.");
      return;
    }
    const next = {
      ...profile,
      timeZone: profile.timeZone.trim(),
      adultEligibilityConfirmed: adultConsent,
      healthDataConsent: healthConsent,
      consentVersion: "demo-v1",
      consentRecordedAt: consentActive ? profile.consentRecordedAt ?? new Date().toISOString() : undefined,
      onboardingComplete: (complete || profile.onboardingComplete) && consentActive,
    };
    setProfile(next);
    const withdrawsActiveConsent = (
      state.profile.healthDataConsent && !next.healthDataConsent
    ) || (
      state.profile.adultEligibilityConfirmed && !next.adultEligibilityConfirmed
    );
    const contactsChanged = JSON.stringify(contacts) !== JSON.stringify(state.contacts);
    setSaving(true);
    const profileSave = updateProfile(next);
    // Normal onboarding/profile saves must compose with contacts in the same eager snapshot.
    // A withdrawal owns the explicit mutation slot, so changed contacts follow only after its
    // authoritative response has been accepted instead of being silently dropped.
    if (!withdrawsActiveConsent) updateContacts(contacts);
    const profileSaved = await profileSave;
    if (profileSaved && withdrawsActiveConsent && contactsChanged) updateContacts(contacts);
    setSaving(false);
    if (!profileSaved) {
      notify("Those consent changes were not saved. Tracking remains in its previous state; keep Gutsy open and try again.");
      return;
    }
    notify(complete
      ? "Onboarding and consent recorded. You can correct, revoke or delete every field later."
      : profile.onboardingComplete && !consentActive
        ? contactsChanged
          ? "Health-data consent withdrawn. Tracking is paused; your contact edits are now saving."
          : "Health-data consent withdrawn. Tracking is paused; export or delete existing data under Privacy."
        : "Profile, PMH and consent choices saved.");
  };
  const contactField = (id: string, key: keyof CareContact, value: string) => setContacts((current) => current.map((contact) => contact.id === id ? { ...contact, [key]: value } : contact));
  const acceptPmhProposal = () => {
    if (!pmhProposal) return;
    const existing = String(profile[pmhProposal.field]).trim();
    field(pmhProposal.field, `${existing}${existing ? "; " : ""}${pmhProposal.value}`);
    setPmhProposal(undefined);
    setPmhCandidate("");
    notify("Proposed PMH wording accepted into the editable form. Use Save changes to persist it.");
  };
  const acceptConversationProposal = (proposal: ProfileProposal) => {
    const existing = String(profile[proposal.field]).trim();
    const alreadyPresent = existing.toLocaleLowerCase().includes(proposal.value.toLocaleLowerCase());
    const value = alreadyPresent ? existing : `${existing}${existing ? "; " : ""}${proposal.value}`;
    setProfile((current) => ({ ...current, [proposal.field]: value }));
    void updateProfile({ [proposal.field]: value });
    resolveProfileProposal(proposal.id, "accepted");
    notify("PMH proposal accepted and saved to your profile.");
  };

  return <div className="panel-stack profile-panel">
    <section className="panel-intro"><span className={`pill ${profile.onboardingComplete ? "ok" : "watch"}`}>{profile.onboardingComplete ? "Baseline active" : "Finish onboarding"}</span><h3>Your context, controlled by you</h3><p>Remi uses only the profile areas allowed in Privacy. Past medical history shapes context and safety screening; it never authorises a clinical decision.</p></section>

    <section className="feature-card">
      <div className="section-heading"><div><p className="eyebrow">Step 1 · About you</p><h3>Adult onboarding and consent</h3></div><UserRound /></div>
      <div className="field-pair"><label>Full name<input value={profile.name} onChange={(e) => field("name", e.target.value)} /></label><label>Date of birth<input type="date" value={profile.dateOfBirth} onChange={(e) => field("dateOfBirth", e.target.value)} /></label></div>
      <div className="field-pair"><label>Home time zone (IANA)<input list="common-time-zones" value={profile.timeZone} onChange={(event) => field("timeZone", event.target.value)} placeholder="Europe/London" /><span className="field-help">Used for “today”, treatment schedules and reminder timing.</span></label><div><button className="btn" onClick={() => field("timeZone", browserTimeZone())}>Use this device’s time zone</button></div></div>
      <datalist id="common-time-zones"><option value="Europe/London" /><option value="Europe/Amsterdam" /><option value="America/New_York" /><option value="America/Chicago" /><option value="America/Denver" /><option value="America/Los_Angeles" /><option value="Asia/Kolkata" /><option value="Asia/Singapore" /><option value="Australia/Sydney" /><option value="Pacific/Auckland" /><option value="UTC" /></datalist>
      <div className="consent-box"><label><input type="checkbox" checked={adultConsent} onChange={(e) => setAdultConsent(e.target.checked)} /> I confirm I am 18 or older and this demo complements, not replaces, my clinical care.</label><label><input type="checkbox" checked={healthConsent} onChange={(e) => setHealthConsent(e.target.checked)} /> I consent to holding sensitive health information in this live session and the development demo API’s encrypted database.</label><p>Consent record: {profile.consentRecordedAt ? `${profile.consentVersion} · ${formatConsentTimestamp(profile.consentRecordedAt, profile.timeZone)}` : "not yet recorded"}. Uncheck and save to pause new tracking; existing data remains available to correct, export or delete.</p></div>
    </section>

    <section className="feature-card">
      <div className="section-heading"><div><p className="eyebrow">Step 2 · IBD baseline</p><h3>What is usual for you?</h3></div><Stethoscope /></div>
      <div className="field-pair"><label>Diagnosis<input value={profile.diagnosis} onChange={(e) => field("diagnosis", e.target.value)} placeholder="Crohn’s disease or ulcerative colitis" /></label><label>Subtype<input value={profile.subtype} onChange={(e) => field("subtype", e.target.value)} /></label><label>Year diagnosed<input value={profile.diagnosedYear} onChange={(e) => field("diagnosedYear", e.target.value)} /></label><label>Disease extent<input value={profile.extent} onChange={(e) => field("extent", e.target.value)} /></label></div>
      <div className="field-pair"><label>Usual bowel pattern<input value={profile.usualBowel} onChange={(e) => field("usualBowel", e.target.value)} /></label><label>Usual pain<input value={profile.usualPain} onChange={(e) => field("usualPain", e.target.value)} /></label><label>Usual resting heart rate<input value={profile.usualHeartRate} onChange={(e) => field("usualHeartRate", e.target.value)} /></label><label>Usual sleep<input value={profile.usualSleep} onChange={(e) => field("usualSleep", e.target.value)} /></label></div>
      <label>Personal care plan<textarea value={profile.carePlan} onChange={(e) => field("carePlan", e.target.value)} /></label>
    </section>

    <section className="feature-card">
      <div className="section-heading"><div><p className="eyebrow">Step 3 · Past medical history</p><h3>Structured grounding context</h3></div><ClipboardList /></div>
      <label>Prior surgery / stoma history<textarea value={profile.surgeries} onChange={(e) => field("surgeries", e.target.value)} /></label>
      <div className="field-pair"><label>Other significant conditions<textarea value={profile.conditions} onChange={(e) => field("conditions", e.target.value)} placeholder="Diabetes, bone health, mental health…" /></label><label>Allergies and intolerances<textarea value={profile.allergies} onChange={(e) => field("allergies", e.target.value)} /></label><label>Current medicines and reason<input value={profile.currentMedicines} onChange={(e) => field("currentMedicines", e.target.value)} /></label><label>Past medicines and why stopped<input value={profile.pastMedicines} onChange={(e) => field("pastMedicines", e.target.value)} /></label><label>Family history<input value={profile.familyHistory} onChange={(e) => field("familyHistory", e.target.value)} /></label><label>Dietary needs<input value={profile.dietaryNeeds} onChange={(e) => field("dietaryNeeds", e.target.value)} /></label></div>
      <label className="toggle-row"><span><b>Immunosuppressed</b><small>Used for infection safety context</small></span><input type="checkbox" checked={profile.immunosuppressed} onChange={(e) => field("immunosuppressed", e.target.checked)} /></label>
      {state.profileProposals.length > 0 && <div className="proposal-review" aria-label="Conversation-derived PMH proposals">
        <p><b>Review wording noticed in conversation</b></p>
        {state.profileProposals.map((proposal) => <div className="pmh-proposal-item" key={proposal.id}>
          <p><b>Profile field:</b> {proposalFieldLabels[proposal.field]}</p>
          <p><b>Exact proposed wording:</b> {proposal.value}</p>
          {proposal.status === "pending" ? <div className="button-row">
            <button className="btn primary" onClick={() => acceptConversationProposal(proposal)}>Accept and save</button>
            <button className="btn" onClick={() => { resolveProfileProposal(proposal.id, "dismissed"); notify("PMH proposal dismissed; the profile was not changed."); }}>Dismiss</button>
          </div> : <span className={`status ${proposal.status === "accepted" ? "ok" : ""}`}>{proposal.status === "accepted" ? "Accepted into profile" : "Dismissed — profile unchanged"}</span>}
        </div>)}
      </div>}
      <div className="pmh-suggestion"><Plus /><div><b>Remi can propose, never silently add, PMH updates</b><p>Turn a fact noticed in conversation into exact, reviewable wording. Preparing a proposal does not change the profile.</p><div className="field-pair"><label>Profile area<select value={pmhField} onChange={(event) => setPmhField(event.target.value as typeof pmhField)}><option value="conditions">Other condition</option><option value="surgeries">Surgery / stoma history</option><option value="allergies">Allergy / intolerance</option><option value="familyHistory">Family history</option><option value="pastMedicines">Past medicine</option></select></label><label>Exact proposed wording<input value={pmhCandidate} onChange={(event) => setPmhCandidate(event.target.value)} placeholder="For example: ileocecal resection in 2019" /></label></div><button className="btn" disabled={!pmhCandidate.trim()} onClick={() => setPmhProposal({ field: pmhField, value: pmhCandidate.trim() })}>Prepare proposal</button>{pmhProposal && <div className="proposal-review" role="status"><p><b>Proposed {pmhProposal.field} update:</b> {pmhProposal.value}</p><div className="button-row"><button className="btn primary" onClick={acceptPmhProposal}>Accept into profile form</button><button className="btn" onClick={() => { setPmhProposal(undefined); notify("PMH proposal dismissed; the profile was not changed."); }}>Not now</button></div></div>}</div>{!pmhProposal && <span className="status ok"><Check /> Patient review required</span>}</div>
    </section>

    <section className="feature-card">
      <div className="section-heading"><div><p className="eyebrow">Step 4 · Care routes</p><h3>Delivery and named clinical contacts</h3></div><HeartHandshake /></div>
      <div className="field-pair"><label>Home address<input value={profile.address} onChange={(e) => field("address", e.target.value)} /></label><label>Postcode<input value={profile.postcode} onChange={(e) => field("postcode", e.target.value)} /></label></div>
      <div className="contact-edit-list">{contacts.map((contact) => <fieldset key={contact.id}><legend>{contact.role || "Care contact"}</legend><div className="field-pair"><label>Name<input value={contact.name} onChange={(e) => contactField(contact.id, "name", e.target.value)} /></label><label>Role<input value={contact.role} onChange={(e) => contactField(contact.id, "role", e.target.value)} /></label><label>Organisation / pharmacy<input value={contact.organisation} onChange={(e) => contactField(contact.id, "organisation", e.target.value)} /></label><label>Phone<input value={contact.phone} onChange={(e) => contactField(contact.id, "phone", e.target.value)} /></label></div><button className="text-btn" onClick={() => setContacts((current) => current.filter((item) => item.id !== contact.id))}>Remove contact</button></fieldset>)}</div>
      <button className="btn" onClick={() => setContacts((current) => [...current, { id: `contact-${Date.now()}`, initials: "NC", name: "", role: "", organisation: "", phone: "" }])}><Plus /> Add care contact</button>
    </section>

    <section className="privacy-note strong"><LockKeyhole /><p><b>Highly sensitive health data.</b> View source use in Trends &amp; evidence. Correct, exclude, export or delete it under Privacy. Profile access can be revoked independently.</p></section>
    <div className="sticky-actions"><button className="btn" disabled={saving} onClick={() => { void save(false); }}>{saving ? "Saving…" : "Save changes"}</button>{!profile.onboardingComplete && <button className="btn primary" disabled={saving} onClick={() => { void save(true); }}>{saving ? "Saving…" : "Complete onboarding"}</button>}</div>
  </div>;
}
