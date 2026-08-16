"""Fleet Dashboard - FastAPI application."""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import yaml
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .collector import SSHCollector

app = FastAPI(title="Fleet Dashboard", version="0.1.0")

# Allow the frontend dev server to call the API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory cache of the last collected facts per node
_cache: dict[str, dict[str, Any]] = {}


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
    """Collect facts from all nodes (runs SSH in parallel)."""
    nodes = load_config()
    with ThreadPoolExecutor(max_workers=len(nodes) or 1) as pool:
        loop = asyncio.get_event_loop()
        futures = [loop.run_in_executor(pool, collect_one, node) for node in nodes]
        results = await asyncio.gather(*futures)

    for result in results:
        _cache[result["name"]] = result

    return {"collected": len(results), "nodes": results}


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
