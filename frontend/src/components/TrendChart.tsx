import type { TrendPoint } from "../types";

type Props = { points: TrendPoint[]; compact?: boolean; title?: string; note?: string; bowelLabel?: string };

function xAt(index: number, count: number): number {
  const width = 680;
  return 28 + (index / Math.max(1, count - 1)) * (width - 52);
}

function segments(points: TrendPoint[], getValue: (point: TrendPoint) => number | undefined, getY: (value: number) => number): string[] {
  const result: string[] = [];
  let current: string[] = [];
  points.forEach((point, index) => {
    const value = getValue(point);
    if (value == null) {
      if (current.length) result.push(current.join(" "));
      current = [];
      return;
    }
    current.push(`${xAt(index, points.length)},${getY(value)}`);
  });
  if (current.length) result.push(current.join(" "));
  return result;
}

function summary(points: TrendPoint[], getValue: (point: TrendPoint) => number | undefined, suffix = ""): string {
  const values = points.map(getValue).filter((value): value is number => value != null);
  if (!values.length) return "none recorded";
  if (values.length === 1) return `${values[0]}${suffix}`;
  return `${values[0]} to ${values.at(-1)}${suffix}`;
}

export function TrendChart({ points, compact, title = "Included pain, bowel and resting heart-rate records", note, bowelLabel = "Bowel logs" }: Props) {
  if (points.length === 0) {
    return <figure className={compact ? "trend-card compact" : "trend-card"}><figcaption><span>{title}</span></figcaption><div className="chart-empty" role="img" aria-label={`${title}. No included records are available yet.`}>No included records yet.</div></figure>;
  }
  const symptomY = (value: number) => 150 - (Math.min(10, Math.max(0, value)) / 10) * 112;
  const heartY = (value: number) => 150 - ((Math.min(75, Math.max(50, value)) - 50) / 25) * 112;
  const symptomLines = segments(points, (point) => point.symptom, symptomY);
  const bowelLines = segments(points, (point) => point.bowel || undefined, symptomY);
  const heartLines = segments(points, (point) => point.heartRate, heartY);
  const labelIndexes = new Set([0, points.length - 1, Math.floor((points.length - 1) / 2)]);
  return (
    <figure className={compact ? "trend-card compact" : "trend-card"}>
      <figcaption>
        <span>{title}</span>
        <span className="chart-legend"><i className="symptom-line" />Pain /10 <i className="bowel-line" />{bowelLabel} <i className="hr-line" />Resting HR</span>
      </figcaption>
      <svg viewBox="0 0 680 176" role="img" aria-label={`${title}. Recorded pain ${summary(points, (point) => point.symptom, "/10")}; ${bowelLabel.toLowerCase()} ${summary(points, (point) => point.bowel || undefined)}; resting heart rate ${summary(points, (point) => point.heartRate, " bpm")}. Missing values are not filled in.`}>
        <g className="chart-grid">
          <line x1="28" y1="38" x2="656" y2="38"/><line x1="28" y1="76" x2="656" y2="76"/><line x1="28" y1="113" x2="656" y2="113"/><line x1="28" y1="150" x2="656" y2="150"/>
        </g>
        {heartLines.map((line, index) => <polyline key={`heart-${index}`} className="hr-polyline" points={line} />)}
        {bowelLines.map((line, index) => <polyline key={`bowel-${index}`} className="bowel-polyline" points={line} />)}
        {symptomLines.map((line, index) => <polyline key={`pain-${index}`} className="symptom-polyline" points={line} />)}
        {points.map((point, index) => <g key={`points-${point.day}-${index}`}>
          {point.heartRate != null && <circle className="hr-point" cx={xAt(index, points.length)} cy={heartY(point.heartRate)} r="3" />}
          {point.bowel > 0 && <circle className="bowel-point" cx={xAt(index, points.length)} cy={symptomY(point.bowel)} r="3" />}
          {point.symptom != null && <circle className="symptom-point" cx={xAt(index, points.length)} cy={symptomY(point.symptom)} r="3" />}
        </g>)}
        {points.map((point, index) => {
          if (!labelIndexes.has(index)) return null;
          return <text key={`${point.day}-${index}`} className="chart-small" x={xAt(index, points.length)} y="169" textAnchor={index === points.length - 1 ? "end" : index === 0 ? "start" : "middle"}>{point.day}</text>;
        })}
      </svg>
      {!compact && note && <p className="note">{note}</p>}
    </figure>
  );
}
