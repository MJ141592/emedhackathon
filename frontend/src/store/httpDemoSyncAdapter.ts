import type { DemoState, JournalEntry, PrivacySettings, Profile, SupporterView } from "../types";
import type { DemoSyncAdapter } from "./demoRepository";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const DEMO_URL = "/api/demo";

async function responseError(response: Response, action: string): Promise<Error> {
  let detail = "";
  try {
    detail = await response.text();
  } catch {
    // The status still provides a useful error when the response body is unavailable.
  }
  return new Error(
    `${action} failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""})${detail ? `: ${detail}` : ""}`,
  );
}

function cloneState(state: DemoState): DemoState {
  return JSON.parse(JSON.stringify(state)) as DemoState;
}

/**
 * Creates the persisted-demo adapter used by the browser store.
 *
 * Every mutation shares one queue, so rapid React updates cannot arrive at the
 * aggregate out of order. The API's ETag is carried into each complete-snapshot
 * replacement. A conflict is surfaced for explicit reconciliation: retrying an
 * old complete snapshot after silently fetching a newer ETag could overwrite a
 * concurrent change made in another tab or client.
 */
export function createHttpDemoSyncAdapter(fetcher: Fetcher = fetch): DemoSyncAdapter {
  let etag: string | null = null;
  let mutationQueue: Promise<void> = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function rememberEtag(response: Response): void {
    const nextEtag = response.headers.get("ETag");
    if (!nextEtag) throw new Error("The persisted demo response did not include an ETag.");
    etag = nextEtag;
  }

  async function readRemote(): Promise<DemoState> {
    const response = await fetcher(DEMO_URL, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw await responseError(response, "Loading the persisted demo");
    rememberEtag(response);
    return (await response.json()) as DemoState;
  }

  async function putSnapshot(snapshot: DemoState): Promise<Response> {
    if (!etag) await readRemote();
    return fetcher(DEMO_URL, {
      method: "PUT",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "If-Match": etag!,
      },
      body: JSON.stringify(snapshot),
    });
  }

  return {
    hydrate(_localState) {
      return enqueue(readRemote);
    },

    sync(state) {
      const snapshot = cloneState(state);
      return enqueue(async () => {
        const response = await putSnapshot(snapshot);
        if (!response.ok) throw await responseError(response, "Saving the persisted demo");
        rememberEtag(response);
        // Return the accepted aggregate because server-authored clocks and provenance may
        // intentionally differ from the browser's requested snapshot.
        return (await response.json()) as DemoState;
      });
    },

    sendChat(text) {
      return enqueue(async () => {
        const response = await fetcher("/api/chat", {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!response.ok) throw await responseError(response, "Saving the patient message");
        await response.arrayBuffer();
        return readRemote();
      });
    },

    addJournal(draft) {
      return enqueue(async () => {
        const response = await fetcher("/api/journal", {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(draft),
        });
        if (!response.ok) throw await responseError(response, "Saving the journal entry");
        const entry = (await response.json()) as JournalEntry;
        return { state: await readRemote(), entry };
      });
    },

    updateJournal(id, patch) {
      const body = {
        ...patch,
        ...(Object.prototype.hasOwnProperty.call(patch, "photo") && patch.photo === undefined
          ? { photo: null }
          : {}),
      };
      const serialized = JSON.stringify(body);
      return enqueue(async () => {
        const response = await fetcher(`/api/journal/${id}`, {
          method: "PATCH",
          // Browser keepalive bodies are capped. Media deletion is tiny and gets unload
          // protection; observation edits that carry an existing data URL use normal fetch.
          keepalive: serialized.length < 60_000,
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: serialized,
        });
        if (!response.ok) throw await responseError(response, "Correcting the journal entry");
        await response.arrayBuffer();
        return readRemote();
      });
    },

    deleteJournal(id) {
      return enqueue(async () => {
        const response = await fetcher(`/api/journal/${id}`, {
          method: "DELETE",
          keepalive: true,
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw await responseError(response, "Deleting the journal entry");
        await response.arrayBuffer();
        return readRemote();
      });
    },

    withdrawHealthConsent(patch: Partial<Profile>) {
      return enqueue(async () => {
        const response = await fetcher("/api/profile", {
          method: "PATCH",
          keepalive: true,
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!response.ok) throw await responseError(response, "Updating the patient profile");
        await response.arrayBuffer();
        return readRemote();
      });
    },

    updatePrivacy(patch: Partial<PrivacySettings>) {
      return enqueue(async () => {
        const response = await fetcher("/api/privacy", {
          method: "PATCH",
          keepalive: true,
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!response.ok) throw await responseError(response, "Updating privacy controls");
        await response.arrayBuffer();
        return readRemote();
      });
    },

    acknowledgeSafetyAlert() {
      return enqueue(async () => {
        const response = await fetcher("/api/safety/alert", {
          method: "DELETE",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw await responseError(response, "Acknowledging the safety guidance");
        await response.arrayBuffer();
        return readRemote();
      });
    },

    reset() {
      return enqueue(async () => {
        const response = await fetcher(`${DEMO_URL}/reset`, {
          method: "POST",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw await responseError(response, "Resetting the persisted demo");
        rememberEtag(response);
        await response.arrayBuffer();
      });
    },

    deleteAll() {
      return enqueue(async () => {
        const response = await fetcher("/api/data", {
          method: "DELETE",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw await responseError(response, "Deleting persisted patient data");

        // DELETE returns the cleared state, while GET is the revision-bearing read.
        await readRemote();
      });
    },

    importClinicalPlan() {
      return enqueue(async () => {
        const response = await fetcher("/api/care/simulate-plan-import", {
          method: "POST",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw await responseError(response, "Importing the simulated clinician plan");
        rememberEtag(response);
        return (await response.json()) as DemoState;
      });
    },

    createSupporterInvitation() {
      return enqueue(async () => {
        const response = await fetcher("/api/trusted-supporter/invitation", {
          method: "POST",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw await responseError(response, "Creating the supporter demo code");
        rememberEtag(response);
        await response.arrayBuffer();
        return readRemote();
      });
    },

    revokeSupporterInvitation() {
      return enqueue(async () => {
        const response = await fetcher("/api/trusted-supporter/invitation", {
          method: "DELETE",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw await responseError(response, "Revoking the supporter demo code");
        rememberEtag(response);
        await response.arrayBuffer();
        return readRemote();
      });
    },

    supporterView(accessCode: string) {
      return enqueue(async () => {
        const response = await fetcher("/api/trusted-supporter/access", {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ accessCode }),
        });
        if (!response.ok) throw await responseError(response, "Opening the supporter demo view");
        return (await response.json()) as SupporterView;
      });
    },

    supporterLog(accessCode: string, text: string) {
      return enqueue(async () => {
        const response = await fetcher("/api/trusted-supporter/log", {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ accessCode, text }),
        });
        if (!response.ok) throw await responseError(response, "Saving the supporter reviewable log");
        rememberEtag(response);
        const result = (await response.json()) as { view: SupporterView };
        return { state: await readRemote(), view: result.view };
      });
    },

    correctChatMessage(id: number, text: string) {
      return enqueue(async () => {
        const response = await fetcher(`/api/chat/${id}`, {
          method: "PATCH",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!response.ok) throw await responseError(response, "Correcting the conversation message");
        rememberEtag(response);
        await response.arrayBuffer();
        return readRemote();
      });
    },

    deleteChatMessage(id: number) {
      return enqueue(async () => {
        const response = await fetcher(`/api/chat/${id}`, {
          method: "DELETE",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw await responseError(response, "Deleting the conversation message");
        rememberEtag(response);
        await response.arrayBuffer();
        return readRemote();
      });
    },
  };
}

export const httpDemoSyncAdapter = createHttpDemoSyncAdapter();
