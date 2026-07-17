from typing import Literal

from pydantic import BaseModel, Field


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=8_000)


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=30)


class TextToSpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4_000)
    voice: Literal["eve", "ara", "leo", "rex", "sal"] = "eve"
    language: str = Field(default="en", min_length=2, max_length=12, pattern=r"^[A-Za-z-]+$")


class TextResult(BaseModel):
    text: str
    model: str


class AudioResult(BaseModel):
    audio_url: str
    model: str


class AIStatus(BaseModel):
    configured: bool
    models: dict[str, str]

