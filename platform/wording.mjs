// What a model writes for a shot, put right before a picture is made from it. Each of these is something a model left in
// its answer on 《雾都码头谜案》 and the video model was then handed.

// What the model wrote may or may not end a sentence, and these run on into each other.
export const sentence = text => {
  const trimmed = String(text ?? '').trim()
  return !trimmed || /[。！？.!?]$/.test(trimmed) ? trimmed : `${trimmed}。`
}

// A list that is closed by whoever puts it into a sentence.
export const unended = text => String(text ?? '').trim().replace(/[。.！!；;，,、\s]+$/, '')

// What each prop is called, by its id. An id is for the code; what a picture is made from has to say what the thing is.
export const propNamesOf = project => new Map((project.scenes ?? []).flatMap(scene => [...(scene.props ?? []), ...(scene.carried ?? [])]).map(prop => [prop.id, prop.name]))

// A model told what is in hand by id writes the id into the shot: "指尖夹着cherry_wood_pipe" went to the video model.
// Longest first, so one id inside another is not cut in two, and only as a word of its own.
export const namedProps = (text, names) => [...names].filter(([id, name]) => id.length >= 3 && name).sort(([one], [other]) => other.length - one.length)
  .reduce((said, [id, name]) => said.replace(new RegExp(`(?<![A-Za-z0-9_])${id.replace(/[^A-Za-z0-9_]/g, '')}(?![A-Za-z0-9_])`, 'g'), name), String(text ?? ''))

// The lines are handed to the shot by themselves. Copied into what the shot shows as well, they are asked for twice, of a
// model told to say each once.
const COPIED = 4 // Characters. Shorter than this, the words can be in a sentence for their own reasons.
export const copiesLines = (face, lines = []) => lines.some(line => line.says.length >= COPIED && String(face ?? '').includes(line.says))
export const withoutLines = (face, lines = []) => lines.reduce((said, line) => (line.says.length >= COPIED ? said.replaceAll(line.says, '') : said), String(face ?? ''))
  .replace(/[“"「]\s*[”"」]/g, '').replace(/[\s，,、：:“”"「」]+([。！？.!?]?)$/, '$1')
