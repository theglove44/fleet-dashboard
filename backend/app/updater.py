"""Fleet Dashboard - Update management.

Runs package updates (apt/brew) on nodes over SSH.
"""

from __future__ import annotations

import paramiko


class NodeUpdater:
    """Runs update commands on a node over SSH."""

    def __init__(self, host: str, user: str, os_type: str, port: int = 22, timeout: int = 300):
        self.host = host
        self.user = user
        self.os_type = os_type
        self.port = port
        self.timeout = timeout

    def _connect(self) -> paramiko.SSHClient:
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        client.connect(
            hostname=self.host,
            username=self.user,
            port=self.port,
            timeout=15,
            look_for_keys=True,
            allow_agent=True,
        )
        return client

    def _run(self, client: paramiko.SSHClient, command: str, timeout: int | None = None) -> tuple[str, str, int]:
        """Run a command and return (stdout, stderr, exit_code)."""
        _stdin, stdout, stderr = client.exec_command(command, timeout=timeout or self.timeout)
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        code = stdout.channel.recv_exit_status()
        return out, err, code

    def get_commands(self) -> list[str]:
        """Return the shell commands to run for updates on this OS."""
        if self.os_type == "macos":
            brew = "/opt/homebrew/bin/brew"
            return [f"{brew} update && {brew} upgrade 2>&1"]
        # Linux (apt). If user is root, no sudo needed.
        sudo = "" if self.user == "root" else "sudo "
        return [
            f"{sudo}apt-get update -qq 2>&1",
            f"{sudo}apt-get upgrade -y 2>&1",
        ]

    def run_updates(self) -> dict:
        """Run updates and return the result."""
        client = self._connect()
        try:
            output = []
            exit_code = 0
            for cmd in self.get_commands():
                out, err, code = self._run(client, cmd)
                output.append(out + err)
                exit_code = code
                if code != 0:
                    break
            return {
                "host": self.host,
                "user": self.user,
                "os": self.os_type,
                "success": exit_code == 0,
                "exit_code": exit_code,
                "output": "\n".join(output),
            }
        finally:
            client.close()
