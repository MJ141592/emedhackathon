import { useEffect, useRef, useState } from "react";
import type { ChatMessage, JournalEntry, Suggestion } from "../types";
import { CHAT_CHIPS } from "../data";

const ICONS: Record<Suggestion["icon"], string> = {
  flask: "M9 3h6M10 3v6l-4 8a3 3 0 0 0 3 4h6a3 3 0 0 0 3-4l-4-8V3M7.5 15h9",
  message: "M4 5h16v11H8l-4 4zM8 9h8M8 12h5",
  phone: "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2",
  note: "M5 4h13a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5zM5 4v16M9 9h6M9 13h6",
};

type Props = {
  messages: ChatMessage[];
  suggestions: Suggestion[];
  suggestionsNote: string;
  onSend: (text: string) => void;
  notify: (message: string) => void;
};

export function parseUtterance(
  text: string,
  nextId: () => number,
): { reply: ChatMessage; entries: Omit<JournalEntry, "id" | "time">[] } {
  const lower = text.toLowerCase();
  const entries: Omit<JournalEntry, "id" | "time">[] = [];
  const logged: string[] = [];

  if (!text.trim().endsWith("?")) {
    if (/(stool|poo|bowel|diarrh|loose|toilet|urgency)/.test(lower)) {
      const blood = lower.includes("blood");
      entries.push({
        kind: "BOWEL MOVEMENT",
        body: `Bristol type ${/loose|diarrh/.test(lower) ? 6 : 4}${blood ? ", small amount of blood" : ""} — logged from chat`,
        flagged: blood,
      });
      logged.push("that bowel movement");
    }
    if (/(breakfast|lunch|dinner|ate|porridge|coffee|meal|snack|takeaway)/.test(lower)) {
      entries.push({ kind: "MEAL", body: `${text.replace(/^i\s+(had|ate)\s+/i, "")} — added to your food diary` });
      logged.push("the meal");
    }
    const pain = lower.match(/pain[^0-9]*(\d{1,2})/);
    if (pain) {
      entries.push({ kind: "PAIN", body: `${pain[1]}/10 — above your usual 1–2` });
      logged.push(`pain at ${pain[1]}/10`);
    }
    if (/(tired|fatigue|shattered|exhausted|knackered)/.test(lower)) {
      entries.push({ kind: "FATIGUE", body: "Higher than usual — logged from chat" });
      logged.push("the fatigue");
    }
    if (/(night out|drinks|beers|alcohol)/.test(lower) && !/(meal)/.test(lower)) {
      entries.push({ kind: "LIFE EVENT", body: `${text} — possible trigger, no judgement` });
      logged.push("the night out");
    }
  }

  if (logged.length > 0) {
    return {
      reply: {
        id: nextId(),
        from: "penny",
        text: `Logged ${logged.join(" and ")} in your journal — tap any entry there to correct me. Anything else about how you're feeling?`,
      },
      entries,
    };
  }

  if (lower.includes("blood") && lower.includes("panic")) {
    return {
      reply: {
        id: nextId(),
        from: "penny",
        text: "On its own, a small amount isn't unusual and isn't a reason to panic. Alongside six days of rising symptoms, it is a reason to check properly — that's why I've suggested a calprotectin home test above. If bleeding ever becomes heavy, or you feel faint or feverish, that's urgent care straight away, not a test kit.",
      },
      entries: [],
    };
  }

  if (lower.includes("ibuprofen") || lower.includes("nsaid")) {
    return {
      reply: {
        id: nextId(),
        from: "penny",
        text: "Best avoided if you can — NSAIDs like ibuprofen are linked to flare-ups for some people with IBD, and your week is already off baseline. Paracetamol is usually the safer first option, but check with your pharmacist or IBD team. General information from approved sources, not a prescription decision.",
      },
      entries: [],
    };
  }

  return {
    reply: {
      id: nextId(),
      from: "penny",
      text: "Tell me anything — a meal, a symptom, a worry — and I'll do the structuring. I answer from your own records and approved IBD guidance, and anything safety-critical goes to your care team, not just me.",
    },
    entries: [],
  };
}

export function PennyChat({ messages, suggestions, suggestionsNote, onSend, notify }: Props) {
  const [input, setInput] = useState("");
  const threadRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    threadRef.current?.scrollTo?.({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const send = (text: string) => {
    if (!text.trim()) return;
    onSend(text);
    setInput("");
  };

  return (
    <div className="chatwrap">
      <div className="chathead">
        <div className="penny-avatar" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
          </svg>
        </div>
        <div className="who">
          <b>Penny</b>
          <small>Here to talk through symptoms, worries, or anything unclear</small>
        </div>
        <button className="btn callbtn" onClick={() => notify("Voice with Penny — coming in the next mock.")}>
          <svg viewBox="0 0 24 24">
            <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />
          </svg>
          Start voice call
        </button>
      </div>

      <div className="thread" ref={threadRef}>
        <span className="stamp">TODAY 08:12</span>
        {messages.map((message) => (
          <div key={message.id} className={message.from === "penny" ? "msg penny" : "msg me"}>
            {message.text}
          </div>
        ))}

        <div className="suggestcard">
          <p className="suggesthead">Suggested by Penny</p>
          {suggestions.map((suggestion) => (
            <div key={suggestion.title} className="action">
              <div className="ic">
                <svg viewBox="0 0 24 24">
                  <path d={ICONS[suggestion.icon]} />
                </svg>
              </div>
              <div className="tx">
                <b>{suggestion.title}</b>
                <span>{suggestion.desc}</span>
              </div>
              <button
                className="btn primary"
                onClick={() => notify(`${suggestion.title}: prepared for you to confirm (mock).`)}
              >
                {suggestion.cta}
              </button>
            </div>
          ))}
          <p className="note">{suggestionsNote}</p>
        </div>
      </div>

      <div className="chips">
        {CHAT_CHIPS.map((chip) => (
          <button key={chip} className="chip" onClick={() => send(chip)}>
            {chip}
          </button>
        ))}
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          send(input);
        }}
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Message Penny — say it however it comes out"
          aria-label="Message Penny"
        />
        <button className="send" type="submit" aria-label="Send">
          <svg viewBox="0 0 24 24">
            <path d="M12 19V5M6 11l6-6 6 6" />
          </svg>
        </button>
      </form>
    </div>
  );
}
