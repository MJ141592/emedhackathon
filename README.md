# Gutsy

Gutsy is a safety-first IBD companion demo. It combines low-effort symptom capture, a personal evidence ledger, an adaptive four-phase home screen, bounded support from Penny, and explicit patient-confirmed care workflows.

The seeded scenario follows Matthew Johnson on 17 July 2026 as several symptoms move away from his baseline. Every external action in the demo is simulated. Gutsy does not diagnose a flare, prescribe or change medicine, place a real order, message a real clinician, or replace a personal care plan.

## What is implemented

- Adult onboarding, profile, IBD baseline, past medical history, care contacts, trusted-supporter permissions, and patient-controlled context access.
- One correctable journal for bowel movements, food and hydration, meal and optional toilet photos, pain, fatigue, wellbeing, life events, medicines, wearable signals, and test results.
- Natural-language and voice-note capture. Missing fields remain unconfirmed instead of being invented.
- Steady, Watchful, Flare, and Recovery views with baseline comparisons, trends, source evidence, and patient-confirmed state changes.
- A deterministic red-flag screen outside the model path, plus an always-visible urgent-help route.
- Patient-confirmed calprotectin ordering and fulfilment simulation, editable clinician-message threads with unsent evening drafts, a clinician-owned prescription simulation, and a verified patient-local day-by-day steroid taper with discreet progressive reminders.
- Ranked, permission-aware one-variable diet experiment candidates that require a real pre-start baseline, pause while symptoms or treatment are changing, and gate nutritional risk for team review.
- Editable clinician and recovery summaries, JSON/text exports, audit history, data exclusion/correction, conversation deletion, full demo-data deletion, photo retention, wearable controls, and discreet notification settings.
- Optional Runware chat, image-to-text, transcription, and text-to-speech API adapters.

## Architecture

```text
React + TypeScript UI
        │
        ├── DemoStore ── live browser-session memory
        │       │
        │       └── sync adapter ── FastAPI domain API ── encrypted SQLite aggregate
        │                                  ├── deterministic safety/lifecycle rules
        │                                  └── audit revisions and workflow state
        │
        └── /api/ai ── FastAPI Runware gateway ── Runware models (optional)
```

The browser store keeps the interface responsive during the current session without placing the health aggregate in `localStorage`. The configured sync adapter hydrates the same versioned `DemoState` contract from FastAPI and persists encrypted mutations to SQLite. The default database is created under `backend/data/`, or can be moved with `EMED_DB_PATH`. Deployments should set `EMED_DATA_ENCRYPTION_KEY`; local development creates a mode-0600 key sidecar next to the database.

The backend groups routes around the demo aggregate, profile and journal, safety and lifecycle evaluation, care/test/team/prescription workflows, taper adherence, experiments, wearables, summaries, privacy, audit history, export/deletion, and optional AI services. Its live OpenAPI schema is available at <http://localhost:8000/docs>.

## Prerequisites

- Node.js 22+
- Python 3.11+
- [uv](https://docs.astral.sh/uv/)

## Setup

```sh
npm ci
uv sync --project backend --locked
cp .env.example .env
```

`RUNWARE_API_KEY` is optional. Leave it blank to run the complete deterministic demo without model inference.

Start the frontend and backend together:

```sh
npm run dev
```

- App: <http://localhost:5173>
- API: <http://localhost:8000>
- OpenAPI: <http://localhost:8000/docs>

Set `FRONTEND_PORT` or `BACKEND_PORT` to override the development ports. Set `EMED_DB_PATH` to use a different SQLite location.

## Demo walkthrough

The reset fixture opens in Watchful mode with Matthew's journal, baseline, wearable context, prepared test order, clinician-message draft, clinician-owned prescription pathway, paused oat-milk experiment, and a clinician-authored taper available for review. No taper dose is recorded as taken or missed.

1. Use the four **Demo** phase buttons to inspect how the home screen adapts. These buttons simulate state and never make a clinical determination.
2. Tell Penny, "Loose stool with urgency and a small amount of blood this morning." The structured record appears in the journal and can be edited, excluded, or deleted.
3. Open **Trends & evidence** to inspect the exact source records, correct them, confirm the governed Watchful support mode, and edit/export the clinician summary.
4. Open **Care** to review and confirm the prepared calprotectin order, advance its simulated fulfilment, edit and approve the team message, and inspect the prescriber-owned medicine flow.
5. Switch to **Flare** to see active red-flag support. Urgent wording such as heavy bleeding or faintness is intercepted by deterministic rules rather than conversational reassurance.
6. Follow the explicit simulated care chain: confirm the governed evidence, complete and share the home-test result, request prescriber review, simulate clinician approval and pharmacy readiness, then record collection. Collection anchors the unchanged 42-day schedule to that date and requires the patient to verify it again before any dose action appears.
7. A **Recovery** or **Steady** demo button changes presentation only. Dose actions require collected clinician-issued treatment (or evidence-confirmed Recovery), and an experiment requires an evidence-confirmed clean Stable baseline. Moving away from confirmed Stable pauses an experiment without losing progress.
8. Use **Profile** and **Privacy** to update context permissions, export the record, disconnect the simulated wearable, delete conversation history, or delete all demo data and return to onboarding.

Buttons that advance delivery, lab, clinician, pharmacy, wearable, or message status are labelled as simulations. They do not contact an external service.

## Runware-disabled behavior

Without a Runware key, `/api/ai/status` reports `configured: false` and inference endpoints return a structured service-unavailable response. The rest of Gutsy remains functional:

- typed capture, journal structuring, red-flag screening, evidence, trends, care workflows, taper support, experiments, persistence, privacy, and export are deterministic;
- a voice note can still be recorded and reviewed manually, but automatic transcription explains that Runware is unavailable;
- photos remain editable demo records (live session memory plus encrypted local-development SQLite) with unconfirmed placeholder observations. The optional **Describe with Runware** button checks configuration first; without a key it keeps the image inside Gutsy and never fabricates a model result;
- optional spoken Penny replies stay as written text and explain that Runware text-to-speech is unavailable;
- external care and fulfilment steps remain explicit simulations.

Model tests use fakes, so development and CI do not require a key or credits. See [Runware integration](docs/RUNWARE.md) for provider models, payload boundaries, and environment overrides.

## Safety and privacy boundary

This repository is a product demonstration, not a deployed clinical service or medical device.

- Consequential actions require patient confirmation; prescriptions and dose schedules require an authorised clinician.
- Deterministic red-flag rules are separate from Penny and model output. They route to the configured care plan, NHS 111, or 999/A&E rather than reassuring through chat.
- AI output and image observations cannot diagnose a flare, set urgency, order a test, send a message, or issue/change medicine.
- Recorded facts, possible patterns, and general information are labelled separately and linked to correctable source records.
- Names, clinical records, addresses, team details, and non-emergency contact numbers in the fixture are fictional demo data.
- Session memory and encrypted local SQLite persistence are for development only. Production use would still require authentication, managed keys, access control, retention enforcement, consent records, clinical governance, regulatory review, monitoring, and real provider integrations.

Do not enter real patient information into this demo.

## Checks and tests

Install the Playwright browser once on a development machine:

```sh
npm run test:e2e:install
```

Then use:

| Command | Purpose |
| --- | --- |
| `npm run check` | TypeScript checking, Ruff, and backend checks |
| `npm test` | Frontend unit/component tests and backend API/domain tests |
| `npm run build` | Production frontend build |
| `npm run test:e2e` | Chromium critical-journey tests; starts both servers |
| `npm run test:e2e:ui` | Interactive Playwright runner |
| `npm run test:all` | Unit/API tests followed by end-to-end tests |

The end-to-end suite resets both server and browser state before each journey. It covers all four phases, natural-language capture and correction, urgent help, calprotectin confirmation, clinician-message approval, taper dose confirmation, experiment pausing, export/deletion, and onboarding. Set `PLAYWRIGHT_BASE_URL` to test an already-running deployment instead of starting local servers.

GitHub Actions installs Node, Python/uv, Chromium, and all dependencies, then runs static checks, unit/API tests, the production build, and Playwright. Failed-run traces, screenshots, video, and the HTML report are uploaded as an artifact.

## Repository layout

```text
frontend/             React, TypeScript, Vite, and Vitest
backend/              FastAPI, SQLite domain services, Runware adapters, and Pytest
e2e/                  Playwright critical-journey tests
.github/workflows/    Continuous integration
docs/                 Product, journey, UI, and provider plans
```
