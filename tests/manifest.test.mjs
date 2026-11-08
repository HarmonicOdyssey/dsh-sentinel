import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { createSentinel, readInstalledPackages } from '../lib/index.js'
import {
  SAMPLE_EVENTS,
  makeProfile,
  removeDir,
  tempDir,
  waitFor,
  writeCatalog,
  writeJson,
  writeText,
} from './helpers.mjs'

function setDependencies(profile, dependencies) {
  writeJson(path.join(profile, 'package.json'), {
    name: 'dsh-profile-test',
    private: true,
    dependencies,
  })
}

test('the manifest snapshot compares real installed versions, not range specs', () => {
  const profile = makeProfile({
    alpha: { version: '1.2.3' },
    '@scope/beta': { version: '0.4.0' },
  })
  try {
    const packages = readInstalledPackages(profile)
    assert.equal(packages.get('alpha').version, '1.2.3')
    assert.equal(packages.get('@scope/beta').version, '0.4.0')
    assert.equal(packages.size, 2)
  } finally {
    removeDir(profile)
  }
})

test('start detects damaged plugins, and a manifest change removes them without a restart', async () => {
  const dir = tempDir()
  const profile = makeProfile({
    'broken-plugin': {
      version: '1.0.0',
      source: "ctx.on('deleted/event', () => {})\n",
    },
    'healthy-plugin': {
      version: '2.0.0',
      source: "ctx.on('session/event', () => {})\n",
    },
  })
  const catalogFile = path.join(dir, 'catalog.md')
  writeCatalog(catalogFile, SAMPLE_EVENTS)

  const sentinel = createSentinel({
    profileDir: profile,
    snapshotPath: path.join(dir, 'snapshot.json'),
    catalogCandidates: [catalogFile],
  })

  try {
    await sentinel.start()
    let report = sentinel.report()
    assert.equal(report.engine_status, 'normal')
    assert.deepEqual(
      report.damaged.map((entry) => [entry.package, entry.events]),
      [['broken-plugin', ['deleted/event']]],
    )
    assert.equal(report.healthy_count, 1)

    // Uninstall: only the manifest and the installed files change.
    setDependencies(profile, { 'healthy-plugin': '^2.0.0' })
    removeDir(path.join(profile, 'node_modules', 'broken-plugin'))
    await sentinel.handleManifestChange()

    report = sentinel.report()
    assert.deepEqual(report.damaged, [])
    assert.equal(report.healthy_count, 1)
    assert.equal(report.scanned_packages, 1)
  } finally {
    sentinel.dispose()
    removeDir(profile)
    removeDir(dir)
  }
})

test('an upgrade rescans only the changed package and reflects the new version', async () => {
  const dir = tempDir()
  const profile = makeProfile({
    'upgraded-plugin': {
      version: '1.0.0',
      source: "ctx.on('deleted/event', () => {})\n",
    },
  })
  const catalogFile = path.join(dir, 'catalog.md')
  writeCatalog(catalogFile, SAMPLE_EVENTS)

  const sentinel = createSentinel({
    profileDir: profile,
    snapshotPath: path.join(dir, 'snapshot.json'),
    catalogCandidates: [catalogFile],
  })

  try {
    await sentinel.start()
    assert.deepEqual(sentinel.report().damaged, [
      {
        package: 'upgraded-plugin',
        version: '1.0.0',
        events: ['deleted/event'],
        reason: 'event_not_in_catalog',
      },
    ])

    // Same dependency range, new installed version and fixed source.
    const packageDir = path.join(profile, 'node_modules', 'upgraded-plugin')
    writeJson(path.join(packageDir, 'package.json'), {
      name: 'upgraded-plugin',
      version: '2.0.0',
      type: 'module',
      main: './index.js',
    })
    writeText(path.join(packageDir, 'index.js'), "ctx.on('session/event', () => {})\n")

    await sentinel.handleManifestChange()
    const report = sentinel.report()
    assert.deepEqual(report.damaged, [])
    assert.equal(report.healthy_count, 1)
    assert.equal(report.scanned_packages, 1)
  } finally {
    sentinel.dispose()
    removeDir(profile)
    removeDir(dir)
  }
})

test('the debounced watcher path applies a manifest change', async () => {
  const dir = tempDir()
  const profile = makeProfile({
    'first-plugin': {
      version: '1.0.0',
      source: "ctx.on('session/event', () => {})\n",
    },
  })
  const catalogFile = path.join(dir, 'catalog.md')
  writeCatalog(catalogFile, SAMPLE_EVENTS)

  const sentinel = createSentinel({
    profileDir: profile,
    snapshotPath: path.join(dir, 'snapshot.json'),
    catalogCandidates: [catalogFile],
    debounceMs: 30,
  })

  try {
    await sentinel.start()
    assert.equal(sentinel.report().damaged.length, 0)

    // Simulate `dsh plugin add`: manifest + node_modules change together.
    setDependencies(profile, { 'first-plugin': '^1.0.0', 'second-plugin': '^0.1.0' })
    const secondDir = path.join(profile, 'node_modules', 'second-plugin')
    writeJson(path.join(secondDir, 'package.json'), {
      name: 'second-plugin',
      version: '0.1.0',
      type: 'module',
      main: './index.js',
    })
    writeText(path.join(secondDir, 'index.js'), "ctx.on('deleted/event', () => {})\n")

    sentinel.scheduleManifestChange()
    const becameDamaged = await waitFor(() => sentinel.report().damaged.length === 1, 3000)
    assert.equal(becameDamaged, true)
    assert.equal(sentinel.report().damaged[0].package, 'second-plugin')
  } finally {
    sentinel.dispose()
    removeDir(profile)
    removeDir(dir)
  }
})

test('a package with an unreadable entry is unknown and makes the run scan_partial', async () => {
  const dir = tempDir()
  const profile = makeProfile({
    'broken-entry': { version: '1.0.0' },
    'healthy-plugin': {
      version: '1.0.0',
      source: "ctx.on('session/event', () => {})\n",
    },
  })
  const catalogFile = path.join(dir, 'catalog.md')
  writeCatalog(catalogFile, SAMPLE_EVENTS)

  const sentinel = createSentinel({
    profileDir: profile,
    snapshotPath: path.join(dir, 'snapshot.json'),
    catalogCandidates: [catalogFile],
  })

  try {
    await sentinel.start()
    const report = sentinel.report()
    assert.equal(report.engine_status, 'scan_partial')
    assert.deepEqual(
      report.unknown.map((entry) => [entry.package, entry.reason]),
      [['broken-entry', 'source_unreadable']],
    )
    assert.equal(report.healthy_count, 1)
  } finally {
    sentinel.dispose()
    removeDir(profile)
    removeDir(dir)
  }
})
