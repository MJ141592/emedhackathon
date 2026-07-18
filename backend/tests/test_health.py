import asyncio
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app import main as main_module
from app.main import app

client = TestClient(app)


def test_health_endpoint() -> None:
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "healthy", "service": "Gutsy API"}


def test_api_process_runs_consent_bound_background_agent(monkeypatch) -> None:
    store = SimpleNamespace(
        get=lambda: SimpleNamespace(
            profile=SimpleNamespace(
                onboardingComplete=True,
                adultEligibilityConfirmed=True,
                healthDataConsent=True,
            )
        )
    )
    calls = []
    monkeypatch.setattr(main_module, "_store_for_app", lambda _application: store)
    monkeypatch.setattr(main_module, "run_evening_background", lambda value: calls.append(value))

    asyncio.run(main_module._run_background_work(app))

    assert calls == [store]
