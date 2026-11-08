import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { apply, DEGRADED_ROUTE, REPORT_ROUTE } from '../lib/index.js'
import {
  callRoute,
  makeHostContext,
  makeProfile,
  removeDir,
  waitFor,
} from './helpers.mjs'

async function reportFromRoute(routes) {
  const ready = await waitFor(() => routes.has(REPORT_ROUTE))
  assert.equal(ready, true, 'report route should be registered')
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const response = await callRoute(routes.get(REPORT_ROUTE))
    const body = response.json
    if (body.engine_status !== undefined) return body
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('report route never became ready')
}

test('apply never throws when host surfaces are missing', () => {
  const profile = makeProfile({
    'fixture-plugin': {
      version: '1.0.0',
      source: "ctx.on('removed/event', () => {})\n",
    },
  })
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = profile
  try {
    // No tools, no webServer, no sidebar: the host half must still return.
    const host = makeHostContext({ tools: false, webServer: false })
    assert.doesNotThrow(() => apply(host.ctx))
    host.disposeAll()

    // A host whose inject throws for one surface must also be survivable.
    const throwing = makeHostContext()
    const originalInject = throwing.ctx.inject
    throwing.ctx.inject = (names, callback) => {
      if (names.includes('webServer')) throw new Error('sidebar registration unavailable')
      return originalInject(names, callback)
    }
    assert.doesNotThrow(() => apply(throwing.ctx))
    throwing.disposeAll()
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
    removeDir(profile)
  }
})

test('apply registers the tool and the report route, and both expose the same report', async () => {
  const profile = makeProfile({
    'fixture-plugin': {
      version: '1.0.0',
      source: "ctx.on('removed/event', () => {})\n",
    },
  })
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = profile
  const host = makeHostContext()
  try {
    apply(host.ctx)
    assert.equal(host.registeredTools.length, 1)
    assert.equal(host.registeredTools[0].name, 'plugin_health_report')
    assert.match(host.registeredTools[0].description, /返回当前已安装插件的健康检查结果/)

    const body = await reportFromRoute(host.routes)
    assert.equal(body.engine_status, 'normal')
    assert.deepEqual(
      body.damaged.map((entry) => [entry.package, entry.events]),
      [['fixture-plugin', ['removed/event']]],
    )

    const text = await host.registeredTools[0].execute({})
    assert.match(text, /插件健康总览/)
    assert.match(text, /体检引擎状态：正常/)
    assert.match(text, /fixture-plugin@1\.0\.0/)

    const json = JSON.parse(await host.registeredTools[0].execute({ format: 'json' }))
    assert.equal(json.engine_status, 'normal')
    assert.equal(json.catalog_source, 'builtin_snapshot')
  } finally {
    host.disposeAll()
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
    removeDir(profile)
  }
})

test('a failed startup self-check settles immediately and explains itself', async () => {
  const previous = process.env.DSH_PROFILE_DIR
  const missingProfile = path.join(process.cwd(), '.tmp', 'does-not-exist-profile')
  process.env.DSH_PROFILE_DIR = missingProfile
  const host = makeHostContext()
  try {
    apply(host.ctx)
    assert.equal(host.registeredTools.length, 1)
    const started = Date.now()
    const text = await host.registeredTools[0].execute({})
    assert.ok(Date.now() - started < 2000, 'a self-check failure must not wait for a scan')
    assert.match(text, /体检引擎状态：自检失败/)
    assert.match(text, /无法读取 profile 插件清单/)

    const body = await reportFromRoute(host.routes)
    assert.equal(body.engine_status, 'self_check_failed')
    assert.deepEqual(body.damaged, [])
  } finally {
    host.disposeAll()
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
  }
})

test('a failed panel registration degrades only the panel: the tool still returns a report', async () => {
  const profile = makeProfile({
    'fixture-plugin': {
      version: '1.0.0',
      source: "ctx.on('removed/event', () => {})\n",
    },
  })
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = profile
  const host = makeHostContext()
  try {
    apply(host.ctx)
    await waitFor(() => host.routes.has(REPORT_ROUTE))

    const response = await callRoute(host.routes.get(DEGRADED_ROUTE), {
      method: 'POST',
      body: JSON.stringify({ reason: 'panel_register_failed' }),
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json, { ok: true })

    const text = await host.registeredTools[0].execute({})
    assert.match(text, /体检引擎状态：自检失败/)
    assert.match(text, /降级：侧边栏注册接口不可用/)
    assert.match(text, /回退到仅工具\/JSON 输出/)
  } finally {
    host.disposeAll()
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
    removeDir(profile)
  }
})

test('a missing configured catalog falls back to the packaged snapshot', async () => {
  const profile = makeProfile({
    'fixture-plugin': {
      version: '1.0.0',
      source: "ctx.on('removed/event', () => {})\n",
    },
  })
  const previousProfile = process.env.DSH_PROFILE_DIR
  const previousCatalog = process.env.DSH_SENTINEL_CATALOG
  process.env.DSH_PROFILE_DIR = profile
  process.env.DSH_SENTINEL_CATALOG = path.join(profile, 'missing-catalog.md')
  const host = makeHostContext()
  try {
    apply(host.ctx)
    const body = await reportFromRoute(host.routes)
    // A configured-but-absent catalog quietly falls back to the packaged
    // snapshot; the report still names the degraded vocabulary provenance.
    assert.equal(body.engine_status, 'normal')
    assert.equal(body.catalog_source, 'builtin_snapshot')
    assert.deepEqual(
      body.damaged.map((entry) => entry.package),
      ['fixture-plugin'],
    )
  } finally {
    host.disposeAll()
    if (previousProfile === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previousProfile
    if (previousCatalog === undefined) delete process.env.DSH_SENTINEL_CATALOG
    else process.env.DSH_SENTINEL_CATALOG = previousCatalog
    removeDir(profile)
  }
})

test('the report route rejects non-GET methods', async () => {
  const profile = makeProfile({})
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = profile
  const host = makeHostContext()
  try {
    apply(host.ctx)
    await waitFor(() => host.routes.has(REPORT_ROUTE))
    const response = await callRoute(host.routes.get(REPORT_ROUTE), { method: 'POST' })
    assert.equal(response.statusCode, 405)
  } finally {
    host.disposeAll()
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
    removeDir(profile)
  }
})
