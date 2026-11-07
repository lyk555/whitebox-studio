// The model never paints an object exactly where its whitebox is. Rather than asking it to, this
// measures the difference from the matte, so the painted object can be fitted onto the whitebox.
// No rendering in here, so it can be checked without a browser.

const IDENTITY = { uScale: 1, vScale: 1, uOffset: 0, vOffset: 0 }
const REACH_SHARE = 0.15 // Of the object's shorter side. Paint further from its whitebox than this is not it.
const MIN_REACH = 16 // Pixels.
// A column needs this share of the fullest column to count, which drops the stub of a skirting board
// left attached to an object. Rows need less, because a table's legs fill only a little of each row.
const COLUMN_SHARE = 0.15
const ROW_SHARE = 0.08

function boundsOf(inside, width, height) {
  let x0 = width
  let y0 = height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!inside(x, y)) continue
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
  }
  return x1 < 0 ? null : [x0, y0, x1, y1]
}

// True for pixels within reach of the whitebox's real outline. A bounding box will not do: a tall
// object running off the frame has a wide one, which takes in things that are nowhere near it.
function nearWhitebox(inWhitebox, width, height, reach) {
  const stride = width + 1
  const sums = new Int32Array(stride * (height + 1))
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      sums[(y + 1) * stride + x + 1] = (inWhitebox(x, y) ? 1 : 0)
        + sums[y * stride + x + 1] + sums[(y + 1) * stride + x] - sums[y * stride + x]
    }
  }
  return (x, y) => {
    const x0 = Math.max(0, x - reach)
    const y0 = Math.max(0, y - reach)
    const x1 = Math.min(width, x + reach + 1)
    const y1 = Math.min(height, y + reach + 1)
    return sums[y1 * stride + x1] - sums[y0 * stride + x1] - sums[y1 * stride + x0] + sums[y0 * stride + x0] > 0
  }
}

// How many painted pixels each column and row holds, in the biggest connected patch of paint that
// overlaps the whitebox's bounds.
function paintProfile(isObject, width, height, box) {
  const seen = new Uint8Array(width * height)
  const queue = new Int32Array(width * height)
  let best = null
  let bestOverlap = 0
  for (let y = box[1]; y <= box[3]; y++) {
    for (let x = box[0]; x <= box[2]; x++) {
      const start = y * width + x
      if (seen[start] || !isObject(x, y)) continue
      seen[start] = 1
      queue[0] = start
      let head = 0
      let tail = 1
      let overlap = 0
      const columns = new Map()
      const rows = new Map()
      while (head < tail) {
        const at = queue[head++]
        const px = at % width
        const py = (at - px) / width
        if (px >= box[0] && px <= box[2] && py >= box[1] && py <= box[3]) overlap++
        columns.set(px, (columns.get(px) || 0) + 1)
        rows.set(py, (rows.get(py) || 0) + 1)
        for (const [nx, ny] of [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]]) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const next = ny * width + nx
          if (seen[next] || !isObject(nx, ny)) continue
          seen[next] = 1
          queue[tail++] = next
        }
      }
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        best = { columns: [...columns.entries()], rows: [...rows.entries()] }
      }
    }
  }
  return best
}

function extent(counts, share) {
  const fullest = Math.max(...counts.map(([, count]) => count))
  const kept = counts.filter(([, count]) => count >= fullest * share).map(([at]) => at)
  return [Math.min(...kept), Math.max(...kept)]
}

// Sampling the plate at uv * scale + offset puts the painted outline exactly over the whitebox's.
// Paint on another object's whitebox belongs to that object, so it is left out.
export function fitToWhitebox({ width, height, inWhitebox, isPainted, isOther = () => false }) {
  const box = boundsOf(inWhitebox, width, height)
  if (!box || box[0] === box[2] || box[1] === box[3]) return IDENTITY
  const reach = Math.round(Math.max(MIN_REACH, Math.min(box[2] - box[0], box[3] - box[1]) * REACH_SHARE))
  const near = nearWhitebox(inWhitebox, width, height, reach)
  const profile = paintProfile((x, y) => isPainted(x, y) && !isOther(x, y) && near(x, y), width, height, box)
  if (!profile) return IDENTITY
  const [x0, x1] = extent(profile.columns, COLUMN_SHARE)
  const [y0, y1] = extent(profile.rows, ROW_SHARE)
  if (x0 === x1 || y0 === y1) return IDENTITY
  const uScale = (x1 - x0) / (box[2] - box[0])
  const vScale = (y1 - y0) / (box[3] - box[1])
  // v runs up the picture while pixel rows run down it, so each is measured from its lower edge.
  return {
    uScale,
    vScale,
    uOffset: x0 / width - (box[0] / width) * uScale,
    vOffset: 1 - y1 / height - (1 - box[3] / height) * vScale,
  }
}

// How well the painted object fills its whitebox outline, from 0 to 1 (shared area over total area).
// Paint that lands on another object's whitebox belongs to that object, so it is left out.
export function silhouetteOverlap({ width, height, inWhitebox, isPainted, isOther }) {
  const box = boundsOf(inWhitebox, width, height)
  if (!box) return null
  const near = nearWhitebox(inWhitebox, width, height, Math.round(Math.max(MIN_REACH, Math.min(box[2] - box[0], box[3] - box[1]) * REACH_SHARE)))
  let shared = 0
  let total = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const whitebox = inWhitebox(x, y)
      const painted = isPainted(x, y) && !isOther(x, y) && near(x, y)
      if (whitebox && painted) shared++
      if (whitebox || painted) total++
    }
  }
  return total ? shared / total : null
}
