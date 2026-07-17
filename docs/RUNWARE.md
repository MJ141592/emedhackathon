# Runware AI integration

The application keeps Runware behind the Python API. The browser never receives the Runware API key and only calls application-specific endpoints.

## Capabilities and models

| Capability | Default model | Runware task |
| --- | --- | --- |
| Chat | `google:gemini@3.1-flash-lite` | `textInference` |
| Image to text | `google:gemini@3.1-flash-lite` | `textInference` with `inputs.images` |
| Speech to text | `google:gemini@3.1-flash-lite` | `textInference` with `inputs.audios` |
| Text to speech | `xai:tts@0` | `audioInference` with `speech` |

Runware's audio-generation API currently focuses on generation and does not expose a dedicated transcription task. The selected Gemini model accepts audio through Runware's multimodal text-inference task, so it provides the prototype transcription path as well as image understanding.

The model AIR identifiers are environment-configurable. This keeps the application services stable as models change.

## Configuration

Create an API key in Runware, then create the local environment file before starting the development server:

```sh
cp .env.example .env
# Set RUNWARE_API_KEY in .env
npm run dev
```

To use different models, copy the relevant values from `.env.example` into the shell environment. These variables are read only by the backend:

- `RUNWARE_CHAT_MODEL`
- `RUNWARE_VISION_MODEL`
- `RUNWARE_TRANSCRIPTION_MODEL`
- `RUNWARE_SPEECH_MODEL`

Do not put `RUNWARE_API_KEY` in a `VITE_` variable or frontend source file. Vite exposes those values to the browser.

## Backend design

`backend/app/ai/gateway.py` owns the Runware SDK connection, request validation, timeout, and provider error translation. The application-facing classes live in `backend/app/ai/services.py`:

- `ChatService`
- `ImageToTextService`
- `SpeechToTextService`
- `TextToSpeechService`

FastAPI routes in `backend/app/ai/routes.py` handle HTTP validation, media-size limits, and response schemas. Service prompts enforce the current prototype boundaries, including neutral meal logging without calorie or diet scoring.

## HTTP endpoints

| Method | Endpoint | Input |
| --- | --- | --- |
| `GET` | `/api/ai/status` | None |
| `POST` | `/api/ai/chat` | JSON conversation messages |
| `POST` | `/api/ai/image-to-text` | Multipart image, purpose, and optional note |
| `POST` | `/api/ai/speech-to-text` | Multipart audio |
| `POST` | `/api/ai/text-to-speech` | JSON text, voice, and language |

The status endpoint reports whether a key is configured and which model identifiers are active. It never returns the key.

## Current limitations

- This is a prototype; conversations and media are not persisted as patient records.
- Chat context comes from messages supplied in the current browser session. A consented patient-data retrieval layer is still required for full-context chat.
- Runware receives uploaded media for inference. Retention, consent, regional processing, and data-processing terms must be resolved before handling real patient data.
- Model output is not a diagnosis or medication instruction. Consequential clinical workflows require deterministic safeguards and clinical governance outside the model.

## Official documentation

- [Runware Python SDK](https://runware.ai/docs/platform/python)
- [Runware platform introduction](https://runware.ai/docs/platform/introduction)
- [Gemini 3.1 Flash Lite](https://runware.ai/docs/models/google-gemini-3-1-flash-lite)
- [xAI Text-to-Speech examples](https://runware.ai/docs/models/xai-tts/examples)
- [Runware audio generation API](https://runware.ai/audio-generation-api)
