/**
 * Shared, host-free types.
 *
 * Nothing here imports a DSH package or Node.js: the same vocabulary is used by
 * the pure engine (`catalog`, `scanner`, `diff`, `report`) and by the tests.
 */

/** How an event is dispatched. `unknown` is only produced by imported catalogs. */
export type DispatchMode = 'emit' | 'waterfall' | 'parallel' | 'serial' | 'unknown'

/** One vocabulary entry: the event name and how DSH dispatches it. */
export interface CatalogEntry {
  name: string
  mode: DispatchMode
}

/** Where the event vocabulary came from. */
export type CatalogSource = 'persistence-catalog.md' | 'builtin_snapshot'

/** A loaded event vocabulary plus everything needed to explain it to a user. */
export interface Catalog {
  /** False when neither the Markdown catalog nor the bundled snapshot was usable. */
  available: boolean
  /** Sorted, de-duplicated entries. Empty when `available` is false. */
  entries: CatalogEntry[]
  /** Lookup set over `entries`. */
  names: ReadonlySet<string>
  source: CatalogSource
  /** Best-effort DSH version the vocabulary belongs to. */
  versionHint: string
  /** When the source artifact was generated, when it records that. */
  generatedAt: string | null
  /** The file the vocabulary was read from, when it exists on disk. */
  file: string | null
  /** Why a candidate catalog was skipped. Never contains a stack trace. */
  warnings: string[]
  /** Why no vocabulary is available. `null` when `available` is true. */
  error: string | null
}

/** Overall condition of the sentinel itself. */
export type EngineStatus =
  | 'normal'
  | 'catalog_unavailable'
  | 'self_check_failed'
  | 'scan_partial'

/** Enumerated degradation reasons; never a boolean. */
export type DegradationReason =
  | 'panel_register_failed'
  | 'tool_register_failed'
  | 'catalog_load_failed'
  | 'scan_failed'
  | 'profile_watch_failed'
  | 'self_check_failed'

/** A listener call found in plugin source, with the literal event name. */
export interface ListenerRef {
  name: string
  /** `on` for `ctx.on`, `waterfall` for `ctx.waterfall`. */
  mode: 'on' | 'waterfall'
  /** Path relative to the scanned package root, using `/`. */
  file: string
  /** 1-based line of the receiver, e.g. `ctx`. */
  line: number
}

/** A listener whose event name cannot be determined statically. */
export interface DynamicRef {
  mode: 'on' | 'waterfall'
  file: string
  line: number
}

/** Everything the scanner learned about one installed package. */
export interface PackageScan {
  package: string
  version: string
  /** Absolute package directory, `''` when it could not be resolved. */
  dir: string
  events: ListenerRef[]
  dynamic: DynamicRef[]
  /** Files that were parsed, relative to `dir`. */
  files: string[]
  /** Read/parse failures. Presence alone makes the run `scan_partial`. */
  errors: string[]
}

/** A package with at least one listener whose event is absent from the catalog. */
export interface DamagedEntry {
  package: string
  version: string
  events: string[]
  reason: 'event_not_in_catalog'
}

/** Why a package could not be judged. */
export type UnknownReason =
  | 'no_literal_event_names'
  | 'no_event_listeners'
  | 'source_unreadable'

/** A package that was not classifiable, with a machine-readable reason. */
export interface UnknownEntry {
  package: string
  version: string
  reason: UnknownReason
}

/** A package whose literal listeners all exist in the catalog. */
export interface HealthyEntry {
  package: string
  version: string
  events: string[]
  dynamic_count: number
}

/** Pure comparison output. */
export interface DiffResult {
  damaged: DamagedEntry[]
  unknown: UnknownEntry[]
  healthy: HealthyEntry[]
}

/** The structured report returned by the tool and served over HTTP. */
export interface HealthReport {
  generated_at: string
  catalog_source: CatalogSource
  catalog_version_hint: string
  catalog_generated_at: string | null
  engine_status: EngineStatus
  /** One readable sentence explaining a non-normal status. Empty when normal. */
  engine_reason: string
  /** Every degradation observed since the sentinel started. */
  degradations: DegradationReason[]
  damaged: DamagedEntry[]
  unknown: UnknownEntry[]
  healthy_count: number
  /** How many installed packages were considered. */
  scanned_packages: number
  /** Per-package scan failures; also switches the engine to `scan_partial`. */
  scan_errors: string[]
}
