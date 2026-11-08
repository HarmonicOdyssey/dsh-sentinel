/**
 * Report assembly and rendering.
 *
 * One JSON shape feeds three surfaces: the sidebar panel (client half), the
 * agent tool, and the HTTP JSON endpoint. Text rendering lives here so the tool
 * and the panel can never disagree about what "damaged" means.
 */

import { diffScans } from './diff.ts'
import { DEGRADATION_TEXT } from './safe.ts'
import type {
  Catalog,
  DegradationReason,
  EngineStatus,
  HealthReport,
  PackageScan,
  UnknownReason,
} from './types.ts'

export interface BuildReportInput {
  catalog: Catalog
  scans: readonly PackageScan[]
  engineStatus: EngineStatus
  engineReason: string
  degradations: readonly DegradationReason[]
  now?: () => Date
}

/** Build the structured report (development document §4.3). */
export function buildReport(input: BuildReportInput): HealthReport {
  const now = input.now ?? (() => new Date())
  const available = input.catalog.available
  const diff = available ? diffScans(input.scans, input.catalog.names) : null

  const scanErrors = input.scans.flatMap((scan) =>
    scan.errors.map((error) => `${scan.package}: ${error}`),
  )

  // A self-check failure outranks a missing vocabulary: it explains why the
  // sentinel is silent. Otherwise a missing vocabulary removes every "damaged"
  // conclusion — without a baseline, absence from an empty set would flag
  // every listener.
  const engineStatus: EngineStatus =
    input.engineStatus === 'self_check_failed'
      ? 'self_check_failed'
      : available
        ? input.engineStatus
        : 'catalog_unavailable'
  const engineReason =
    input.engineStatus === 'self_check_failed'
      ? input.engineReason
      : available
        ? input.engineReason
        : input.catalog.error ?? '无法获取事件词表'

  return {
    generated_at: now().toISOString(),
    catalog_source: input.catalog.source,
    catalog_version_hint: input.catalog.versionHint,
    catalog_generated_at: input.catalog.generatedAt,
    engine_status: engineStatus,
    engine_reason: engineReason,
    degradations: [...new Set(input.degradations)],
    damaged: diff?.damaged ?? [],
    unknown: diff?.unknown ?? [],
    healthy_count: diff?.healthy.length ?? 0,
    scanned_packages: input.scans.length,
    scan_errors: scanErrors,
  }
}

/** Readable reason for an unclassified package. */
export function unknownReasonText(reason: UnknownReason): string {
  switch (reason) {
    case 'no_literal_event_names':
      return '无法静态确定监听的事件名（变量、拼接或模板）'
    case 'no_event_listeners':
      return '源码中没有监听任何事件'
    case 'source_unreadable':
      return '源码不可读或解析失败'
  }
}

/** Readable label for the engine status line. */
export function engineStatusText(status: EngineStatus): string {
  switch (status) {
    case 'normal':
      return '正常'
    case 'catalog_unavailable':
      return '词表不可用'
    case 'self_check_failed':
      return '自检失败'
    case 'scan_partial':
      return '部分扫描'
  }
}

function versioned(pkg: string, version: string): string {
  return version === '' ? pkg : `${pkg}@${version}`
}

/**
 * Render the human-facing summary used by the sidebar and the text tool
 * output. Damaged entries come first and are never collapsed; healthy entries
 * collapse to a count.
 */
export function renderReportText(report: HealthReport): string {
  const lines: string[] = ['插件健康总览', '']

  lines.push(`● 确定性损坏 (${report.damaged.length})`)
  if (report.damaged.length === 0) {
    lines.push('    （未发现确定性损坏）')
  } else {
    for (const entry of report.damaged) {
      lines.push(`    ${versioned(entry.package, entry.version)}`)
      for (const event of entry.events) {
        lines.push(`      监听 ${event}，但当前版本词表中不存在`)
      }
      lines.push('      建议：检查该插件是否有新版本，或联系插件作者')
    }
  }
  lines.push('')

  lines.push(`○ 未检查 (${report.unknown.length})`)
  if (report.unknown.length === 0) {
    lines.push('    （无）')
  } else {
    for (const entry of report.unknown) {
      lines.push(`    ${versioned(entry.package, entry.version)}`)
      lines.push(`      原因：${unknownReasonText(entry.reason)}`)
    }
  }
  lines.push('')

  lines.push(`○ 健康 (${report.healthy_count})`)
  lines.push('')

  lines.push(`○ 体检引擎状态：${engineStatusText(report.engine_status)}`)
  if (report.engine_reason !== '') {
    lines.push(`    原因：${report.engine_reason}`)
  }
  for (const reason of report.degradations) {
    lines.push(`    降级：${DEGRADATION_TEXT[reason]}`)
  }
  if (report.engine_status === 'catalog_unavailable') {
    lines.push('    词表来源：不可用')
  } else {
    const label =
      report.catalog_source === 'builtin_snapshot' ? '内置快照' : 'persistence-catalog.md'
    const lagging =
      report.catalog_source === 'builtin_snapshot' ? '，可能滞后于当前 DSH 版本' : ''
    lines.push(`    词表来源：${label}（${report.catalog_version_hint}${lagging}）`)
  }
  lines.push(`    检查时间：${report.generated_at}`)
  if (report.scan_errors.length > 0) {
    lines.push('    扫描异常：')
    for (const error of report.scan_errors.slice(0, 20)) {
      lines.push(`      ${error}`)
    }
    if (report.scan_errors.length > 20) {
      lines.push(`      ……另有 ${report.scan_errors.length - 20} 条，见 JSON 报告`)
    }
  }

  return lines.join('\n')
}

/** The exact JSON text exposed by the tool's `format: "json"` mode. */
export function renderReportJson(report: HealthReport): string {
  return JSON.stringify(report, null, 2)
}

/** A one-line summary for compact consumers (used by logs). */
export function summarizeReport(report: HealthReport): string {
  return (
    `damaged=${report.damaged.length} unknown=${report.unknown.length} ` +
    `healthy=${report.healthy_count} status=${report.engine_status} ` +
    `catalog=${report.catalog_source}@${report.catalog_version_hint}`
  )
}
