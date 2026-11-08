import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const SNAPSHOT = path.resolve('snapshot/catalog.json')
const payload = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'))

test('the bundled snapshot has the documented minimal entry shape', () => {
  assert.equal(typeof payload.dsh_version, 'string')
  assert.ok(Array.isArray(payload.events))
  assert.ok(payload.events.length >= 80, 'a vocabulary this small is likely truncated')
  for (const entry of payload.events) {
    assert.deepEqual(Object.keys(entry).sort(), ['mode', 'name'])
    assert.ok(['emit', 'waterfall', 'parallel', 'serial'].includes(entry.mode))
  }
})

test('the bundled snapshot is sorted and de-duplicated', () => {
  const names = payload.events.map((entry) => entry.name)
  assert.deepEqual(names, [...names].sort((left, right) => left.localeCompare(right)))
  assert.equal(new Set(names).size, names.length)
})

test('the bundled snapshot contains the events the engine examples rely on', () => {
  const names = new Set(payload.events.map((entry) => entry.name))
  for (const required of [
    'webserver/index-inject',
    'tools/pre-execute',
    'agent/pre-step',
    'session/event',
  ]) {
    assert.equal(names.has(required), true, `${required} should be in the snapshot`)
  }
})
