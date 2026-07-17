from fastapi import FastAPI

app = FastAPI(title="eMed API", version="0.1.0")


@app.get("/api/health", tags=["system"])
async def health() -> dict[str, str]:
    return {"status": "healthy", "service": "eMed API"}

