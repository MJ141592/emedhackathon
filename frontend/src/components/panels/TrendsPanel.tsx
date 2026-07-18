import { useEffect, useMemo, useState } from "react";
import { Check, Download, EyeOff, Link2, Pencil, ShieldCheck } from "lucide-react";
import { useDemoStore } from "../../store/DemoStore";
import { canConfirmStableBaseline, deriveDashboard } from "../../store/dashboardDerivations";
import { deriveRecoveredBaselineProposal } from "../../store/baselineService";
import { taperCourseComplete } from "../../store/recoveryGovernance";
import type { JournalEntry, PhaseId } from "../../types";
import { TrendChart } from "../TrendChart";
import { ConfirmDialog } from "../ui/ConfirmDialog";

const PHASE_NAMES: Record<PhaseId, string> = { stable: "Steady", watch: "Watchful", flare: "Flare", recovery: "Recovery" };

function download(name: string, text: string, type = "application/json") {
  const href = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  link.click();
  URL.revokeObjectURL(href);
}

function EvidenceEntry({ entry, anchor = true }: { entry: JournalEntry; anchor?: boolean }) {
  const { updateEntry } = useDemoStore();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(entry.body);
  const objectiveCareResult = entry.kind === "TEST RESULT" && entry.source === "care";
  useEffect(() => setBody(entry.body), [entry.body]);
  return <article className={`evidence-row ${entry.excluded ? "excluded" : ""}`} id={anchor ? `evidence-${entry.id}` : undefined}>
    <div className="evidence-icon"><Link2 aria-hidden="true" /></div>
    <div className="evidence-copy">
      <div><span className="answer-kind recorded-fact">recorded fact · source #{entry.id}</span><time>{entry.date} · {entry.time}</time></div>
      <b>{entry.kind}</b>
      {editing ? <><textarea value={body} onChange={(event) => setBody(event.target.value)} aria-label={`Correct ${entry.kind} source`} /><div className="button-row"><button className="btn primary" onClick={() => { updateEntry(entry.id, { body: body.trim() }); setEditing(false); }}>Save correction</button><button className="btn" onClick={() => { setBody(entry.body); setEditing(false); }}>Cancel</button></div></> : <p>{entry.body}</p>}
    </div>
    {!editing && <div className="evidence-actions">{!objectiveCareResult && <button className="icon-btn small" onClick={() => setEditing(true)} aria-label={`Correct ${entry.kind} evidence`}><Pencil /></button>}{objectiveCareResult && <span className="source-lock" title="Lab-authored result; exclude it if it should not inform Gutsy">Lab-authored</span>}<button className="icon-btn small" onClick={() => updateEntry(entry.id, { excluded: !entry.excluded })} aria-label={`${entry.excluded ? "Include" : "Exclude"} ${entry.kind} evidence`}><EyeOff /></button></div>}
  </article>;
}

export function TrendsPanel({ notify }: { notify: (message: string) => void }) {
  const { state, confirmCurrentPhase, confirmPhase, updateProfile, updateSummary, regenerateSummary, exportData } = useDemoStore();
  const [summary, setSummary] = useState(state.clinicianSummary);
  const [confirmBaseline, setConfirmBaseline] = useState(false);
  const [trendMode, setTrendMode] = useState<"daily" | "weekly">("daily");
  const dashboard = useMemo(() => deriveDashboard(state), [state]);
  const { content, evidence, lifecycle } = dashboard;
  const firstName = state.profile.name.trim().split(" ")[0] || "you";
  const recoveredBaseline = useMemo(() => deriveRecoveredBaselineProposal(state), [state]);
  const confirmationTarget = state.pendingPhase && state.pendingPhase === lifecycle.proposedPhase
    ? state.pendingPhase
    : lifecycle.proposedPhase;
  const stableBaselineReview = canConfirmStableBaseline(state);
  const canConfirm = Boolean(confirmationTarget) || stableBaselineReview;

  useEffect(() => setSummary(state.clinicianSummary), [state.clinicianSummary]);

  const confirmReview = () => {
    if (stableBaselineReview) {
      confirmCurrentPhase();
      notify("Stable baseline confirmed from your complete maintained profile. Diet experiments remain optional and patient-controlled.");
      return;
    }
    if (confirmationTarget && (state.pendingPhase === confirmationTarget || confirmationTarget !== state.phase)) confirmPhase();
    else confirmCurrentPhase();
    if (confirmationTarget) notify(`${PHASE_NAMES[confirmationTarget]} support mode confirmed from the governed source review. You still choose every next action.`);
  };

  return <div className="panel-stack">
    <section className="panel-intro"><span className={content.pill.className}>{content.pill.label}</span>{confirmationTarget && <span className="status watch">Proposed: {PHASE_NAMES[confirmationTarget]} · confirmation required</span>}<h3>Change is measured against {firstName === "you" ? "your" : `${firstName}’s`} baseline</h3><p>No generic “healthy” target and no diagnosis. The chart and observations below are rebuilt from currently included records.</p></section>

    <section className="trend-view" aria-labelledby="trend-view-heading">
      <div className="trend-view-heading">
        <div><p className="eyebrow" id="trend-view-heading">Trend timescale</p><p>Daily detail or weekly averages from included records only.</p></div>
        <div className="trend-mode-control" role="group" aria-label="Trend timescale">
          <button type="button" aria-pressed={trendMode === "daily"} className={trendMode === "daily" ? "selected" : ""} onClick={() => setTrendMode("daily")}>Daily · 14 days</button>
          <button type="button" aria-pressed={trendMode === "weekly"} className={trendMode === "weekly" ? "selected" : ""} onClick={() => setTrendMode("weekly")}>Weekly · 8 weeks</button>
        </div>
      </div>
      <TrendChart
        points={trendMode === "daily" ? content.trend : dashboard.weeklyTrend}
        title={trendMode === "daily" ? dashboard.trendTitle : dashboard.weeklyTrendTitle}
        bowelLabel={trendMode === "daily" ? "Bowel logs" : "Avg bowel / recorded day"}
        note={trendMode === "daily"
          ? dashboard.lifeEventNote
          : "Weekly points average only days with an included value. Blank weeks stay blank; they are not treated as symptom-free."}
      />
    </section>

    <section className="feature-card change-card">
      <div className="section-heading"><div><p className="eyebrow">Explainable change</p><h3>{dashboard.patternHeadline}</h3></div>{state.phaseConfirmed && !confirmationTarget ? <span className="status ok"><Check /> Confirmed by {firstName}</span> : <span className="status watch">Waiting for governed review</span>}</div>
      <p>{dashboard.patternExplanation}</p>
      {evidence.length ? <div className="evidence-list">{evidence.map((entry) => <EvidenceEntry key={entry.id} entry={entry} />)}</div> : <p className="soft-signal">There are no included source entries behind a change proposal. Corrected and excluded records are not silently counted.</p>}
      {lifecycle.signals.map((candidate) => <div className="pattern-row" key={candidate.key}><span className={`answer-kind ${candidate.clinical ? "possible-pattern" : "recorded-fact"}`}>{candidate.clinical ? "possible pattern" : "supporting signal"}</span><p><b>{candidate.label}.</b> {candidate.detail}</p></div>)}
      <div className="pattern-row"><span className="answer-kind general-information">general information</span><p>Faecal calprotectin can provide objective evidence when used inside a clinically governed pathway.</p></div>
      {(!state.phaseConfirmed || confirmationTarget) && <div className="button-row">{canConfirm && <button className="btn primary" onClick={confirmReview}>{stableBaselineReview ? "Confirm Stable baseline" : `Confirm ${PHASE_NAMES[confirmationTarget!]} support mode`}</button>}<button className="btn" onClick={() => notify("Use Correct or Exclude beside any source that is wrong.")}>Something is wrong</button></div>}
    </section>

    <section className="feature-card">
      <div className="section-heading"><div><p className="eyebrow">Personal food timeline</p><h3>Recorded episodes, with every source visible</h3></div><Link2 aria-hidden="true" /></div>
      <p>Gutsy only aligns timestamps in your included diary. It does not label foods as triggers or recommend exclusions from these episodes.</p>
      {dashboard.personalPatterns.length ? dashboard.personalPatterns.map((pattern) => <div className="pattern-row" key={pattern.id}>
        <span className="answer-kind possible-pattern">possible pattern</span>
        <div className="evidence-copy"><p><b>{pattern.title}.</b> {pattern.summary}</p><p className="soft-signal"><b>{pattern.disclaimer}</b></p>
          <div className="evidence-list" aria-label={`Exact source entries for ${pattern.title}`}>{pattern.sources.map((source) => <EvidenceEntry anchor={false} entry={source} key={`${pattern.id}-${source.id}`} />)}</div>
        </div>
      </div>) : <p className="soft-signal">No included meal has a later included symptom record inside the bounded 12-hour episode window. This is missing diary evidence, not proof that food is unrelated.</p>}
    </section>

    <section className="feature-card">
      <div className="section-heading"><div><p className="eyebrow">Baseline</p><h3>Your “usual,” not a population target</h3></div><ShieldCheck aria-hidden="true" /></div>
      <dl className="definition-grid"><div><dt>Bowel movements</dt><dd>{state.profile.usualBowel}</dd></div><div><dt>Pain</dt><dd>{state.profile.usualPain}</dd></div><div><dt>Resting HR</dt><dd>{state.profile.usualHeartRate}</dd></div><div><dt>Sleep</dt><dd>{state.profile.usualSleep}</dd></div></dl>
      {state.wearable.connected && <p className="soft-signal">Resting heart rate, HRV, sleep and activity are noisy supporting context only and never create a lifecycle escalation on their own. Last simulated sync: {state.wearable.lastSync}.</p>}
    </section>

    {state.phase === "stable" && taperCourseComplete(state) && <section className="feature-card"><div className="section-heading"><div><p className="eyebrow">Close the recovery loop</p><h3>Review the recovered baseline</h3></div><ShieldCheck /></div>{recoveredBaseline ? <><p>Gutsy prepared these record-based values from {recoveredBaseline.evidenceIds.length} included records after the latest settling marker. They are not applied automatically.</p><dl className="definition-grid">{Object.entries(recoveredBaseline.values).map(([key, value]) => <div key={key}><dt>{{ usualBowel: "Bowel", usualPain: "Pain", usualHeartRate: "Resting HR", usualSleep: "Sleep" }[key as keyof typeof recoveredBaseline.values]}</dt><dd>{value}</dd></div>)}</dl><button className="btn" onClick={() => setConfirmBaseline(true)}>Review baseline update</button></> : <p className="soft-signal">The course is complete, but more included recovered bowel, pain, sleep or wearable records are needed before Gutsy can prepare a baseline proposal.</p>}</section>}

    <section className="feature-card">
      <div className="section-heading"><div><p className="eyebrow">Clinician-ready summary</p><h3>Preview, edit and export</h3></div></div>
      {state.clinicianSummaryStale && <div className="inline-warning"><div><b>Your saved wording is preserved</b><p>Included records changed after this patient-edited draft was saved. Review it or explicitly regenerate from the latest records.</p></div></div>}
      <label htmlFor="clinician-summary">Only your approved words leave Gutsy</label>
      <textarea id="clinician-summary" className="summary-editor" value={summary} onChange={(event) => setSummary(event.target.value)} />
      <div className="button-row"><button className="btn primary" onClick={() => { updateSummary(summary); notify("Summary draft saved locally. It has not been sent."); }}>Save draft</button><button className="btn" onClick={() => { regenerateSummary(); notify("Summary explicitly regenerated from currently included records. Review it before sharing."); }}>Regenerate from records</button><button className="btn" onClick={() => { updateSummary(summary); download("gutsy-clinician-summary.txt", summary, "text/plain"); notify("Summary exported to this device. Nothing was sent to a clinician."); }}><Download /> Export summary</button><button className="btn" onClick={() => download("gutsy-data-export.json", exportData())}><Download /> Export all evidence</button></div>
    </section>
    {recoveredBaseline && <ConfirmDialog open={confirmBaseline} title="Use these recovered records as the new baseline?" description="This updates only your editable baseline fields after your review. It does not diagnose remission or change care. You can correct the values later in Profile." confirmLabel="Update my baseline" onCancel={() => setConfirmBaseline(false)} onConfirm={() => { updateProfile(recoveredBaseline.values); setConfirmBaseline(false); notify("Recovered baseline updated from the reviewed included records."); }} />}
  </div>;
}
