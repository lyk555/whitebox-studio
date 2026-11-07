// The sound of walking around, between the videos, which carry their own. Made on the spot, so it
// needs no files and no model. A browser only allows sound after the player has done something, so
// nothing is created until start().
const ROOM_LEVEL = 0.05
const STEP_LEVEL = 0.28

export function createStepCounter() {
  let walked = 0
  return {
    // How many footfalls this much walking comes to.
    advance(distance, stepMeters) {
      walked += distance
      const steps = Math.floor(walked / stepMeters)
      walked -= steps * stepMeters
      return steps
    },
  }
}

function noiseBuffer(context, seconds) {
  const buffer = context.createBuffer(1, Math.round(context.sampleRate * seconds), context.sampleRate)
  const data = buffer.getChannelData(0)
  let last = 0
  // Each sample leans on the one before, which gives a low rumble instead of a hiss.
  for (let i = 0; i < data.length; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02
    data[i] = last * 3.5
  }
  return buffer
}

export function createSound() {
  let context = null
  let roomGain = null
  let stepNoise = null
  let stepsPlayed = 0
  return {
    get state() { return { audio: context?.state ?? 'none', stepsPlayed } },
    start() {
      if (context) {
        context.resume()
        return
      }
      context = new AudioContext()
      roomGain = context.createGain()
      roomGain.gain.value = ROOM_LEVEL
      roomGain.connect(context.destination)
      const room = context.createBufferSource()
      room.buffer = noiseBuffer(context, 6)
      room.loop = true
      const roomFilter = context.createBiquadFilter()
      roomFilter.type = 'lowpass'
      roomFilter.frequency.value = 500
      room.connect(roomFilter).connect(roomGain)
      room.start()
      stepNoise = noiseBuffer(context, 1)
    },
    // The room keeps sounding under the videos, which are mostly silent between their few sounds.
    fadeRoom(level, seconds = 0.3) {
      if (!context) return
      roomGain.gain.cancelScheduledValues(context.currentTime)
      roomGain.gain.setTargetAtTime(level * ROOM_LEVEL, context.currentTime, seconds / 3)
    },
    footstep() {
      if (!context) return
      stepsPlayed++
      const now = context.currentTime
      const level = STEP_LEVEL * (0.8 + Math.random() * 0.4)
      const envelope = context.createGain()
      envelope.gain.setValueAtTime(level, now)
      envelope.gain.exponentialRampToValueAtTime(0.001, now + 0.16)
      envelope.connect(context.destination)
      const scuff = context.createBufferSource()
      scuff.buffer = stepNoise
      const filter = context.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.value = 700 + Math.random() * 300
      scuff.connect(filter).connect(envelope)
      scuff.start(now, Math.random() * 0.8, 0.18)
      const thump = context.createOscillator()
      thump.frequency.setValueAtTime(110, now)
      thump.frequency.exponentialRampToValueAtTime(55, now + 0.1)
      thump.connect(envelope)
      thump.start(now)
      thump.stop(now + 0.14)
    },
  }
}
