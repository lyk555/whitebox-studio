// The set: a floor plan to arrange it on, and the real stage to walk it.
import { $, api, ask, attempt, el, emptyState, field, fill, flushSave, go, hooks, icon, locked, nextButton, pageBar, project, readingBanner, readonly, resetNode, runScope, running, saveSoon, state, svg, toast } from './core.js'

let frameVersion = 0
let saying = null // What was just said to the designer, while the answer is on its way.

const shapeOf = object => object.shape ?? state.catalog.archetypes[object.archetype]

// A rough model as a small plaster drawing, seen from above the camera's side.
function shapeSketch(shape, width = 76) {
  const project2d = ([x, y, z]) => [0.87 * x - 0.5 * z, -0.95 * y + 0.22 * x + 0.42 * z]
  const faces = []
  const face = (points, tone, depth) => faces.push({ points, tone, depth })
  for (const part of shape.parts ?? []) {
    const [x, y, z] = part.at
    if (part.shape === 'box') {
      const [w, h, d] = part.size
      const [x0, x1, y0, y1, z0, z1] = [x - w / 2, x + w / 2, y - h / 2, y + h / 2, z - d / 2, z + d / 2]
      const depth = x * 0.5 + z * 0.8 + y * 0.45
      face([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], 'side', depth)
      face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], 'front', depth)
      face([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], 'top', depth)
    } else if (part.shape === 'round') {
      const steps = 14
      const ring = (radius, level, turn) => [x + radius * Math.cos(turn), level, z + radius * Math.sin(turn)]
      const depth = x * 0.5 + z * 0.8 + y * 0.45
      for (let i = 0; i < steps; i++) {
        const [a, b] = [(i / steps) * 2 * Math.PI, ((i + 1) / steps) * 2 * Math.PI]
        const facing = Math.cos((a + b) / 2) * 0.5 + Math.sin((a + b) / 2) * 0.86
        if (facing <= 0) continue
        const bottom = y - part.height / 2
        const top = y + part.height / 2
        face([ring(part.radiusBottom, bottom, a), ring(part.radiusBottom, bottom, b), ring(part.radiusTop, top, b), ring(part.radiusTop, top, a)], facing > 0.6 ? 'front' : 'side', depth)
      }
      face(Array.from({ length: steps }, (_, i) => ring(part.radiusTop, y + part.height / 2, (i / steps) * 2 * Math.PI)), 'top', depth + 0.01)
    } else {
      const steps = 8
      const [x0, x1] = [x - part.length / 2, x + part.length / 2]
      const arc = turn => [y + part.radius * Math.sin(turn), z + part.radius * Math.cos(turn)]
      const depth = x * 0.5 + z * 0.8 + y * 0.45
      for (let i = 0; i < steps; i++) {
        const [ya, za] = arc((i / steps) * Math.PI)
        const [yb, zb] = arc(((i + 1) / steps) * Math.PI)
        face([[x0, ya, za], [x1, ya, za], [x1, yb, zb], [x0, yb, zb]], i < steps / 2 ? 'front' : 'top', depth)
      }
      face(Array.from({ length: steps + 1 }, (_, i) => { const [ya, za] = arc((i / steps) * Math.PI); return [x1, ya, za] }), 'side', depth + 0.01)
    }
  }
  const flat = faces.sort((a, b) => a.depth - b.depth).map(item => ({ ...item, points: item.points.map(project2d) }))
  const all = flat.flatMap(item => item.points)
  const xs = all.map(point => point[0])
  const ys = all.map(point => point[1])
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const pad = Math.max(maxX - minX, maxY - minY) * 0.08 || 0.1
  return svg('svg', { class: 'sketch', width, height: width, viewBox: `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`, 'aria-hidden': 'true' },
    flat.map(item => svg('polygon', { class: `sketch-${item.tone}`, points: item.points.map(point => point.join(',')).join(' ') })))
}

async function sayToDesigner(text) {
  const said = text.trim()
  if (!said || saying) return
  saying = said
  state.selection.chatDraft = ''
  drawInspector()
  try {
    await flushSave()
    state.view = await api(`/api/projects/${state.projectId}/set-chat`, { method: 'POST', body: { sceneId: currentScene().id, message: said, selected: state.selection.whiteboxObject } })
    frameVersion++
    hooks.renderChrome()
  } catch (error) {
    state.selection.chatDraft = said
    toast(error.message, true)
  } finally {
    saying = null
    drawInspector()
    drawViewport()
    $('wb-chat')?.focus()
  }
}

// One place to ask for anything about the room, in the person's own words.
function designerChat(scene) {
  const { selection } = state
  const lines = scene.chat ?? []
  const picked = scene.objects.find(object => object.id === selection.whiteboxObject)
  const hasUndo = Boolean(scene.undo)
  const log = el('div', { class: 'chat-log', id: 'wb-chat-log' },
    !lines.length && !saying ? el('div', { class: 'chat-starters' },
      [`把“${scene.beats[0]?.objectName ?? '第一件东西'}”做得更有特点`, '东西全部靠墙，中间留空', '加一件只有这个地方才有的东西'].map(line => el('button', { class: 'quiet', onclick: () => sayToDesigner(line) }, line))) : null,
    lines.map((line, index) => {
      if (line.role === 'user') return el('div', { class: 'chat-line me' }, line.text)
      const made = (line.changed ?? []).map(id => scene.objects.find(object => object.id === id)).filter(Boolean)
      return el('div', { class: `chat-line designer ${line.failed ? 'failed' : ''}` }, line.text,
        made.length ? el('div', { class: 'chat-made' }, made.map(object => el('button', { title: object.name, onclick: () => pickObject(object.id) }, shapeOf(object) ? shapeSketch(shapeOf(object), 58) : null, el('small', {}, object.name)))) : null,
        hasUndo && index === lines.length - 1 && !line.failed && made.length ? el('button', { class: 'quiet chat-undo', disabled: locked() || Boolean(saying), onclick: attempt(async () => {
          state.view = await api(`/api/projects/${state.projectId}/set-chat/undo`, { method: 'POST', body: { sceneId: scene.id } })
          frameVersion++
          hooks.renderChrome()
          drawInspector()
          drawViewport()
        }) }, icon('rotate-ccw', 13), '撤销这次修改') : null)
    }),
    saying ? [el('div', { class: 'chat-line me' }, saying), el('div', { class: 'chat-line designer thinking' }, icon('loader-circle', 14), '正在改，要检查走不走得通、拍不拍得到……')] : null)
  const box = el('textarea', {
    id: 'wb-chat', rows: 2, disabled: locked() || Boolean(saying), 'aria-label': '告诉布景师要怎么改',
    placeholder: picked ? `对“${picked.name}”，你想怎么改？` : '想要什么，直接说：比如第二步换成一台打字机',
    value: selection.chatDraft ?? '',
    oninput: event => { selection.chatDraft = event.target.value },
    onkeydown: event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault()
        sayToDesigner(event.target.value)
      }
    },
  })
  queueMicrotask(() => { const host = $('wb-chat-log'); if (host) host.scrollTop = host.scrollHeight })
  return el('div', { class: 'block chat' }, el('h3', {}, '和布景师说'), log,
    el('div', { class: 'chat-box' }, box, el('button', { class: 'primary icon-only', 'aria-label': '发送', disabled: locked() || Boolean(saying), onclick: () => sayToDesigner(box.value) }, icon('arrow-up', 15))))
}

function currentScene() {
  const { selection } = state
  const { scenes } = project()
  if (!scenes.some(scene => scene.id === selection.whiteboxScene)) selection.whiteboxScene = scenes[0]?.id
  return scenes.find(scene => scene.id === selection.whiteboxScene)
}

function cones(root, { room, cameras }) {
  const clipId = 'plan-clip'
  root.append(svg('clipPath', { id: clipId }, svg('rect', { x: room.west, y: room.north, width: room.east - room.west, height: room.south - room.north })))
  const group = svg('g', { 'clip-path': `url(#${clipId})` })
  // One fixed camera is stored as two the same, so that the stage does not have to know.
  for (const [id, camera] of Object.entries(cameras).filter(([id, camera]) => !camera.fixed || id === 'a')) {
    const [px, , pz] = camera.position
    const [tx, , tz] = camera.target
    const heading = Math.atan2(tx - px, tz - pz)
    const halfAngle = Math.atan(Math.tan((camera.fov * Math.PI) / 360) * (16 / 9))
    const ray = turn => [px + Math.sin(heading + turn) * 40, pz + Math.cos(heading + turn) * 40]
    const [lx, lz] = ray(-halfAngle)
    const [rx, rz] = ray(halfAngle)
    group.append(svg('polygon', { class: 'cone', points: `${px},${pz} ${lx},${lz} ${rx},${rz}` }))
    group.append(svg('line', { class: 'cone-edge', x1: px, y1: pz, x2: lx, y2: lz }), svg('line', { class: 'cone-edge', x1: px, y1: pz, x2: rx, y2: rz }))
    const labelZ = room.south + 0.42
    root.append(svg('text', { class: 'cone-label', x: px + ((tx - px) / (tz - pz)) * (labelZ - pz), y: labelZ, 'text-anchor': 'middle' }, camera.fixed ? '固定机位' : `机位 ${id.toUpperCase()}`))
  }
  root.append(group)
}

function planView(scene, data, onMoved, onPick) {
  const { selection } = state
  const flagged = new Set(data.issues.filter(issue => issue.object).map(issue => issue.object))
  const used = new Set(scene.beats.map(beat => beat.object).filter(Boolean))
  const editable = !locked()
  const { room, door, corridor, kind, exit, exits } = data.shell
  const VIEW = { minX: room.west - 0.5, maxX: room.east + 0.5, minZ: room.north - 2.8, maxZ: room.south + 1.3 }
  const root = svg('svg', { class: 'plan', viewBox: `${VIEW.minX} ${VIEW.minZ} ${VIEW.maxX - VIEW.minX} ${VIEW.maxZ - VIEW.minZ}`, role: 'img', 'aria-label': `${scene.title}的平面图，拖动物件调整位置`, preserveAspectRatio: 'xMidYMid meet' })
  // The passage behind the door, and the room.
  if (exit === 'door') {
    const passage = { x: door.x - 0.8, width: 1.9 }
    root.append(svg('rect', { class: 'passage', x: passage.x, y: room.north - 2.5, width: passage.width, height: 2.5 }))
    root.append(svg('text', { class: 'label', x: passage.x + passage.width / 2, y: room.north - 1.25 }, '门后通道'))
  } else if (scene.exits) {
    // Where each way out on the map comes out, and where it goes.
    for (const way of exits) root.append(svg('text', { class: 'label', x: way.x, y: room.north - 0.25 }, `去${project().scenes.find(other => other.id === scene.exits.find(item => item.id === way.id)?.to)?.title ?? '别处'}`))
  } else {
    root.append(svg('text', { class: 'label', x: door.x, y: room.north - 0.25 }, '出口'))
  }
  root.append(svg('rect', { class: `room ${kind === 'outdoor' ? 'outdoor' : ''}`, x: room.west, y: room.north, width: room.east - room.west, height: room.south - room.north }))
  for (let x = room.west + 1; x < room.east; x++) root.append(svg('line', { class: 'grid', x1: x, x2: x, y1: room.north, y2: room.south }))
  for (let z = room.north + 1; z < room.south; z++) root.append(svg('line', { class: 'grid', x1: room.west, x2: room.east, y1: z, y2: z }))
  cones(root, data.shell)
  for (const way of scene.exits ? exits : [door]) root.append(svg('rect', { class: `door ${way.kind === 'door' || exit === 'door' ? '' : 'opening'}`, x: way.x - way.width / 2, y: room.north - 0.07, width: way.width, height: 0.14 }))
  const selectedBeat = data.story.beats.find(beat => {
    const source = scene.beats.find(candidate => candidate.id === beat.id)
    return source?.object && source.object === selection.whiteboxObject
  })
  if (selectedBeat?.target) root.append(svg('circle', { class: 'reach', cx: selectedBeat.target.x, cy: selectedBeat.target.z, r: selectedBeat.target.radius }))
  const toPlan = event => {
    const point = root.createSVGPoint()
    point.x = event.clientX
    point.y = event.clientY
    return point.matrixTransform(root.getScreenCTM().inverse())
  }
  for (const block of data.blocks) {
    const [x, , z] = block.center
    const [w, , d] = block.size
    const classes = ['object', used.has(block.name) && 'story', block.onTop && 'top', selection.whiteboxObject === block.name && 'on', flagged.has(block.name) && 'has-issue'].filter(Boolean).join(' ')
    const rect = svg('rect', { x: x - w / 2, y: z - d / 2, width: w, height: d, rx: 0.04 })
    const carries = data.blocks.some(other => other.onTop && Math.abs(other.center[0] - x) < w / 2 && Math.abs(other.center[2] - z) < d / 2)
    const fits = !carries && d >= 0.45 && block.label.length * 0.2 < w - 0.1
    const label = svg('text', { x, y: fits ? z : z + d / 2 + 0.17, class: fits ? '' : 'outside' }, block.onTop ? '' : block.label)
    const group = svg('g', { class: classes }, svg('title', {}, block.label), rect, label)
    if (!block.onTop) {
      let grab = null
      group.addEventListener('pointerdown', event => {
        if (!editable) { onPick(block.name); return }
        const at = toPlan(event)
        grab = { dx: at.x - x, dz: at.y - z, moved: false }
        group.setPointerCapture(event.pointerId)
      })
      group.addEventListener('pointermove', event => {
        if (!grab) return
        const at = toPlan(event)
        grab.moved = true
        grab.x = Math.round((at.x - grab.dx) / 0.05) * 0.05
        grab.z = Math.round((at.y - grab.dz) / 0.05) * 0.05
        rect.setAttribute('x', grab.x - w / 2)
        rect.setAttribute('y', grab.z - d / 2)
        label.setAttribute('x', grab.x)
        label.setAttribute('y', fits ? grab.z : grab.z + d / 2 + 0.17)
      })
      group.addEventListener('pointerup', () => {
        const done = grab
        grab = null
        if (done?.moved) onMoved(block.name, Number(done.x.toFixed(2)), Number(done.z.toFixed(2)))
        else onPick(block.name)
      })
    }
    root.append(group)
  }
  data.story.beats.forEach((beat, index) => {
    if (!beat.anchor) return
    root.append(svg('circle', { class: 'mark', cx: beat.anchor.x, cy: beat.anchor.z, r: 0.08 }))
    root.append(svg('text', { class: 'label mark-label', x: beat.anchor.x, y: beat.anchor.z + 0.25 }, beat.id === 'door' ? '推门站位' : `第 ${index + 1} 步站位`))
  })
  root.append(svg('circle', { class: 'spawn', cx: data.spawn.x, cy: data.spawn.z, r: 0.11 }))
  root.append(svg('text', { class: 'label spawn-label', x: data.spawn.x, y: data.spawn.z + 0.29 }, '起点'))
  const scaleEnd = room.east
  const scaleY = room.north - 0.45
  root.append(svg('line', { class: 'scale', x1: scaleEnd - 2, x2: scaleEnd, y1: scaleY, y2: scaleY }), svg('line', { class: 'scale', x1: scaleEnd - 2, x2: scaleEnd - 2, y1: scaleY - 0.08, y2: scaleY + 0.08 }), svg('line', { class: 'scale', x1: scaleEnd, x2: scaleEnd, y1: scaleY - 0.08, y2: scaleY + 0.08 }))
  root.append(svg('text', { class: 'scale-label', x: scaleEnd - 1, y: scaleY - 0.15 }, '2 米'))
  return root
}

function drawViewport() {
  const host = $('wb-viewport')
  if (!host) return
  const { selection, view } = state
  const scene = currentScene()
  const data = view.stages[scene.id]
  const wantsWalk = selection.wbView === 'walk'
  const blocked = data.issues.some(issue => issue.level === 'error')
  const tabs = $('wb-tabs')
  if (tabs) for (const button of tabs.children) button.classList.toggle('on', button.dataset.view === (wantsWalk ? 'walk' : 'plan'))
  if (wantsWalk) {
    host.className = 'viewport'
    if (blocked) {
      fill(host, emptyState('triangle-alert', '现在还走不进去', '右边列出了要解决的问题，回平面图挪一挪就好。', el('button', { onclick: () => { selection.wbView = 'plan'; drawViewport() } }, '回平面图')))
      return
    }
    const src = `/play/${state.projectId}/${scene.id}/?view=clay&v=${frameVersion}`
    if (host.querySelector('iframe')?.getAttribute('src') !== src) fill(host, el('iframe', { class: 'stage-frame', title: '走进白模', src }))
    return
  }
  host.className = 'viewport plan-view'
  const moved = (id, x, z) => {
    const object = scene.objects.find(candidate => candidate.id === id)
    if (object) Object.assign(object, { x, z, slot: null })
    selection.whiteboxObject = id
    saveGeometry()
  }
  fill(host, planView(scene, data, moved, pickObject))
}

function saveGeometry() {
  saveSoon({ scenes: project().scenes }, () => { frameVersion++; drawInspector(); drawViewport() })
}

function pickObject(id) {
  state.selection.whiteboxObject = id
  drawInspector()
  if (state.selection.wbView !== 'walk') drawViewport()
}

function drawInspector() {
  const host = $('wb-inspector')
  if (!host) return
  const p = project()
  const { selection, view, catalog } = state
  const scene = currentScene()
  const data = view.stages[scene.id]
  const selected = scene.objects?.find(object => object.id === selection.whiteboxObject)
  const block = data.blocks.find(candidate => candidate.name === selection.whiteboxObject)
  const inUse = scene.beats.some(beat => beat.object === selection.whiteboxObject)
  const kinds = Object.entries(catalog.archetypes).filter(([, kind]) => !kind.onTop)
  const beatOf = name => scene.beats.findIndex(beat => beat.object === name)
  const typing = document.activeElement?.id === 'wb-chat'
  queueMicrotask(() => { if (typing) $('wb-chat')?.focus() })
  const { room, kind, exit } = data.shell
  fill(host,
    readonly() ? null : designerChat(scene),
    el('div', { class: 'block' }, el('h3', {}, '这个地方'),
      el('dl', { class: 'kv' },
        el('dt', {}, '大小'), el('dd', {}, `${(room.east - room.west).toFixed(1).replace(/\.0$/, '')} × ${(room.south - room.north).toFixed(1).replace(/\.0$/, '')} 米`),
        el('dt', {}, '环境'), el('dd', {}, kind === 'outdoor' ? '室外' : '室内'),
        el('dt', {}, '出口'), el('dd', {}, scene.exits ? scene.exits.map(way => way.name).join('、') || '没有' : `${scene.exit.name || '门'}${exit === 'door' ? '（要打开）' : '（直接走过去）'}`)),
      scene.plainLayout ? el('div', { class: 'check-line bad' }, icon('circle-alert', 15), '这里模型没摆好，先用了保底摆法。可以点上面的“重新布景”，或者直接告诉布景师想要什么。') : null),
    el('div', { class: 'block' }, el('h3', {}, '检查'),
      data.issues.length
        ? data.issues.map(issue => el('div', { class: 'check-line bad' }, icon('circle-alert', 15), issue.message))
        : (data.shell.cameras.a.fixed
          ? ['每件东西都走得到', '要互动的东西都看得全', '过道都够宽，不用挤过去', '通往出口的路是通的']
          : ['每件东西都走得到', '两个机位都拍得全', '通往出口的路是通的']).map(line => el('div', { class: 'check-line' }, icon('circle-check', 15), line))),
    selected || (readonly() && block) ? el('div', { class: 'block' },
      el('div', { class: 'inspector-head' }, el('div', {}, el('h2', {}, block?.label ?? selected.name)), el('button', { class: 'quiet icon-only', 'aria-label': '取消选中', onclick: () => pickObject(null) }, icon('x'))),
      selected && shapeOf(selected) ? el('div', { class: 'sketch-well' }, shapeSketch(shapeOf(selected), 132), el('small', { class: 'muted mono' }, `${shapeOf(selected).size.join(' × ')} m`)) : null,
      selected ? el('div', { class: 'form' },
        field('名字', selected.name, value => {
          selected.name = value
          for (const beat of scene.beats) if (beat.object === selected.id) beat.objectName = value
          saveSoon({ scenes: p.scenes })
        }),
        field('画出来的样子', selected.look, value => { selected.look = value; saveSoon({ scenes: p.scenes }) }, { multiline: true, rows: 3, hint: '白模只定形状和位置，细节靠这句话。' }),
        selected.on ? null : el('label', { class: 'field' }, el('span', {}, '体块形状'), el('select', { disabled: locked(), onchange: event => { selected.archetype = event.target.value; delete selected.shape; saveGeometry() } },
          selected.shape ? el('option', { value: '', selected: true, disabled: true }, '为它定做的形状') : null,
          kinds.map(([id, kind]) => el('option', { value: id, selected: !selected.shape && id === selected.archetype }, kind.label)))),
        inUse ? el('p', { class: 'small muted' }, `第 ${beatOf(selected.id) + 1} 步要用到它，所以不能移除。`)
          : el('div', {}, el('button', { class: 'danger', disabled: locked(), onclick: () => {
            scene.objects = scene.objects.filter(object => object.id !== selected.id && object.on !== selected.id)
            selection.whiteboxObject = null
            saveGeometry()
          } }, icon('trash-2', 14), '移除'))) : null) : null,
    el('div', { class: 'block' }, el('h3', {}, `物件 ${data.blocks.length}`),
      el('div', { class: 'outline' }, data.blocks.map(item => {
        const beat = beatOf(item.name)
        return el('button', { class: `${beat >= 0 ? 'story' : ''} ${item.onTop ? 'nested' : ''} ${selection.whiteboxObject === item.name ? 'on' : ''}`, onclick: () => pickObject(item.name) },
          el('span', { class: 'swatch' }), item.label, beat >= 0 ? el('small', {}, `第 ${beat + 1} 步`) : null)
      })),
      readonly() ? null : el('div', { class: 'row', style: 'margin-top:4px' },
        el('select', { id: 'add-kind', style: 'flex:1;width:auto;min-width:0', 'aria-label': '要添加的陈设', disabled: locked() }, kinds.map(([id, kind]) => el('option', { value: id }, kind.label))),
        el('button', { disabled: locked(), onclick: () => {
          const archetype = $('add-kind').value
          const number = Math.max(0, ...scene.objects.map(object => Number(object.id.slice(1)) || 0)) + 1
          // Out in the open near the camera, where it is easy to pick up, in a room of any size.
          const size = catalog.archetypes[archetype].size
          scene.objects.push({ id: `o${number}`, name: catalog.archetypes[archetype].label, archetype, x: Math.min(1.6, room.east - size[0] / 2 - 0.2), z: Math.min(1.2, room.south - size[2] / 2 - 0.2), look: '' })
          selection.whiteboxObject = `o${number}`
          saveGeometry()
        } }, icon('plus', 14), '添加'))),
    readonly() ? null : el('p', { class: 'small muted' }, `黑色的是故事要用到的物件，灰色的是陈设。蓝色区域是${data.shell.cameras.a.fixed ? '这一屏' : '两个机位'}拍得到的范围。${data.shell.cameras.a.fixed ? '白模定位置和大小，模型画出来的样子和细节会比方块丰富，碰撞会按画面微调。' : ''}`),
  )
}

export function renderWhitebox() {
  const p = project()
  const { selection, view } = state
  if (!p.scenes.length) return [pageBar({ title: '白模' }), el('div', { class: 'work-main' }, emptyState('box', '还没有地方', '先把故事写好，定下有哪些地方。', el('button', { class: 'primary', onclick: () => go('story') }, '去写故事')))]
  const built = p.scenes.every(scene => scene.demoStage || scene.objects?.length)
  const layoutIds = view.nodes.filter(node => node.kind === 'layout').map(node => node.id)
  const layout = attempt(async () => {
    if (built) {
      if (!await ask('重新布景？', '模型会重新决定每个场景摆什么、摆在哪，手动拖动过的位置会被替换。', '重新布景')) return
      for (const id of layoutIds) await resetNode(id)
    }
    await runScope('layout')
  })
  if (!built) {
    return [pageBar({ title: '白模', note: '在花钱之前，先走进去试试。' }), el('div', { class: 'work-main' }, readingBanner(),
      running() ? null : emptyState('box', '还没有搭白模', '模型为每个场景设计物件的形状和摆放，代码检查走不走得通、拍不拍得到。不会画任何画面。', readonly() ? null : el('button', { class: 'primary large', onclick: layout }, icon('box', 16), '搭白模')))]
  }
  const scene = currentScene()
  const setView = name => () => { selection.wbView = name; drawViewport() }
  queueMicrotask(() => { drawViewport(); drawInspector() })
  return [
    pageBar({ title: '白模', note: '布局和剧情顺序在这里定下来，现在试走不花钱。', actions: [
      readonly() ? null : el('button', { class: 'quiet', disabled: running(), onclick: layout }, icon('refresh-cw', 14), '重新布景'),
      nextButton('下一步：生成', 'generate'),
    ] }),
    el('div', { class: 'workspace' },
      el('div', { class: 'work-main flush' },
        el('div', { class: 'viewport-tabs' },
          el('div', { class: 'segmented', id: 'wb-tabs', role: 'group', 'aria-label': '视图' },
            el('button', { 'data-view': 'plan', onclick: setView('plan') }, icon('map', 13), '平面图'),
            el('button', { 'data-view': 'walk', onclick: setView('walk') }, icon('footprints', 13), '走进去')),
          el('span', { class: 'spacer' }),
          p.scenes.length > 1 ? el('div', { class: 'segmented', role: 'group', 'aria-label': '场景' }, p.scenes.map(item => el('button', { class: item.id === scene.id ? 'on' : '', onclick: () => { selection.whiteboxScene = item.id; selection.whiteboxObject = null; hooks.renderPage() } }, item.title))) : el('b', { style: 'font:500 14px var(--story)' }, scene.title)),
        readingBanner(),
        el('div', { class: 'viewport', id: 'wb-viewport' })),
      el('aside', { class: 'inspector', id: 'wb-inspector' })),
  ]
}
