import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import App from "./App";

afterEach(() => {
  vi.restoreAllMocks();
});

test("shows the backend health status", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ status: "healthy", service: "eMed API" })),
  );

  render(<App />);

  expect(await screen.findByText("eMed API is healthy")).toBeInTheDocument();
});

