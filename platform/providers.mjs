// The only place that talks to the models. Two providers with one shape: the real one, and a dry run
// that makes real files with no calls, so a whole workflow can be proven before anything is paid for.
import { spawn } from 'node:child_process'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { config } from './config.mjs'
import { FatalError, TransientError } from './engine.mjs'
import { ffmpeg, writePng } from './ffmpeg.mjs'

const NO_KEY_MESSAGE = '缺少火山方舟 API Key：请在“设置”里填写。'
const NO_REPLY_SECONDS = 120

function classified(status, message) {
  const transient = status === 429 || status >= 500
  return new (transient ? TransientError : FatalError)(`方舟接口 HTTP ${status}：${message}`)
}

async function ark(path, { signal, ...options } = {}) {
  const { key, baseURL } = config()
  if (!key) throw new FatalError(NO_KEY_MESSAGE)
  let response
  try {
    response = await fetch(`${baseURL}${path}`, { ...options, signal, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new TransientError(`连不上方舟：${error.cause?.code ?? error.message}`)
  }
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = { raw: text.slice(0, 500) } }
  if (!response.ok) throw classified(response.status, body?.error?.message || body?.message || body.raw || text.slice(0, 300))
  return body
}

async function asDataUrl(path) {
  return `data:image/png;base64,${(await readFile(path)).toString('base64')}`
}

async function download(url, path, signal) {
  let response
  try {
    response = await fetch(url, { signal })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new TransientError(`下载失败：${error.cause?.code ?? error.message}`)
  }
  if (!response.ok) throw new TransientError(`下载失败：HTTP ${response.status}`)
  // Through a temporary file, so a cut connection cannot leave half a picture that looks finished.
  await writeFile(`${path}.part`, Buffer.from(await response.arrayBuffer()))
  await rename(`${path}.part`, path)
}

// Streams so that a long answer is not mistaken for a dead connection: only silence stops it.
async function arkText({ system, user, images = [], model, thinking = false, onUsage = () => {}, signal, onProgress = () => {} }) {
  const { key, baseURL, textModel } = config()
  if (!key) throw new FatalError(NO_KEY_MESSAGE)
  const silence = new AbortController()
  let watchdog
  const heardFrom = () => {
    clearTimeout(watchdog)
    watchdog = setTimeout(() => silence.abort(), NO_REPLY_SECONDS * 1000)
  }
  heardFrom()
  try {
    let response
    try {
      response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.any([signal, silence.signal]),
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model ?? textModel,
          messages: [{ role: 'system', content: system }, { role: 'user', content: images.length ? [{ type: 'text', text: user }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))] : user }],
          thinking: { type: thinking ? 'enabled' : 'disabled' },
          response_format: { type: 'json_object' },
          max_tokens: 16384,
          temperature: 0.7,
          stream: true,
          stream_options: { include_usage: true },
        }),
      })
    } catch (error) {
      if (signal.aborted) throw error
      if (silence.signal.aborted) throw new TransientError(`模型 ${NO_REPLY_SECONDS} 秒没有回应。`)
      throw new TransientError(`连不上方舟：${error.cause?.code ?? error.message}`)
    }
    if (!response.ok) {
      const body = await response.text()
      let message = body.slice(0, 300)
      try { message = JSON.parse(body)?.error?.message ?? message } catch {}
      throw classified(response.status, message)
    }
    const decoder = new TextDecoder()
    let buffered = ''
    let answer = ''
    let finish = null
    try {
      for await (const chunk of response.body) {
        heardFrom()
        buffered += decoder.decode(chunk, { stream: true })
        const lines = buffered.split('\n')
        buffered = lines.pop()
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') continue
          const parsed = JSON.parse(payload)
          if (parsed.usage) onUsage(parsed.usage)
          const choice = parsed.choices?.[0]
          answer += choice?.delta?.content ?? ''
          finish = choice?.finish_reason ?? finish
        }
        onProgress(`模型已写 ${answer.length} 字`)
      }
    } catch (error) {
      if (signal.aborted) throw error
      if (silence.signal.aborted) throw new TransientError(`模型 ${NO_REPLY_SECONDS} 秒没有新内容。`)
      throw new TransientError(`连接中断：${error.message}`)
    }
    if (finish === 'length') throw new FatalError('模型的回答被截断了：内容超过了单次上限。')
    if (!answer.trim()) throw new TransientError('模型返回了空内容。')
    return answer
  } finally {
    clearTimeout(watchdog)
  }
}

async function arkImage({ prompt, references, out, size, signal }) {
  const reply = await ark('/images/generations', {
    method: 'POST',
    signal,
    body: JSON.stringify({
      model: config().imageModel,
      prompt,
      ...(references.length ? { image: await Promise.all(references.map(asDataUrl)) } : {}),
      size,
      response_format: 'url',
      output_format: 'png',
      watermark: false,
    }),
  })
  const url = reply.data?.[0]?.url
  if (!url) throw new FatalError(`图像模型没有返回图片：${JSON.stringify(reply).slice(0, 300)}`)
  await download(url, out, signal)
  return { size: reply.data[0].size, usage: reply.usage }
}

const REFUSED = /sensitive|safety|privacy|real.?person|审核|敏感|InputImage|InputText|Invalid/i

async function arkVideo({ text, first, last, references = [], ratio, resolution, duration, audio = false, out, signal, external, setExternal, onStatus = () => {} }) {
  let taskId = external?.taskId
  if (!taskId) {
    const task = await ark('/contents/generations/tasks', {
      method: 'POST',
      signal,
      body: JSON.stringify({
        model: config().videoModel,
        content: [
          { type: 'text', text },
          ...await Promise.all(references.map(async path => ({ type: 'image_url', image_url: { url: await asDataUrl(path) }, role: 'reference_image' }))),
          ...(first ? [{ type: 'image_url', image_url: { url: await asDataUrl(first) }, role: 'first_frame' }] : []),
          ...(last ? [{ type: 'image_url', image_url: { url: await asDataUrl(last) }, role: 'last_frame' }] : []),
        ],
        ratio, resolution, duration, generate_audio: audio, watermark: false,
      }),
    })
    taskId = task.id
    await setExternal({ taskId })
  } else {
    onStatus('接回上次已提交的视频任务')
  }
  const started = Date.now()
  let unheard = 0
  for (;;) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5000)
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')) }, { once: true })
    })
    let status
    try {
      status = await ark(`/contents/generations/tasks/${encodeURIComponent(taskId)}`, { signal })
      unheard = 0
    } catch (error) {
      if (signal.aborted) throw error
      if (!(error instanceof TransientError) || ++unheard >= 6) throw error
      continue
    }
    onStatus(`${status.status} · ${Math.round((Date.now() - started) / 1000)} 秒`)
    if (status.status === 'succeeded') {
      await download(status.content.video_url, out, signal)
      return { taskId, usage: status.usage }
    }
    if (['failed', 'expired', 'cancelled'].includes(status.status)) {
      const reason = `${status.error?.code ?? ''} ${status.error?.message ?? '没有返回原因'}`.trim()
      // A dead task will never finish, so whatever happens next must submit a new one.
      await setExternal(null)
      throw new (REFUSED.test(reason) ? FatalError : TransientError)(`视频任务 ${status.status}：${reason}`)
    }
  }
}

// One turn of a continuing conversation that may call tools. Plain text, since this is where a writer writes.
async function arkChat({ messages, tools, model, thinking = true, maxTokens = 32768, onUsage = () => {}, signal, onProgress = () => {} }) {
  const { key, baseURL, textModel } = config()
  if (!key) throw new FatalError(NO_KEY_MESSAGE)
  const silence = new AbortController()
  let watchdog
  const heardFrom = () => {
    clearTimeout(watchdog)
    watchdog = setTimeout(() => silence.abort(), NO_REPLY_SECONDS * 1000)
  }
  heardFrom()
  try {
    let response
    try {
      response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.any([signal, silence.signal]),
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model ?? textModel, messages, ...(tools?.length ? { tools } : {}),
          thinking: { type: thinking ? 'enabled' : 'disabled' },
          max_tokens: maxTokens, stream: true, stream_options: { include_usage: true },
        }),
      })
    } catch (error) {
      if (signal.aborted) throw error
      if (silence.signal.aborted) throw new TransientError(`模型 ${NO_REPLY_SECONDS} 秒没有回应。`)
      throw new TransientError(`连不上方舟：${error.cause?.code ?? error.message}`)
    }
    if (!response.ok) {
      const body = await response.text()
      let message = body.slice(0, 300)
      try { message = JSON.parse(body)?.error?.message ?? message } catch {}
      throw classified(response.status, message)
    }
    const decoder = new TextDecoder()
    let buffered = ''
    let content = ''
    let finish = null
    const calls = []
    try {
      for await (const chunk of response.body) {
        heardFrom()
        buffered += decoder.decode(chunk, { stream: true })
        const lines = buffered.split('\n')
        buffered = lines.pop()
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') continue
          const parsed = JSON.parse(payload)
          if (parsed.usage) onUsage(parsed.usage)
          const choice = parsed.choices?.[0]
          content += choice?.delta?.content ?? ''
          for (const part of choice?.delta?.tool_calls ?? []) {
            const call = (calls[part.index ?? 0] ??= { id: '', type: 'function', function: { name: '', arguments: '' } })
            call.id ||= part.id ?? ''
            call.function.name += part.function?.name ?? ''
            call.function.arguments += part.function?.arguments ?? ''
          }
          finish = choice?.finish_reason ?? finish
        }
        onProgress(`模型已写 ${content.length} 字`)
      }
    } catch (error) {
      if (signal.aborted) throw error
      if (silence.signal.aborted) throw new TransientError(`模型 ${NO_REPLY_SECONDS} 秒没有新内容。`)
      throw new TransientError(`连接中断：${error.message}`)
    }
    if (finish === 'length') throw new FatalError('模型的回答被截断了：内容超过了单次上限。')
    return { content, toolCalls: calls.filter(Boolean) }
  } finally {
    clearTimeout(watchdog)
  }
}

// ---------------------------------------------------------------- dry run
const GREEN = [0, 255, 0]

function paintFigure(size, phase, walking) {
  const pixels = new Uint8ClampedArray(size * size * 4)
  for (let i = 0; i < pixels.length; i += 4) pixels.set([...GREEN, 255], i)
  const rect = (x, y, w, h, color) => {
    for (let py = Math.max(0, Math.round(y)); py < Math.min(size, Math.round(y + h)); py++) {
      for (let px = Math.max(0, Math.round(x)); px < Math.min(size, Math.round(x + w)); px++) pixels.set([...color, 255], (py * size + px) * 4)
    }
  }
  const unit = size / 100
  const swing = walking ? Math.sin(phase) * 12 : 0
  rect(44 * unit, 10 * unit, 12 * unit, 12 * unit, [214, 170, 140])
  rect(38 * unit, 22 * unit, 24 * unit, 36 * unit, [40, 66, 80])
  rect((46 + swing) * unit, 58 * unit, 7 * unit, 32 * unit, [36, 36, 44])
  rect((47 - swing) * unit, 58 * unit, 7 * unit, 32 * unit, [30, 30, 38])
  rect((31 - swing * 0.5) * unit, 24 * unit, 6 * unit, 28 * unit, [40, 66, 80])
  rect((63 + swing * 0.5) * unit, 24 * unit, 6 * unit, 28 * unit, [40, 66, 80])
  return pixels
}

function pipeFrames(out, size, fps, count, paint) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${size}x${size}`, '-r', String(fps), '-i', 'pipe:0', '-c:v', 'libx264', '-crf', '12', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out], { stdio: ['pipe', 'ignore', 'pipe'] })
    let errors = ''
    child.stderr.on('data', chunk => { errors += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`写入 ${out} 失败：${errors}`)))
    let frame = 0
    const next = () => {
      while (frame < count) {
        const ok = child.stdin.write(Buffer.from(paint(frame++).buffer))
        if (!ok) { child.stdin.once('drain', next); return }
      }
      child.stdin.end()
    }
    next()
  })
}

const pause = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')) }, { once: true })
})

async function mockImage({ references, out, size = '2560x1440', hint = {}, signal }) {
  await pause(150, signal)
  const [width, height] = size.split('x').map(Number)
  const scaled = `scale=${width}:${height}`
  if (hint.kind === 'stand') {
    await writePng(out, paintFigure(768, 0, false), 768, 768)
  } else if (hint.kind === 'matte') {
    // Keeps what the mask marks as furniture and paints the rest screen green, as the real model is asked to.
    await ffmpeg(['-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x00ff00:s=${width}x${height}`, '-i', references[0], '-i', hint.mask, '-filter_complex',
      `[1:v]${scaled},format=gbrp[plate];[0:v]format=gbrp[green];[2:v]${scaled},format=gray,lut=y='if(gt(val,200),255,0)',format=gbrp[mask];[green][plate][mask]maskedmerge[out]`, '-map', '[out]', '-frames:v', '1', out])
  } else if (references[0] && hint.kind !== 'prop') {
    // Tinted, so a dry-run plate cannot be mistaken for a real one, and carrying the guide's lines.
    // A picture with holes to fill takes the whitebox instead, since nothing here can fill them.
    await ffmpeg(['-loglevel', 'error', '-i', hint.kind === 'fill' ? references[1] : references[0], '-vf', `${scaled},colorbalance=rs=.18:gs=.05:bs=-.14,drawbox=x=0:y=0:w=iw:h=26:color=0xffb000@0.65:t=fill`, '-frames:v', '1', out])
  } else if (hint.kind === 'prop') {
    await ffmpeg(['-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x00ff00:s=${size}`, '-vf', `drawbox=x=iw*0.2:y=ih*0.2:w=iw*0.6:h=ih*0.6:color=0xd9b779:t=fill`, '-frames:v', '1', out])
  } else {
    await ffmpeg(['-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x8a8a8a:s=${size}`, '-vf', 'drawbox=x=iw*0.15:y=ih*0.25:w=iw*0.25:h=ih*0.5:color=0xd6aa8c:t=fill,drawbox=x=iw*0.6:y=ih*0.25:w=iw*0.25:h=ih*0.5:color=0xd6aa8c:t=fill', '-frames:v', '1', out])
  }
  return { size, usage: { dryRun: true } }
}

async function mockVideo({ first, last, references = [], duration, out, hint = {}, signal, setExternal, external, onStatus = () => {} }) {
  if (!external?.taskId) await setExternal({ taskId: `dry-${Date.now()}` })
  onStatus('试运行')
  await pause(250, signal)
  if (hint.kind === 'walk') {
    const fps = 24
    const period = 26
    await pipeFrames(out, 720, fps, duration * fps, frame => paintFigure(720, (frame / period) * Math.PI * 2, true))
    return { taskId: 'dry', usage: { dryRun: true } }
  }
  const tone = ['-f', 'lavfi', '-t', String(duration), '-i', 'sine=frequency=220:sample_rate=44100']
  const start = first ?? references.at(-1)
  const end = last ?? start
  const fit = 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p,fps=24'
  await ffmpeg(['-loglevel', 'error', '-loop', '1', '-t', String(duration), '-i', start, '-loop', '1', '-t', String(duration), '-i', end, ...tone,
    '-filter_complex', `[0:v]${fit}[a];[1:v]${fit}[b];[a][b]xfade=transition=fade:duration=${Math.max(0.5, duration / 3).toFixed(2)}:offset=${(duration * 0.6).toFixed(2)}[v]`,
    '-map', '[v]', '-map', '2:a', '-t', String(duration), '-c:v', 'libx264', '-crf', '16', '-preset', 'ultrafast', '-c:a', 'aac', out])
  return { taskId: 'dry', usage: { dryRun: true } }
}

const PROVIDERS = {
  ark: { text: arkText, chat: arkChat, image: arkImage, video: arkVideo },
  mock: { text: null, image: mockImage, video: mockVideo },
}

export const providerFor = project => PROVIDERS[project.provider] ?? PROVIDERS.mock

// Reading a story costs next to nothing and a placeholder reading is useless to look at, so it uses the
// real model whenever there is a key. Previewing only ever replaces pictures and video.
export const readerProvider = () => (config().key ? PROVIDERS.ark : PROVIDERS.mock)

export async function testConnection() {
  // Listing tasks costs nothing and proves the key and the address both work.
  await ark('/contents/generations/tasks?page_num=1&page_size=1')
}
