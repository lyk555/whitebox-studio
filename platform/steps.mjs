// What each kind of step does. The engine decides when; this only decides how.
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { breakdownCast, breakdownPlot, breakdownScenes, buildLayout, castOnScreen } from './breakdown.mjs'
import { designWorld, writeOutline, writeScripts } from './authoring.mjs'
import { runBrowserJob } from './browserJobs.mjs'
import { FatalError } from './engine.mjs'
import { concatFiles, dropLeadIn, durationOf, extractEnds, ffmpeg, joinFilm, raiseSound, readPicture, readRaw, readVideoFrames, SPRITE_SIZE, writePng } from './ffmpeg.mjs'
import { composeDetails, objectShare } from './detail.mjs'
import { floorTakenByWall, meanDifference, misplacedInPicture, outlineAgreement, roomAgreement } from './metrics.mjs'
import { DIRECTIONS, heldOn } from './prompts.mjs'
import { providerFor, readerProvider } from './providers.mjs'
import { matteFromLayers, sortOutAlike, thingOfLayer } from './layers.mjs'
import { keepFinishedFile, seatFillFile } from './seat.mjs'
import { cutOutFigure, sheetFromVideoFrames } from './sprites.mjs'
import { castDir, readProject, replaceFile, sceneDir, writeAtomic, writeProject } from './store.mjs'
import { anchorsOf, settleWorld } from './world.mjs'

const MIN_ALIGNMENT = 0.65
const MIN_ROOM_AGREEMENT = 0.6 // Low on purpose: the darker and more dramatic the light, the less walls and floor separate. See roomSplitScore.
const LEAST_ROOM_CONTRAST = 16 // Wall and floor colour apart, of 0 to 255 a channel. Rooms told apart well measured 35 and up.
const PLATE_SIZE = [2560, 1440]
const MAX_FLOOR_TAKEN = 0.02 // Good plates measured 0.000. One with an invented wall, 0.036 with furniture in front of it and 0.107 without.
const PAINT_ATTEMPTS = 3
const FIGURE_HEIGHT = 1024 // Pixels, of someone standing in the room. On screen they are a few hundred at most.
const CHARACTER_HEIGHT_METERS = 1.75
const SEAM_WARNING = 12
const GREEN_SCREEN_IMAGE = 'green_screen.png'

const ensureDirFor = path => mkdir(dirname(path), { recursive: true })
const boxesMeet = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]

// Where a clip of a read-only project lives, which may be outside the project.
const externalClip = (project, clip) => join(project.assetsFrom, clip.file)

// What is wrong with a picture others will be built on, in words, or nothing.
async function plateProblem(context, gate, file, attempt) {
  // A preview's picture of colours is not a real one, so it has nothing to say about where things are.
  if (gate.things && context.project.provider !== 'mock') {
    // What lies flat on the back wall takes no floor, so where it was painted costs no one a way through.
    const onWall = new Set((context.node.onWall ?? []).map(({ index }) => index))
    const wrong = await misplacedInPicture(file, gate.things.filter(thing => !onWall.has(thing.index)), context.node.thingSizes)
    context.metric('放错位置', wrong.length)
    if (wrong.length) return `模型把东西画错了（${wrong.map(({ label, standsAt, oversized }) => (standsAt ? `${label}画到了${standsAt}的位置` : `${label}画得太大了，占了白模 ${oversized} 倍的宽度，或者伸到了太靠近镜头的地方`)).join('，')}），要重画这张底图`
  }
  if (gate.guide) {
    const score = await outlineAgreement(context.path(gate.guide), file)
    context.metric('对齐分数', Number(score.toFixed(3)))
    context.log(`第 ${attempt} 次：和白模的对齐分数 ${score.toFixed(3)}（至少 ${MIN_ALIGNMENT}）`)
    if (score < MIN_ALIGNMENT) return `和白模的对齐分数只有 ${score.toFixed(3)}`
  }
  // Nor does its plate have a real wall and floor to tell apart.
  if (gate.room && context.project.provider !== 'mock') {
    const { score, contrast } = await roomAgreement(context.path(gate.room), file)
    context.metric('房间结构', Number(score.toFixed(3)))
    context.log(`第 ${attempt} 次：墙和地面还在白模的位置上，分数 ${score.toFixed(3)}（至少 ${MIN_ROOM_AGREEMENT}）`)
    // A room moved also moves everything in it, and the split after this finds each thing out of its box.
    if (score < MIN_ROOM_AGREEMENT && contrast < LEAST_ROOM_CONTRAST && context.node.placesCheckedNext) {
      context.log(`墙和地面颜色太接近（只差 ${contrast.toFixed(1)}），这个分数说明不了房间有没有跑偏，交给下一步按物件位置核对`)
    } else if (score < MIN_ROOM_AGREEMENT) return `墙和地面跑偏了，分数只有 ${score.toFixed(3)}`
  }
  if (gate.mask) {
    const taken = await floorTakenByWall(context.path(gate.mask), file)
    context.metric('多画的墙', Number(taken.toFixed(3)))
    context.log(`第 ${attempt} 次：画面右侧的地面有 ${Math.round(taken * 100)}% 被画成了墙（至多 ${Math.round(MAX_FLOOR_TAKEN * 100)}%）`)
    if (taken > MAX_FLOOR_TAKEN) return `画面右侧多画了一面白模里没有的墙（${Math.round(taken * 100)}% 的地面被占）`
  }
  return null
}

// The picture a later step found fault with, painted again in place. The steps after it wait for that later step.
async function repaintBase(context, provider, { prompt, references, size, out, gate }, attempt, fault) {
  context.progress('正在重画底图')
  const target = context.path(out)
  const fresh = `${target}.new.png`
  // Told what was wrong, or it is only trying its luck again.
  await provider.image({ prompt: `${prompt}\n上一张画错了：${fault.replace(/，要重画这张底图$/, '')}。这一张必须改正，每件东西的大小和位置都要和图1里它的体块一致。`, references: references.map(context.path), out: fresh, size, signal: context.signal })
  const problem = await plateProblem(context, gate, fresh, attempt)
  if (problem) context.log(`重画的底图也有问题，还是用它往下核对：${problem}`)
  await replaceFile(fresh, target)
}

const STEPS = {
  async outline(context, provider) {
    const before = await readProject(context.project.id)
    const { truth, chapters } = await writeOutline({ project: before, provider, signal: context.signal, log: context.log, progress: context.progress, metric: context.metric })
    const project = await readProject(context.project.id)
    // Places and scripts were written from the chapters that are now gone.
    Object.assign(project, { truth, chapters, scenes: [], start: null, mapDesign: '', scriptsReviewed: false })
    settleWorld(project)
    await writeProject(project)
  },

  async world(context, provider) {
    const before = await readProject(context.project.id)
    const { design, start, scenes, where } = await designWorld({ project: before, provider, signal: context.signal, log: context.log, progress: context.progress })
    const project = await readProject(context.project.id)
    Object.assign(project, { mapDesign: design, start, scenes, scriptsReviewed: false })
    for (const anchor of anchorsOf(project)) {
      Object.assign(anchor, { where: where[anchor.id] ?? [], steps: [] })
      delete anchor.script
    }
    settleWorld(project)
    await writeProject(project)
  },

  async script(context, provider) {
    await writeScripts({ id: context.project.id, provider, signal: context.signal, log: context.log, progress: context.progress, metric: context.metric })
  },

  async plot(context, provider) {
    const before = await readProject(context.project.id)
    const { story, plot } = await breakdownPlot({ project: before, provider, signal: context.signal, log: context.log, progress: context.progress })
    const project = await readProject(context.project.id)
    Object.assign(project, { premise: before.premise ?? before.story, story, plot })
    await writeProject(project)
  },

  async cast(context, provider) {
    const { title, style, cast } = await breakdownCast({ project: context.project, provider, signal: context.signal, log: context.log, progress: context.progress })
    const project = await readProject(context.project.id)
    Object.assign(project, { title: project.titleLocked ? project.title : title || project.title, style, cast })
    await writeProject(project)
  },

  async scenes(context, provider) {
    const scenes = await breakdownScenes({ project: await readProject(context.project.id), provider, signal: context.signal, log: context.log, progress: context.progress })
    const project = await readProject(context.project.id)
    project.scenes = scenes
    if (project.plot) project.cast = castOnScreen(project.cast, scenes)
    await writeProject(project)
  },

  async layout(context, provider) {
    const { sceneId } = context.node
    const before = await readProject(context.project.id)
    const scene = before.scenes.find(candidate => candidate.id === sceneId)
    const { objects, beats, plain } = await buildLayout({ project: before, scene, provider, signal: context.signal, log: context.log, progress: context.progress })
    const project = await readProject(context.project.id)
    const target = project.scenes.find(candidate => candidate.id === sceneId)
    // A new layout is a new room: what was said about the old one no longer applies to it.
    Object.assign(target, { objects, beats, undo: null, chat: [], plainLayout: Boolean(plain) })
    await writeProject(project)
  },

  // Paints a picture, and for the pictures everything else is built on, checks it against the whitebox.
  async image(context, provider) {
    const { params } = context.node
    const out = context.path(context.node.outputs[0])
    await ensureDirFor(out)
    const fresh = `${out}.new.png`
    const references = params.references.map(context.path)
    const hint = params.hint ? { ...params.hint, mask: params.hint.mask ? context.path(params.hint.mask) : undefined } : undefined
    const { repaint } = context.node
    const attempts = params.gate ? PAINT_ATTEMPTS : 1
    for (let attempt = 1; attempt <= attempts; attempt++) {
      context.progress(`正在作画（第 ${attempt} 次）`)
      const { size } = await provider.image({ prompt: params.prompt, references, out: fresh, size: params.size, hint, signal: context.signal })
      if (size) context.metric('尺寸', size)
      if (!params.gate) break
      const problem = await plateProblem(context, params.gate, fresh, attempt)
      if (!problem) break
      if (attempt < attempts && repaint) {
        // Things out of place are in the picture this was made from, so that is what has to be painted again.
        context.log(`第 ${attempt} 次：${problem}`)
        await repaintBase(context, provider, repaint, attempt, problem)
        continue
      }
      if (attempt === attempts) {
        // Kept, because the only way to argue with a check is to look at what it refused.
        await replaceFile(fresh, `${out}.rejected.png`)
        throw new FatalError(`${attempts > 1 ? `画了 ${attempts} 次都不合格（最后一次：${problem}）` : problem}，已停止，后面的素材都依赖它。被拒的图留在 ${context.node.outputs[0]}.rejected.png。`)
      }
    }
    // A picture a video starts from is no bigger than the video.
    if (params.fit) {
      const [width, height] = params.fit
      await ffmpeg(['-loglevel', 'error', '-y', '-i', fresh, '-vf', `scale=${width}:${height}:flags=lanczos`, '-frames:v', '1', `${fresh}.fit.png`])
      await replaceFile(`${fresh}.fit.png`, fresh)
    }
    if (params.keep) {
      const [width, height] = (params.size ?? '2560x1440').split('x').map(Number)
      await copyFile(fresh, `${out}.raw.png`) // What was paid for, so the join can be redone without painting again.
      await keepFinishedFile({ paintedPath: fresh, finishedPath: context.path(params.keep.finished), maskPath: context.path(params.keep.mask), mattePath: context.path(params.keep.matte), clayPath: context.path(params.keep.clay), width, height })
      context.log('已把搬空图接到主机位原图上，只保留物件背后的部分')
    }
    if (params.seat) {
      const [width, height] = (params.size ?? '2560x1440').split('x').map(Number)
      const { gains } = await seatFillFile({ paintedPath: fresh, guidePath: context.path(params.seat.guide), clayPath: context.path(params.seat.clay), width, height })
      context.log(`补画部分调色：地面 ${gains[0].map(gain => gain.toFixed(2)).join(' / ')}，墙面 ${gains[1].map(gain => gain.toFixed(2)).join(' / ')}`)
    }
    await replaceFile(fresh, out)
  },

  // Which thing is which in a finished picture, split out of it by the model rather than painted again, so the
  // matte sits on the picture exactly. Found in the wrong place, it is the picture that has to be painted again.
  async layers(context, provider) {
    const { params } = context.node
    const out = context.path(context.node.outputs[0])
    await ensureDirFor(out)
    const fresh = `${out}.new.png`
    const work = `${out}.layers`
    const [width, height] = (params.size ?? '2560x1440').split('x').map(Number)
    const { repaint } = context.node
    const attempts = params.gate ? PAINT_ATTEMPTS : 1
    for (let attempt = 1; attempt <= attempts; attempt++) {
      context.progress(`正在拆分物件（第 ${attempt} 次）`)
      const split = await provider.layers({ image: context.path(params.references[0]), prompt: params.prompt, labels: params.labels, mask: params.mask ? context.path(params.mask) : undefined, dir: work, signal: context.signal })
      const [splitWidth, splitHeight] = split.size.split('x').map(Number)
      const layers = []
      for (const layer of split.layers) {
        const index = thingOfLayer(layer.name, params.labels)
        if (index < 0) {
          context.log(`多拆出了“${layer.name}”，不是这里的东西，没有用它`)
          continue
        }
        const [left, top, right, bottom] = layer.box.map((value, i) => Math.round(value * (i % 2 ? height / splitHeight : width / splitWidth)))
        if (right <= left || bottom <= top) continue
        layers.push({ index, z: layer.z, box: [left, top, right, bottom], pixels: await readRaw(layer.file, right - left, bottom - top) })
      }
      await rm(work, { recursive: true, force: true })
      if (context.node.places) sortOutAlike(layers, params.labels, context.node.places)
      // Flat on the wall, a thing found nowhere near its own place is something else of that name, not it.
      for (const { index, box } of context.node.onWall ?? []) {
        const at = layers.findIndex(layer => layer.index === index)
        if (at < 0 || boxesMeet(layers[at].box, box)) continue
        context.log(`第 ${attempt} 次：${params.labels[index]}贴着后墙，在它的位置上没有拆出来，大概画进了墙里；它不占地，不影响走路，分割图里不算它`)
        layers.splice(at, 1)
      }
      const missing = params.labels.filter((_, index) => !layers.some(layer => layer.index === index))
      if (missing.length) context.log(`第 ${attempt} 次：画面里没有拆出${missing.join('、')}`)
      context.metric('拆出的物件', layers.length)
      await writePng(fresh, matteFromLayers(layers, width, height), width, height)
      if (!params.gate) break
      const problem = await plateProblem(context, params.gate, fresh, attempt)
      if (!problem) break
      if (attempt < attempts && repaint) {
        context.log(`第 ${attempt} 次：${problem}`)
        await repaintBase(context, provider, repaint, attempt, problem)
        continue
      }
      await replaceFile(fresh, `${out}.rejected.png`)
      throw new FatalError(`${attempts > 1 ? `画了 ${attempts} 次都不合格（最后一次：${problem}）` : problem}，已停止，后面的素材都依赖它。被拒的分割图留在 ${context.node.outputs[0]}.rejected.png。`)
    }
    await replaceFile(fresh, out)
  },

  async refine(context, provider) {
    const { from, region: { x, y, side }, prompt, size } = context.node.params
    const out = context.path(context.node.outputs[0])
    await ensureDirFor(out)
    const crop = `${out}.crop.png`
    const fresh = `${out}.new.png`
    await ffmpeg(['-loglevel', 'error', '-i', context.path(from), '-vf', `crop=${side}:${side}:${x}:${y}`, '-frames:v', '1', crop])
    context.progress('正在精修')
    await provider.image({ prompt, references: [crop], out: fresh, size, hint: { kind: 'refine' }, signal: context.signal })
    await rm(crop, { force: true })
    await replaceFile(fresh, out)
  },

  // Works only from what is on disk, so it never costs a model call.
  async composeDetail(context) {
    const { from, matte, regions } = context.node.params
    const [width, height] = PLATE_SIZE
    const base = await readRaw(context.path(from), width, height)
    // Area scaling: the model painted these at about twice the size they go back at.
    const details = await Promise.all(regions.map(({ file, side }) => readRaw(context.path(file), side, side, 'area')))
    const keep = objectShare(await readRaw(context.path(matte), width, height), width, height)
    const pixels = composeDetails({ base, width, height, regions, details, keep })
    const out = context.path(context.node.outputs[0])
    const fresh = `${out}.new.png`
    await writePng(fresh, pixels, width, height)
    await replaceFile(fresh, out)
    context.metric('精修区域', regions.map(({ labels }) => labels.join('+')))
  },

  async copy(context) {
    const out = context.path(context.node.outputs[0])
    await ensureDirFor(out)
    await copyFile(context.path(context.node.params.from), out)
  },

  async blankMatte(context) {
    const out = context.path(context.node.outputs[0])
    await ensureDirFor(out)
    await ffmpeg(['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=2560x1440', '-frames:v', '1', out])
  },

  async browser(context) {
    const { sceneId, params: { op } } = context.node
    await mkdir(sceneDir(context.project.id, sceneId), { recursive: true })
    await runBrowserJob({ projectId: context.project.id, sceneId, op, signal: context.signal, onStatus: context.progress })
  },

  // Only the side-on walk is shot without seeing the feet first, and every other direction is shown them.
  async walk(context, provider) {
    const { direction, prompt, castId } = context.node.params
    const dir = castDir(context.project.id, castId)
    await mkdir(dir, { recursive: true })
    const screen = join(dir, GREEN_SCREEN_IMAGE)
    if (!existsSync(screen)) {
      const size = 512
      const pixels = new Uint8ClampedArray(size * size * 4)
      for (let i = 0; i < pixels.length; i += 4) pixels.set([0, 255, 0, 255], i)
      await writePng(screen, pixels, size, size)
    }
    const boots = join(dir, 'boots_reference.png')
    const out = context.path(context.node.outputs[0])
    const fresh = `${out}.new.mp4`
    await provider.video({
      text: prompt,
      references: [join(dir, 'plate_face.png'), screen, ...(direction !== 'e' && existsSync(boots) ? [boots] : [])],
      ratio: '1:1', resolution: '720p', duration: 6, out: fresh, hint: { kind: 'walk' },
      signal: context.signal, external: context.external, setExternal: context.setExternal, onStatus: context.progress,
    })
    await replaceFile(fresh, out)
  },

  // If this does not key, nothing else about this character would have worked either.
  async pilot(context) {
    const { castId, direction } = context.node.params
    const dir = castDir(context.project.id, castId)
    const sheet = await sheetFor(dir, direction)
    context.metric('步伐循环帧数', sheet.cycleFrames)
    context.metric('循环接缝', sheet.loopSeam)
    await rm(join(dir, sheet.file), { force: true })
    // Words do not hold the colour of the feet from one direction to the next, so every direction is
    // shown them, cut from the side-on walk. The cut stops well below the face. Seedance 2.0 mini refuses a
    // reference wider than 2.5:1, so the strip is a little taller than the feet need.
    await ffmpeg(['-loglevel', 'error', '-ss', '1', '-i', join(dir, `walk_${direction}.mp4`), '-frames:v', '1', '-vf', 'crop=iw:ih*0.42:0:ih*0.58', context.path(context.node.outputs[0])])
  },

  // Standing still has to be a real pose, since any frame of a walk looks like walking.
  async stand(context, provider) {
    const { direction, prompt, castId, size } = context.node.params
    const dir = castDir(context.project.id, castId)
    const reference = join(dir, `walk_${direction}_ref.png`)
    await ffmpeg(['-loglevel', 'error', '-ss', '1', '-i', join(dir, `walk_${direction}.mp4`), '-frames:v', '1', reference])
    const out = context.path(context.node.outputs[0])
    const fresh = `${out}.new.png`
    await provider.image({ prompt, references: [reference], out: fresh, size, hint: { kind: 'stand' }, signal: context.signal })
    await replaceFile(fresh, out)
  },

  // Someone standing in the room, cut out of their green screen and trimmed to them, feet on the bottom edge.
  async cutout(context) {
    const [green] = context.node.inputs.map(context.path)
    const out = context.path(context.node.outputs[0])
    const side = 2048
    // Far more than the game ever shows one at, and small enough to load at once.
    const { pixels, width, height } = cutOutFigure(await readRaw(green, side, side), side, side, FIGURE_HEIGHT)
    await ensureDirFor(out)
    await writePng(`${out}.new.png`, pixels, width, height)
    await replaceFile(`${out}.new.png`, out)
    context.metric('尺寸', `${width}x${height}`)
  },

  // Works only from the videos already on disk, so it never costs a model call.
  async sprites(context) {
    const { castId } = context.node.params
    const dir = castDir(context.project.id, castId)
    const manifest = {}
    for (const direction of Object.keys(DIRECTIONS)) {
      context.progress('正在抠像')
      manifest[direction] = await sheetFor(dir, direction)
    }
    await writeAtomic(join(dir, 'sprites.json'), JSON.stringify(manifest, null, 2))
    context.metric('循环接缝', Object.fromEntries(Object.entries(manifest).map(([direction, entry]) => [direction, entry.loopSeam])))
  },

  // Part of the game's picture, as big as a video starts from. rect is [left, top, width, height], as shares of the picture.
  async crop(context) {
    const { rect: [x, y, w, h], size: [width, height] } = context.node.params
    const out = context.path(context.node.outputs[0])
    await ensureDirFor(out)
    await ffmpeg(['-loglevel', 'error', '-y', '-i', context.path(context.node.inputs[0]), '-vf', `crop=iw*${w}:ih*${h}:iw*${x}:ih*${y},scale=${width}:${height}:flags=lanczos`, '-frames:v', '1', `${out}.new.png`])
    await replaceFile(`${out}.new.png`, out)
  },

  // A part of one take starts on a picture with faces in it, which the video model may refuse as a real person. Then it is made
  // the way it was before takes: the room's own pictures and a cut to the face shot. A shot with no such fallback, as an opening,
  // holds on the picture it ends on instead (prompts.mjs heldOn).
  async clipPart(context, provider) {
    const { fallback, ...asked } = context.node.params
    const out = context.path(context.node.outputs[0])
    await ensureDirFor(out)
    const fresh = `${out}.new.mp4`
    const make = async ({ prompt, duration, audio, opensOnCut, references, first, last }, external, setExternal) => {
      await provider.video({
        text: prompt, references: references.map(context.path), first: first ? context.path(first) : undefined, last: last ? context.path(last) : undefined,
        ratio: '16:9', resolution: '720p', duration, audio, out: fresh, hint: { kind: 'clip' },
        signal: context.signal, external, setExternal, onStatus: context.progress,
      })
      if (opensOnCut) await dropLeadIn(fresh)
    }
    // A task already under way says which way it was asked, so a restart collects it instead of paying again.
    const asFallback = value => context.setExternal(value && { ...value, fallback: true })
    const asHeld = value => context.setExternal(value && { ...value, held: true })
    // With nothing else to fall back on, a refused first picture is left out: the shot starts on the one it ends on.
    const canHold = !fallback && asked.first && asked.last && asked.first !== asked.last && !asked.references.length
    if (fallback && context.external?.fallback) {
      await make(fallback, context.external, asFallback)
    } else if (canHold && context.external?.held) {
      await make(heldOn(asked), context.external, asHeld)
    } else {
      try {
        await make(asked, context.external, context.setExternal)
        if (fallback) context.metric('拍法', '一镜到底')
      } catch (error) {
        if (!error.refusedPicture || !(fallback || canHold)) throw error
        if (fallback) {
          context.log(`视频模型不接受推近的画面（${error.message}），这一段改回切镜头的拍法`)
          context.metric('拍法', '切镜头')
          await make(fallback, null, asFallback)
        } else {
          context.log(`视频模型不接受第一帧（${error.message}），这一段改从尾帧开拍，镜头停在尾帧上`)
          context.metric('拍法', '停在尾帧')
          await make(heldOn(asked), null, asHeld)
        }
      }
    }
    await replaceFile(fresh, out)
  },

  async clipFinal(context) {
    const { sceneId, params: { clipId, parts, hasLast } } = context.node
    const dir = sceneDir(context.project.id, sceneId)
    const partNames = Array.from({ length: parts }, (_, index) => `${clipId}_part${index}.mp4`)
    const out = join(dir, `${clipId}.mp4`)
    const fresh = `${out}.new.mp4`
    if (parts === 1) {
      await copyFile(join(dir, partNames[0]), fresh)
    } else {
      const list = join(dir, `${clipId}_parts.txt`)
      await writeFile(list, partNames.map(name => `file '${name}'`).join('\n'))
      await concatFiles(list, fresh)
    }
    await raiseSound(fresh)
    await replaceFile(fresh, out)
    const firstPath = join(dir, `video_${clipId}_first.png`)
    const lastPath = join(dir, `video_${clipId}_last.png`)
    await extractEnds(out, firstPath, lastPath)
    const cutIn = await meanDifference(join(dir, `frame_${clipId}_first.png`), firstPath)
    context.metric('切入差', Number(cutIn.toFixed(2)))
    if (hasLast) {
      const cutOut = await meanDifference(join(dir, `frame_${clipId}_last.png`), lastPath)
      context.metric('切出差', Number(cutOut.toFixed(2)))
      if (cutOut > SEAM_WARNING) context.log(`提醒：切出差 ${cutOut.toFixed(1)}，切回游戏时可能看得出。`)
    }
    if (cutIn > SEAM_WARNING) context.log(`提醒：切入差 ${cutIn.toFixed(1)}，切进视频时可能看得出。`)
  },

  async report(context) {
    const { sceneId } = context.node
    const dir = sceneDir(context.project.id, sceneId)
    const silhouette = await runBrowserJob({ projectId: context.project.id, sceneId, op: 'silhouettes', signal: context.signal, onStatus: context.progress })
    const report = {
      alignment: {
        a_closed: Number((await outlineAgreement(join(dir, 'clay_a_closed.png'), join(dir, 'plate_a_closed.png'))).toFixed(3)),
        b: Number((await outlineAgreement(join(dir, 'guide_b_furniture.png'), join(dir, 'plate_b.png'))).toFixed(3)),
      },
      silhouette,
    }
    await writeAtomic(join(dir, 'report.json'), JSON.stringify(report, null, 2))
    context.metric('对齐分数', report.alignment)
    context.metric('轮廓重合', silhouette)
  },

  async film(context) {
    const { project } = context
    const { clips, external } = context.node.params
    const paths = clips.map(clip => external ? externalClip(project, clip) : context.path(clip.file))
    const missing = paths.find(path => !existsSync(path))
    if (missing) throw new FatalError(`缺少视频：${missing}`)
    context.progress(`正在合成 ${paths.length} 段视频`)
    const out = context.path('film.mp4')
    const fresh = `${out}.new.mp4`
    await joinFilm(paths, fresh)
    await replaceFile(fresh, out)
    let start = 0
    const chapters = []
    for (const [index, clip] of clips.entries()) {
      chapters.push({ title: clip.title, start: Number(start.toFixed(2)) })
      start += await durationOf(paths[index])
    }
    await writeAtomic(context.path('chapters.json'), JSON.stringify(chapters, null, 2))
    context.metric('片长（秒）', Math.round(start))
  },
}

async function sheetFor(dir, direction) {
  const frames = await readVideoFrames(join(dir, `walk_${direction}.mp4`))
  const standingPath = join(dir, `stand_${direction}.png`)
  const standing = existsSync(standingPath) ? await readPicture(standingPath) : undefined
  const size = SPRITE_SIZE.frame
  const sheet = sheetFromVideoFrames(frames, size, size, { standing })
  const file = `sprite_${direction}.png`
  await writePng(join(dir, file), sheet.pixels, sheet.width, sheet.height)
  const metersPerPixel = CHARACTER_HEIGHT_METERS / sheet.bodyHeight
  return {
    file, columns: sheet.columns, rows: sheet.rows, frameCount: sheet.frameCount, cycleFrames: sheet.cycleFrames,
    heightMeters: sheet.cellHeight * metersPerPixel, widthMeters: sheet.cellWidth * metersPerPixel,
    stepMeters: Number((sheet.stepPixels * metersPerPixel).toFixed(3)),
    loopSeam: Number(sheet.loopSeam.toFixed(4)),
  }
}

// A provider can be handed in, so a check can stand in for the models.
export async function executeNode(context, provider = null) {
  const step = STEPS[context.node.kind]
  if (!step) throw new FatalError(`未知步骤：${context.node.kind}`)
  // Read fresh: an earlier step in this run may have changed the project.
  const project = await readProject(context.project.id)
  const reads = ['outline', 'world', 'script', 'plot', 'cast', 'scenes', 'layout'].includes(context.node.kind)
  return step({ ...context, project }, provider ?? (reads ? readerProvider() : providerFor(project)))
}
