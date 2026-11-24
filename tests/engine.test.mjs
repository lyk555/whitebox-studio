// The promises the workflow makes, checked with steps that only write small files.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { cancelRun, FatalError, nodeStatuses, planFor, readState, resetNode, startRun, TransientError } from '../platform/engine.mjs'
import { createProject, listProjects, projectDir, removeFromLibrary } from '../platform/store.mjs'

async function setup(t) {
  const project = await createProject({ id: `test-${randomBytes(4).toString('hex')}` })
  t.after(() => rm(projectDir(project.id), { recursive: true, force: true }))
  const put = async (name, text) => {
    const path = join(projectDir(project.id), name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text)
  }
  return { project, put }
}

// Runs a graph to the end and reports how many times each step ran.
function runner(project, nodes, steps, ran = {}) {
  return (options = {}) => new Promise(resolve => {
    startRun({
      project, graph: () => nodes, reload: async () => project, backoff: [0.01],
      execute: async context => {
        ran[context.node.id] = (ran[context.node.id] ?? 0) + 1
        await steps[context.node.id](context)
      },
      onFinish: () => resolve(ran),
      ...options,
    })
  })
}

const statusesOf = async (project, nodes) => nodeStatuses(project, nodes, await readState(project.id))
const write = (name, text = 'made') => context => writeFile(context.path(name), text)

test('a finished step is not redone, and what it made is still there', async t => {
  const { project } = await setup(t)
  const nodes = [{ id: 'a.txt', kind: 'k', resource: 'local', outputs: ['a.txt'] }]
  const go = runner(project, nodes, { 'a.txt': write('a.txt') })
  await go()
  const ran = await go()
  assert.equal(ran['a.txt'], 1)
  assert.equal((await statusesOf(project, nodes))['a.txt'], 'done')
})

test('a step is redone when what goes into it changes, and only then', async t => {
  const { project, put } = await setup(t)
  await put('in.txt', 'one')
  const nodes = [{ id: 'out.txt', kind: 'k', resource: 'local', inputs: ['in.txt'], outputs: ['out.txt'] }]
  const ran = {}
  const go = runner(project, nodes, { 'out.txt': write('out.txt') }, ran)
  await go()
  await go()
  assert.equal(ran['out.txt'], 1)
  await put('in.txt', 'two')
  assert.equal((await statusesOf(project, nodes))['out.txt'], 'stale')
  await go()
  assert.equal(ran['out.txt'], 2)
})

test('rewriting a file with the same content changes nothing downstream', async t => {
  const { project, put } = await setup(t)
  await put('in.txt', 'same')
  const nodes = [{ id: 'out.txt', kind: 'k', resource: 'local', inputs: ['in.txt'], outputs: ['out.txt'] }]
  const ran = {}
  const go = runner(project, nodes, { 'out.txt': write('out.txt') }, ran)
  await go()
  await new Promise(resolve => setTimeout(resolve, 20))
  await put('in.txt', 'same')
  await go()
  assert.equal(ran['out.txt'], 1)
})

// Seen on 《榆园命案》: Lestrade's figure was painted again, the cut-out made from it still matched its old record, so the frames
// that use the cut-out were taken at once, with the old Lestrade in them, and then counted as up to date.
test('a step waits while a step before it is about to remake what it reads', async t => {
  const { project, put } = await setup(t)
  await put('prompt.txt', 'old')
  const nodes = [
    { id: 'paint', kind: 'k', resource: 'local', inputs: ['prompt.txt'], outputs: ['green.txt'] },
    { id: 'cut', kind: 'k', resource: 'local', deps: ['paint'], inputs: ['green.txt'], outputs: ['figure.txt'] },
    { id: 'frames', kind: 'k', resource: 'local', deps: ['cut'], inputs: ['figure.txt'], outputs: ['frame.txt'] },
  ]
  const copy = (from, to) => async context => writeFile(context.path(to), await readFile(context.path(from), 'utf8'))
  const steps = { paint: copy('prompt.txt', 'green.txt'), cut: copy('green.txt', 'figure.txt'), frames: copy('figure.txt', 'frame.txt') }
  await runner(project, nodes, steps)()
  await put('prompt.txt', 'new')
  const before = await statusesOf(project, nodes)
  assert.equal(before.paint, 'stale')
  assert.equal(before.cut, 'waiting', 'its file still matches, but the picture it is cut from is about to change')
  assert.equal(before.frames, 'waiting')
  const order = []
  await runner(project, nodes, Object.fromEntries(Object.entries(steps).map(([id, step]) => [id, async context => { order.push(id); await step(context) }])))()
  assert.deepEqual(order, ['paint', 'cut', 'frames'])
  assert.equal(await readFile(join(projectDir(project.id), 'frame.txt'), 'utf8'), 'new')
})

test('a step before it that failed holds nothing up', async t => {
  const { project, put } = await setup(t)
  await put('in.txt', 'one')
  const nodes = [
    { id: 'first', kind: 'k', resource: 'local', inputs: ['in.txt'], outputs: ['first.txt'] },
    { id: 'second', kind: 'k', resource: 'local', deps: ['first'], inputs: ['first.txt'], outputs: ['second.txt'] },
  ]
  await runner(project, nodes, { first: write('first.txt'), second: write('second.txt') })()
  await put('in.txt', 'two')
  await runner(project, nodes, { first: () => { throw new FatalError('模型拒绝了') }, second: write('second.txt') })()
  const statuses = await statusesOf(project, nodes)
  assert.equal(statuses.first, 'failed')
  assert.equal(statuses.second, 'done', 'what it was made from is still what is on disk')
})

test('a changed setting counts as a changed input', async t => {
  const { project } = await setup(t)
  const build = prompt => [{ id: 'out.txt', kind: 'k', resource: 'local', params: { prompt }, outputs: ['out.txt'] }]
  await runner(project, build('one'), { 'out.txt': write('out.txt') })()
  assert.equal((await statusesOf(project, build('one')))['out.txt'], 'done')
  assert.equal((await statusesOf(project, build('two')))['out.txt'], 'stale')
})

test('a dry run does not count as a real result', async t => {
  const { project } = await setup(t)
  const nodes = [{ id: 'out.txt', kind: 'k', resource: 'local', outputs: ['out.txt'] }]
  await runner(project, nodes, { 'out.txt': write('out.txt') })()
  assert.equal((await statusesOf(project, nodes))['out.txt'], 'done')
  assert.equal((await statusesOf({ ...project, provider: 'ark' }, nodes))['out.txt'], 'stale')
})

test('a failure stops what depends on it and nothing else, and says why', async t => {
  const { project } = await setup(t)
  const nodes = [
    { id: 'bad', kind: 'k', resource: 'local', outputs: ['bad.txt'] },
    { id: 'after-bad', kind: 'k', resource: 'local', deps: ['bad'], outputs: ['after.txt'] },
    { id: 'other', kind: 'k', resource: 'local', outputs: ['other.txt'] },
  ]
  const ran = await runner(project, nodes, {
    bad: () => { throw new FatalError('模型拒绝了') },
    'after-bad': write('after.txt'),
    other: write('other.txt'),
  })()
  const statuses = await statusesOf(project, nodes)
  assert.equal(statuses.bad, 'failed')
  assert.equal(statuses['after-bad'], 'waiting')
  assert.equal(statuses.other, 'done')
  assert.equal(ran['after-bad'], undefined)
  assert.equal(ran.bad, 1, 'something retrying cannot fix is not retried')
  assert.equal((await readState(project.id)).nodes.bad.error, '模型拒绝了')
})

test('running something else leaves an earlier failure on the record', async t => {
  const { project } = await setup(t)
  const nodes = [
    { id: 'bad', kind: 'k', resource: 'local', outputs: ['bad.txt'] },
    { id: 'other', kind: 'k', resource: 'local', outputs: ['other.txt'] },
  ]
  const steps = { bad: () => { throw new FatalError('模型拒绝了') }, other: write('other.txt') }
  await runner(project, nodes, steps)({ targets: ['bad'] })
  await runner(project, nodes, steps)({ targets: ['other'] })
  assert.equal((await readState(project.id)).nodes.bad.error, '模型拒绝了')
  assert.equal((await statusesOf(project, nodes)).bad, 'failed')
})

test('a step that repaints what it reads and then fails is not run again by itself', async t => {
  const { project, put } = await setup(t)
  await put('paint.png', 'first')
  const nodes = [{ id: 'matte', kind: 'k', resource: 'local', inputs: ['paint.png'], outputs: ['matte.png'] }]
  let calls = 0
  await runner(project, nodes, {
    // Like the matte check, which paints the picture it reads again before it gives up.
    matte: async context => {
      calls++
      if (calls > 3) cancelRun(project.id) // Otherwise this goes on, and is paid for, until someone stops it.
      await writeFile(context.path('paint.png'), `repainted ${calls}`)
      throw new FatalError('画错了')
    },
  })()
  assert.equal(calls, 1)
  assert.equal((await statusesOf(project, nodes)).matte, 'failed')
})

test('a passing problem is retried, and a permanent one gives up', async t => {
  const { project } = await setup(t)
  let calls = 0
  const flaky = [{ id: 'flaky', kind: 'k', resource: 'local', outputs: ['flaky.txt'] }]
  await runner(project, flaky, {
    flaky: async context => {
      calls++
      if (calls < 3) throw new TransientError('HTTP 503')
      await writeFile(context.path('flaky.txt'), 'made')
    },
  })()
  assert.equal(calls, 3)
  assert.equal((await statusesOf(project, flaky)).flaky, 'done')

  let forever = 0
  const stuck = [{ id: 'stuck', kind: 'k', resource: 'local', outputs: ['stuck.txt'] }]
  await runner(project, stuck, { stuck: () => { forever++; throw new TransientError('HTTP 503') } })()
  assert.equal(forever, 4)
  assert.equal((await statusesOf(project, stuck)).stuck, 'failed')
})

test('a step that claims to finish without its output has failed', async t => {
  const { project } = await setup(t)
  const nodes = [{ id: 'empty', kind: 'k', resource: 'local', outputs: ['never.txt'] }]
  await runner(project, nodes, { empty: async () => {} })()
  assert.equal((await statusesOf(project, nodes)).empty, 'failed')
})

test('a paid task already submitted is picked up after a stop, not submitted again', async t => {
  const { project } = await setup(t)
  const nodes = [{ id: 'video', kind: 'k', resource: 'video', outputs: ['video.txt'] }]
  const submitted = []
  const seen = []
  const steps = {
    video: async context => {
      seen.push(context.external)
      if (!context.external) {
        submitted.push('task-1')
        await context.setExternal({ taskId: 'task-1' })
        // The server is stopped while the model is still working on it.
        cancelRun(project.id)
        context.signal.throwIfAborted()
      }
      await writeFile(context.path('video.txt'), 'collected')
    },
  }
  await runner(project, nodes, steps)()
  assert.equal((await statusesOf(project, nodes)).video, 'ready', 'stopped, not failed')
  assert.deepEqual((await readState(project.id)).nodes.video.external, { taskId: 'task-1' }, 'the id is on disk')
  await runner(project, nodes, steps)()
  assert.deepEqual(submitted, ['task-1'])
  assert.deepEqual(seen, [null, { taskId: 'task-1' }])
  assert.equal((await statusesOf(project, nodes)).video, 'done')
})

test('a redone paid step keeps what it replaces', async t => {
  const { project } = await setup(t)
  const nodes = [{ id: 'pic', kind: 'k', resource: 'image', outputs: ['pic.txt'] }]
  let version = 0
  const go = runner(project, nodes, { pic: context => writeFile(context.path('pic.txt'), `v${++version}`) })
  await go()
  await resetNode(project.id, 'pic')
  // A reset alone forgets the result without touching the file.
  assert.equal(await readFile(join(projectDir(project.id), 'pic.txt'), 'utf8'), 'v1')
  assert.equal((await statusesOf(project, nodes)).pic, 'ready')
  await go()
  assert.equal(await readFile(join(projectDir(project.id), 'pic.txt'), 'utf8'), 'v2')
  const archive = join(projectDir(project.id), 'archive')
  const [stamp] = await readdir(archive)
  assert.equal(await readFile(join(archive, stamp, 'pic.txt'), 'utf8'), 'v1')
})

test('the plan counts everything downstream of a change, and nothing that is up to date', () => {
  const nodes = [
    { id: 'a', resource: 'image', attempts: 3 },
    { id: 'b', resource: 'video', seconds: 6, deps: ['a'] },
    { id: 'c', resource: 'video', seconds: 4 },
    { id: 'd', resource: 'text' },
  ]
  const { calls, nodes: list } = planFor(nodes, { a: 'stale', b: 'done', c: 'done', d: 'done' })
  assert.deepEqual(list, ['a', 'b'])
  assert.deepEqual(calls, { text: 0, image: 3, imageMin: 1, video: 1, videoSeconds: 6 })
})

test('a work removed from the library stays on disk', async t => {
  const { project, put } = await setup(t)
  await put('plate.png', 'paid for')
  await removeFromLibrary(project.id)
  assert.equal((await listProjects()).some(work => work.id === project.id), false)
  assert.equal(await readFile(join(projectDir(project.id), 'plate.png'), 'utf8'), 'paid for')
})

test('many steps writing at once all land', async t => {
  const { project } = await setup(t)
  const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, kind: 'k', resource: 'local', outputs: [`n${i}.txt`] }))
  const steps = Object.fromEntries(nodes.map(node => [node.id, async context => {
    for (let i = 0; i < 20; i++) context.log(`line ${i}`)
    await writeFile(context.path(`${node.id}.txt`), 'made')
  }]))
  await runner(project, nodes, steps)()
  const statuses = await statusesOf(project, nodes)
  assert.ok(Object.values(statuses).every(status => status === 'done'), JSON.stringify(statuses))
})
