# Fleet Dashboard - Agent Guide

## Project Overview

Fleet Dashboard is a fleet management tool for ~11 computers on a tailnet (Ubuntu, Proxmox, Ubuntu VMs, macOS on Apple Silicon and Intel). It provides a single web UI to view, update, and manage all nodes over SSH.

**Architecture:**
- **Backend:** Python 3.11+ / FastAPI / uvicorn (single systemd service, serves both API and built frontend)
- **Collector:** Python + paramiko (SSH-based inventory collection)
- **Frontend:** React + Vite (built to `dist/`, served by the backend)
- **Database:** SQLite (planned)
- **Transport:** SSH over tailnet

**Deployment:** Runs on a dedicated VM (`fleet-manager`, Debian 12) as a systemd service. Backend serves the built frontend from `frontend/dist/` so it's a single service on one port.

---

## Key Files

- `backend/app/main.py` - FastAPI app (routes: `/api/nodes`, `/api/collect`, `/health`)
- `backend/app/collector.py` - SSH-based inventory collector (paramiko)
- `backend/config.yaml` - Node configuration (hostname, user, os, group)
- `frontend/src/App.jsx` - React dashboard (Fleet Constellation design)
- `frontend/src/styles.css` - Dashboard styles

---

## Design Direction

The dashboard uses a **Fleet Constellation** design:
- Dark atmospheric theme (deep ink background `#070a10`)
- Nodes rendered as glowing orbs on a sky, connected by mesh lines (the tailnet)
- The central box (`mini-ubuntu` / fleet-manager) is the **HEART** with a pulsing amber ring
- Nodes sized by role: Proxmox hosts bigger, VMs smaller
- Node cards with role colors (Proxmox orange, hosts cyan, VMs blue, macOS violet)

**Design principle:** Ground the design in the subject (a fleet on a tailnet). The constellation is the signature element. Avoid generic dashboard templates.

---

## Lessons Learnt & Fixes

This section documents problems encountered and their solutions. Add to it whenever you hit a new issue.

### SSH & Authentication

1. **Tailscale SSH conflicts with regular SSH keys for the collector.**
   - **Problem:** The collector uses paramiko (regular SSH keys). When Tailscale SSH is enabled on a node, it takes over port 22 for tailnet connections and asks for tailnet-identity approval instead of using the regular key. This blocks the collector.
   - **Fix:** Disable Tailscale SSH on nodes where the collector needs regular-key access: `sudo tailscale up --ssh=false --accept-risk=lose-ssh`. Regular SSH keys then work cleanly.
   - **Lesson:** Don't mix Tailscale SSH and regular-key SSH on the same node when a paramiko-based collector is used. Pick one auth path per node.

2. **SSH users differ per node.**
   - **Problem:** The SSH user is not consistent across the fleet (chris, christof21, christaylor, office, root).
   - **Fix:** Store the correct user per node in `config.yaml`. Check `~/.ssh/config` for the existing user mapping.

3. **`tailscale ssh` host-key verification quirk.**
   - **Problem:** `tailscale ssh` checks host keys against the FQDN (`node.tailnet.ts.net`) but normal SSH adds keys under the IP, causing "Host key verification failed."
   - **Fix:** Not fully resolved; avoid relying on `tailscale ssh` for the collector. Use regular SSH keys instead.

4. **Tailscale SSH admin approval required.**
   - **Problem:** Enabling Tailscale SSH on some nodes prints a URL requiring admin approval in the Tailscale console.
   - **Fix:** The user must visit the URL and approve. This is a one-time manual step.

### Deployment

5. **`vite preview` does not proxy `/api`.**
   - **Problem:** The dev-server proxy is dev-only. In production, `vite preview` doesn't forward `/api` to the backend.
   - **Fix:** Serve the built frontend directly from FastAPI. Mount `/assets` as static and serve `index.html` at `/`. Single service on one port.

6. **Python 3.14 has no prebuilt wheels for pydantic-core.**
   - **Problem:** On bleeding-edge Python, older pydantic fails to build from source.
   - **Fix:** Use `--only-binary :all:` and a recent pydantic (>=2.13) that has prebuilt wheels.

7. **`declare` associative arrays fail in `/bin/sh` (dash).**
   - **Problem:** Shell scripts using bash associative arrays fail on Debian's default `dash`.
   - **Fix:** Use POSIX-compatible loops or a simple `push_key` function instead of `declare -A`.

8. **rsync not available on fresh VMs.**
   - **Problem:** Deploying the project to a fresh VM failed because rsync isn't installed.
   - **Fix:** Use `tar czf - | ssh host 'tar xzf -'` to copy the project over SSH.

9. **Some nodes run SSH on non-standard ports.**
   - **Problem:** `mediaserver` runs SSH on port 2053, not 22. The collector failed to connect until the port was specified.
   - **Fix:** The collector and `NodeConfig` now support a per-node `port` field. Set it in `config.yaml` for nodes with custom SSH ports.

10. **Some nodes have minimal `authorized_keys`.**
    - **Problem:** `openclaw-1` only had 3 keys (macbook, github, fleet-manager). The collector key had to be added manually by the user.
    - **Fix:** Check each node's `authorized_keys` and add the collector key manually where needed. Some nodes may not accept automated key push.

11. **Tailscale SSH can be disabled without sudo on some nodes.**
    - **Problem:** Some nodes require sudo to disable Tailscale SSH, but others allow `tailscale up --ssh=false --accept-risk=lose-ssh` directly without sudo.
    - **Fix:** Try the command without sudo first; fall back to sudo if needed.

12. **WebSocket route defined in `main.py` gets rejected with 403.**
    - **Problem:** A FastAPI WebSocket route (`@app.websocket`) defined directly in `main.py` was rejected with HTTP 403 during the handshake, even though the identical logic worked when defined in a separate module.
    - **Fix:** Define the WebSocket route in a separate module (`terminal.py`) and register it via a `register_terminal_routes(app)` function. This avoids the 403 handshake rejection.
    - **Lesson:** When a WebSocket route 403s but works in isolation, move it out of the main app module.

13. **Interactive SSH terminal via xterm.js + WebSocket.**
    - **Feature:** The node detail modal has an "Open SSH" button that opens a live terminal (xterm.js) connected to the node over a WebSocket (`/ws/terminal/{node_name}`). The backend bridges the WebSocket to a paramiko SSH session using the per-node user from `config.yaml` and the collector key.
    - **Message protocol:** Client sends `{"type":"input","data":...}` and `{"type":"resize","cols","rows"}`; server sends `{"type":"output","data":...}` and `{"type":"exit","code","error"}`.

14. **Do NOT remove the CORS middleware — it breaks browser POST requests.**
    - **Problem:** When debugging the WebSocket 403, the CORS middleware was removed. This silently broke the browser's POST `/api/collect` — the browser sends a CORS preflight `OPTIONS` request, which got rejected with 405, so the actual POST never happened and the frontend showed "Failed to fetch."
    - **Fix:** Re-add the CORS middleware (`allow_origins=["*"]`, `allow_methods=["*"]`, `allow_headers=["*"]`). The WebSocket 403 was a separate issue (route defined in `main.py`), NOT caused by CORS.
    - **Lesson:** The CORS middleware is required for browser POST requests (preflight). Removing it to fix an unrelated issue breaks POSTs. Keep it. The WebSocket 403 fix was moving the route to `terminal.py`, not removing CORS.

15. **Collection should be asynchronous (returns fast, polls for results).**
    - **Problem:** The synchronous `/api/collect` took ~8-9s (SSHing into all 9 nodes). The browser connection dropped before the response completed, causing "Failed to fetch."
    - **Fix:** Make `/api/collect` kick off collection in a background task and return immediately (`{"status":"started"}`). The frontend polls `/api/nodes` every 2s until all nodes report back.
    - **Lesson:** Long-running requests over the tailnet can be dropped by the browser. Return fast and poll for results instead of holding a long-lived request open.

---

## End-to-End Testing (run after each turn of development)

Based on the stack (FastAPI backend, paramiko collector, React frontend, SSH over tailnet), run these tests after each development turn:

### 1. Backend API Tests
```bash
# From the backend directory
cd backend
# Start the server
.venv/bin/uvicorn app.main:app --port 8011 &
# Health check
curl -s http://localhost:8011/health
# Expect: {"status":"ok"}

# List nodes
curl -s http://localhost:8011/api/nodes
# Expect: JSON with all nodes from config.yaml

# Collect from nodes
curl -s -X POST http://localhost:8011/api/collect
# Expect: collected count + node data
```

### 2. Collector Connectivity
```bash
# From fleet-manager, test each node in config.yaml
ssh -o BatchMode=yes -o ConnectTimeout=6 <user>@<host> "hostname"
# Expect: the node's hostname returned
```
**Acceptance:** At least the reachable nodes return their hostname. Note any nodes blocked by Tailscale SSH or auth.

### 3. Frontend Build
```bash
cd frontend
npm run build
# Expect: builds successfully, no errors
```

### 4. Full Stack (single service)
```bash
# Backend serves both API and frontend
curl -s http://localhost:8011/ | grep "<div id=\"root\">"
# Expect: the React app HTML

curl -s http://localhost:8011/api/nodes
# Expect: node JSON
```

### 5. Frontend → Backend via Proxy (dev)
```bash
cd frontend && npm run dev
curl -s http://localhost:5173/api/nodes
# Expect: node JSON (dev proxy works)
```

### 6. Constellation Renders (manual)
- Open `http://fleet-manager:8011/` in a browser
- Expect: the constellation map renders with all nodes as orbs
- Expect: the HEART node (`mini-ubuntu` or fleet-manager) has a pulsing amber ring
- Expect: online nodes glow, offline nodes are dimmed

### 7. Regression: Existing SSH still works
- Confirm normal SSH key access still works to all nodes (Tailscale SSH changes didn't break anything)

---

## Deployment Checklist (after changes)

1. Build frontend: `cd frontend && npm run build`
2. Copy project to fleet-manager: `tar czf - --exclude=.venv --exclude=node_modules --exclude=.git . | ssh chris@fleet-manager 'tar xzf - -C ~/fleet-dashboard'`
3. Restart backend: `ssh chris@fleet-manager 'sudo systemctl restart fleet-backend'`
4. Verify: `curl -s http://fleet-manager:8011/health`
