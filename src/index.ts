/**
 * Host entry — the only file that touches DSH host APIs.
 *
 * `apply` does three cheap, independently guarded things and returns:
 *   1. register the report HTTP routes (fed to the sidebar panel);
 *   2. register the `plugin_health_report` agent tool;
 *   3. register a manifest watcher and one deferred full scan.
 *
 * It never scans inside `apply`, never throws, and every failure is recorded as
 * a degradation reason rather than propagated (development document §5).
 */

import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { emptyCatalog, loadCatalog } from './catalog.ts'
import { scanPackage } from './scanner.ts'
import { buildReport, renderReportJson, renderReportText } from './report.ts'
import { DEGRADATION_TEXT, describeError, guard, selfCheck } from './safe.ts'
import type {
  Catalog,
  DegradationReason,
  EngineStatus,
  HealthReport,
  PackageScan,
} from './types.ts'

/** Diagnostic name used by Cordis. */
export const name = 'sentinel'

/** No required services: every surface arrives through `ctx.inject` and degrades alone. */
export const inject: string[] = []

/** The package root, from `lib/index.js` (built) or `src/index.ts` (tests). */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** HTTP route the panel polls. Kept exact so it cannot shadow anything else. */
export const REPORT_ROUTE = '/dsh-sentinel/report.json'
/** The client half reports a failed panel registration here. */
export const DEGRADED_ROUTE = '/dsh-sentinel/degraded'

const MAX_DEGRADED_BODY = 4096
const TOOL_NAME = 'plugin_health_report'
const SERVICE_PROBE_MS = 10_000

// ── Structural host types ───────────────────────────────────────────────────
// Declared locally so this package has no runtime DSH dependency and stays
// installable in profiles whose DSH version only provides a subset.

export interface Logger {
  info?(message: string): void
  warn?(message: string): void
}

export interface ToolDefinitionLike {
  name: string
  description: string
  parameters: unknown
  output: unknown
  execute: (args: Record<string, unknown>) => unknown
}

export interface ToolRegistryLike {
  register(definition: ToolDefinitionLike): unknown
}

export interface WebServerRouteLike {
  kind: 'exact'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void
}

export interface WebServerLike {
  register(route: WebServerRouteLike): () => void
}

export interface HostContext {
  logger?: Logger
  tools?: ToolRegistryLike
  webServer?: WebServerLike
  effect?(callback: () => (() => void) | void): unknown
  inject?(services: readonly string[], callback: (child: HostContext) => void): unknown
  get?(service: string): unknown
}

// ── Profile discovery ───────────────────────────────────────────────────────

/** Resolve the active profile directory from the environment DSH exports. */
export function resolveProfileDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env['DSH_PROFILE_DIR']
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit)
  const profile = env['DSH_PROFILE']
  if (typeof profile === 'string' && profile.trim() !== '') {
    const home = env['DSH_HOME'] ?? path.join(os.homedir(), '.dsh')
    return path.join(home, 'profiles', profile)
  }
  return null
}

/** Markdown catalog candidates, most specific first. */
export function defaultCatalogCandidates(
  profileDir: string | null,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string[] {
  const candidates: string[] = []
  const override = env['DSH_SENTINEL_CATALOG']
  if (typeof override === 'string' && override.trim() !== '') candidates.push(path.resolve(override))
  if (profileDir !== null) {
    candidates.push(path.join(profileDir, 'docs', 'persistence-catalog.md'))
    candidates.push(path.join(profileDir, 'persistence-catalog.md'))
  }
  candidates.push(path.join(cwd, 'persistence-catalog.md'))
  candidates.push(path.join(cwd, 'docs', 'persistence-catalog.md'))
  const home = env['DSH_HOME'] ?? path.join(os.homedir(), '.dsh')
  candidates.push(path.join(home, 'persistence-catalog.md'))
  candidates.push(path.join(home, 'docs', 'persistence-catalog.md'))
  return [...new Set(candidates)]
}

interface InstalledPackage {
  name: string
  version: string
  dir: string
}

/**
 * Read the profile's plugin manifest (`package.json` dependencies) and resolve
 * each installed package's real version from its own manifest. `link:` and
 * range specs therefore compare by the version actually on disk.
 */
export function readInstalledPackages(profileDir: string | null): Map<string, InstalledPackage> | null {
  if (profileDir === null) return null
  let manifest: Record<string, unknown>
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'),
    ) as unknown
    if (parsed === null || typeof parsed !== 'object') return null
    manifest = parsed as Record<string, unknown>
  } catch {
    return null
  }

  const dependencies =
    manifest['dependencies'] !== null && typeof manifest['dependencies'] === 'object'
      ? (manifest['dependencies'] as Record<string, unknown>)
      : {}
  const packages = new Map<string, InstalledPackage>()
  for (const [dependency, spec] of Object.entries(dependencies)) {
    const dir = path.join(profileDir, 'node_modules', ...dependency.split('/'))
    let version = typeof spec === 'string' ? spec : 'unknown'
    try {
      const installed = JSON.parse(
        fs.readFileSync(path.join(dir, 'package.json'), 'utf8'),
      ) as { version?: unknown }
      if (typeof installed.version === 'string' && installed.version.trim() !== '') {
        version = installed.version
      }
    } catch {
      // The scan will record the unreadable package; keep the range as a label.
    }
    packages.set(dependency, { name: dependency, version, dir })
  }
  return packages
}

// ── Sentinel orchestration (host-free, unit-testable) ───────────────────────

export interface SentinelOptions {
  profileDir: string | null
  /** Absolute path to the bundled snapshot. */
  snapshotPath: string
  /** Markdown candidates, most specific first. */
  catalogCandidates?: string[]
  /** Debounce for manifest writes. dsh plugin add/remove may write twice. */
  debounceMs?: number
  maxScanFiles?: number
  logger?: Logger
  now?: () => Date
}

export interface Sentinel {
  /** Run the startup full scan. Resolves when the first report is available. */
  start(): Promise<void>
  /** Reload the catalog and rescan every package. */
  refreshAll(): Promise<void>
  /** Reconcile against the manifest after a write (add/remove/upgrade). */
  handleManifestChange(): Promise<void>
  /** Debounced wrapper used by the fs watcher. */
  scheduleManifestChange(): void
  /** The current structured report. */
  report(): HealthReport
  /** True once the first scan (or a failed attempt) settled. */
  isReady(): boolean
  /** Resolve true when ready, or false after `timeoutMs`. */
  whenReady(timeoutMs: number): Promise<boolean>
  notifyPanelFailure(detail?: string): void
  markSelfCheckFailed(detail: string): void
  recordDegradation(reason: DegradationReason, detail: string): void
  dispose(): void
}

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve)
  })

class SentinelImpl implements Sentinel {
  private readonly options: SentinelOptions
  private catalog: Catalog | null = null
  private scans = new Map<string, PackageScan>()
  private packages = new Map<string, InstalledPackage>()
  private readonly degradations = new Map<DegradationReason, string>()
  private selfCheckFailure: string | null = null
  private ready = false
  private started = false
  private disposed = false
  private debounceTimer: NodeJS.Timeout | null = null
  private readonly readyWaiters = new Set<() => void>()

  constructor(options: SentinelOptions) {
    this.options = options
  }

  private log(level: 'info' | 'warn', message: string): void {
    try {
      this.options.logger?.[level]?.(`[sentinel] ${message}`)
    } catch {
      /* logging must never be the failure */
    }
  }

  recordDegradation(reason: DegradationReason, detail: string): void {
    if (!this.degradations.has(reason)) {
      this.degradations.set(reason, detail)
      this.log('warn', `${reason}: ${detail}`)
    }
  }

  markSelfCheckFailed(detail: string): void {
    this.selfCheckFailure = detail
    this.recordDegradation('self_check_failed', detail)
    // No scan will run, so the report is complete now: tools and the panel must
    // not wait for a readiness that can never arrive.
    this.settleReady()
  }

  notifyPanelFailure(detail?: string): void {
    this.recordDegradation(
      'panel_register_failed',
      detail ?? '目标 DSH 未提供 sidebarRightTabs/slots，面板不可用',
    )
  }

  private computeStatus(): EngineStatus {
    if (this.selfCheckFailure !== null) return 'self_check_failed'
    if (this.degradations.has('panel_register_failed')) return 'self_check_failed'
    if (this.catalog === null || !this.catalog.available) return 'catalog_unavailable'
    if (
      this.degradations.has('scan_failed') ||
      [...this.scans.values()].some((scan) => scan.errors.length > 0)
    ) {
      return 'scan_partial'
    }
    return 'normal'
  }

  private computeReason(): string {
    if (this.selfCheckFailure !== null) return this.selfCheckFailure
    const panel = this.degradations.get('panel_register_failed')
    if (panel !== undefined) {
      return `${panel}；已回退到仅工具/JSON 输出，报告本身仍然有效`
    }
    if (this.catalog === null) return '尚未完成事件词表加载'
    if (!this.catalog.available) return this.catalog.error ?? '无法获取事件词表'
    const scanFailed = this.degradations.get('scan_failed')
    if (scanFailed !== undefined) return `扫描过程中出现异常：${scanFailed}`
    const failed = [...this.scans.values()].filter((scan) => scan.errors.length > 0).length
    if (failed > 0) return `${failed} 个包的源码未能完整读取；其余结论仍然有效`
    return ''
  }

  report(): HealthReport {
    const catalog =
      this.catalog ?? emptyCatalog(this.selfCheckFailure ?? '尚未完成事件词表加载')
    return buildReport({
      catalog,
      scans: [...this.scans.values()],
      engineStatus: this.computeStatus(),
      engineReason: this.computeReason(),
      degradations: [...this.degradations.keys()],
      now: this.options.now,
    })
  }

  isReady(): boolean {
    return this.ready
  }

  whenReady(timeoutMs: number): Promise<boolean> {
    if (this.ready) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const finish = (value: boolean): void => {
        clearTimeout(timer)
        this.readyWaiters.delete(onReady)
        resolve(value)
      }
      const onReady = (): void => finish(true)
      const timer = setTimeout(() => finish(this.ready), timeoutMs)
      this.readyWaiters.add(onReady)
    })
  }

  private settleReady(): void {
    this.ready = true
    for (const waiter of [...this.readyWaiters]) waiter()
    this.readyWaiters.clear()
  }

  private loadCatalog(): Catalog {
    return loadCatalog({
      candidates: this.options.catalogCandidates ?? defaultCatalogCandidates(this.options.profileDir),
      snapshotPath: this.options.snapshotPath,
      now: this.options.now,
    })
  }

  private scanOne(pkg: InstalledPackage): PackageScan {
    try {
      return scanPackage(pkg.dir, pkg.name, pkg.version, {
        maxFiles: this.options.maxScanFiles,
      })
    } catch (error) {
      return {
        package: pkg.name,
        version: pkg.version,
        dir: pkg.dir,
        events: [],
        dynamic: [],
        files: [],
        errors: [`扫描失败：${describeError(error)}`],
      }
    }
  }

  private async scanAll(packages: Map<string, InstalledPackage>): Promise<void> {
    const next = new Map<string, PackageScan>()
    for (const pkg of packages.values()) {
      if (this.disposed) return
      next.set(pkg.name, this.scanOne(pkg))
      await yieldToEventLoop()
    }
    this.scans = next
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    try {
      const packages = readInstalledPackages(this.options.profileDir)
      if (packages === null) {
        this.markSelfCheckFailed('无法读取 profile 插件清单')
      } else {
        this.packages = packages
      }
      this.catalog = this.loadCatalog()
      if (!this.catalog.available) {
        this.recordDegradation('catalog_load_failed', this.catalog.error ?? '词表不可用')
      }
      await this.scanAll(this.packages)
    } catch (error) {
      this.recordDegradation('scan_failed', describeError(error))
    } finally {
      this.settleReady()
      this.log('info', `首次检查完成（${this.packages.size} 个包）`)
    }
  }

  async refreshAll(): Promise<void> {
    try {
      const packages = readInstalledPackages(this.options.profileDir)
      if (packages === null) {
        this.markSelfCheckFailed('无法读取 profile 插件清单')
        return
      }
      this.packages = packages
      this.catalog = this.loadCatalog()
      if (!this.catalog.available) {
        this.recordDegradation('catalog_load_failed', this.catalog.error ?? '词表不可用')
      }
      await this.scanAll(packages)
    } catch (error) {
      this.recordDegradation('scan_failed', describeError(error))
    } finally {
      this.settleReady()
    }
  }

  async handleManifestChange(): Promise<void> {
    if (this.disposed) return
    const packages = readInstalledPackages(this.options.profileDir)
    if (packages === null) {
      this.recordDegradation('profile_watch_failed', '插件清单在变化后不可读')
      return
    }

    // A catalog that was unavailable at boot may have appeared since.
    if (this.catalog === null || !this.catalog.available) {
      const reloaded = this.loadCatalog()
      if (reloaded.available) {
        this.catalog = reloaded
        this.log('info', '词表恢复可用，重新检查全部包')
        this.packages = packages
        await this.scanAll(packages)
        this.settleReady()
        return
      }
      this.catalog = reloaded
    }

    const changed: InstalledPackage[] = []
    for (const [packageName, pkg] of packages) {
      const previous = this.packages.get(packageName)
      if (previous === undefined || previous.version !== pkg.version) changed.push(pkg)
    }
    for (const packageName of [...this.scans.keys()]) {
      if (!packages.has(packageName)) this.scans.delete(packageName)
    }

    this.packages = packages
    for (const pkg of changed) {
      if (this.disposed) return
      const scan = this.scanOne(pkg)
      this.scans.set(pkg.name, scan)
      this.log('info', `清单变化：重新检查 ${pkg.name}@${pkg.version}`)
      await yieldToEventLoop()
    }
    this.settleReady()
  }

  scheduleManifestChange(): void {
    if (this.disposed) return
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.handleManifestChange().catch((error: unknown) => {
        this.recordDegradation('scan_failed', describeError(error))
      })
    }, this.options.debounceMs ?? 400)
  }

  dispose(): void {
    this.disposed = true
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    for (const waiter of [...this.readyWaiters]) waiter()
    this.readyWaiters.clear()
  }
}

/** Construct the host-free sentinel. Tests use this directly. */
export function createSentinel(options: SentinelOptions): Sentinel {
  return new SentinelImpl(options)
}

// ── Tool definition ─────────────────────────────────────────────────────────

export function buildToolDefinition(sentinel: Sentinel): ToolDefinitionLike {
  return {
    name: TOOL_NAME,
    description:
      '返回当前已安装插件的健康检查结果，包括确定性损坏和无法检查的插件。' +
      '不传参数返回文本摘要；传 format="json" 返回结构化 JSON。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: 'text（默认）返回人可读摘要；json 返回结构化报告',
        },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [
        { type: 'text', text: String(value ?? '') },
      ],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      await sentinel.whenReady(5000)
      const report = sentinel.report()
      return args['format'] === 'json' ? renderReportJson(report) : renderReportText(report)
    },
  }
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_DEGRADED_BODY) {
        settled = true
        sendJson(res, 413, { ok: false, error: 'body too large' })
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => {
      if (!settled) {
        settled = true
        resolve(null)
      }
    })
  })
}

function registerRoutes(ctx: HostContext, sentinel: Sentinel): void {
  let routesInstalled = false

  const attach = (child: HostContext): void => {
    const webServer = child.webServer
    if (webServer === undefined) {
      sentinel.notifyPanelFailure('webServer 服务不可用，面板拿不到报告')
      return
    }
    const install = (): (() => void) => {
      routesInstalled = true
      const disposers: Array<() => void> = []
      const safeDispose = (dispose: unknown): void => {
        if (typeof dispose === 'function') (dispose as () => void)()
      }
      try {
        disposers.push(
          webServer.register({
            kind: 'exact',
            path: REPORT_ROUTE,
            handler: (req, res) => {
              try {
                const method = String(req.method ?? 'GET').toUpperCase()
                if (method !== 'GET' && method !== 'HEAD') {
                  sendJson(res, 405, { ok: false, error: 'use GET' })
                  return
                }
                if (!sentinel.isReady()) {
                  sendJson(res, 200, { status: 'scanning' })
                  return
                }
                if (method === 'HEAD') {
                  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
                  res.end()
                  return
                }
                sendJson(res, 200, sentinel.report())
              } catch (error) {
                try {
                  sendJson(res, 500, { ok: false, error: describeError(error) })
                } catch {
                  /* response may already be sent */
                }
              }
            },
          }),
        )
        disposers.push(
          webServer.register({
            kind: 'exact',
            path: DEGRADED_ROUTE,
            handler: (req, res) => {
              void (async () => {
                try {
                  if (String(req.method ?? 'GET').toUpperCase() !== 'POST') {
                    sendJson(res, 405, { ok: false, error: 'use POST' })
                    return
                  }
                  const body = await readBody(req, res)
                  if (body === null) return
                  let parsed: unknown
                  try {
                    parsed = JSON.parse(body)
                  } catch {
                    sendJson(res, 400, { ok: false, error: 'invalid JSON' })
                    return
                  }
                  const reason =
                    parsed !== null && typeof parsed === 'object'
                      ? (parsed as { reason?: unknown }).reason
                      : undefined
                  if (reason !== 'panel_register_failed') {
                    sendJson(res, 400, { ok: false, error: 'unknown reason' })
                    return
                  }
                  sentinel.notifyPanelFailure('客户端侧边栏注册失败')
                  sendJson(res, 200, { ok: true })
                } catch (error) {
                  try {
                    sendJson(res, 500, { ok: false, error: describeError(error) })
                  } catch {
                    /* response may already be sent */
                  }
                }
              })()
            },
          }),
        )
      } catch (error) {
        sentinel.recordDegradation('panel_register_failed', describeError(error))
      }
      return () => {
        for (const dispose of disposers) {
          try {
            safeDispose(dispose)
          } catch {
            /* already removed */
          }
        }
      }
    }
    if (typeof child.effect === 'function') child.effect(install)
    else install()
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], attach)
    } catch (error) {
      sentinel.recordDegradation('panel_register_failed', describeError(error))
    }
  } else {
    const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    if (webServer === undefined) {
      sentinel.notifyPanelFailure('webServer 服务不可用，面板拿不到报告')
    } else {
      attach({ ...ctx, webServer: webServer as WebServerLike })
    }
  }

  // The service may simply be mounted later; if it never arrives, record it.
  const probe = setTimeout(() => {
    if (!routesInstalled) {
      sentinel.notifyPanelFailure('等待 webServer 服务超时，面板拿不到报告')
    }
  }, SERVICE_PROBE_MS)
  if (typeof probe.unref === 'function') probe.unref()
}

function registerTool(ctx: HostContext, sentinel: Sentinel): void {
  let toolRegistered = false

  const attach = (child: HostContext): void => {
    const tools = child.tools
    if (tools === undefined) {
      sentinel.recordDegradation('tool_register_failed', 'tools 服务不可用')
      return
    }
    const install = (): (() => void) => {
      try {
        tools.register(buildToolDefinition(sentinel))
        toolRegistered = true
      } catch (error) {
        sentinel.recordDegradation('tool_register_failed', describeError(error))
      }
      return () => {
        /* the registry owns the disposer; nothing to release here */
      }
    }
    if (typeof child.effect === 'function') child.effect(install)
    else install()
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['tools'], attach)
    } catch (error) {
      sentinel.recordDegradation('tool_register_failed', describeError(error))
    }
  } else {
    const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
    if (tools === undefined) {
      sentinel.recordDegradation('tool_register_failed', 'tools 服务不可用')
    } else {
      attach({ ...ctx, tools: tools as ToolRegistryLike })
    }
  }

  // If the service never arrives, say so instead of silently having no tool.
  const probe = setTimeout(() => {
    if (!toolRegistered) {
      sentinel.recordDegradation('tool_register_failed', '等待 tools 服务超时')
    }
  }, SERVICE_PROBE_MS)
  if (typeof probe.unref === 'function') probe.unref()
}

function registerWatch(ctx: HostContext, sentinel: Sentinel): void {
  const profileDir = resolveProfileDir()
  if (profileDir === null) {
    sentinel.recordDegradation('profile_watch_failed', '无法定位 profile 目录')
    return
  }
  const install = (): (() => void) => {
    let watcher: fs.FSWatcher
    try {
      watcher = fs.watch(profileDir, { persistent: false }, (_event, filename) => {
        if (filename === null) {
          sentinel.scheduleManifestChange()
          return
        }
        const base = path.basename(String(filename))
        if (
          base === 'package.json' ||
          base === 'cordis.patch.yml' ||
          base === 'cordis.yml' ||
          base === 'pnpm-lock.yaml'
        ) {
          sentinel.scheduleManifestChange()
        }
      })
    } catch (error) {
      sentinel.recordDegradation('profile_watch_failed', describeError(error))
      return () => {}
    }
    watcher.on('error', (error) => {
      sentinel.recordDegradation('profile_watch_failed', describeError(error))
    })
    return () => {
      try {
        watcher.close()
      } catch {
        /* already closed */
      }
    }
  }
  if (typeof ctx.effect === 'function') ctx.effect(install)
  else install()
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * DSH calls this once. It returns immediately and never throws.
 */
export function apply(ctx: HostContext): void {
  let sentinel: Sentinel | null = null
  try {
    const profileDir = resolveProfileDir()
    const snapshotPath = path.join(PACKAGE_ROOT, 'snapshot', 'catalog.json')
    const instance = createSentinel({
      profileDir,
      snapshotPath,
      catalogCandidates: defaultCatalogCandidates(profileDir),
      logger: ctx.logger,
    })
    sentinel = instance

    const check = selfCheck({ packageRoot: PACKAGE_ROOT, profileDir })
    if (!check.ok) {
      instance.markSelfCheckFailed(check.failures.join('；'))
    }

    guard('panel_register_failed', instance.recordDegradation.bind(instance), () => {
      registerRoutes(ctx, instance)
    })
    guard('tool_register_failed', instance.recordDegradation.bind(instance), () => {
      registerTool(ctx, instance)
    })

    if (check.ok) {
      guard('profile_watch_failed', instance.recordDegradation.bind(instance), () => {
        registerWatch(ctx, instance)
      })
      guard('scan_failed', instance.recordDegradation.bind(instance), () => {
        const startScan = (): (() => void) => {
          const timer = setTimeout(() => {
            void instance.start().catch((error: unknown) => {
              instance.recordDegradation('scan_failed', describeError(error))
            })
          }, 0)
          return () => clearTimeout(timer)
        }
        if (typeof ctx.effect === 'function') ctx.effect(startScan)
        else startScan()
      })
    }
  } catch (error) {
    // Last line of defence: `apply` must not throw even if everything above did.
    try {
      ctx.logger?.warn?.(`[sentinel] apply 降级：${describeError(error)}`)
      sentinel?.recordDegradation('self_check_failed', describeError(error))
    } catch {
      /* nothing left to do */
    }
  }
}

/** Exported for diagnostics and tests. */
export { DEGRADATION_TEXT }
