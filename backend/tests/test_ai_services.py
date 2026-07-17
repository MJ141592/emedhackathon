import asyncio
from typing import Any

import pytest

from app.ai.config import RunwareSettings
from app.ai.errors import AIConfigurationError, AIResponseError
from app.ai.gateway import RunwareGateway
from app.ai.schemas import ChatMessage
from app.ai.services import (
    ChatService,
    ImageToTextService,
    SpeechToTextService,
    TextToSpeechService,
)


class FakeGateway:
    def __init__(self, response: dict[str, Any]) -> None:
        self.response = response
        self.payload: dict[str, Any] | None = None

    async def run(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.payload = payload
        return self.response


def test_chat_sends_conversation_and_safety_prompt() -> None:
    gateway = FakeGateway({"text": "Here is a concise answer."})
    service = ChatService(gateway, "chat-model")

    reply = asyncio.run(service.reply([ChatMessage(role="user", content="Summarise today")]))

    assert reply == "Here is a concise answer."
    assert gateway.payload is not None
    assert gateway.payload["model"] == "chat-model"
    assert gateway.payload["messages"] == [{"role": "user", "content": "Summarise today"}]
    assert "Do not diagnose" in gateway.payload["settings"]["systemPrompt"]


def test_meal_image_prompt_prohibits_calorie_feedback() -> None:
    gateway = FakeGateway({"text": "Pasta with tomato sauce; basil may be present."})
    service = ImageToTextService(gateway, "vision-model")

    result = asyncio.run(service.describe("data:image/jpeg;base64,abc", "meal_log"))

    assert result.startswith("Pasta")
    assert gateway.payload is not None
    prompt = gateway.payload["messages"][0]["content"]
    assert "Do not estimate or mention calories" in prompt
    assert gateway.payload["inputs"]["images"] == ["data:image/jpeg;base64,abc"]


def test_speech_to_text_uses_audio_input() -> None:
    gateway = FakeGateway({"text": "I felt better this morning."})
    service = SpeechToTextService(gateway, "transcription-model")

    result = asyncio.run(service.transcribe("YXVkaW8="))

    assert result == "I felt better this morning."
    assert gateway.payload is not None
    assert gateway.payload["inputs"]["audios"] == ["YXVkaW8="]


def test_text_to_speech_returns_audio_url() -> None:
    gateway = FakeGateway({"audioURL": "https://example.test/speech.mp3"})
    service = TextToSpeechService(gateway, "speech-model")

    result = asyncio.run(service.synthesize("Your check-in is ready.", "eve", "en"))

    assert result == "https://example.test/speech.mp3"
    assert gateway.payload is not None
    assert gateway.payload["speech"]["voice"] == "eve"


def test_empty_provider_text_is_rejected() -> None:
    gateway = FakeGateway({"text": "  "})
    service = ChatService(gateway, "chat-model")

    with pytest.raises(AIResponseError):
        asyncio.run(service.reply([ChatMessage(role="user", content="Hello")]))


def test_gateway_requires_server_side_api_key() -> None:
    gateway = RunwareGateway(api_key=None)

    with pytest.raises(AIConfigurationError):
        asyncio.run(gateway.run({"taskType": "textInference", "model": "example"}))


def test_default_models_are_runware_air_identifiers() -> None:
    settings = RunwareSettings.from_environment()

    assert settings.chat_model == "google:gemini@3.1-flash-lite"
    assert settings.vision_model == "google:gemini@3.1-flash-lite"
    assert settings.transcription_model == "google:gemini@3.1-flash-lite"
    assert settings.speech_model == "xai:tts@0"

