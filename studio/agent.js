// Notes on the whole story, from any page, above all right after playing it. What comes back is a proposal: what would
// change and what remaking it would cost. Nothing moves until it is applied.
import { $, api, ask, attempt, callsSentence, el, fill, flushSave, go, hooks, icon, project, readonly, running, runScope, state } from './core.js'

const STARTERS = ['你先看一遍全片，有什么问题', '让这两个人当面吵起来', '这一场多加一步，让线索来得更曲折']
const STARTERS_ON = {
  story: ['第二章再多一个转折', '结局再狠一点', '主角要靠自己赢'],
  chapters: ['第二章再多一个转折', '前两个锚点不要分先后，让玩家自己选', '结局再狠一点'],
  cast: ['把配角写得更有私心', '换一个主角的造型', '再加一个搅局的人'],
  scenes: ['加一个地方，让玩家能绕回来', '这条路等第二章再打开', '两个地方合成一个'],
  whitebox: ['这里太空了，多摆点东西', '把出口挪到中间', '这个地方再大一点'],
}
const startersNow = () => (project()?.flow === 'chapters' ? STARTERS_ON[state.stage] : null) ?? STARTERS

let saying = null
let drawn = ''

const agent = () => project()?.agent ?? { chat: [], proposal: null, canUndo: false, redoPending: false }
export const agentAvailable = () => Boolean(project()) && !readonly() && (project().scenes.length > 0 || (project().chapters?.length ?? 0) > 0)
export const agentWaiting = () => Boolean(agent().proposal)

export function toggleAgent(open = !state.selection.agentOpen) {
  state.selection.agentOpen = open
  document.querySelector('.shell')?.classList.toggle('agent-open', open)
  hooks.renderChrome()
  if (open) {
    updateAgent(true)
    queueMicrotask(() => $('agent-note')?.focus())
  }
}

const applied = reply => {
  state.view = reply
  hooks.renderChrome()
  updateAgent(true)
}

async function say(text) {
  const said = text.trim()
  if (!said || saying || running()) return
  const id = state.projectId
  await flushSave()
  saying = said
  state.selection.agentDraft = ''
  $('agent-note').value = ''
  updateAgent(true)
  try {
    const reply = await api(`/api/projects/${id}/agent`, { method: 'POST', body: { message: said, page: state.stage } })
    saying = null
    if (state.projectId === id) {
      applied(reply)
      // Said yes in words: what was waiting is now being made, and that is where it can be watched.
      if (reply.run) go('generate')
    }
  } catch (error) {
    saying = null
    state.selection.agentDraft = said
    if ($('agent-note')) $('agent-note').value = said
    updateAgent(true)
    throw error
  }
}

// Leaves a game page before remaking what it has open, and the production board shows what is happening next.
const apply = regenerate => attempt(async () => {
  applied(await api(`/api/projects/${state.projectId}/agent/apply`, { method: 'POST', body: { regenerate } }))
  if (regenerate) go('generate')
  else hooks.renderPage()
})

const dismiss = attempt(async () => applied(await api(`/api/projects/${state.projectId}/agent/dismiss`, { method: 'POST' })))

const undo = attempt(async () => {
  applied(await api(`/api/projects/${state.projectId}/agent/undo`, { method: 'POST' }))
  hooks.renderPage()
})

const redo = attempt(async () => {
  if (project().provider === 'ark' && !await ask('重做改动涉及的内容？', [`最多生成 ${callsSentence(state.view.plan)}，会产生模型费用。`, '内容没变的不会重做，旧的结果保留在 archive 文件夹里。'], '开始重做')) return
  await runScope('generate')
  go('generate')
})

// In a long text only the part that differs says anything, and it may well be at the end.
function onlyWhatDiffers(from, to) {
  if (from.length < 80 || !to) return [from, to]
  let start = 0
  while (start < from.length && from[start] === to[start]) start++
  let end = 0
  while (end < from.length - start && end < to.length - start && from.at(-1 - end) === to.at(-1 - end)) end++
  const cut = text => `${start > 12 ? '……' : ''}${text.slice(start > 12 ? start - 12 : 0, end > 12 ? text.length - end + 12 : text.length)}${end > 12 ? '……' : ''}`
  return [cut(from), cut(to)]
}

function changeLine({ where, what, from, to }) {
  const [before, after] = onlyWhatDiffers(from, to)
  return el('li', {},
    el('span', { class: 'agent-where' }, `${where} · ${what}`),
    before ? el('del', { title: from }, before) : null,
    after ? el('span', { class: 'agent-to', title: to }, after) : null)
}

function costOf({ plan, needsLayout }) {
  const real = project().provider === 'ark'
  const paid = plan.calls.image > 0 || plan.calls.video > 0
  if (needsLayout.length) return `新场景先自动摆白模，只用文本模型。摆好后可以先走进去试，确认了再生成，之后大约要做 ${callsSentence(plan.calls)}，摆好后会有准确的数字。`
  if (plan.neverMade) return '这个故事还没开始生成，这条只改内容，不花钱。'
  if (!plan.steps) return '不用重做任何东西，不花钱，马上生效。'
  if (!paid) return '不花钱，只需要重新合成影片。'
  return real ? `最多重做 ${callsSentence(plan.calls)}，会产生模型费用。旧的结果保留在 archive 文件夹里。` : `预演模式不花钱：用占位素材重做 ${callsSentence(plan.calls)}。`
}

function proposalCard(proposal) {
  const { plan, needsLayout, changed, notes, remakes } = proposal
  const paid = !plan.neverMade && (plan.calls.image > 0 || plan.calls.video > 0)
  const busy = running() || Boolean(saying)
  const actions = needsLayout.length
    ? [el('button', { class: 'primary', disabled: busy, onclick: apply(false) }, '应用并摆白模')]
    : paid
      ? [el('button', { class: 'primary', disabled: busy, onclick: apply(true) }, '应用并重做'), el('button', { disabled: busy, onclick: apply(false) }, '先只改内容')]
      : [el('button', { class: 'primary', disabled: busy, onclick: apply(plan.steps > 0 && !plan.neverMade) }, '应用')]
  return el('div', { class: 'agent-proposal' },
    changed.length ? el('div', { class: 'block' }, el('h3', {}, '要改的内容'), el('ul', { class: 'agent-changes' }, changed.map(changeLine))) : null,
    remakes?.length ? el('p', { class: 'small' }, `重新生成 ${remakes.length} 项，内容不变。`) : null,
    proposal.doubts?.length ? el('div', { class: 'notice' }, el('b', {}, '我自查后还不放心：'), proposal.doubts.join('；')) : null,
    notes?.length ? el('p', { class: 'small muted' }, notes.join(' ')) : null,
    el('div', { class: 'block' }, el('h3', {}, '代价'),
      el('p', { class: 'small' }, costOf(proposal)),
      plan.items.length && !plan.neverMade ? el('div', { class: 'agent-items' }, plan.items.map(item => el('span', { class: 'chip' }, `${item.section} · ${item.title}`))) : null),
    el('div', { class: 'row' }, actions, el('button', { class: 'quiet', disabled: busy, onclick: dismiss }, '不要')))
}

function logLines() {
  const { chat = [], proposal, canUndo, redoPending } = agent()
  const lines = chat.map((line, index) => {
    if (line.role === 'user') return el('div', { class: 'chat-line me' }, line.text)
    const isLast = index === chat.length - 1
    return el('div', { class: `chat-line designer ${line.failed ? 'failed' : ''}` }, line.text,
      line.looked?.length ? el('small', { class: 'agent-looked' }, `看了：${line.looked.join('；')}`) : null,
      line.applied && isLast && canUndo ? el('button', { class: 'quiet chat-undo', disabled: running() || Boolean(saying), onclick: undo }, icon('rotate-ccw', 13), '撤销') : null)
  })
  return [
    !chat.length && !saying ? el('div', { class: 'block' },
      el('p', { class: 'small muted' }, '玩过或看过之后，说说哪里不对：剧情、人物、台词、场景、白模都能改。我能看画面，听不到声音。说“可以”我就照着重做，做完再看一遍。'),
      el('div', { class: 'chat-starters' }, startersNow().map(text => el('button', { onclick: () => { const box = $('agent-note'); box.value = text; state.selection.agentDraft = text; box.focus() } }, text)))) : null,
    lines,
    saying ? [el('div', { class: 'chat-line me' }, saying), el('div', { class: 'chat-line designer thinking' }, icon('loader-circle', 14), '正在想怎么改，改完还要自己再查一遍：意见落实了没有、剧情接不接得上……')] : null,
    agent().checking ? el('div', { class: 'chat-line designer thinking' }, icon('loader-circle', 14), '正在看刚做好的画面……') : null,
    proposal && !saying ? proposalCard(proposal) : null,
    redoPending && !proposal && !saying && !running() && state.view.plan && (state.view.plan.image || state.view.plan.video)
      ? el('div', { class: 'notice' }, `改动还没有重做，试玩和成片里仍是旧画面。最多要做 ${callsSentence(state.view.plan)}。`, el('button', { class: 'primary', onclick: redo }, '重做'))
      : null,
  ]
}

export function agentPanel() {
  const box = el('textarea', {
    id: 'agent-note', rows: 3, 'aria-label': '修改意见', placeholder: '说说哪里要改……',
    value: state.selection.agentDraft ?? '',
    oninput: event => { state.selection.agentDraft = event.target.value },
    onkeydown: event => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
      event.preventDefault()
      attempt(say)(event.target.value)
    },
  })
  drawn = ''
  return el('aside', { class: 'agent-panel', 'aria-label': '修改意见' },
    el('div', { class: 'agent-head' }, el('h2', {}, '修改意见'), el('button', { class: 'quiet icon-only', 'aria-label': '收起', title: '收起', onclick: () => toggleAgent(false) }, icon('x', 16))),
    el('div', { class: 'chat-log agent-log', id: 'agent-log', 'aria-live': 'polite' }),
    el('div', { class: 'agent-foot' },
      el('p', { class: 'small muted', id: 'agent-hint', hidden: true }, '正在制作，停下来之后才能改。'),
      el('div', { class: 'chat-box' }, box, el('button', { class: 'primary icon-only', id: 'agent-send', 'aria-label': '发送', onclick: attempt(() => say(box.value)) }, icon('arrow-up', 15)))))
}

// Redrawn only when something it shows has changed, since the server reports progress many times a second.
export function updateAgent(force = false) {
  const log = $('agent-log')
  if (!log || !state.selection.agentOpen) return
  const signature = JSON.stringify([agent(), saying, running(), project().provider, state.view.plan])
  const busy = running() || Boolean(saying)
  $('agent-note').disabled = busy
  $('agent-send').disabled = busy
  $('agent-hint').hidden = !running()
  if (!force && signature === drawn) return
  drawn = signature
  fill(log, logLines())
  log.scrollTop = log.scrollHeight
}
