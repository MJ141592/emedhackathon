import { useLayoutEffect, useRef, useState, type ChangeEvent } from "react";
import { Camera, Phone, Send } from "lucide-react";
import type { ChatMessage, EvidenceSource, Suggestion, SuggestionKind } from "../types";
import { normalizeTimeZone } from "../store/patientTime";

type Props = {
  messages: ChatMessage[];
  suggestions: Suggestion[];
  suggestionsNote: string;
  timeZone: string;
  trackingEnabled: boolean;
  journalInferenceEnabled: boolean;
  onSend: (text: string) => Promise<boolean>;
  onCorrectMessage: (id: number, text: string) => Promise<boolean>;
  onDeleteMessage: (id: number) => Promise<boolean>;
  onSuggestion: (kind: SuggestionKind) => void;
  onSourceTarget: (target: NonNullable<EvidenceSource["target"]>) => void;
  notify: (message: string) => void;
};

export function formatChatTimestamp(value: string, timeZone: string): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return "Time unavailable";
  const zone = normalizeTimeZone(timeZone, "UTC");
  const date = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: zone,
  }).format(instant);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: zone,
  }).format(instant);
  return `${date} · ${time}`;
}

export function PennyChat({ messages, timeZone, trackingEnabled, onSend, notify }: Props) {
  const [input, setInput] = useState("");
  const [sendBusy, setSendBusy] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLInputElement | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const newestMessageId = messages.at(-1)?.id;

  useLayoutEffect(() => {
    const thread = threadRef.current;
    const newestMessage = newestMessageId == null
      ? null
      : thread?.querySelector<HTMLElement>(`#message-${newestMessageId}`);
    if (!thread || !newestMessage) return;
    // Keep scrolling local to the conversation, following the newest message.
    const top = Math.max(0, thread.scrollTop + newestMessage.getBoundingClientRect().top - thread.getBoundingClientRect().top - 12);
    if (typeof thread.scrollTo === "function") thread.scrollTo({ top, behavior: "auto" });
    else thread.scrollTop = top;
  }, [messages.length, newestMessageId]);

  const send = async (text: string): Promise<boolean> => {
    if (!text.trim() || sendBusy) return false;
    setSendBusy(true);
    try {
      const saved = await onSend(text);
      if (!saved) {
        notify("That message could not be saved safely. Your text is still here so you can retry.");
        return false;
      }
      setInput("");
      return true;
    } catch {
      notify("That message could not be saved safely. Your text is still here so you can retry.");
      return false;
    } finally {
      setSendBusy(false);
    }
  };

  const startCall = () => {
    notify("Connecting you to your IBD nurse…");
  };

  const attachPhoto = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) notify("Photo added to your conversation with Remi.");
  };

  return (
    <section className="chatwrap" aria-label="Chat with Remi">
      <div className="thread" ref={threadRef} role="log" aria-label="Conversation with Remi" aria-live="polite" aria-relevant="additions text">
        {messages.length === 0 && <div className="empty-state"><b>Your conversation is private and empty.</b><span>Send Remi a message or a question in your own words.</span></div>}
        {messages.map((message) => (
          <article id={`message-${message.id}`} key={message.id} className={message.from === "penny" ? "msg penny" : "msg me"}>
            <time className="message-time" dateTime={message.createdAt}>{formatChatTimestamp(message.createdAt, timeZone)}</time>
            <p>{message.text}</p>
          </article>
        ))}
      </div>

      <form className="composer" aria-busy={sendBusy} onSubmit={(event) => { event.preventDefault(); void send(input); }}>
        <input ref={composerRef} value={input} disabled={!trackingEnabled} readOnly={sendBusy} aria-disabled={!trackingEnabled || undefined} onChange={(event) => setInput(event.target.value)} placeholder={trackingEnabled ? "Message Remi" : "Tracking paused — re-enable consent in Profile"} aria-label="Message Remi" />
        <button className="send" type="submit" disabled={!trackingEnabled || sendBusy} aria-label={sendBusy ? "Sending message…" : "Send message"} aria-describedby={sendBusy ? "remi-send-status" : undefined}><Send aria-hidden="true" /></button>
        <button className="tool" type="button" onClick={startCall} aria-label="Call your IBD nurse"><Phone aria-hidden="true" /></button>
        <button className="tool" type="button" onClick={() => photoInputRef.current?.click()} aria-label="Take or add a photo"><Camera aria-hidden="true" /></button>
        <input ref={photoInputRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={attachPhoto} />
        <span id="remi-send-status" className="sr-only" role="status" aria-live="polite">{sendBusy ? "Sending message…" : ""}</span>
      </form>
    </section>
  );
}

export { structureUtterance as parseUtterance } from "../store/captureService";
