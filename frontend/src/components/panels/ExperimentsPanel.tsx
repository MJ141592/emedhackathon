import { useState } from "react";
import { AlertCircle, Beaker, Check, Pause, Pencil, Play, Plus, Scale, Sprout, Trash2 } from "lucide-react";
import { useDemoStore } from "../../store/DemoStore";
import {
  experimentCheckInDates,
  experimentRequiresReview,
  experimentReviewDefinition,
  experimentReviewRequestMessage,
  experimentReviewThread,
  experimentScores,
  experimentTimelineObservations,
  hasExperimentCheckInOnDate,
  isRecordedExperimentBaseline,
  rankLowBurdenExperiments,
  SIMULATED_EXPERIMENT_REVIEWER,
} from "../../store/experimentSafety";
import type { Experiment } from "../../types";
import { buildClinicianSummary } from "../../store/stateDerivations";
import { dateInTimeZone } from "../../store/patientTime";
import { ConfirmDialog } from "../ui/ConfirmDialog";

function blankCandidate(): Experiment {
  return {
    id: "",
    title: "",
    variable: "",
    goal: "",
    baseline: "",
    outcome: "",
    startDate: "",
    durationDays: 14,
    day: 0,
    status: "suggested",
    observations: [],
    reviewRequired: false,
  };
}

function completeCandidate(candidate: Experiment): boolean {
  return Boolean(
    candidate.title.trim()
    && candidate.variable.trim()
    && candidate.goal.trim()
    && isRecordedExperimentBaseline(candidate.baseline)
    && candidate.outcome.trim()
    && Number.isInteger(candidate.durationDays)
    && candidate.durationDays >= 1
    && candidate.durationDays <= 60,
  );
}

export function ExperimentsPanel({ notify }: { notify: (message: string) => void }) {
  const { state, updateEntry, deleteEntry, updateExperiment, updateTeamMessage, refreshTeamMessage } = useDemoStore();
  const [confirmStart, setConfirmStart] = useState(false);
  const [confirmComplete, setConfirmComplete] = useState(false);
  const [candidateToReplace, setCandidateToReplace] = useState<Experiment | null>(null);
  const [editingCandidate, setEditingCandidate] = useState(false);
  const [candidate, setCandidate] = useState<Experiment>(() => blankCandidate());
  const [observation, setObservation] = useState("");
  const [outcomeReview, setOutcomeReview] = useState("");
  const [editingObservation, setEditingObservation] = useState<{ entryId: number; note: string }>();
  const experiment = state.experiment;
  const stable = state.phase === "stable" && state.phaseConfirmed && !state.pendingPhase;
  const firstName = state.profile.name.split(" ")[0] || "the patient";
  const governedReview = experiment.reviewRequired || experimentRequiresReview(experiment, state.profile);
  const checkInDates = experimentCheckInDates(state);
  const timelineObservations = experimentTimelineObservations(state);
  const currentDate = dateInTimeZone(new Date(), state.profile.timeZone);
  const checkedInToday = hasExperimentCheckInOnDate(state, currentDate);
  const reviewRequest = experiment.reviewRequestMessageId
    ? experimentReviewRequestMessage(state, experiment.reviewRequestMessageId)
    : undefined;
  const eligibleReviewReply = experimentReviewThread(state);
  const reviewApproved = governedReview && Boolean(experiment.reviewApprovedAt);
  const scores = experimentScores(experiment, state.profile);
  const rankedCandidates = rankLowBurdenExperiments(state, {
    profile: state.privacy.assistantProfileAccess,
    journal: state.privacy.assistantJournalAccess,
  });

  const toggle = () => {
    if (experiment.status === "active") {
      updateExperiment({ status: "paused" });
      notify("Experiment paused. Your progress is kept; there is no penalty.");
    } else if (!stable) {
      notify("Experiments stay paused while symptoms or treatment are changing.");
    } else if (governedReview && !reviewApproved) {
      notify("This experiment needs a recorded dietitian or IBD-team approval before it can start.");
    } else if (!isRecordedExperimentBaseline(experiment.baseline)) {
      notify("Record an actual pre-start observation before starting; a reminder or plan to record one is not a baseline.");
    } else if (!completeCandidate(experiment)) {
      notify("Define one variable, a goal, a pre-start baseline, an outcome and a limited duration before starting.");
    } else {
      setConfirmStart(true);
    }
  };

  const beginCandidate = () => {
    const canEditExisting = experiment.status === "suggested" && experiment.day === 0;
    setCandidate(canEditExisting ? { ...experiment } : blankCandidate());
    setEditingCandidate(true);
  };

  const commitCandidate = (draft: Experiment) => {
    const reviewRequired = draft.reviewRequired || experimentRequiresReview(draft, state.profile);
    updateExperiment({
      ...draft,
      id: draft.id || `EXP-${Date.now()}`,
      title: draft.title.trim(),
      variable: draft.variable.trim(),
      goal: draft.goal.trim(),
      baseline: draft.baseline.trim(),
      outcome: draft.outcome.trim(),
      startDate: "",
      day: 0,
      status: "suggested",
      observations: [],
      reviewRequired,
      reviewRequestMessageId: undefined,
      reviewApprovedAt: undefined,
      reviewApprovedBy: undefined,
    });
    setEditingCandidate(false);
    setCandidateToReplace(null);
    setObservation("");
    setOutcomeReview("");
    notify(reviewRequired ? "Candidate saved. Its wording or duration requires clinical review before it can start." : "One-variable candidate saved for your review. Nothing has started yet.");
  };

  const saveCandidate = () => {
    const durationDays = Math.round(Number(candidate.durationDays));
    const draft = { ...candidate, durationDays };
    if (!isRecordedExperimentBaseline(draft.baseline)) {
      notify("Enter an actual observation recorded before day 1. Penny leaves suggested baselines blank and cannot fill this evidence for you.");
      return;
    }
    if (!completeCandidate(draft)) {
      notify("Complete the candidate name, one variable, goal, pre-start baseline, outcome and a duration from 1 to 60 days.");
      return;
    }
    const replacingProgress = experiment.status !== "suggested" || experiment.day > 0 || experiment.observations.length > 0;
    if (replacingProgress) setCandidateToReplace(draft);
    else commitCandidate(draft);
  };

  const saveCheckIn = () => {
    const note = observation.trim();
    if (experiment.status !== "active") return notify("Start the experiment before recording a daily check-in.");
    if (!note) return notify("Add a neutral observation for today before saving the check-in.");
    if (experiment.day >= experiment.durationDays) return notify("All planned days are recorded. Review the outcome to complete this experiment.");
    if (checkedInToday) return notify("Today’s experiment check-in is already recorded. The next check-in opens on the next calendar day.");
    if (experiment.day !== checkInDates.length) return notify("Experiment progress needs to be reconciled with its shared timeline before another check-in.");
    const nextDay = checkInDates.length + 1;
    updateExperiment({ day: nextDay, observations: [...experiment.observations, `Day ${nextDay}: ${note}`] });
    setObservation("");
    notify(`Day ${nextDay} check-in saved and added to the shared journal timeline as a personal observation.`);
  };

  const complete = () => {
    const review = outcomeReview.trim();
    if (!review) return notify("Write a personal outcome review before completing the experiment.");
    if (checkInDates.length < experiment.durationDays || experiment.day < experiment.durationDays) {
      return notify(`Complete all ${experiment.durationDays} distinct daily check-ins before reviewing the outcome.`);
    }
    updateExperiment({
      status: "complete",
      observations: [...experiment.observations, `Outcome review (personal observation, not proof): ${review}`],
    });
    setOutcomeReview("");
    setConfirmComplete(false);
    notify("Experiment completed. The personal outcome review is in the journal and clinician summary; it is not a causal conclusion.");
  };

  const saveObservationCorrection = (entryId: number, event: "check-in" | "complete", day: number) => {
    const note = editingObservation?.note.trim();
    const entry = state.entries.find((item) => item.id === entryId);
    if (!entry || !note) return notify("Enter the corrected personal observation before saving.");
    const body = event === "check-in"
      ? `Diet experiment check-in — day ${day} of ${experiment.durationDays}: ${note}`
      : `Diet experiment completed: ${experiment.title}. Personal outcome review: ${note} This is an observation for this person and period, not proof of cause or treatment.`;
    updateEntry(entryId, {
      body,
      structured: { ...entry.structured, experimentObservation: note },
    });
    setEditingObservation(undefined);
    notify("Experiment observation corrected. Progress and the clinician summary now use the corrected journal source.");
  };

  const removeObservation = (entryId: number) => {
    deleteEntry(entryId);
    setEditingObservation(undefined);
    notify("Experiment observation deleted. Progress and any outcome summary were reconciled to the remaining timeline.");
  };

  return <div className="panel-stack">
    <section className="panel-intro"><span className={`pill ${stable ? "ok" : "watch"}`}>{stable ? "Steady enough to learn" : "Paused while symptoms change"}</span><h3>One gentle question at a time</h3><p>Experiments record personal observations. They cannot prove a food causes or treats symptoms, and restrictive changes need a dietitian or IBD-team review.</p></section>

    {!stable && <section className="care-safety-strip experiment-pause"><Pause /><div><b>Experiments are paused {state.pendingPhase ? "while a support-mode change is under review" : `in ${state.phase === "watch" ? "watchful" : state.phase} mode`}</b><span>Changing symptoms or treatment would confound the result. Nothing has been lost.</span></div></section>}

    <section className="feature-card experiment-card">
      <div className="section-heading"><div><p className="eyebrow">Current experiment · {experiment.day} of {experiment.durationDays} days recorded</p><h3>{experiment.title || "No candidate planned"}</h3></div><span className={`status ${experiment.status === "active" || experiment.status === "complete" ? "ok" : "watch"}`}>{experiment.status}</span></div>
      <div className="experiment-rule"><Beaker /><div><b>Change one main variable</b><span>{experiment.variable || "Define a single change before starting"}</span></div></div>
      <dl className="definition-grid"><div><dt>Your goal</dt><dd>{experiment.goal || "Not defined"}</dd></div><div><dt>Pre-start baseline</dt><dd>{experiment.baseline || "Not recorded"}</dd></div><div><dt>Outcome defined before starting</dt><dd>{experiment.outcome || "Not defined"}</dd></div><div><dt>Duration</dt><dd>{experiment.durationDays} distinct daily check-ins</dd></div><div><dt>Clinical review</dt><dd>{reviewApproved ? `Approved by ${experiment.reviewApprovedBy} for this unchanged candidate` : eligibleReviewReply ? "Eligible team reply received — approval still needs to be recorded" : reviewRequest ? `Requested in team thread (${reviewRequest.status})` : governedReview ? "Required before starting" : "Not required by the recorded candidate and PMH context"}</dd></div></dl>
      <div className="progress-track" role="progressbar" aria-label="Experiment progress" aria-valuemin={0} aria-valuemax={experiment.durationDays} aria-valuenow={experiment.day}><span style={{ width: `${Math.min(100, (experiment.day / experiment.durationDays) * 100)}%` }} /></div>
      <div className="observation-list">{timelineObservations.length ? timelineObservations.map((item) => <article className="observation-item" key={item.entryId}>
        {editingObservation?.entryId === item.entryId ? <>
          <label htmlFor={`experiment-correction-${item.entryId}`}>Correct this personal observation</label>
          <textarea id={`experiment-correction-${item.entryId}`} value={editingObservation.note} onChange={(event) => setEditingObservation({ entryId: item.entryId, note: event.target.value })} />
          <div className="button-row"><button className="btn primary" onClick={() => saveObservationCorrection(item.entryId, item.event, item.day)}>Save correction</button><button className="btn" onClick={() => setEditingObservation(undefined)}>Cancel</button></div>
        </> : <>
          <p><Check />{item.label}</p>
          <small>{item.date} · shared journal source</small>
          <div className="button-row compact"><button className="btn" onClick={() => setEditingObservation({ entryId: item.entryId, note: item.note })}><Pencil /> Correct</button><button className="btn danger" onClick={() => removeObservation(item.entryId)}><Trash2 /> Delete</button></div>
        </>}
      </article>) : <p>No daily observations recorded yet.</p>}</div>

      {experiment.status === "active" && <>
        <label htmlFor="experiment-observation">Today’s neutral observation for {experiment.outcome}</label>
        <textarea id="experiment-observation" value={observation} onChange={(event) => setObservation(event.target.value)} placeholder="For example: morning urgency was unchanged today" disabled={experiment.day >= experiment.durationDays || checkedInToday} />
        <div className="button-row"><button className="btn primary" onClick={saveCheckIn} disabled={experiment.day >= experiment.durationDays || checkedInToday}>Save day {Math.min(experiment.day + 1, experiment.durationDays)} check-in</button></div>
        {checkedInToday && <p className="soft-signal"><Check /> Today’s dated check-in is already in the shared timeline. The next one opens tomorrow.</p>}
        {experiment.day >= experiment.durationDays && <p className="soft-signal"><Check /> All planned daily check-ins are recorded. Review the personal outcome below to finish.</p>}
        <label htmlFor="experiment-outcome-review">Review the outcome before completing</label>
        <textarea id="experiment-outcome-review" value={outcomeReview} onChange={(event) => setOutcomeReview(event.target.value)} placeholder={`What did you personally observe about ${experiment.outcome || "the defined outcome"}?`} />
        <div className="button-row"><button className="btn" disabled={checkInDates.length < experiment.durationDays} onClick={() => outcomeReview.trim() ? setConfirmComplete(true) : notify("Write a personal outcome review before completing the experiment.")}>Review and complete experiment</button></div>
      </>}

      {governedReview && eligibleReviewReply && !reviewApproved && experiment.status !== "active" && experiment.status !== "complete" && <div className="button-row"><button className="btn primary" onClick={() => {
        updateExperiment({ reviewApprovedAt: new Date().toISOString(), reviewApprovedBy: SIMULATED_EXPERIMENT_REVIEWER });
        notify("Simulated clinical-team approval recorded for this exact candidate. Editing its definition will invalidate the approval.");
      }}>Record simulated team approval</button></div>}
      {reviewApproved && <p className="soft-signal"><Check /> This approval applies only to the unchanged candidate definition. Editing it requires a new review.</p>}

      {experiment.status !== "complete" && <button className={experiment.status === "active" ? "btn" : "btn primary"} onClick={toggle}>{experiment.status === "active" ? <><Pause /> Pause experiment</> : <><Play /> {experiment.status === "suggested" ? "Start experiment" : "Resume experiment"}</>}</button>}
      {experiment.status === "complete" && <p className="soft-signal"><Check /> Complete. Review this alongside other records; it remains a personal observation, not proof.</p>}
    </section>

    <section className="feature-card">
      <div className="section-heading"><div><p className="eyebrow">Candidate builder</p><h3>Define the question before changing anything</h3></div><Pencil /></div>
      <p>Only one candidate can be current. Saving a new candidate never starts it, and replacing a paused or completed experiment requires confirmation.</p>
      {!editingCandidate ? <button className="btn" onClick={beginCandidate} disabled={experiment.status === "active"}>{experiment.status === "suggested" && experiment.day === 0 ? <><Pencil /> Edit candidate</> : <><Plus /> Create a new candidate</>}</button> : <>
        <section className="candidate-shortlist" aria-labelledby="ranked-candidates-heading">
          <div className="section-heading"><div><p className="eyebrow">Competing choices · nothing starts automatically</p><h4 id="ranked-candidates-heading">Ranked low-burden candidates</h4></div><Sprout /></div>
          <p>Penny uses only the profile and journal context you permit, then weighs usefulness, safety, effort and measurability. Choosing an option fills the builder but leaves the evidence baseline for you to record.</p>
          <ol className="candidate-ranking" aria-label="Ranked low-burden candidates">
            {rankedCandidates.map((ranked, index) => <li key={ranked.experiment.title}>
              <article>
                <div className="candidate-heading"><span className="rank-badge">#{index + 1}</span><div><h5>{ranked.experiment.title}</h5><p>{ranked.experiment.variable}</p></div><span className={`status ${ranked.risk === "Low" ? "ok" : "watch"}`}>Risk: {ranked.risk}</span></div>
                <dl className="candidate-scores">
                  <div><dt>Useful</dt><dd>{ranked.scores.usefulness}/5</dd></div>
                  <div><dt>Safety</dt><dd>{ranked.scores.safety}/5</dd></div>
                  <div><dt>Ease</dt><dd>{ranked.scores.ease}/5</dd></div>
                  <div><dt>Measurable</dt><dd>{ranked.scores.measurability}/5</dd></div>
                </dl>
                <div className="candidate-rationale">{ranked.rationale.map((reason) => <p key={reason}>{reason}</p>)}</div>
                <button className="btn" aria-label={`Choose ${ranked.experiment.title}`} onClick={() => setCandidate({ ...ranked.experiment })}>Choose this candidate</button>
              </article>
            </li>)}
          </ol>
        </section>
        <div className="field-pair">
          <label>Candidate name<input value={candidate.title} onChange={(event) => setCandidate((current) => ({ ...current, title: event.target.value }))} placeholder="For example: oat milk instead of dairy milk" /></label>
          <label>One main variable<input value={candidate.variable} onChange={(event) => setCandidate((current) => ({ ...current, variable: event.target.value }))} placeholder="Milk choice only" /></label>
          <label>Your goal<input value={candidate.goal} onChange={(event) => setCandidate((current) => ({ ...current, goal: event.target.value }))} placeholder="See whether morning urgency changes" /></label>
          <label>Pre-start baseline<input aria-label="Pre-start baseline" aria-describedby="experiment-baseline-help" value={candidate.baseline} onChange={(event) => setCandidate((current) => ({ ...current, baseline: event.target.value }))} placeholder="For example: morning urgency 3/10 before day 1" /><small id="experiment-baseline-help">Enter what you actually observed before day 1. A plan or reminder to measure it does not count.</small></label>
          <label>Outcome to track<input value={candidate.outcome} onChange={(event) => setCandidate((current) => ({ ...current, outcome: event.target.value }))} placeholder="Morning urgency score" /></label>
          <label>Planned duration (days)<input type="number" min={1} max={60} value={candidate.durationDays} onChange={(event) => setCandidate((current) => ({ ...current, durationDays: Number(event.target.value) }))} /></label>
        </div>
        <label className="toggle-row"><span><b>Clinical review required before starting</b><small>Automatically required for restrictive wording, weight-loss risk, food-group removal, recorded nutritional vulnerability, or plans over 28 days.</small></span><input type="checkbox" checked={candidate.reviewRequired || experimentRequiresReview(candidate, state.profile)} disabled={experimentRequiresReview(candidate, state.profile)} onChange={(event) => setCandidate((current) => ({ ...current, reviewRequired: event.target.checked }))} /></label>
        <div className="button-row"><button className="btn primary" onClick={saveCandidate}>Save candidate</button><button className="btn" onClick={() => setEditingCandidate(false)}>Cancel</button></div>
      </>}
    </section>

    <section className="feature-card"><div className="section-heading"><div><p className="eyebrow">Why Penny suggested this</p><h3>Usefulness, safety and effort</h3></div><Sprout /></div><div className="score-list"><div><b>Useful question</b><span>{experiment.goal || `A goal ${firstName} chooses before starting.`}</span><strong>{scores.usefulness}</strong></div><div><b>Easy to measure</b><span>{experiment.outcome ? `Daily check-in: ${experiment.outcome}.` : "Define the outcome before starting."}</span><strong>{scores.measurable}</strong></div><div><b>Burden</b><span>One variable, a limited duration and no calorie scoring.</span><strong>{scores.burden}</strong></div><div><b>Nutritional risk</b><span>Restrictive wording and prolonged plans are automatically held for clinical review.</span><strong>{scores.risk}</strong></div></div><p className="soft-signal"><Scale /> Correlation is never presented as proof. A result belongs to this person and this period only.</p></section>

    <section className="feature-card warning-card"><AlertCircle /><div><h3>Changes that always need clinical review</h3><p>Restrictive diets, significant weight-loss risk, removing a food group, or experimenting during a suspected flare. Prepare and send a team question, receive a simulated reply that explicitly supports proceeding, then record that approval against the unchanged candidate.</p><button className="btn" onClick={() => {
      if (state.teamMessage.status !== "draft") return notify("Your current team update has already been sent. Use the Care contacts to ask for dietitian review.");
      const definition = experimentReviewDefinition(experiment);
      const question = `Dietitian experiment question: please review this exact unchanged candidate before I start. ${definition}. Could you confirm whether it is appropriate and safe to proceed?`;
      const currentRecords = state.teamMessageStale ? buildClinicianSummary(state) : state.teamMessage.body;
      if (state.teamMessageStale) refreshTeamMessage();
      updateTeamMessage({ body: `${currentRecords.trim()}\n\n${question}`.trim() });
      if (governedReview) updateExperiment({ reviewRequestMessageId: state.teamMessage.id });
      notify(governedReview ? "A dietitian question was linked to this candidate in your editable care-team draft. Nothing was sent." : "A dietitian question was added to your editable care-team draft. Nothing was sent.");
    }}>{reviewRequest ? "Review linked team question" : "Prepare a dietitian question"}</button></div></section>

    <ConfirmDialog open={confirmStart} title="Start this one-variable experiment?" description="Confirm that symptoms are steady, the variable and outcome are correct, and no other planned diet or medication change will overlap. The result will be an observation, not a medical conclusion." confirmLabel="Start experiment" onCancel={() => setConfirmStart(false)} onConfirm={() => {
      updateExperiment({ status: "active", startDate: experiment.startDate || dateInTimeZone(new Date(), state.profile.timeZone) });
      setConfirmStart(false);
      notify("Experiment started. It will pause automatically if the demo leaves Steady, and each check-in will join the journal timeline.");
    }} />

    <ConfirmDialog open={confirmComplete} title="Complete and save this personal review?" description="This ends the current experiment and records your review in the shared journal and clinician summary. It describes what happened for you in this period; it does not prove cause, treatment or safety." confirmLabel="Complete experiment" onCancel={() => setConfirmComplete(false)} onConfirm={complete} />

    <ConfirmDialog open={Boolean(candidateToReplace)} title="Replace the current experiment candidate?" description="The current candidate will stop being current. Its prior journal events and audit history remain, but the experiment card will start again at day zero with the new one-variable plan." confirmLabel="Save new candidate" onCancel={() => setCandidateToReplace(null)} onConfirm={() => candidateToReplace && commitCandidate(candidateToReplace)} />
  </div>;
}
