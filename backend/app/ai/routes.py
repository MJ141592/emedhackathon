import base64
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status

from app.ai.dependencies import get_ai_services
from app.ai.schemas import AIStatus, AudioResult, ChatRequest, TextResult, TextToSpeechRequest
from app.ai.services import AIServices

router = APIRouter(prefix="/api/ai", tags=["ai"])

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_AUDIO_BYTES = 20 * 1024 * 1024


async def _read_upload(upload: UploadFile, limit: int, media_type: str) -> bytes:
    if not upload.content_type or not upload.content_type.startswith(f"{media_type}/"):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"A valid {media_type} file is required.",
        )

    content = await upload.read(limit + 1)
    if not content:
        raise HTTPException(status_code=422, detail="The uploaded file is empty.")
    if len(content) > limit:
        raise HTTPException(status_code=413, detail=f"The {media_type} file is too large.")
    return content


@router.get("/status", response_model=AIStatus)
async def ai_status(services: Annotated[AIServices, Depends(get_ai_services)]) -> AIStatus:
    settings = services.settings
    return AIStatus(
        configured=settings.configured,
        models={
            "chat": settings.chat_model,
            "image_to_text": settings.vision_model,
            "speech_to_text": settings.transcription_model,
            "text_to_speech": settings.speech_model,
        },
    )


@router.post("/chat", response_model=TextResult)
async def chat(
    request: ChatRequest, services: Annotated[AIServices, Depends(get_ai_services)]
) -> TextResult:
    text = await services.chat.reply(request.messages)
    return TextResult(text=text, model=services.chat.model)


@router.post("/image-to-text", response_model=TextResult)
async def image_to_text(
    image: Annotated[UploadFile, File()],
    services: Annotated[AIServices, Depends(get_ai_services)],
    purpose: Annotated[Literal["meal_log", "general"], Form()] = "meal_log",
    note: Annotated[str | None, Form(max_length=500)] = None,
) -> TextResult:
    content = await _read_upload(image, MAX_IMAGE_BYTES, "image")
    encoded = base64.b64encode(content).decode("ascii")
    data_uri = f"data:{image.content_type};base64,{encoded}"
    text = await services.image_to_text.describe(data_uri, purpose, note)
    return TextResult(text=text, model=services.image_to_text.model)


@router.post("/speech-to-text", response_model=TextResult)
async def speech_to_text(
    audio: Annotated[UploadFile, File()],
    services: Annotated[AIServices, Depends(get_ai_services)],
) -> TextResult:
    content = await _read_upload(audio, MAX_AUDIO_BYTES, "audio")
    encoded = base64.b64encode(content).decode("ascii")
    text = await services.speech_to_text.transcribe(encoded)
    return TextResult(text=text, model=services.speech_to_text.model)


@router.post("/text-to-speech", response_model=AudioResult)
async def text_to_speech(
    request: TextToSpeechRequest,
    services: Annotated[AIServices, Depends(get_ai_services)],
) -> AudioResult:
    audio_url = await services.text_to_speech.synthesize(
        request.text, request.voice, request.language
    )
    return AudioResult(audio_url=audio_url, model=services.text_to_speech.model)

