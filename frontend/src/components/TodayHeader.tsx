import type { PhaseContent } from "../types";

export function TodayHeader({ content }: { content: PhaseContent }) {
  return (
    <div className="today-head">
      <div className="pagehead">
        <span className={content.pill.className}>{content.pill.label}</span>
        <h1>Good morning, Amara</h1>
        <p className="sub">{content.sub}</p>
      </div>

      <div className="gauge" role="img" aria-label={`Flare gauge: currently ${content.gauge.label}`}>
        <div className="track">
          <div className="dot" style={{ left: `${content.gauge.percent}%` }} />
        </div>
        <div className="labels">
          <span>Remission</span>
          <span className="now">{content.gauge.label}</span>
          <span>Flare</span>
        </div>
      </div>

      <div className="grid metrics">
        {content.metrics.map((metric) => (
          <div key={metric.k} className="card metric">
            <div className="k">{metric.k}</div>
            <div className="v">
              {metric.v}
              {metric.unit && <span className="unit">{metric.unit}</span>}
            </div>
            <div className={`d ${metric.dClass}`}>{metric.d}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
