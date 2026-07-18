from pathlib import Path
from tempfile import TemporaryDirectory
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
from app.domain.store import SQLiteDemoStore, get_demo_store
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


_test_directory = TemporaryDirectory()
_test_store = SQLiteDemoStore(Path(_test_directory.name) / "ai-routes.sqlite3")
client = TestClient(app)


def setup_module() -> None:
    app.dependency_overrides[get_ai_services] = fake_services
    app.dependency_overrides[get_demo_store] = lambda: _test_store


def teardown_module() -> None:
    client.close()
    app.dependency_overrides.clear()
    _test_directory.cleanup()


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


def test_image_endpoint_accepts_optional_toilet_photo_purpose() -> None:
    denied = client.post(
        "/api/ai/image-to-text",
        data={"purpose": "toilet_log"},
        files={"image": ("capture.jpg", b"image-data", "image/jpeg")},
    )
    assert denied.status_code == 403

    assert client.patch("/api/privacy", json={"toiletPhotoConsent": True}).status_code == 200
    response = client.post(
        "/api/ai/image-to-text",
        data={"purpose": "toilet_log"},
        files={"image": ("capture.jpg", b"image-data", "image/jpeg")},
    )

    assert response.status_code == 200


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


def test_inference_endpoints_honor_granular_assistant_permissions() -> None:
    assert client.patch(
        "/api/privacy",
        json={"assistantJournalAccess": False, "assistantConversationAccess": False},
    ).status_code == 200
    try:
        assert client.post(
            "/api/ai/chat", json={"messages": [{"role": "user", "content": "Hello"}]}
        ).status_code == 403
        assert client.post(
            "/api/ai/image-to-text",
            data={"purpose": "meal_log"},
            files={"image": ("meal.jpg", b"image-data", "image/jpeg")},
        ).status_code == 403
        assert client.post(
            "/api/ai/speech-to-text",
            files={"audio": ("note.webm", b"audio-data", "audio/webm")},
        ).status_code == 403
        # Spoken playback does not retrieve Journal or earlier-conversation context.
        assert client.post(
            "/api/ai/text-to-speech",
            json={"text": "Hello", "voice": "eve", "language": "en"},
        ).status_code == 200
    finally:
        restored = client.patch(
            "/api/privacy",
            json={"assistantJournalAccess": True, "assistantConversationAccess": True},
        )
        assert restored.status_code == 200


def test_inference_endpoints_fail_closed_after_health_data_consent_withdrawal() -> None:
    revoked = client.patch(
        "/api/profile",
        json={"healthDataConsent": False, "onboardingComplete": False},
    )
    assert revoked.status_code == 200
    try:
        assert client.post(
            "/api/ai/chat", json={"messages": [{"role": "user", "content": "Hello"}]}
        ).status_code == 403
        assert client.post(
            "/api/ai/image-to-text",
            data={"purpose": "meal_log"},
            files={"image": ("meal.jpg", b"image-data", "image/jpeg")},
        ).status_code == 403
        assert client.post(
            "/api/ai/speech-to-text",
            files={"audio": ("note.webm", b"audio-data", "audio/webm")},
        ).status_code == 403
        assert client.post(
            "/api/ai/text-to-speech",
            json={"text": "Hello", "voice": "eve", "language": "en"},
        ).status_code == 403
    finally:
        restored = client.patch(
            "/api/profile",
            json={"healthDataConsent": True, "onboardingComplete": True},
        )
        assert restored.status_code == 200
