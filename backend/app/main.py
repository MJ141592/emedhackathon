import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse

from app.ai.errors import AIConfigurationError, AIProviderError, AIServiceError
from app.ai.routes import router as ai_router
from app.domain.retention import cleanup_expired_media
from app.domain.routes import router as domain_router
from app.domain.routes import run_evening_background
from app.domain.store import get_demo_store

logger = logging.getLogger(__name__)
RETENTION_CLEANUP_INTERVAL_SECONDS = 60 * 60
BACKGROUND_WORK_INTERVAL_SECONDS = 5 * 60


def _store_for_app(application: FastAPI):
    provider = application.dependency_overrides.get(get_demo_store, get_demo_store)
    return provider()


async def _run_retention_cleanup(application: FastAPI) -> None:
    try:
        await asyncio.to_thread(cleanup_expired_media, _store_for_app(application))
    except Exception:
        # Retention cleanup must keep retrying, while a transient SQLite error must not make
        # urgent-help and export/delete routes unavailable.
        logger.exception("Automatic media-retention cleanup failed")


async def _retention_worker(application: FastAPI) -> None:
    while True:
        await asyncio.sleep(RETENTION_CLEANUP_INTERVAL_SECONDS)
        await _run_retention_cleanup(application)


async def _run_background_work(application: FastAPI) -> None:
    try:
        store = _store_for_app(application)
        profile = store.get().profile
        if not (
            profile.onboardingComplete
            and profile.adultEligibilityConfirmed
            and profile.healthDataConsent
        ):
            return
        await asyncio.to_thread(run_evening_background, store)
    except Exception:
        # Background drafting must be retried independently and can never take the API down.
        logger.exception("Automatic consent-bound background work failed")


async def _background_worker(application: FastAPI) -> None:
    while True:
        await asyncio.sleep(BACKGROUND_WORK_INTERVAL_SECONDS)
        await _run_background_work(application)


@asynccontextmanager
async def lifespan(application: FastAPI):
    # Run once before accepting requests, then periodically while the API process is alive.
    await _run_retention_cleanup(application)
    await _run_background_work(application)
    retention_worker = asyncio.create_task(_retention_worker(application))
    background_worker = asyncio.create_task(_background_worker(application))
    try:
        yield
    finally:
        retention_worker.cancel()
        background_worker.cancel()
        with suppress(asyncio.CancelledError):
            await retention_worker
        with suppress(asyncio.CancelledError):
            await background_worker


app = FastAPI(title="Gutsy API", version="0.1.0", lifespan=lifespan)


@app.middleware("http")
async def prevent_sensitive_api_caching(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/") and request.url.path != "/api/health":
        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"
    return response


app.include_router(ai_router)
app.include_router(domain_router)


@app.exception_handler(AIConfigurationError)
async def handle_ai_configuration_error(
    _request: Request, error: AIConfigurationError
) -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        content={"code": error.code, "message": str(error)},
    )


@app.exception_handler(AIProviderError)
async def handle_ai_provider_error(_request: Request, error: AIProviderError) -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_502_BAD_GATEWAY,
        content={"code": error.code, "message": str(error), "provider_code": error.provider_code},
    )


@app.exception_handler(AIServiceError)
async def handle_ai_service_error(_request: Request, error: AIServiceError) -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_502_BAD_GATEWAY,
        content={"code": error.code, "message": str(error)},
    )


@app.get("/api/health", tags=["system"])
async def health() -> dict[str, str]:
    return {"status": "healthy", "service": "Gutsy API"}
