import React, { useEffect, useState, useCallback, useMemo, useRef, lazy, Suspense } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import {
  HEART_NAMES, HEART_POS, MESH, REMOTE_NODES,
  STATUS_LABEL, STATUS_SHORT,
  nodeStatus, typeLabel, orbRadius, nodePos, osLabel,
} from './layout'

const Flythrough = lazy(() => import('./Flythrough'))

function roleColor(node) {
  if (REMOTE_NODES.has(node.name)) return '#f0b429'
  if (node.group === 'proxmox') return '#f0a45d'
  if (node.group === 'vm') return '#69a8ff'
  if (node.os_type === 'macos') return '#bb91ff'
  return '#54d6d0'
}

function Constellation({ nodes, onSelect }) {
  const [hover, setHover] = useState(null)
  const names = useMemo(() => nodes.map((n) => n.name), [nodes])
  const posOf = useCallback((name) => nodePos(name, names), [names])
  const heartNode = nodes.find((n) => HEART_NAMES.has(n.name))

  const spokeLines = names.map((name) => {
    if (HEART_NAMES.has(name)) return null
    const p = posOf(name)
    const active = hover === name
    return (
      <line key={`spoke-${name}`} x1={HEART_POS.x} y1={HEART_POS.y} x2={p.x} y2={p.y}
        stroke="#3a4a66" strokeWidth={active ? 0.7 : 0.28}
        strokeLinecap="round" />
    )
  })

  const peerLines = MESH.map(([a, b], i) => {
    if (!names.includes(a) || !names.includes(b)) return null
    const pa = posOf(a), pb = posOf(b)
    const active = hover === a || hover === b
    return (
      <line key={`mesh-${i}`} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
        stroke="#3a4a66" strokeWidth={active ? 0.8 : 0.4}
        strokeLinecap="round" />
    )
  })

  const orbs = nodes.filter((node) => !HEART_NAMES.has(node.name)).map((node) => {
    const pos = posOf(node.name)
    const r = orbRadius(node) * 0.58
    const isHover = hover === node.name
    const color = roleColor(node)

    return (
      <g key={node.name}
        transform={`translate(${pos.x}, ${pos.y})`}
        onMouseEnter={() => setHover(node.name)}
        onMouseLeave={() => setHover(null)}
        onClick={() => onSelect(node)}
        style={{ cursor: 'pointer' }}
      >
        <circle r={r} fill={color} opacity={node.online === false ? 0.35 : 0.92} />
        {REMOTE_NODES.has(node.name) && <circle r={r + 2.1} fill="none" stroke="#f0b429" strokeWidth="0.5" strokeDasharray="1.3 1.2" />}
        <text y={5.4} textAnchor="middle" fontSize="2.45" fill={isHover ? '#e8ecf4' : '#c6cfde'} fontFamily="IBM Plex Mono, monospace" paintOrder="stroke" stroke="#090d16" strokeWidth="0.75" strokeLinejoin="round">
          {node.name}
        </text>
      </g>
    )
  })

  return (
    <svg viewBox="0 0 100 100" className="constellation" preserveAspectRatio="xMidYMid meet">
      {spokeLines}
      {peerLines}
      {heartNode && (
        <g className="heart" transform={`translate(${HEART_POS.x}, ${HEART_POS.y})`} onClick={() => onSelect(heartNode)} style={{ cursor: 'pointer' }}>
          <circle r="8.2" fill="rgba(240,180,41,.07)" stroke="rgba(240,180,41,.25)" strokeWidth="0.45" />
          <circle r="6.8" fill="none" stroke="#f0b429" strokeWidth="0.45" strokeDasharray="1.5 1.4" />
          <circle r="4.6" fill="#f0b429" />
          <text y="11" textAnchor="middle" fontSize="2.3" fill="#f0c76b" fontFamily="IBM Plex Mono, monospace">fleet-manager · HEART</text>
        </g>
      )}
      {orbs}
    </svg>
  )
}

function SummaryStrip({ nodes }) {
  const online = nodes.filter((n) => n.online).length
  const total = nodes.length
  const updates = nodes.reduce((s, n) => s + (n.pending_updates || 0), 0)
  const memTotal = nodes.reduce((s, n) => s + (n.mem_total_gb || 0), 0)
  const cores = nodes.reduce((s, n) => s + (n.cpu_count || 0), 0)

  return (
    <div className="summary-strip">
      <div className="summary-tile">
        <div className="stat-value ok">{online}/{total}</div>
        <div className="stat-label">Online</div>
      </div>
      <div className="summary-tile">
        <div className={`stat-value ${updates > 0 ? 'warn' : ''}`}>{updates}</div>
        <div className="stat-label">Pending updates</div>
      </div>
      <div className="summary-tile">
        <div className="stat-value">{Math.round(memTotal)}G</div>
        <div className="stat-label">Total memory</div>
      </div>
      <div className="summary-tile">
        <div className="stat-value">{cores}</div>
        <div className="stat-label">Total cores</div>
      </div>
    </div>
  )
}

function relTime(iso) {
  if (!iso) return ''
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// ---- Sortable node table (the scannable list under the graph) ----
function NodeTable({ nodes, onSelect }) {
  const [sortKey, setSortKey] = useState('updates')
  const [sortDir, setSortDir] = useState(-1)
  const [filter, setFilter] = useState('all')

  const severity = { offline: 0, stale: 1, ok: 2, warn: 3 }
  const columns = [
    { key: 'name', label: 'Name' },
    { key: 'role', label: 'Role' },
    { key: 'status', label: 'Status' },
    { key: 'updates', label: 'Updates' },
    { key: 'mem', label: 'Memory' },
    { key: 'uptime', label: 'Uptime' },
  ]
  const sortValue = {
    name: (n) => n.name.toLowerCase(),
    role: (n) => typeLabel(n),
    status: (n) => severity[nodeStatus(n)],
    updates: (n) => n.pending_updates || 0,
    mem: (n) => (n.online ? (n.mem_used_gb || 0) : -1),
    uptime: (n) => n.uptime || '',
  }

  const filtered = useMemo(() => {
    let list = nodes
    if (filter === 'online') list = nodes.filter((n) => n.online)
    else if (filter === 'warn') list = nodes.filter((n) => nodeStatus(n) === 'warn')
    else if (filter === 'offline') list = nodes.filter((n) => !n.online)
    else if (filter === 'stale') list = nodes.filter((n) => nodeStatus(n) === 'stale')
    return [...list].sort((a, b) => {
      const va = sortValue[sortKey](a)
      const vb = sortValue[sortKey](b)
      if (va < vb) return -sortDir
      if (va > vb) return sortDir
      return a.name.localeCompare(b.name)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, sortKey, sortDir, filter])

  const toggleSort = (key) => {
    if (key === sortKey) setSortDir((d) => -d)
    else {
      setSortKey(key)
      setSortDir(key === 'name' || key === 'role' || key === 'uptime' ? 1 : -1)
    }
  }

  const filters = [
    ['all', `All (${nodes.length})`],
    ['online', `Online (${nodes.filter((n) => n.online).length})`],
    ['warn', `Updates (${nodes.filter((n) => nodeStatus(n) === 'warn').length})`],
    ['offline', `Offline (${nodes.filter((n) => !n.online).length})`],
    ['stale', `Stale (${nodes.filter((n) => nodeStatus(n) === 'stale').length})`],
  ]

  return (
    <div className="node-table-panel">
      <div className="table-toolbar">
        <span className="panel-title">Nodes</span>
        <div className="table-filters">
          {filters.map(([key, label]) => (
            <button
              key={key}
              className={`chip ${filter === key ? 'active' : ''}`}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <table className="node-table">
        <thead>
          <tr>
            {columns.map(({ key, label }) => (
              <th key={key} onClick={() => toggleSort(key)} className={sortKey === key ? 'sorted' : ''}>
                {label}
                {sortKey === key && <span className="sort-arrow">{sortDir === 1 ? ' ▲' : ' ▼'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filtered.map((n) => {
            const st = nodeStatus(n)
            return (
              <tr key={n.name} onClick={() => onSelect(n)}>
                <td className="cell-name">{n.name}</td>
                <td>{typeLabel(n)}</td>
                <td>
                  <span className={`status-cell ${st}`}>
                    <span className={`dot ${st}`} />
                    {STATUS_SHORT[st]}
                  </span>
                </td>
                <td className={`mono ${n.pending_updates > 0 ? 'warn' : ''}`}>
                  {n.online ? (n.pending_updates ?? 0) : '—'}
                </td>
                <td className="mono">
                  {n.mem_used_gb ? `${n.mem_used_gb}/${n.mem_total_gb}G` : '—'}
                </td>
                <td className="mono cell-uptime">{n.uptime || '—'}</td>
              </tr>
            )
          })}
          {filtered.length === 0 && (
            <tr><td colSpan={columns.length} className="empty-row">No nodes match this filter</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function lastUpdateLabel(last) {
  if (!last) return '—'
  const state = last.success
    ? 'OK'
    : (last.error || `Failed (exit ${last.exit_code ?? '?'})`)
  const when = last.finished_at ? relTime(last.finished_at) : ''
  return when ? `${state} · ${when}` : state
}

function tailOutput(text, lines = 16) {
  if (!text) return ''
  return text.trim().split('\n').slice(-lines).join('\n')
}

// ---- Node detail popup (modal) ----
function NodeDetail({ node, intent, onClose, onNodes }) {
  const status = nodeStatus(node)
  const isHeart = HEART_NAMES.has(node.name)
  const [showTerminal, setShowTerminal] = useState(false)
  const [localUpdating, setLocalUpdating] = useState(false)
  const [updateMsg, setUpdateMsg] = useState(null)
  const [confirmPkgs, setConfirmPkgs] = useState(null) // null | {loading} | {packages, error}
  const updating = localUpdating || !!node.updating
  const bootedRef = useRef(false)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // launched from the fsn flyover: SSH cube opens the terminal,
  // UPDATE cube opens the package-list confirm immediately
  useEffect(() => {
    if (bootedRef.current) return
    bootedRef.current = true
    if (intent === 'ssh') setShowTerminal(true)
    else if (intent === 'update') startUpdate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Step 1: fetch the pending package list and show it for confirmation
  const startUpdate = async () => {
    if (!node.online || updating) return
    setConfirmPkgs({ loading: true })
    try {
      const res = await fetch(`/api/updates/${encodeURIComponent(node.name)}?t=${Date.now()}`)
      const body = await res.json()
      if (res.ok && body.success) {
        const count = body.pending_updates ?? (body.packages || []).length
        onNodes((current) => current.map((n) => n.name === node.name
          ? { ...n, pending_updates: count, updates_checked_at: body.updates_checked_at }
          : n))
      }
      setConfirmPkgs({ packages: body.packages || [], error: !res.ok || !body.success ? (body.error || `HTTP ${res.status}`) : null })
    } catch (e) {
      setConfirmPkgs({ packages: [], error: e.message || 'Could not fetch package list' })
    }
  }

  const runUpdate = async () => {
    if (!node.online || updating) return
    setConfirmPkgs(null)
    setLocalUpdating(true)
    setUpdateMsg(null)
    const started = Date.now()
    try {
      const res = await fetch(`/api/update/${encodeURIComponent(node.name)}?t=${Date.now()}`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.success === false) {
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      let attempts = 0
      const tick = async () => {
        try {
          const r = await fetch('/api/nodes')
          const d = await r.json()
          const list = d.nodes || []
          onNodes(list)
          const fresh = list.find((n) => n.name === node.name)
          const finishedAt = fresh?.last_update?.finished_at
          const finishedAfterStart = finishedAt && new Date(finishedAt).getTime() >= started - 2000
          attempts += 1
          if ((fresh && fresh.updating === false && finishedAfterStart) || attempts >= 180) {
            setLocalUpdating(false)
            if (fresh?.last_update?.success) {
              setUpdateMsg({ ok: true, text: 'Updates installed' })
            } else if (fresh?.last_update) {
              setUpdateMsg({
                ok: false,
                text: fresh.last_update.error || `Update failed (exit ${fresh.last_update.exit_code})`,
              })
            } else {
              setUpdateMsg({ ok: false, text: 'Update timed out' })
            }
            return
          }
        } catch {
          // keep polling through transient fetch errors
        }
        setTimeout(tick, 2000)
      }
      tick()
    } catch (e) {
      setLocalUpdating(false)
      setUpdateMsg({ ok: false, text: e.message || 'Update failed' })
    }
  }

  if (!node) return null

  const last = node.last_update

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className="modal-title-row">
            <span className={`status-dot ${status}`} />
            <h2 className="modal-title">{node.name}</h2>
            {isHeart && <span className="type-badge controller">Controller</span>}
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="modal-status">
          <span className={`status-pill`}>
            <span className={`dot ${status}`} />
            {STATUS_LABEL[status]}
          </span>
          <span className="type-badge">{typeLabel(node)}</span>
        </div>

        <dl className="detail-list">
          <div className="detail-row">
            <dt>OS</dt>
            <dd>{osLabel(node)}</dd>
          </div>
          <div className="detail-row">
            <dt>Architecture</dt>
            <dd>{node.arch || '—'}</dd>
          </div>
          <div className="detail-row">
            <dt>IP</dt>
            <dd>{node.ip || '—'}</dd>
          </div>
          <div className="detail-row">
            <dt>CPU</dt>
            <dd>{node.cpu_model || `${node.cpu_count || '—'} cores`}</dd>
          </div>
          <div className="detail-row">
            <dt>Cores</dt>
            <dd>{node.cpu_count ?? '—'}</dd>
          </div>
          <div className="detail-row">
            <dt>Memory</dt>
            <dd>{node.mem_used_gb ? `${node.mem_used_gb}G used / ${node.mem_total_gb}G` : (node.mem_total_gb ? `${node.mem_total_gb}G total` : '—')}</dd>
          </div>
          <div className="detail-row">
            <dt>Disk</dt>
            <dd>{node.disk_used_gb ? `${node.disk_used_gb}G / ${node.disk_total_gb}G` : '—'}</dd>
          </div>
          <div className="detail-row">
            <dt>Uptime</dt>
            <dd>{node.uptime || '—'}</dd>
          </div>
          <div className="detail-row">
            <dt>Pending updates</dt>
            <dd className={status === 'warn' ? 'warn' : ''}>{node.pending_updates ?? '—'}</dd>
          </div>
          <div className="detail-row">
            <dt>Last update</dt>
            <dd className={last && !last.success ? 'warn' : ''}>{lastUpdateLabel(last)}</dd>
          </div>
        </dl>

        {updateMsg && (
          <div className={`update-msg ${updateMsg.ok ? 'ok' : 'err'}`}>{updateMsg.text}</div>
        )}
        {last && !last.success && last.output && (
          <pre className="update-output">{tailOutput(last.output)}</pre>
        )}

        <div className="modal-actions">
          {node.online && (
            <button className="btn ghost" onClick={() => setShowTerminal((v) => !v)}>
              {showTerminal ? 'Close SSH' : 'Open SSH'}
            </button>
          )}
          {node.online && !confirmPkgs && (
            <button className="btn" onClick={startUpdate} disabled={updating}>
              {updating && <span className="spinner" />}
              {updating
                ? 'Updating…'
                : (node.pending_updates ? `Update (${node.pending_updates})` : 'Update')}
            </button>
          )}
        </div>

        {confirmPkgs && (
          <div className="confirm-panel">
            <div className="confirm-title">Run updates on {node.name}?</div>
            {confirmPkgs.loading ? (
              <div className="confirm-loading"><span className="spinner spinner-dark" />Fetching package list…</div>
            ) : (
              <>
                <div className={`confirm-sub ${confirmPkgs.error ? 'err' : ''}`}>
                  {confirmPkgs.error
                    ? `Could not list packages: ${confirmPkgs.error}`
                    : confirmPkgs.packages.length === 0
                      ? 'No pending packages found — you can still run an upgrade.'
                      : `Will upgrade ${confirmPkgs.packages.length} package${confirmPkgs.packages.length === 1 ? '' : 's'}:`}
                </div>
                {!confirmPkgs.error && confirmPkgs.packages.length > 0 && (
                  <pre className="update-output">{confirmPkgs.packages.join('\n')}</pre>
                )}
                <div className="modal-actions">
                  <button className="btn ghost" onClick={() => setConfirmPkgs(null)}>Cancel</button>
                  <button className="btn danger" onClick={runUpdate}>Run update</button>
                </div>
              </>
            )}
          </div>
        )}

        {showTerminal && node.online && (
          <SSHTerminal node={node} />
        )}
      </div>
    </div>
  )
}

// ---- Interactive SSH terminal (xterm.js + WebSocket) ----
function SSHTerminal({ node }) {
  const containerRef = useRef(null)
  const termRef = useRef(null)
  const wsRef = useRef(null)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'IBM Plex Mono, monospace',
      theme: {
        background: '#0b0f1a',
        foreground: '#e8ecf4',
        cursor: '#f0b429',
        selectionBackground: '#1a2233',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()
    termRef.current = term

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/terminal/${node.name}`)
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      term.focus()
      // send initial size
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.type === 'output') {
        term.write(msg.data)
      } else if (msg.type === 'exit') {
        setConnected(false)
        if (msg.error) setError(msg.error)
        term.write(`\r\n\x1b[31m[connection closed: ${msg.error || 'session ended'}]\x1b[0m\r\n`)
      }
    }
    ws.onerror = () => {
      setConnected(false)
      setError('WebSocket error')
    }
    ws.onclose = () => {
      setConnected(false)
    }

    const onData = (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }))
      }
    }
    term.onData(onData)

    const onResize = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      ws.close()
      term.dispose()
    }
  }, [node.name])

  return (
    <div className="ssh-terminal">
      <div className="ssh-terminal-bar">
        <span className={`ssh-dot ${connected ? 'ok' : 'offline'}`} />
        <span className="ssh-label">{node.user}@{node.host}</span>
        {error && <span className="ssh-error">{error}</span>}
      </div>
      <div className="ssh-terminal-body" ref={containerRef} />
    </div>
  )
}

const AGENT_TOOL_COLUMNS = [
  ['claude', 'Claude Code'], ['codex', 'Codex'], ['pi', 'Pi'], ['grok', 'Grok Build'],
]

function agentCellLabel(cell, dryRun) {
  if (!cell?.installed) return 'Not installed'
  if (cell.state === 'behind') return 'Behind fleet'
  if (cell.state === 'fail') return cell.update || 'Update failed'
  if (cell.state === 'skip') return 'No update path'
  if (cell.state === 'ok') return 'Updated'
  return dryRun ? 'At fleet version' : 'Already current'
}

function AgentUpdatePanel({ nodes }) {
  const [run, setRun] = useState(null)
  const [confirmUpdate, setConfirmUpdate] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState(null)
  const macbook = nodes.find((n) => n.name === 'macbook')
  const running = run?.status === 'running'

  useEffect(() => {
    let cancelled = false
    let timer
    const poll = async () => {
      try {
        const res = await fetch('/api/agent-updater/status')
        const data = await res.json()
        if (cancelled) return
        setRun(data)
        if (data.status === 'running') timer = setTimeout(poll, 2000)
      } catch {
        if (!cancelled) {
          setError('Could not read agent updater status')
          timer = setTimeout(poll, 2000)
        }
      }
    }
    poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [run?.status, run?.run_id])

  const startRun = async (dryRun) => {
    setStarting(true)
    setError(null)
    setConfirmUpdate(false)
    try {
      const res = await fetch('/api/agent-updater/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dry_run: dryRun }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      setRun(data)
    } catch (e) {
      setError(e.message || 'Could not start agent update')
    } finally {
      setStarting(false)
    }
  }

  return (
    <section className="agent-panel">
      <div className="agent-panel-head">
        <div className="agent-heading">
          <span className="agent-mark">⌘</span>
          <div>
            <div className="agent-kicker">Fleet maintenance</div>
            <h2>Agent toolchain</h2>
          </div>
        </div>
        <span className={`agent-state ${running ? 'running' : run?.status === 'complete' ? 'complete' : run?.status === 'failed' ? 'failed' : ''}`}>
          {running ? 'Running' : run?.status === 'complete' ? (run.dry_run ? 'Preview complete' : (run.summary?.problems ? 'Review results' : 'Run complete')) : run?.status === 'failed' ? 'Failed' : 'Ready'}
        </span>
      </div>
      <p className="agent-description">
        Inspect and update Claude Code, Codex, Pi and Grok Build using the version-controlled MacBook fleet script.
        It runs locally on MacBook and follows that Mac’s SSH host list.
      </p>
      <div className="agent-tools" aria-label="Managed CLI tools">
        {['Claude Code', 'Codex', 'Pi', 'Grok Build'].map((tool) => <span key={tool} className="agent-tool">{tool}</span>)}
        <span className="agent-scope">MacBook + SSH hosts</span>
      </div>

      {confirmUpdate ? (
        <div className="agent-confirm">
          <div>
            <strong>Update every detected tool?</strong>
            <p>This runs the script’s native, Homebrew, npm or tool-specific updater on MacBook and its SSH hosts.</p>
          </div>
          <div className="agent-actions">
            <button className="btn ghost" onClick={() => setConfirmUpdate(false)}>Cancel</button>
            <button className="btn danger" onClick={() => startRun(false)} disabled={starting || running}>
              {starting ? 'Starting…' : 'Confirm fleet update'}
            </button>
          </div>
        </div>
      ) : (
        <div className="agent-actions">
          <button className="btn ghost" onClick={() => startRun(true)} disabled={starting || running || !macbook?.online}>
            {running && run?.dry_run && <span className="spinner" />}
            Preview scan
          </button>
          <button className="btn" onClick={() => setConfirmUpdate(true)} disabled={starting || running || !macbook?.online}>
            {running && !run?.dry_run && <span className="spinner" />}
            Update toolchain
          </button>
        </div>
      )}

      {!macbook?.online && <div className="agent-hint">MacBook must be reachable; collect the fleet first.</div>}
      {error && <div className="agent-error">{error}</div>}
      {run?.error && <div className="agent-error">{run.error}</div>}
      {running && <div className="agent-running-note">The sweep can take several minutes. Updates run in parallel across SSH hosts.</div>}
      {run?.finished_at && (
        <div className="agent-run-meta">
          {run.dry_run ? 'Preview' : 'Update run'} · finished {relTime(run.finished_at)}
        </div>
      )}
      {run?.summary && (
        <div className="agent-summary">
          <div><strong>{run.summary.reachable}/{run.summary.hosts}</strong><span>Reachable</span></div>
          <div><strong>{run.summary.installed}</strong><span>Tools found</span></div>
          <div className={run.summary.behind ? 'warn' : ''}><strong>{run.summary.behind}</strong><span>Behind fleet</span></div>
          <div className={run.summary.problems ? 'err' : ''}><strong>{run.summary.problems}</strong><span>Needs attention</span></div>
        </div>
      )}
      {run?.hosts?.length > 0 && (
        <div className="agent-table-wrap">
          <table className="agent-table">
            <thead>
              <tr><th>Host</th>{AGENT_TOOL_COLUMNS.map(([key, label]) => <th key={key}>{label}</th>)}</tr>
            </thead>
            <tbody>
              {run.hosts.map((host) => (
                <tr key={host.name} className={!host.reachable ? 'unreachable' : ''}>
                  <th scope="row">
                    <span className={`agent-host-dot ${host.reachable ? 'online' : ''}`} />
                    <span>{host.name}</span>
                  </th>
                  {!host.reachable ? (
                    <td colSpan={AGENT_TOOL_COLUMNS.length} className="agent-host-unreachable">{host.error || 'Host unreachable'}</td>
                  ) : AGENT_TOOL_COLUMNS.map(([key]) => {
                    const cell = host.tools.find((tool) => tool.name === key)
                    return (
                      <td key={key}>
                        <div className={`agent-cell ${cell?.state || 'none'}`}>
                          <strong>{cell?.installed ? (cell.version || cell.before || 'Unknown') : '—'}</strong>
                          <span>{agentCellLabel(cell, run.dry_run)}</span>
                          {cell?.installed && <small>{cell.method}</small>}
                        </div>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(run?.output || run?.error_output) && (
        <details className="agent-raw">
          <summary>Raw script report and per-host log location</summary>
          <pre className="agent-output">{[run.output, run.error_output].filter(Boolean).join('\n')}</pre>
        </details>
      )}
    </section>
  )
}

function App() {
  const [nodes, setNodes] = useState([])
  const [loading, setLoading] = useState(true)
  const [collecting, setCollecting] = useState(false)
  const [error, setError] = useState(null)
  const [toast, setToast] = useState(null)
  const [selected, setSelected] = useState(null) // {name, intent: 'ssh'|'update'|null}
  const [flyover, setFlyover] = useState(false)

  const fetchNodes = useCallback(async () => {
    try {
      const res = await fetch('/api/nodes')
      const data = await res.json()
      setNodes(data.nodes || [])
      setError(null)
    } catch {
      setError('Could not reach the backend API')
    } finally {
      setLoading(false)
    }
  }, [])

  const collect = useCallback(async () => {
    setCollecting(true)
    try {
      const res = await fetch('/api/collect?t=' + Date.now(), { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // Poll the run state, not cached node values: cached results may be old.
      const runId = (await res.json()).run_id
      let attempts = 0
      const poll = async () => {
        try {
          const [statusRes, nodesRes] = await Promise.all([
            fetch('/api/collect/status'),
            fetch('/api/nodes'),
          ])
          if (!statusRes.ok || !nodesRes.ok) throw new Error('Could not check collection progress')
          const status = await statusRes.json()
          const data = await nodesRes.json()
          setNodes(data.nodes || [])
          attempts += 1
          if (status.run_id !== runId) throw new Error('Collection run was replaced')
          if (status.status === 'complete') {
            setCollecting(false)
            setToast({ type: 'ok', msg: `Collected ${status.completed}/${status.total} nodes` })
            setTimeout(() => setToast(null), 3000)
          } else if (status.status === 'failed' || attempts >= 180) {
            throw new Error(status.error || 'Collection timed out')
          } else {
            setTimeout(poll, 2000)
          }
        } catch (e) {
          setError(e.message || 'Collection failed')
          setToast({ type: 'error', msg: e.message || 'Collection failed' })
          setCollecting(false)
        }
      }
      poll()
    } catch (e) {
      const msg = e.message || 'Collection failed'
      setError(msg)
      setToast({ type: 'error', msg })
      setCollecting(false)
      setTimeout(() => setToast(null), 3000)
    }
  }, [])

  useEffect(() => { fetchNodes() }, [fetchNodes])

  // Re-render every 30s so relative times ("3m ago") stay fresh
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30000)
    return () => clearInterval(id)
  }, [])

  const online = nodes.filter((n) => n.online).length
  const anyOffline = online < nodes.length
  const latestCollectedAt = nodes
    .map((n) => n.collected_at || n.last_seen)
    .filter(Boolean)
    .sort()
    .at(-1)

  const selectedNode = useMemo(
    () => nodes.find((n) => n.name === selected?.name) || null,
    [nodes, selected]
  )

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">✦</span>
          <span className="brand-name">Fleet</span>
        </div>
        <div className="topbar-actions">
          <span className="status-pill">
            <span className={`dot ${anyOffline ? 'warn' : 'ok'}`} />
            {online}/{nodes.length} online
          </span>
          {latestCollectedAt && (
            <span className="last-updated">checked {relTime(latestCollectedAt)}</span>
          )}
          <button className="btn" onClick={collect} disabled={collecting}>
            {collecting && <span className="spinner" />}
            {collecting ? 'Collecting…' : 'Collect'}
          </button>
        </div>
      </header>

      <main className="content">
        <div className="page-head">
          <h1 className="page-title">Fleet</h1>
          <div className="page-sub">sapsucker-godzilla.ts.net</div>
        </div>

        <SummaryStrip nodes={nodes} />

        <div className="constellation-panel">
          <div className="panel-title-row">
            <span className="panel-title">Network · role colours · click a node for details</span>
            <button className="btn ghost flyover-btn" onClick={() => setFlyover(true)}>
              ✦ Flyover
            </button>
          </div>
          <div className="orbit-legend" aria-label="Map legend">
            <span><i className="role-swatch proxmox" />Proxmox</span>
            <span><i className="role-swatch vm" />VMs</span>
            <span><i className="role-swatch host" />Hosts</span>
            <span><i className="role-swatch mac" />macOS</span>
            <span><i className="role-swatch remote" />Remote</span>
            <span className="legend-note">dim = offline</span>
            <span className="legend-note"><i className="mesh-swatch" />tailnet links</span>
          </div>
          {loading ? (
            <div className="constellation-loading">Charting the sky…</div>
          ) : (
            <Constellation nodes={nodes} onSelect={(n) => setSelected({ name: n.name })} />
          )}
        </div>

        {!loading && (
          <NodeTable nodes={nodes} onSelect={(n) => setSelected({ name: n.name })} />
        )}

        {!loading && <AgentUpdatePanel nodes={nodes} />}

        {error && <div className="error-banner">{error}</div>}
        {toast && <div className="error-banner" style={{ borderColor: toast.type === 'error' ? 'var(--danger)' : 'var(--ok)' }}>{toast.msg}</div>}
      </main>

      {flyover && (
        <Suspense fallback={null}>
          <Flythrough
            nodes={nodes}
            onSelect={(name, intent) => setSelected({ name, intent })}
            onClose={() => setFlyover(false)}
          />
        </Suspense>
      )}

      {selectedNode && (
        <NodeDetail
          node={selectedNode}
          intent={selected?.intent || null}
          onClose={() => setSelected(null)}
          onNodes={setNodes}
        />
      )}
    </div>
  )
}

export default App
