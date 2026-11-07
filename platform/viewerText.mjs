// What someone watching gets: narration, what the player is doing, and what people say. No outline and no shot descriptions,
// so anyone reading this knows only what an audience would.
const words = text => String(text ?? '').trim()

export function viewerScene(scene, index) {
  const out = [`【第 ${index + 1} 场：${scene.title}】`]
  if (words(scene.openingLine)) out.push(`旁白：${words(scene.openingLine)}`)
  for (const beat of scene.beats) {
    out.push(`主角去做：${beat.objective}`)
    if (words(beat.during)) out.push(`旁白：${words(beat.during)}`)
    for (const line of beat.lines ?? []) out.push(`${line.who}：${line.says}`)
    if (words(beat.after)) out.push(`旁白：${words(beat.after)}`)
  }
  if (words(scene.endingLine)) out.push(`旁白：${words(scene.endingLine)}`)
  for (const line of scene.film?.ending?.lines ?? []) out.push(`${line.who}：${line.says}`)
  return out.join('\n')
}

export const viewerText = (scenes, upTo = scenes.length) => scenes.slice(0, upTo).map(viewerScene).join('\n\n')
