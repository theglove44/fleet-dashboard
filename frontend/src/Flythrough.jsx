import React, { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js'
import { MESH, HEART_POS, STATUS_COLOR, nodeStatus, nodePos, osLabel } from './layout'

// ---- Fleet fsn: a Jurassic-Park-style File System Navigator for your tailnet ----
// Each node is a translucent glass box floating over a wireframe canyon; its
// pending updates glow inside as gold tiles. First-person fly-through controls.

const SPREAD = 2.2      // world units per sky unit (shared with the 2D sky)
const GRID_Y = -22      // canyon floor height
const TILE_CAP = 36     // max update tiles rendered per box

// glass-box size per role
function boxSize(node) {
  if (node.group === 'proxmox') return 15
  if (node.group === 'vm') return 9
  return 12
}

function heartWorld() {
  return new THREE.Vector3((HEART_POS.x - 50) * SPREAD, 0, (HEART_POS.y - 50) * SPREAD)
}

function nodeWorld(name, names) {
  const p = nodePos(name, names)
  return new THREE.Vector3((p.x - 50) * SPREAD, 0, (p.y - 50) * SPREAD)
}

function glowTexture(color) {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const ctx = c.getContext('2d')
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64)
  g.addColorStop(0, color)
  g.addColorStop(0.3, color + '66')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 128, 128)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function textTexture(text, color = '#f5d9ff') {
  const c = document.createElement('canvas')
  let ctx = c.getContext('2d')
  const font = '600 44px IBM Plex Mono, monospace'
  ctx.font = font
  const pad = 24
  c.width = Math.ceil(ctx.measureText(text).width) + pad * 2
  c.height = 72
  ctx = c.getContext('2d')
  ctx.font = font
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.shadowColor = '#000000'
  ctx.shadowBlur = 14
  ctx.fillStyle = color
  ctx.fillText(text, c.width / 2, 38)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return { tex, aspect: c.width / c.height }
}

function labelSprite(text, color = '#f5d9ff') {
  const { tex, aspect } = textTexture(text, color)
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
  const sprite = new THREE.Sprite(mat)
  const h = 4.5
  sprite.scale.set((h * aspect), h, 1)
  return sprite
}

export default function Flythrough({ nodes, onSelect, onClose }) {
  const mountRef = useRef(null)
  const [glFailed, setGlFailed] = useState(false)
  const [locked, setLocked] = useState(false)
  const [freeLook, setFreeLook] = useState(false)  // drag-to-look fallback (lock denied)
  const focusRef = useRef(null)          // scene-side: which node is focused
  const [focusName, setFocusName] = useState(null) // HUD mirror
  const [showIntro, setShowIntro] = useState(
    () => !sessionStorage.getItem('fsn-intro-dismissed')
  )
  const dismissIntro = () => {
    setShowIntro(false)
    try { sessionStorage.setItem('fsn-intro-dismissed', '1') } catch {}
  }

  // the quote card dismisses itself after a few seconds as well as on click
  useEffect(() => {
    if (!showIntro) return
    const id = setTimeout(dismissIntro, 6000)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showIntro])

  // ---- one-time scene setup ----
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    let renderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true })
    } catch {
      setGlFailed(true)
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#050308')
    scene.fog = new THREE.FogExp2('#050308', 0.0038)

    const camera = new THREE.PerspectiveCamera(
      62, mount.clientWidth / mount.clientHeight, 0.1, 1600
    )
    // spawn high enough that proxmox-lan's tower doesn't hide the HEART /
    // stormbreaker behind it (~34° down instead of ~7°)
    camera.position.set(0, 118, 172)
    camera.lookAt(0, 6, 0)

    // ---- starfield ----
    const starCount = 900
    const starPos = new Float32Array(starCount * 3)
    for (let i = 0; i < starCount; i++) {
      const theta = Math.random() * Math.PI * 2
      const phi = Math.random() * Math.PI * 0.42
      const rad = 650 + Math.random() * 250
      starPos[i * 3] = rad * Math.sin(phi) * Math.cos(theta)
      starPos[i * 3 + 1] = rad * Math.cos(phi) + 40
      starPos[i * 3 + 2] = rad * Math.sin(phi) * Math.sin(theta)
    }
    const starGeo = new THREE.BufferGeometry()
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3))
    const starMat = new THREE.PointsMaterial({ color: 0xcdd6ea, size: 1.4, sizeAttenuation: false, transparent: true, opacity: 0.75 })
    scene.add(new THREE.Points(starGeo, starMat))

    // ---- wireframe canyon — flat like FSN by default, T toggles the dunes ----
    const terrGeo = new THREE.PlaneGeometry(760, 760, 96, 96)
    terrGeo.rotateX(-Math.PI / 2)
    let hillsOn = false
    function applyTerrain(hills) {
      const posAttr = terrGeo.attributes.position
      for (let i = 0; i < posAttr.count; i++) {
        if (!hills) { posAttr.setY(i, 0); continue }
        const x = posAttr.getX(i)
        const z = posAttr.getZ(i)
        const d = Math.hypot(x, z)
        // rolling dunes near the middle, rising rim at the horizon
        const dunes =
          Math.sin(x * 0.045) * Math.cos(z * 0.038) * 4 +
          Math.sin(x * 0.013 + 1.7) * Math.cos(z * 0.017 + 0.6) * 7
        const rim = Math.max(0, (d - 210) / 180)
        posAttr.setY(i, dunes + rim * rim * 46)
      }
      posAttr.needsUpdate = true
      terrGeo.computeVertexNormals()
    }
    applyTerrain(hillsOn)
    const terrain = new THREE.Mesh(
      terrGeo,
      new THREE.MeshBasicMaterial({ color: 0x58409a, wireframe: true, transparent: true, opacity: 0.34 })
    )
    terrain.position.y = GRID_Y
    scene.add(terrain)

    // ---- the HEART: a beam of light rising from the canyon floor ----
    const heartPos = heartWorld()
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(1.1, 1.1, 64, 16, 1, true),
      new THREE.MeshBasicMaterial({
        color: '#f0b429', transparent: true, opacity: 0.32,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      })
    )
    beam.position.set(heartPos.x, GRID_Y + 32, heartPos.z)
    scene.add(beam)
    const heartGlowTex = glowTexture('#f0b429')
    const heartGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: heartGlowTex, blending: THREE.AdditiveBlending,
      transparent: true, depthWrite: false, opacity: 0.85,
    }))
    heartGlow.scale.set(30, 30, 1)
    heartGlow.position.set(heartPos.x, GRID_Y + 56, heartPos.z)
    scene.add(heartGlow)
    const ringGeo = new THREE.RingGeometry(1, 1.06, 64)
    const rings = [0, 1].map(() => {
      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color: '#f0b429', transparent: true, opacity: 0.5,
        side: THREE.DoubleSide, depthWrite: false,
      }))
      ring.rotation.x = -Math.PI / 2
      ring.position.set(heartPos.x, GRID_Y + 0.4, heartPos.z)
      scene.add(ring)
      return ring
    })

    // ---- shared materials ----
    const disposables = []
    // lights for the solid flat-shaded blocks (FSN-style lambert slabs)
    scene.add(new THREE.AmbientLight(0x8a90a8, 0.55))
    const sun = new THREE.DirectionalLight(0xffe9c9, 1.15)
    sun.position.set(70, 140, 50)
    scene.add(sun)
    const heartLamp = new THREE.PointLight(0xf0b429, 1.2, 420, 1.6)
    heartLamp.position.set(heartPos.x, GRID_Y + 40, heartPos.z)
    scene.add(heartLamp)

    // unit cube stretched per-block; lambert gives the flat-shaded slab look
    const blockGeo = new THREE.BoxGeometry(1, 1, 1)
    const blockEdgeGeo = new THREE.EdgesGeometry(blockGeo)
    const blockMat = {
      warn: new THREE.MeshLambertMaterial({ color: '#f0b429' }),
      ok: new THREE.MeshLambertMaterial({ color: '#3fb950' }),
      offline: new THREE.MeshLambertMaterial({ color: '#4a5568' }),
    }
    disposables.push(blockGeo, blockEdgeGeo, ...Object.values(blockMat))

    // spotlight ring dropped on the focused tower (the film's settle beat)
    const focusRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: '#f0b429', transparent: true, opacity: 0,
      side: THREE.DoubleSide, depthWrite: false,
    }))
    focusRing.rotation.x = -Math.PI / 2
    focusRing.visible = false
    scene.add(focusRing)
    const focusSpot = new THREE.SpotLight(0xffe2b0, 2.2, 600, 0.4, 0.55)
    focusSpot.visible = false
    scene.add(focusSpot)
    scene.add(focusSpot.target)
    disposables.push(focusRing.material)

    const EDGE_PINK = 0xff5ad2

    // cached glow textures per status color (avoid leaking on every poll)
    const ledTexCache = {}
    const ledTexFor = (status) => {
      if (!ledTexCache[status]) {
        ledTexCache[status] = glowTexture(STATUS_COLOR[status])
        disposables.push(ledTexCache[status])
      }
      return ledTexCache[status]
    }

    // ---- node glass boxes ----
    const nameList = nodes.map((n) => n.name)
    const nodeObjs = {}
    nodes.forEach((node, i) => {
      const pos = nodeWorld(node.name, nameList)
      const size = boxSize(node)
      const half = size / 2
      const group = new THREE.Group()
      group.position.copy(pos)
      group.userData.phase = i * 1.7

      const geo = new THREE.BoxGeometry(size, size, size)
      const fill = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color: 0xb0328f, transparent: true, opacity: 0.07,
          depthWrite: false,
        })
      )
      fill.userData.nodeName = node.name
      group.add(fill)

      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: EDGE_PINK, transparent: true, opacity: 0.85 })
      )
      group.add(edges)

      // status LED at the top-front corner
      const led = new THREE.Mesh(
        new THREE.SphereGeometry(1.1, 16, 16),
        new THREE.MeshBasicMaterial({ color: STATUS_COLOR.ok })
      )
      led.position.set(half - 1.6, half - 1.6, half + 0.4)
      group.add(led)

      const ledGlow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: ledTexFor('ok'), blending: THREE.AdditiveBlending,
        transparent: true, depthWrite: false, opacity: 0.9,
      }))
      ledGlow.scale.set(7, 7, 1)
      ledGlow.position.copy(led.position)
      group.add(ledGlow)

      const label = labelSprite(node.name)
      label.position.y = half + 4.5
      group.add(label)

      // solid platform the blocks stand on (FSN towers sit on flat slabs)
      const platH = 1.1
      const platform = new THREE.Mesh(
        new THREE.BoxGeometry(size * 0.92, platH, size * 0.92),
        new THREE.MeshLambertMaterial({ color: '#2a2536' })
      )
      platform.position.y = -half + platH / 2 + 0.4
      group.add(platform)
      const platEdge = new THREE.LineSegments(
        new THREE.EdgesGeometry(platform.geometry),
        new THREE.LineBasicMaterial({ color: EDGE_PINK, transparent: true, opacity: 0.5 })
      )
      platEdge.position.copy(platform.position)
      group.add(platEdge)

      const tiles = new THREE.Group()
      group.add(tiles)

      group.position.y = half + 6   // hover above the canyon
      scene.add(group)

      disposables.push(geo, fill.material, edges.geometry, edges.material,
        led.geometry, led.material, ledGlow.material,
        label.material, label.material.map,
        platform.geometry, platform.material, platEdge.geometry, platEdge.material)

      nodeObjs[node.name] = { group, fill, edges, led, ledGlow, tiles, label, size, builtKey: null }
    })

    // ---- fsn blocks: one solid slab per pending package ----
    // The count is real data (/api/updates/{node}); per-package sizes aren't
    // collected, so block height varies deterministically from the name hash.
    const pkgCache = {}   // node name -> [package names] (null = not fetched yet)
    const hash01 = (s) => {
      let h = 2166136261
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
      return ((h >>> 0) % 1000) / 1000
    }
    const clearBlocks = (obj) => {
      const shared = Object.values(blockMat)
      while (obj.tiles.children.length) {
        const t = obj.tiles.children.pop()
        obj.tiles.remove(t)
        if (!shared.includes(t.material)) {   // painted faces own their materials
          if (Array.isArray(t.material)) {
            t.material.forEach((m) => { m.map?.dispose?.(); m.dispose?.() })
          } else {
            t.material?.map?.dispose?.()
            t.material?.dispose?.()
          }
        }
      }
      obj.blockMeshes = []
    }

    // FSN file-tower labels: the package name is PAINTED ON THE BLOCK ITSELF
    // (all four sides), like the film's filing towers. Scales with the block,
    // can never collide with a neighbour's floating label. Long names shrink,
    // then truncate with an ellipsis; tall blocks read spine-style vertically.
    const faceCanvas = document.createElement('canvas')
    function drawFaceText(pkgName, bg, fg, vertical) {
      const c = faceCanvas
      c.width = vertical ? 128 : 512
      c.height = vertical ? 512 : 128
      const g = c.getContext('2d')
      g.fillStyle = bg
      g.fillRect(0, 0, c.width, c.height)
      g.fillStyle = fg
      let size = 72
      const maxW = (vertical ? c.height : c.width) - 24
      const setFont = () => { g.font = `600 ${size}px "IBM Plex Mono", ui-monospace, monospace` }
      g.textBaseline = 'middle'
      g.textAlign = 'center'
      let text = pkgName
      setFont()
      while (g.measureText(text).width > maxW && size > 30) {
        size -= 4
        setFont()
      }
      if (g.measureText(text).width > maxW) {   // still too wide -> ellipsize
        while (text.length > 1 && g.measureText(text + '…').width > maxW) {
          text = text.slice(0, -1)
        }
        text += '…'
      }
      if (vertical) {
        g.translate(c.width / 2, c.height / 2)
        g.rotate(-Math.PI / 2)
        g.fillText(text, 0, 0)
      } else {
        g.fillText(text, c.width / 2, c.height / 2 + 2)
      }
      const tex = new THREE.CanvasTexture(c)
      tex.anisotropy = 4
      return tex
    }
    const FACE_COLORS = {
      warn: ['#f0b429', '#241a08'],
      ok: ['#3fb950', '#0b2410'],
      offline: ['#4a5568', '#c7d0dc'],
    }
    function paintedBlockMaterials(pkgName, state, tall) {
      const [bg, fg] = FACE_COLORS[state] || FACE_COLORS.warn
      const tex = drawFaceText(pkgName, bg, fg, tall)
      const texM = tex.clone()   // mirrored so -x/-z faces read correctly
      texM.needsUpdate = true
      texM.wrapS = THREE.RepeatWrapping
      texM.repeat.x = -1
      const front = new THREE.MeshLambertMaterial({ map: tex })
      const back = new THREE.MeshLambertMaterial({ map: texM })
      // box face order: +x, -x, +y, -y, +z, -z
      return [front, back, blockMat[state], blockMat[state], front, back]
    }

    function buildBlocks(obj, name, n) {
      const offline = !n?.online
      const pkgs = pkgCache[name]   // null = not fetched yet -> generic blocks
      const state = offline ? 'offline' : ((pkgs?.length || n?.pending_updates || 0) > 0 ? 'warn' : 'ok')
      const key = `${state}|${offline}|${pkgs ? pkgs.join(',') : 'generic-' + (n?.pending_updates || 0)}`
      if (obj.builtKey === key) return
      obj.builtKey = key
      clearBlocks(obj)

      const half = obj.size / 2
      const platTop = -half + 0.4 + 1.1
      const maxH = obj.size * 0.62
      const list = offline
        ? Array.from({ length: 5 }, (_, i) => `offline-${i}`)
        : (pkgs ?? Array.from({ length: Math.min(n?.pending_updates || 0, TILE_CAP) }, (_, i) => `pkg-${i}`))
      const shown = list.slice(0, TILE_CAP)
      obj.blockMeshes = []
      if (!shown.length) {
        // clean node: a single low green slab marks the empty platform
        const slab = new THREE.Mesh(blockGeo, blockMat.ok)
        slab.scale.set(obj.size * 0.3, obj.size * 0.06, obj.size * 0.3)
        slab.position.y = platTop + obj.size * 0.03
        obj.tiles.add(slab)
        return
      }
      const cols = Math.ceil(Math.sqrt(shown.length))
      const rows = Math.ceil(shown.length / cols)
      const cellW = (obj.size * 0.86) / cols
      shown.forEach((pkgName, i) => {
        const h = obj.size * 0.08 + hash01(pkgName) * maxH
        const w = cellW * 0.55
        const cx = i % cols, cy = Math.floor(i / cols)
        const block = new THREE.Mesh(
          blockGeo,
          paintedBlockMaterials(pkgName, offline ? 'offline' : 'warn', h > w * 1.5)
        )
        block.scale.set(w, h, w)
        block.position.set(
          (cx - (cols - 1) / 2) * cellW,
          platTop + h / 2,
          (cy - (rows - 1) / 2) * cellW
        )
        block.userData.pkg = pkgName   // full name for the hover tooltip
        obj.tiles.add(block)
        obj.blockMeshes.push(block)
      })
    }
    function fetchPackages(name) {
      const n = latest[name]
      if (!n?.online) { pkgCache[name] = []; return }
      if (!(n.pending_updates > 0)) { pkgCache[name] = []; return }
      fetch(`/api/updates/${encodeURIComponent(name)}?t=${Date.now()}`)
        .then((r) => r.json())
        .then((b) => {
          pkgCache[name] = b.packages || []
          if (focusRef.current === name && nodeObjs[name]) buildBlocks(nodeObjs[name], name, latest[name])
        })
        .catch(() => {})
    }

    // ---- single full-name tooltip for the block under the reticle/cursor ----
    // Faces carry truncated names; this is where the complete name appears.
    const tip = labelSprite('', '#ffe6b3')
    tip.material.depthTest = false   // information text never loses a depth fight
    tip.renderOrder = 30
    tip.visible = false
    scene.add(tip)
    disposables.push({ dispose: () => { tip.material.map?.dispose(); tip.material.dispose() } })
    const tipKey = { v: null }
    const pointerPx = { x: 0, y: 0, inside: false }
    renderer.domElement.addEventListener('mousemove', (e) => {
      pointerPx.x = e.clientX
      pointerPx.y = e.clientY
      pointerPx.inside = true
    })
    function updateBlockTip() {
      const o = focusRef.current ? nodeObjs[focusRef.current] : null
      if (!o?.blockMeshes?.length || !o.interior?.group.visible) {
        tip.visible = false
        return
      }
      let ndcX = 0, ndcY = 0, haveRay = false
      if (document.pointerLockElement) {
        haveRay = true                              // reticle: screen centre
      } else if (freeLook && pointerPx.inside) {    // fallback: actual cursor
        const r = renderer.domElement.getBoundingClientRect()
        ndcX = ((pointerPx.x - r.left) / r.width) * 2 - 1
        ndcY = -((pointerPx.y - r.top) / r.height) * 2 + 1
        haveRay = true
      }
      if (!haveRay) { tip.visible = false; return }
      pointerNDC.set(ndcX, ndcY)
      raycaster.setFromCamera(pointerNDC, camera)
      const hit = raycaster.intersectObjects(o.blockMeshes)[0]
      if (!hit) {
        tip.visible = false
        tipKey.v = null
        return
      }
      const pkg = hit.object.userData.pkg
      if (tipKey.v !== pkg) {
        tipKey.v = pkg
        const { tex, aspect } = textTexture(pkg, '#ffe6b3')
        tip.material.map?.dispose()
        tip.material.map = tex
        tip.material.needsUpdate = true
        tip.scale.set(4.5 * aspect, 4.5, 1)
      }
      // blocks live inside the node's group -> need the WORLD position
      hit.object.getWorldPosition(tip.position)
      tip.position.y += hit.object.scale.y / 2 + 3
      tip.visible = true
    }

    // ---- mesh "roads": links run along the canyon floor between pedestals ----
    const trailTex = glowTexture('#7fd4ff')
    disposables.push(trailTex)
    const trails = []
    const lineMatMesh = new THREE.LineBasicMaterial({
      color: 0xff5ad2, transparent: true, opacity: 0.38,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
    const FLOOR_Y = GRID_Y + 0.3
    // drop from each tower to the floor, right-angle road across, rise back up
    function roadPath(oa, ob) {
      const aF = oa.clone(); aF.y = FLOOR_Y
      const bF = ob.clone(); bF.y = FLOOR_Y
      const mid = new THREE.Vector3(bF.x, FLOOR_Y, aF.z)
      return [oa.clone(), aF, mid, bF, ob.clone()]
    }
    function pointOnPath(pts, p) {
      const segs = []
      let total = 0
      for (let i = 0; i < pts.length - 1; i++) {
        const l = pts[i].distanceTo(pts[i + 1])
        segs.push(l); total += l
      }
      let d = p * total
      for (let i = 0; i < segs.length; i++) {
        if (d <= segs[i] || i === segs.length - 1) {
          return pts[i].clone().lerp(pts[i + 1], segs[i] ? Math.min(d / segs[i], 1) : 0)
        }
        d -= segs[i]
      }
      return pts[pts.length - 1].clone()
    }
    MESH.forEach(([a, b], i) => {
      if (!(a in nodeObjs) || !(b in nodeObjs)) return
      const oa = nodeObjs[a].group.position
      const ob = nodeObjs[b].group.position
      const pts = roadPath(oa, ob)
      const geo = new THREE.BufferGeometry().setFromPoints(pts)
      scene.add(new THREE.Line(geo, lineMatMesh))
      disposables.push(geo)
      const dot = new THREE.Sprite(new THREE.SpriteMaterial({
        map: trailTex, blending: THREE.AdditiveBlending,
        transparent: true, depthWrite: false, opacity: 0.9,
      }))
      dot.scale.set(4, 4, 1)
      scene.add(dot)
      trails.push({ dot, path: pts, ends: [a, b], phase: (i * 0.37) % 1 })
    })
    disposables.push(lineMatMesh)

    // ---- node interiors: fsn action cubes shown when a box is focused ----
    const actionGeo = new THREE.BoxGeometry(7, 7, 7)
    const actionEdgeGeo = new THREE.EdgesGeometry(actionGeo)
    disposables.push(actionGeo, actionEdgeGeo)

    function makeActionCube(ig, x, topY, labelText) {
      const fillM = new THREE.Mesh(
        actionGeo,
        new THREE.MeshBasicMaterial({ color: 0xb0328f, transparent: true, opacity: 0.14, depthWrite: false })
      )
      fillM.position.set(x, topY, 0)
      const edgeL = new THREE.LineSegments(
        actionEdgeGeo,
        new THREE.LineBasicMaterial({ color: EDGE_PINK, transparent: true, opacity: 0.95 })
      )
      edgeL.position.copy(fillM.position)
      const lab = labelSprite(labelText)
      lab.position.set(x, topY + 5, 0)
      lab.material.depthTest = false   // action labels never lose a depth fight
      lab.renderOrder = 20
      ig.add(fillM, edgeL, lab)
      return { fillM, edgeL, lab }
    }

    function ensureInterior(o, nodeName) {
      if (o.interior) return o.interior
      const ig = new THREE.Group()
      ig.visible = false
      const topY = o.size / 2 + 4
      const ssh = makeActionCube(ig, -o.size * 0.38, topY, 'SSH')
      ssh.fillM.userData.intent = 'ssh'
      ssh.fillM.userData.nodeName = nodeName
      const upd = makeActionCube(ig, o.size * 0.38, topY, 'UPDATE')
      upd.fillM.userData.intent = 'update'
      upd.fillM.userData.nodeName = nodeName
      // OS / arch / actions live in the fixed DOM strip at the bottom of the
      // screen now — world text is for atmosphere only
      o.group.add(ig)
      o.interior = { group: ig, ssh, upd, info: null, countKey: null }
      ;[ssh.fillM.material, ssh.edgeL.material,
        upd.fillM.material, upd.edgeL.material].forEach((m) => disposables.push(m))
      return o.interior
    }

    function refreshUpdateLabel(o, n) {
      if (!o.interior || !n) return
      const key = String(n.online ? (n.pending_updates || 0) : 'offline')
      if (o.interior.countKey === key) return
      o.interior.countKey = key
      const ig = o.interior.group
      ig.remove(o.interior.upd.lab)
      o.interior.upd.lab.material.map?.dispose()
      o.interior.upd.lab.material.dispose()
      const offline = key === 'offline'
      o.interior.upd.lab = labelSprite(
        offline ? 'UPDATE' : (Number(key) > 0 ? `UPDATE (${key})` : 'UPDATE'),
        offline ? '#6b7280' : undefined
      )
      o.interior.upd.lab.material.depthTest = false
      o.interior.upd.lab.renderOrder = 20
      o.interior.upd.lab.position.set(o.size * 0.38, o.size / 2 + 9, 0)
      ig.add(o.interior.upd.lab)
    }

    // The SSH / UPDATE row sits at ±size*0.38 world units, which collapses to
    // a few pixels on small or distant towers — the labels literally render as
    // "SSUPDATE". Widen the row whenever the *base-offset* projection falls
    // under a minimum pixel gap. Gap is always measured from the base offsets,
    // never from the displaced cubes, so there's no per-frame feedback loop.
    const ACTION_MIN_GAP_PX = 150
    const actA = new THREE.Vector3()
    const actB = new THREE.Vector3()
    function layoutActionRow(o) {
      const it = o.interior
      if (!it || !it.group.visible) return
      const w = renderer.domElement.clientWidth || 1
      const h = renderer.domElement.clientHeight || 1
      const baseX = o.size * 0.38
      actA.copy(o.group.position); actA.x -= baseX
      actB.copy(o.group.position); actB.x += baseX
      actA.project(camera); actB.project(camera)
      if (actA.z > 1 || actB.z > 1) return   // behind camera
      const dx = (actB.x - actA.x) * 0.5 * w
      const dy = (actB.y - actA.y) * 0.5 * h
      const gapPx = Math.hypot(dx, dy)
      let offX = baseX
      if (gapPx > 1 && gapPx < ACTION_MIN_GAP_PX) {
        offX = Math.min(baseX * (ACTION_MIN_GAP_PX / gapPx), o.size * 2.4)
      }
      const topY = o.size / 2 + 4
      it.ssh.fillM.position.x = -offX
      it.ssh.edgeL.position.x = -offX
      it.ssh.lab.position.x = -offX
      it.upd.fillM.position.x = offX
      it.upd.edgeL.position.x = offX
      it.upd.lab.position.x = offX
    }

    // bright Tron-lines from the focused box to its mesh neighbours
    const nbLines = []
    function buildNeighborLines(name) {
      removeNeighborLines()
      const o = nodeObjs[name]
      MESH.forEach(([a, b]) => {
        const other = a === name ? b : (b === name ? a : null)
        if (!other || !(other in nodeObjs)) return
        const geo = new THREE.BufferGeometry().setFromPoints([
          o.group.position.clone(), nodeObjs[other].group.position.clone(),
        ])
        const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
          color: 0x7fd4ff, transparent: true, opacity: 0.9,
        }))
        scene.add(line)
        nbLines.push({ line, geo, mat: line.material })
      })
    }
    function removeNeighborLines() {
      nbLines.forEach(({ line, geo, mat }) => {
        scene.remove(line); geo.dispose(); mat.dispose()
      })
      nbLines.length = 0
    }

    // ---- focus state (focusRef is scene-side; focusName mirrors it for the HUD) ----
    const latest = {}

    function restyle() {
      const cur = focusRef.current
      Object.entries(latest).forEach(([name, n]) => {
        const o = nodeObjs[name]
        if (!o) return
        const st = nodeStatus(n)
        const offline = st === 'offline'
        const dim = cur !== null && cur !== name
        o.fill.material.opacity = offline ? 0.02 : (dim ? 0.02 : 0.07)
        o.edges.material.opacity = offline ? 0.25 : (dim ? 0.12 : 0.85)
        o.edges.material.color.set(offline ? 0x555f70 : EDGE_PINK)
        // background node names fade away in node view so they can't collide
        // with the SSH / UPDATE labels or the hint bar
        o.label.material.opacity = dim ? 0.15 : 1
        o.led.material.color.set(STATUS_COLOR[st])
        o.ledGlow.material.map = ledTexFor(st)
        o.ledGlow.material.opacity = offline ? 0.3 : (dim ? 0.4 : 0.9)
        buildBlocks(o, name, n)
        if (o.interior) {
          o.interior.group.visible = cur === name
          refreshUpdateLabel(o, n)
        }
      })
      trails.forEach((tr) => {
        const onlinePair = tr.ends.every((e) => latest[e]?.online)
        tr.dot.visible = onlinePair && (!cur || tr.ends.includes(cur))
      })
    }

    // screen-space de-clutter for the name sprites: any two labels that land
    // within ~90px of each other fade the more distant one to focus-dim level
    const overlapV = new THREE.Vector3()
    function resolveLabelOverlaps() {
      const w = renderer.domElement.clientWidth || 1
      const h = renderer.domElement.clientHeight || 1
      const cur = focusRef.current
      const items = []
      Object.entries(nodeObjs).forEach(([name, o]) => {
        const base = cur !== null && cur !== name ? 0.15 : 1
        o.label.getWorldPosition(overlapV)
        const p = overlapV.project(camera)
        if (p.z > 1) return   // behind the camera
        items.push({
          o, base,
          x: (p.x * 0.5 + 0.5) * w,
          y: (-p.y * 0.5 + 0.5) * h,
          camd: camera.position.distanceTo(o.group.position),
        })
        o.label.material.opacity = base
      })
      const THRESH = Math.min(90, w * 0.075)
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const a = items[i], b = items[j]
          const dx = a.x - b.x, dy = a.y - b.y
          if (dx * dx + dy * dy >= THRESH * THRESH) continue
          const far = a.camd > b.camd ? a : b
          far.o.label.material.opacity = Math.min(far.o.label.material.opacity, 0.15)
        }
      }
    }

    function focus(name) {
      if (!(name in nodeObjs)) return
      focusRef.current = name
      setFocusName(name)
      const o = nodeObjs[name]
      ensureInterior(o, name)
      refreshUpdateLabel(o, latest[name])
      restyle()
      buildNeighborLines(name)
      fetchPackages(name)   // real package names drive the block heights
      // swoop to a fsn-style top-down angle over this box
      const target = o.group.position.clone().add(new THREE.Vector3(0, 2, 0))
      // approach direction away from the heart; the centre node sits ON it,
      // so fall back to a fixed heading when the offset is ~zero (else NaN
      // parks the camera inside the box and the additive glow whites out)
      const dir = target.clone().sub(heartPos); dir.y = 0
      if (dir.lengthSq() < 4) dir.set(1, 0, 0.35)
      dir.normalize()
      const dist = o.size * 0.5 + Math.max(26, o.size * 0.9)   // never closer than the surface + margin
      const camTo = target.clone().add(dir.multiplyScalar(dist))
      camTo.y = target.y + o.size * 0.85 + 12
      startTween(camTo, target, { dur: 1.45, ease: 'dive' })
      // drop the spotlight ring on this tower
      focusRing.position.set(o.group.position.x, GRID_Y + 0.4, o.group.position.z)
      focusRing.userData.baseScale = o.size * 0.85
      focusRing.visible = true
      focusSpot.position.copy(o.group.position).add(new THREE.Vector3(0, 150, 0))
      focusSpot.target.position.copy(o.group.position)
      focusSpot.visible = true
    }

    function unfocus() {
      if (focusRef.current === null) return
      focusRef.current = null
      setFocusName(null)
      removeNeighborLines()
      restyle()
      focusRing.visible = false
      focusSpot.visible = false
      // pull back to the fleet overview
      const dir = camera.position.clone().sub(heartPos); dir.y = 0
      if (dir.lengthSq() < 1) dir.set(0, 0, 1)
      dir.normalize()
      const camTo = heartPos.clone().add(dir.multiplyScalar(165))
      camTo.y = 112
      startTween(camTo, heartPos.clone().add(new THREE.Vector3(0, 6, 0)))
    }

    // ---- camera tween (lookAt-based; PointerLockControls owns rotation between tweens) ----
    const lookTarget = heartPos.clone().add(new THREE.Vector3(0, 6, 0))
    const tween = { active: false, t: 0, dur: 1.2, ease: 'smooth', fromP: null, toP: null, fromT: null, toT: null }
    function startTween(toP, toT, opts = {}) {
      tween.fromP = camera.position.clone()
      tween.toP = toP
      tween.fromT = lookTarget.clone()
      tween.toT = toT
      tween.t = 0
      tween.dur = opts.dur || 1.2
      tween.ease = opts.ease || 'smooth'
      tween.active = true
    }

    // ---- status refresh ----
    const api = {
      applyNodes(fresh) {
        fresh.forEach((n) => { latest[n.name] = n })
        restyle()
      },
      focus(name) { focus(name) },   // exposed for debugging/tests
      unfocus,
    }
    api.applyNodes(nodes)
    window.__flyoverApi = api

    // ---- first-person fly controls ----
    const controls = new PointerLockControls(camera, renderer.domElement)
    const keys = {}
    const onKeyDown = (e) => {
      if (e.code === 'KeyQ' && !document.querySelector('.modal-overlay')) { onClose(); return }
      if (e.code === 'KeyB') { unfocus(); return }
      if (e.code === 'KeyT') {
        hillsOn = !hillsOn
        applyTerrain(hillsOn)
        return
      }
      if (document.pointerLockElement && (e.code === 'Space' || e.code === 'ControlLeft')) e.preventDefault()
      keys[e.code] = true
    }
    const onKeyUp = (e) => { keys[e.code] = false }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)

    let moveSpeed = 46
    const onWheel = (e) => {
      moveSpeed = Math.min(220, Math.max(10, moveSpeed * (e.deltaY > 0 ? 0.85 : 1.18)))
    }
    renderer.domElement.addEventListener('wheel', onWheel, { passive: true })

    // picking + control. Preferred path is pointer lock; if the API is denied
    // (permissions policy, kiosk, some Chrome states) we fall back to
    // drag-to-look with cursor picking so the mode never becomes a screensaver.
    const raycaster = new THREE.Raycaster()
    const center = new THREE.Vector2(0, 0)
    const pointerNDC = new THREE.Vector2()
    let lockedAt = 0      // ignore clicks right after grabbing the mouse (double-click echo)
    let everLocked = false
    let freeLook = false  // drag-to-look fallback active
    camera.rotation.order = 'YXZ'
    const enterFreeLook = () => {
      if (freeLook) return
      freeLook = true
      setFreeLook(true)
      dismissIntro()
    }
    const onLockChange = () => {
      const nowLocked = !!document.pointerLockElement
      if (nowLocked) {
        everLocked = true
        lockedAt = performance.now()
        dismissIntro()   // grabbing the controls counts as having seen the intro
      }
      setLocked(nowLocked)
    }
    document.addEventListener('pointerlockchange', onLockChange)
    const onLockError = () => {
      // esc-mash cooldown also lands here; only switch modes if lock never worked
      if (!everLocked) enterFreeLook()
    }
    document.addEventListener('pointerlockerror', onLockError)

    function hitTargets() {
      const targets = []
      Object.entries(nodeObjs).forEach(([name, o]) => {
        targets.push(o.fill)
        if (focusRef.current === name && o.interior) {
          targets.push(o.interior.ssh.fillM, o.interior.upd.fillM)
        }
      })
      return targets
    }
    function applyHit(hit) {
      if (!hit) {
        unfocus()
        return
      }
      const ud = hit.object.userData
      if (ud.intent) {
        const n = latest[ud.nodeName]
        if (!n?.online) return   // offline nodes can't SSH or update
        if (document.pointerLockElement) document.exitPointerLock()
        if (onSelect) onSelect(ud.nodeName, ud.intent)
      } else {
        focus(ud.nodeName)
      }
    }
    // locked mode: crosshair raycast from screen centre
    const onMouseDown = (e) => {
      if (!document.pointerLockElement) return
      if (e.target !== renderer.domElement) return            // UI chrome, never ours
      if (performance.now() - lockedAt < 350) return          // the click that grabbed the mouse
      raycaster.setFromCamera(center, camera)
      applyHit(raycaster.intersectObjects(hitTargets())[0])
    }
    renderer.domElement.addEventListener('mousedown', onMouseDown)

    // free-look mode: drag to look; a short click (< 6px movement) picks at the cursor
    const drag = { down: false, x: 0, y: 0, moved: 0 }
    const onFreeDown = (e) => {
      if (!freeLook || document.pointerLockElement) return
      if (e.target !== renderer.domElement) return
      drag.down = true; drag.x = e.clientX; drag.y = e.clientY; drag.moved = 0
    }
    const onFreeMove = (e) => {
      if (!drag.down) return
      const dx = e.clientX - drag.x
      const dy = e.clientY - drag.y
      drag.x = e.clientX; drag.y = e.clientY
      drag.moved += Math.abs(dx) + Math.abs(dy)
      const eu = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ')
      eu.y -= dx * 0.0024
      eu.x = Math.max(-1.5, Math.min(1.5, eu.x - dy * 0.0024))
      camera.quaternion.setFromEuler(eu)
    }
    const onFreeUp = (e) => {
      if (!drag.down) return
      drag.down = false
      if (drag.moved >= 6) return   // that was a look-drag, not a pick
      if (document.querySelector('.modal-overlay')) return
      const r = renderer.domElement.getBoundingClientRect()
      pointerNDC.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1
      )
      raycaster.setFromCamera(pointerNDC, camera)
      applyHit(raycaster.intersectObjects(hitTargets())[0])
    }
    renderer.domElement.addEventListener('mousedown', onFreeDown)
    window.addEventListener('mousemove', onFreeMove)
    window.addEventListener('mouseup', onFreeUp)

    const onClick = (e) => {
      if (e.target !== renderer.domElement) return
      if (document.pointerLockElement || freeLook) return
      if (document.querySelector('.modal-overlay')) return
      try {
        const p = renderer.domElement.requestPointerLock()
        p?.catch?.(() => { if (!everLocked) enterFreeLook() })
      } catch {
        if (!everLocked) enterFreeLook()
      }
    }
    renderer.domElement.addEventListener('click', onClick)

    // ---- resize ----
    const onResize = () => {
      if (!mount.clientWidth) return
      camera.aspect = mount.clientWidth / mount.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(mount.clientWidth, mount.clientHeight)
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(mount)

    // ---- render loop ----
    const clock = new THREE.Clock()
    let elapsed = 0
    let raf
    const startLoop = () => {
      if (raf) return
      clock.getDelta()   // swallow the pause so dt doesn't jump
      animate()
    }
    const stopLoop = () => {
      cancelAnimationFrame(raf)
      raf = undefined
    }
    const onVisibility = () => {
      if (document.hidden) {
        stopLoop()
      } else if (!window.__glFailed) {
        startLoop()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2)
    const forward = new THREE.Vector3()
    const right = new THREE.Vector3()
    const UP = new THREE.Vector3(0, 1, 0)
    const vel = new THREE.Vector3()
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const animate = () => {
      raf = requestAnimationFrame(animate)
      const dt = Math.min(clock.getDelta(), 0.05)
      elapsed += dt
      const t = elapsed

      // boxes bob over the canyon (static when the user prefers reduced motion)
      Object.values(nodeObjs).forEach((o) => {
        if (!reducedMotion) {
          o.group.position.y = o.size / 2 + 6 + Math.sin(t * 0.7 + o.group.userData.phase) * 1.1
        }
        o.tiles.children.forEach((tile, ti) => {
          tile.rotation.y += dt * 0.4 + ti * 0.0004
        })
      })

      if (!reducedMotion) {
        // heart beam breathes
        beam.material.opacity = 0.26 + Math.sin(t * 1.6) * 0.08
        heartGlow.material.opacity = 0.7 + Math.sin(t * 1.6) * 0.2
        heartGlow.scale.setScalar(30 + Math.sin(t * 1.6) * 5)
        rings.forEach((ring, i) => {
          const p = ((t + i * 1.4) % 2.8) / 2.8
          ring.scale.setScalar(4 + p * 34)
          ring.material.opacity = 0.5 * (1 - p)
        })
      }

      // trails
      trails.forEach((tr) => {
        if (!tr.dot.visible) return
        const p = (t * 0.09 + tr.phase) % 1
        tr.dot.position.copy(pointOnPath(tr.path, p))
      })

      // focused tower's spotlight ring breathes
      if (focusRing.visible) {
        const s = (focusRing.userData.baseScale || 20) * (1 + Math.sin(t * 2.4) * 0.07)
        focusRing.scale.setScalar(s)
        focusRing.material.opacity = 0.55
      }

      // one full package name at a time: the block under the reticle/cursor
      updateBlockTip()

      // keep SSH / UPDATE clickable: enforce a minimum on-screen gap
      if (focusRef.current && nodeObjs[focusRef.current]) {
        layoutActionRow(nodeObjs[focusRef.current])
      }

      // flight — velocity is smoothed toward the keyed direction so holds
      // accelerate in and single taps glide a little instead of barely moving
      if (document.pointerLockElement || freeLook) {
        camera.getWorldDirection(forward)
        right.crossVectors(forward, UP).normalize()
        const wish = new THREE.Vector3()
        if (keys.KeyW) wish.add(forward)
        if (keys.KeyS) wish.sub(forward)
        if (keys.KeyD) wish.add(right)
        if (keys.KeyA) wish.sub(right)
        if (keys.Space) wish.y += 1
        if (keys.KeyC || keys.ControlLeft) wish.y -= 1
        if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(moveSpeed)
        // frame-rate independent exponential smoothing (~0.12s to ~90% speed)
        vel.lerp(wish, 1 - Math.pow(0.00005, dt))
        camera.position.addScaledVector(vel, dt)
        camera.position.y = Math.max(GRID_Y + 3, Math.min(camera.position.y, 260))
      } else {
        vel.set(0, 0, 0)
      }

      // camera tween — the 'dive' bulges toward the tower mid-flight then
      // settles onto it by arrival (bounded, so it can never enter geometry)
      if (tween.active) {
        tween.t += dt / tween.dur
        const raw = Math.min(tween.t, 1)
        camera.position.lerpVectors(tween.fromP, tween.toP, easeInOut(raw))
        if (tween.ease === 'dive') {
          const travel = tween.fromP.distanceTo(tween.toP)
          camera.position.addScaledVector(
            tween.toP.clone().sub(tween.fromP).normalize(),
            Math.sin(raw * Math.PI) * Math.min(14, travel * 0.08)
          )
        }
        lookTarget.lerpVectors(tween.fromT, tween.toT, easeInOut(raw))
        camera.lookAt(lookTarget)
        if (tween.t >= 1) tween.active = false
      } else if (focusRef.current !== null && (document.pointerLockElement || freeLook)) {
        // flew away from the focused box -> drop back to fleet view
        const o = nodeObjs[focusRef.current]
        if (o && camera.position.distanceTo(o.group.position) > o.size * 4 + 34) unfocus()
      }

      // name-label collisions: when two node names overlap on screen, the
      // farther one fades (same treatment focus mode gives background labels)
      resolveLabelOverlaps()

      renderer.render(scene, camera)
    }
    animate()

    return () => {
      stopLoop()
      document.removeEventListener('visibilitychange', onVisibility)
      ro.disconnect()
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('pointerlockchange', onLockChange)
      document.removeEventListener('pointerlockerror', onLockError)
      renderer.domElement.removeEventListener('wheel', onWheel)
      renderer.domElement.removeEventListener('mousedown', onMouseDown)
      renderer.domElement.removeEventListener('mousedown', onFreeDown)
      window.removeEventListener('mousemove', onFreeMove)
      window.removeEventListener('mouseup', onFreeUp)
      renderer.domElement.removeEventListener('click', onClick)
      delete window.__flyoverApi
      disposables.forEach((d) => d.dispose?.())
      ringGeo.dispose()
      starGeo.dispose()
      starMat.dispose()
      controls.disconnect?.()
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (window.__flyoverApi) window.__flyoverApi.applyNodes(nodes)
  })

  // Escape closes the flyover only when the mouse is free and no modal is open
  useEffect(() => {
    const onKey = (e) => {
      if (
        e.key === 'Escape' &&
        !document.pointerLockElement &&
        !document.querySelector('.modal-overlay')
      ) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (glFailed) {
    return (
      <div className="flyover">
        <div className="flyover-hud">
          <span className="flyover-title">✦ Fleet flyover</span>
          <button className="btn ghost" onClick={onClose}>Exit</button>
        </div>
        <div className="flyover-fallback">
          WebGL isn't available in this browser, so the flyover can't render.
          The 2D constellation still has everything.
        </div>
      </div>
    )
  }

  return (
    <div className="flyover">
      <div className="flyover-hud">
        <span className="flyover-title">✦ Fleet <span>fsn</span></span>
        <span className={`flyover-speed ${locked ? '' : 'dim'}`}>
          {locked
            ? (focusName
                ? 'click SSH / UPDATE · click another box to hop · B or fly away to back out'
                : 'WASD fly · scroll speed · click a box to inspect')
            : freeLook
              ? 'drag to look · WASD fly · scroll speed · click a box to inspect'
              : 'click to take the controls'}
        </span>
        <button
          className="btn ghost"
          onClick={(e) => { e.stopPropagation(); onClose() }}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          Exit
        </button>
      </div>
      {locked && <div className="flyover-crosshair" />}
      {/* fixed screen-space strip: information lives in DOM, never in a
          depth fight with world geometry */}
      {focusName && (() => {
        const nd = nodes.find((x) => x.name === focusName)
        const offline = !nd?.online
        return (
          <div className={`flyover-infobar ${offline ? 'off' : ''}`}>
            <span className="fi-name">{focusName}</span>
            <span className="fi-meta">
              {offline ? 'OFFLINE' : [osLabel(nd), nd?.arch, `${nd?.pending_updates || 0} pending`].filter(Boolean).join(' · ')}
            </span>
            <span className="fi-actions">
              <button
                disabled={offline}
                onMouseDown={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); if (!offline && onSelect) onSelect(focusName, 'ssh') }}
              >
                SSH
              </button>
              <button
                className="danger"
                disabled={offline || nd?.updating}
                onMouseDown={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); if (!offline && !nd?.updating && onSelect) onSelect(focusName, 'update') }}
              >
                {nd?.updating ? 'UPDATING…' : `UPDATE${nd?.pending_updates ? ` (${nd.pending_updates})` : ''}`}
              </button>
            </span>
          </div>
        )
      })()}
      {!locked && showIntro && (
        <div className="flyover-lockhint">
          <div className="flyover-lockhint-big">It's a Unix system.</div>
          <div className="flyover-lockhint-sub">You know this.<br/>Click anywhere to take the controls.</div>
          <div className="flyover-lockhint-keys">
            <span><b>mouse</b> look</span>
            <span><b>W A S D</b> fly</span>
            <span><b>Space / C</b> rise / sink</span>
            <span><b>scroll</b> cruise speed</span>
            <span><b>click box</b> enter node</span>
            <span><b>B / fly away</b> back out</span>
            <span><b>T</b> flat / hills</span>
            <span><b>Q / Esc</b> release · exit</span>
          </div>
        </div>
      )}
      <div className="flyover-scene" ref={mountRef} />
    </div>
  )
}
