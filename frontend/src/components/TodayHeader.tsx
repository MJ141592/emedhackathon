import { Pill } from "lucide-react";
import type { PhaseContent, PhaseId } from "../types";

type Props = {
  content: PhaseContent;
  phase: PhaseId;
  pendingPhase?: PhaseId;
  phaseConfirmed: boolean;
  firstName: string;
  onReviewEvidence: () => void;
  treatmentFocus?: {
    eyebrow: string;
    title: string;
    detail: string;
    status: string;
  };
  onOpenTreatment?: () => void;
};

export function TodayHeader({ content, firstName, treatmentFocus, onOpenTreatment }: Props) {
  return (
    <section className="today-head" aria-labelledby="today-heading">
      <div className="pagehead-row">
        <div className="pagehead">
          <span className={content.pill.className}>{content.pill.label}</span>
          <h1 id="today-heading">Good morning, {firstName}</h1>
          <p className="sub">{content.sub}</p>
        </div>
      </div>

      {treatmentFocus && (
        <section className="treatment-home-focus" aria-labelledby="today-treatment-heading">
          <Pill aria-hidden="true" />
          <div>
            <span>{treatmentFocus.eyebrow}</span>
            <h2 id="today-treatment-heading">{treatmentFocus.title}</h2>
            <p>{treatmentFocus.detail}</p>
          </div>
          <div className="treatment-home-action">
            <b>{treatmentFocus.status}</b>
            {onOpenTreatment && <button className="btn" onClick={onOpenTreatment}>Open treatment record</button>}
          </div>
        </section>
      )}

      <div className="gauge" role="img" aria-label={`Flare gauge: currently ${content.gauge.label}; this is a supported demo state, not a diagnosis`}>
        <div className="track"><div className="dot" style={{ left: `${content.gauge.percent}%` }} /></div>
        <div className="labels"><span>Remission</span><span className="now">{content.gauge.label}</span><span>Flare</span></div>
      </div>

      <div className="grid metrics">
        {content.metrics.map((metric) => (
          <div key={metric.k} className="card metric">
            <div className="k">{metric.k}</div>
            <div className="v">{metric.v}{metric.unit && <span className="unit">{metric.unit}</span>}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
