#!/usr/bin/env node
/**
 * Build `snapshot/catalog.json` — the minimal `{ name, mode }` vocabulary that
 * ships with the plugin.
 *
 * Two accepted sources:
 *
 *   node scripts/gen-snapshot.mjs --from-cordis-api <api-catalog.ts> \
 *     --dsh-version 0.2.2-rc.1
 *
 *     Reads `EVENT_API` from DSH's generated
 *     `packages/extensions/tool-cordis/src/api-catalog.ts` (the machine catalog
 *     behind `cordis_inspect`). This is the only shipped DSH artifact that
 *     carries both event names and dispatch modes, which is why it is the
 *     default source for the bundled snapshot.
 *
 *   node scripts/gen-snapshot.mjs --from-markdown <persistence-catalog.md>
 *
 *     Reads a Markdown catalog whose table has Event/Name and Mode/Dispatch
 *     columns — the same format `src/catalog.ts` accepts at runtime. Use this
 *     when a DSH release publishes a persistence catalog that carries dispatch
 *     modes.
 *
 * The output is deterministic apart from `generated_at`; events are sorted by
 * name and each entry has exactly `{ name, mode }`.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseCatalogMarkdown } from '../lib/catalog.js'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

function usage() {
  console.error(
    'usage: node scripts/gen-snapshot.mjs --from-cordis-api <file> --dsh-version <v> [--out <file>]\n' +
      '   or: node scripts/gen-snapshot.mjs --from-markdown <file> [--dsh-version <v>] [--out <file>]',
  )
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index++) {
    const current = argv[index]
    if (!current.startsWith('--')) continue
    const key = current.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      args[key] = true
    } else {
      args[key] = value
      index++
    }
  }
  return args
}

function readCordisEvents(text) {
  const start = text.indexOf('export const EVENT_API')
  if (start === -1) throw new Error('未找到 `export const EVENT_API`')
  const end = text.indexOf('export const TYPE_API', start)
  const block = text.slice(start, end === -1 ? undefined : end)
  const pattern = /\{\s*name:\s*'((?:[^'\\]|\\.)+)',\s*mode:\s*'([^']+)',/g
  const entries = []
  let match
  while ((match = pattern.exec(block)) !== null) {
    const eventName = match[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\')
    entries.push({ name: eventName, mode: match[2] })
  }
  if (entries.length === 0) throw new Error('EVENT_API 中没有解析出任何事件')
  return entries
}

function dedupe(entries) {
  const byName = new Map()
  for (const entry of entries) {
    if (!byName.has(entry.name)) byName.set(entry.name, entry)
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const out = path.resolve(root, typeof args.out === 'string' ? args.out : 'snapshot/catalog.json')
  const dshVersion = typeof args['dsh-version'] === 'string' ? args['dsh-version'] : 'unknown'

  let entries
  let source
  if (typeof args['from-cordis-api'] === 'string') {
    const file = path.resolve(process.cwd(), args['from-cordis-api'])
    const text = fs.readFileSync(file, 'utf8')
    entries = readCordisEvents(text)
    source = 'packages/extensions/tool-cordis/src/api-catalog.ts#EVENT_API'
  } else if (typeof args['from-markdown'] === 'string') {
    const file = path.resolve(process.cwd(), args['from-markdown'])
    const text = fs.readFileSync(file, 'utf8')
    entries = parseCatalogMarkdown(text)
    source = path.basename(file)
  } else {
    usage()
    process.exitCode = 2
    return
  }

  const events = dedupe(entries)
  const payload = {
    format: 1,
    generated_at: new Date().toISOString(),
    dsh_version: dshVersion,
    source,
    event_count: events.length,
    events,
  }
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  console.log(`wrote ${events.length} events to ${path.relative(root, out)} (dsh ${dshVersion})`)
}

main()
