import {
  Bot,
  Camera,
  Check,
  CircleAlert,
  FileAudio,
  ImagePlus,
  LoaderCircle,
  MessageSquareText,
  Mic,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  Volume2,
} from "lucide-react";
import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import { aiClient, AIStatus, ChatMessage } from "./api";
import { useAudioRecorder } from "./useAudioRecorder";

type Tool = "chat" | "voice" | "photo" | "speech";

const tools: { id: Tool; label: string; icon: typeof MessageSquareText }[] = [
  { id: "chat", label: "Chat", icon: MessageSquareText },
  { id: "voice", label: "Voice note", icon: Mic },
  { id: "photo", label: "Photo log", icon: Camera },
  { id: "speech", label: "Read aloud", icon: Volume2 },
];

function BusyLabel({ children }: { children: ReactNode }) {
  return (
    <>
      <LoaderCircle className="spin" size={17} aria-hidden="true" />
      {children}
    </>
  );
}

function ErrorMessage({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="inline-error" role="alert">
      <CircleAlert size={17} aria-hidden="true" />
      {message}
    </p>
  );
}

function ChatPanel({ disabled }: { disabled: boolean }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => endRef.current?.scrollIntoView?.({ behavior: "smooth" }), [messages]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || busy || disabled) return;

    const nextMessages: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(nextMessages);
    setDraft("");
    setError(null);
    setBusy(true);
    try {
      const result = await aiClient.chat(nextMessages);
      setMessages([...nextMessages, { role: "assistant", content: result.text }]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Chat failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tool-panel chat-panel">
      <header className="panel-heading">
        <div>
          <span className="kicker">Assistant</span>
          <h1>Conversation</h1>
        </div>
        {messages.length > 0 && (
          <button className="icon-button" onClick={() => setMessages([])} title="Clear chat">
            <RotateCcw size={18} aria-hidden="true" />
            <span className="sr-only">Clear chat</span>
          </button>
        )}
      </header>

      <div className="conversation" aria-live="polite">
        {messages.length === 0 && (
          <div className="empty-state">
            <Bot size={28} aria-hidden="true" />
            <p>What would you like to record or understand?</p>
          </div>
        )}
        {messages.map((message, index) => (
          <div className={`message ${message.role}`} key={`${message.role}-${index}`}>
            <span className="message-role">{message.role === "user" ? "You" : "eMed"}</span>
            <p>{message.content}</p>
          </div>
        ))}
        {busy && (
          <div className="thinking" role="status">
            <LoaderCircle className="spin" size={16} aria-hidden="true" /> Thinking
          </div>
        )}
        <div ref={endRef} />
      </div>

      <ErrorMessage message={error} />
      <form className="composer" onSubmit={submit}>
        <label className="sr-only" htmlFor="chat-input">
          Message
        </label>
        <textarea
          id="chat-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="Message eMed"
          rows={2}
          maxLength={8000}
          disabled={disabled}
        />
        <button
          className="send-button"
          type="submit"
          disabled={!draft.trim() || busy || disabled}
          title="Send message"
        >
          <Send size={19} aria-hidden="true" />
          <span className="sr-only">Send message</span>
        </button>
      </form>
    </div>
  );
}

function VoicePanel({ disabled }: { disabled: boolean }) {
  const recorder = useAudioRecorder();
  const [file, setFile] = useState<File | null>(null);
  const [filePreviewUrl, setFilePreviewUrl] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const audioSource = recorder.audio ?? file;

  useEffect(() => {
    if (!file) {
      setFilePreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setFilePreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  async function transcribe() {
    if (!audioSource || disabled) return;
    setBusy(true);
    setError(null);
    try {
      const result = await aiClient.transcribe(audioSource);
      setTranscript(result.text);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Transcription failed.");
    } finally {
      setBusy(false);
    }
  }

  function clear() {
    recorder.reset();
    setFile(null);
    setTranscript("");
    setError(null);
  }

  return (
    <div className="tool-panel">
      <header className="panel-heading">
        <div>
          <span className="kicker">Capture</span>
          <h1>Voice note</h1>
        </div>
      </header>

      <div className={`recorder ${recorder.state === "recording" ? "is-recording" : ""}`}>
        <div className="record-indicator">
          <Mic size={24} aria-hidden="true" />
          <strong>{recorder.state === "recording" ? "Recording" : "Ready"}</strong>
        </div>
        {recorder.state === "recording" ? (
          <button className="danger-button" type="button" onClick={recorder.stop}>
            <Square size={16} fill="currentColor" aria-hidden="true" /> Stop
          </button>
        ) : (
          <button className="primary-button" type="button" onClick={recorder.start} disabled={disabled}>
            <Mic size={17} aria-hidden="true" /> Record
          </button>
        )}
      </div>

      <div className="file-row">
        <label className="secondary-button" htmlFor="audio-file">
          <FileAudio size={17} aria-hidden="true" /> Choose audio
        </label>
        <input
          id="audio-file"
          className="sr-only"
          type="file"
          accept="audio/*"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        <span>{file?.name ?? (recorder.audio ? "Recorded voice note" : "No audio selected")}</span>
      </div>

      {recorder.previewUrl && <audio className="audio-player" controls src={recorder.previewUrl} />}
      {filePreviewUrl && <audio className="audio-player" controls src={filePreviewUrl} />}

      <ErrorMessage message={recorder.error ?? error} />
      <div className="action-row">
        <button
          className="primary-button"
          type="button"
          onClick={transcribe}
          disabled={!audioSource || busy || disabled}
        >
          {busy ? <BusyLabel>Transcribing</BusyLabel> : <><Sparkles size={17} aria-hidden="true" /> Transcribe</>}
        </button>
        {(audioSource || transcript) && (
          <button className="text-button" type="button" onClick={clear}>Clear</button>
        )}
      </div>

      {transcript && (
        <div className="result-block">
          <label htmlFor="transcript">Transcript</label>
          <textarea id="transcript" value={transcript} onChange={(event) => setTranscript(event.target.value)} rows={7} />
        </div>
      )}
    </div>
  );
}

function PhotoPanel({ disabled }: { disabled: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [purpose, setPurpose] = useState<"meal_log" | "general">("meal_log");
  const [note, setNote] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  async function analyse() {
    if (!file || disabled) return;
    setBusy(true);
    setError(null);
    try {
      const response = await aiClient.describeImage(file, purpose, note);
      setResult(response.text);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Image analysis failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tool-panel">
      <header className="panel-heading">
        <div>
          <span className="kicker">Diary</span>
          <h1>Photo log</h1>
        </div>
      </header>

      <div className="segmented" aria-label="Photo type">
        <button className={purpose === "meal_log" ? "active" : ""} onClick={() => setPurpose("meal_log")} type="button">Meal</button>
        <button className={purpose === "general" ? "active" : ""} onClick={() => setPurpose("general")} type="button">General</button>
      </div>

      <label className={`photo-drop ${preview ? "has-preview" : ""}`} htmlFor="photo-file">
        {preview ? (
          <img src={preview} alt="Selected log" />
        ) : (
          <>
            <ImagePlus size={26} aria-hidden="true" />
            <span>Choose photo</span>
          </>
        )}
      </label>
      <input
        id="photo-file"
        className="sr-only"
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(event) => {
          setFile(event.target.files?.[0] ?? null);
          setResult("");
        }}
      />

      <label className="field-label" htmlFor="photo-note">Note <span>optional</span></label>
      <input id="photo-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder="Add context" />

      {purpose === "meal_log" && (
        <p className="constraint-note"><Check size={16} aria-hidden="true" /> Neutral logging only. No calories, macros, scores, or judgement.</p>
      )}
      <ErrorMessage message={error} />
      <button className="primary-button" type="button" onClick={analyse} disabled={!file || busy || disabled}>
        {busy ? <BusyLabel>Creating entry</BusyLabel> : <><Sparkles size={17} aria-hidden="true" /> Create log entry</>}
      </button>

      {result && (
        <div className="result-block">
          <label htmlFor="photo-result">Log entry</label>
          <textarea id="photo-result" value={result} onChange={(event) => setResult(event.target.value)} rows={8} />
        </div>
      )}
    </div>
  );
}

function SpeechPanel({ disabled }: { disabled: boolean }) {
  const [text, setText] = useState("");
  const [voice, setVoice] = useState("eve");
  const [language, setLanguage] = useState("en");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function generate() {
    if (!text.trim() || disabled) return;
    setBusy(true);
    setError(null);
    try {
      const response = await aiClient.synthesize(text.trim(), voice, language);
      setAudioUrl(response.audio_url);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Speech generation failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tool-panel">
      <header className="panel-heading">
        <div>
          <span className="kicker">Accessibility</span>
          <h1>Read aloud</h1>
        </div>
      </header>

      <label className="field-label" htmlFor="speech-text">Text</label>
      <textarea id="speech-text" value={text} onChange={(event) => setText(event.target.value)} rows={8} maxLength={4000} placeholder="Enter text to hear" />

      <div className="field-grid">
        <div>
          <label className="field-label" htmlFor="speech-voice">Voice</label>
          <select id="speech-voice" value={voice} onChange={(event) => setVoice(event.target.value)}>
            <option value="eve">Eve</option>
            <option value="ara">Ara</option>
            <option value="leo">Leo</option>
            <option value="rex">Rex</option>
            <option value="sal">Sal</option>
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="speech-language">Language</label>
          <input id="speech-language" value={language} onChange={(event) => setLanguage(event.target.value)} maxLength={12} />
        </div>
      </div>

      <ErrorMessage message={error} />
      <button className="primary-button" type="button" onClick={generate} disabled={!text.trim() || busy || disabled}>
        {busy ? <BusyLabel>Generating</BusyLabel> : <><Volume2 size={17} aria-hidden="true" /> Generate speech</>}
      </button>
      {audioUrl && <audio className="audio-player" controls autoPlay src={audioUrl} />}
    </div>
  );
}

function App() {
  const [activeTool, setActiveTool] = useState<Tool>("chat");
  const [status, setStatus] = useState<AIStatus | null>(null);
  const [backendError, setBackendError] = useState(false);

  useEffect(() => {
    aiClient.status().then(setStatus).catch(() => setBackendError(true));
  }, []);

  const disabled = status?.configured === false || backendError;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand"><span className="brand-mark">e</span><strong>eMed</strong></div>
        <div className={`provider-status ${disabled ? "offline" : ""}`} role="status">
          <span aria-hidden="true" />
          {backendError ? "Backend offline" : status?.configured === false ? "Runware key needed" : status ? "Runware ready" : "Connecting"}
        </div>
      </header>

      <div className="workspace">
        <nav className="tool-nav" aria-label="AI tools">
          <p>AI workspace</p>
          {tools.map(({ id, label, icon: Icon }) => (
            <button key={id} className={activeTool === id ? "active" : ""} onClick={() => setActiveTool(id)} type="button">
              <Icon size={18} aria-hidden="true" /> {label}
            </button>
          ))}
          <div className="nav-footnote"><Sparkles size={15} aria-hidden="true" /> Powered by Runware</div>
        </nav>

        <main className="main-content">
          {status?.configured === false && (
            <div className="configuration-alert" role="alert">
              <CircleAlert size={18} aria-hidden="true" />
              <span>Set <code>RUNWARE_API_KEY</code> on the backend to enable AI requests.</span>
            </div>
          )}
          {activeTool === "chat" && <ChatPanel disabled={disabled} />}
          {activeTool === "voice" && <VoicePanel disabled={disabled} />}
          {activeTool === "photo" && <PhotoPanel disabled={disabled} />}
          {activeTool === "speech" && <SpeechPanel disabled={disabled} />}
        </main>
      </div>
    </div>
  );
}

export default App;
