# eMed Hackathon

Full-stack monorepo with a React/TypeScript frontend and a FastAPI/Python backend.

See the [high-level product plan](docs/PRODUCT_PLAN.md) for the proposed IBD companion experience and delivery phases, and [Effortless Tracking, Patient Context, and the Background Health Agent](docs/EFFORTLESS_TRACKING_AND_BACKGROUND_AGENT.md) for the low-effort capture, patient-context, and background-agent design.

## Prerequisites

- Node.js 22+
- Python 3.9+
- [uv](https://docs.astral.sh/uv/)

## Setup

```sh
npm install
uv sync --project backend
```

## Development

Start both applications:

```sh
npm run dev
```

- Frontend: <http://localhost:5173>
- Backend API: <http://localhost:8000>
- API documentation: <http://localhost:8000/docs>

Override the ports with `FRONTEND_PORT` and `BACKEND_PORT`.

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
