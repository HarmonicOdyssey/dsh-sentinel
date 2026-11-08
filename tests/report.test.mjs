import assert from 'node:assert/strict'
import test from 'node:test'

import { emptyCatalog } from '../lib/catalog.js'
import {
  buildReport,
  engineStatusText,
  renderReportJson,
  renderReportText,
  unknownReasonText,
} from '../lib/report.js'

function catalog(events = ['session/event']) {
  return {
    available: true,
    entries: events.map((name) => ({ name, mode: 'emit' })),
    names: new Set(events),
    source: 'builtin_snapshot',
    versionHint: '0.2.2-rc.1',
    generatedAt: '2026-11-07T00:00:00.000Z',
    file: '/tmp/catalog.json',
    warnings: [],
    error: null,
  }
}

function scan(overrides = {}) {
  return {
    package: 'some-plugin',
    version: '1.2.0',
    dir: '/tmp/some-plugin',
    events: [{ name: 'gone/event', mode: 'on', file: 'index.js', line: 1 }],
    dynamic: [],
    files: ['index.js'],
    errors: [],
    ...overrides,
  }
}

test('buildReport produces the documented JSON shape', () => {
  const report = buildReport({
    catalog: catalog(),
    scans: [scan()],
    engineStatus: 'normal',
    engineReason: '',
    degradations: [],
    now: () => new Date('2026-11-07T10:00:00.000Z'),
  })

  assert.deepEqual(Object.keys(report).sort(), [
    'catalog_generated_at',
    'catalog_source',
    'catalog_version_hint',
    'damaged',
    'degradations',
    'engine_reason',
    'engine_status',
    'generated_at',
    'healthy_count',
    'scan_errors',
    'scanned_packages',
    'unknown',
  ])
  assert.equal(report.generated_at, '2026-11-07T10:00:00.000Z')
  assert.equal(report.catalog_source, 'builtin_snapshot')
  assert.equal(report.engine_status, 'normal')
  assert.deepEqual(report.damaged, [
    {
      package: 'some-plugin',
      version: '1.2.0',
      events: ['gone/event'],
      reason: 'event_not_in_catalog',
    },
  ])
  assert.equal(report.healthy_count, 0)
  assert.equal(report.scanned_packages, 1)
})

test('buildReport omits damaged conclusions when the catalog is unavailable', () => {
  const report = buildReport({
    catalog: emptyCatalog('词表文件不可读'),
    scans: [scan()],
    engineStatus: 'normal',
    engineReason: '',
    degradations: ['catalog_load_failed'],
    now: () => new Date('2026-11-07T10:00:00.000Z'),
  })
  assert.equal(report.engine_status, 'catalog_unavailable')
  assert.match(report.engine_reason, /词表文件不可读/)
  assert.deepEqual(report.damaged, [])
  assert.deepEqual(report.unknown, [])
  assert.equal(report.healthy_count, 0)
})

test('renderReportText puts damaged first and includes a suggestion and source', () => {
  const report = buildReport({
    catalog: catalog(),
    scans: [scan()],
    engineStatus: 'normal',
    engineReason: '',
    degradations: [],
    now: () => new Date('2026-11-07T10:00:00.000Z'),
  })
  const text = renderReportText(report)
  assert.match(text, /插件健康总览/)
  assert.match(text, /● 确定性损坏 \(1\)/)
  assert.match(text, /some-plugin@1\.2\.0/)
  assert.match(text, /监听 gone\/event，但当前版本词表中不存在/)
  assert.match(text, /建议：检查该插件是否有新版本/)
  assert.match(text, /○ 体检引擎状态：正常/)
  assert.match(text, /词表来源：内置快照（0\.2\.2-rc\.1，可能滞后于当前 DSH 版本）/)
})

test('renderReportJson is valid JSON of the same report', () => {
  const report = buildReport({
    catalog: catalog(),
    scans: [scan({ events: [], errors: [], files: [] })],
    engineStatus: 'scan_partial',
    engineReason: '1 个包不可读',
    degradations: ['scan_failed'],
    now: () => new Date('2026-11-07T10:00:00.000Z'),
  })
  const parsed = JSON.parse(renderReportJson(report))
  assert.equal(parsed.engine_status, 'scan_partial')
  assert.equal(parsed.unknown.length, 1)
})

test('status and reason labels are exhaustive', () => {
  assert.equal(engineStatusText('catalog_unavailable'), '词表不可用')
  assert.equal(engineStatusText('self_check_failed'), '自检失败')
  assert.match(unknownReasonText('no_literal_event_names'), /无法静态确定/)
})
