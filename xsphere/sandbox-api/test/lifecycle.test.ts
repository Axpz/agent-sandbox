import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { ListedSandboxes } from '../src/contract/schemas'
import type { JsonObject } from '../src/k8s/client'

type Condition = { type: string; status: string }
type Claim = {
  metadata: { name: string; creationTimestamp?: string; annotations?: Record<string, string> }
  spec: { lifecycle?: { shutdownTime: string }; [key: string]: unknown }
  status: { sandbox: { name: string }; conditions: Condition[] }
}
type Sandbox = {
  metadata: { name: string; ownerReferences: Array<{ kind: string; name: string }> }
  spec: { operatingMode: string; shutdownTime?: string; shutdownPolicy?: string }
  status: { conditions: Condition[] }
}

const claims = new Map<string, Claim>()
const sandboxes = new Map<string, Sandbox>()
let completeTransition = true

function read<T>(items: Map<string, T>, name: string): T {
  const item = items.get(name)
  if (!item) throw Object.assign(new Error('not found'), { code: 404 })
  return item
}

function bind(claim: Claim, id: string): void {
  claim.metadata.creationTimestamp ??= '2026-09-01T00:00:00Z'
  claim.status = { sandbox: { name: id }, conditions: [{ type: 'Ready', status: 'True' }] }
  claims.set(claim.metadata.name, claim)
  sandboxes.set(id, {
    metadata: {
      name: id,
      ownerReferences: [{ kind: 'SandboxClaim', name: claim.metadata.name }],
    },
    spec: { operatingMode: 'Running' },
    status: { conditions: [{ type: 'Ready', status: 'True' }] },
  })
}

const createClaim = mock(async (body: JsonObject) => {
  const claim = structuredClone(body) as Claim
  bind(claim, `bound-${claims.size}`)
  return structuredClone(claim)
})
const deleteClaim = mock(async (name: string) => {
  const claim = read(claims, name)
  sandboxes.delete(claim.status.sandbox.name)
  claims.delete(name)
})
const getSandbox = mock(async (name: string) => structuredClone(read(sandboxes, name)))
const listClaims = mock(async (_selector: string) => structuredClone([...claims.values()]))
const patchLifecycle = mock(async (name: string, shutdownTime: string) => {
  Object.assign(read(sandboxes, name).spec, { shutdownTime, shutdownPolicy: 'Retain' })
})
const patchClaimTime = mock(async (name: string, shutdownTime: string) => {
  read(claims, name).spec.lifecycle = { shutdownTime }
})
const patchMode = mock(async (name: string, operatingMode: string) => {
  const sandbox = read(sandboxes, name)
  sandbox.spec.operatingMode = operatingMode
  sandbox.status.conditions = completeTransition
    ? [{ type: operatingMode === 'Suspended' ? 'Suspended' : 'Ready', status: 'True' }]
    : []
})

// Exercise the real HTTP contract and backend; only the Kubernetes boundary is fake.
mock.module('../src/k8s/client', () => ({
  CLAIM_GVR: { group: 'extensions.agents.x-k8s.io', version: 'v1beta1' },
  createClaimCR: createClaim,
  deleteClaimCR: deleteClaim,
  getClaimCR: async (name: string) => structuredClone(read(claims, name)),
  getSandboxCR: getSandbox,
  listClaimCRs: listClaims,
  patchSandboxLifecycle: patchLifecycle,
  patchClaimShutdownTime: patchClaimTime,
  patchSandboxOperatingMode: patchMode,
  isNotFound: (error: { code?: number }) => error.code === 404,
}))

const { app } = await import('../src/app')
const { config } = await import('../src/config')

function request(path: string, method = 'GET', body?: unknown) {
  return app.request(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
}

beforeEach(() => {
  claims.clear()
  sandboxes.clear()
  for (const fn of [
    createClaim,
    deleteClaim,
    getSandbox,
    listClaims,
    patchLifecycle,
    patchClaimTime,
    patchMode,
  ]) {
    fn.mockClear()
  }
  config.createTimeoutMs = 20
  config.createPollMs = 1
  completeTransition = true
  bind(
    {
      metadata: {
        name: 'claim-a',
        annotations: {
          'sandbox-api/template-id': 'arm-business',
          'sandbox-api.metadata/team': 'a',
        },
      },
      spec: {},
      status: { sandbox: { name: 'sandbox-a' }, conditions: [] },
    },
    'sandbox-a',
  )
})

describe('imported sandbox-api compatibility', () => {
  test('health and OpenAPI retain their names and paths', async () => {
    expect(await (await request('/health')).json()).toEqual({ status: 'ok' })
    const spec = (await (await request('/openapi.json')).json()) as {
      info: { title: string }
      paths: Record<string, unknown>
    }
    expect(spec.info.title).toBe('sandbox-api')
    expect(spec.paths['/sandboxes/{sandboxID}/connect']).toBeDefined()
  })

  test('create returns the bound Sandbox ID and keeps camelCase/defaults', async () => {
    const before = Date.now()
    const response = await request('/sandboxes', 'POST', {
      templateID: 'arm-business',
      envVars: { TASK: 'test' },
      metadata: { team: 'a' },
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      clientID: 'sandbox-api',
      sandboxID: 'bound-1',
      templateID: 'arm-business',
      envdVersion: config.envdVersion,
    })
    const body = createClaim.mock.calls[0][0]
    expect(body).toMatchObject({
      metadata: { labels: { 'app.kubernetes.io/managed-by': 'sandbox-api' } },
      spec: { warmPoolRef: { name: config.warmPool }, env: [{ name: 'TASK', value: 'test' }] },
    })
    expect((body.spec as Claim['spec']).lifecycle).toBeUndefined()
    expect(Date.parse(patchLifecycle.mock.calls[0][1])).toBeGreaterThanOrEqual(before + 7200000)
  })

  test('non-autoPause create keeps the lease on the Claim', async () => {
    expect(
      (await request('/sandboxes', 'POST', { templateID: 'base', autoPause: false, timeout: 60 }))
        .status,
    ).toBe(201)
    expect(createClaim.mock.calls[0][0]).toMatchObject({
      spec: { lifecycle: { shutdownPolicy: 'Retain' } },
    })
    expect(patchLifecycle).not.toHaveBeenCalled()
  })

  test('pause/resume preserves ownership and performs only operatingMode transitions', async () => {
    expect((await request('/sandboxes/sandbox-a/pause', 'POST')).status).toBe(204)
    expect((await request('/sandboxes/sandbox-a/pause', 'POST')).status).toBe(409)
    expect((await request('/sandboxes/sandbox-a/timeout', 'POST', { timeout: 60 })).status).toBe(
      409,
    )
    expect((await request('/sandboxes/sandbox-a/resume', 'POST', {})).status).toBe(201)
    expect((await request('/sandboxes/sandbox-a/resume', 'POST', {})).status).toBe(409)
    expect(patchMode.mock.calls).toEqual([
      ['sandbox-a', 'Suspended'],
      ['sandbox-a', 'Running'],
    ])
    expect(deleteClaim).not.toHaveBeenCalled()
    expect(read(claims, 'claim-a').status.sandbox.name).toBe('sandbox-a')
  })

  test('failed resume reports failure without deleting the Claim or Sandbox', async () => {
    await request('/sandboxes/sandbox-a/pause', 'POST')
    completeTransition = false
    const response = await request('/sandboxes/sandbox-a/resume', 'POST', { timeout: 60 })
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ code: 500 })
    expect(deleteClaim).not.toHaveBeenCalled()
    expect(claims.has('claim-a')).toBe(true)
    expect(sandboxes.has('sandbox-a')).toBe(true)
  })

  test('connect does not shorten a running lease and resumes a paused Sandbox', async () => {
    read(sandboxes, 'sandbox-a').spec.shutdownTime = '2099-01-01T00:00:00Z'
    expect((await request('/sandboxes/sandbox-a/connect', 'POST', { timeout: 60 })).status).toBe(
      200,
    )
    expect(patchLifecycle).not.toHaveBeenCalled()
    expect(patchMode).not.toHaveBeenCalled()
    await request('/sandboxes/sandbox-a/pause', 'POST')
    expect((await request('/sandboxes/sandbox-a/connect', 'POST', { timeout: 60 })).status).toBe(
      201,
    )
  })

  test('timeout selects the correct lifecycle owner', async () => {
    expect((await request('/sandboxes/sandbox-a/timeout', 'POST', { timeout: 60 })).status).toBe(
      204,
    )
    expect(patchLifecycle.mock.calls[0][0]).toBe('sandbox-a')
    read(claims, 'claim-a').spec.lifecycle = { shutdownTime: '2026-01-01T00:00:00Z' }
    expect((await request('/sandboxes/sandbox-a/timeout', 'POST', { timeout: 60 })).status).toBe(
      204,
    )
    expect(patchClaimTime.mock.calls[0][0]).toBe('claim-a')
  })

  test('detail, metadata filtering and pagination retain the SDK wire contract', async () => {
    expect(await (await request('/sandboxes/sandbox-a')).json()).toMatchObject({
      sandboxID: 'sandbox-a',
      state: 'running',
      metadata: { team: 'a' },
    })
    const second = structuredClone(read(claims, 'claim-a'))
    second.metadata.name = 'claim-b'
    bind(second, 'sandbox-b')
    const first = await request('/v2/sandboxes?limit=1&metadata=team%253Da')
    expect(
      ListedSandboxes.parse(await first.json()).map(
        (item: { sandboxID: string }) => item.sandboxID,
      ),
    ).toEqual(['sandbox-a'])
    const token = first.headers.get('x-next-token')
    expect(token).toBeTruthy()
    const next = await request(`/v2/sandboxes?limit=1&nextToken=${token}`)
    expect(
      ListedSandboxes.parse(await next.json()).map((item: { sandboxID: string }) => item.sandboxID),
    ).toEqual(['sandbox-b'])
    expect(next.headers.get('x-next-token')).toBeNull()
    expect(listClaims.mock.calls[0][0]).toBe('app.kubernetes.io/managed-by=sandbox-api')
    expect((await request('/v2/sandboxes?state=unknown')).status).toBe(400)
    expect((await request('/v2/sandboxes?nextToken=invalid')).status).toBe(400)
  })

  test('kill deletes the owning Claim, not an arbitrary resource name', async () => {
    expect((await request('/sandboxes/sandbox-a', 'DELETE')).status).toBe(204)
    expect(deleteClaim.mock.calls).toEqual([['claim-a']])
    expect((await request('/sandboxes/sandbox-a', 'DELETE')).status).toBe(404)
    expect((await request('/sandboxes/missing/pause', 'POST')).status).toBe(404)
    expect((await request('/sandboxes/missing/connect', 'POST', { timeout: 60 })).status).toBe(404)
  })

  test('invalid create bodies fail before touching Kubernetes', async () => {
    expect((await request('/sandboxes', 'POST', { templateId: 'wrong-case' })).status).toBe(400)
    expect(createClaim).not.toHaveBeenCalled()
  })
})
