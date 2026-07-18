import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import type { ChatMessage } from "../types";
import { PennyChat } from "./PennyChat";


const messages: ChatMessage[] = [
  {
    id: 41,
    from: "me",
    text: "I had pain four out of ten.",
    createdAt: "2026-07-18T09:00:00Z",
  },
  {
    id: 42,
    from: "penny",
    text: "I created an editable journal record.",
    createdAt: "2026-07-18T09:00:01Z",
    category: "recorded fact",
  },
];


type RenderOptions = {
  chatMessages?: ChatMessage[];
  onSend?: (text: string) => Promise<boolean>;
  onCorrectMessage?: (id: number, text: string) => Promise<boolean>;
  onDeleteMessage?: (id: number) => Promise<boolean>;
};


function renderChat({
  chatMessages = messages,
  onSend = vi.fn(async () => true),
  onCorrectMessage = vi.fn(async () => true),
  onDeleteMessage = vi.fn(async () => true),
}: RenderOptions = {}) {
  const notify = vi.fn();
  render(
    <PennyChat
      messages={chatMessages}
      suggestions={[]}
      suggestionsNote="No automatic action."
      timeZone="Europe/London"
      trackingEnabled
      journalInferenceEnabled
      onSend={onSend}
      onCorrectMessage={onCorrectMessage}
      onDeleteMessage={onDeleteMessage}
      onSuggestion={vi.fn()}
      onSourceTarget={vi.fn()}
      notify={notify}
    />,
  );
  return { notify, onSend, onCorrectMessage, onDeleteMessage };
}


test("lets the patient review and save a correction to their own message", async () => {
  const { notify, onCorrectMessage } = renderChat();
  const patientMessage = document.getElementById("message-41");
  expect(patientMessage).not.toBeNull();
  fireEvent.click(within(patientMessage as HTMLElement).getByRole("button", { name: "Correct" }));
  const editor = within(patientMessage as HTMLElement).getByRole("textbox", {
    name: "Correct your message",
  });
  fireEvent.change(editor, { target: { value: "I had pain two out of ten." } });
  fireEvent.click(within(patientMessage as HTMLElement).getByRole("button", {
    name: "Save correction",
  }));

  await waitFor(() => expect(onCorrectMessage).toHaveBeenCalledWith(
    41,
    "I had pain two out of ten.",
  ));
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("PMH proposals"));
  await waitFor(() => expect(within(patientMessage as HTMLElement).getByRole("button", {
    name: "Correct",
  })).toHaveFocus());
});


test("shows each message's real patient-local timestamp instead of a hardcoded today label", () => {
  renderChat();

  expect(within(document.getElementById("message-41") as HTMLElement).getByText("18 Jul 2026 · 10:00"))
    .toHaveAttribute("datetime", "2026-07-18T09:00:00Z");
  expect(screen.queryByText("TODAY 08:12")).not.toBeInTheDocument();
});


test("aligns the start of the newest reply inside the thread instead of scrolling to its end", () => {
  const originalScrollTo = HTMLElement.prototype.scrollTo;
  const scrollTo = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scrollTo });
  const rect = (top: number) => ({
    x: 0, y: top, top, bottom: top + 50, left: 0, right: 100, width: 100, height: 50,
    toJSON: () => ({}),
  }) as DOMRect;
  const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("thread")) return rect(100);
    if (this.id === "message-42") return rect(460);
    return rect(0);
  });

  try {
    renderChat();
    const thread = screen.getByRole("log", { name: "Conversation with Penny" });
    expect(scrollTo).toHaveBeenCalledWith({ top: 348, behavior: "auto" });
    expect(scrollTo.mock.instances[0]).toBe(thread);
  } finally {
    rectSpy.mockRestore();
    if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: originalScrollTo });
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  }
});


test("returns focus to Correct after cancelling with the button or Escape", async () => {
  renderChat();
  const patientMessage = document.getElementById("message-41") as HTMLElement;

  fireEvent.click(within(patientMessage).getByRole("button", { name: "Correct" }));
  fireEvent.click(within(patientMessage).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(within(patientMessage).getByRole("button", { name: "Correct" })).toHaveFocus());

  fireEvent.click(within(patientMessage).getByRole("button", { name: "Correct" }));
  const editor = within(patientMessage).getByRole("textbox", { name: "Correct your message" });
  fireEvent.keyDown(editor, { key: "Escape" });
  await waitFor(() => expect(within(patientMessage).getByRole("button", { name: "Correct" })).toHaveFocus());
});


test("keeps the composer focusable and announces progress while a send is pending", async () => {
  let resolveSend: (saved: boolean) => void = () => undefined;
  const onSend = vi.fn(() => new Promise<boolean>((resolve) => { resolveSend = resolve; }));
  renderChat({ onSend });
  const composer = screen.getByRole("textbox", { name: "Message Penny" });
  const form = composer.closest("form");

  fireEvent.change(composer, { target: { value: "Please log this carefully" } });
  composer.focus();
  fireEvent.submit(form!);

  expect(form).toHaveAttribute("aria-busy", "true");
  expect(composer).toHaveFocus();
  expect(composer).not.toBeDisabled();
  expect(composer).toHaveAttribute("readonly");
  expect(screen.getByRole("button", { name: "Sending message…" })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("Sending message…");
  for (const chip of within(screen.getByLabelText("Quick messages")).getAllByRole("button")) {
    expect(chip).toBeDisabled();
    expect(chip).toHaveAccessibleName(/Sending message…/);
  }

  resolveSend(true);
  await waitFor(() => expect(form).toHaveAttribute("aria-busy", "false"));
  expect(composer).not.toHaveAttribute("readonly");
  expect(composer).toHaveValue("");
});


test("preserves draft text and clears busy state when sending rejects", async () => {
  const onSend = vi.fn(async () => { throw new Error("network unavailable"); });
  const { notify } = renderChat({ onSend });
  const composer = screen.getByRole("textbox", { name: "Message Penny" });
  const form = composer.closest("form");

  fireEvent.change(composer, { target: { value: "Do not lose this draft" } });
  fireEvent.submit(form!);

  await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining("still here")));
  expect(form).toHaveAttribute("aria-busy", "false");
  expect(composer).toHaveValue("Do not lose this draft");
  expect(composer).not.toHaveAttribute("readonly");
  expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
});


test("requires confirmation before deleting an individual Penny reply", async () => {
  const { onDeleteMessage } = renderChat();
  const pennyReply = document.getElementById("message-42");
  expect(pennyReply).not.toBeNull();
  fireEvent.click(within(pennyReply as HTMLElement).getByRole("button", {
    name: "Delete reply",
  }));

  const dialog = screen.getByRole("alertdialog", { name: "Delete this Penny reply?" });
  expect(within(dialog).getByText(/Linked journal records/)).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", {
    name: "Delete conversation record",
  }));
  await waitFor(() => expect(onDeleteMessage).toHaveBeenCalledWith(42));
  await waitFor(() => expect(screen.getByRole("button", { name: "Correct" })).toHaveFocus());
});


test("moves focus to the composer when deletion leaves no adjacent message", async () => {
  const onDeleteMessage = vi.fn(async (_id: number) => true);

  function DeletionHarness() {
    const [chatMessages, setChatMessages] = useState([messages[1]]);
    return <PennyChat
      messages={chatMessages}
      suggestions={[]}
      suggestionsNote="No automatic action."
      timeZone="Europe/London"
      trackingEnabled
      journalInferenceEnabled
      onSend={vi.fn(async () => true)}
      onCorrectMessage={vi.fn(async () => true)}
      onDeleteMessage={async (id) => {
        const deleted = await onDeleteMessage(id);
        if (deleted) setChatMessages((current) => current.filter((message) => message.id !== id));
        return deleted;
      }}
      onSuggestion={vi.fn()}
      onSourceTarget={vi.fn()}
      notify={vi.fn()}
    />;
  }

  render(<DeletionHarness />);
  fireEvent.click(screen.getByRole("button", { name: "Delete reply" }));
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", {
    name: "Delete conversation record",
  }));

  await waitFor(() => expect(screen.getByRole("textbox", { name: "Message Penny" })).toHaveFocus());
});
