import type { V1ConfigMap, V1Pod } from '@kubernetes/client-node'
import { config } from '../config'
import {
  CLAIM_GVR,
  coreApi,
  deleteClaimCR,
  getClaimCR,
  getSandboxCR,
  isNotFound,
  type JsonObject,
  patchClaimRestore,
  patchSandboxOperatingMode,
} from '../k8s/client'
import { logger } from '../logger'
import { cleanJobs, pollWorker, WorkerFailed } from './jobs'
import {
  MEMORY_LABEL,
  MemoryConflict,
  type MemoryRecord,
  RESTORE_ANNOTATION,
  recordSchema,
  type Source,
  sourceSchema,
} from './model'

type Metadata = {
  name: string
  uid: string
  resourceVersion: string
  deletionTimestamp?: string
  labels?: Record<string, string>
  ownerReferences?: Array<{ uid: string; kind: string }>
}
type Journal = { cm: V1ConfigMap; record: MemoryRecord }
const active = new Set<string>()
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const journalName = (claimName: string) => `checkpoint-${claimName}`

export function memoryManaged(claim: JsonObject): boolean {
  return (claim.metadata as Metadata).labels?.[MEMORY_LABEL] === 'true'
}

function runtime() {
  if (!config.checkpoint)
    throw new Error('memory lifecycle is disabled; refusing disk-only fallback')
  return config.checkpoint
}

export async function prepareMemory(claimName: string, deadline: string, autoPause: boolean) {
  runtime()
  const record: MemoryRecord = { version: 2, claimName, deadline, autoPause, state: 'running' }
  await coreApi.createNamespacedConfigMap({
    namespace: config.namespace,
    body: {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: journalName(claimName), labels: { [MEMORY_LABEL]: 'true' } },
      data: { record: JSON.stringify(record) },
    },
  })
}

async function readJournal(claimName: string): Promise<Journal> {
  const cm = await coreApi.readNamespacedConfigMap({
    namespace: config.namespace,
    name: journalName(claimName),
  })
  const record = recordSchema.parse(JSON.parse(cm.data?.record ?? ''))
  if (record.claimName !== claimName) throw new Error('checkpoint journal identity mismatch')
  return { cm, record }
}

async function persist(journal: Journal): Promise<void> {
  journal.cm.data = { record: JSON.stringify(recordSchema.parse(journal.record)) }
  journal.cm = await coreApi.replaceNamespacedConfigMap({
    namespace: config.namespace,
    name: journalName(journal.record.claimName),
    body: journal.cm,
  })
}

async function bind(journal: Journal): Promise<{ claim: JsonObject; sandbox: JsonObject } | null> {
  const claim = await getClaimCR(journal.record.claimName)
  const meta = claim.metadata as Metadata
  if (
    meta.deletionTimestamp ||
    !memoryManaged(claim) ||
    (journal.record.claimUID && journal.record.claimUID !== meta.uid)
  ) {
    throw new Error('memory lifecycle Claim was deleted or replaced')
  }
  const name = (claim.status as { sandbox?: { name?: string } } | undefined)?.sandbox?.name
  if (!name) return null
  const sandbox = await getSandboxCR(name)
  const sm = sandbox.metadata as Metadata
  if (
    sm.deletionTimestamp ||
    !sm.ownerReferences?.some((ref) => ref.uid === meta.uid && ref.kind === 'SandboxClaim') ||
    (journal.record.sandboxUID && journal.record.sandboxUID !== sm.uid)
  ) {
    throw new Error('memory lifecycle Sandbox ownership changed')
  }
  if (!journal.record.sandboxUID) {
    Object.assign(journal.record, { claimUID: meta.uid, sandboxName: name, sandboxUID: sm.uid })
    if (!journal.cm.metadata) throw new Error('checkpoint journal has no metadata')
    journal.cm.metadata.ownerReferences = [
      {
        apiVersion: `${CLAIM_GVR.group}/${CLAIM_GVR.version}`,
        kind: 'SandboxClaim',
        name: meta.name,
        uid: meta.uid,
        controller: true,
      },
    ]
    await persist(journal)
  }
  const spec = sandbox.spec as { shutdownTime?: string }
  if (
    spec.shutdownTime ||
    (claim.spec as { lifecycle?: { shutdownTime?: string } }).lifecycle?.shutdownTime
  ) {
    throw new Error('controller-owned expiry conflicts with memory lifecycle')
  }
  return { claim, sandbox }
}

async function podFor(record: MemoryRecord): Promise<V1Pod | null> {
  if (!record.sandboxName) throw new Error('checkpoint journal is not bound')
  try {
    const pod = await coreApi.readNamespacedPod({
      namespace: config.namespace,
      name: record.sandboxName,
    })
    if (
      !pod.metadata?.ownerReferences?.some(
        (ref) => ref.kind === 'Sandbox' && ref.uid === record.sandboxUID,
      )
    ) {
      throw new Error('Pod does not belong to the recorded Sandbox')
    }
    return pod
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

export function validateSource(record: MemoryRecord, pod: V1Pod): Source {
  const rt = runtime()
  const spec = pod.spec
  const status = pod.status?.containerStatuses?.[0]
  if (
    !spec ||
    pod.metadata?.deletionTimestamp ||
    spec.runtimeClassName !== rt.runtimeClassName ||
    spec.nodeName !== rt.nodeName ||
    spec.restartPolicy !== 'Never' ||
    spec.containers.length !== 1 ||
    spec.initContainers?.length ||
    spec.ephemeralContainers?.length ||
    !status?.state?.running ||
    status.restartCount !== 0 ||
    !status.containerID?.startsWith('containerd://')
  ) {
    throw new Error(
      'memory checkpoint requires a running, single-container, restartPolicy Never Pod on the configured runtime/node',
    )
  }
  return sourceSchema.parse({
    namespace: config.namespace,
    sandboxName: record.sandboxName,
    sandboxUID: record.sandboxUID,
    podName: pod.metadata?.name,
    podUID: pod.metadata?.uid,
    nodeName: spec.nodeName,
    containerID: status.containerID.slice('containerd://'.length),
    image: spec.containers[0].image,
  })
}

function podReady(pod: V1Pod): boolean {
  return (
    !pod.metadata?.deletionTimestamp &&
    (pod.status?.conditions?.some(
      (condition) => condition.type === 'Ready' && condition.status === 'True',
    ) ??
      false)
  )
}

// Exactly one API replica owns reconciliation. Each step persists before its next
// side effect; deterministic Jobs survive HTTP disconnects and API restarts.
async function advance(journal: Journal): Promise<void> {
  const rt = runtime()
  const bound = await bind(journal)
  if (!bound) return
  const record = journal.record
  const op = record.operation
  if (!op) return
  const name = record.sandboxName
  if (!name) throw new Error('checkpoint journal is not bound')
  const poll = (request: Parameters<typeof pollWorker>[3]) =>
    pollWorker(rt, journal.cm, op.id, request)
  try {
    if (op.stage === 'save') {
      const result = await poll({ action: 'save', id: op.id, source: op.source })
      if (!result.done) return
      if (!result.checkpoint) throw new Error('save returned no checkpoint manifest')
      record.checkpoint = result.checkpoint
      op.stage = 'suspend'
      await persist(journal)
    }
    if (op.stage === 'suspend') {
      // runsc already stopped the tasks. The controller owns Pod cleanup; never
      // force-delete its API object as a substitute for actual resource release.
      if (!record.checkpoint) throw new Error('refusing suspension without a committed checkpoint')
      await patchSandboxOperatingMode(name, 'Suspended')
      if (await podFor(record)) return
      record.state = 'paused'
      delete record.operation
      delete record.error
      await persist(journal)
      logger.info({ sandboxID: name }, 'memory sandbox paused')
      return
    }
    if (op.stage === 'verify') {
      if (!record.checkpoint) throw new Error('no committed checkpoint; refusing cold start')
      if (
        (bound.sandbox.spec as { operatingMode: string }).operatingMode !== 'Suspended' ||
        (await podFor(record))
      ) {
        throw new Error('restore requires the original Pod to be absent and Sandbox suspended')
      }
      if (!(await poll({ action: 'verify', checkpoint: record.checkpoint })).done) return
      const spec = bound.sandbox.spec as {
        podTemplate: { metadata?: { annotations?: Record<string, string> }; spec: V1Pod['spec'] }
      }
      if (
        spec.podTemplate.spec?.containers.length !== 1 ||
        spec.podTemplate.spec.containers[0].image !== record.checkpoint.source.image ||
        spec.podTemplate.spec.runtimeClassName !== rt.runtimeClassName ||
        spec.podTemplate.spec.restartPolicy !== 'Never' ||
        spec.podTemplate.spec.nodeSelector?.['kubernetes.io/hostname'] !== rt.nodeName
      ) {
        throw new Error('restore template changed; refusing incompatible restore')
      }
      const claimSpec = bound.claim.spec as {
        additionalPodMetadata?: { annotations?: Record<string, string> }
      }
      if (
        claimSpec.additionalPodMetadata?.annotations?.[RESTORE_ANNOTATION] !==
        record.checkpoint.path
      ) {
        await patchClaimRestore(
          record.claimName,
          (bound.claim.metadata as Metadata).resourceVersion,
          record.checkpoint.path,
        )
        return
      }
      if (spec.podTemplate.metadata?.annotations?.[RESTORE_ANNOTATION] !== record.checkpoint.path)
        return
      op.stage = 'start'
      op.startedAt = new Date().toISOString()
      await persist(journal)
    }
    if (op.stage === 'start') {
      await patchSandboxOperatingMode(name, 'Running')
      const pod = await podFor(record)
      if (!pod || !podReady(pod)) {
        if (Date.now() - Date.parse(op.startedAt) > config.createTimeoutMs) {
          throw new Error(
            'restored Pod is not Ready; checkpoint and PVC retained, no cold-start fallback',
          )
        }
        return
      }
      const source = validateSource(record, pod)
      if (
        source.podUID === op.source.podUID ||
        pod.metadata?.annotations?.[RESTORE_ANNOTATION] !== record.checkpoint?.path
      ) {
        throw new Error('new Pod does not reference the committed checkpoint')
      }
      record.state = 'running'
      record.deadline = new Date(
        Date.now() + (op.resumeTimeoutSeconds ?? 7200) * 1000,
      ).toISOString()
      delete record.operation
      delete record.error
      await persist(journal)
      logger.info({ sandboxID: name }, 'memory sandbox restored')
    }
  } catch (error) {
    // Transport errors may hide a running Job. Only terminal worker failures are
    // recorded; an uncertain/failed save needs inspection, not a fresh snapshot.
    if (error instanceof WorkerFailed) {
      record.error = error.message.slice(0, 2048)
      if (op.stage === 'verify') delete record.operation
      await persist(journal)
    }
    throw error
  }
}

export async function memoryDetail(claimName: string) {
  const { record } = await readJournal(claimName)
  return { endAt: record.deadline, state: record.state, busy: Boolean(record.operation) }
}

export async function initializeMemory(claimName: string): Promise<void> {
  await exclusive(claimName, async () => {
    const journal = await readJournal(claimName)
    if (!(await bind(journal))) throw new Error('memory sandbox is not bound')
    const pod = await podFor(journal.record)
    if (!pod) throw new Error('memory sandbox has no Pod')
    validateSource(journal.record, pod)
  })
}

export async function memoryTimeout(
  claimName: string,
  seconds: number,
  extendOnly: boolean,
): Promise<void> {
  runtime()
  await exclusive(claimName, async () => {
    const journal = await readJournal(claimName)
    if (journal.record.operation)
      throw new MemoryConflict('memory transition in progress; retry after it completes')
    const deadline = new Date(Date.now() + Math.max(0, seconds) * 1000).toISOString()
    if (!extendOnly || deadline > journal.record.deadline) {
      journal.record.deadline = deadline
      await persist(journal)
    }
  })
}

async function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (active.has(key))
    throw new MemoryConflict('memory transition in progress; retry after it completes')
  active.add(key)
  try {
    return await fn()
  } finally {
    active.delete(key)
  }
}

export async function transition(
  claimName: string,
  action: 'pause' | 'resume',
  resumeTimeoutSeconds?: number,
): Promise<void> {
  runtime()
  await exclusive(claimName, async () => {
    const journal = await readJournal(claimName)
    if (!(await bind(journal))) throw new MemoryConflict('Sandbox is not bound yet')
    const record = journal.record
    if (record.operation && record.operation.action !== action)
      throw new MemoryConflict('another memory transition is in progress')
    if (record.operation && record.error) throw new Error(record.error)
    if (!record.operation) {
      if ((action === 'pause') === (record.state === 'paused')) return
      await cleanJobs(journal.cm)
      const pod = action === 'pause' ? await podFor(record) : null
      const source =
        action === 'pause' ? (pod ? validateSource(record, pod) : null) : record.checkpoint?.source
      if (!source)
        throw new Error('no running source or committed checkpoint; refusing lifecycle fallback')
      record.operation = {
        id: crypto.randomUUID(),
        action,
        stage: action === 'pause' ? 'save' : 'verify',
        source,
        startedAt: new Date().toISOString(),
        ...(action === 'resume'
          ? { resumeTimeoutSeconds: Math.max(0, resumeTimeoutSeconds ?? 7200) }
          : {}),
      }
      delete record.error
      await persist(journal)
    }
    const deadline = Date.now() + runtime().timeoutSeconds * 3 * 1000 + config.createTimeoutMs
    while (record.operation) {
      await advance(journal)
      if (Date.now() > deadline)
        throw new Error(
          'memory transition still pending; progress is retained and reconciliation will continue',
        )
      if (record.operation) await sleep(config.createPollMs)
    }
    if (record.error) throw new Error(record.error)
  })
}

export async function memoryCanDelete(claimName: string): Promise<void> {
  if (active.has(claimName) || (await readJournal(claimName)).record.operation) {
    throw new MemoryConflict('memory transition in progress; retry deletion after it completes')
  }
}

export function startMemoryReconciler(intervalMs = 2000): () => void {
  if (!config.checkpoint) return () => {}
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let cursor: string | undefined
  const tick = async () => {
    try {
      const page = await coreApi.listNamespacedConfigMap({
        namespace: config.namespace,
        labelSelector: `${MEMORY_LABEL}=true`,
        limit: 50,
        _continue: cursor,
      })
      cursor = page.metadata?._continue || undefined
      for (const cm of page.items) {
        if (stopped) break
        const record = recordSchema.parse(JSON.parse(cm.data?.record ?? ''))
        if (active.has(record.claimName)) continue
        try {
          await exclusive(record.claimName, async () => {
            // Reread after acquiring exclusion; a request may have changed it.
            const journal = await readJournal(record.claimName)
            if (!(await bind(journal))) return
            if (journal.record.operation) {
              if (journal.record.error) return
              await advance(journal)
              return
            }
            if (
              journal.record.state === 'running' &&
              !journal.record.error &&
              Date.parse(journal.record.deadline) <= Date.now()
            ) {
              if (!journal.record.autoPause) {
                await deleteClaimCR(record.claimName)
                return
              }
              const pod = await podFor(journal.record)
              if (!pod) throw new Error('expired memory sandbox has no running Pod')
              await cleanJobs(journal.cm)
              journal.record.operation = {
                id: crypto.randomUUID(),
                action: 'pause',
                stage: 'save',
                source: validateSource(journal.record, pod),
                startedAt: new Date().toISOString(),
              }
              await persist(journal)
            }
          })
        } catch (error) {
          if (!isNotFound(error) && !(error instanceof MemoryConflict)) {
            logger.error(
              { err: String(error), claimName: record.claimName },
              'memory reconciliation failed',
            )
          }
        }
      }
    } catch (error) {
      cursor = undefined
      logger.error({ err: String(error) }, 'memory journal scan failed')
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs)
    }
  }
  void tick()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
