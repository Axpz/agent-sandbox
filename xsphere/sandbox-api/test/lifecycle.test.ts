import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { V1ConfigMap, V1Job, V1ObjectMeta, V1Pod } from '@kubernetes/client-node'
import {
  MEMORY_LABEL,
  RESTORE_ANNOTATION,
  recordSchema,
  type WorkerRequest,
} from '../src/checkpoint/model'
import { ListedSandboxes } from '../src/contract/schemas'
import type { JsonObject } from '../src/k8s/client'

type Condition = { type: string; status: string }
type Claim = {
  metadata: Omit<V1ObjectMeta, 'creationTimestamp'> & { name: string; creationTimestamp?: string }
  spec: { lifecycle?: { shutdownTime: string }; [key: string]: unknown }
  status: { sandbox: { name: string }; conditions: Condition[] }
}
type Sandbox = {
  metadata: V1ObjectMeta & { name: string }
  spec: {
    operatingMode: string
    shutdownTime?: string
    shutdownPolicy?: string
    podTemplate?: { metadata?: V1ObjectMeta; spec?: V1Pod['spec'] }
  }
  status: { conditions: Condition[] }
}

const claims = new Map<string, Claim>()
const sandboxes = new Map<string, Sandbox>()
let completeTransition = true
const configMaps = new Map<string, V1ConfigMap>()
const jobs = new Map<string, V1Job>()
const pods = new Map<string, V1Pod>()
let failWorker: string | null = null
let failSuspension = false
let workerPending = false
const workerActions: string[] = []

function read<T>(items: Map<string, T>, name: string): T {
  const item = items.get(name)
  if (!item) throw Object.assign(new Error('not found'), { code: 404 })
  return item
}

function bind(claim: Claim, id: string): void {
  claim.metadata.uid ??= crypto.randomUUID()
  claim.metadata.resourceVersion ??= '1'
  claim.metadata.creationTimestamp ??= '2026-09-01T00:00:00Z'
  claim.status = { sandbox: { name: id }, conditions: [{ type: 'Ready', status: 'True' }] }
  claims.set(claim.metadata.name, claim)
  sandboxes.set(id, {
    metadata: {
      name: id,
      uid: crypto.randomUUID(),
      ownerReferences: [
        {
          apiVersion: 'extensions.agents.x-k8s.io/v1beta1',
          kind: 'SandboxClaim',
          name: claim.metadata.name,
          uid: claim.metadata.uid,
        },
      ],
    },
    spec: { operatingMode: 'Running' },
    status: { conditions: [{ type: 'Ready', status: 'True' }] },
  })
  if (claim.metadata.labels?.[MEMORY_LABEL] === 'true') {
    const sandbox = read(sandboxes, id)
    sandbox.spec.podTemplate = {
      spec: {
        runtimeClassName: 'gvisor',
        nodeSelector: { 'kubernetes.io/hostname': 'node-a' },
        restartPolicy: 'Never',
        containers: [{ name: 'runtime', image: `example@sha256:${'a'.repeat(64)}` }],
      },
    }
    createPod(sandbox)
  }
}

function createPod(sandbox: Sandbox): void {
  pods.set(sandbox.metadata.name, {
    metadata: {
      name: sandbox.metadata.name,
      uid: crypto.randomUUID(),
      annotations: sandbox.spec.podTemplate?.metadata?.annotations,
      ownerReferences: [
        {
          apiVersion: 'agents.x-k8s.io/v1beta1',
          kind: 'Sandbox',
          name: sandbox.metadata.name,
          uid: sandbox.metadata.uid ?? '',
        },
      ],
    },
    spec: {
      ...sandbox.spec.podTemplate?.spec,
      nodeName: 'node-a',
      containers: sandbox.spec.podTemplate?.spec?.containers ?? [],
    },
    status: {
      conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [
        {
          name: 'runtime',
          image: 'example',
          imageID: 'sha256:abc',
          ready: true,
          restartCount: 0,
          containerID: `containerd://${'c'.repeat(64)}`,
          state: { running: {} },
        },
      ],
    },
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
  if (failSuspension && operatingMode === 'Suspended') throw new Error('suspension unavailable')
  const sandbox = read(sandboxes, name)
  sandbox.spec.operatingMode = operatingMode
  sandbox.status.conditions = completeTransition
    ? [{ type: operatingMode === 'Suspended' ? 'Suspended' : 'Ready', status: 'True' }]
    : []
  if (sandbox.spec.podTemplate) {
    if (operatingMode === 'Suspended') pods.delete(name)
    else if (completeTransition && !pods.has(name)) createPod(sandbox)
  }
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
  patchClaimRestore: async (name: string, _rv: string, path: string) => {
    const claim = read(claims, name)
    claim.spec.additionalPodMetadata = { annotations: { [RESTORE_ANNOTATION]: path } }
    const sandbox = read(sandboxes, claim.status.sandbox.name)
    if (sandbox.spec.podTemplate)
      sandbox.spec.podTemplate.metadata = { annotations: { [RESTORE_ANNOTATION]: path } }
  },
  coreApi: {
    createNamespacedConfigMap: async ({ body }: { body: V1ConfigMap }) => {
      const cm = structuredClone(body)
      cm.metadata = { ...cm.metadata, uid: crypto.randomUUID(), resourceVersion: '1' }
      configMaps.set(cm.metadata.name ?? '', cm)
      return structuredClone(cm)
    },
    readNamespacedConfigMap: async ({ name }: { name: string }) =>
      structuredClone(read(configMaps, name)),
    replaceNamespacedConfigMap: async ({ name, body }: { name: string; body: V1ConfigMap }) => {
      configMaps.set(name, structuredClone(body))
      return structuredClone(body)
    },
    listNamespacedConfigMap: async () => ({ items: structuredClone([...configMaps.values()]) }),
    readNamespacedPod: async ({ name }: { name: string }) => structuredClone(read(pods, name)),
    listNamespacedPod: async ({ labelSelector }: { labelSelector: string }) => {
      if (workerPending) return { items: [] }
      const job = read(jobs, labelSelector.split('=')[1])
      const request = JSON.parse(
        job.spec?.template.spec?.containers[0]?.env?.find(
          (entry) => entry.name === 'CHECKPOINT_REQUEST',
        )?.value ?? '',
      ) as WorkerRequest
      const checkpoint =
        request.action === 'save'
          ? {
              id: request.id,
              source: request.source,
              rootID: 'd'.repeat(64),
              path: `/var/lib/checkpoints/${request.source.sandboxUID}/${request.id}`,
              runscSha256: 'b'.repeat(64),
              createdAt: new Date().toISOString(),
              files: ['checkpoint.img', 'pages.img', 'pages_meta.img'].map((name) => ({
                name,
                size: 10,
                sha256: 'e'.repeat(64),
              })),
            }
          : undefined
      const failed = request.action === failWorker
      return {
        items: [
          {
            metadata: { ownerReferences: [{ uid: job.metadata?.uid }] },
            status: {
              containerStatuses: [
                {
                  state: {
                    terminated: {
                      exitCode: failed ? 1 : 0,
                      message: JSON.stringify({
                        ok: !failed,
                        checkpoint,
                        error: failed ? 'worker failed' : undefined,
                      }),
                    },
                  },
                },
              ],
            },
          },
        ],
      }
    },
  },
  batchApi: {
    readNamespacedJob: async ({ name }: { name: string }) => structuredClone(read(jobs, name)),
    createNamespacedJob: async ({ body }: { body: V1Job }) => {
      const job = structuredClone(body)
      job.metadata = { ...job.metadata, uid: crypto.randomUUID() }
      const request = JSON.parse(
        job.spec?.template.spec?.containers[0]?.env?.find(
          (entry) => entry.name === 'CHECKPOINT_REQUEST',
        )?.value ?? '',
      ) as WorkerRequest
      workerActions.push(request.action)
      jobs.set(job.metadata.name ?? '', job)
      return structuredClone(job)
    },
    listNamespacedJob: async () => ({ items: structuredClone([...jobs.values()]) }),
    deleteNamespacedJob: async ({ name }: { name: string }) => {
      jobs.delete(name)
    },
  },
}))

const { app } = await import('../src/app')
const { config } = await import('../src/config')
const { metricsApp, metricsRegistry } = await import('../src/metrics')

function request(path: string, method = 'GET', body?: unknown) {
  return app.request(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
}

beforeEach(() => {
  metricsRegistry.resetMetrics()
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
  config.checkpoint = null
  configMaps.clear()
  jobs.clear()
  pods.clear()
  workerActions.length = 0
  failWorker = null
  failSuspension = false
  workerPending = false
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

describe('lifecycle request metrics', () => {
  async function count(operation: string, result: string) {
    const [metric] = await metricsRegistry.getMetricsAsJSON()
    return metric?.values.find(
      (sample) =>
        'metricName' in sample &&
        sample.metricName === 'sandbox_api_lifecycle_request_duration_seconds_count' &&
        sample.labels.operation === operation &&
        sample.labels.result === result,
    )?.value
  }

  test('counts completed requests and keeps connect separate from explicit resume', async () => {
    expect((await request('/sandboxes/sandbox-a/pause', 'POST')).status).toBe(204)
    expect((await request('/sandboxes/sandbox-a/pause', 'POST')).status).toBe(409)
    expect((await request('/sandboxes/missing/pause', 'POST')).status).toBe(404)
    expect((await request('/sandboxes/sandbox-a/resume', 'POST', { timeout: 60 })).status).toBe(201)
    expect((await request('/sandboxes/sandbox-a/connect', 'POST', { timeout: 60 })).status).toBe(
      200,
    )
    expect(await count('pause', 'success')).toBe(1)
    expect(await count('pause', 'client_error')).toBe(2)
    expect(await count('resume', 'success')).toBe(1)
    expect(await count('connect', 'success')).toBe(1)
  })

  test('records thrown checkpoint failures without changing error handling', async () => {
    const id = await createMemorySandbox()
    failWorker = 'save'
    expect((await request(`/sandboxes/${id}/pause`, 'POST')).status).toBe(500)
    expect(await count('pause', 'server_error')).toBe(1)
    expect(await count('pause', 'success')).toBeUndefined()
    expect(pods.has(id)).toBe(true)
    expect(deleteClaim).not.toHaveBeenCalled()
  })

  test('exposes seconds and bounded labels only on the internal metrics app', async () => {
    await request('/sandboxes/sandbox-a/pause', 'POST')
    const response = await metricsApp.request('/metrics')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/plain')
    const text = await response.text()
    expect(text).toContain('sandbox_api_lifecycle_request_duration_seconds_sum{')
    expect(text).not.toContain('sandbox-a')
    expect(text).not.toContain('/sandboxes/')
    expect((await request('/metrics')).status).toBe(404)
    expect((await metricsApp.request('/sandboxes')).status).toBe(404)
    expect(await count('pause', 'success')).toBe(1)
  })
})

async function createMemorySandbox(): Promise<string> {
  config.checkpoint = {
    runtimeClassName: 'gvisor',
    nodeName: 'node-a',
    runscBinary: '/var/lib/runtime/runsc',
    runscRoot: '/run/containerd/runsc/k8s.io',
    artifactRoot: '/var/lib/checkpoints',
    runscSha256: 'b'.repeat(64),
    workerImage: 'api:immutable-test',
    timeoutSeconds: 30,
  }
  const response = await request('/sandboxes', 'POST', {
    templateID: 'arm-business',
    timeout: 7200,
  })
  expect(response.status).toBe(201)
  return ((await response.json()) as { sandboxID: string }).sandboxID
}

describe('memory lifecycle through the existing HTTP API', () => {
  test('a failed suspension can be retried without taking another checkpoint', async () => {
    const id = await createMemorySandbox()
    failSuspension = true
    expect((await request(`/sandboxes/${id}/pause`, 'POST')).status).toBe(500)
    failSuspension = false
    expect((await request(`/sandboxes/${id}/pause`, 'POST')).status).toBe(204)
    expect(workerActions).toEqual(['save'])
    expect(deleteClaim).not.toHaveBeenCalled()
  })
  test('autoPause uses the same save/stop flow and recovers a journalled operation after restart', async () => {
    const id = await createMemorySandbox()
    const { startMemoryReconciler } = await import('../src/checkpoint/lifecycle')
    await request(`/sandboxes/${id}/timeout`, 'POST', { timeout: 0 })
    let stop = startMemoryReconciler(1)
    try {
      while (!jobs.size) await Bun.sleep(1)
      stop()
      const record = recordSchema.parse(JSON.parse([...configMaps.values()][0].data?.record ?? ''))
      expect(record.operation?.action).toBe('pause')
      stop = startMemoryReconciler(1)
      const deadline = Date.now() + 2000
      while (
        ((await (await request(`/sandboxes/${id}`)).json()) as { state: string }).state !== 'paused'
      ) {
        if (Date.now() > deadline) throw new Error('autoPause did not finish')
        await Bun.sleep(1)
      }
      expect(workerActions).toEqual(['save'])
      expect(pods.has(id)).toBe(false)
      expect(patchLifecycle).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })
  test('create owns expiry; pause saves before suspension and connect restores without deleting ownership', async () => {
    const id = await createMemorySandbox()
    const originalPodUID = read(pods, id).metadata?.uid
    expect(patchLifecycle).not.toHaveBeenCalled()
    expect(await (await request(`/sandboxes/${id}`)).json()).toMatchObject({
      metadata: { 'xsphere.io/pause-mode': 'memory' },
    })
    expect((await request(`/sandboxes/${id}/pause`, 'POST')).status).toBe(204)
    expect(workerActions).toEqual(['save'])
    expect(read(sandboxes, id).spec.operatingMode).toBe('Suspended')
    expect(pods.has(id)).toBe(false)
    expect((await request(`/sandboxes/${id}/connect`, 'POST', { timeout: 7200 })).status).toBe(201)
    expect(workerActions).toEqual(['save', 'verify'])
    expect(read(pods, id).metadata?.uid).not.toBe(originalPodUID)
    expect(read(pods, id).metadata?.annotations?.[RESTORE_ANNOTATION]).toStartWith(
      '/var/lib/checkpoints/',
    )
    expect(deleteClaim).not.toHaveBeenCalled()
  })

  test('failed save stays failed without retrying, suspending or deleting the Pod', async () => {
    const id = await createMemorySandbox()
    failWorker = 'save'
    expect((await request(`/sandboxes/${id}/pause`, 'POST')).status).toBe(500)
    expect((await request(`/sandboxes/${id}/pause`, 'POST')).status).toBe(500)
    expect(workerActions).toEqual(['save'])
    expect(patchMode).not.toHaveBeenCalled()
    expect(pods.has(id)).toBe(true)
    expect(deleteClaim).not.toHaveBeenCalled()
  })

  test('a failed subsequent pause preserves the previous successful checkpoint record', async () => {
    const id = await createMemorySandbox()
    await request(`/sandboxes/${id}/pause`, 'POST')
    const saved = recordSchema.parse(
      JSON.parse([...configMaps.values()][0].data?.record ?? ''),
    ).checkpoint
    await request(`/sandboxes/${id}/resume`, 'POST', { timeout: 60 })
    failWorker = 'save'
    expect((await request(`/sandboxes/${id}/pause`, 'POST')).status).toBe(500)
    const record = recordSchema.parse(JSON.parse([...configMaps.values()][0].data?.record ?? ''))
    expect(record.checkpoint).toEqual(saved)
    expect(record.error).toBeDefined()
    expect(deleteClaim).not.toHaveBeenCalled()
  })

  test('failed validation never starts a new Pod or removes the artifact', async () => {
    const id = await createMemorySandbox()
    await request(`/sandboxes/${id}/pause`, 'POST')
    patchMode.mockClear()
    failWorker = 'verify'
    expect((await request(`/sandboxes/${id}/connect`, 'POST', { timeout: 60 })).status).toBe(500)
    expect(patchMode).not.toHaveBeenCalled()
    expect(pods.has(id)).toBe(false)
    const record = recordSchema.parse(JSON.parse([...configMaps.values()][0].data?.record ?? ''))
    expect(record.state).toBe('paused')
    expect(record.checkpoint).toBeDefined()
    expect(deleteClaim).not.toHaveBeenCalled()
  })

  test('disabling configuration cannot silently use legacy pause/resume', async () => {
    const id = await createMemorySandbox()
    config.checkpoint = null
    expect((await request(`/sandboxes/${id}/pause`, 'POST')).status).toBe(500)
    expect(patchMode).not.toHaveBeenCalled()
  })

  test('timeout and deletion conflict with an active save; no concurrent lifecycle mutation', async () => {
    const id = await createMemorySandbox()
    workerPending = true
    const pausing = request(`/sandboxes/${id}/pause`, 'POST')
    while (!jobs.size) await Bun.sleep(1)
    expect((await request(`/sandboxes/${id}/timeout`, 'POST', { timeout: 60 })).status).toBe(409)
    expect((await request(`/sandboxes/${id}`, 'DELETE')).status).toBe(409)
    expect(deleteClaim).not.toHaveBeenCalled()
    workerPending = false
    expect((await pausing).status).toBe(204)
  })
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
