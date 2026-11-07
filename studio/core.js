// What every page shares: drawing, talking to the server, and what is open right now.
import { ICONS } from './icons.js'

export const $ = id => document.getElementById(id)
const SVG_NS = 'http://www.w3.org/2000/svg'

export function el(tag, props = {}, ...children) {
  const isSvg = props.svg || tag === 'svg'
  const node = isSvg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key === 'svg' || value === undefined || value === null || value === false) continue
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else if (isSvg || key === 'class' || key === 'role' || key === 'style' || key.startsWith('aria') || key.startsWith('data')) node.setAttribute(key, value)
    else node[key] = value
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue
    node.append(child.nodeType ? child : String(child))
  }
  return node
}
export const svg = (tag, props = {}, ...children) => el(tag, { ...props, svg: true }, ...children)

export function icon(name, size = 16) {
  const node = document.createElementNS(SVG_NS, 'svg')
  for (const [key, value] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: name === 'play' ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) node.setAttribute(key, value)
  node.innerHTML = ICONS[name] ?? ''
  return node
}

export const fill = (host, ...children) => host.replaceChildren(...children.flat(Infinity).filter(Boolean))

export async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
  const reply = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(reply.error || `HTTP ${response.status}`)
  return reply
}

let toastTimer
export function toast(message, bad = false) {
  const box = $('toast')
  box.textContent = message
  box.className = bad ? 'bad' : ''
  box.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { box.hidden = true }, bad ? 7000 : 3200)
}

export const attempt = work => async (...args) => {
  try {
    return await work(...args)
  } catch (error) {
    toast(error.message, true)
  }
}

export function ask(title, body, yes, { danger = false } = {}) {
  const dialog = $('confirm')
  $('confirm-title').textContent = title
  fill($('confirm-body'), [body].flat().map(line => el('p', {}, line)))
  $('confirm-yes').textContent = yes
  $('confirm-yes').className = danger ? 'danger' : 'primary'
  dialog.returnValue = ''
  dialog.showModal()
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), { once: true }))
}

// ---------------------------------------------------------------- what is open
export const state = {
  view: null, // Everything the server says about the open project.
  projectId: null,
  stage: null,
  catalog: null,
  selection: {},
}

export const freshSelection = () => ({ person: null, sceneNode: null, whiteboxScene: null, whiteboxObject: null, wbView: null, card: null, node: null, playScene: null, makeView: 'gallery' })
state.selection = freshSelection()

// Filled in by the shell, so pages can ask for a redraw without importing it.
export const hooks = { renderPage: () => {}, renderChrome: () => {}, openSettings: () => {}, refresh: async () => {} }

export const project = () => state.view?.project
export const readonly = () => Boolean(project()?.readonly)
export const running = () => Boolean(state.view?.run)
export const locked = () => readonly() || running()
export const makingNodes = () => state.view.nodes.filter(node => node.group !== 'authoring')
export const go = (stage, id = state.projectId) => { location.hash = `#/${id}/${stage}` }

export const fileUrl = (relative, stamp = '') => `/api/projects/${state.projectId}/files/${encodeURI(relative)}${stamp ? `?t=${stamp}` : ''}`
export const thumbUrl = (file, { width = 480, at, key, stamp = '', id = state.projectId } = {}) =>
  `/api/projects/${id}/thumb?file=${encodeURIComponent(file)}&w=${width}${at !== undefined ? `&at=${at}` : ''}${key ? '&key=1' : ''}&s=${stamp}`

const nodeReady = id => ['done', 'stale'].includes(state.view.statuses[id])

// The best picture there is of a scene right now: painted if it has been, otherwise its whitebox.
export function scenePoster(scene) {
  if (readonly()) return { file: 'plate_a_closed.png' }
  const painted = `scene:${scene.id}:a_closed`
  if (nodeReady(painted)) return { file: `scenes/${scene.id}/plate_a_closed.png`, stamp: state.view.records[painted]?.finishedAt }
  const guides = `scene:${scene.id}:guides`
  if (nodeReady(guides)) return { file: `scenes/${scene.id}/clay_a_closed.png`, stamp: state.view.records[guides]?.finishedAt, draft: true }
  return null
}

// ---------------------------------------------------------------- saving
let saveTimer = null
let pendingPatch = {}
let afterSave = () => {}

export function saveSoon(patch, after = () => {}) {
  Object.assign(pendingPatch, patch)
  afterSave = after
  clearTimeout(saveTimer)
  saveTimer = setTimeout(attempt(flushSave), 450)
}

export async function flushSave() {
  clearTimeout(saveTimer)
  if (!Object.keys(pendingPatch).length) return
  const body = pendingPatch
  const then = afterSave
  pendingPatch = {}
  afterSave = () => {}
  state.view = await api(`/api/projects/${state.projectId}`, { method: 'PUT', body })
  hooks.renderChrome()
  then()
}

// What a run would make, in words.
export function callsSentence(plan) {
  const parts = []
  if (plan.image) parts.push(`${plan.imageMin === plan.image ? plan.image : `${plan.imageMin} 到 ${plan.image}`} 张图`)
  if (plan.video) parts.push(`${plan.video} 段视频（共 ${plan.videoSeconds} 秒）`)
  return parts.join('、') || '不需要调用模型'
}

export async function runScope(scope, extra = {}) {
  await flushSave()
  await api(`/api/projects/${state.projectId}/run`, { method: 'POST', body: { scope, ...extra } })
  await hooks.refresh()
}

export async function runTargets(targets) {
  await flushSave()
  await api(`/api/projects/${state.projectId}/run`, { method: 'POST', body: { targets } })
  await hooks.refresh()
}

export const resetNode = id => api(`/api/projects/${state.projectId}/nodes/${encodeURIComponent(id)}/reset`, { method: 'POST' })

// ---------------------------------------------------------------- pieces
export function field(label, value, onChange, { multiline = false, rows = 3, placeholder = '', hint = null } = {}) {
  return el('label', { class: 'field' }, el('span', {}, label), el(multiline ? 'textarea' : 'input', { value: value ?? '', placeholder, disabled: locked(), ...(multiline ? { rows } : {}), oninput: event => onChange(event.target.value) }), hint ? el('small', {}, hint) : null)
}

// The strip across the top of every working page.
export function pageBar({ title, note, actions = [] }) {
  return el('header', { class: 'page-bar' },
    el('div', { class: 'page-bar-title' }, project() ? el('span', { class: 'crumb' }, project().title) : null, el('h1', {}, title), note ? el('p', {}, note) : null),
    el('div', { class: 'page-bar-actions' }, actions))
}

export const nextButton = (label, stage) => el('button', { class: 'primary', onclick: () => go(stage) }, label, icon('arrow-right', 15))

export const emptyState = (iconName, title, text, action = null) => el('div', { class: 'empty-state' },
  el('div', { class: 'empty-icon' }, icon(iconName, 22)), el('h2', {}, title), el('p', {}, text), action)

export function readingBanner() {
  const { view } = state
  const busy = view.nodes.find(node => node.group === 'authoring' && view.statuses[node.id] === 'running')
  if (busy) return el('div', { class: 'notice busy', 'data-reading': '1' }, `${busy.title}…… ${view.records[busy.id]?.progress ?? ''}`)
  const failed = view.nodes.find(node => node.group === 'authoring' && view.statuses[node.id] === 'failed')
  if (failed) return el('div', { class: 'notice bad' }, icon('circle-alert'), `${failed.title}没有完成：${view.records[failed.id]?.error}`)
  return null
}

export const imgOf = (file, options = {}, props = {}) => el('img', { src: thumbUrl(file, options), alt: '', loading: 'lazy', ...props })
