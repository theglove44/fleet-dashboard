# Fleet Dashboard - Phase 1
# Agentless inventory: central box SSHes into each node and gathers facts.

## Requirements

- Python 3.11+
- SSH key-based access to all nodes over your tailnet
- Tailscale running on the central box

## Setup

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Configuration

Create `backend/config.yaml` (see `config.example.yaml`):

```yaml
nodes:
  - name: node-01
    host: node-01.tailnet-name.ts.net
    user: christof21
    os: ubuntu
    group: host
  - name: vm-01
    host: vm-01.tailnet-name.ts.net
    user: christof21
    os: ubuntu
    group: vm
```

## Run

```bash
source .venv/bin/activate
python -m app.main
```

The API will be available at `http://localhost:8000`.
