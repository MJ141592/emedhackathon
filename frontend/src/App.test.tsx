import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import App from "./App";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("shows the Runware AI workspace", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ configured: true, models: {} })),
  );

  render(<App />);

  expect(await screen.findByText("Runware ready")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Conversation" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Voice note" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Photo log" })).toBeInTheDocument();
});

test("sends a chat message through the backend", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/status")) {
      return new Response(JSON.stringify({ configured: true, models: {} }));
    }
    return new Response(JSON.stringify({ text: "Recorded.", model: "test-model" }));
  });

  render(<App />);
  const input = await screen.findByPlaceholderText("Message eMed");
  fireEvent.change(input, { target: { value: "I felt better today" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));

  expect(await screen.findByText("Recorded.")).toBeInTheDocument();
});
