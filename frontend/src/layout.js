// ---- Shared fleet model: layout + status semantics used by both the 2D
// constellation (SVG) and the 3D flyover, so they can never drift apart ----

export const HEART_NAMES = new Set(['controller', 'fleet-manager'])

export function nodeStatus(node) {
  if (!node.online) return 'offline'
  const collectedAt = node.collected_at || node.last_seen
  const age = collectedAt ? Date.now() - new Date(collectedAt).getTime() : Infinity
  if (!Number.isFinite(age) || age < 0 || age > 15 * 60 * 1000) return 'stale'
  if ((node.pending_updates || 0) > 0) return 'warn'
  return 'ok'
}

// PRETTY_NAME arrives quoted from os-release; strip quotes (also covers stale cache)
export function osLabel(node) {
  return (node.os_version || node.os || '').replace(/"/g, '') || '—'
}

export function typeLabel(node) {
  if (node.group === 'proxmox') return 'Proxmox'
  if (node.group === 'vm') return 'VM'
  if (node.os_type === 'macos') return 'macOS'
  return 'Host'
}

export function orbRadius(node) {
  if (HEART_NAMES.has(node.name)) return 6
  if (node.group === 'proxmox') return 5.4
  if (node.group === 'vm') return 3.1
  return 4.2
}

// Nodes reached off-LAN (outside the peer mesh); dashed ring marks that route.
export const REMOTE_NODES = new Set(['central-brain'])

// The HEART stays centered; all configured satellites are evenly spaced on
// one orbit so adding nodes never creates a special-case outlier.
export const HEART_POS = { x: 50, y: 50 }
export const MESH = [
  ['stormbreaker', 'macbook'],
  ['macbook', 'mediaserver'],
  ['mediaserver', 'proxmox-zen'],
  ['proxmox-zen', 'proxmox-lan'],
  ['proxmox-lan', 'tuckinandtalk'],
  ['tuckinandtalk', 'openclaw-1'],
  ['openclaw-1', 'loki'],
  ['loki', 'mini-ubuntu'],
  ['mini-ubuntu', 'stormbreaker'],
]

export const STATUS_COLOR = { ok: '#3fb950', warn: '#f0b429', offline: '#6b7280', stale: '#8b95a7' }
export const STATUS_LABEL = { ok: 'Online', warn: 'Updates pending', offline: 'Offline', stale: 'Stale — refresh needed' }
export const STATUS_SHORT = { ok: 'Online', warn: 'Updates', offline: 'Offline', stale: 'Stale' }

export function nodePos(name, names) {
  if (HEART_NAMES.has(name)) return HEART_POS
  const meshOrder = [...new Set(MESH.flat())].filter((n) => names.includes(n))
  const satellites = [
    ...meshOrder,
    ...names.filter((n) => !HEART_NAMES.has(n) && !meshOrder.includes(n)),
  ]
  const i = satellites.indexOf(name)
  const count = Math.max(satellites.length, 1)
  const angle = (2 * Math.PI * i) / count - Math.PI / 2
  const radius = 32
  return { x: HEART_POS.x + radius * Math.cos(angle), y: HEART_POS.y + radius * Math.sin(angle) }
}
