import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { writePng } from '../platform/ffmpeg.mjs'
import { floorTakenByWall } from '../platform/metrics.mjs'
import { platePrompts } from '../platform/prompts.mjs'
import { keepFinishedFile, seatFill, seatFillFile } from '../platform/seat.mjs'
import { readRaw } from '../platform/ffmpeg.mjs'
import { buildStage } from '../platform/stage.mjs'
import { fallbackLayout } from '../platform/breakdown.mjs'
import { buildGraph } from '../platform/graph.mjs'

const W = 320
const H = 180
const picture = paint => {
  const pixels = Buffer.alloc(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = paint(x, y)
      pixels.set([r, g, b, 255], (y * W + x) * 4)
    }
  }
  return pixels
}
const inTemp = async t => {
  const dir = await mkdtemp(join(tmpdir(), 'second-camera-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return dir
}

// The whitebox's zones: wall above the line, floor below it, reaching the right edge.
const mask = picture((x, y) => y < 80 ? [0, 0, 0] : [120, 120, 120])
const BRICK = [120, 40, 30]
const WOOD = [70, 60, 40]

test('a wall the whitebox does not have is caught, however well the outlines match', async t => {
  const dir = await inTemp(t)
  await writePng(join(dir, 'mask.png'), mask, W, H)
  await writePng(join(dir, 'good.png'), picture((x, y) => y < 80 ? WOOD : BRICK), W, H)
  await writePng(join(dir, 'invented.png'), picture((x, y) => y < 80 || x > 270 ? WOOD : BRICK), W, H)
  assert.ok(await floorTakenByWall(join(dir, 'mask.png'), join(dir, 'good.png')) < 0.01)
  assert.ok(await floorTakenByWall(join(dir, 'mask.png'), join(dir, 'invented.png')) > 0.5)
})

test('a room whose wall and floor share a colour is not refused for it', async t => {
  const dir = await inTemp(t)
  await writePng(join(dir, 'mask.png'), mask, W, H)
  await writePng(join(dir, 'same.png'), picture((x, y) => x > 270 ? [90, 60, 40] : [92, 61, 40]), W, H)
  assert.equal(await floorTakenByWall(join(dir, 'mask.png'), join(dir, 'same.png')), 0)
})

test('both pictures of the room are told there is no third wall, and the first is checked for one', () => {
  const scene = { title: '房间', place: '灰墙', mood: '柔光', props: [], beats: [{ id: 'b1', objective: '看', objectName: '木箱', gives: [], takes: [], performed: false }], exit: { name: '门', beyond: '走廊' } }
  Object.assign(scene, fallbackLayout(scene))
  const prompts = platePrompts({ style: '写实', cast: [] }, scene, buildStage(scene))
  assert.ok(prompts.a_closed.includes('画面右侧没有墙'))
  assert.ok(prompts.a_empty.includes('画面右侧没有墙'))
  const nodes = buildGraph({ story: '故事', style: '写实', cast: [{ id: 'c1', name: '人', costume: '衣', look: '脸', playable: true }], scenes: [{ ...scene, id: 's1', film: { opening: { action: 'a' }, door: { action: 'b' }, ending: { action: 'c' } } }] })
  const param = id => nodes.find(node => node.id === id).params
  assert.deepEqual(param('scene:s1:a_closed').gate, { guide: 'scenes/s1/clay_a_closed.png', mask: 'scenes/s1/clay_a_mask.png' })
  assert.deepEqual(param('scene:s1:a_empty').gate, { mask: 'scenes/s1/clay_a_mask.png' })
  assert.deepEqual(param('scene:s1:b_empty').seat, { guide: 'scenes/s1/guide_b_room.png', clay: 'scenes/s1/clay_b_empty.png' })
})

// The left half is kept, the right half is the hole. Floor below the line, wall above it.
const HOLE = [255, 0, 255]
const clay = picture((x, y) => y < 80 ? [170, 170, 170] : [220, 220, 220])
const guide = picture((x, y) => x >= 160 ? HOLE : y < 80 ? [100, 80, 60] : [120, 40, 30])

test('the fill takes the colour of what it joins, surface by surface', () => {
  const painted = picture((x, y) => y < 80 ? [50, 40, 30] : [240, 80, 60])
  const { gains } = seatFill({ painted, guide, clay, width: W, height: H })
  for (const [gain, expected] of [[gains[0], [121 / 241, 41 / 81, 31 / 61]], [gains[1], [101 / 51, 81 / 41, 61 / 31]]]) {
    gain.forEach((value, c) => assert.ok(Math.abs(value - expected[c]) < 0.01, `${value} vs ${expected[c]}`))
  }
})

test('what the finished picture can show comes from it, and only what the furniture hid comes from the emptied one', async t => {
  const dir = await inTemp(t)
  const paths = { paintedPath: join(dir, 'empty.png'), finishedPath: join(dir, 'finished.png'), maskPath: join(dir, 'mask.png'), clayPath: join(dir, 'clay.png') }
  const FINISHED = [150, 60, 40]
  const WASHED = [90, 90, 90]
  await writePng(paths.paintedPath, picture(() => WASHED), W, H)
  await writePng(paths.finishedPath, picture((x, y) => (x > 100 && x < 140 && y > 60 && y < 110 ? [10, 200, 10] : FINISHED)), W, H)
  await writePng(paths.maskPath, picture((x, y) => (x > 100 && x < 140 && y > 60 && y < 110 ? [255, 255, 255] : y < 40 ? [0, 0, 0] : [120, 120, 120])), W, H)
  await writePng(paths.clayPath, picture(() => [220, 220, 220]), W, H)
  await keepFinishedFile({ ...paths, width: W, height: H })
  const out = await readRaw(paths.paintedPath, W, H)
  const at = (x, y) => [...out.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)]
  assert.deepEqual(at(280, 150), FINISHED, '远处保留原图的颜色和细节')
  const [r, g, b] = at(120, 85)
  assert.ok(g < 120, `物件被搬走了，不是原图的绿色：${[r, g, b]}`)
  assert.ok(Math.abs(r - FINISHED[0]) < 12 && Math.abs(g - FINISHED[1]) < 12, `补上的部分调成了周围的颜色：${[r, g, b]}`)
})

test('the fill matches each place it joins, not one average for the picture', async t => {
  const dir = await inTemp(t)
  const paths = { paintedPath: join(dir, 'empty.png'), finishedPath: join(dir, 'finished.png'), maskPath: join(dir, 'mask.png'), clayPath: join(dir, 'clay.png') }
  const twoBlocks = (x, y) => (x > 40 && x < 80 && y > 60 && y < 110) || (x > 240 && x < 280 && y > 60 && y < 110)
  // The model drifted one way on the left of the picture and another way on the right.
  await writePng(paths.paintedPath, picture(x => (x < 160 ? [100, 100, 100] : [180, 180, 180])), W, H)
  await writePng(paths.finishedPath, picture((x, y) => (twoBlocks(x, y) ? [255, 0, 0] : x < 160 ? [60, 80, 120] : [120, 100, 60])), W, H)
  await writePng(paths.maskPath, picture((x, y) => (twoBlocks(x, y) ? [255, 255, 255] : [120, 120, 120])), W, H)
  await writePng(paths.clayPath, picture(() => [220, 220, 220]), W, H)
  await keepFinishedFile({ ...paths, width: W, height: H })
  const out = await readRaw(paths.paintedPath, W, H)
  const at = (x, y) => [...out.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)]
  at(60, 85).forEach((value, c) => assert.ok(Math.abs(value - [60, 80, 120][c]) < 10, `左边 ${at(60, 85)}`))
  at(260, 85).forEach((value, c) => assert.ok(Math.abs(value - [120, 100, 60][c]) < 10, `右边 ${at(260, 85)}`))
})

test('a sliver of hole too thin for the working size still gets filled', async t => {
  const dir = await inTemp(t)
  const [width, height] = [1600, 900]
  const big = paint => {
    const pixels = Buffer.alloc(width * height * 4)
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set([...paint(x, y), 255], (y * width + x) * 4)
    return pixels
  }
  const paths = { paintedPath: join(dir, 'painted.png'), guidePath: join(dir, 'guide.png'), clayPath: join(dir, 'clay.png') }
  await writePng(paths.paintedPath, big(() => [90, 60, 40]), width, height)
  await writePng(paths.guidePath, big((x, y) => x >= 1200 || (y < 1 && x > 400 && x < 800) ? HOLE : [100, 80, 60]), width, height)
  await writePng(paths.clayPath, big(() => [170, 170, 170]), width, height)
  await seatFillFile({ ...paths, width, height })
  const out = await readRaw(paths.paintedPath, width, height)
  for (let x = 400; x < 800; x += 5) {
    const i = x * 4
    assert.ok(!(out[i] > 110 && out[i + 2] > 110 && out[i + 1] < 70), `第一行 ${x} 还是洞的颜色：${[out[i], out[i + 1], out[i + 2]]}`)
  }
})

test('what was kept stays as it was, and no trace of the hole is left', async t => {
  const dir = await inTemp(t)
  const paths = { paintedPath: join(dir, 'painted.png'), guidePath: join(dir, 'guide.png'), clayPath: join(dir, 'clay.png') }
  await writePng(paths.paintedPath, picture((x, y) => y < 80 ? [50, 40, 30] : [240, 80, 60]), W, H)
  await writePng(paths.guidePath, guide, W, H)
  await writePng(paths.clayPath, clay, W, H)
  await seatFillFile({ ...paths, width: W, height: H })
  const out = await readRaw(paths.paintedPath, W, H)
  const at = (x, y) => [...out.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)]
  assert.deepEqual(at(40, 140), [120, 40, 30])
  assert.deepEqual(at(40, 30), [100, 80, 60])
  for (const [x, y, target] of [[300, 140, [120, 40, 30]], [300, 30, [100, 80, 60]]]) {
    at(x, y).forEach((value, c) => assert.ok(Math.abs(value - target[c]) <= 6, `${at(x, y)} vs ${target}`))
  }
  for (let y = 5; y < H - 5; y += 7) {
    for (let x = 140; x < 180; x += 3) {
      const [r, g, b] = at(x, y)
      assert.ok(!(r > 180 && g < 90 && b > 180), `洞的颜色留在了 ${x},${y}`)
    }
  }
})
