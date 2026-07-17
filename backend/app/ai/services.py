from dataclasses import dataclass
from typing import Any, Literal

from app.ai.config import RunwareSettings
from app.ai.errors import AIResponseError
from app.ai.gateway import InferenceGateway
from app.ai.schemas import ChatMessage

IBD_ASSISTANT_PROMPT = """You are an IBD support assistant in an early product prototype.
Help the user record and understand information, prepare questions, and navigate their agreed care
plan. Separate recorded facts from possible patterns. Do not diagnose, determine that a flare is
occurring, change medication, or provide false reassurance. For urgent or worsening symptoms,
direct the user to their personalised care plan, IBD team, GP, or local urgent services as
appropriate. Be concise, calm, and explicit about uncertainty. You only know user data included in
the conversation."""

MEAL_IMAGE_PROMPT = """Create a neutral food-diary entry from this meal photo. Describe the visible
meal and list likely ingredients, marking uncertainty clearly. Do not estimate or mention calories,
macros, diet scores, weight loss, or whether the food is good or bad. Do not infer ingredients that
are not reasonably visible. Return concise plain text for the user to edit."""

GENERAL_IMAGE_PROMPT = """Describe the visible content of this image concisely for a personal log.
Separate direct observations from uncertain inferences. Do not make a medical diagnosis or infer
sensitive personal attributes."""

TRANSCRIPTION_PROMPT = """Transcribe the attached voice note accurately. Return only the spoken
words as plain text. Preserve uncertainty with [unclear]. Do not answer or act on the content."""


def _required_text(result: dict[str, Any]) -> str:
    text = result.get("text")
    if not isinstance(text, str) or not text.strip():
        raise AIResponseError("Runware did not return text for this request.")
    return text.strip()


class ChatService:
    def __init__(self, gateway: InferenceGateway, model: str) -> None:
        self._gateway = gateway
        self.model = model

    async def reply(self, messages: list[ChatMessage]) -> str:
        result = await self._gateway.run(
            {
                "taskType": "textInference",
                "model": self.model,
                "messages": [message.model_dump() for message in messages],
                "settings": {
                    "systemPrompt": IBD_ASSISTANT_PROMPT,
                    "temperature": 0.25,
                    "maxTokens": 700,
                },
            }
        )
        return _required_text(result)


class ImageToTextService:
    def __init__(self, gateway: InferenceGateway, model: str) -> None:
        self._gateway = gateway
        self.model = model

    async def describe(
        self,
        image_data_uri: str,
        purpose: Literal["meal_log", "general"],
        note: str | None = None,
    ) -> str:
        prompt = MEAL_IMAGE_PROMPT if purpose == "meal_log" else GENERAL_IMAGE_PROMPT
        if note:
            prompt = f"{prompt}\nThe user added this context: {note}"

        result = await self._gateway.run(
            {
                "taskType": "textInference",
                "model": self.model,
                "messages": [{"role": "user", "content": prompt}],
                "inputs": {"images": [image_data_uri]},
                "settings": {"temperature": 0.2, "maxTokens": 500},
            }
        )
        return _required_text(result)


class SpeechToTextService:
    def __init__(self, gateway: InferenceGateway, model: str) -> None:
        self._gateway = gateway
        self.model = model

    async def transcribe(self, audio_base64: str) -> str:
        result = await self._gateway.run(
            {
                "taskType": "textInference",
                "model": self.model,
                "messages": [{"role": "user", "content": TRANSCRIPTION_PROMPT}],
                "inputs": {"audios": [audio_base64]},
                "settings": {"temperature": 0, "maxTokens": 1_500},
            }
        )
        return _required_text(result)


class TextToSpeechService:
    def __init__(self, gateway: InferenceGateway, model: str) -> None:
        self._gateway = gateway
        self.model = model

    async def synthesize(self, text: str, voice: str, language: str) -> str:
        result = await self._gateway.run(
            {
                "taskType": "audioInference",
                "model": self.model,
                "speech": {"text": text, "voice": voice, "language": language},
            }
        )
        audio_url = result.get("audioURL")
        if not isinstance(audio_url, str) or not audio_url:
            raise AIResponseError("Runware did not return audio for this request.")
        return audio_url


@dataclass(frozen=True)
class AIServices:
    settings: RunwareSettings
    chat: ChatService
    image_to_text: ImageToTextService
    speech_to_text: SpeechToTextService
    text_to_speech: TextToSpeechService

