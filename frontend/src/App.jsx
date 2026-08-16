import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

const CONTROLLER = 'mini-ubuntu' // the collector/controller node

// ---- Node status semantics (state, not device type) ----
function nodeStatus(node) {
  if (!node.online) return 'offline'
  if ((node.pending_updates || 0) > 0) return 'warn'
  return 'ok'
}

// ---- Device type label ----
function typeLabel(node) {
  if (node.group === 'proxmox') return 'Proxmox'
  if (node.group === 'vm') return 'VM'
  return 'Host'
}

// ---- Constellation layout (hand-placed) ----
const LAYOUT = {
  'mini-ubuntu':   { x: 50, y: 50 },
  'proxmox-zen':   { x: 20, y: 20 },
  'proxmox-lan':   { x: 18, y: 80 },
  'loki':          { x: 80, y: 18 },
  'mediaserver':   { x: 82, y: 82 },
  'openclaw-1':    { x: 70, y: 50 },
  'tuckinandtalk': { x: 50, y: 18 },
  'macbook':       { x: 88, y: 50 },
  'stormbreaker':  { x: 32, y: 88 },
}
const MESH = [
  ['mini-ubuntu', 'proxmox-zen'],
  ['mini-ubuntu', 'proxmox-lan'],
  ['mini-ubuntu', 'loki'],
  ['mini-ubuntu', 'mediaserver'],
  ['mini-ubuntu', 'openclaw-1'],
  ['mini-ubuntu', 'tuckinandtalk'],
  ['mini-ubuntu', 'macbook'],
  ['mini-ubuntu', 'stormbreaker'],
  ['proxmox-zen', 'proxmox-lan'],
  ['loki', 'mediaserver'],
  ['macbook', 'stormbreaker'],
]

const STATUS_COLOR = { ok: '#3fb950', warn: '#f0b429', offline: '#6b7280' }
const STATUS_LABEL = { ok: 'Online', warn: 'Updates pending', offline: 'Offline' }

function Constellation({ nodes, onSelect }) {
  const [hover, setHover] = useState(null)
  const statusMap = useMemo(() => {
    const m = {}
    nodes.forEach((n) => { m[n.name] = nodeStatus(n) })
    return m
  }, [nodes])

  const lines = MESH.map(([a, b], i) => {
    const pa = LAYOUT[a], pb = LAYOUT[b]
    if (!pa || !pb) return null
    const active = hover === a || hover === b
    return (
      <line key={i} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
        stroke="#3a4a66" strokeWidth={active ? 0.8 : 0.4}
        strokeLinecap="round" />
    )
  })

  const orbs = nodes.map((node) => {
    const pos = LAYOUT[node.name]
    if (!pos) return null
    const status = statusMap[node.name]
    const isController = node.name === CONTROLLER
    const cores = node.cpu_count || 2
    const r = isController ? 6 : Math.min(3 + cores * 0.6, 6.5)
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
        {isController && <circle r={r + 3} fill="none" stroke={color} strokeWidth="0.5" strokeDasharray="1.5 1.5" />}
        <text y={r + 6} textAnchor="middle" fontSize="2.4" fill={isHover ? '#e8ecf4' : '#7c8698'} fontFamily="monospace">
          {node.name}
        </text>
      </g>
    )
  })

  return (
    <svg viewBox="0 0 100 100" className="constellation" preserveAspectRatio="xMidYMid meet">
      {lines}
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

// ---- Node detail popup (modal) ----
function NodeDetail({ node, onClose }) {
  const status = nodeStatus(node)
  const isController = node.name === CONTROLLER
  const [showTerminal, setShowTerminal] = useState(false)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!node) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className="modal-title-row">
            <span className={`status-dot ${status}`} />
            <h2 className="modal-title">{node.name}</h2>
            {isController && <span className="type-badge controller">Controller</span>}
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
            <dd>{node.os_version || node.os || '—'}</dd>
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
        </dl>

        <div className="modal-actions">
          {node.online && (
            <button className="btn" onClick={() => setShowTerminal((v) => !v)}>
              {showTerminal ? 'Close SSH' : 'Open SSH'}
            </button>
          )}
        </div>

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
  const [selected, setSelected] = useState(null)

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
      const res = await fetch('/api/collect', { method: 'POST' })
      const data = await res.json()
      setNodes(data.nodes || [])
      setLastUpdated(new Date())
      setToast({ type: 'ok', msg: `Collected ${data.nodes?.length || 0} nodes` })
    } catch {
      setError('Collection failed')
      setToast({ type: 'error', msg: 'Collection failed' })
    } finally {
      setCollecting(false)
      setTimeout(() => setToast(null), 3000)
    }
  }, [])

  useEffect(() => { fetchNodes() }, [fetchNodes])

  const online = nodes.filter((n) => n.online).length
  const anyOffline = online < nodes.length

  const selectedNode = useMemo(
    () => nodes.find((n) => n.name === selected) || null,
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
          <div className="panel-title">Network · radius scales with cores · click a node for details</div>
          {loading ? (
            <div className="constellation-loading">Charting the sky…</div>
          ) : (
            <Constellation nodes={nodes} onSelect={(n) => setSelected(n.name)} />
          )}
          <div className="constellation-legend">
            <span className="legend-item"><span className="legend-dot ok" /> Online</span>
            <span className="legend-item"><span className="legend-dot warn" /> Updates</span>
            <span className="legend-item"><span className="legend-dot offline" /> Offline</span>
            <span className="legend-item"><span className="legend-line">——</span> Tailscale mesh</span>
          </div>
        </div>

        {error && <div className="error-banner">{error}</div>}
        {toast && <div className="error-banner" style={{ borderColor: toast.type === 'error' ? 'var(--danger)' : 'var(--ok)' }}>{toast.msg}</div>}
      </main>

      {selectedNode && <NodeDetail node={selectedNode} onClose={() => setSelected(null)} />}
    </div>
  )
}

export default App
