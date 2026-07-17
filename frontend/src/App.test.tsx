import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import App from "./App";

test("renders the MeMed dashboard with Penny and the journal", () => {
  render(<App />);

  expect(screen.getByText("MeMed")).toBeInTheDocument();
  expect(screen.getByText("Good morning, Amara")).toBeInTheDocument();
  expect(screen.getByText("Penny")).toBeInTheDocument();
  expect(screen.getByText("Journal")).toBeInTheDocument();
});

test("switching the demo state updates the flare summary", () => {
  render(<App />);

  fireEvent.click(screen.getByRole("button", { name: "Recovery" }));
  expect(screen.getByText("Recovering — taper day 12 of 42")).toBeInTheDocument();
});

test("a chat message is parsed into a journal entry", () => {
  render(<App />);

  fireEvent.click(screen.getByRole("button", { name: "Porridge and a coffee for breakfast" }));
  expect(screen.getByText(/Logged the meal in your journal/)).toBeInTheDocument();
});
