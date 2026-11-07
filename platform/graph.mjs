// What a project has to go through, as a graph. Rebuilt from the project's data every time, so there is
// nothing to keep in sync: change a line of the story and the graph is simply different.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT } from './config.mjs'
import { regionsFor, thingCentres, thingSizes } from './detail.mjs'
import { DIRECTIONS, facePrompt, filmClips, platePrompts, propPrompt, refinePrompt, standPrompt, walkPrompt } from './prompts.mjs'
import { shellFrom } from '../runtime/shell.js'
import { buildStage, wallsFirstCameraSees } from './stage.mjs'
import { castOnScreen } from './breakdown.mjs'
import { filmOrder, isWorld } from './world.mjs'

const MEMO_LIMIT = 64
const stageMemo = new Map()

// Finding marks walks a simulated player around, so the same scene is only ever worked out once.
export function stageOf(scene) {
  if (scene.demoStage) return demoStage(scene)
  const key = JSON.stringify([scene.stage, scene.title, scene.openingLine, scene.endingLine, scene.objects, scene.beats, scene.props, scene.carried, scene.exit, scene.paint, scene.exits, scene.id])
  if (!stageMemo.has(key)) {
    if (stageMemo.size >= MEMO_LIMIT) stageMemo.delete(stageMemo.keys().next().value)
    stageMemo.set(key, buildStage(scene))
  }
  return stageMemo.get(key)
}

let demoData = null
export async function loadDemoData() {
  demoData = (await import('../runtime/sceneData.js')).default
  return demoData
}

const DEMO_LABELS = { table: '长桌', lamp: '台灯', pillar: '石柱', shelf: '书架', chest: '木箱', cabinet: '高柜', couch: '沙发' }

function demoStage() {
  return { data: demoData, blocks: demoData.blocks.map(block => ({ ...block, label: DEMO_LABELS[block.name] ?? block.name, onTop: block.name === 'lamp' })), issues: [], ok: true, shell: shellFrom() }
}

const PAINT_ATTEMPTS = 3
const AUTHORING = 'authoring'
const FACING = { e: '侧面', n: '背面', s: '正面', ne: '侧背面', se: '侧正面' }

export function buildGraph(project) {
  const nodes = []
  const add = node => { nodes.push(node); return node.id }

  if (project.readonly) {
    add(filmNode(project, []))
    return nodes
  }

  // ---------------------------------------------------------------- reading the story
  // Projects read before this step existed have no premise, and stay as they were read. What it is hashed from is what the
  // person wrote, so the fuller story it leaves behind does not make it out of date.
  const writesWholeStory = project.premise !== undefined
  const world = isWorld(project)
  if (world) {
    // In the order a person would think it through, and each can be looked at and changed before the next. Nothing about
    // these says what they read: what they wrote is edited by hand and by the Agent, and neither should ever bring a writer
    // back to write over it. They run when they are asked to, and only then.
    add({ id: 'story:outline', kind: 'outline', group: AUTHORING, resource: 'text', title: '定章节和锚点', lane: '拆解', params: {} })
    add({ id: 'story:cast', kind: 'cast', group: AUTHORING, resource: 'text', title: '定人物', lane: '拆解', deps: ['story:outline'], params: {} })
    add({ id: 'story:world', kind: 'world', group: AUTHORING, resource: 'text', title: '设计地点图', lane: '拆解', deps: ['story:cast'], params: {} })
    add({ id: 'story:script', kind: 'script', group: AUTHORING, resource: 'text', title: '写每个锚点的戏', lane: '拆解', deps: ['story:world'], params: {} })
  } else {
    if (writesWholeStory) add({ id: 'story:plot', kind: 'plot', group: AUTHORING, resource: 'text', title: '写完整故事', lane: '拆解', params: { premise: project.premise ?? project.story } })
    add({ id: 'story:cast', kind: 'cast', group: AUTHORING, resource: 'text', title: '拆人物', lane: '拆解', ...(writesWholeStory ? { deps: ['story:plot'] } : {}), params: { story: project.story } })
    add({ id: 'story:scenes', kind: 'scenes', group: AUTHORING, resource: 'text', title: '拆场景', lane: '拆解', deps: ['story:cast'], params: { story: project.story, cast: project.cast.map(person => person.name) } })
  }
  for (const scene of project.scenes) {
    add({
      id: `story:layout:${scene.id}`, kind: 'layout', group: AUTHORING, resource: 'text', title: `搭白模 · ${scene.title}`, lane: '拆解', sceneId: scene.id, deps: [world ? 'story:script' : 'story:scenes'],
      params: { title: scene.title, place: scene.place, mood: scene.mood, style: project.style, beats: scene.beats.map(beat => [beat.objectName, beat.performed]) },
    })
  }

  const player = project.cast.find(person => person.playable) ?? project.cast[0]
  const ready = player && project.scenes.length && project.scenes.every(scene => scene.objects?.length)
  if (!ready) return nodes
  // Worked out from the story every time, like the rest of this graph. A story that cannot yet be walked keeps every clip.
  const clipOrder = world ? filmOrder(project) : null

  // ---------------------------------------------------------------- people
  const faceFile = person => `cast/${person.id}/plate_face.png`
  // Who the story ended up not showing has no face to pay for.
  for (const person of world ? castOnScreen(project.cast, project.scenes) : project.cast) {
    add({ id: `cast:${person.id}:face`, kind: 'image', resource: 'image', title: '定妆照', lane: `人物 · ${person.name}`, outputs: [faceFile(person)], params: { prompt: facePrompt(person), references: [], size: '2048x2048', hint: { kind: 'face' } } })
  }
  const dir = `cast/${player.id}`
  const [pilot, ...others] = Object.keys(DIRECTIONS)
  const lane = `人物 · ${player.name}`
  const walkNode = (direction, deps, inputs, hasFeet) => ({
    id: `cast:${player.id}:walk:${direction}`, kind: 'walk', resource: 'video', seconds: 6, title: `走路 · ${FACING[direction]}`, lane, deps, inputs, outputs: [`${dir}/walk_${direction}.mp4`],
    params: { prompt: walkPrompt(player, direction, hasFeet), direction, castId: player.id },
  })
  add(walkNode(pilot, [`cast:${player.id}:face`], [faceFile(player)], false))
  // One direction first: if the screen will not key or the model refuses the character, this shows it
  // before paying for the other four.
  const pilotId = add({ id: `cast:${player.id}:pilot`, kind: 'pilot', resource: 'local', title: '试走一个方向', lane, deps: [`cast:${player.id}:walk:${pilot}`], inputs: [`${dir}/walk_${pilot}.mp4`], outputs: [`${dir}/boots_reference.png`], params: { castId: player.id, direction: pilot } })
  for (const direction of others) add(walkNode(direction, [pilotId], [faceFile(player), `${dir}/boots_reference.png`], true))
  const walkIds = Object.keys(DIRECTIONS).map(direction => `cast:${player.id}:walk:${direction}`)
  for (const direction of Object.keys(DIRECTIONS)) {
    add({ id: `cast:${player.id}:stand:${direction}`, kind: 'stand', resource: 'image', title: `站姿 · ${FACING[direction]}`, lane, deps: [`cast:${player.id}:walk:${direction}`], inputs: [`${dir}/walk_${direction}.mp4`], outputs: [`${dir}/stand_${direction}.png`], params: { prompt: standPrompt(), direction, castId: player.id, size: '2048x2048' } })
  }
  const standIds = Object.keys(DIRECTIONS).map(direction => `cast:${player.id}:stand:${direction}`)
  const spriteFiles = [`${dir}/sprites.json`, ...Object.keys(DIRECTIONS).map(direction => `${dir}/sprite_${direction}.png`)]
  const spritesId = add({
    id: `cast:${player.id}:sprites`, kind: 'sprites', resource: 'local', title: '做走路动画', lane, deps: [...walkIds, ...standIds],
    inputs: Object.keys(DIRECTIONS).flatMap(direction => [`${dir}/walk_${direction}.mp4`, `${dir}/stand_${direction}.png`]), outputs: spriteFiles, params: { castId: player.id },
  })

  // ---------------------------------------------------------------- scenes
  const allClips = []
  for (const scene of project.scenes) {
    const stage = stageOf(scene)
    const sid = scene.id
    const at = name => `scenes/${sid}/${name}`
    const nid = name => `scene:${sid}:${name}`
    const plateLane = `${scene.title} · 布景`
    const filmLane = `${scene.title} · 视频`
    const prompts = platePrompts(project, scene, stage)
    const shape = { stage: stage.data.stage, blocks: stage.data.blocks, story: stage.data.story, spawn: stage.data.spawn, relaxed: stage.data.relaxed, glows: stage.data.glows }
    const guides = ['clay_a_closed', 'clay_a_open', 'clay_b', 'clay_a_empty', 'clay_b_empty', 'clay_corridor', 'clay_a_mask', 'clay_b_mask', 'door_mask'].map(name => at(`${name}.png`))
    const browser = (id, title, op, deps, inputs, outputs) => add({ id: nid(id), kind: 'browser', resource: 'browser', title, lane: plateLane, sceneId: sid, deps, inputs, outputs, params: { op, shape } })
    const painted = (id, title, deps, references, extra = {}) => add({
      id: nid(id), kind: 'image', resource: 'image', title, lane: plateLane, sceneId: sid, deps, inputs: references, outputs: [at(`plate_${id}.png`)],
      params: { prompt: prompts[id === 'b' && stage.shell.CAMERAS.a.tripod === true ? 'b_whole' : id], references, size: '2560x1440', ...extra },
    })
    const tripod = stage.shell.CAMERAS.a.tripod === true
    if (tripod) guides.push(at('clay_b_full_mask.png'))
    const guidesId = browser('guides', '渲染白模', 'guides', [], [], guides)
    // The two pictures everything else is derived from. The model sometimes ignores the whitebox and
    // paints its own room (these scored 0.50 to 0.58, good ones 0.73 and up), and that has to stop here.
    // A wall this camera is not shown must not be painted. One it is shown is nothing to check for.
    const noInventedWall = wallsFirstCameraSees(stage.shell).east ? {} : { mask: at('clay_a_mask.png') }
    const isDoor = stage.shell.exit === 'door'
    const relaxed = tripod && scene.paint === 'relaxed'
    // Painted loosely, then the parts that matter are painted again at full size and laid back in. Everything
    // downstream reads the finished picture and does not know how it was made.
    const paintLoosely = (camera, finalId, title, deps, references, mask) => {
      const paintId = `${camera}_paint`
      const from = at(`plate_${paintId}.png`)
      const paintGate = { room: at(mask), ...(camera === 'a' ? noInventedWall : {}) }
      painted(paintId, `${title}（整体）`, deps, references, { gate: paintGate })
      nodes.at(-1).attempts = PAINT_ATTEMPTS
      // Which thing is which. Made from the first painting: repainting a part moves nothing, and laying a part
      // back in needs to know where the thing stops, or its square brings a patch of different floor with it.
      const matteId = `${camera}_matte`
      const matteFile = at(`plate_${matteId}.png`)
      const checksPlaces = stage.shell.stage.framing === 'close'
      painted(matteId, camera === 'a' ? '分清主机位的物件' : '分清第二机位的物件', [nid(paintId)], [from], { hint: { kind: 'matte', mask: at(mask) }, ...(checksPlaces ? { gate: { things: thingCentres(stage, camera) } } : {}) })
      if (checksPlaces) {
        // Outside the params, so how a fault is put right has no say in whether the step is up to date.
        const matteNode = nodes.at(-1)
        matteNode.repaint = { prompt: prompts[paintId], references, size: '2560x1440', out: from, gate: paintGate }
        matteNode.thingSizes = thingSizes(stage, camera)
        matteNode.attempts = PAINT_ATTEMPTS * 2 - 1 // Each try at the colours, and a new picture between them.
      }
      // After the check, since a thing painted in the wrong place means a new picture for these to start from.
      const regions = regionsFor(stage, camera).map((region, index) => {
        const file = at(`detail_${finalId}_${index}.png`)
        add({
          id: nid(`${finalId}_detail_${index}`), kind: 'refine', resource: 'image', title: `精修 · ${region.labels.join('、')}`, lane: plateLane, sceneId: sid, deps: [nid(paintId), nid(matteId)], inputs: [from], outputs: [file],
          params: { from, region: { x: region.x, y: region.y, side: region.side }, prompt: refinePrompt(project, scene, region.labels), size: '2048x2048' },
        })
        return { ...region, file }
      })
      add({
        id: nid(finalId), kind: 'composeDetail', resource: 'local', title: `${title}（合成精修）`, lane: plateLane, sceneId: sid,
        deps: [nid(paintId), nid(matteId), ...regions.map((_, index) => nid(`${finalId}_detail_${index}`))], inputs: [from, matteFile, ...regions.map(region => region.file)], outputs: [at(`plate_${finalId}.png`)],
        params: { from, matte: matteFile, regions },
      })
    }
    if (relaxed) paintLoosely('a', 'a_closed', '主机位画面', [guidesId], [at('clay_a_closed.png')], 'clay_a_mask.png')
    else painted('a_closed', '主机位画面', [guidesId], [at('clay_a_closed.png'), at('clay_a_mask.png')], { gate: { guide: at('clay_a_closed.png'), ...noInventedWall } })
    if (isDoor) painted('a_open_raw', '门打开的画面', [nid('a_closed')], [at('plate_a_closed.png'), at('clay_a_open.png')])
    if (!tripod) painted('a_matte', '抠出家具', [nid('a_closed')], [at('plate_a_closed.png')], { hint: { kind: 'matte', mask: at('clay_a_mask.png') } })
    if (!tripod) painted('a_empty', '搬空的房间', [nid('a_closed'), nid('a_matte')], [at('plate_a_closed.png'), at('clay_a_empty.png')], { ...(noInventedWall.mask ? { gate: noInventedWall } : {}), keep: { finished: at('plate_a_closed.png'), mask: at('clay_a_mask.png'), matte: at('plate_a_matte.png'), clay: at('clay_a_empty.png') } })
    const paintsCorridor = isDoor && !stage.shell.CAMERAS.a.fixed
    if (paintsCorridor) painted('corridor', '门后通道', [guidesId, nid('a_open_raw')], [at('clay_corridor.png'), at('plate_a_open_raw.png')])
    if (isDoor) browser('a_open', '合成开门', 'blendOpen', [nid('a_closed'), nid('a_open_raw')], [at('plate_a_closed.png'), at('plate_a_open_raw.png'), at('door_mask.png')], [at('plate_a_open.png')])
    // Nothing opens, so the picture with the way out open is the same picture.
    else add({ id: nid('a_open'), kind: 'copy', resource: 'local', title: '出口一直开着', lane: plateLane, sceneId: sid, deps: [nid('a_closed')], inputs: [at('plate_a_closed.png')], outputs: [at('plate_a_open.png')], params: { from: at('plate_a_closed.png') } })
    const firstCamera = [nid('a_closed'), ...(tripod ? [] : [nid('a_empty'), nid('a_matte')]), nid('a_open'), ...(paintsCorridor ? [nid('corridor')] : [])]
    const firstCameraFiles = ['plate_a_closed', ...(tripod ? [] : ['plate_a_empty', 'plate_a_matte']), 'plate_a_open', ...(paintsCorridor ? ['plate_corridor'] : [])].map(name => at(`${name}.png`))
    if (tripod && stage.shell.CAMERAS.a.fixed) {
      // One camera, one picture. The rest of the stage still asks for a second, which is simply the same one.
      add({ id: nid('b'), kind: 'copy', resource: 'local', title: '只有一个机位', lane: plateLane, sceneId: sid, deps: [nid('a_closed')], inputs: [at('plate_a_closed.png')], outputs: [at('plate_b.png')], params: { from: at('plate_a_closed.png') } })
      add({ id: nid('b_matte'), kind: 'copy', resource: 'local', title: '只有一个机位的抠图', lane: plateLane, sceneId: sid, deps: [nid('a_matte')], inputs: [at('plate_a_matte.png')], outputs: [at('plate_b_matte.png')], params: { from: at('plate_a_matte.png') } })
    } else if (tripod) {
      // Each camera has a whole picture of its own, painted from the first so that it is the same place.
      browser('guide_draft', '第二机位草稿', 'draftB', [guidesId, nid('a_closed')], [at('plate_a_closed.png')], [at('guide_b_draft.png')])
      if (relaxed) {
        paintLoosely('b', 'b', '第二机位画面', [nid('guide_draft')], [at('guide_b_draft.png'), at('clay_b_full_mask.png')], 'clay_b_full_mask.png')
      } else {
        painted('b', '第二机位画面', [nid('guide_draft')], [at('guide_b_draft.png'), at('clay_b_full_mask.png')], { gate: { guide: at('clay_b.png') } })
      }
    } else {
    browser('guide_room', '换到第二机位', 'guideRoom', firstCamera, firstCameraFiles, [at('guide_b_room.png')])
    painted('b_empty', '第二机位的空房间', [nid('guide_room')], [at('guide_b_room.png'), at('clay_b_empty.png')], { hint: { kind: 'fill' }, seat: { guide: at('guide_b_room.png'), clay: at('clay_b_empty.png') } })
    browser('guide_furniture', '第二机位的家具位置', 'guideFurniture', [nid('b_empty')], [...firstCameraFiles, at('plate_b_empty.png')], [at('guide_b_furniture.png')])
    if (prompts.b) {
      painted('b', '第二机位画面', [nid('guide_furniture')], [at('guide_b_furniture.png'), at('clay_b_mask.png')], { gate: { guide: at('guide_b_furniture.png') } })
      painted('b_matte', '抠出第二机位家具', [nid('b')], [at('plate_b.png')], { hint: { kind: 'matte', mask: at('clay_b_mask.png') } })
    } else {
      // Nothing is painted from the second camera, so what it shows is already finished.
      add({ id: nid('b'), kind: 'copy', resource: 'local', title: '第二机位不用另画', lane: plateLane, sceneId: sid, deps: [nid('guide_furniture')], inputs: [at('guide_b_furniture.png')], outputs: [at('plate_b.png')], params: { from: at('guide_b_furniture.png') } })
      add({ id: nid('b_matte'), kind: 'blankMatte', resource: 'local', title: '第二机位没有家具', lane: plateLane, sceneId: sid, deps: [nid('b')], outputs: [at('plate_b_matte.png')], params: {} })
    }
    }
    const propIds = (scene.props ?? []).map(prop => add({
      id: nid(`prop_${prop.id}`), kind: 'image', resource: 'image', title: `道具 ${prop.name}`, lane: plateLane, sceneId: sid, deps: [nid('a_closed')], inputs: [at('plate_a_closed.png')], outputs: [at(`plate_prop_${prop.id}.png`)],
      params: { prompt: propPrompt(prop), references: [at('plate_a_closed.png')], size: '2048x2048', hint: { kind: 'prop' } },
    }))
    // A prop carried in keeps the picture it was first drawn with. Only the inventory shows it, so the
    // shots of this scene do not wait for it.
    for (const prop of scene.carried ?? []) {
      const source = `scenes/${prop.from}/plate_prop_${prop.id}.png`
      add({ id: nid(`prop_${prop.id}`), kind: 'copy', resource: 'local', title: `带上道具 ${prop.name}`, lane: plateLane, sceneId: sid, deps: [`scene:${prop.from}:prop_${prop.id}`], inputs: [source], outputs: [at(`plate_prop_${prop.id}.png`)], params: { from: source } })
    }

    const clips = filmClips(project, scene, stage)
    const stageProp = stage.data.story.stageProp
    const frameOutputs = clips.flatMap(clip => [at(`frame_${clip.id}_first.png`), ...(clip.hasLast ? [at(`frame_${clip.id}_last.png`)] : [])])
    const framesId = add({
      id: nid('frames'), kind: 'browser', resource: 'browser', title: '拍首尾画面', lane: filmLane, sceneId: sid,
      deps: [nid(tripod ? 'b' : 'b_matte'), ...(tripod ? firstCamera : []), ...(relaxed ? [nid('a_matte'), nid('b_matte')] : []), spritesId, ...propIds],
      inputs: [...firstCameraFiles, at('plate_b.png'), ...(tripod ? [] : [at('plate_b_empty.png'), at('plate_b_matte.png')]), ...(relaxed ? [at('plate_a_matte.png'), at('plate_b_matte.png')] : []), ...spriteFiles, ...(stageProp ? [at(`plate_prop_${stageProp.item}.png`)] : [])],
      outputs: frameOutputs, params: { op: 'frames', shape },
    })
    for (const clip of clips) {
      const faceParts = clip.parts.flatMap((part, index) => part.showsFace ? [index] : [])
      const partFile = index => at(`${clip.id}_part${index}.mp4`)
      const partIds = clip.parts.map((part, index) => {
        const faces = (part.people ?? []).map(person => faceFile(person))
        const first = at(`frame_${clip.id}_first.png`)
        const last = at(`frame_${clip.id}_last.png`)
        const faceShotPlace = part.facePlate === undefined ? [first] : part.facePlate ? [at(part.facePlate)] : []
        return add({
          id: nid(`clip:${clip.id}:${index}`), kind: 'clipPart', resource: 'video', seconds: part.duration, title: `${clip.title} · ${part.showsFace ? '露脸' : `镜头 ${index + 1}`}`, lane: filmLane, sceneId: sid,
          // The shot with the face goes first: if it is going to be refused, nothing else has been paid for.
          deps: [framesId, ...(part.showsFace ? faces.map(() => null) : faceParts.map(other => nid(`clip:${clip.id}:${other}`)))].filter(Boolean).concat(part.showsFace ? (part.people ?? []).map(person => `cast:${person.id}:face`) : []),
          // A face shot takes only the portrait from the game, so a change to the room or the walking does not touch it.
          inputs: part.showsFace ? faces : [first, ...(part.landsOnEnd ? [last] : [])],
          outputs: [partFile(index)],
          params: { prompt: part.text, duration: part.duration, audio: true, opensOnCut: Boolean(part.opensOnCut), references: part.showsFace ? [...faces, ...faceShotPlace] : [], first: part.showsFace ? null : first, last: !part.showsFace && part.landsOnEnd ? last : null },
        })
      })
      const clipFile = at(`${clip.id}.mp4`)
      add({
        id: nid(`clip:${clip.id}`), kind: 'clipFinal', resource: 'local', title: `${clip.title} · 合成`, lane: filmLane, sceneId: sid, deps: partIds,
        inputs: clip.parts.map((_, index) => partFile(index)), outputs: [clipFile, at(`video_${clip.id}_first.png`), ...(clip.hasLast ? [at(`video_${clip.id}_last.png`)] : [])],
        params: { clipId: clip.id, parts: clip.parts.length, hasLast: clip.hasLast },
      })
      allClips.push({ file: clipFile, title: `${scene.title} · ${clip.title}`, nodeId: nid(`clip:${clip.id}`) })
    }
    if (!tripod) add({
      id: nid('report'), kind: 'report', resource: 'browser', title: '质量检查', lane: filmLane, sceneId: sid, deps: clips.map(clip => nid(`clip:${clip.id}`)),
      inputs: [at('plate_a_closed.png'), at('plate_b.png'), at('plate_a_matte.png'), at('plate_b_matte.png')], outputs: [at('report.json')], params: { op: 'silhouettes', shape },
    })
  }
  const position = file => {
    const found = clipOrder?.indexOf(file) ?? -1
    return found < 0 ? Infinity : found
  }
  add(filmNode(project, clipOrder ? allClips.filter(clip => position(clip.file) !== Infinity || !clipOrder.length).sort((one, other) => position(one.file) - position(other.file)) : allClips))
  return nodes
}

function filmNode(project, clips) {
  if (project.readonly) {
    const list = project.scenes.flatMap(scene => scene.clips.map(clip => ({ file: clip.id, title: clip.title, sceneId: scene.id })))
    return { id: 'film', kind: 'film', resource: 'local', title: '合成整片', lane: '成片', outputs: ['film.mp4', 'chapters.json'], params: { clips: list, external: true } }
  }
  return {
    id: 'film', kind: 'film', resource: 'local', title: '合成整片', lane: '成片', deps: clips.map(clip => clip.nodeId), inputs: clips.map(clip => clip.file), outputs: ['film.mp4', 'chapters.json'],
    params: { clips: clips.map(({ file, title }) => ({ file, title })) },
  }
}

// What the person making the film thinks in: people, sets, shots. Each card rolls up the engineering
// steps that make it, and shows the one picture that says how it is going.
export function cardsFor(project, nodes) {
  const stepsOf = test => nodes.filter(node => test(node.id)).map(node => node.id)
  const cards = []
  const add = card => cards.push({ steps: [], ...card })
  if (project.readonly) {
    const [scene] = project.scenes
    add({ id: 'cast:c1', section: '人物', title: project.cast[0].name, note: '定妆照与走路动作', hero: 'plate_face.png' })
    add({ id: 'set', section: `布景 · ${scene.title}`, title: scene.title, note: '两个机位的完整布景', hero: 'plate_a_closed.png' })
    for (const prop of scene.props) add({ id: `prop:${prop.id}`, section: `布景 · ${scene.title}`, title: prop.name, note: '道具', hero: `plate_prop_${prop.id}.png`, keyed: true })
    for (const clip of scene.clips) add({ id: `clip:${clip.id}`, section: `镜头 · ${scene.title}`, title: clip.title, note: '电影镜头', hero: clip.file })
    add({ id: 'film', section: '成片', title: '整部影片', note: '所有镜头按故事顺序接在一起', hero: 'film.mp4', heroNode: 'film', steps: ['film'] })
    return cards
  }
  for (const person of project.cast) {
    const steps = stepsOf(id => id.startsWith(`cast:${person.id}:`))
    if (!steps.length) continue
    add({ id: `cast:${person.id}`, section: '人物', title: person.name, note: person.playable ? '定妆照，以及五个方向的走路和站姿' : '定妆照', hero: `cast/${person.id}/plate_face.png`, heroNode: `cast:${person.id}:face`, steps })
  }
  for (const scene of project.scenes) {
    const prefix = `scene:${scene.id}:`
    const isClip = id => id.startsWith(`${prefix}clip:`)
    const isProp = id => id.startsWith(`${prefix}prop_`)
    const setSteps = stepsOf(id => id.startsWith(prefix) && !isClip(id) && !isProp(id) && id !== `${prefix}report`)
    if (!setSteps.length) continue
    const at = name => `scenes/${scene.id}/${name}`
    add({
      id: `set:${scene.id}`, section: `布景 · ${scene.title}`, title: scene.title, note: stageOf(scene).shell.CAMERAS.a.fixed ? '这个地方的完整布景' : '两个机位的完整布景', steps: setSteps,
      hero: at('plate_a_closed.png'), heroNode: `${prefix}a_closed`, fallback: at('clay_a_closed.png'), fallbackNode: `${prefix}guides`,
    })
    for (const prop of scene.props ?? []) {
      const nodeId = `${prefix}prop_${prop.id}`
      add({ id: `prop:${scene.id}:${prop.id}`, section: `布景 · ${scene.title}`, title: prop.name, note: '道具', steps: [nodeId], hero: at(`plate_prop_${prop.id}.png`), heroNode: nodeId, keyed: true })
    }
    const clipIds = [...new Set(nodes.filter(node => isClip(node.id)).map(node => node.id.split(':')[3]))]
    for (const clipId of clipIds) {
      const finalId = `${prefix}clip:${clipId}`
      const final = nodes.find(node => node.id === finalId)
      add({
        id: `clip:${scene.id}:${clipId}`, section: `镜头 · ${scene.title}`, title: final.title.replace(/ · 合成$/, ''), note: '电影镜头', steps: stepsOf(id => id === finalId || id.startsWith(`${finalId}:`)),
        hero: at(`${clipId}.mp4`), heroNode: finalId, fallback: at(`frame_${clipId}_first.png`), fallbackNode: `${prefix}frames`,
      })
    }
  }
  if (nodes.some(node => node.id === 'film')) {
    add({ id: 'film', section: '成片', title: '整部影片', note: '所有镜头按故事顺序接在一起', hero: 'film.mp4', heroNode: 'film', steps: stepsOf(id => id === 'film' || id.endsWith(':report')) })
  }
  return cards
}

export const isAuthoring = node => node.group === AUTHORING
export const generationTargets = nodes => nodes.filter(node => !isAuthoring(node)).map(node => node.id)

// What the page needs to draw a step, without the bulk of what it was hashed from.
export function publicNode(node) {
  const { params, ...rest } = node
  return { ...rest, prompt: params?.prompt, references: params?.references ?? [], first: params?.first, last: params?.last }
}

export const runtimeFile = name => readFile(join(ROOT, 'runtime', name))
