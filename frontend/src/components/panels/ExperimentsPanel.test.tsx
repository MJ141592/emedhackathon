import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { DemoStoreProvider } from "../../store/DemoStore";
import { freshDemoState } from "../../store/demoRepository";
import { ExperimentsPanel } from "./ExperimentsPanel";

describe("ranked diet experiment candidates", () => {
  test("shows competing scored choices and leaves baseline evidence for the patient", () => {
    const state = freshDemoState();
    state.phase = "stable";
    state.phaseConfirmed = true;
    state.pendingPhase = undefined;
    const notify = vi.fn();

    render(<DemoStoreProvider initialState={state}><ExperimentsPanel notify={notify} /></DemoStoreProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Create a new candidate" }));

    const ranking = screen.getByRole("list", { name: "Ranked low-burden candidates" });
    expect(within(ranking).getAllByRole("article").length).toBeGreaterThanOrEqual(3);
    expect(within(ranking).getAllByText(/Risk: (Low|Clinical review)/).length).toBeGreaterThanOrEqual(3);
    expect(within(ranking).getAllByText("Measurable").length).toBeGreaterThanOrEqual(3);

    fireEvent.click(within(ranking).getByRole("button", { name: "Choose Oat milk instead of dairy milk" }));
    expect(screen.getByRole("textbox", { name: "Candidate name" })).toHaveValue("Oat milk instead of dairy milk");
    expect(screen.getByRole("textbox", { name: "Pre-start baseline" })).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "Save candidate" }));
    expect(notify).toHaveBeenLastCalledWith(expect.stringMatching(/actual observation recorded before day 1/i));
  });
});
