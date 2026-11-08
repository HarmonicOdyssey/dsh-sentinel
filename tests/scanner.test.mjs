import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { collectRelativeImports, extractListeners, scanPackage } from '../lib/scanner.js'
import { makeProfile, removeDir, tempDir, writeText } from './helpers.mjs'

test('extractListeners finds ctx.on and ctx.waterfall literals', () => {
  const source = [
    'export function apply(ctx) {',
    '  ctx.on("session/events", handler)',
    "  ctx.waterfall('agent/pre-step', async (payload, next) => next())",
    '}',
  ].join('\n')

  const result = extractListeners(source, 'index.js')
  assert.deepEqual(
    result.listeners.map((entry) => [entry.name, entry.mode, entry.line]),
    [
      ['session/events', 'on', 2],
      ['agent/pre-step', 'waterfall', 3],
    ],
  )
  assert.deepEqual(result.dynamic, [])
  assert.equal(result.parseError, null)
})

test('extractListeners ignores comments, strings, regexes, and other receivers', () => {
  const source = [
    '// ctx.on("commented/out", handler)',
    '/* ctx.waterfall("also/commented", handler) */',
    'const text = "ctx.on(\'inside/a/string\', handler)"',
    'const pattern = /ctx\\.on\\("inside\\/a\\/regex"/',
    'other.ctx.on("not/our/context", handler)',
    'ctx.on("real/event", handler)',
  ].join('\n')

  const result = extractListeners(source, 'index.ts')
  assert.deepEqual(result.listeners.map((entry) => entry.name), ['real/event'])
})

test('extractListeners reports dynamic names without guessing', () => {
  const source = [
    'const EVENT = "dynamic/name"',
    'ctx.on(EVENT, handler)',
    'ctx.waterfall(`interp/${suffix}`, handler)',
    'ctx.on("prefix/" + rest, handler)',
    'ctx.on("literal/ok", handler)',
  ].join('\n')

  const result = extractListeners(source, 'index.js')
  assert.deepEqual(result.listeners.map((entry) => entry.name), ['literal/ok'])
  assert.equal(result.dynamic.length, 3)
  assert.deepEqual(result.dynamic.map((entry) => entry.mode), ['on', 'waterfall', 'on'])
})

test('extractListeners accepts a template without substitution', () => {
  const result = extractListeners('ctx.on(`plain/template`, handler)', 'index.js')
  assert.deepEqual(result.listeners.map((entry) => entry.name), ['plain/template'])
})

test('extractListeners handles TypeScript type arguments', () => {
  const result = extractListeners(
    "ctx.on<{ turn: number }>('typed/event', handler)\n",
    'index.ts',
  )
  assert.deepEqual(result.listeners.map((entry) => entry.name), ['typed/event'])
})

test('extractListeners handles optional chaining and string escapes', () => {
  const source = ['ctx?.on?.("session/event", handler)', "ctx.on('esc\\'aped', handler)"].join('\n')
  const result = extractListeners(source, 'index.js')
  assert.deepEqual(result.listeners.map((entry) => entry.name), ['session/event', "esc'aped"])
})

test('extractListeners records a lexical error instead of failing the scan', () => {
  const result = extractListeners('ctx.on("unterminated', 'index.js')
  assert.match(result.parseError, /字符串未闭合/)
  assert.equal(result.listeners.length, 1)
})

test('collectRelativeImports only returns relative specifiers', () => {
  const source = [
    "import { a } from './lib/a.js'",
    "import './side-effect.js'",
    "export { b } from '../b.js'",
    "const c = require('./c.cjs')",
    "const d = await import('./d.mjs')",
    "import x from 'some-package'",
  ].join('\n')
  assert.deepEqual(collectRelativeImports(source).sort(), [
    '../b.js',
    './c.cjs',
    './d.mjs',
    './lib/a.js',
    './side-effect.js',
  ])
})

test('scanPackage reads the entry plus one level of relative imports', () => {
  const dir = tempDir()
  try {
    writeText(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', main: './index.js' }),
    )
    writeText(
      path.join(dir, 'index.js'),
      "import { listener } from './lib/events.js'\nexport function apply(ctx) { ctx.on('entry/event', listener) }\n",
    )
    writeText(
      path.join(dir, 'lib', 'events.js'),
      "export const listener = () => {}\nctx.waterfall('imported/event', listener)\n",
    )
    writeText(
      path.join(dir, 'lib', 'deep.js'),
      "ctx.on('too/deep', listener)\n",
    )
    writeText(
      path.join(dir, 'lib', 'events.js'),
      "import './deep.js'\nctx.waterfall('imported/event', listener)\n",
    )

    const scan = scanPackage(dir, 'fixture', '1.0.0')
    assert.deepEqual(scan.events.map((entry) => entry.name).sort(), ['entry/event', 'imported/event'])
    assert.deepEqual(scan.files.sort(), ['index.js', 'lib/events.js'])
    assert.deepEqual(scan.errors, [])
  } finally {
    removeDir(dir)
  }
})

test('scanPackage scans the root export only, not ./client', () => {
  const dir = tempDir()
  try {
    writeText(
      path.join(dir, 'host.js'),
      "export function apply(ctx) { ctx.on('host/event', () => {}) }\n",
    )
    writeText(
      path.join(dir, 'client.js'),
      "window.__ModuleLoader__.load({ id: 'x', factory() { ctx.on('client/event', () => {}) } })\n",
    )
    writeText(
      path.join(dir, 'package.json'),
      JSON.stringify(
        {
          name: 'fixture',
          version: '2.0.0',
          type: 'module',
          exports: { '.': './host.js', './client': './client.js' },
        },
        null,
        2,
      ),
    )

    const scan = scanPackage(dir, 'fixture', '2.0.0')
    assert.deepEqual(scan.events.map((entry) => entry.name), ['host/event'])
    assert.deepEqual(scan.files, ['host.js'])
  } finally {
    removeDir(dir)
  }
})

test('scanPackage records missing entry files as errors, not an empty healthy scan', () => {
  const dir = tempDir()
  try {
    writeText(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'broken', version: '1.0.0', main: './missing.js' }),
    )
    const scan = scanPackage(dir, 'broken', '1.0.0')
    assert.equal(scan.events.length, 0)
    assert.equal(scan.errors.length > 0, true)
  } finally {
    removeDir(dir)
  }
})

test('scanPackage reads a link-installed package by its real version', () => {
  const profile = makeProfile({
    'linked-pkg': {
      version: '3.1.4',
      source: "ctx.on('linked/event', () => {})\n",
    },
  })
  try {
    const scan = scanPackage(
      path.join(profile, 'node_modules', 'linked-pkg'),
      'linked-pkg',
      'link:C:/somewhere',
    )
    assert.equal(scan.version, '3.1.4')
    assert.deepEqual(scan.events.map((entry) => entry.name), ['linked/event'])
  } finally {
    removeDir(profile)
  }
})
