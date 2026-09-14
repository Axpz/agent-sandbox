import { OpenAPIHono } from '@hono/zod-openapi'
import { MemoryConflict } from './checkpoint/model'
import {
  connectSandbox,
  createSandbox,
  getSandbox,
  killSandbox,
  listSandboxes,
  pauseSandbox,
  resumeSandbox,
  setSandboxTimeout,
} from './contract/routes'
import * as backend from './k8s/backend'
import { logger } from './logger'
import { observeLifecycleRequest } from './metrics'

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export const app = new OpenAPIHono()

// Structured request logging via pino.
app.use('*', async (c, next) => {
  const start = performance.now()
  await next()
  const ms = performance.now() - start
  observeLifecycleRequest(c.req.method, c.req.path, c.res.status, ms / 1000)
  logger.info({ method: c.req.method, path: c.req.path, status: c.res.status, ms }, 'request')
})

app.get('/health', (c) => c.json({ status: 'ok' }))

// Unexpected backend errors throw and are turned into a {code,message} 500 by
// app.onError below; only contract-declared statuses are returned inline.
app.openapi(createSandbox, async (c) => {
  const body = c.req.valid('json')
  const sb = await backend.createSandbox({
    templateID: body.templateID,
    envVars: body.envVars,
    metadata: body.metadata,
    timeout: body.timeout,
    autoPause: body.autoPause,
  })
  return c.json(sb, 201)
})

app.openapi(getSandbox, async (c) => {
  const { sandboxID } = c.req.valid('param')
  const detail = await backend.getSandbox(sandboxID)
  if (!detail) return c.json({ code: 404, message: `sandbox ${sandboxID} not found` }, 404)
  return c.json(detail, 200)
})

app.openapi(listSandboxes, async (c) => {
  const query = c.req.valid('query')
  try {
    const result = await backend.listSandboxes(query)
    if (result.nextToken) c.header('x-next-token', result.nextToken)
    return c.json(result.sandboxes, 200)
  } catch (e) {
    if (e instanceof backend.InvalidListQueryError) {
      return c.json({ code: 400, message: e.message }, 400)
    }
    throw e
  }
})

app.openapi(killSandbox, async (c) => {
  const { sandboxID } = c.req.valid('param')
  const killed = await backend.killSandbox(sandboxID)
  if (!killed) return c.json({ code: 404, message: `sandbox ${sandboxID} not found` }, 404)
  return c.body(null, 204)
})
app.openapi(setSandboxTimeout, async (c) => {
  const { sandboxID } = c.req.valid('param')
  const { timeout } = c.req.valid('json')
  const result = await backend.setSandboxTimeout(sandboxID, timeout)
  if (result.status === 'not-found') {
    return c.json({ code: 404, message: `sandbox ${sandboxID} not found` }, 404)
  }
  if (result.status === 'conflict') {
    return c.json({ code: 409, message: `sandbox ${sandboxID} is paused` }, 409)
  }
  return c.body(null, 204)
})
app.openapi(connectSandbox, async (c) => {
  const { sandboxID } = c.req.valid('param')
  const { timeout } = c.req.valid('json')
  const result = await backend.connectSandbox(sandboxID, timeout)
  if (result.status === 'not-found') {
    return c.json({ code: 404, message: `sandbox ${sandboxID} not found` }, 404)
  }
  return c.json(result.value, result.status === 'resumed' ? 201 : 200)
})
app.openapi(pauseSandbox, async (c) => {
  const { sandboxID } = c.req.valid('param')
  const result = await backend.pauseSandbox(sandboxID)
  if (result.status === 'not-found') {
    return c.json({ code: 404, message: `sandbox ${sandboxID} not found` }, 404)
  }
  if (result.status === 'conflict') {
    return c.json({ code: 409, message: `sandbox ${sandboxID} is already paused` }, 409)
  }
  return c.body(null, 204)
})

app.openapi(resumeSandbox, async (c) => {
  const { sandboxID } = c.req.valid('param')
  const body = c.req.valid('json')
  const result = await backend.resumeSandbox(sandboxID, body?.timeout ?? 15)
  if (result.status === 'not-found') {
    return c.json({ code: 404, message: `sandbox ${sandboxID} not found` }, 404)
  }
  if (result.status === 'conflict') {
    return c.json({ code: 409, message: `sandbox ${sandboxID} is already running` }, 409)
  }
  return c.json(result.value, 201)
})

// Any uncaught error → e2b-style {code,message} envelope.
app.onError((err, c) => {
  if (err instanceof MemoryConflict) return c.json({ code: 409, message: err.message }, 409)
  logger.error({ err: errMsg(err), method: c.req.method, path: c.req.path }, 'unhandled error')
  return c.json({ code: 500, message: errMsg(err) }, 500)
})

// Document the X-API-KEY scheme (enforcement lands in a later block).
app.openAPIRegistry.registerComponent('securitySchemes', 'ApiKeyAuth', {
  type: 'apiKey',
  in: 'header',
  name: 'X-API-KEY',
})

app.doc('/openapi.json', {
  openapi: '3.1.0',
  info: { title: 'sandbox-api', version: '0.0.1' },
})
