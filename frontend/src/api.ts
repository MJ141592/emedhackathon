export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type TextResult = {
  text: string;
  model: string;
};

export type AudioResult = {
  audio_url: string;
  model: string;
};

export type AIStatus = {
  configured: boolean;
  models: Record<string, string>;
};

type ErrorResponse = {
  detail?: string;
  message?: string;
};

export class APIError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class AIClient {
  constructor(private readonly basePath = "/api/ai") {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.basePath}${path}`, init);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ErrorResponse;
      throw new APIError(body.message ?? body.detail ?? "The AI request failed.", response.status);
    }
    return response.json() as Promise<T>;
  }

  status(): Promise<AIStatus> {
    return this.request<AIStatus>("/status");
  }

  chat(messages: ChatMessage[]): Promise<TextResult> {
    return this.request<TextResult>("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
  }

  transcribe(audio: Blob): Promise<TextResult> {
    const form = new FormData();
    form.append("audio", audio, "voice-note.webm");
    return this.request<TextResult>("/speech-to-text", { method: "POST", body: form });
  }

  describeImage(file: File, purpose: "meal_log" | "toilet_log" | "general", note: string): Promise<TextResult> {
    const form = new FormData();
    form.append("image", file);
    form.append("purpose", purpose);
    if (note.trim()) form.append("note", note.trim());
    return this.request<TextResult>("/image-to-text", { method: "POST", body: form });
  }

  synthesize(text: string, voice: string, language: string): Promise<AudioResult> {
    return this.request<AudioResult>("/text-to-speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice, language }),
    });
  }
}

export const aiClient = new AIClient();
