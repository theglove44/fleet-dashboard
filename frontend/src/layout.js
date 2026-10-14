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

// Hand-placed sky coords (0-100), keys must match config.yaml names.
// fleet-manager (the dashboard VM) sits ON the HEART. The other nodes form a
// 9-node ring in MESH order so peer edges hug the rim with no crossings.
export const HEART_POS = { x: 50, y: 48 }
export const LAYOUT = {
  'fleet-manager': { x: 50, y: 48 },
  'stormbreaker':  { x: 50, y: 13 },
  'macbook':       { x: 73, y: 21 },
  'mediaserver':   { x: 85, y: 42 },
  'proxmox-zen':   { x: 81, y: 66 },
  'proxmox-lan':   { x: 62, y: 81 },
  'tuckinandtalk': { x: 38, y: 81 },
  'openclaw-1':    { x: 19, y: 66 },
  'loki':          { x: 15, y: 42 },
  'mini-ubuntu':   { x: 27, y: 21 },
}
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
  if (LAYOUT[name]) return LAYOUT[name]
  const unknown = names.filter((n) => !LAYOUT[n])
  const i = unknown.indexOf(name)
  const n = Math.max(unknown.length, 1)
  const angle = (2 * Math.PI * i) / n - Math.PI / 2
  return { x: 50 + 38 * Math.cos(angle), y: 50 + 34 * Math.sin(angle) }
}
