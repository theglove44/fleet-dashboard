import React, { useEffect, useMemo, useState } from 'react'
import {
  HEART_NAMES, MESH, REMOTE_NODES, orbRadius,
} from './layout'

const VIEW = { width: 100, height: 100 }
const HUB = { x: 50, y: 50 }
const COLORS = { proxmox: '#f0a45d', vm: '#69a8ff', host: '#54d6d0', mac: '#bb91ff', remote: '#f0b429' }

function satellitesOf(nodes) {
  return nodes.filter((node) => !HEART_NAMES.has(node.name))
}

function roleColor(node) {
  if (REMOTE_NODES.has(node.name)) return COLORS.remote
  if (node.group === 'proxmox') return COLORS.proxmox
  if (node.group === 'vm') return COLORS.vm
  if (node.os_type === 'macos') return COLORS.mac
  return COLORS.host
}

function NodeMark({ node, point, hub = false }) {
  const r = hub ? 4.6 : orbRadius(node) * 0.58
  const color = hub ? COLORS.remote : roleColor(node)
  return (
    <g transform={`translate(${point.x},${point.y})`}>
      {hub ? <circle r={r + 2.2} fill="none" stroke={color} strokeWidth="0.45" strokeDasharray="1.5 1.4" /> : null}
      {REMOTE_NODES.has(node.name) && <circle r={r + 2.1} fill="none" stroke={COLORS.remote} strokeWidth="0.5" strokeDasharray="1.3 1.2" />}
      <circle r={r} fill={color} opacity={node.online === false ? 0.35 : 0.92} />
    </g>
  )
}

function NodeLabel({ node, point, anchor = 'middle' }) {
  return <text x={point.x} y={point.y + 5.4} textAnchor={anchor} className="concept-node-label">{node.name}</text>
}

function Hub({ node, point }) {
  return (
    <g>
      <circle cx={point.x} cy={point.y} r="8.2" fill="rgba(240,180,41,.07)" stroke="rgba(240,180,41,.25)" strokeWidth="0.45" />
      <NodeMark node={node || { name: 'fleet-manager' }} point={point} hub />
      <text x={point.x} y={point.y + 11} textAnchor="middle" className="concept-hub-label">fleet-manager · HEART</text>
    </g>
  )
}

function WheelMock({ nodes }) {
  const satellites = satellitesOf(nodes)
  const hub = nodes.find((n) => HEART_NAMES.has(n.name))
  const points = useMemo(() => {
    const map = {}
    satellites.forEach((node, i) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(satellites.length, 1)
      map[node.name] = { x: 50 + 32 * Math.cos(angle), y: 50 + 32 * Math.sin(angle) }
    })
    return map
  }, [satellites])
  return (
    <svg viewBox={`0 0 ${VIEW.width} ${VIEW.height}`} className="concept-map" role="img" aria-label="All fleet nodes distributed evenly around the central hub">
      <circle cx="50" cy="50" r="32" className="concept-orbit" />
      {satellites.map((node) => <line key={`spoke-${node.name}`} x1="50" y1="50" x2={points[node.name].x} y2={points[node.name].y} className="concept-spoke" />)}
      {MESH.map(([a, b], i) => points[a] && points[b] ? <line key={i} x1={points[a].x} y1={points[a].y} x2={points[b].x} y2={points[b].y} className="concept-mesh" /> : null)}
      {satellites.map((node) => <g key={node.name}><NodeMark node={node} point={points[node.name]} /><NodeLabel node={node} point={points[node.name]} /></g>)}
      <Hub node={hub} point={HUB} />
    </svg>
  )
}

function RoleLegend() {
  const legend = [
    ['Proxmox', COLORS.proxmox], ['VM', COLORS.vm], ['Host', COLORS.host],
    ['macOS', COLORS.mac], ['Remote', COLORS.remote],
  ]
  return <div className="concept-legend">{legend.map(([label, color]) => <span key={label}><i style={label === 'Remote' ? { border: `1px dashed ${color}` } : { background: color }} />{label}</span>)}</div>
}

function ClusterMock({ nodes }) {
  const hub = nodes.find((n) => HEART_NAMES.has(n.name))
  const nonHub = satellitesOf(nodes)
  const groups = [
    { key: 'proxmox', label: 'PROXMOX', color: COLORS.proxmox, center: { x: 24, y: 26 }, items: nonHub.filter((n) => n.group === 'proxmox') },
    { key: 'vm', label: 'VIRTUAL MACHINES', color: COLORS.vm, center: { x: 76, y: 26 }, items: nonHub.filter((n) => n.group === 'vm') },
    { key: 'mac', label: 'macOS', color: COLORS.mac, center: { x: 24, y: 74 }, items: nonHub.filter((n) => n.os_type === 'macos') },
    { key: 'host', label: 'HOSTS · REMOTE', color: COLORS.host, center: { x: 76, y: 74 }, items: nonHub.filter((n) => n.group === 'host' && n.os_type !== 'macos') },
  ].filter((g) => g.items.length)
  return (
    <svg viewBox={`0 0 ${VIEW.width} ${VIEW.height}`} className="concept-map" role="img" aria-label="Fleet nodes grouped by role around the central hub">
      {groups.map((group) => <line key={`hub-${group.key}`} x1="50" y1="50" x2={group.center.x} y2={group.center.y} className="concept-spoke" />)}
      {groups.map((group) => {
        const points = group.items.map((node, i) => {
          const angle = -Math.PI / 2 + (2 * Math.PI * i) / group.items.length
          return { node, point: { x: group.center.x + 7 * Math.cos(angle), y: group.center.y + 6.5 * Math.sin(angle) } }
        })
        return (
          <g key={group.key}>
            <ellipse cx={group.center.x} cy={group.center.y} rx="19" ry="16" fill={`${group.color}0d`} stroke={`${group.color}55`} strokeWidth="0.45" />
            <text x={group.center.x} y={group.center.y - 11.5} textAnchor="middle" className="concept-group-label" fill={group.color}>{group.label}</text>
            {points.map(({ node, point }) => <line key={`link-${node.name}`} x1={group.center.x} y1={group.center.y} x2={point.x} y2={point.y} className="concept-cluster-link" />)}
            {points.map(({ node, point }) => <g key={node.name}><NodeMark node={node} point={point} /><NodeLabel node={node} point={point} /></g>)}
          </g>
        )
      })}
      <Hub node={hub} point={HUB} />
    </svg>
  )
}

function RailMock({ nodes }) {
  const satellites = satellitesOf(nodes)
  const remote = satellites.filter((n) => REMOTE_NODES.has(n.name))
  const local = satellites.filter((n) => !REMOTE_NODES.has(n.name))
  const hub = nodes.find((n) => HEART_NAMES.has(n.name))
  const center = { x: 34, y: 50 }
  const points = {}
  local.forEach((node, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(local.length, 1)
    points[node.name] = { x: center.x + 23 * Math.cos(angle), y: center.y + 23 * Math.sin(angle) }
  })
  const remotePoints = remote.map((node, i) => ({ node, point: { x: 81, y: 42 + i * 16 } }))
  return (
    <svg viewBox={`0 0 ${VIEW.width} ${VIEW.height}`} className="concept-map" role="img" aria-label="Local mesh with a dedicated remote-node rail">
      <rect x="67" y="17" width="28" height="66" rx="4" className="concept-rail" />
      <text x="81" y="24" textAnchor="middle" className="concept-group-label" fill={COLORS.remote}>REMOTE</text>
      {local.map((node) => <line key={`spoke-${node.name}`} x1={center.x} y1={center.y} x2={points[node.name].x} y2={points[node.name].y} className="concept-spoke" />)}
      {MESH.map(([a, b], i) => points[a] && points[b] ? <line key={i} x1={points[a].x} y1={points[a].y} x2={points[b].x} y2={points[b].y} className="concept-mesh" /> : null)}
      {remotePoints.map(({ node, point }) => <line key={`remote-link-${node.name}`} x1={center.x} y1={center.y} x2={point.x - 4} y2={point.y} className="concept-remote-link" />)}
      {local.map((node) => <g key={node.name}><NodeMark node={node} point={points[node.name]} /><NodeLabel node={node} point={points[node.name]} /></g>)}
      {remotePoints.map(({ node, point }) => <g key={node.name}><NodeMark node={node} point={point} /><NodeLabel node={node} point={point} /></g>)}
      <Hub node={hub} point={center} />
    </svg>
  )
}

const OPTIONS = [
  { key: 'wheel', title: '01 · Role-coloured orbit', pitch: 'Option 1’s balanced wheel, with option 2’s role colours.', detail: 'Color identifies device role; the dashed gold ring calls out the remote node. A compact legend sits above the map.' },
  { key: 'clusters', title: '02 · Role clusters', pitch: 'Group machines by Proxmox, VMs, macOS and hosts.', detail: 'Best for scanning by role. The remote node shares the host cluster but keeps its dashed remote marker.' },
  { key: 'rail', title: '03 · Remote rail', pitch: 'Keep the local mesh circular; give remote nodes a named lane.', detail: 'Clearest when remote sites grow. Uses a little less room for the local wheel, but isolates out-of-mesh devices.' },
]

export default function MapConcepts() {
  const [nodes, setNodes] = useState([])
  const [loadError, setLoadError] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch('/api/nodes').then((r) => r.json()).then((d) => {
      if (!cancelled) setNodes(d.nodes || [])
    }).catch(() => { if (!cancelled) setLoadError(true) })
    return () => { cancelled = true }
  }, [])
  const maps = { wheel: WheelMock, clusters: ClusterMock, rail: RailMock }
  return (
    <main className="concept-page">
      <header className="concept-page-head">
        <div><div className="agent-kicker">Fleet constellation · design study</div><h1>Map layout concepts</h1><p>Three ways to fit the current fleet without losing the HEART or hiding a node label.</p></div>
        <a href="/" className="btn ghost">← Back to fleet</a>
      </header>
      {loadError && <div className="error-banner">Could not load live nodes; the maps are empty until the API responds.</div>}
      <div className="concept-grid">
        {OPTIONS.map((option) => {
          const Map = maps[option.key]
          return <article className="concept-card" key={option.key}>
            <div className="concept-card-head"><span className="concept-number">{option.key === 'clusters' ? 'RECOMMENDED' : 'OPTION'}</span><h2>{option.title}</h2></div>
            <p className="concept-pitch">{option.pitch}</p>
            {option.key === 'wheel' && <RoleLegend />}
            <div className="concept-canvas"><Map nodes={nodes} /></div>
            <p className="concept-detail">{option.detail}</p>
          </article>
        })}
      </div>
      <footer className="concept-foot">{nodes.length ? `${nodes.length} configured devices · click a name on the live map for details` : 'Waiting for configured devices'} · no layout changes are applied by this preview</footer>
    </main>
  )
}
