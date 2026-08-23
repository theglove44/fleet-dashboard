import React, { useEffect, useState, useCallback, useMemo, useRef, lazy, Suspense } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import {
  HEART_NAMES, HEART_POS, LAYOUT, MESH,
  STATUS_COLOR, STATUS_LABEL, STATUS_SHORT,
  nodeStatus, typeLabel, orbRadius, nodePos, osLabel,
} from './layout'

const Flythrough = lazy(() => import('./Flythrough'))

function Constellation({ nodes, onSelect }) {
  const [hover, setHover] = useState(null)
  const names = useMemo(() => nodes.map((n) => n.name), [nodes])
  const posOf = useCallback((name) => nodePos(name, names), [names])
  const statusMap = useMemo(() => {
    const m = {}
    nodes.forEach((n) => { m[n.name] = nodeStatus(n) })
    return m
  }, [nodes])

  const spokeLines = names.map((name) => {
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

  const orbs = nodes.map((node) => {
    const pos = posOf(node.name)
    const status = statusMap[node.name]
    const isHeart = HEART_NAMES.has(node.name)
    const r = orbRadius(node)
    const isHover = hover === node.name
    const color = STATUS_COLOR[status]

    return (
      <g key={node.name}
        transform={`translate(${pos.x}, ${pos.y})`}
        onMouseEnter={() => setHover(node.name)}
        onMouseLeave={() => setHover(null)}
        onClick={() => onSelect(node)}
        style={{ cursor: 'pointer' }}
      >
        <circle r={r} fill={color} opacity={status === 'offline' ? 0.3 : 0.9} />
        {isHeart && <circle r={r + 3} fill="none" stroke={color} strokeWidth="0.5" strokeDasharray="1.5 1.5" />}
        <text y={r + 6} textAnchor="middle" fontSize="2.4" fill={isHover ? '#e8ecf4' : '#7c8698'} fontFamily="monospace">
          {node.name}
        </text>
      </g>
    )
  })

  return (
    <svg viewBox="0 0 100 100" className="constellation" preserveAspectRatio="xMidYMid meet">
      {spokeLines}
      {peerLines}
      <g className="heart" transform={`translate(${HEART_POS.x}, ${HEART_POS.y})`}>
        <circle r="2.1" fill="currentColor" />
        <circle className="heart-ring" r="3.6" fill="none" stroke="currentColor" strokeWidth="0.4" />
        <circle className="heart-ring delay" r="3.6" fill="none" stroke="currentColor" strokeWidth="0.4" />
      </g>
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

  const severity = { offline: 0, ok: 1, warn: 2 }
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
      setConfirmPkgs({ packages: body.packages || [], error: !body.success ? body.error : null })
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

function App() {
  const [nodes, setNodes] = useState([])
  const [loading, setLoading] = useState(true)
  const [collecting, setCollecting] = useState(false)
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
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
      // Collection is async now; poll for results
      let attempts = 0
      const poll = async () => {
        const r = await fetch('/api/nodes')
        const d = await r.json()
        setNodes(d.nodes || [])
        const nodes = d.nodes || []
        const collected = nodes.filter((n) => n.online || n.error).length
        attempts += 1
        if (collected === nodes.length || attempts >= 8) {
          setCollecting(false)
          setLastUpdated(new Date())
          setToast({ type: 'ok', msg: `Collected ${collected}/${nodes.length} nodes` })
          setTimeout(() => setToast(null), 3000)
        } else {
          setTimeout(poll, 2000)
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
          {lastUpdated && (
            <span className="last-updated">
              updated {Math.max(1, Math.round((Date.now() - lastUpdated.getTime()) / 60000))}m ago
            </span>
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
            <span className="panel-title">Network · size by role · click a node for details</span>
            <button className="btn ghost flyover-btn" onClick={() => setFlyover(true)}>
              ✦ Flyover
            </button>
          </div>
          {loading ? (
            <div className="constellation-loading">Charting the sky…</div>
          ) : (
            <Constellation nodes={nodes} onSelect={(n) => setSelected({ name: n.name })} />
          )}
          <div className="constellation-legend">
            <span className="legend-item"><span className="legend-dot ok" /> Online</span>
            <span className="legend-item"><span className="legend-dot warn" /> Updates</span>
            <span className="legend-item"><span className="legend-dot offline" /> Offline</span>
            <span className="legend-item"><span className="legend-line">——</span> Tailscale mesh</span>
          </div>
        </div>

        {!loading && (
          <NodeTable nodes={nodes} onSelect={(n) => setSelected({ name: n.name })} />
        )}

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
