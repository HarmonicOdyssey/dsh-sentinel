/**
 * The event-vocabulary loader.
 *
 * Two sources, in priority order (development document §3.1):
 *
 *  A. `persistence-catalog.md` — the DSH repository's generated catalog. The
 *     loader accepts a Markdown table that carries both an event name column
 *     and a dispatch-mode column (`emit`, `waterfall`, `parallel`, `serial`).
 *     A catalog whose structure does not carry dispatch modes is rejected with
 *     an explicit error instead of being silently treated as an empty set.
 *
 *  B. `snapshot/catalog.json` — the minimal `{ name, mode }` vocabulary that
 *     ships with this package. It is used whenever A is absent or structurally
 *     incompatible, and the report says so.
 *
 * DSH 0.2.x's `docs/persistence-catalog.md` lists persisted Session event
 * types (e.g. `event:session/title`) and has no dispatch-mode column, so it is
 * rejected by the rule above and the bundled snapshot wins. This is exactly the
 * compatibility fallback §3.1 asks for; see README "词表来源".
 */

import fs from 'node:fs'

import type { Catalog, CatalogEntry, CatalogSource, DispatchMode } from './types.ts'

/** A catalog file exists but its structure is not one this engine can read. */
export class CatalogFormatError extends Error {
  readonly code = 'CATALOG_FORMAT'

  constructor(message: string) {
    super(message)
    this.name = 'CatalogFormatError'
  }
}

const KNOWN_MODES = new Set<DispatchMode>(['emit', 'waterfall', 'parallel', 'serial'])

/** Normalize one mode cell; unknown words become `unknown`, never a guess. */
function normalizeMode(raw: string): DispatchMode {
  const value = raw.replace(/[`*_]/g, '').trim().toLowerCase()
  if (value === '') throw new CatalogFormatError('事件行的分发模式为空')
  if (KNOWN_MODES.has(value as DispatchMode)) return value as DispatchMode
  if (value === 'bail') return 'waterfall'
  return 'unknown'
}

/**
 * Strip presentation noise around a Markdown table cell.
 *
 * Only wrapping markers are removed: an underscore inside an event name is
 * part of the name, so it must survive.
 */
function cleanCell(raw: string): string {
  return raw
    .replace(/`/g, '')
    .replace(/^\*+|\*+$/g, '')
    .replace(/^_+|_+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Split a Markdown table row into raw cells. */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
}

function looksLikeEventName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
}

/**
 * Parse a Markdown event catalog.
 *
 * Accepted table header cells (case-insensitive, with or without backticks):
 *   - name: `Event`, `Event name`, `Name`
 *   - mode: `Mode`, `Dispatch`, `Dispatch mode`
 *
 * @throws {CatalogFormatError} when no event table exists, when a table has
 * names but no mode column, or when a row is malformed.
 */
export function parseCatalogMarkdown(text: string): CatalogEntry[] {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new CatalogFormatError('词表文件为空')
  }

  const lines = text.split(/\r?\n/)
  const entries = new Map<string, CatalogEntry>()
  let sawEventTable = false

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (!line.trim().startsWith('|')) continue

    // Gather one contiguous table block.
    const block: Array<{ text: string; line: number }> = []
    while (index < lines.length) {
      const current = lines[index] ?? ''
      if (!current.trim().startsWith('|')) break
      block.push({ text: current, line: index + 1 })
      index++
    }
    index-- // the outer loop increments past the first non-table line

    if (block.length < 2) continue
    const header = splitRow(block[0]?.text ?? '').map((cell) =>
      cleanCell(cell).toLowerCase(),
    )
    const nameIndex = header.findIndex((cell) =>
      cell === 'event' || cell === 'event name' || cell === 'name',
    )
    const modeIndex = header.findIndex((cell) =>
      cell === 'mode' || cell === 'dispatch' || cell === 'dispatch mode',
    )
    if (nameIndex === -1) continue

    sawEventTable = true
    if (modeIndex === -1) {
      throw new CatalogFormatError(
        `词表表格（第 ${block[0]?.line ?? 0} 行）缺少分发模式列；` +
          '需要 Event/Name 与 Mode/Dispatch 两列，无法据此判断事件是否仍被分发',
      )
    }

    for (const row of block.slice(1)) {
      const cells = splitRow(row.text)
      if (isSeparatorRow(cells)) continue
      const rawName = cleanCell(cells[nameIndex] ?? '').replace(/^event\s*:\s*/i, '')
      if (rawName === '') continue
      if (!looksLikeEventName(rawName)) {
        throw new CatalogFormatError(`第 ${row.line} 行的事件名不合法：${rawName}`)
      }
      const rawMode = cells[modeIndex] ?? ''
      let mode: DispatchMode
      try {
        mode = normalizeMode(rawMode)
      } catch (error) {
        throw new CatalogFormatError(
          `第 ${row.line} 行的事件 ${rawName} 没有可用的分发模式：${(error as Error).message}`,
        )
      }
      if (!entries.has(rawName)) entries.set(rawName, { name: rawName, mode })
    }
  }

  if (!sawEventTable) {
    throw new CatalogFormatError(
      '未找到事件表：词表必须包含 Event/Name 与 Mode/Dispatch 两列的 Markdown 表格',
    )
  }
  if (entries.size === 0) {
    throw new CatalogFormatError('事件表存在，但没有解析出任何事件')
  }
  return [...entries.values()].sort((left, right) => left.name.localeCompare(right.name))
}

/** Extract a best-effort DSH version from the head of a catalog file. */
export function readVersionHint(text: string): string {
  const head = text.split(/\r?\n/).slice(0, 80).join('\n')
  const match = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(head)
  return match?.[1] ?? 'unknown'
}

interface SnapshotShape {
  events?: unknown
  dsh_version?: unknown
  generated_at?: unknown
}

/** Parse the bundled snapshot file. Throws `CatalogFormatError` when malformed. */
export function parseSnapshot(text: string): {
  entries: CatalogEntry[]
  versionHint: string
  generatedAt: string | null
} {
  let parsed: SnapshotShape
  try {
    parsed = JSON.parse(text) as SnapshotShape
  } catch (error) {
    throw new CatalogFormatError(`内置快照不是合法 JSON：${(error as Error).message}`)
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new CatalogFormatError('内置快照必须是 JSON 对象')
  }
  if (!Array.isArray(parsed.events)) {
    throw new CatalogFormatError('内置快照缺少 events 数组')
  }
  const entries = new Map<string, CatalogEntry>()
  for (const raw of parsed.events) {
    if (raw === null || typeof raw !== 'object') continue
    const record = raw as { name?: unknown; mode?: unknown }
    if (typeof record.name !== 'string' || record.name.trim() === '') continue
    if (!looksLikeEventName(record.name)) {
      throw new CatalogFormatError(`内置快照包含不合法的事件名：${record.name}`)
    }
    const mode =
      typeof record.mode === 'string' && record.mode.trim() !== ''
        ? normalizeMode(record.mode)
        : 'unknown'
    if (!entries.has(record.name)) entries.set(record.name, { name: record.name, mode })
  }
  if (entries.size === 0) {
    throw new CatalogFormatError('内置快照的 events 为空')
  }
  return {
    entries: [...entries.values()].sort((left, right) => left.name.localeCompare(right.name)),
    versionHint: typeof parsed.dsh_version === 'string' ? parsed.dsh_version : 'unknown',
    generatedAt: typeof parsed.generated_at === 'string' ? parsed.generated_at : null,
  }
}

/** A catalog that cannot answer any question. */
export function emptyCatalog(error: string, warnings: string[] = []): Catalog {
  return {
    available: false,
    entries: [],
    names: new Set<string>(),
    source: 'builtin_snapshot',
    versionHint: 'unknown',
    generatedAt: null,
    file: null,
    warnings,
    error,
  }
}

export interface LoadCatalogOptions {
  /** Markdown candidates, highest priority first. Missing paths are skipped quietly. */
  candidates: readonly string[]
  /** Absolute path to `snapshot/catalog.json`. */
  snapshotPath: string
  /** Injectable clock, used only by tests. */
  now?: () => Date
}

/**
 * Load the vocabulary. Never throws: a total failure returns `available:false`
 * with a readable `error`, and the engine then reports only that fact.
 */
export function loadCatalog(options: LoadCatalogOptions): Catalog {
  const warnings: string[] = []
  const tried: string[] = []
  let sawCandidate = false

  for (const candidate of options.candidates) {
    if (candidate === '') continue
    sawCandidate = true
    tried.push(candidate)
    let text: string
    try {
      text = fs.readFileSync(candidate, 'utf8')
    } catch {
      continue // absent candidate: not a degradation, just no Source A
    }
    try {
      const entries = parseCatalogMarkdown(text)
      const stat = fs.statSync(candidate)
      return {
        available: true,
        entries,
        names: new Set(entries.map((entry) => entry.name)),
        source: 'persistence-catalog.md',
        versionHint: readVersionHint(text),
        generatedAt: stat.mtime.toISOString(),
        file: candidate,
        warnings,
        error: null,
      }
    } catch (error) {
      warnings.push(`跳过 ${candidate}：${(error as Error).message}`)
    }
  }

  // Source B: the bundled snapshot.
  try {
    const text = fs.readFileSync(options.snapshotPath, 'utf8')
    const snapshot = parseSnapshot(text)
    if (sawCandidate && warnings.length === 0) {
      warnings.push('未找到可用的 persistence-catalog.md，使用内置快照（可能滞后于当前 DSH 版本）')
    }
    return {
      available: true,
      entries: snapshot.entries,
      names: new Set(snapshot.entries.map((entry) => entry.name)),
      source: 'builtin_snapshot',
      versionHint: snapshot.versionHint,
      generatedAt: snapshot.generatedAt,
      file: options.snapshotPath,
      warnings,
      error: null,
    }
  } catch (error) {
    const detail = (error as Error).message
    // `ENOENT` here means the package's own snapshot is missing; report it as
    // one readable condition rather than two stacked messages.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      warnings.push('内置快照文件缺失')
    } else {
      warnings.push(`内置快照不可用：${detail}`)
    }
    return emptyCatalog(
      sawCandidate
        ? `persistence-catalog.md 与内置快照均不可用：${warnings.join('；') || detail}`
        : `内置快照不可用：${detail}`,
      warnings,
    )
  }
}

/** Human-readable source label used by the panel and tool output. */
export function catalogSourceLabel(catalog: Catalog): string {
  if (!catalog.available) return '不可用'
  const source: CatalogSource = catalog.source
  if (source === 'persistence-catalog.md') {
    return `persistence-catalog.md（${catalog.versionHint}）`
  }
  return `内置快照（${catalog.versionHint}，可能滞后于当前 DSH 版本）`
}
