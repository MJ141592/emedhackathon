from functools import lru_cache

from app.ai.config import RunwareSettings
from app.ai.gateway import RunwareGateway
from app.ai.services import (
    AIServices,
    ChatService,
    ImageToTextService,
    SpeechToTextService,
    TextToSpeechService,
)


@lru_cache
def get_ai_services() -> AIServices:
    settings = RunwareSettings.from_environment()
    gateway = RunwareGateway(settings.api_key)
    return AIServices(
        settings=settings,
        chat=ChatService(gateway, settings.chat_model),
        image_to_text=ImageToTextService(gateway, settings.vision_model),
        speech_to_text=SpeechToTextService(gateway, settings.transcription_model),
        text_to_speech=TextToSpeechService(gateway, settings.speech_model),
    )

