from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from truman_calling.api.db import engine
from truman_calling.api import ws
from truman_calling.api.routers import (
    agents,
    alerts,
    audio,
    calls,
    judge,
    personas,
    profiles,
    results,
    rubrics,
    runs,
    scenarios,
    schedules,
    suites,
    takeover,
    voices,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await engine.dispose()


app = FastAPI(title="Truman API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", tags=["meta"])
async def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(agents.router)
app.include_router(personas.router)
app.include_router(profiles.router)
app.include_router(rubrics.router)
app.include_router(judge.router)
app.include_router(scenarios.router)
app.include_router(runs.router)
app.include_router(results.router)
app.include_router(schedules.router)
app.include_router(calls.router)
app.include_router(alerts.router)
app.include_router(suites.router)
app.include_router(audio.router)
app.include_router(takeover.router)
app.include_router(voices.router)
app.include_router(ws.router)
