"""Fleet Dashboard - FastAPI application."""

from __future__ import annotations

import asyncio
import json
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .collector import SSHCollector
from .terminal import register_terminal_routes
from .updater import NodeUpdater

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
            "user": node.user,
            "port": node.port,
            "group": node.group,
            "os_type": node.os,
            "online": True,
            "last_seen": None,  # Phase 2 adds timestamps
            **facts.to_dict(),
        }
    except Exception as e:  # noqa: BLE001
        return {
            "name": node.name,
            "host": node.host,
            "user": node.user,
            "port": node.port,
            "group": node.group,
            "os_type": node.os,
            "online": False,
            "error": str(e),
        }


@app.get("/api/nodes")
async def get_nodes() -> dict[str, Any]:
    """Return all nodes with their last collected facts."""
    nodes = load_config()
    results = []
    for node in nodes:
        cached = _cache.get(node.name)
        stub = {"online": False, "error": "not yet collected"} if not cached else {}
        results.append({
            **stub,
            **(cached or {}),
            "name": node.name,
            "host": node.host,
            "user": node.user,
            "port": node.port,
            "group": node.group,
            "os_type": node.os,
        })
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
            # Merge fresh facts but preserve last_update (collect should not wipe update results)
            prev = _cache.get(result["name"], {})
            _cache[result["name"]] = {
                **result,
                "last_update": prev.get("last_update"),
                "updating": prev.get("updating"),
            }
        _save_cache(_cache)

    asyncio.create_task(_run())
    return {"status": "started", "collecting": True}


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/update/{node_name}")
async def update_node(node_name: str) -> dict[str, Any]:
    """Run package updates on a single node (async, returns immediately)."""
    node = next((n for n in load_config() if n.name == node_name), None)
    if node is None:
        return {"success": False, "error": f"Unknown node: {node_name}"}

    updater = NodeUpdater(node.host, node.user, node.os, port=node.port)
    _cache[node.name] = {**_cache.get(node.name, {}), "updating": True}

    async def _run() -> None:
        try:
            result = await asyncio.get_event_loop().run_in_executor(None, updater.run_updates)
        except Exception as e:  # noqa: BLE001
            result = {"success": False, "error": str(e)}
        result["finished_at"] = datetime.now(timezone.utc).isoformat()
        try:
            # Re-collect so pending_updates reflects the real state
            fresh = await asyncio.get_event_loop().run_in_executor(None, collect_one, node)
        except Exception:
            fresh = {}
        prev = _cache.get(node.name, {})
        _cache[node.name] = {**prev, **fresh, "last_update": result, "updating": False}
        _save_cache(_cache)

    asyncio.create_task(_run())
    return {"status": "started", "node": node_name, "updating": True}


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
