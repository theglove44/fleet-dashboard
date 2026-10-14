"""Fleet Dashboard - FastAPI application."""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import paramiko
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
    temp_file = CACHE_FILE.with_name(f"{CACHE_FILE.name}.{uuid.uuid4().hex}.tmp")
    try:
        with open(temp_file, "w") as f:
            json.dump(cache, f, indent=2)
        os.replace(temp_file, CACHE_FILE)
    except OSError:
        try:
            temp_file.unlink(missing_ok=True)
        except OSError:
            pass


# In-memory cache of the last collected facts per node (loaded from disk)
_cache: dict[str, dict[str, Any]] = _load_cache()
_collection_state: dict[str, Any] = {"status": "idle", "run_id": None, "started_at": None, "finished_at": None}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class AgentUpdateRequest(BaseModel):
    dry_run: bool = False


class NodeConfig(BaseModel):
    name: str
    host: str
    user: str
    port: int = 22
    os: str
    group: str = "host"


CONFIG_FILE = Path(__file__).resolve().parent.parent / "config.yaml"


def load_config(path: str | Path | None = None) -> list[NodeConfig]:
    """Load node config from its project path, independent of the process cwd."""
    try:
        with open(path or CONFIG_FILE) as f:
            data = yaml.safe_load(f)
        return [NodeConfig(**n) for n in data.get("nodes", [])]
    except FileNotFoundError as e:
        config_path = path or CONFIG_FILE
        raise FileNotFoundError(f"Node configuration not found: {config_path}") from e


def collect_one(node: NodeConfig) -> dict[str, Any]:
    """Collect facts for a single node."""
    collector = SSHCollector(node.host, node.user, node.os, port=node.port)
    collected_at = _utc_now()
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
            "last_seen": collected_at,
            "collected_at": collected_at,
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
            "last_seen": collected_at,
            "collected_at": collected_at,
            "error": str(e) or type(e).__name__,
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


@app.get("/api/collect/status")
async def get_collection_status() -> dict[str, Any]:
    """Return the state of the most recent collection run."""
    return dict(_collection_state)


@app.post("/api/collect")
async def collect_all() -> dict[str, Any]:
    """Kick off collection from all nodes (runs SSH in parallel, async).

    Returns immediately with 202; the frontend polls /api/nodes for results.
    """
    global _collection_state
    if _collection_state["status"] == "running":
        return {**_collection_state, "collecting": True}

    nodes = load_config()
    run_id = str(uuid.uuid4())
    _collection_state = {
        "status": "running", "run_id": run_id, "started_at": _utc_now(),
        "finished_at": None, "total": len(nodes), "completed": 0,
    }

    async def _run() -> None:
        global _collection_state
        try:
            with ThreadPoolExecutor(max_workers=len(nodes) or 1) as pool:
                loop = asyncio.get_running_loop()
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
            _collection_state = {**_collection_state, "status": "complete", "completed": len(results), "finished_at": _utc_now()}
        except Exception as e:  # noqa: BLE001
            _collection_state = {**_collection_state, "status": "failed", "error": str(e), "finished_at": _utc_now()}

    asyncio.create_task(_run())
    return {**_collection_state, "collecting": True}


_agent_update_state: dict[str, Any] = {
    "status": "idle", "run_id": None, "dry_run": None,
    "started_at": None, "finished_at": None,
}


def _parse_agent_report(output: str) -> tuple[str, list[dict[str, Any]], dict[str, int]]:
    """Separate the human report from the script's structured host/tool rows."""
    marker = "@@AGENT_DATA_BEGIN@@"
    if marker not in output:
        return output.strip(), [], {}
    report, data = output.split(marker, 1)
    hosts: dict[str, dict[str, Any]] = {}
    for line in data.splitlines():
        fields = line.split("|")
        if fields[0] == "AGENT_HOST" and len(fields) >= 4:
            hosts[fields[1]] = {"name": fields[1], "reachable": fields[2] == "ok", "error": fields[3], "tools": []}
        elif fields[0] == "AGENT_TOOL" and len(fields) == 10:
            _, host, name, installed, method, before, update, after, version, state = fields
            hosts.setdefault(host, {"name": host, "reachable": True, "error": "", "tools": []})["tools"].append({
                "name": name, "installed": installed == "yes", "method": method,
                "before": before, "update": update, "after": after,
                "version": version, "state": state,
            })
    rows = list(hosts.values())
    tools = [tool for host in rows for tool in host["tools"]]
    summary = {
        "reachable": sum(h["reachable"] for h in rows),
        "hosts": len(rows),
        "installed": sum(t["installed"] for t in tools),
        "behind": sum(t["state"] == "behind" for t in tools),
        "updated": sum(t["state"] == "ok" for t in tools),
        "problems": sum(t["state"] in ("fail", "skip") for t in tools) + sum(not h["reachable"] for h in rows),
    }
    return report.strip(), rows, summary


def _run_agent_update(dry_run: bool) -> dict[str, Any]:
    """Run the version-controlled fleet agent script from the MacBook."""
    node = next((n for n in load_config() if n.name == "macbook"), None)
    if node is None:
        raise RuntimeError("No 'macbook' node is configured")

    script_path = Path(__file__).resolve().parent.parent / "scripts" / "fleet-agent-update.sh"
    script = script_path.read_text()
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            hostname=node.host,
            username=node.user,
            port=node.port,
            timeout=15,
            look_for_keys=True,
            allow_agent=True,
        )
        args = "--machine-output --dry-run" if dry_run else "--machine-output"
        command = f"bash -s -- {args}"
        stdin, stdout, stderr = client.exec_command(command, timeout=900)
        stdin.write(script)
        stdin.channel.shutdown_write()
        raw_output = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        out, hosts, summary = _parse_agent_report(raw_output)
        return {
            "exit_code": stdout.channel.recv_exit_status(), "output": out,
            "error_output": err, "hosts": hosts, "summary": summary,
        }
    finally:
        client.close()


@app.get("/api/agent-updater/status")
async def get_agent_update_status() -> dict[str, Any]:
    """Return the last agent tool scan/update result."""
    return dict(_agent_update_state)


@app.post("/api/agent-updater/run")
async def start_agent_update(request: AgentUpdateRequest) -> dict[str, Any]:
    """Run the MacBook fleet agent script asynchronously."""
    global _agent_update_state
    if _agent_update_state["status"] == "running":
        return dict(_agent_update_state)

    run_id = str(uuid.uuid4())
    _agent_update_state = {
        "status": "running", "run_id": run_id, "dry_run": request.dry_run,
        "started_at": _utc_now(), "finished_at": None,
    }

    async def _run() -> None:
        global _agent_update_state
        try:
            result = await asyncio.get_running_loop().run_in_executor(
                None, _run_agent_update, request.dry_run
            )
            _agent_update_state = {
                **_agent_update_state,
                **result,
                "status": "complete" if result["exit_code"] == 0 else "failed",
                "finished_at": _utc_now(),
            }
        except Exception as e:  # noqa: BLE001
            _agent_update_state = {
                **_agent_update_state, "status": "failed", "error": str(e),
                "finished_at": _utc_now(),
            }

    asyncio.create_task(_run())
    return dict(_agent_update_state)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/updates/{node_name}")
async def get_upgradable(node_name: str) -> dict[str, Any]:
    """List pending packages on a node (used for the update confirm dialog)."""
    node = next((n for n in load_config() if n.name == node_name), None)
    if node is None:
        return {"success": False, "error": f"Unknown node: {node_name}", "packages": []}
    collector = SSHCollector(node.host, node.user, node.os, port=node.port)
    try:
        packages = await asyncio.get_event_loop().run_in_executor(
            None, collector.upgradable_packages
        )
        checked_at = _utc_now()
        _cache[node.name] = {
            **_cache.get(node.name, {}),
            "pending_updates": len(packages),
            "updates_checked_at": checked_at,
        }
        _save_cache(_cache)
        return {
            "success": True,
            "packages": packages,
            "pending_updates": len(packages),
            "updates_checked_at": checked_at,
        }
    except Exception as e:  # noqa: BLE001
        return {"success": False, "error": str(e), "packages": []}


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
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"

if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/")
    async def serve_index():
        return FileResponse(FRONTEND_DIST / "index.html")
