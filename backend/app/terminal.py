"""Fleet Dashboard - WebSocket SSH terminal bridge.

Opens an interactive SSH session to a node and bridges it to a browser
terminal (xterm.js) over a WebSocket.
"""

from __future__ import annotations

import asyncio
from typing import Any

import paramiko
from fastapi import APIRouter, WebSocket

router = APIRouter()


class SSHSession:
    """A single interactive SSH session bridged to a WebSocket."""

    def __init__(self, host: str, user: str, port: int = 22):
        self.host = host
        self.user = user
        self.port = port
        self.client: paramiko.SSHClient | None = None
        self.channel: paramiko.Channel | None = None

    def connect(self) -> None:
        """Open the SSH connection and an interactive shell channel."""
        self.client = paramiko.SSHClient()
        self.client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        self.client.connect(
            hostname=self.host,
            username=self.user,
            port=self.port,
            timeout=10,
            look_for_keys=True,
            allow_agent=True,
        )
        self.channel = self.client.invoke_shell(
            term="xterm-256color",
            width=120,
            height=30,
        )
        self.channel.settimeout(0.0)

    def read(self) -> str:
        """Read any available output from the channel (non-blocking)."""
        if not self.channel:
            return ""
        try:
            if self.channel.recv_ready():
                data = self.channel.recv(65536)
                return data.decode("utf-8", errors="replace")
        except (OSError, paramiko.SSHException):
            pass
        return ""

    def write(self, data: str) -> None:
        """Send input to the channel."""
        if self.channel and self.channel.send_ready():
            self.channel.send(data)

    def resize(self, cols: int, rows: int) -> None:
        """Resize the remote PTY."""
        if self.channel:
            try:
                self.channel.resize_pty(width=cols, height=rows)
            except (OSError, paramiko.SSHException):
                pass

    def close(self) -> None:
        """Close the channel and client."""
        try:
            if self.channel:
                self.channel.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            if self.client:
                self.client.close()
        except Exception:  # noqa: BLE001
            pass


async def bridge_terminal(websocket: WebSocket, host: str, user: str, port: int = 22) -> None:
    """Bridge a WebSocket to an interactive SSH session.

    Message protocol (JSON):
      {"type": "input", "data": "..."}   -> send to SSH
      {"type": "resize", "cols": 120, "rows": 30} -> resize PTY
    Server -> client:
      {"type": "output", "data": "..."}  -> terminal output
      {"type": "exit", "code": 0}        -> session ended
    """
    await websocket.accept()

    session = SSHSession(host, user, port)
    try:
        # Connect in a thread executor to avoid blocking the event loop
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, session.connect)
    except Exception as e:  # noqa: BLE001
        await websocket.send_json({"type": "exit", "code": 1, "error": str(e)})
        await websocket.close()
        return

    async def pump_output() -> None:
        """Continuously read SSH output and send to the client."""
        while True:
            data = await loop.run_in_executor(None, session.read)
            if data:
                await websocket.send_json({"type": "output", "data": data})
            else:
                await asyncio.sleep(0.02)

    pump_task = asyncio.create_task(pump_output())

    try:
        while True:
            message = await websocket.receive_json()
            mtype = message.get("type")
            if mtype == "input":
                await loop.run_in_executor(None, session.write, message.get("data", ""))
            elif mtype == "resize":
                await loop.run_in_executor(
                    None, session.resize, message.get("cols", 120), message.get("rows", 30)
                )
    except Exception:  # noqa: BLE001
        pass
    finally:
        pump_task.cancel()
        session.close()
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass


def register_terminal_routes(app) -> None:
    """Register the WebSocket terminal route on the FastAPI app.

    The route lives in this module (not main.py) because a WebSocket route
    defined directly in the main app module was rejected with a 403 during
    the handshake. Defining it here via a router avoids that.
    """

    @app.websocket("/ws/terminal/{node_name}")
    async def ws_terminal(websocket: WebSocket, node_name: str) -> None:
        """Open an interactive SSH terminal to a node over WebSocket."""
        from .main import load_config

        node = next((n for n in load_config() if n.name == node_name), None)
        if node is None:
            await websocket.accept()
            await websocket.send_json({"type": "exit", "code": 1, "error": f"Unknown node: {node_name}"})
            await websocket.close()
            return
        await bridge_terminal(websocket, node.host, node.user, node.port)
