import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Create an isolated temporary directory for one test. */
export function tempDir(prefix = 'dsh-sentinel-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
}

export function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

/**
 * Create a profile-shaped directory with a manifest and installed packages.
 *
 * `packages` maps a package name to `{ version, source?, manifest?, files? }`.
 * A package without `source` still gets a package.json, which is enough for
 * the "installed but unreadable entry" path.
 */
export function makeProfile(packages, options = {}) {
  const root = options.root ?? tempDir()
  const dependencies = {}
  for (const [name, pkg] of Object.entries(packages)) {
    dependencies[name] = options.linkSpecs?.[name] ?? `^${pkg.version}`
    const dir = path.join(root, 'node_modules', ...name.split('/'))
    writeJson(path.join(dir, 'package.json'), {
      name,
      version: pkg.version,
      type: 'module',
      main: pkg.main ?? './index.js',
      ...(pkg.manifest ?? {}),
    })
    if (pkg.source !== undefined) writeText(path.join(dir, pkg.main ?? 'index.js'), pkg.source)
    for (const [file, text] of Object.entries(pkg.files ?? {})) {
      writeText(path.join(dir, file), text)
    }
  }
  writeJson(path.join(root, 'package.json'), {
    name: 'dsh-profile-test',
    private: true,
    dependencies,
  })
  return root
}

/** Write a Markdown catalog in the format the loader accepts. */
export function writeCatalog(file, events, prefix = '') {
  const rows = events.map(([name, mode]) => `| \`${name}\` | \`${mode}\` |`).join('\n')
  writeText(file, [prefix, '| Event | Mode |', '| --- | --- |', rows, ''].join('\n'))
}

export const SAMPLE_EVENTS = [
  ['session/event', 'emit'],
  ['tools/pre-execute', 'waterfall'],
  ['agent/pre-step', 'waterfall'],
  ['webserver/index-inject', 'emit'],
]

/** A minimal ServerResponse stand-in. */
export function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers ?? {}
      return this
    },
    end(text = '') {
      this.body = text
      return this
    },
    get json() {
      return JSON.parse(this.body)
    },
  }
}

/** A minimal IncomingMessage stand-in for exact-route handlers. */
export function makeReq(method = 'GET') {
  const req = new EventEmitter()
  req.method = method
  req.headers = {}
  req.destroy = () => {}
  return req
}

/** Call a registered exact route and return the fake response. */
export async function callRoute(route, { method = 'GET', body = '' } = {}) {
  const req = makeReq(method)
  const res = makeRes()
  route.handler(req, res)
  if (method !== 'GET' && method !== 'HEAD') {
    if (body !== '') req.emit('data', Buffer.from(body))
    req.emit('end')
  }
  await new Promise((resolve) => setTimeout(resolve, 15))
  return res
}

/** A fake host context that records every surface the sentinel registers. */
export function makeHostContext({ tools = true, webServer = true, logger } = {}) {
  const registeredTools = []
  const routes = new Map()
  const disposers = []
  const services = {}

  if (tools) {
    services.tools = {
      register(definition) {
        registeredTools.push(definition)
        return () => {
          const index = registeredTools.indexOf(definition)
          if (index >= 0) registeredTools.splice(index, 1)
        }
      },
    }
  }
  if (webServer) {
    services.webServer = {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    }
  }

  const ctx = {
    logger: logger ?? { info() {}, warn() {} },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    inject(names, callback) {
      const child = { ...ctx }
      for (const name of names) child[name] = services[name]
      callback(child)
      return () => {}
    },
    get(name) {
      return services[name]
    },
  }

  return {
    ctx,
    registeredTools,
    routes,
    disposeAll() {
      while (disposers.length > 0) {
        const dispose = disposers.pop()
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    },
  }
}

/** Wait until `predicate()` is true or the timeout expires. */
export async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return predicate()
}
