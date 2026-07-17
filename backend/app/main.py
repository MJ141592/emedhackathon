from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse

from app.ai.errors import AIConfigurationError, AIProviderError, AIServiceError
from app.ai.routes import router as ai_router

app = FastAPI(title="eMed API", version="0.1.0")
app.include_router(ai_router)


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
    return {"status": "healthy", "service": "eMed API"}
