import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Clock3, Download, LockKeyhole, MessageSquare, PackageCheck, Phone, Pill, ShieldAlert, Stethoscope } from "lucide-react";
import { useDemoStore } from "../../store/DemoStore";
import type { SuggestionKind, TestStatus } from "../../types";
import { hasGovernedWatchEvidence, hasIncludedRaisedTestEvidence } from "../../store/dashboardDerivations";
import { taperTreatmentActive } from "../../store/recoveryGovernance";
import { buildClinicianSummary } from "../../store/stateDerivations";
import { dateInTimeZone, formatDateInTimeZone, formatTimeInTimeZone } from "../../store/patientTime";
import { ConfirmDialog } from "../ui/ConfirmDialog";

const TEST_STEPS: { status: TestStatus; label: string; detail: string }[] = [
  { status: "prepared", label: "Prepared for review", detail: "Governed symptom rule plus patient review — never AI alone" },
  { status: "ordered", label: "Order confirmed", detail: "Delivery address and consent confirmed by the patient" },
  { status: "shipped", label: "Kit shipped", detail: "Royal Mail 24 tracking simulated" },
  { status: "delivered", label: "Delivered", detail: "Collection guide is available" },
  { status: "sampled", label: "Sample collected", detail: "Patient confirms collection" },
  { status: "posted", label: "Posted to lab", detail: "Prepaid return tracked" },
  { status: "lab", label: "At the laboratory", detail: "Result usually in 3–4 days" },
  { status: "result", label: "Result available", detail: "Plain-language context shown with symptoms" },
  { status: "shared", label: "Shared with IBD team", detail: "Patient confirmed the share" },
];

const HIGH_OUTPUT_SAFETY_OPTION = "10 or more bowel movements in 24 hours";

type ConfirmKind = "test" | "share" | "team" | "prescription" | "dose" | null;

function downloadSummary(contents: string, date: string) {
  const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = `gutsy-clinician-summary-${date}.txt`;
  anchor.click();
  URL.revokeObjectURL(href);
}

export function CarePanel({ focus, notify, openUrgent }: { focus?: SuggestionKind; notify: (message: string) => void; openUrgent: () => void }) {
  const store = useDemoStore();
  const { state, updateTest, updateTeamMessage, refreshTeamMessage, updatePrescription, updateTaper, markDoseTaken, markDoseMissed, correctDoseRecord, importClinicalPlan, updateSummary, regenerateSummary } = store;
  const [confirm, setConfirm] = useState<ConfirmKind>(null);
  const [addressConfirmed, setAddressConfirmed] = useState(state.testOrder.addressConfirmed);
  const [testConsent, setTestConsent] = useState(state.testOrder.consent);
  const [messageBody, setMessageBody] = useState(state.teamMessage.body);
  const [teamReviewed, setTeamReviewed] = useState(false);
  const [summary, setSummary] = useState(state.clinicianSummary);
  const [sideEffects, setSideEffects] = useState<string[]>(state.taper.sideEffects);
  const [safety, setSafety] = useState<string[]>([]);
  const [missedDayToConfirm, setMissedDayToConfirm] = useState<number>();
  const [doseCorrection, setDoseCorrection] = useState<{ day: number; fact: "taken" | "missed" }>();

  useEffect(() => setMessageBody(state.teamMessage.body), [state.teamMessage.body, state.teamMessage.id]);
  useEffect(() => setSummary(state.clinicianSummary), [state.clinicianSummary]);
  useEffect(() => {
    const targetId = focus === "test" ? "test-flow" : focus === "team" ? "team-flow" : focus === "prescription" ? "prescription-flow" : focus === "taper" ? "taper-flow" : focus === "urgent" ? "safety-screen" : undefined;
    if (!targetId) return;
    requestAnimationFrame(() => document.getElementById(targetId)?.scrollIntoView?.({ block: "start" }));
  }, [focus]);

  const testIndex = TEST_STEPS.findIndex((step) => step.status === state.testOrder.status);
  const todayValue = dateInTimeZone(new Date(), state.profile.timeZone);
  const taperActionsAvailable = taperTreatmentActive(state);
  const currentDose = taperActionsAvailable
    ? state.taper.days.find((day) => day.date === todayValue)
    : state.taper.days.find((day) => day.day === state.taper.currentDay);
  const nextDose = state.taper.days.find((day) => day.day > (currentDose?.day ?? state.taper.currentDay) && day.doseMg !== currentDose?.doseMg);
  const unresolvedPastDoses = state.taper.days.filter((day) => day.date < todayValue && !day.taken && !state.taper.missedDays.includes(day.day));
  const missedDose = state.taper.days.find((day) => day.day === missedDayToConfirm);
  const takenDoseRecords = state.taper.days.filter((day) => day.taken);
  const missedDoseRecords = state.taper.days.filter((day) => state.taper.missedDays.includes(day.day));
  const ibdContact = state.contacts.find((contact) => /ibd|gastro|nurse/i.test(`${contact.role} ${contact.organisation}`)) ?? state.contacts[0];
  const prescriberContact = state.contacts.find((contact) => /consultant|gastro|prescriber|doctor|\bdr\b/i.test(`${contact.role} ${contact.name}`));
  const pharmacyContact = state.contacts.find((contact) => /pharmacy|pharmacist/i.test(`${contact.role} ${contact.organisation} ${contact.name}`));
  const teamName = ibdContact?.organisation || "your IBD team";
  const snoozeTime = state.taper.snoozedUntil ? new Date(state.taper.snoozedUntil) : undefined;
  const snoozeLabel = snoozeTime && !Number.isNaN(snoozeTime.getTime()) ? formatTimeInTimeZone(snoozeTime, state.profile.timeZone) : state.taper.snoozedUntil;
  const safetyEmergency = safety.some((item) => ["Heavy or continuous bleeding", "Severe abdominal pain", "Faint or collapsed", "Repeated vomiting or no wind"].includes(item));
  const safetySameDay = safety.some((item) => ["Fever", "Cannot keep fluids down", HIGH_OUTPUT_SAFETY_OPTION].includes(item));
  const resultIncludedInEvidence = state.entries.some((entry) => !entry.excluded && entry.kind === "TEST RESULT" && entry.structured?.calprotectin === state.testOrder.result);
  const governedTestOrderReady = state.phase === "watch"
    && state.phaseConfirmed
    && !state.pendingPhase
    && hasGovernedWatchEvidence(state);
  const trackingActive = state.profile.onboardingComplete
    && state.profile.adultEligibilityConfirmed
    && state.profile.healthDataConsent;
  const taperSteps = state.taper.days.filter((day, index, days) => index === 0 || day.doseMg !== days[index - 1].doseMg);
  const prescriptionRequestAllowed = state.phase === "flare"
    && state.phaseConfirmed
    && !state.pendingPhase
    && state.prescription.rescuePlanEligible
    && hasIncludedRaisedTestEvidence(state);
  const unresolvedExperimentReview = state.experiment.reviewRequestMessageId === state.teamMessage.id
    && !state.experiment.reviewApprovedAt
    && (state.teamMessage.status === "sent" || state.teamMessage.status === "read");
  const canPrepareFollowUp = state.teamMessage.status === "replied" && !unresolvedExperimentReview;
  const teamGovernanceReady = state.teamMessage.notificationRule !== "Not configured"
    && !state.teamMessage.clinicalOwner.startsWith("Not configured");
  const deliveryConfirmedAt = state.testOrder.confirmedAt
    ? new Date(state.testOrder.confirmedAt)
    : undefined;
  const deliveryConfirmationLabel = deliveryConfirmedAt && !Number.isNaN(deliveryConfirmedAt.getTime())
    ? `${formatDateInTimeZone(deliveryConfirmedAt, state.profile.timeZone)} at ${formatTimeInTimeZone(deliveryConfirmedAt, state.profile.timeZone)} (${state.profile.timeZone})`
    : undefined;

  const advanceTest = () => {
    const next = TEST_STEPS[testIndex + 1];
    if (!next) return;
    const patch: Parameters<typeof updateTest>[0] = { status: next.status };
    if (next.status === "result") {
      patch.result = 420;
      patch.resultNote = "Raised result — your IBD team must interpret this alongside symptoms and your care plan.";
      store.addEntry({ kind: "TEST RESULT", body: "Faecal calprotectin 420 µg/g — raised; shared interpretation pending", source: "care", flagged: true, structured: { calprotectin: 420, diagnostic: false } });
    }
    updateTest(patch);
    notify(`Demo fulfilment moved to: ${next.label}.`);
  };

  const confirmContent = useMemo(() => {
    if (confirm === "test") return { title: "Place this home-test order?", description: "You are confirming the delivery details and consent below. A clinically governed rule prepared this order; neither Penny nor image analysis made the decision.", label: "Confirm and order kit", action: () => { if (!governedTestOrderReady) return notify("The current included records must support a confirmed Watchful review before ordering."); if (!addressConfirmed || !testConsent) return notify("Confirm both the address and consent before ordering."); updateTest({ status: "ordered", addressConfirmed: true, consent: true }); setConfirm(null); notify("Kit order confirmed. Fulfilment is simulated in this demo."); } };
    if (confirm === "share") return { title: "Share this result with your IBD team?", description: "The result and its symptom context will be marked as shared in this simulation. It is not an emergency message, and your team must interpret the result.", label: "Confirm result sharing", action: () => { updateTest({ status: "shared" }); setConfirm(null); notify("Result sharing confirmed in the simulated care pathway."); } };
    if (confirm === "team") return { title: "Send this message to your IBD team?", description: `Review your words carefully. ${teamName} expects to respond ${state.teamMessage.expectedResponse.toLowerCase()}. This message is not an emergency service.`, label: "Approve and send", action: () => { if (!teamGovernanceReady) return notify("A named clinical owner and governed notification rule must be configured before sending."); if (state.teamMessageStale) return notify("Included records changed. Refresh and review this draft before sending."); if (!messageBody.trim()) return notify("The reviewed message cannot be empty."); if (!teamReviewed) return notify("Confirm that you reviewed the message before sending."); updateTeamMessage({ body: messageBody.trim(), status: "sent" }); setConfirm(null); setTeamReviewed(false); notify("Message sent in the simulated care pathway."); } };
    if (confirm === "prescription") return { title: "Ask the prescriber to review the rescue plan?", description: `This routes evidence to ${state.prescription.prescriber || "your named prescriber"}. It does not issue medicine. An authorised prescriber must decide, and Penny cannot select or change the dose.`, label: "Send request for prescriber review", action: () => { updatePrescription({ status: "requested" }); setConfirm(null); notify("Request sent for simulated prescriber review. No prescription has been issued."); } };
    if (confirm === "dose") return { title: `Confirm ${currentDose?.doseMg ?? 0} mg was taken?`, description: `Only confirm a dose you actually took. This records adherence to ${state.taper.prescribedBy || "the named prescriber"}’s verified prescription; it does not change today’s or any future dose.`, label: "Mark today’s dose as taken", action: () => { if (!taperActionsAvailable) return notify("Dose support starts only after clinician-issued treatment is collected or governed Recovery is confirmed."); markDoseTaken(); setConfirm(null); notify("Today’s prescribed dose marked as taken."); } };
    return null;
  }, [addressConfirmed, confirm, currentDose?.doseMg, governedTestOrderReady, markDoseTaken, messageBody, notify, state.prescription.prescriber, state.taper.prescribedBy, state.teamMessage.expectedResponse, state.teamMessageStale, taperActionsAvailable, teamGovernanceReady, teamName, teamReviewed, testConsent, updatePrescription, updateTeamMessage, updateTest]);

  return <div className="panel-stack care-stack">
    <section className="care-safety-strip"><ShieldAlert /><div><b>Contact first. Urgent symptoms cannot wait for messages.</b><span>{ibdContact ? `${ibdContact.name}: ${ibdContact.phone}` : "Add an IBD advice-line contact in Profile"} · expected response {state.teamMessage.expectedResponse.toLowerCase()}</span></div><button className="btn danger-outline" onClick={openUrgent}>Urgent help</button></section>

    <details className="feature-card personal-care-plan"><summary><Stethoscope aria-hidden="true" /><span><b>Your personal care plan</b><small>Recorded by you · open before choosing a care action</small></span></summary><p>{state.profile.carePlan || "No personal care-plan wording is recorded. Add it in Profile and use your named clinical contact for advice."}</p>{ibdContact && <a className="btn" href={`tel:${ibdContact.phone.replace(/[^+\d]/g, "")}`}><Phone aria-hidden="true" /> Call {ibdContact.name}</a>}</details>

    {!trackingActive && <div className="inline-warning"><LockKeyhole /><div><b>New care workflow actions are paused</b><p>Your care plan, contacts, results, schedules and summaries remain visible. Re-enable health-data consent in Profile before ordering, messaging, recording treatment or adding a safety check.</p></div></div>}
    <fieldset className="care-workflow-fieldset" disabled={!trackingActive}>
      <legend className="sr-only">Test, message, prescription, taper and safety workflows</legend>
    <section className={`feature-card ${focus === "test" ? "focus-ring" : ""}`} id="test-flow">
      <div className="section-heading"><div><p className="eyebrow">Closed-loop test</p><h3>Calprotectin home test · {state.testOrder.id}</h3></div><span className={`status ${state.testOrder.status === "result" || state.testOrder.status === "shared" ? "flag" : "watch"}`}>{state.testOrder.status}</span></div>
      <dl className="definition-grid" aria-label="Test-order clinical governance">
        <div><dt>Clinical owner</dt><dd>{state.testOrder.clinicalOwner}</dd></div>
        <div><dt>Configured demo rule</dt><dd>{state.testOrder.eligibilityRule}</dd></div>
        <div><dt>Why prepared</dt><dd>{state.testOrder.eligibilityReason}</dd></div>
        {state.testOrder.deliveryAddress && <div><dt>Confirmed shipment</dt><dd>{state.testOrder.deliveryAddress}, {state.testOrder.deliveryPostcode}{deliveryConfirmationLabel ? ` · ${deliveryConfirmationLabel}` : ""}</dd></div>}
      </dl>
      <ol className="care-steps">{TEST_STEPS.map((step, index) => <li key={step.status} className={index < testIndex ? "done" : index === testIndex ? "current" : "future"}><span className="step-marker">{index < testIndex ? <Check /> : index + 1}</span><div><b>{step.label}</b><span>{step.status === "ordered" ? state.testOrder.deliveryAddress ? `Shipment details locked when confirmed by ${state.profile.name.trim() || "the patient"}` : `Delivery address and consent confirmed by ${state.profile.name.trim() || "the patient"}` : step.detail}</span>{step.status === "result" && state.testOrder.result && <p className="result-box"><strong>{state.testOrder.result} µg/g</strong>{state.testOrder.resultNote}{!resultIncludedInEvidence && <small>This workflow record is retained, but its deleted or excluded journal source is not used in trends, lifecycle rules or the clinician summary.</small>}</p>}</div></li>)}</ol>
      {state.testOrder.status === "prepared" ? <>
        {!governedTestOrderReady && <div className="inline-warning"><AlertTriangle /><p>A test can be ordered only from a governed Watchful review whose currently included records still meet the sustained-change rule. A demo phase or generic confirmation is not enough.</p></div>}
        <button className="btn primary" onClick={() => governedTestOrderReady ? setConfirm("test") : notify("Open Trends & evidence and confirm the governed Watchful observations before ordering.")}>{governedTestOrderReady ? "Review test order" : "Confirm governed Watchful evidence"}</button>
      </> : state.testOrder.status === "result" ? <button className="btn primary" onClick={() => setConfirm("share")}>Review result sharing</button> : state.testOrder.status !== "shared" ? <button className="btn" onClick={advanceTest}>{({ ordered: "Simulate kit shipped", shipped: "Simulate kit delivered", delivered: "I collected the sample", sampled: "I posted the sample", posted: "Simulate lab receipt", lab: "Simulate result available" } as Partial<Record<TestStatus, string>>)[state.testOrder.status] ?? "Advance demo fulfilment"}</button> : <span className="status ok"><Check /> Loop complete</span>}
      {(state.testOrder.status === "delivered" || state.testOrder.status === "sampled") && <details className="guidance"><summary>Sample collection guide</summary><ol><li>Write the collection date on the tube.</li><li>Use the collection sheet; keep the sample away from toilet water.</li><li>Place the closed tube in the biohazard bag and prepaid box.</li><li>Post the same day if possible. Follow the kit leaflet if anything differs.</li></ol></details>}
    </section>

    <section className={`feature-card ${focus === "team" ? "focus-ring" : ""}`} id="team-flow">
      <div className="section-heading"><div><p className="eyebrow">Contact-first pathway</p><h3>Editable update to {teamName}</h3></div><span className={`status ${state.teamMessage.status === "replied" || state.teamMessage.status === "read" ? "ok" : "watch"}`}>{state.teamMessage.status}</span></div>
      <dl className="definition-grid" aria-label="Clinician-notification governance">
        <div><dt>Clinical owner</dt><dd>{state.teamMessage.clinicalOwner}</dd></div>
        <div><dt>Configured demo rule</dt><dd>{state.teamMessage.notificationRule}</dd></div>
        <div><dt>Why prepared</dt><dd>{state.teamMessage.notificationReason}</dd></div>
      </dl>
      {!teamGovernanceReady && <div className="inline-warning"><AlertTriangle /><div><b>Messaging is not configured</b><p>A named clinical owner, governed notification rule and response expectation must be imported before this draft can be sent.</p></div></div>}
      {state.teamMessageHistory.length > 0 && <div className="care-message-history" aria-label="Earlier clinician-message thread">
        {[...state.teamMessageHistory].reverse().map((message) => <article key={message.id}>
          <div><b>{message.subject}</b><span className="status ok">{message.status}</span></div>
          <p><strong>You sent</strong>{message.body}</p>
          {message.reply && <p className="thread-reply"><strong>{ibdContact ? `${ibdContact.name}, ${ibdContact.role}` : "Your IBD team"}</strong>{message.reply}</p>}
        </article>)}
      </div>}
      {state.teamMessageStale && <div className="inline-warning" role="alert"><AlertTriangle /><div><b>Included records changed; this draft is preserved</b><p>Nothing was overwritten or sent. Refresh it from the currently included records, then review every word before sending.</p></div></div>}
      <label htmlFor="team-draft">Patient-approved message</label><textarea id="team-draft" value={messageBody} onChange={(event) => setMessageBody(event.target.value)} disabled={state.teamMessage.status !== "draft"} />
      <div className="response-time"><Clock3 /><span><b>Expected response</b>{state.teamMessage.expectedResponse}. Use urgent care if you cannot safely wait.</span></div>
      {state.teamMessage.status === "draft" && <div className="button-row"><button className="btn primary" disabled={state.teamMessageStale || !teamGovernanceReady} onClick={() => { setTeamReviewed(false); setConfirm("team"); }}>Review team message</button><button className="btn" onClick={() => { const regenerated = buildClinicianSummary(state); refreshTeamMessage(); setMessageBody(regenerated); notify("Draft refreshed from currently included records. Review every word before sending."); }}>Refresh from included records</button></div>}
      {state.teamMessage.status === "sent" && <button className="btn" onClick={() => { updateTeamMessage({ status: "read" }); notify(`Simulated: ${ibdContact?.name || "the IBD team"} read the message.`); }}>Simulate team read</button>}
      {state.teamMessage.status === "read" && <button className="btn" onClick={() => {
        const reviewsCurrentExperiment = state.experiment.reviewRequestMessageId === state.teamMessage.id;
        updateTeamMessage({
          status: "replied",
          reply: reviewsCurrentExperiment
            ? `Reviewed with the dietitian: this unchanged one-variable candidate is appropriate and approved to proceed while symptoms remain stable.`
            : `Thanks ${state.profile.name.split(" ")[0] || "—"} — please complete the calprotectin test and call us today if bleeding increases.`,
        });
        notify(reviewsCurrentExperiment ? "A simulated clinical-review reply arrived. Return to Experiments to explicitly record its approval." : "A simulated nurse reply arrived.");
      }}>{state.experiment.reviewRequestMessageId === state.teamMessage.id ? "Simulate reviewed team reply" : "Simulate nurse reply"}</button>}
      {state.teamMessage.reply && <blockquote className="team-reply"><MessageSquare /><div><b>{ibdContact ? `${ibdContact.name}, ${ibdContact.role}` : "Your IBD team"}</b><p>{state.teamMessage.reply}</p></div></blockquote>}
      {canPrepareFollowUp && <button className="btn" onClick={() => { const id = `MSG-${Date.now()}`; const subject = `Follow-up from ${state.profile.name || "Gutsy patient"}`; updateTeamMessage({ id, subject, body: state.clinicianSummary, status: "draft", reply: undefined }); setMessageBody(state.clinicianSummary); notify("The prior sent message state was preserved and a new editable follow-up draft was prepared. Nothing was sent."); }}>Prepare next follow-up draft</button>}
      {unresolvedExperimentReview && <p className="note">This consequential diet-review thread stays current until its simulated team reply is available; the evening agent will not archive it.</p>}
    </section>

    <section className={`feature-card ${focus === "prescription" ? "focus-ring" : ""}`} id="prescription-flow">
      <div className="section-heading"><div><p className="eyebrow">Clinician-owned prescription</p><h3>{state.prescription.medicine}</h3></div><span className="status watch">{state.prescription.status.replace("-", " ")}</span></div>
      <div className="guardrail"><Stethoscope /><p><b>Penny is not the prescriber.</b> {state.prescription.prescriber} owns the decision. {state.prescription.pharmacy} only receives an authorised prescription.</p></div>
      <dl className="definition-grid"><div><dt>Clinical owner</dt><dd>{state.prescription.clinicalOwner}</dd></div><div><dt>Configured demo rule</dt><dd>{state.prescription.eligibilityRule}</dd></div><div><dt>Why eligible</dt><dd>{state.prescription.eligibilityReason}</dd></div><div><dt>Rescue pathway</dt><dd>{state.prescription.rescuePlanEligible ? "Documented as eligible for review" : "Not eligible"}</dd></div><div><dt>Prescriber</dt><dd>{state.prescription.prescriber}</dd></div><div><dt>Pharmacy</dt><dd>{state.prescription.pharmacy}</dd></div><div><dt>Current state</dt><dd>{state.prescription.status}</dd></div><div><dt>Response review</dt><dd>Not before {state.prescription.reviewAfterHours} hours, then repeated records on separate days</dd></div></dl>
      {state.prescription.status === "not-started" && <div className="inline-warning"><Stethoscope /><div><b>No clinician-owned rescue pathway is recorded</b><p>A clean profile does not inherit Matthew’s plan. This explicit demo import simulates a named clinician providing eligibility, review timing and an immutable schedule; Penny does not create it.</p><button className="btn" onClick={async () => notify(await importClinicalPlan() ? "Simulated clinician plan imported. Review and verify its exact schedule before use." : "The clinician-plan simulation could not be imported. Check the sync error and retry.")}>Simulate secure clinician-plan import</button></div></div>}
      {state.prescription.status === "prepared" && (prescriptionRequestAllowed ? <button className="btn primary" onClick={() => setConfirm("prescription")}>Prepare prescriber request</button> : <div className="inline-warning"><AlertTriangle /><p>This request is available only in Flare support under the documented rescue pathway. Contact the IBD team first.</p></div>)}
      {state.prescription.status === "requested" && <button className="btn" onClick={() => { updatePrescription({ status: "approved", medicine: "Prednisolone · clinician-prescribed course" }); notify(`Simulated: ${prescriberContact?.name || state.prescription.prescriber || "the prescriber"} approved and authored the prescription.`); }}>Simulate clinician approval</button>}
      {state.prescription.status === "approved" && <button className="btn" onClick={() => { updatePrescription({ status: "ready" }); notify(`Prescription is ready at ${pharmacyContact?.name || state.prescription.pharmacy || "the named pharmacy"}.`); }}>Mark ready at named pharmacy</button>}
      {state.prescription.status === "ready" && <div className="ready-banner"><PackageCheck /><div><b>Your clinician-approved prescription is ready</b><span>Collect from {pharmacyContact?.name || state.prescription.pharmacy || "your named pharmacy"}{pharmacyContact?.organisation && pharmacyContact.organisation !== pharmacyContact.name ? ` · ${pharmacyContact.organisation}` : ""}</span></div><button className="btn" onClick={() => updatePrescription({ status: "collected" })}>I collected it</button></div>}
    </section>

    <section className={`feature-card taper-card ${focus === "taper" ? "focus-ring" : ""}`} id="taper-flow">
      <div className="section-heading"><div><p className="eyebrow">Clinician-authored taper · {state.taper.days.length || "no"} scheduled days</p><h3>{taperActionsAvailable ? currentDose ? `Today: ${currentDose.doseMg} mg ${state.taper.medicine}` : "No prescribed dose is scheduled for today" : "Schedule review only — dose support is not active"}</h3></div><span className={`status ${state.taper.verified ? "ok" : "watch"}`}>{state.taper.verified && <Check />} {state.taper.verified ? `Verified from ${state.taper.prescribedBy}` : "Needs verification"}</span></div>
      {!state.taper.verified && state.taper.days.length > 0 && <div className="inline-warning"><AlertTriangle /><div><b>Patient verification required</b><p>Compare this imported schedule with the clinician’s label. Verification records that you reviewed it; it does not author or change any dose.</p><button className="btn" onClick={() => { updateTaper({ verified: true }); notify("Clinician-authored schedule verified without changing any dose."); }}>I verified this schedule against the label</button></div></div>}
      {state.taper.days.length > 0 && <details className="guidance"><summary>Review the exact imported schedule</summary><ol>{taperSteps.map((step, index) => { const nextStep = taperSteps[index + 1]; const endDay = (nextStep?.day ?? state.taper.days.length + 1) - 1; const end = state.taper.days.find((day) => day.day === endDay); return <li key={step.day}><b>{step.doseMg} mg</b> · days {step.day}–{endDay} · {step.date}{end && end.date !== step.date ? ` to ${end.date}` : ""}</li>; })}</ol><p>This is displayed exactly as imported from {state.taper.prescribedBy || "the recorded prescriber"}. Gutsy cannot calculate, edit or accelerate it.</p></details>}
      {!taperActionsAvailable && <div className="inline-warning"><AlertTriangle /><div><b>Dose actions are locked</b><p>The schedule can be reviewed and verified now. Today’s dose, reminders, missed-dose reconciliation and steroid check-ins become available only after clinician-issued treatment is collected or an evidence-backed Recovery phase is confirmed.</p></div></div>}
      {taperActionsAvailable && <>
        <div className="dose-focus"><Pill /><div><strong>{currentDose ? `${currentDose.doseMg} mg` : "No scheduled dose"}</strong><span>{currentDose ? "Take exactly as prescribed. Gutsy cannot alter the schedule." : "A clinician-authored schedule must be added and verified before dose support starts."}</span></div>{currentDose?.taken ? <span className="status ok"><Check /> Taken</span> : currentDose && state.taper.verified ? <button className="btn primary" onClick={() => setConfirm("dose")}>Mark today’s dose as taken</button> : <span className="status watch">Unavailable</span>}</div>
        {nextDose && <p className="next-dose">Next prescribed change: <b>{nextDose.doseMg} mg on taper day {nextDose.day}</b>. You do not need to calculate it.</p>}
        {currentDose && !currentDose.taken && <div className="button-row"><button className="btn" onClick={() => { const until = new Date(Date.now() + 30 * 60 * 1000).toISOString(); updateTaper({ snoozedUntil: until }); notify("Discreet reminder snoozed for 30 minutes."); }}>Snooze 30 minutes</button><details className="guidance inline"><summary>I may have missed a dose</summary><p>Gutsy does not calculate a replacement dose or change this taper. Follow the dispensing label and prescriber’s plan, and contact {pharmacyContact?.phone ? <a href={`tel:${pharmacyContact.phone.replace(/[^+\d]/g, "")}`}>{pharmacyContact.name}</a> : pharmacyContact?.name || state.prescription.pharmacy || "your pharmacist"} or your IBD team for medicine-specific advice.</p><a href="https://www.nhs.uk/medicines/prednisolone/how-and-when-to-take-prednisolone-tablets-and-liquid/" target="_blank" rel="noopener noreferrer">Read NHS prednisolone missed-dose guidance</a></details></div>}
        {state.taper.snoozedUntil && <p className="note">Reminder snoozed until {snoozeLabel}. It will reappear automatically; no streak was reset.</p>}
        {unresolvedPastDoses.length > 0 && <details className="guidance"><summary>{unresolvedPastDoses.length} earlier dose {unresolvedPastDoses.length === 1 ? "record needs" : "records need"} reconciliation</summary><p>Record only what happened. Marking a past dose as not taken never changes today’s or any future dose. Do not double a dose; use the label and contact your pharmacist or IBD team if unsure.</p><div className="button-row">{unresolvedPastDoses.slice(-4).map((day) => <button className="btn" key={day.day} onClick={() => setMissedDayToConfirm(day.day)}>Day {day.day} · {day.date}: record not taken</button>)}</div></details>}
        {state.taper.missedDays.length > 0 && <p className="note">Reconciled as not taken: taper {state.taper.missedDays.map((day) => `day ${day}`).join(", ")}. These remain visible in the recovery summary.</p>}
        {(takenDoseRecords.length > 0 || missedDoseRecords.length > 0) && <details className="guidance"><summary>Correct an adherence record</summary><p>Use this only if you marked a dose by mistake. The original entry remains in the audit trail as excluded, a dated correction is added to the timeline, and the clinician-authored schedule never changes.</p><div className="button-row">{takenDoseRecords.slice(-4).map((day) => <button className="btn" key={`taken-${day.day}`} onClick={() => setDoseCorrection({ day: day.day, fact: "taken" })}>Day {day.day} marked taken — I marked this by mistake</button>)}{missedDoseRecords.slice(-4).map((day) => <button className="btn" key={`missed-${day.day}`} onClick={() => setDoseCorrection({ day: day.day, fact: "missed" })}>Day {day.day} marked not taken — I marked this by mistake</button>)}</div></details>}
        <fieldset className="checkin"><legend>Low-burden steroid check-in</legend>{["Poor sleep", "Mood change", "Possible infection", "New swelling", "Symptoms worsening again"].map((item) => <label key={item}><input type="checkbox" checked={sideEffects.includes(item)} onChange={(event) => setSideEffects((current) => event.target.checked ? [...current, item] : current.filter((value) => value !== item))}/>{item}</label>)}<button className="btn" onClick={() => { const contactConcern = sideEffects.some((item) => ["Mood change", "Possible infection", "New swelling", "Symptoms worsening again"].includes(item)); updateTaper({ sideEffects, checkInComplete: true }); notify(contactConcern ? "Check-in saved. Same-day contact guidance has been surfaced." : "Check-in saved for the recovery summary."); }}>Save side-effect check-in</button></fieldset>
        {sideEffects.some((item) => ["Mood change", "Possible infection", "New swelling", "Symptoms worsening again"].includes(item)) && <div className="inline-warning"><AlertTriangle /><p>Contact your pharmacist or IBD team today for clinically approved advice. If severe symptoms or red flags are present, use urgent care.</p></div>}
      </>}
    </section>

    <section className={`feature-card ${focus === "urgent" ? "focus-ring" : ""}`} id="safety-screen">
      <div className="section-heading"><div><p className="eyebrow">Deterministic safety check</p><h3>Can you safely wait for routine care?</h3></div><ShieldAlert /></div>
      <p>This checklist runs separately from Penny and any AI model.</p>
      <div className="safety-grid">{["Heavy or continuous bleeding", "Severe abdominal pain", "Fever", "Faint or collapsed", "Cannot keep fluids down", HIGH_OUTPUT_SAFETY_OPTION, "Repeated vomiting or no wind", "None of these"].map((item) => <label key={item}><input type="checkbox" checked={safety.includes(item)} onChange={(event) => setSafety((current) => event.target.checked ? [...current.filter((value) => item === "None of these" ? false : value !== "None of these"), item] : current.filter((value) => value !== item))}/>{item}</label>)}</div>
      <button className="btn" disabled={safety.length === 0} onClick={() => { const selected = safety.filter((item) => item !== "None of these"); store.addEntry({ kind: "WELLBEING", body: `Deterministic safety check: ${selected.length ? selected.join(", ") : "none of the listed red flags selected"}`, source: "manual", flagged: selected.length > 0, structured: { safetyCheck: true, blood: selected.includes("Heavy or continuous bleeding") ? "heavy" : "none", pain: selected.includes("Severe abdominal pain") ? 8 : 0, ...(selected.includes("Fever") ? { feverC: 38 } : {}), ...(selected.includes(HIGH_OUTPUT_SAFETY_OPTION) ? { bowelMovements24h: 10 } : {}), faint: selected.includes("Faint or collapsed"), dehydration: selected.includes("Cannot keep fluids down"), vomiting: selected.includes("Repeated vomiting or no wind"), cannotPassStoolOrGas: selected.includes("Repeated vomiting or no wind") } }); notify(selected.length ? "Safety check saved. Deterministic routing is visible now and remains in your timeline." : "Safety check saved with no listed red flag selected."); if (selected.length) openUrgent(); }}>Save safety check</button>
      {safetyEmergency && <div className="urgent-result" role="alert"><Phone /><div><b>Use urgent care now</b><p>Call 111, or 999 / go to A&amp;E if symptoms are severe or you may be in immediate danger. Do not wait for an app or team message.</p></div></div>}
      {!safetyEmergency && safetySameDay && <div className="inline-warning" role="alert"><Phone /><div><b>Contact your IBD team or GP today</b><p>Use the personal care plan for same-day advice. If symptoms become severe or you feel unsafe, use urgent care.</p></div></div>}
    </section>
    </fieldset>

    <section className={`feature-card ${focus === "summary" ? "focus-ring" : ""}`}>
      <div className="section-heading"><div><p className="eyebrow">Recovery / appointment summary</p><h3>Editable before export or sharing</h3></div></div>
      {state.clinicianSummaryStale && <div className="inline-warning"><AlertTriangle /><div><b>Your saved wording is preserved</b><p>Included records changed after this patient-edited draft was saved. Review it or explicitly regenerate from the latest records.</p></div></div>}
      <textarea value={summary} onChange={(event) => setSummary(event.target.value)} aria-label="Edit recovery summary" />
      <div className="button-row"><button className="btn primary" onClick={() => { updateSummary(summary); notify("Summary saved locally; it has not been shared."); }}>Save summary draft</button><button className="btn" onClick={() => { regenerateSummary(); notify("Summary explicitly regenerated from currently included records. Review it before sharing."); }}>Regenerate from records</button><button className="btn" onClick={() => { downloadSummary(summary, todayValue); notify("A text copy of the current reviewed draft was created on this device; nothing was shared."); }}><Download aria-hidden="true" /> Download draft</button></div>
    </section>

    <section className="feature-card"><div className="section-heading"><div><p className="eyebrow">Your care team</p><h3>Named people and direct routes</h3></div></div><div className="contact-list">{state.contacts.map((contact) => <article key={contact.id}><span className="contact-avatar">{contact.initials}</span><div><b>{contact.name}</b><span>{contact.role} · {contact.organisation}</span></div><a className="btn" href={`tel:${contact.phone.replaceAll(" ", "")}`}><Phone /> Call</a></article>)}</div></section>

    {confirmContent && <ConfirmDialog open title={confirmContent.title} description={confirmContent.description} confirmLabel={confirmContent.label} onConfirm={confirmContent.action} onCancel={() => setConfirm(null)}>
      {confirm === "test" && <div className="confirm-fields"><p><b>Deliver to:</b> {state.profile.address}, {state.profile.postcode}</p><label><input type="checkbox" checked={addressConfirmed} onChange={(event) => setAddressConfirmed(event.target.checked)} /> I confirm this delivery address</label><label><input type="checkbox" checked={testConsent} onChange={(event) => setTestConsent(event.target.checked)} /> I consent to this order and understand the result is shared only after confirmation</label></div>}
      {confirm === "team" && <div className="confirm-fields"><p className="draft-preview">{messageBody || "The message is empty."}</p><label><input type="checkbox" checked={teamReviewed} onChange={(event) => setTeamReviewed(event.target.checked)} /> I reviewed the message and want it sent</label></div>}
    </ConfirmDialog>}
    <ConfirmDialog open={missedDayToConfirm !== undefined} title={`Record taper day ${missedDose?.day ?? "—"} as not taken?`} description={`This reconciles the past ${missedDose?.date ?? "scheduled date"} record only. It does not advise taking a dose now, change the prescribed schedule or remove the missed record.`} confirmLabel="Record as not taken" onCancel={() => setMissedDayToConfirm(undefined)} onConfirm={() => { if (missedDayToConfirm !== undefined) markDoseMissed(missedDayToConfirm); setMissedDayToConfirm(undefined); notify("Past dose reconciled as not taken. No prescribed dose changed."); }} />
    <ConfirmDialog open={doseCorrection !== undefined} title={`Mark taper day ${doseCorrection?.day ?? "—"} ${doseCorrection?.fact === "taken" ? "taken" : "not-taken"} record as a mistake?`} description="This retracts only your adherence fact. The original timeline source is retained as excluded, an audited correction is added, and no prescribed day, dose or date changes." confirmLabel="Yes, record the correction" onCancel={() => setDoseCorrection(undefined)} onConfirm={() => { if (doseCorrection) correctDoseRecord(doseCorrection.day, doseCorrection.fact); setDoseCorrection(undefined); notify("Adherence correction saved. The clinician-authored schedule was unchanged and the summary was refreshed."); }} />
  </div>;
}
