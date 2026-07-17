export type PhaseId = "stable" | "watch" | "flare" | "recovery";

export type JournalEntry = {
  id: number;
  time: string;
  kind: string;
  body: string;
  flagged?: boolean;
  penny?: boolean;
};

export type ChatMessage = {
  id: number;
  from: "penny" | "me";
  text: string;
};

export type Metric = {
  k: string;
  v: string;
  unit?: string;
  d: string;
  dClass: "up" | "warn" | "flat" | "ok";
};

export type Suggestion = {
  icon: "flask" | "message" | "phone" | "note";
  title: string;
  desc: string;
  cta: string;
};

export type PhaseContent = {
  pill: { label: string; className: string };
  sub: string;
  gauge: { percent: number; label: string };
  metrics: Metric[];
  suggestions: Suggestion[];
  suggestionsNote: string;
};
