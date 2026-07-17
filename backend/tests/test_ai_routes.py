from typing import Any

from fastapi.testclient import TestClient

from app.ai.config import RunwareSettings
from app.ai.dependencies import get_ai_services
from app.ai.gateway import InferenceGateway
from app.ai.services import (
    AIServices,
    ChatService,
    ImageToTextService,
    SpeechToTextService,
    TextToSpeechService,
)
from app.main import app


class FakeGateway(InferenceGateway):
    async def run(self, payload: dict[str, Any]) -> dict[str, Any]:
        if payload["taskType"] == "audioInference":
            return {"audioURL": "https://example.test/audio.mp3"}
        return {"text": "Generated text"}


def fake_services() -> AIServices:
    settings = RunwareSettings(api_key="configured")
    gateway = FakeGateway()
    return AIServices(
        settings=settings,
        chat=ChatService(gateway, settings.chat_model),
        image_to_text=ImageToTextService(gateway, settings.vision_model),
        speech_to_text=SpeechToTextService(gateway, settings.transcription_model),
        text_to_speech=TextToSpeechService(gateway, settings.speech_model),
    )


client = TestClient(app)


def setup_module() -> None:
    app.dependency_overrides[get_ai_services] = fake_services


def teardown_module() -> None:
    app.dependency_overrides.clear()


def test_ai_status_does_not_expose_credentials() -> None:
    response = client.get("/api/ai/status")

    assert response.status_code == 200
    assert response.json()["configured"] is True
    assert "api_key" not in response.json()


def test_chat_endpoint() -> None:
    response = client.post(
        "/api/ai/chat", json={"messages": [{"role": "user", "content": "Hello"}]}
    )

    assert response.status_code == 200
    assert response.json() == {
        "text": "Generated text",
        "model": "google:gemini@3.1-flash-lite",
    }


def test_image_endpoint_accepts_meal_photo() -> None:
    response = client.post(
        "/api/ai/image-to-text",
        data={"purpose": "meal_log"},
        files={"image": ("meal.jpg", b"image-data", "image/jpeg")},
    )

    assert response.status_code == 200
    assert response.json()["text"] == "Generated text"


def test_speech_endpoint_rejects_non_audio_upload() -> None:
    response = client.post(
        "/api/ai/speech-to-text",
        files={"audio": ("note.txt", b"not-audio", "text/plain")},
    )

    assert response.status_code == 415


def test_text_to_speech_endpoint() -> None:
    response = client.post(
        "/api/ai/text-to-speech",
        json={"text": "Hello", "voice": "eve", "language": "en"},
    )

    assert response.status_code == 200
    assert response.json()["audio_url"] == "https://example.test/audio.mp3"

