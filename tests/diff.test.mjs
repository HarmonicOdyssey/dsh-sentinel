import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyScan, diffNames, diffScans } from '../lib/diff.js'

function scan(overrides = {}) {
  return {
    package: 'pkg',
    version: '1.0.0',
    dir: '/tmp/pkg',
    events: [],
    dynamic: [],
    files: ['index.js'],
    errors: [],
    ...overrides,
  }
}

function listener(name, mode = 'on') {
  return { name, mode, file: 'index.js', line: 1 }
}

test('diffNames reports removed names when the sets do not overlap', () => {
  const catalog = new Set(['session/event', 'tools/pre-execute'])
  const diff = diffNames(['deleted/event', 'session/event'], catalog)
  assert.deepEqual(diff.removed, ['deleted/event'])
  assert.deepEqual(diff.present, ['session/event'])
})

test('diffNames handles empty, fully overlapping, and fully disjoint inputs', () => {
  const catalog = new Set(['a', 'b'])

  assert.deepEqual(diffNames([], catalog), { removed: [], present: [] })
  assert.deepEqual(diffNames(['a', 'b'], catalog), { removed: [], present: ['a', 'b'] })
  assert.deepEqual(diffNames(['x', 'y'], catalog), {
    removed: ['x', 'y'],
    present: [],
  })
  assert.deepEqual(diffNames(['x', 'x'], catalog), {
    removed: ['x'],
    present: [],
  })
})

test('classifyScan marks a package damaged only for missing literal events', () => {
  const catalog = new Set(['a', 'b'])
  const result = classifyScan(
    scan({ events: [listener('a'), listener('gone', 'waterfall')] }),
    catalog,
  )
  assert.equal(result.status, 'damaged')
  assert.deepEqual(result.missing, ['gone'])
})

test('classifyScan marks a package healthy when every literal event exists', () => {
  const result = classifyScan(scan({ events: [listener('a'), listener('b')] }), new Set(['a', 'b']))
  assert.deepEqual(result, { status: 'healthy', events: ['a', 'b'], dynamic_count: 0 })
})

test('classifyScan returns unknown for no listeners and for dynamic-only listeners', () => {
  const catalog = new Set(['a'])

  assert.deepEqual(classifyScan(scan(), catalog), {
    status: 'unknown',
    reason: 'no_event_listeners',
  })
  assert.deepEqual(
    classifyScan(scan({ dynamic: [{ mode: 'on', file: 'index.js', line: 3 }] }), catalog),
    { status: 'unknown', reason: 'no_literal_event_names' },
  )
})

test('classifyScan returns source_unreadable when the scanner reported errors', () => {
  assert.deepEqual(classifyScan(scan({ errors: ['boom'] }), new Set(['a'])), {
    status: 'unknown',
    reason: 'source_unreadable',
  })
})

test('diffScans keeps the three groups stable and sorted', () => {
  const catalog = new Set(['a'])
  const result = diffScans(
    [
      scan({ package: 'z-damaged', events: [listener('gone')] }),
      scan({ package: 'a-healthy', events: [listener('a')] }),
      scan({ package: 'm-unknown', events: [] }),
    ],
    catalog,
  )
  assert.deepEqual(result.damaged, [
    { package: 'z-damaged', version: '1.0.0', events: ['gone'], reason: 'event_not_in_catalog' },
  ])
  assert.deepEqual(result.unknown, [
    { package: 'm-unknown', version: '1.0.0', reason: 'no_event_listeners' },
  ])
  assert.deepEqual(result.healthy, [
    { package: 'a-healthy', version: '1.0.0', events: ['a'], dynamic_count: 0 },
  ])
})
