// A picture split into cut-outs by the model, made into the matte the studio reads. No test here calls a model.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { kindOf, matteFromLayers, sortOutAlike, thingOfLayer } from '../platform/layers.mjs'
import { misplacedThings } from '../platform/metrics.mjs'
import { onWall } from '../platform/detail.mjs'
import { providerFor } from '../platform/providers.mjs'
import { OBJECT_COLOURS } from '../runtime/objectColours.js'

const solid = (wide, high, alpha = 255) => {
  const pixels = new Uint8ClampedArray(wide * high * 4)
  for (let at = 0; at < pixels.length; at += 4) pixels.set([90, 60, 30, alpha], at)
  return pixels
}
const colourAt = (pixels, width, x, y) => [...pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 3)]

test('a cut-out is found by its name, also when the model adds to the name', () => {
  const labels = ['书桌', '扶手椅', '书桌上的煤气灯']
  assert.equal(thingOfLayer('扶手椅', labels), 1)
  assert.equal(thingOfLayer('书桌（连同桌上的小物件）', labels), 0)
  assert.equal(thingOfLayer('书桌上的煤气灯', labels), 2, 'the longest name it holds, not the first')
  assert.equal(thingOfLayer('窗帘', labels), -1)
  assert.equal(thingOfLayer(undefined, labels), -1)
})

test('each cut-out is its thing\'s colour where it is solid, the nearer over the farther, and the rest is green', () => {
  const width = 10
  const height = 6
  const halfSeen = solid(4, 2)
  halfSeen.fill(0, 0, 4 * 4) // Its top row is see-through, as round a chair's legs.
  const matte = matteFromLayers([
    { index: 1, z: 2, box: [2, 2, 6, 4], pixels: halfSeen },
    { index: 0, z: 1, box: [0, 0, 5, 5], pixels: solid(5, 5) },
  ], width, height)
  assert.deepEqual(colourAt(matte, width, 9, 5), [0, 255, 0])
  assert.deepEqual(colourAt(matte, width, 1, 1), OBJECT_COLOURS[0].rgb)
  assert.deepEqual(colourAt(matte, width, 3, 3), OBJECT_COLOURS[1].rgb, 'nearer, so on top')
  assert.deepEqual(colourAt(matte, width, 3, 2), OBJECT_COLOURS[0].rgb, 'where the nearer one is see-through, the farther one shows')
  assert.deepEqual(colourAt(matte, width, 5, 3), OBJECT_COLOURS[1].rgb)
})

test('things of one sort are told apart by where they stand, and others keep their names', () => {
  // Seen on 《雾都码头谜案》: four piles of crates, named only by where they were, came back under each other's names.
  const labels = ['废弃木箱堆', '角落油布堆', '门洞旁的废弃木箱堆', '墙边的废弃木箱堆', '散落空煤麻袋1', '散落空煤麻袋2']
  assert.deepEqual(labels.map(kindOf), ['废弃木箱堆', '角落油布堆', '废弃木箱堆', '废弃木箱堆', '散落空煤麻袋', '散落空煤麻袋'])
  const places = [{ index: 0, x: 500, y: 700 }, { index: 1, x: 300, y: 700 }, { index: 2, x: 1600, y: 700 }, { index: 3, x: 1850, y: 700 }, { index: 4, x: 900, y: 950 }, { index: 5, x: 1300, y: 950 }]
  const at = (index, x) => ({ index, z: 1, box: [x - 50, 650, x + 50, 750] })
  const layers = sortOutAlike([at(3, 500), at(0, 1600), at(0, 1850), at(1, 1300), at(4, 1300), at(5, 900)], labels, places)
  assert.deepEqual(layers.map(layer => layer.index), [0, 2, 3, 1, 5, 4], 'two named alike are both placed; the oilcloth is left where it was painted')
})

test('a thing is as wide as its foot: what spreads out above the floor takes none of it', () => {
  // A frame drawn with the beams overhead, as in the coal yard: narrow where it stands, wide above.
  const width = 80
  const height = 45
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let at = 0; at < pixels.length; at += 4) pixels.set([0, 255, 0, 255], at)
  const fill = (x0, x1, y0, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) pixels.set([0, 0, 255, 255], (y * width + x) * 4) }
  fill(0, 60, 5, 12) // Beams overhead.
  fill(20, 30, 12, 35) // The frame.
  const scale = 2560 / width
  const thing = [{ index: 1, label: '钢架', x: 25 * scale, y: 22 * scale }]
  assert.deepEqual(misplacedThings(pixels, width, height, thing, { 1: { wide: 10 * scale, bottom: 35 * scale } }), [])
  fill(5, 60, 30, 35) // Now spilling across the floor where it stands.
  assert.equal(misplacedThings(pixels, width, height, thing, { 1: { wide: 10 * scale, bottom: 35 * scale } })[0].label, '钢架')
})

test('only what lies flat on the back wall, unused by the story, is left to the painter', () => {
  // Seen on 《雾都码头谜案》: a pier's frame 0.22 m deep, painted into the wall; the split took the pier in the distance.
  const shell = { room: { north: -4 }, CAMERAS: { a: { position: [0, 1.6, 4], target: [0, 1.2, -4], fov: 50 } } }
  const block = (name, z, depth) => ({ name, label: name, center: [0, 1, z], size: [1.8, 2, depth] })
  const blocks = [block('frame', -4 + 0.05 + 0.11, 0.22), block('shelf', -4 + 0.3 + 0.2, 0.4), block('board', -4 + 0.02 + 0.05, 0.1)]
  assert.deepEqual(onWall({ blocks, shell }, 'a').map(({ index }) => index), [0, 2], 'the shelf is deep enough to take floor')
  assert.deepEqual(onWall({ blocks, shell }, 'a', new Set(['board'])).map(({ index }) => index), [0], 'what the story uses must be seen')
  const [{ box }] = onWall({ blocks, shell }, 'a')
  assert.ok(box[0] < box[2] && box[1] < box[3])
})

test('a cut-out reaching past the picture is cut at its edge', () => {
  const matte = matteFromLayers([{ index: 0, z: 1, box: [-2, 3, 3, 8], pixels: solid(5, 5) }], 4, 4)
  assert.deepEqual(colourAt(matte, 4, 0, 3), OBJECT_COLOURS[0].rgb)
  assert.deepEqual(colourAt(matte, 4, 3, 3), [0, 255, 0])
})

test('a split asks for cut-outs of the one picture, and brings each back with where it goes', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'whitebox-layers-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const image = join(folder, 'plate.png')
  await writeFile(image, 'picture')
  const realFetch = globalThis.fetch
  const realKey = process.env.ARK_API_KEY
  process.env.ARK_API_KEY = 'test-only'
  t.after(() => {
    globalThis.fetch = realFetch
    if (realKey === undefined) delete process.env.ARK_API_KEY; else process.env.ARK_API_KEY = realKey
  })
  const bodies = []
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/images/generations')) {
      bodies.push(JSON.parse(init.body))
      return Response.json({ data: [
        { url: 'https://images.test/base.png', size: '2560x1440', z_index: 0 },
        { url: 'https://images.test/chair.png', size: '700x800', z_index: 2, name: '扶手椅', bounding_box: { absolute: [108, 690, 491, 1126], normalized: [42, 479, 192, 782] } },
        { url: 'https://images.test/desk.png', size: '900x760', z_index: 1, name: '书桌', bounding_box: { absolute: [713, 840, 1269, 1315], normalized: [279, 583, 496, 913] } },
      ] })
    }
    return new Response(Buffer.from(`from ${String(url).split('/').pop()}`))
  }
  const split = await providerFor({ provider: 'ark' }).layers({ image, prompt: '拆出书桌、扶手椅', dir: join(folder, 'work'), signal: new AbortController().signal })
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].layer_decomposition, true)
  assert.equal(bodies[0].prompt, '拆出书桌、扶手椅')
  assert.equal(bodies[0].image, `data:image/png;base64,${Buffer.from('picture').toString('base64')}`)
  assert.equal(split.size, '2560x1440')
  assert.deepEqual(split.layers.map(({ name, z, box }) => ({ name, z, box })), [
    { name: '扶手椅', z: 2, box: [108, 690, 491, 1126] },
    { name: '书桌', z: 1, box: [713, 840, 1269, 1315] },
  ])
  assert.equal(await readFile(split.layers[1].file, 'utf8'), 'from desk.png')
})
