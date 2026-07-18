import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

import { PennyChat } from "./PennyChat";

const aiMocks = vi.hoisted(() => ({
  status: vi.fn(),
  transcribe: vi.fn(),
}));

vi.mock("../api", () => ({
  aiClient: {
    status: aiMocks.status,
    transcribe: aiMocks.transcribe,
  },
}));

vi.mock("../useAudioRecorder", () => ({
  useAudioRecorder: () => ({
    state: "ready",
    audio: new Blob(["recording"], { type: "audio/webm" }),
    previewUrl: null,
    error: null,
    start: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
  }),
}));

function renderVoiceReview() {
  const notify = vi.fn();
  const onSend = vi.fn(async () => true);
  render(
    <PennyChat
      messages={[]}
      suggestions={[]}
      suggestionsNote="No automatic action."
      timeZone="Europe/London"
      trackingEnabled
      journalInferenceEnabled
      onSend={onSend}
      onCorrectMessage={vi.fn(async () => true)}
      onDeleteMessage={vi.fn(async () => true)}
      onSuggestion={vi.fn()}
      onSourceTarget={vi.fn()}
      notify={notify}
    />,
  );
  return { notify, onSend };
}

beforeEach(() => {
  aiMocks.status.mockReset();
  aiMocks.transcribe.mockReset();
});

test("a configured provider failure cannot become a confirmable placeholder health record", async () => {
  aiMocks.status.mockResolvedValue({ configured: true, models: {} });
  aiMocks.transcribe.mockRejectedValue(new Error("provider unavailable"));
  const { notify, onSend } = renderVoiceReview();

  fireEvent.click(screen.getByRole("button", { name: "Transcribe and review" }));

  const transcript = await screen.findByRole("textbox", {
    name: "Review voice transcript before logging",
  });
  expect(transcript).toHaveValue("");
  expect(screen.getByRole("button", { name: "Confirm transcript" })).toBeDisabled();
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("could not be completed"));
  expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("isn’t configured"));
  expect(onSend).not.toHaveBeenCalled();

  fireEvent.change(transcript, { target: { value: "I felt tired after lunch." } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm transcript" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledWith("I felt tired after lunch."));
});

test("an unconfigured provider is reported accurately and leaves manual wording empty", async () => {
  aiMocks.status.mockResolvedValue({ configured: false, models: {} });
  const { notify } = renderVoiceReview();

  fireEvent.click(screen.getByRole("button", { name: "Transcribe and review" }));

  expect(await screen.findByRole("textbox", {
    name: "Review voice transcript before logging",
  })).toHaveValue("");
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("isn’t configured"));
  expect(aiMocks.transcribe).not.toHaveBeenCalled();
});
