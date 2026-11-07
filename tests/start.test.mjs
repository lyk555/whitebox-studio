// Double-clicking start.bat is how this is opened, and nothing else would notice it breaking.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('start.bat stays plain ASCII with CRLF, or Windows loses its place in it and runs half a line as a command', () => {
  const bytes = readFileSync(new URL('../start.bat', import.meta.url))
  assert.ok(bytes.every(byte => byte < 128), 'start.bat has a byte that is not ASCII')
  const lineFeeds = bytes.filter(byte => byte === 10).length
  const returns = bytes.filter((byte, index) => byte === 10 && bytes[index - 1] === 13).length
  assert.equal(returns, lineFeeds, 'start.bat has a line that does not end in CRLF')
})
