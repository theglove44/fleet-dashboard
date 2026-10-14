"""Fleet Dashboard - Phase 1 agentless inventory collector.

SSHes into each configured node and gathers system facts.
"""

from __future__ import annotations

import platform
import re
from dataclasses import dataclass, field
from typing import Any

import paramiko


@dataclass
class NodeFacts:
    """System facts gathered from a remote node."""

    hostname: str = ""
    os: str = ""
    os_version: str = ""
    arch: str = ""
    cpu_model: str = ""
    cpu_count: int = 0
    mem_total_gb: float = 0.0
    mem_used_gb: float = 0.0
    disk_total_gb: float = 0.0
    disk_used_gb: float = 0.0
    ip: str = ""
    uptime: str = ""
    packages: list[str] = field(default_factory=list)
    pending_updates: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "hostname": self.hostname,
            "os": self.os,
            "os_version": self.os_version,
            "arch": self.arch,
            "cpu_model": self.cpu_model,
            "cpu_count": self.cpu_count,
            "mem_total_gb": round(self.mem_total_gb, 1),
            "mem_used_gb": round(self.mem_used_gb, 1),
            "disk_total_gb": round(self.disk_total_gb, 1),
            "disk_used_gb": round(self.disk_used_gb, 1),
            "ip": self.ip,
            "uptime": self.uptime,
            "package_count": len(self.packages),
            "pending_updates": self.pending_updates,
        }


class SSHCollector:
    """Gathers system facts over SSH."""

    def __init__(self, host: str, user: str, os_type: str, port: int = 22, timeout: int = 10):
        self.host = host
        self.user = user
        self.os_type = os_type
        self.port = port
        self.timeout = timeout

    def _exec(
        self, client: paramiko.SSHClient, command: str, timeout: int | None = None
    ) -> tuple[str, str, int]:
        """Run a command and return its stdout, stderr, and exit status."""
        stdin, stdout, stderr = client.exec_command(command, timeout=timeout or self.timeout)
        stdin.channel.shutdown_write()
        out = stdout.read().decode(errors="replace").strip()
        err = stderr.read().decode(errors="replace").strip()
        return out, err, stdout.channel.recv_exit_status()

    def _run(self, client: paramiko.SSHClient, command: str, timeout: int | None = None) -> str:
        """Run a command and return stdout, or stderr when stdout is empty."""
        out, err, _ = self._exec(client, command, timeout)
        return out or err

    def collect(self) -> NodeFacts:
        facts = NodeFacts()
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            client.connect(
                hostname=self.host,
                username=self.user,
                port=self.port,
                timeout=self.timeout,
                look_for_keys=True,
                allow_agent=True,
            )

            facts.hostname = self._run(client, "hostname")
            facts.arch = self._run(client, "uname -m")

            if self.os_type == "macos":
                self._collect_macos(client, facts)
            else:
                facts.uptime = self._run(client, "uptime -p")
                facts.ip = self._run(client, "hostname -I | awk '{print $1}'")
                self._collect_linux(client, facts)

        finally:
            client.close()

        return facts

    def _collect_linux(self, client: paramiko.SSHClient, facts: NodeFacts) -> None:
        facts.os = self._run(
            client,
            "lsb_release -ds 2>/dev/null || cat /etc/os-release | grep PRETTY_NAME | cut -d'=' -f2",
        ).strip().strip('"')
        facts.cpu_model = self._run(client, "grep 'model name' /proc/cpuinfo | head -1 | cut -d':' -f2 | xargs")
        facts.cpu_count = int(self._run(client, "nproc") or 0)

        mem = self._run(client, "free -g | awk '/Mem:/{print $2, $3}'").split()
        if len(mem) >= 2:
            facts.mem_total_gb = float(mem[0])
            facts.mem_used_gb = float(mem[1])

        disk = self._run(client, "df -h / | awk 'NR==2{print $2, $3}'").split()
        if len(disk) >= 2:
            facts.disk_total_gb = self._gb_from_human(disk[0])
            facts.disk_used_gb = self._gb_from_human(disk[1])

        # Count from cached lists. Do not apt-get update here: paramiko's 10s
        # channel timeout fires on that command (openclaw-1) and used to mark
        # a reachable node offline. Refresh lists in upgradable_packages().
        try:
            updates = self._run(client, "apt list --upgradable 2>/dev/null | tail -n +2 | wc -l")
            facts.pending_updates = int(updates or 0)
        except Exception:
            facts.pending_updates = 0

    def _collect_macos(self, client: paramiko.SSHClient, facts: NodeFacts) -> None:
        # macOS uptime lacks `uptime -p`; extract the "up ..." segment instead
        raw = self._run(
            client, "uptime | sed -E 's/^.* up /up /; s/, *[0-9]+ users?.*$//'"
        )
        facts.uptime = self._pretty_uptime(raw)
        facts.ip = self._run(client, "ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1")
        facts.os = self._run(client, "sw_vers -productVersion")
        facts.cpu_model = self._run(client, "sysctl -n machdep.cpu.brand_string")
        facts.cpu_count = int(self._run(client, "sysctl -n hw.ncpu") or 0)

        mem = self._run(client, "sysctl -n hw.memsize")
        try:
            facts.mem_total_gb = int(mem) / (1024**3)
        except ValueError:
            pass

        disk = self._run(client, "df -h / | awk 'NR==2{print $2, $3}'").split()
        if len(disk) >= 2:
            facts.disk_total_gb = self._gb_from_human(disk[0])
            facts.disk_used_gb = self._gb_from_human(disk[1])

        # Pending brew updates
        updates = self._run(client, "brew outdated 2>/dev/null | wc -l")
        facts.pending_updates = int(updates or 0)

    def upgradable_packages(self) -> list[str]:
        """Return the names of packages with pending updates."""
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            client.connect(
                hostname=self.host,
                username=self.user,
                port=self.port,
                timeout=self.timeout,
                look_for_keys=True,
                allow_agent=True,
            )
            if self.os_type == "macos":
                out = self._run(
                    client,
                    'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"; brew outdated 2>/dev/null',
                )
                return [line.split()[0] for line in out.splitlines() if line.strip()]
            sudo = "" if self.user == "root" else "sudo -n "
            _, update_error, update_code = self._exec(
                client, f"{sudo}apt-get update -qq", timeout=120
            )
            if update_code != 0:
                detail = update_error or f"apt-get update exited with status {update_code}"
                raise RuntimeError(f"Could not refresh apt package lists: {detail}")
            out = self._run(client, "apt list --upgradable 2>/dev/null | tail -n +2")
            return [line.split("/")[0] for line in out.splitlines() if line.strip()]
        finally:
            client.close()

    @staticmethod
    def _pretty_uptime(raw: str) -> str:
        """Rewrite macOS 'up 34 days, 21:57' in the style of Linux `uptime -p`."""
        m = re.match(r"^up\s+(?:(\d+)\s+days?,\s*)?(\d+):(\d{2})$", raw.strip())
        if not m:
            return raw
        d, h, mi = (int(g) if g else 0 for g in m.groups())
        parts = []
        if d:
            parts.append(f"{d} day{'s' if d != 1 else ''}")
        if h:
            parts.append(f"{h} hour{'s' if h != 1 else ''}")
        if mi or not (d or h):
            parts.append(f"{mi} minute{'s' if mi != 1 else ''}")
        return "up " + ", ".join(parts)

    @staticmethod
    def _gb_from_human(value: str) -> float:
        """Convert '1.5G' or '512M' to GB float."""
        try:
            if value.endswith("G"):
                return float(value[:-1])
            if value.endswith("M"):
                return float(value[:-1]) / 1024
            if value.endswith("T"):
                return float(value[:-1]) * 1024
            return float(value)
        except ValueError:
            return 0.0
