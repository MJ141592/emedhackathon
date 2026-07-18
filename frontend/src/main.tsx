import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { DemoStoreProvider } from "./store/DemoStore";
import { configureDemoSyncAdapter } from "./store/demoRepository";
import { httpDemoSyncAdapter } from "./store/httpDemoSyncAdapter";
import { registerPersistentReminders } from "./store/persistentNotifications";

configureDemoSyncAdapter(httpDemoSyncAdapter);
// Ask for periodic background execution where the installed browser already permits it. This
// does not request notification permission; unsupported browsers retain page-time execution.
void registerPersistentReminders(true);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DemoStoreProvider><App /></DemoStoreProvider>
  </StrictMode>,
);
