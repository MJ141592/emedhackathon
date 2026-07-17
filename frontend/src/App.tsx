import { useCallback, useRef, useState } from "react";
import type { ChatMessage, JournalEntry, PhaseId } from "./types";
import { INITIAL_CHAT, INITIAL_TODAY_ENTRIES, PHASE_LABELS, TODAY } from "./data";
import { TodayHeader } from "./components/TodayHeader";
import { PennyChat, parseUtterance } from "./components/PennyChat";
import { JournalPanel } from "./components/JournalPanel";

function App() {
  const [phase, setPhase] = useState<PhaseId>("watch");
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_CHAT);
  const [entries, setEntries] = useState<JournalEntry[]>(INITIAL_TODAY_ENTRIES);
  const [toast, setToast] = useState<string | null>(null);
  const idRef = useRef(100);
  const nextId = useCallback(() => ++idRef.current, []);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3400);
  }, []);

  const addEntry = useCallback(
    (entry: Omit<JournalEntry, "id" | "time">) => {
      const now = new Date();
      const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      setEntries((current) => [...current, { ...entry, id: nextId(), time }]);
    },
    [nextId],
  );

  const sendChat = useCallback(
    (text: string) => {
      const mine: ChatMessage = { id: nextId(), from: "me", text };
      const { reply, entries: parsed } = parseUtterance(text, nextId);
      setMessages((current) => [...current, mine, reply]);
      parsed.forEach(addEntry);
    },
    [addEntry, nextId],
  );

  const content = TODAY[phase];

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="name">MeMed</span>
          <span className="tag">IBD companion</span>
        </div>
        <div className="demo">
          <span>Demo</span>
          {PHASE_LABELS.map((candidate) => (
            <button
              key={candidate.id}
              className={candidate.id === phase ? "demo-btn selected" : "demo-btn"}
              onClick={() => setPhase(candidate.id)}
            >
              {candidate.label}
            </button>
          ))}
        </div>
        <button className="urgent" onClick={() => notify("Urgent help: 111, or 999 / A&E if severe. Your IBD advice line: 020 7946 0000.")}>
          Urgent help
        </button>
        <div className="me">
          <div className="avatar">AO</div>
          <div>
            <b>Amara O.</b>
            <small>Crohn's · azathioprine</small>
          </div>
        </div>
      </header>

      <div className="cols">
        <main className="left">
          <TodayHeader content={content} />
          <PennyChat
            messages={messages}
            suggestions={content.suggestions}
            suggestionsNote={content.suggestionsNote}
            onSend={sendChat}
            notify={notify}
          />
        </main>
        <JournalPanel entries={entries} addEntry={addEntry} notify={notify} />
      </div>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

export default App;
