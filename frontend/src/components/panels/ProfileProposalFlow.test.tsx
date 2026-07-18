import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import App from "../../App";
import { INITIAL_STATE } from "../../data";
import { DemoStoreProvider } from "../../store/DemoStore";

function renderApp() {
  return render(<DemoStoreProvider initialState={structuredClone(INITIAL_STATE)}><App /></DemoStoreProvider>);
}

function openProfile() {
  fireEvent.click(screen.getAllByRole("button", { name: "Profile" })[0]);
  return screen.getByRole("dialog", { name: "Profile & past medical history" });
}

test("chat history wording remains a pending proposal until the patient accepts it", async () => {
  renderApp();
  fireEvent.change(screen.getByRole("textbox", { name: "Message Penny" }), {
    target: { value: "I'm allergic to sulfasalazine" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(await screen.findByText(/nothing has been added to your PMH/i)).toBeInTheDocument();

  const profile = openProfile();
  const proposal = within(profile).getByLabelText("Conversation-derived PMH proposals");
  expect(within(proposal).getByText("Allergies and intolerances")).toBeInTheDocument();
  expect(within(proposal).getByText("sulfasalazine")).toBeInTheDocument();
  const allergyField = within(profile).getByRole("textbox", { name: "Allergies and intolerances" });
  expect((allergyField as HTMLTextAreaElement).value).not.toContain("sulfasalazine");

  fireEvent.click(within(proposal).getByRole("button", { name: "Accept and save" }));
  expect((allergyField as HTMLTextAreaElement).value).toContain("sulfasalazine");
  expect(within(proposal).getByText("Accepted into profile")).toBeInTheDocument();
});

test("dismissing a conversation proposal leaves the profile unchanged", async () => {
  renderApp();
  fireEvent.change(screen.getByRole("textbox", { name: "Message Penny" }), {
    target: { value: "I was diagnosed with coeliac disease" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));

  await screen.findByText(/nothing has been added to your PMH/i);

  const profile = openProfile();
  const proposal = within(profile).getByLabelText("Conversation-derived PMH proposals");
  const conditions = within(profile).getByRole("textbox", { name: "Other significant conditions" });
  expect((conditions as HTMLTextAreaElement).value).not.toContain("coeliac disease");
  fireEvent.click(within(proposal).getByRole("button", { name: "Dismiss" }));
  expect((conditions as HTMLTextAreaElement).value).not.toContain("coeliac disease");
  expect(within(proposal).getByText("Dismissed — profile unchanged")).toBeInTheDocument();
});
