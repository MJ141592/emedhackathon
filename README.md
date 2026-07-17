# eMed Hackathon

Full-stack monorepo with a React/TypeScript frontend and a FastAPI/Python backend.

See the [high-level product plan](docs/PRODUCT_PLAN.md) for the proposed IBD companion experience and delivery phases.

## Prerequisites

- Node.js 22+
- Python 3.11+
- [uv](https://docs.astral.sh/uv/)

## Setup

```sh
npm install
uv sync --project backend
cp .env.example .env
```

Add a Runware API key to `.env` before using the AI tools.

## Development

Start both applications:

```sh
npm run dev
```

- Frontend: <http://localhost:5173>
- Backend API: <http://localhost:8000>
- API documentation: <http://localhost:8000/docs>

Override the ports with `FRONTEND_PORT` and `BACKEND_PORT`.

The browser includes basic Runware-backed chat, speech-to-text, image-to-text, and text-to-speech tools. See [Runware integration](docs/RUNWARE.md) for model choices, environment overrides, API endpoints, and current limitations.

## Checks

```sh
npm run check
npm test
npm run build
```

## Layout

```text
frontend/  React, TypeScript, and Vite
backend/   FastAPI application and Python tests
```
