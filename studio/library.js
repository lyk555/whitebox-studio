// The front door: what this does, shown on a real example, and everything made so far.
import { api, ask, attempt, el, fill, go, hooks, icon, thumbUrl } from './core.js'

const SAMPLE = '守夜人老周在旧剧院干了三十年。今晚下着大雨，他巡查到后台，发现化妆间的灯亮着。化妆台上压着一张没有署名的纸条，写着：道具箱里有你一直想找的东西。老周在戏服底下翻出一把生锈的铜钥匙。他握着钥匙，走到后台尽头那扇从没开过的小门前。门后传来很轻的音乐声。他推开了门。'
const STEPS = ['故事', '章节', '人物', '地点图', '白模', '生成', '互动', '观看']

// The whole idea of the tool in one picture: the same room as geometry and as a finished frame.
function compare(work) {
  const box = el('div', { class: 'compare', role: 'img', 'aria-label': '同一个房间的白模和成片，可以左右拖动对比' },
    el('img', { src: thumbUrl('plate_a_closed.png', { id: work.id, width: 1280, stamp: work.updatedAt }), alt: '' }),
    el('img', { class: 'clay', src: thumbUrl('clay_a_closed.png', { id: work.id, width: 1280, stamp: work.updatedAt }), alt: '' }),
    el('div', { class: 'compare-line' }),
    el('div', { class: 'compare-handle' }, icon('chevrons-left-right', 18)),
    el('span', { class: 'compare-tag left' }, '白模'),
    el('span', { class: 'compare-tag right' }, '成片'))
  let dragging = false
  let touched = false
  const setSplit = fraction => box.style.setProperty('--split', `${Math.max(0, Math.min(1, fraction)) * 100}%`)
  const follow = event => {
    const { left, width } = box.getBoundingClientRect()
    setSplit((event.clientX - left) / width)
  }
  box.addEventListener('pointerdown', event => {
    dragging = true
    touched = true
    box.setPointerCapture(event.pointerId)
    follow(event)
  })
  box.addEventListener('pointermove', event => { if (dragging) follow(event) })
  box.addEventListener('pointerup', () => { dragging = false })
  // One slow pass on arrival, so the picture says what it is before anyone touches it.
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const started = performance.now()
    const sweep = now => {
      if (touched || !box.isConnected) return
      const t = Math.min(1, (now - started) / 2600)
      const eased = t * t * (3 - 2 * t)
      setSplit(0.82 - 0.46 * eased)
      if (t < 1) requestAnimationFrame(sweep)
    }
    setSplit(0.82)
    requestAnimationFrame(sweep)
  }
  return box
}

function workCard(work) {
  return el('article', { class: 'work' },
    el('button', { class: 'work-open', onclick: () => openWork(work) },
      el('div', { class: 'work-cover' },
        work.cover ? el('img', { src: thumbUrl(work.cover, { id: work.id, stamp: work.updatedAt, width: 640 }), alt: '', loading: 'lazy' }) : el('div', { class: 'blank' }, icon('feather', 26))),
      work.readonly ? null : el('div', { class: 'work-meter' }, el('i', { style: `width:${Math.round(work.progress * 100)}%` })),
      el('div', { class: 'work-body' },
        el('b', {}, work.title),
        el('div', { class: 'work-meta' },
          work.readonly ? el('span', { class: 'chip solid' }, '示例') : el('span', { class: 'chip' }, work.phase),
          work.scenes ? el('span', {}, work.chapters ? `${work.scenes} 个地方` : `${work.scenes} 场`) : null,
          work.cast ? el('span', {}, `${work.cast} 人`) : null))),
    work.readonly ? null : el('button', { class: 'work-remove', 'aria-label': `移除 ${work.title}`, title: '移出作品库', onclick: attempt(async () => {
      if (!await ask(`移除《${work.title}》？`, `它会从作品库里消失，文件还留在硬盘上（projects/${work.id}）。`, '移除', { danger: true })) return
      await api(`/api/projects/${work.id}/remove`, { method: 'POST' })
      renderLibrary()
    }) }, icon('trash-2', 14)),
  )
}

// Go to where the work is up to, not back to the beginning.
function openWork(work) {
  const next = work.readonly || work.hasFilm ? 'watch' : work.progress > 0 ? 'generate' : work.phase === '白模已搭好' ? 'whitebox' : work.scenes ? 'scenes' : work.cast ? 'cast' : work.chapters ? 'chapters' : 'story'
  go(next, work.id)
}

export async function renderLibrary() {
  const works = await api('/api/projects')
  const showcase = works.find(work => work.readonly && work.cover)
  const box = el('textarea', { id: 'new-story', placeholder: '写下一段完整的故事，或者一个梗概，多长都可以……', 'aria-label': '故事', oninput: () => { start.disabled = !box.value.trim() } })
  const start = el('button', { class: 'primary', disabled: true, onclick: attempt(async () => {
    start.disabled = true
    const created = await api('/api/projects', { method: 'POST', body: { title: '未命名故事', story: box.value } })
    await api(`/api/projects/${created.id}/run`, { method: 'POST', body: { scope: 'outline', again: true } })
    go('chapters', created.id)
  }) }, '开始', icon('arrow-right', 15))
  fill(document.getElementById('app'), el('div', { class: 'library' },
    el('div', { class: 'library-bar' },
      el('span', { class: 'wordmark' }, el('i', {}, icon('box', 16)), '白模工坊'),
      el('span', { class: 'spacer' }),
      el('button', { class: 'quiet icon-only', 'aria-label': '模型设置', title: '模型设置', onclick: hooks.openSettings }, icon('settings', 17)),
    ),
    el('section', { class: 'hero' },
      el('div', { class: 'hero-copy' },
        el('h1', {}, '把一段故事，', el('br'), '拍成能走进去的短片'),
        el('p', {}, '先用几何体搭出白模，走一走，确认好玩。满意了，再让模型把它画成电影。'),
        el('div', { class: 'composer' }, box,
          el('div', { class: 'composer-foot' },
            el('button', { class: 'quiet', onclick: () => { box.value = SAMPLE; start.disabled = false; box.focus() } }, '用示例故事试试'),
            el('span', { class: 'spacer' }), start)),
        el('div', { class: 'flow-strip' }, STEPS.flatMap((step, index) => [index ? icon('chevron-right', 12) : null, el('span', {}, step)]))),
      showcase ? el('figure', { style: 'margin:0;min-width:0' },
        compare(showcase),
        el('figcaption', { class: 'hero-note' }, '《闭馆之后》里的同一个房间。拖动看看：玩家走动、碰撞、遮挡都在左边的几何体上，模型只负责右边的画面。')) : null,
    ),
    works.length ? el('section', { class: 'works-section' },
      el('div', { class: 'works-head' }, el('h2', {}, '作品'), el('small', { class: 'muted mono' }, works.length)),
      el('div', { class: 'works' }, works.map(workCard))) : null,
  ))
}
