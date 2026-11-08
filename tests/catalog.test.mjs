import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  CatalogFormatError,
  loadCatalog,
  parseCatalogMarkdown,
  parseSnapshot,
  readVersionHint,
} from '../lib/catalog.js'
import { SAMPLE_EVENTS, removeDir, tempDir, writeCatalog, writeJson, writeText } from './helpers.mjs'

test('parseCatalogMarkdown extracts names and dispatch modes from a Markdown table', () => {
  const entries = parseCatalogMarkdown(
    [
      '# Events',
      '',
      '| Event | Mode | Description |',
      '| --- | --- | --- |',
      '| `session/event` | `emit` | one event |',
      '| **tools/pre-execute** | **waterfall** | gate |',
      '| agent/pre-step | parallel | step |',
      '',
    ].join('\n'),
  )
  assert.deepEqual(entries, [
    { name: 'agent/pre-step', mode: 'parallel' },
    { name: 'session/event', mode: 'emit' },
    { name: 'tools/pre-execute', mode: 'waterfall' },
  ])
})

test('parseCatalogMarkdown accepts an `event:` prefix and name/mode headers', () => {
  const entries = parseCatalogMarkdown(
    ['| Name | Dispatch |', '| --- | --- |', '| event:session/event | emit |', ''].join('\n'),
  )
  assert.deepEqual(entries, [{ name: 'session/event', mode: 'emit' }])
})

test('parseCatalogMarkdown rejects a table without a dispatch-mode column', () => {
  assert.throws(
    () =>
      parseCatalogMarkdown(
        ['| Event | Kind |', '| --- | --- |', '| `event:session/event` | event |', ''].join('\n'),
      ),
    (error) => {
      assert.ok(error instanceof CatalogFormatError)
      assert.match(error.message, /分发模式列/)
      return true
    },
  )
})

test('parseCatalogMarkdown rejects a file with no event table instead of returning an empty set', () => {
  assert.throws(
    () => parseCatalogMarkdown('# Nothing here\n\nno table\n'),
    /未找到事件表/,
  )
})

test('parseCatalogMarkdown rejects an empty mode cell', () => {
  assert.throws(
    () => parseCatalogMarkdown(['| Event | Mode |', '| --- | --- |', '| a |  |', ''].join('\n')),
    /没有可用的分发模式/,
  )
})

test('readVersionHint finds a semver in the catalog head', () => {
  assert.equal(readVersionHint('<!-- dsh 0.2.2-rc.1 -->\n| Event | Mode |'), '0.2.2-rc.1')
  assert.equal(readVersionHint('no version here'), 'unknown')
})

test('loadCatalog prefers a valid persistence catalog over the snapshot', () => {
  const dir = tempDir()
  try {
    const catalogFile = path.join(dir, 'docs', 'persistence-catalog.md')
    writeCatalog(catalogFile, SAMPLE_EVENTS, '<!-- dsh 9.9.9 -->\n')
    const snapshotPath = path.join(dir, 'snapshot.json')
    writeJson(snapshotPath, {
      dsh_version: '1.0.0',
      events: [{ name: 'snapshot/only', mode: 'emit' }],
    })

    const catalog = loadCatalog({ candidates: [catalogFile], snapshotPath })
    assert.equal(catalog.available, true)
    assert.equal(catalog.source, 'persistence-catalog.md')
    assert.equal(catalog.versionHint, '9.9.9')
    assert.ok(catalog.names.has('session/event'))
    assert.equal(catalog.names.has('snapshot/only'), false)
  } finally {
    removeDir(dir)
  }
})

test('loadCatalog falls back to the snapshot when the Markdown catalog is incompatible', () => {
  const dir = tempDir()
  try {
    const catalogFile = path.join(dir, 'persistence-catalog.md')
    writeText(
      catalogFile,
      ['| Root | Kind |', '| --- | --- |', '| `event:session/title` | event |', ''].join('\n'),
    )
    const snapshotPath = path.join(dir, 'snapshot.json')
    writeJson(snapshotPath, {
      dsh_version: '0.2.2-rc.1',
      generated_at: '2026-11-07T00:00:00.000Z',
      events: [{ name: 'session/event', mode: 'emit' }],
    })

    const catalog = loadCatalog({ candidates: [catalogFile], snapshotPath })
    assert.equal(catalog.available, true)
    assert.equal(catalog.source, 'builtin_snapshot')
    assert.equal(catalog.versionHint, '0.2.2-rc.1')
    assert.equal(catalog.generatedAt, '2026-11-07T00:00:00.000Z')
    assert.equal(catalog.warnings.length, 1)
    assert.match(catalog.warnings[0], /跳过/)
  } finally {
    removeDir(dir)
  }
})

test('loadCatalog reports catalog_unavailable when neither source is usable', () => {
  const dir = tempDir()
  try {
    const catalog = loadCatalog({
      candidates: [path.join(dir, 'missing.md')],
      snapshotPath: path.join(dir, 'missing.json'),
    })
    assert.equal(catalog.available, false)
    assert.match(catalog.error, /不可用/)
    assert.deepEqual(catalog.entries, [])
    assert.equal(catalog.names.size, 0)
  } finally {
    removeDir(dir)
  }
})

test('parseSnapshot rejects malformed or empty snapshots', () => {
  assert.throws(() => parseSnapshot('not json'), /不是合法 JSON/)
  assert.throws(() => parseSnapshot('{}'), /缺少 events/)
  assert.throws(() => parseSnapshot('{"events":[]}'), /events 为空/)
  assert.throws(
    () => parseSnapshot('{"events":[{"name":"a b","mode":"emit"}]}'),
    /不合法的事件名/,
  )
})
