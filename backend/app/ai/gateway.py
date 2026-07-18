from typing import Any, Protocol

from runware import RunOptions, Runware, RunwareError

from app.ai.errors import AIConfigurationError, AIProviderError, AIResponseError


class InferenceGateway(Protocol):
    async def run(self, payload: dict[str, Any]) -> dict[str, Any]: ...


class RunwareGateway:
    def __init__(self, api_key: str | None) -> None:
        self._api_key = api_key

    async def run(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self._api_key:
            raise AIConfigurationError("Runware is not configured on the server.")

        try:
            async with Runware(api_key=self._api_key) as client:
                results = await client.run(
                    {**payload, "deliveryMethod": "sync"},
                    # Runware still validates every task server-side. The SDK's optional
                    # downloaded-schema compiler currently rejects Runware's standard `uuid`
                    # format before a valid request can leave the process, so keep that broken
                    # client-side preflight off and rely on our typed service payloads plus the
                    # provider response.
                    RunOptions(timeout=60_000, validate=False),
                )
        except RunwareError as error:
            provider_code = str(error.code)
            raise AIProviderError(
                "Runware could not complete the request.", provider_code=provider_code
            ) from error
        except Exception as error:
            # Transport/SDK failures must become a controlled 502 rather than escaping as an
            # unhandled application error. Never include request data or credentials here.
            raise AIProviderError("Runware could not complete the request.") from error

        if not results or not isinstance(results[0], dict):
            raise AIResponseError("Runware returned an empty or invalid response.")

        return results[0]
