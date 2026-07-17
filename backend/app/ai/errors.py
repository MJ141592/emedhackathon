class AIServiceError(RuntimeError):
    code = "ai_service_error"


class AIConfigurationError(AIServiceError):
    code = "ai_not_configured"


class AIProviderError(AIServiceError):
    code = "ai_provider_error"

    def __init__(self, message: str, *, provider_code: str = "unknown") -> None:
        super().__init__(message)
        self.provider_code = provider_code


class AIResponseError(AIServiceError):
    code = "ai_invalid_response"

