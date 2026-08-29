// ---- Shared fleet model: layout + status semantics used by both the 2D
// constellation (SVG) and the 3D flyover, so they can never drift apart ----

export const HEART_NAMES = new Set(['controller', 'fleet-manager'])

export function nodeStatus(node) {
  if (!node.online) return 'offline'
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
// The controller hub (mini-ubuntu) sits ON the HEART; the rest form a ring in
// the same order as the MESH path, so peer edges hug the rim with no crossings.
export const HEART_POS = { x: 50, y: 48 }
export const LAYOUT = {
  'mini-ubuntu':   { x: 50, y: 48 },
  'stormbreaker':  { x: 50, y: 13 },
  'macbook':       { x: 76, y: 23 },
  'mediaserver':   { x: 85, y: 48 },
  'proxmox-zen':   { x: 76, y: 73 },
  'proxmox-lan':   { x: 50, y: 84 },
  'tuckinandtalk': { x: 24, y: 73 },
  'openclaw-1':    { x: 15, y: 48 },
  'loki':          { x: 24, y: 23 },
}
export const MESH = [
  ['proxmox-zen', 'proxmox-lan'],
  ['proxmox-zen', 'mini-ubuntu'],
  ['proxmox-zen', 'mediaserver'],
  ['proxmox-lan', 'tuckinandtalk'],
  ['mini-ubuntu', 'mediaserver'],
  ['mini-ubuntu', 'loki'],
  ['loki', 'openclaw-1'],
  ['loki', 'stormbreaker'],
  ['openclaw-1', 'tuckinandtalk'],
  ['macbook', 'mediaserver'],
  ['macbook', 'mini-ubuntu'],
  ['macbook', 'stormbreaker'],
]

export const STATUS_COLOR = { ok: '#3fb950', warn: '#f0b429', offline: '#6b7280' }
export const STATUS_LABEL = { ok: 'Online', warn: 'Updates pending', offline: 'Offline' }
export const STATUS_SHORT = { ok: 'Online', warn: 'Updates', offline: 'Offline' }

export function nodePos(name, names) {
  if (LAYOUT[name]) return LAYOUT[name]
  const unknown = names.filter((n) => !LAYOUT[n])
  const i = unknown.indexOf(name)
  const n = Math.max(unknown.length, 1)
  const angle = (2 * Math.PI * i) / n - Math.PI / 2
  return { x: 50 + 38 * Math.cos(angle), y: 50 + 34 * Math.sin(angle) }
}
