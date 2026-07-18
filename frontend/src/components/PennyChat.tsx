import { useLayoutEffect, useRef, useState } from "react";
import { Check, Mic, Pause, Pencil, Send, Sparkles, Trash2, Volume2, X } from "lucide-react";
import type { ChatMessage, EvidenceSource, Suggestion, SuggestionKind } from "../types";
import { CHAT_CHIPS } from "../data";
import { useAudioRecorder } from "../useAudioRecorder";
import { aiClient } from "../api";
import { prepareVoiceNoteForTranscription } from "../audioTranscription";
import { normalizeTimeZone } from "../store/patientTime";
import { ConfirmDialog } from "./ui/ConfirmDialog";

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

function SourceLink({ source, onSourceTarget }: { source: EvidenceSource; onSourceTarget: Props["onSourceTarget"] }) {
  if (source.excluded) return <b>{source.label} · retracted</b>;
  if (source.entryId) return <a href={`#entry-${source.entryId}`}><b>{source.label}</b></a>;
  if (source.messageId) return <a href={`#message-${source.messageId}`}><b>{source.label}</b></a>;
  if (source.target) return <button type="button" className="source-link" onClick={() => onSourceTarget(source.target!)}><b>{source.label}</b></button>;
  if (source.url && /^https:\/\//i.test(source.url)) return <a href={source.url} target="_blank" rel="noopener noreferrer"><b>{source.label}</b></a>;
  return <b>{source.label}</b>;
}

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

export function PennyChat({ messages, suggestions, suggestionsNote, timeZone, trackingEnabled, journalInferenceEnabled, onSend, onCorrectMessage, onDeleteMessage, onSuggestion, onSourceTarget, notify }: Props) {
  const [input, setInput] = useState("");
  const [voiceReview, setVoiceReview] = useState<string | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [speechBusyId, setSpeechBusyId] = useState<number | null>(null);
  const [speech, setSpeech] = useState<{ id: number; url: string } | null>(null);
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [messageBusy, setMessageBusy] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLInputElement | null>(null);
  const correctionTriggerRefs = useRef(new Map<number, HTMLButtonElement>());
  const messageActionRefs = useRef(new Map<number, HTMLButtonElement>());
  const recorder = useAudioRecorder();
  const newestMessageId = messages.at(-1)?.id;

  useLayoutEffect(() => {
    const thread = threadRef.current;
    const newestMessage = newestMessageId == null
      ? null
      : thread?.querySelector<HTMLElement>(`#message-${newestMessageId}`);
    if (!thread || !newestMessage) return;
    // Keep scrolling local to the conversation. scrollIntoView can also move the page,
    // while scrolling to the absolute bottom can hide the start of a long Penny reply.
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

  const closeCorrection = (id: number) => {
    setEditing(null);
    requestAnimationFrame(() => correctionTriggerRefs.current.get(id)?.focus());
  };

  const reviewVoice = async () => {
    if (!recorder.audio) return;
    if (!journalInferenceEnabled) {
      notify("Penny’s Journal and photos access is off, so this recording will not be sent for transcription.");
      return;
    }
    setVoiceBusy(true);
    try {
      const status = await aiClient.status();
      if (!status.configured) {
        setVoiceReview("");
        notify("Runware isn’t configured, so listen back and type only the words you want to add.");
        return;
      }
      const result = await aiClient.transcribe(await prepareVoiceNoteForTranscription(recorder.audio));
      setVoiceReview(result.text);
    } catch {
      // Never turn instructional fallback copy into a confirmable patient health record.
      setVoiceReview("");
      notify("Automatic transcription could not be completed. The recording stays here; listen back and type the wording yourself.");
    } finally {
      setVoiceBusy(false);
    }
  };

  const listenToReply = async (message: ChatMessage) => {
    setSpeechBusyId(message.id);
    try {
      const status = await aiClient.status();
      if (!status.configured) {
        notify("Runware text-to-speech is ready to connect, but this environment has no API key or credits.");
        return;
      }
      const result = await aiClient.synthesize(message.text.slice(0, 4_000), "eve", "en-GB");
      setSpeech({ id: message.id, url: result.audio_url });
    } catch {
      notify("The optional spoken reply could not be generated. The written reply is unchanged.");
    } finally {
      setSpeechBusyId(null);
    }
  };

  const saveCorrection = async () => {
    if (!editing?.text.trim() || messageBusy) return;
    const correction = editing;
    setMessageBusy(true);
    let saved = false;
    try {
      saved = await onCorrectMessage(correction.id, correction.text);
    } finally {
      setMessageBusy(false);
    }
    if (!saved) return notify("That conversation correction could not be saved. The original wording is unchanged.");
    closeCorrection(correction.id);
    notify("Your message was corrected. Stale PMH proposals and historical reply links were retracted; journal records remain separately correctable.");
  };

  const confirmDelete = async () => {
    if (deleteId == null || messageBusy) return;
    const targetIndex = messages.findIndex((message) => message.id === deleteId);
    const target = messages.find((message) => message.id === deleteId);
    const adjacentMessage = messages[targetIndex + 1] ?? messages[targetIndex - 1];
    setMessageBusy(true);
    let deleted = false;
    try {
      deleted = await onDeleteMessage(deleteId);
    } finally {
      setMessageBusy(false);
    }
    if (!deleted) return notify("That conversation record could not be deleted.");
    setDeleteId(null);
    if (editing?.id === target?.id) setEditing(null);
    requestAnimationFrame(() => {
      const adjacentAction = adjacentMessage ? messageActionRefs.current.get(adjacentMessage.id) : null;
      if (adjacentAction?.isConnected) adjacentAction.focus();
      else composerRef.current?.focus();
    });
    notify(target?.from === "me"
      ? "Your message and its PMH proposal records were deleted. Separate journal records were preserved and historical reply links retracted."
      : "The individual Penny reply was deleted. Its source journal records were not changed.");
  };

  return (
    <section className="chatwrap" aria-labelledby="penny-heading">
      <div className="chathead">
        <div className="penny-avatar" aria-hidden="true"><Sparkles /></div>
        <div className="who"><h2 id="penny-heading">Penny</h2><small>Grounded in your records</small></div>
        {recorder.state === "recording" ? (
          <button className="btn callbtn recording" onClick={recorder.stop}><Pause aria-hidden="true" /> Stop recording</button>
        ) : (
          <button className="btn callbtn" onClick={recorder.start} disabled={!trackingEnabled || !journalInferenceEnabled}><Mic aria-hidden="true" /> Add voice note</button>
        )}
      </div>

      {(recorder.state === "ready" || recorder.error) && (
        <div className="voice-review" role="status">
          {recorder.previewUrl && <audio controls src={recorder.previewUrl} aria-label="Recorded voice note preview" />}
          {recorder.error ? <p>{recorder.error}</p> : <button className="btn" onClick={reviewVoice} disabled={voiceBusy || !journalInferenceEnabled}><Volume2 aria-hidden="true" /> {voiceBusy ? "Checking transcription…" : "Transcribe and review"}</button>}
          <button className="text-btn" onClick={recorder.reset}>Discard</button>
        </div>
      )}
      {voiceReview !== null && (
        <div className="structured-preview">
          <label htmlFor="voice-transcript">Review voice transcript before logging</label>
          <textarea id="voice-transcript" value={voiceReview} onChange={(event) => setVoiceReview(event.target.value)} placeholder="Type only what you can confirm from the recording" />
          <div className="button-row"><button className="btn primary" disabled={sendBusy || !voiceReview.trim()} onClick={() => { void send(voiceReview).then((saved) => { if (saved) { setVoiceReview(null); recorder.reset(); } }); }}>Confirm transcript</button><button className="btn" onClick={() => setVoiceReview(null)}>Cancel</button></div>
        </div>
      )}

      <div className="thread" ref={threadRef} role="log" aria-label="Conversation with Penny" aria-live="polite" aria-relevant="additions text">
        {messages.length === 0 && <div className="empty-state"><b>Your conversation is private and empty.</b><span>Ask Penny a question or log something in your own words.</span></div>}
        {messages.map((message) => {
          const retractedSource = message.sources?.some((source) => source.excluded);
          return <article id={`message-${message.id}`} key={message.id} className={message.from === "penny" ? "msg penny" : "msg me"}>
            <time className="message-time" dateTime={message.createdAt}>{formatChatTimestamp(message.createdAt, timeZone)}</time>
            {message.category && <span className={`answer-kind ${message.category.replaceAll(" ", "-")}`}>{message.category}</span>}
            {editing?.id === message.id ? <div className="message-edit"><label htmlFor={`correct-message-${message.id}`}>Correct your message</label><textarea id={`correct-message-${message.id}`} value={editing.text} onChange={(event) => setEditing({ id: message.id, text: event.target.value })} onKeyDown={(event) => { if (event.key === "Escape" && !messageBusy) { event.preventDefault(); closeCorrection(message.id); } }} autoFocus /><div className="message-actions"><button type="button" className="text-btn" disabled={messageBusy || !editing.text.trim()} onClick={() => void saveCorrection()}><Check /> Save correction</button><button type="button" className="text-btn" disabled={messageBusy} onClick={() => closeCorrection(message.id)}><X /> Cancel</button></div></div> : <p>{message.text}</p>}
            {retractedSource && <p className="source-retracted" role="status">A source used for this earlier reply was corrected, excluded or deleted. Treat the wording above as historical and review the current journal record.</p>}
            {message.from === "penny" && <button className="message-listen" onClick={() => listenToReply(message)} disabled={speechBusyId === message.id} aria-label={`Listen to Penny reply: ${message.text.slice(0, 60)}`}><Volume2 aria-hidden="true" />{speechBusyId === message.id ? "Preparing audio…" : "Listen (optional Runware)"}</button>}
            {speech?.id === message.id && <audio className="message-audio" controls autoPlay src={speech.url} aria-label="Spoken Penny reply" />}
            {message.sources && message.sources.length > 0 && (
              <details className="message-sources">
                <summary>{message.sources.length} source{message.sources.length === 1 ? "" : "s"} used</summary>
                {message.sources.map((source) => <div key={`${source.label}-${source.date}`}><SourceLink source={source} onSourceTarget={onSourceTarget} /><span>{source.date} · {source.detail}</span></div>)}
              </details>
            )}
            {editing?.id !== message.id && <div className="message-actions" role="group" aria-label={`${message.from === "me" ? "Your message" : "Penny reply"} controls`}>
              {message.from === "me" && <button ref={(element) => { if (element) { correctionTriggerRefs.current.set(message.id, element); messageActionRefs.current.set(message.id, element); } else { correctionTriggerRefs.current.delete(message.id); messageActionRefs.current.delete(message.id); } }} type="button" className="text-btn" onClick={() => setEditing({ id: message.id, text: message.text })}><Pencil /> Correct</button>}
              <button ref={message.from === "penny" ? (element) => { if (element) messageActionRefs.current.set(message.id, element); else messageActionRefs.current.delete(message.id); } : undefined} type="button" className="text-btn danger-text" onClick={() => setDeleteId(message.id)}><Trash2 /> {message.from === "me" ? "Delete" : "Delete reply"}</button>
            </div>}
          </article>;
        })}

        <div className="suggestcard">
          <p className="suggesthead">Suggested by Penny</p>
          {suggestions.map((suggestion) => (
            <div key={suggestion.title} className="action">
              <div className="ic" aria-hidden="true"><svg viewBox="0 0 24 24"><path d={ICONS[suggestion.icon]} /></svg></div>
              <div className="tx"><b>{suggestion.title}</b><span>{suggestion.desc}</span></div>
              <button className="btn primary" onClick={() => onSuggestion(suggestion.kind)}>{suggestion.cta}</button>
              {suggestion.sources && suggestion.sources.length > 0 && <details className="suggestion-sources"><summary>{suggestion.sources.length} exact source record{suggestion.sources.length === 1 ? "" : "s"}</summary>{suggestion.sources.map((source) => <div key={`${suggestion.kind}-${source.entryId ?? source.label}`}><SourceLink source={source} onSourceTarget={onSourceTarget} /><span>{source.date} · open the correctable source</span></div>)}</details>}
            </div>
          ))}
          <p className="note">{suggestionsNote}</p>
        </div>
      </div>

      <div className="chips" aria-label="Quick messages">
        {CHAT_CHIPS.map((chip) => <button key={chip} className="chip" disabled={!trackingEnabled || sendBusy} aria-label={sendBusy ? `${chip} — Sending message…` : chip} aria-describedby={sendBusy ? "penny-send-status" : undefined} onClick={() => void send(chip)}>{chip}</button>)}
      </div>
      <form className="composer" aria-busy={sendBusy} onSubmit={(event) => { event.preventDefault(); void send(input); }}>
        <input ref={composerRef} value={input} disabled={!trackingEnabled} readOnly={sendBusy} aria-disabled={!trackingEnabled || undefined} onChange={(event) => setInput(event.target.value)} placeholder={trackingEnabled ? "Message Penny" : "Tracking paused — re-enable consent in Profile"} aria-label="Message Penny" />
        <button className="send" type="submit" disabled={!trackingEnabled || sendBusy} aria-label={sendBusy ? "Sending message…" : "Send message"} aria-describedby={sendBusy ? "penny-send-status" : undefined}><Send aria-hidden="true" /></button>
        <span id="penny-send-status" className="sr-only" role="status" aria-live="polite">{sendBusy ? "Sending message…" : ""}</span>
      </form>
      <p className="composer-safety">{trackingEnabled ? "Urgent wording is safety-checked before Penny replies." : "Urgent help, correction, export and deletion stay available while tracking is paused."}</p>
      <ConfirmDialog open={deleteId != null} title={messages.find((message) => message.id === deleteId)?.from === "me" ? "Delete your message?" : "Delete this Penny reply?"} description={messages.find((message) => message.id === deleteId)?.from === "me" ? "The message and its PMH proposal records will be deleted. Journal entries created from it stay separately visible and correctable; the linked historical reply will be marked retracted." : "Only this Penny reply will be deleted. Linked journal records and your own messages will not be changed."} confirmLabel={messageBusy ? "Deleting…" : "Delete conversation record"} danger onCancel={() => { if (!messageBusy) setDeleteId(null); }} onConfirm={() => void confirmDelete()} />
    </section>
  );
}

export { structureUtterance as parseUtterance } from "../store/captureService";
