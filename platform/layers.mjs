// A finished picture split by the image model into one cut-out per thing, laid out as the flat-coloured matte the
// rest of the studio reads. Asked to paint that matte itself, a cheaper model draws a new picture with a different
// composition. Splitting keeps every pixel where it was: laid back on the base, the cut-outs give the picture again.
import { OBJECT_COLOURS } from '../runtime/objectColours.js'

const GREEN = [0, 255, 0]
const SOLID = 128 // A cut-out pixel at least this opaque belongs to its thing.

// Which thing a cut-out is, by the name it was given. The model is told to use the labels as names, and sometimes
// adds to them ("橡木书桌（连同桌上的煤气灯）"), so the longest label inside the name wins.
export function thingOfLayer(name, labels) {
  const said = String(name ?? '').trim()
  const exact = labels.indexOf(said)
  if (exact >= 0) return exact
  let best = -1
  labels.forEach((label, index) => {
    if (said.includes(label) && (best < 0 || label.length > labels[best].length)) best = index
  })
  return best
}

// What sort of thing a label names, without where it stands or its number: "门洞旁的废弃木箱堆" and "废弃木箱堆" are one
// sort, as are "散落空煤麻袋1" and "散落空煤麻袋2".
export const kindOf = label => String(label).replace(/\d+$/, '').split('的').at(-1)

// Things of one sort look alike, so a name like "墙边的" is all the model has to tell them apart, and it gets that wrong.
// Where each one stands is what tells them apart, so among them each cut-out goes to the place nearest it. Things of
// different sorts keep their names, so one painted where another belongs is still caught.
export function sortOutAlike(layers, labels, places) {
  const placeOf = new Map(places.map(place => [place.index, place]))
  const middle = ({ box: [left, top, right, bottom] }) => [(left + right) / 2, (top + bottom) / 2]
  const kinds = new Map()
  for (const layer of layers) {
    if (!placeOf.has(layer.index)) continue
    const kind = kindOf(labels[layer.index])
    kinds.set(kind, [...(kinds.get(kind) ?? []), layer])
  }
  for (const [kind, group] of kinds) {
    // Every thing of this sort, also one no cut-out was named for: two cut-outs can come back with the same name.
    const alike = places.filter(place => kindOf(labels[place.index]) === kind).map(place => place.index)
    if (alike.length < 2 || group.length > alike.length) continue
    const cost = order => order.reduce((sum, index, at) => {
      const [x, y] = middle(group[at])
      return sum + Math.hypot(x - placeOf.get(index).x, y - placeOf.get(index).y)
    }, 0)
    let best = null
    for (const order of arrangements(alike, group.length)) if (!best || cost(order) < cost(best)) best = order
    group.forEach((layer, at) => { layer.index = best[at] })
  }
  return layers
}

// Every way of choosing count of the items in order.
function* arrangements(items, count) {
  if (count === 0) { yield []; return }
  for (let at = 0; at < items.length; at++) {
    for (const rest of arrangements([...items.slice(0, at), ...items.slice(at + 1)], count - 1)) yield [items[at], ...rest]
  }
}

// layers: [{ index, z, box: [left, top, right, bottom] in this picture's pixels, pixels: RGBA at the box's size }].
// Nearer cut-outs are laid over farther ones, as in the picture. Whatever no cut-out covers is green.
export function matteFromLayers(layers, width, height) {
  const out = new Uint8ClampedArray(width * height * 4)
  for (let at = 0; at < out.length; at += 4) out.set([...GREEN, 255], at)
  for (const layer of [...layers].sort((a, b) => a.z - b.z)) {
    const colour = OBJECT_COLOURS[layer.index]?.rgb
    if (!colour) continue
    const [left, top, right, bottom] = layer.box
    const wide = right - left
    for (let y = Math.max(0, top); y < Math.min(height, bottom); y++) {
      for (let x = Math.max(0, left); x < Math.min(width, right); x++) {
        if (layer.pixels[((y - top) * wide + (x - left)) * 4 + 3] < SOLID) continue
        out.set(colour, (y * width + x) * 4)
      }
    }
  }
  return out
}
