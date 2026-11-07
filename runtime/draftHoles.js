// A draft for the second camera is grey wherever the first camera could not see. A big grey area is a wall still to
// paint. A small one is only the shape of something that stood in the way, a lamp or a table's edge, and a model
// handed that shape paints it as a thing: a second lamp, a stripe down a bookcase. Those are filled in from around.
// No rendering in here, so it can be checked without a browser.
export function fillSmallHoles(pixels, width, height, isHole, largestHole) {
  const total = width * height
  const hole = new Uint8Array(total)
  for (let i = 0; i < total; i++) hole[i] = isHole(pixels, i * 4) ? 1 : 0

  const seen = new Uint8Array(total)
  const toFill = new Uint8Array(total)
  const stack = []
  const neighbours = at => [at % width > 0 ? at - 1 : -1, at % width < width - 1 ? at + 1 : -1, at >= width ? at - width : -1, at < total - width ? at + width : -1]
  for (let start = 0; start < total; start++) {
    if (!hole[start] || seen[start]) continue
    const members = []
    seen[start] = 1
    stack.push(start)
    while (stack.length) {
      const at = stack.pop()
      members.push(at)
      for (const next of neighbours(at)) {
        if (next >= 0 && hole[next] && !seen[next]) {
          seen[next] = 1
          stack.push(next)
        }
      }
    }
    if (members.length <= largestHole) for (const at of members) toFill[at] = 1
  }

  // Inward from the edge, a ring at a time, each pixel taking the average of what is already known next to it.
  let ring = []
  for (let at = 0; at < total; at++) if (toFill[at] && neighbours(at).some(next => next >= 0 && !toFill[next] && !hole[next])) ring.push(at)
  let filled = 0
  while (ring.length) {
    const sums = ring.map(at => {
      const sum = [0, 0, 0, 0]
      for (const next of neighbours(at)) {
        if (next < 0 || toFill[next] || hole[next]) continue
        for (let channel = 0; channel < 3; channel++) sum[channel] += pixels[next * 4 + channel]
        sum[3]++
      }
      return sum
    })
    ring.forEach((at, index) => {
      const [red, green, blue, count] = sums[index]
      pixels[at * 4] = red / count
      pixels[at * 4 + 1] = green / count
      pixels[at * 4 + 2] = blue / count
      toFill[at] = 0
      hole[at] = 0
      filled++
    })
    const next = new Set()
    for (const at of ring) for (const around of neighbours(at)) if (around >= 0 && toFill[around]) next.add(around)
    ring = [...next]
  }
  return filled
}
