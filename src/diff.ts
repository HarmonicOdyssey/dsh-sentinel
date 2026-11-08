/**
 * The pure comparison step.
 *
 * No filesystem, no host APIs: given what a package listens to and the current
 * event vocabulary, decide `damaged` / `unknown` / `healthy`. This is the file
 * the unit tests pin down most tightly (development document §7.1).
 */

import type {
  DamagedEntry,
  DiffResult,
  HealthyEntry,
  PackageScan,
  UnknownEntry,
  UnknownReason,
} from './types.ts'

export interface NameDiff {
  /** Listened names that are absent from the catalog, de-duplicated and sorted. */
  removed: string[]
  /** Listened names present in the catalog, de-duplicated and sorted. */
  present: string[]
}

/** Compare a listener-name set with a vocabulary set. */
export function diffNames(
  listened: readonly string[],
  catalogNames: ReadonlySet<string>,
): NameDiff {
  const present = new Set<string>()
  const removed = new Set<string>()
  for (const name of listened) {
    if (typeof name !== 'string' || name === '') continue
    if (catalogNames.has(name)) present.add(name)
    else removed.add(name)
  }
  return {
    removed: [...removed].sort(),
    present: [...present].sort(),
  }
}

export type Classification =
  | { status: 'damaged'; missing: string[]; events: string[] }
  | { status: 'unknown'; reason: UnknownReason }
  | { status: 'healthy'; events: string[]; dynamic_count: number }

/**
 * Classify one package.
 *
 * `damaged` requires at least one determined event name that is absent.
 * A package with no determined names is never damaged: it is `unknown`, with
 * the reason the document's report schema expects.
 */
export function classifyScan(
  scan: PackageScan,
  catalogNames: ReadonlySet<string>,
): Classification {
  const events = [...new Set(scan.events.map((entry) => entry.name))].sort()

  if (events.length === 0) {
    if (scan.errors.length > 0) return { status: 'unknown', reason: 'source_unreadable' }
    if (scan.dynamic.length > 0) return { status: 'unknown', reason: 'no_literal_event_names' }
    return { status: 'unknown', reason: 'no_event_listeners' }
  }

  const { removed } = diffNames(events, catalogNames)
  if (removed.length > 0) {
    return { status: 'damaged', missing: removed, events }
  }
  return { status: 'healthy', events, dynamic_count: scan.dynamic.length }
}

/** Classify every scanned package, keeping the three output groups stable. */
export function diffScans(
  scans: readonly PackageScan[],
  catalogNames: ReadonlySet<string>,
): DiffResult {
  const damaged: DamagedEntry[] = []
  const unknown: UnknownEntry[] = []
  const healthy: HealthyEntry[] = []

  for (const scan of scans) {
    const classification = classifyScan(scan, catalogNames)
    if (classification.status === 'damaged') {
      damaged.push({
        package: scan.package,
        version: scan.version,
        events: classification.missing,
        reason: 'event_not_in_catalog',
      })
    } else if (classification.status === 'unknown') {
      unknown.push({
        package: scan.package,
        version: scan.version,
        reason: classification.reason,
      })
    } else {
      healthy.push({
        package: scan.package,
        version: scan.version,
        events: classification.events,
        dynamic_count: classification.dynamic_count,
      })
    }
  }

  const byPackage = (left: { package: string }, right: { package: string }): number =>
    left.package.localeCompare(right.package)

  damaged.sort(byPackage)
  unknown.sort(byPackage)
  healthy.sort(byPackage)

  return { damaged, unknown, healthy }
}
