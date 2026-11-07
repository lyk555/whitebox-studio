// A rough model the text model describes as parts. It chooses what the thing looks like; this sets the numbers
// straight, so every shape ends up centred, on the floor, and in one piece. What cannot be set straight, such
// as something bigger than the room allows, is refused with the reason.
const MAX_PARTS = 16
const MIN_PART = 0.02
const STANDING_LIMIT = { width: 3.2, height: 5, depth: 3.2 }
const ON_TOP_LIMIT = { width: 1.2, height: 1.2, depth: 1.2 }
const TOUCHING = 0.03 // Metres. Parts closer than this count as joined.

const number = (value, what) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${what} 不是数字。`)
  return parsed
}
const atOf = (part, label) => {
  if (!Array.isArray(part.at) || part.at.length !== 3) throw new Error(`${label}的 at 要写成 [x, y, z]。`)
  return part.at.map((value, index) => number(value, `${label}的 at[${index}]`))
}
const positive = (value, what) => {
  const parsed = number(value, what)
  if (parsed < MIN_PART) throw new Error(`${what} 太小了，至少 ${MIN_PART} 米。`)
  return parsed
}

function readPart(part, label) {
  const at = atOf(part, label)
  if (part.shape === 'box') {
    if (!Array.isArray(part.size) || part.size.length !== 3) throw new Error(`${label}是 box，size 要写成 [宽, 高, 深]。`)
    return { shape: 'box', at, size: part.size.map((value, index) => positive(value, `${label}的 size[${index}]`)) }
  }
  if (part.shape === 'round') {
    return { shape: 'round', at, radiusTop: positive(part.radius_top ?? part.radiusTop, `${label}的 radius_top`), radiusBottom: positive(part.radius_bottom ?? part.radiusBottom, `${label}的 radius_bottom`), height: positive(part.height, `${label}的 height`) }
  }
  if (part.shape === 'dome') {
    return { shape: 'dome', at, radius: positive(part.radius, `${label}的 radius`), length: positive(part.length, `${label}的 length`) }
  }
  throw new Error(`${label}的 shape “${part.shape}”不存在，只能是 box、round 或 dome。`)
}

// The box each part takes up. A dome's "at" is the middle of its flat underside, and it lies along x.
function boundsOf({ shape, at: [x, y, z], size, radiusTop, radiusBottom, height, radius, length }) {
  if (shape === 'box') return { low: [x - size[0] / 2, y - size[1] / 2, z - size[2] / 2], high: [x + size[0] / 2, y + size[1] / 2, z + size[2] / 2] }
  if (shape === 'round') {
    const reach = Math.max(radiusTop, radiusBottom)
    return { low: [x - reach, y - height / 2, z - reach], high: [x + reach, y + height / 2, z + reach] }
  }
  return { low: [x - length / 2, y, z - radius], high: [x + length / 2, y + radius, z + radius] }
}

const touching = (a, b) => [0, 1, 2].every(axis => a.low[axis] <= b.high[axis] + TOUCHING && b.low[axis] <= a.high[axis] + TOUCHING)

// How far b has to move, axis by axis, to touch a. Zero on an axis where they already overlap.
const gapTo = (a, b) => [0, 1, 2].map(axis => (b.low[axis] > a.high[axis] ? a.high[axis] - b.low[axis] : b.high[axis] < a.low[axis] ? a.low[axis] - b.high[axis] : 0))
const gapSize = gap => Math.hypot(...gap)

// Models are loose with coordinates: a lampshade 2 cm off its stem is what they meant as joined. So each part
// that floats free is slid onto whatever it is closest to, nearest first, and the thing comes out in one piece.
function joinParts(parts) {
  const bounds = parts.map(boundsOf)
  const joined = new Set([0])
  const grow = () => {
    for (let changed = true; changed;) {
      changed = false
      bounds.forEach((box, index) => {
        if (joined.has(index) || ![...joined].some(other => touching(bounds[other], box))) return
        joined.add(index)
        changed = true
      })
    }
  }
  grow()
  while (joined.size < parts.length) {
    let nearest = null
    bounds.forEach((box, index) => {
      if (joined.has(index)) return
      for (const other of joined) {
        const gap = gapTo(bounds[other], box)
        if (!nearest || gapSize(gap) < gapSize(nearest.gap)) nearest = { index, gap }
      }
    })
    const part = parts[nearest.index]
    part.at = part.at.map((value, axis) => value + nearest.gap[axis])
    bounds[nearest.index] = boundsOf(part)
    joined.add(nearest.index)
    grow()
  }
}

const tidy = value => Number(value.toFixed(3))

export function shapeFromParts(rawParts, { name = '物件', onTop = false } = {}) {
  if (!Array.isArray(rawParts) || !rawParts.length) throw new Error(`“${name}”没有 parts。`)
  if (rawParts.length > MAX_PARTS) throw new Error(`“${name}”有 ${rawParts.length} 个零件，粗模最多 ${MAX_PARTS} 个，把细节留给画面。`)
  const parts = rawParts.map((part, index) => readPart(part, `“${name}”的第 ${index + 1} 个零件`))
  joinParts(parts)
  const bounds = parts.map(boundsOf)
  const low = [0, 1, 2].map(axis => Math.min(...bounds.map(box => box.low[axis])))
  const high = [0, 1, 2].map(axis => Math.max(...bounds.map(box => box.high[axis])))
  const [width, height, depth] = [0, 1, 2].map(axis => tidy(high[axis] - low[axis]))
  const limit = onTop ? ON_TOP_LIMIT : STANDING_LIMIT
  if (width > limit.width || height > limit.height || depth > limit.depth) {
    throw new Error(`“${name}”有 ${width}×${height}×${depth} 米，${onTop ? '放在别的东西上面的' : '立在地上的'}物件最大 ${limit.width}×${limit.height}×${limit.depth} 米。`)
  }
  const shift = [-(low[0] + high[0]) / 2, -low[1], -(low[2] + high[2]) / 2]
  return {
    size: [width, height, depth],
    onTop,
    parts: parts.map(part => {
      const moved = { ...part, at: part.at.map((value, axis) => tidy(value + shift[axis])) }
      for (const key of ['radiusTop', 'radiusBottom', 'height', 'radius', 'length']) if (key in moved) moved[key] = tidy(moved[key])
      if (moved.size) moved.size = moved.size.map(tidy)
      return moved
    }),
  }
}

// How the model is told to build one, in the words it is checked by.
export const PART_RULES = `每件东西用几何零件拼成粗模，parts 里每个零件是下面三种之一，单位是米：
- 方块：{ "shape": "box", "at": [x, y, z], "size": [宽, 高, 深] }，at 是方块的中心
- 圆柱或圆台：{ "shape": "round", "at": [x, y, z], "radius_top": 0.2, "radius_bottom": 0.3, "height": 1 }，at 是中心，只能竖着立
- 半圆拱：{ "shape": "dome", "at": [x, y, z], "radius": 0.4, "length": 1.2 }，at 是平的底面的中心，长边沿左右方向，圆的一面朝上
坐标：x 向右，y 向上，z 朝向镜头。物件不能旋转，所以它的正面朝 z 的正方向。
粗模只要抓住大形和比例：桌子是桌面加四条腿，打字机是底座加斜面加滚筒。每件 1 到 ${MAX_PARTS} 个零件，所有零件连成一个整体，从地面立起来，不要做吊在天花板上或挂在墙上的东西。零件之间的缝隙里能看到后面的东西，所以桌腿之间要真的留空。立在地上的物件最大 ${STANDING_LIMIT.width}×${STANDING_LIMIT.height}×${STANDING_LIMIT.depth} 米，放在别的东西上面的最大 ${ON_TOP_LIMIT.width}×${ON_TOP_LIMIT.height}×${ON_TOP_LIMIT.depth} 米，尺寸按现实比例，一个人大约 1.75 米高。`
