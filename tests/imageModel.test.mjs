// Ark closes the old Seedream ids on 2026-11-24 14:00 (UTC+8). No test here calls a model or reads a real .env.
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { DEFAULT_IMAGE_MODEL, ROOT, upgradeImageModel } from '../platform/config.mjs'
import { providerFor } from '../platform/providers.mjs'

const PRO = 'doubao-seedream-5-0-pro-260628'
const RETIRED = ['doubao-seedream-5-0-260128', 'doubao-seedream-5-0-lite-260128', 'doubao-seedream-4-5-251128', 'doubao-seedream-4-0-250828']

// A copy of config.mjs finds its .env files beside the copy, so the real settings stay out of it.
async function settingsIn({ own, fallback }) {
  const folder = await mkdtemp(join(tmpdir(), 'whitebox-image-model-'))
  const studio = join(folder, 'studio')
  await mkdir(join(studio, 'platform'), { recursive: true })
  await mkdir(join(folder, 'whitebox-loop'))
  await copyFile(join(ROOT, 'platform', 'config.mjs'), join(studio, 'platform', 'config.mjs'))
  if (own) await writeFile(join(studio, '.env'), own)
  if (fallback) await writeFile(join(folder, 'whitebox-loop', '.env'), fallback)
  return { folder, envPath: join(studio, '.env'), settings: await import(pathToFileURL(join(studio, 'platform', 'config.mjs')).href) }
}

test('the default image model is Seedream 5.0 Pro', () => {
  assert.equal(DEFAULT_IMAGE_MODEL, PRO)
})

test('every closing id moves to Pro; anything else is left as chosen', () => {
  for (const closing of RETIRED) assert.equal(upgradeImageModel(closing), PRO)
  for (const kept of [PRO, 'doubao-seedream-5-0-flash-260915', 'doubao-seedream-4-0-20260415', 'ep-20260101-custom']) assert.equal(upgradeImageModel(kept), kept)
})

test('with nothing saved, config gives Pro', async t => {
  const saved = process.env.IMAGE_MODEL
  delete process.env.IMAGE_MODEL
  t.after(() => { if (saved !== undefined) process.env.IMAGE_MODEL = saved })
  const { folder, settings } = await settingsIn({})
  t.after(() => rm(folder, { recursive: true, force: true }))
  assert.equal(settings.config().imageModel, PRO)
})

test('an old id saved in either .env resolves to Pro, and the file is not rewritten', async t => {
  const saved = process.env.IMAGE_MODEL
  delete process.env.IMAGE_MODEL
  t.after(() => { if (saved !== undefined) process.env.IMAGE_MODEL = saved })
  for (const place of ['own', 'fallback']) {
    const text = `IMAGE_MODEL=${RETIRED[0]}\n`
    const { folder, envPath, settings } = await settingsIn({ [place]: text })
    t.after(() => rm(folder, { recursive: true, force: true }))
    assert.equal(settings.config().imageModel, PRO, place)
    assert.equal(settings.publicSettings().imageModel, PRO, place)
    if (place === 'own') assert.equal(await readFile(envPath, 'utf8'), text)
  }
})

test('an old id in the environment resolves to Pro; a model the user chose stays', async t => {
  const saved = process.env.IMAGE_MODEL
  t.after(() => { if (saved === undefined) delete process.env.IMAGE_MODEL; else process.env.IMAGE_MODEL = saved })
  const { folder, settings } = await settingsIn({})
  t.after(() => rm(folder, { recursive: true, force: true }))
  process.env.IMAGE_MODEL = RETIRED[0]
  assert.equal(settings.config().imageModel, PRO)
  process.env.IMAGE_MODEL = 'doubao-seedream-5-0-flash-260915'
  assert.equal(settings.config().imageModel, 'doubao-seedream-5-0-flash-260915')
})

test('saving the page after an old id writes the new one and keeps other lines', async t => {
  const { folder, envPath, settings } = await settingsIn({ own: `# note\nIMAGE_MODEL=${RETIRED[0]}\n` })
  t.after(() => rm(folder, { recursive: true, force: true }))
  await settings.saveSettings({ imageModel: settings.publicSettings().imageModel })
  assert.equal(await readFile(envPath, 'utf8'), `# note\nIMAGE_MODEL=${PRO}\n`)
})

test('the image request sends only what Pro takes', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'whitebox-image-request-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
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
      return Response.json({ data: [{ url: 'https://images.test/plate.png', size: '2560x1440' }] })
    }
    assert.equal(String(url), 'https://images.test/plate.png')
    return new Response(Buffer.from('picture'))
  }
  const out = join(folder, 'plate.png')
  await providerFor({ provider: 'ark' }).image({ prompt: 'room', references: [], out, size: '2560x1440', signal: new AbortController().signal })
  assert.equal(bodies.length, 1)
  // Pro and Flash make single pictures and do not take the setting for sets of them.
  assert.equal('sequential_image_generation' in bodies[0], false)
  // Standard is Pro's default and its better mode.
  assert.equal('optimize_prompt_options' in bodies[0], false)
  assert.equal(bodies[0].output_format, 'png')
  assert.equal(bodies[0].watermark, false)
  assert.equal(await readFile(out, 'utf8'), 'picture')
})
