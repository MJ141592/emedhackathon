import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT_ENV_FILE = Path(__file__).parents[3] / ".env"


@dataclass(frozen=True)
class RunwareSettings:
    api_key: str | None
    chat_model: str = "anthropic:claude@sonnet-4.6"
    vision_model: str = "google:gemini@3.1-flash-lite"
    transcription_model: str = "google:gemini@3.1-flash-lite"
    speech_model: str = "xai:tts@0"

    @classmethod
    def from_environment(cls) -> "RunwareSettings":
        load_dotenv(ROOT_ENV_FILE)
        return cls(
            api_key=os.getenv("RUNWARE_API_KEY"),
            chat_model=os.getenv("RUNWARE_CHAT_MODEL", cls.chat_model),
            vision_model=os.getenv("RUNWARE_VISION_MODEL", cls.vision_model),
            transcription_model=os.getenv(
                "RUNWARE_TRANSCRIPTION_MODEL", cls.transcription_model
            ),
            speech_model=os.getenv("RUNWARE_SPEECH_MODEL", cls.speech_model),
        )

    @property
    def configured(self) -> bool:
        return bool(self.api_key)
