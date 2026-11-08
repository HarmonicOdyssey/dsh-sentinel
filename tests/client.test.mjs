import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const CLIENT_FILE = path.resolve('client/client.js')
const CLIENT_SOURCE = fs.readFileSync(CLIENT_FILE, 'utf8')

const ReactStub = {
  createElement: (...args) => ({ args }),
  useState: () => [null, () => {}],
  useEffect: () => {},
  useCallback: (callback) => callback,
}

/** Evaluate the loader bundle and return the plugin's `apply` plus fetch calls. */
function loadClient() {
  let plugin = null
  const fetchCalls = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(entry) {
          plugin = entry.factory(() => ReactStub)
        },
      },
    },
    fetch: (url, init) => {
      fetchCalls.push({ url, init })
      return Promise.resolve({ ok: true, json: async () => ({}) })
    },
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    console,
  }
  vm.runInNewContext(CLIENT_SOURCE, sandbox, { filename: 'client.js' })
  assert.ok(plugin, 'client bundle should register a factory')
  return { plugin, fetchCalls }
}

function makeSlots() {
  const registrations = []
  return {
    registrations,
    slots: {
      register(definition, component) {
        registrations.push({ kind: 'body', definition, component })
        return () => {}
      },
      inject(name, callback) {
        registrations.push({ kind: 'inject', name })
        return callback()
      },
    },
  }
}

function makeTabs({ throws = false } = {}) {
  const registrations = []
  return {
    registrations,
    tabs: {
      register(definition) {
        if (throws) throw new Error('duplicate tab id')
        registrations.push(definition)
        return () => {}
      },
    },
  }
}

function makeCtx({ tabs, slots, tabsThrows = false } = {}) {
  const disposers = []
  const ctx = {
    get(name) {
      if (name === 'sidebarRightTabs') return tabs
      if (name === 'slots') return slots
      return undefined
    },
    slots,
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
  }
  if (tabs) ctx.sidebarRightTabs = tabs
  return { ctx, disposers }
}

test('client registers a native sidebar tab and its body', () => {
  const { plugin } = loadClient()
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'sidebarRightTabs'])

  const { slots, registrations: slotRegistrations } = makeSlots()
  const { tabs, registrations: tabRegistrations } = makeTabs()
  const { ctx, disposers } = makeCtx({ tabs, slots })

  assert.doesNotThrow(() => plugin.apply(ctx))
  assert.equal(tabRegistrations.length, 1)
  assert.equal(tabRegistrations[0].id, 'dsh-sentinel')
  assert.equal(tabRegistrations[0].kind, 'sentinel')
  assert.equal(tabRegistrations[0].title(), '插件健康')
  assert.equal(Array.isArray(tabRegistrations[0].guide), true)
  assert.equal(tabRegistrations[0].guide[0].id, 'health')

  const body = slotRegistrations.find((entry) => entry.kind === 'body')
  assert.ok(body)
  assert.equal(body.definition.name, 'sidebar.right.pane.tab')
  assert.equal(body.definition.key, 'dsh-sentinel')
  assert.equal(typeof body.component, 'function')

  assert.ok(disposers.length >= 1)
  assert.doesNotThrow(() => disposers.forEach((dispose) => dispose()))
})

test('client reports a failed panel registration to the host instead of throwing', async () => {
  const { plugin, fetchCalls } = loadClient()
  const { ctx } = makeCtx({ tabs: undefined, slots: undefined })
  assert.doesNotThrow(() => plugin.apply(ctx))
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0].url, '/dsh-sentinel/degraded')
  assert.equal(fetchCalls[0].init.method, 'POST')
  assert.equal(JSON.parse(fetchCalls[0].init.body).reason, 'panel_register_failed')
})

test('client survives a throwing tab registration and still reports once', async () => {
  const { plugin, fetchCalls } = loadClient()
  const { slots } = makeSlots()
  const { tabs } = makeTabs({ throws: true })
  const { ctx } = makeCtx({ tabs, slots })
  assert.doesNotThrow(() => plugin.apply(ctx))
  assert.equal(fetchCalls.length, 1)
})

test('client never throws when the host ctx is empty', () => {
  const { plugin, fetchCalls } = loadClient()
  assert.doesNotThrow(() => plugin.apply({}))
  assert.equal(fetchCalls.length, 1)
})
