"""Fleet Dashboard - FastAPI application."""

from __future__ import annotations

import asyncio
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import yaml
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .collector import SSHCollector
from .terminal import register_terminal_routes

app = FastAPI(title="Fleet Dashboard", version="0.1.0")

# Allow the frontend to call the API (handles CORS preflight for POST)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register WebSocket SSH terminal route (defined in terminal.py to avoid
# a 403 handshake rejection that occurs when defined directly in main.py)
register_terminal_routes(app)

# ---- Persistent cache (survives restarts) ----
CACHE_FILE = Path(__file__).resolve().parent.parent / "cache.json"


def _load_cache() -> dict[str, dict[str, Any]]:
    """Load the cache from disk."""
    try:
        with open(CACHE_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_cache(cache: dict[str, dict[str, Any]]) -> None:
    """Persist the cache to disk."""
    try:
        with open(CACHE_FILE, "w") as f:
            json.dump(cache, f, indent=2)
    except OSError:
        pass


# In-memory cache of the last collected facts per node (loaded from disk)
_cache: dict[str, dict[str, Any]] = _load_cache()


class NodeConfig(BaseModel):
    name: str
    host: str
    user: str
    port: int = 22
    os: str
    group: str = "host"


def load_config(path: str = "config.yaml") -> list[NodeConfig]:
    """Load node config from YAML."""
    try:
        with open(path) as f:
            data = yaml.safe_load(f)
        return [NodeConfig(**n) for n in data.get("nodes", [])]
    except FileNotFoundError:
        return []


def collect_one(node: NodeConfig) -> dict[str, Any]:
    """Collect facts for a single node."""
    collector = SSHCollector(node.host, node.user, node.os, port=node.port)
    try:
        facts = collector.collect()
        return {
            "name": node.name,
            "host": node.host,
            "group": node.group,
            "online": True,
            "last_seen": None,  # Phase 2 adds timestamps
            **facts.to_dict(),
        }
    except Exception as e:  # noqa: BLE001
        return {
            "name": node.name,
            "host": node.host,
            "group": node.group,
            "online": False,
            "error": str(e),
        }


@app.get("/api/nodes")
async def get_nodes() -> dict[str, Any]:
    """Return all nodes with their last collected facts."""
    nodes = load_config()
    results = []
    for node in nodes:
        entry = _cache.get(node.name) or {
            "name": node.name,
            "host": node.host,
            "group": node.group,
            "online": False,
            "error": "not yet collected",
        }
        results.append(entry)
    return {"nodes": results}


@app.post("/api/collect")
async def collect_all() -> dict[str, Any]:
    """Kick off collection from all nodes (runs SSH in parallel, async).

    Returns immediately with 202; the frontend polls /api/nodes for results.
    """
    nodes = load_config()

    async def _run() -> None:
        with ThreadPoolExecutor(max_workers=len(nodes) or 1) as pool:
            loop = asyncio.get_event_loop()
            futures = [loop.run_in_executor(pool, collect_one, node) for node in nodes]
            results = await asyncio.gather(*futures)
        for result in results:
            _cache[result["name"]] = result
        _save_cache(_cache)

    asyncio.create_task(_run())
    return {"status": "started", "collecting": True}


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


# ---- Serve built frontend (production) ----
from pathlib import Path
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"

if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/")
    async def serve_index():
        return FileResponse(FRONTEND_DIST / "index.html")
