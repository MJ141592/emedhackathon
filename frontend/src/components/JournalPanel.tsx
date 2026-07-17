import { useState } from "react";
import type { JournalEntry } from "../types";
import { YESTERDAY_ENTRIES } from "../data";

type Props = {
  entries: JournalEntry[];
  addEntry: (entry: Omit<JournalEntry, "id" | "time">) => void;
  notify: (message: string) => void;
};

const BRISTOL = [1, 2, 3, 4, 5, 6, 7];
const PAIN_LEVELS = [2, 4, 6, 8];

function EntryRow({ entry }: { entry: JournalEntry }) {
  return (
    <div className={entry.penny ? "entry penny-note" : entry.flagged ? "entry flagged" : "entry"}>
      <p className="meta">
        {entry.penny ? entry.kind : `${entry.time} · ${entry.kind}`}
        {entry.flagged && <span className="pill flag">Flagged</span>}
      </p>
      <p className="body">{entry.body}</p>
    </div>
  );
}

export function JournalPanel({ entries, addEntry, notify }: Props) {
  const [expanded, setExpanded] = useState<"bowel" | "pain" | null>(null);

  const quickAdd = (entry: Omit<JournalEntry, "id" | "time">, toast: string) => {
    addEntry(entry);
    notify(toast);
    setExpanded(null);
  };

  return (
    <aside className="journal">
      <div className="journalhead">
        <h2>Journal</h2>
        <p className="sub">One stream — this is what Penny reads. Tap anything to correct it.</p>
      </div>

      <div className="quickadd">
        <button
          className="qbtn"
          onClick={() =>
            quickAdd(
              { kind: "MEAL", body: "Meal photo — added to your food diary, analysis in background" },
              "Added to your food diary — you're done. No calories, no judgement.",
            )
          }
        >
          📷 Meal photo
        </button>
        <button className={expanded === "bowel" ? "qbtn open" : "qbtn"} onClick={() => setExpanded(expanded === "bowel" ? null : "bowel")}>
          🚽 Bowel
        </button>
        <button className={expanded === "pain" ? "qbtn open" : "qbtn"} onClick={() => setExpanded(expanded === "pain" ? null : "pain")}>
          🤕 Pain
        </button>
        <button
          className="qbtn"
          onClick={() =>
            quickAdd(
              { kind: "LIFE EVENT", body: "Life event noted — Penny will watch the next few days a little more closely" },
              "Noted — no judgement, it's just context.",
            )
          }
        >
          🌙 Life event
        </button>
      </div>

      {expanded === "bowel" && (
        <div className="mini-form">
          <p className="meta">Bristol type — one tap logs it</p>
          <div className="mini-row">
            {BRISTOL.map((type) => (
              <button
                key={type}
                className="mini-opt"
                onClick={() =>
                  quickAdd(
                    { kind: "BOWEL MOVEMENT", body: `Bristol type ${type} — tap to add blood, urgency or pain`, flagged: type >= 6 },
                    "Logged. Add detail only if you want to.",
                  )
                }
              >
                {type}
              </button>
            ))}
          </div>
        </div>
      )}

      {expanded === "pain" && (
        <div className="mini-form">
          <p className="meta">Pain right now</p>
          <div className="mini-row">
            {PAIN_LEVELS.map((level) => (
              <button
                key={level}
                className="mini-opt"
                onClick={() =>
                  quickAdd({ kind: "PAIN", body: `${level}/10 — logged with one tap` }, "Pain logged against your baseline.")
                }
              >
                {level}/10
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="day">Today · Friday 17 July</p>
      <div className="tl">
        {entries.map((entry) => (
          <EntryRow key={entry.id} entry={entry} />
        ))}
      </div>

      <p className="day">Yesterday · Thursday 16 July</p>
      <div className="tl">
        {YESTERDAY_ENTRIES.map((entry) => (
          <EntryRow key={entry.id} entry={entry} />
        ))}
      </div>
    </aside>
  );
}
