import { Buffer } from 'node:buffer'
import { config, warmPoolFor } from '../config'
import { logger } from '../logger'
import {
  CLAIM_GVR,
  createClaimCR,
  deleteClaimCR,
  getClaimCR,
  getSandboxCR,
  isNotFound,
  type JsonObject,
  listClaimCRs,
  patchClaimShutdownTime,
  patchSandboxLifecycle,
  patchSandboxOperatingMode,
} from './client'

const MANAGED_BY = 'sandbox-api'
// templateID + user metadata have no home on the Sandbox CR, so we stash them
// as claim annotations at create time and read them back in get().
const ANNO_TEMPLATE = 'sandbox-api/template-id'
const ANNO_META_PREFIX = 'sandbox-api.metadata/'

export interface CreateInput {
  templateID: string
  envVars?: Record<string, string>
  metadata?: Record<string, string>
  timeout: number // seconds
  autoPause: boolean
}

export interface SandboxResult {
  clientID: string
  envdVersion: string
  envdAccessToken: string
  sandboxID: string
  templateID: string
  domain: string
}

interface ListedSandboxResult {
  clientID: string
  cpuCount: number
  diskSizeMB: number
  endAt: string
  envdVersion: string
  memoryMB: number
  sandboxID: string
  startedAt: string
  state: 'running' | 'paused'
  templateID: string
  metadata?: Record<string, string>
}

export interface SandboxDetailResult extends ListedSandboxResult {
  domain: string
  envdAccessToken: string
}

export interface ListInput {
  limit: number
  metadata?: string
  nextToken?: string
  state?: string
}

export interface ListResult {
  nextToken?: string
  sandboxes: ListedSandboxResult[]
}

export type ConnectResult =
  | { status: 'running'; value: SandboxResult }
  | { status: 'resumed'; value: SandboxResult }
  | { status: 'not-found' }

export type OperationResult<T = undefined> =
  | { status: 'ok'; value: T }
  | { status: 'not-found' }
  | { status: 'conflict' }

export class InvalidListQueryError extends Error {}

// Internal Claim name; create returns the bound Sandbox name used by the router.
function newClaimName(): string {
  const hex = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
  return `i${hex}`
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface ConditionList {
  conditions?: Array<{ type: string; status: string; reason?: string }>
}

interface BoundSandbox {
  claim: JsonObject
  claimName: string
  sandbox: JsonObject
}

function hasCondition(status: ConditionList, type: string): boolean {
  return status.conditions?.some((c) => c.type === type && c.status === 'True') ?? false
}

function hasConditionReason(status: ConditionList, type: string, reason: string): boolean {
  return status.conditions?.some((c) => c.type === type && c.reason === reason) ?? false
}

function sandboxState(sandbox: JsonObject): 'running' | 'paused' {
  const spec = (sandbox.spec ?? {}) as { operatingMode?: string }
  const status = (sandbox.status ?? {}) as ConditionList
  return spec.operatingMode === 'Suspended' ||
    hasCondition(status, 'Suspended') ||
    hasConditionReason(status, 'Ready', 'SandboxExpired')
    ? 'paused'
    : 'running'
}

function claimUsesAutoPause(claim: JsonObject): boolean {
  const spec = (claim.spec ?? {}) as { lifecycle?: { shutdownTime?: string } }
  return !spec.lifecycle?.shutdownTime
}

async function getBoundSandbox(id: string): Promise<BoundSandbox | null> {
  let sandbox: JsonObject
  try {
    sandbox = await getSandboxCR(id)
  } catch (e) {
    if (isNotFound(e)) return null
    throw e
  }

  const sandboxMeta = (sandbox.metadata ?? {}) as {
    ownerReferences?: Array<{ kind?: string; name?: string }>
  }
  const claimName = sandboxMeta.ownerReferences?.find(
    (owner) => owner.kind === 'SandboxClaim' && owner.name,
  )?.name
  if (!claimName) return null

  try {
    const claim = await getClaimCR(claimName)
    return { claim, claimName, sandbox }
  } catch (e) {
    if (isNotFound(e)) return null
    throw e
  }
}

function detailFromBound(id: string, bound: BoundSandbox): ListedSandboxResult {
  const claimMeta = (bound.claim.metadata ?? {}) as {
    creationTimestamp?: string
    annotations?: Record<string, string>
  }
  const claimSpec = (bound.claim.spec ?? {}) as { lifecycle?: { shutdownTime?: string } }
  const sandboxSpec = (bound.sandbox.spec ?? {}) as { shutdownTime?: string }
  const annos = claimMeta.annotations ?? {}
  const metadata: Record<string, string> = {}
  for (const [key, value] of Object.entries(annos)) {
    if (key.startsWith(ANNO_META_PREFIX)) metadata[key.slice(ANNO_META_PREFIX.length)] = value
  }

  const startedAt = claimMeta.creationTimestamp ?? new Date().toISOString()
  return {
    clientID: MANAGED_BY,
    cpuCount: config.defaultCpuCount,
    diskSizeMB: config.defaultDiskMB,
    endAt: sandboxSpec.shutdownTime ?? claimSpec.lifecycle?.shutdownTime ?? startedAt,
    envdVersion: config.envdVersion,
    memoryMB: config.defaultMemoryMB,
    sandboxID: id,
    startedAt,
    state: sandboxState(bound.sandbox),
    templateID: annos[ANNO_TEMPLATE] ?? 'base',
    ...(Object.keys(metadata).length ? { metadata } : {}),
  }
}

function sandboxResultFromBound(id: string, bound: BoundSandbox): SandboxResult {
  const claimMeta = (bound.claim.metadata ?? {}) as { annotations?: Record<string, string> }
  return {
    clientID: MANAGED_BY,
    envdVersion: config.envdVersion,
    envdAccessToken: config.envdAccessToken,
    sandboxID: id,
    templateID: claimMeta.annotations?.[ANNO_TEMPLATE] ?? 'base',
    domain: config.domain,
  }
}

async function extendSandboxTimeout(
  id: string,
  bound: BoundSandbox,
  timeoutSeconds: number,
): Promise<void> {
  const durationSeconds = Math.max(timeoutSeconds, 0)
  const deadline = new Date(Date.now() + durationSeconds * 1000).toISOString()
  const claimSpec = (bound.claim.spec ?? {}) as { lifecycle?: { shutdownTime?: string } }
  const sandboxSpec = (bound.sandbox.spec ?? {}) as { shutdownTime?: string }
  const currentShutdownMs = Math.max(
    ...[claimSpec.lifecycle?.shutdownTime, sandboxSpec.shutdownTime]
      .map((value) => (value ? Date.parse(value) : Number.NaN))
      .filter(Number.isFinite),
    0,
  )

  if (Date.parse(deadline) <= currentShutdownMs) return
  if (claimUsesAutoPause(bound.claim)) {
    await patchSandboxLifecycle(id, deadline)
  } else {
    await patchClaimShutdownTime(bound.claimName, deadline)
  }
}

async function waitForSandbox(
  id: string,
  action: string,
  ready: (sandbox: JsonObject) => boolean,
): Promise<JsonObject> {
  const deadline = Date.now() + config.createTimeoutMs
  for (;;) {
    const sandbox = await getSandboxCR(id)
    if (ready(sandbox)) return sandbox
    if (Date.now() > deadline) {
      throw new Error(`sandbox ${id} did not ${action} within ${config.createTimeoutMs}ms`)
    }
    await sleep(config.createPollMs)
  }
}

function parseMetadataFilter(raw?: string): Record<string, string> {
  if (!raw) return {}
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    throw new InvalidListQueryError('invalid metadata filter')
  }

  const filter: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(decoded)) {
    if (!key) throw new InvalidListQueryError('invalid metadata filter')
    filter[key] = value
  }
  if (!Object.keys(filter).length) throw new InvalidListQueryError('invalid metadata filter')
  return filter
}

function parseStateFilter(raw?: string): Set<'running' | 'paused'> {
  if (!raw) return new Set(['running', 'paused'])
  const states = raw.split(',').filter(Boolean)
  if (!states.length || states.some((state) => state !== 'running' && state !== 'paused')) {
    throw new InvalidListQueryError('invalid state filter')
  }
  return new Set(states as Array<'running' | 'paused'>)
}

interface ListCursor {
  sandboxID: string
  startedAt: string
}

function decodeCursor(token: string): ListCursor {
  try {
    const value = JSON.parse(
      Buffer.from(token, 'base64url').toString('utf8'),
    ) as Partial<ListCursor>
    if (
      typeof value.sandboxID !== 'string' ||
      typeof value.startedAt !== 'string' ||
      Number.isNaN(Date.parse(value.startedAt))
    ) {
      throw new Error('invalid cursor')
    }
    return { sandboxID: value.sandboxID, startedAt: value.startedAt }
  } catch {
    throw new InvalidListQueryError('invalid next token')
  }
}

function encodeCursor(sandbox: ListedSandboxResult): string {
  return Buffer.from(
    JSON.stringify({ sandboxID: sandbox.sandboxID, startedAt: sandbox.startedAt }),
  ).toString('base64url')
}

export async function createSandbox(input: CreateInput): Promise<SandboxResult> {
  const claimName = newClaimName()
  const deadline = new Date(Date.now() + input.timeout * 1000).toISOString()

  const env = Object.entries(input.envVars ?? {}).map(([name, value]) => ({ name, value }))

  const annotations: Record<string, string> = { [ANNO_TEMPLATE]: input.templateID }
  for (const [k, v] of Object.entries(input.metadata ?? {})) {
    annotations[`${ANNO_META_PREFIX}${k}`] = v
  }

  const hasMeta = Boolean(input.metadata && Object.keys(input.metadata).length)

  const claim: JsonObject = {
    apiVersion: `${CLAIM_GVR.group}/${CLAIM_GVR.version}`,
    kind: 'SandboxClaim',
    metadata: {
      name: claimName,
      namespace: config.namespace,
      labels: { 'app.kubernetes.io/managed-by': MANAGED_BY },
      annotations,
    },
    spec: {
      warmPoolRef: { name: warmPoolFor(input.templateID) },
      ...(env.length ? { env } : {}),
      ...(hasMeta ? { additionalPodMetadata: { annotations: input.metadata } } : {}),
      ...(input.autoPause
        ? {}
        : { lifecycle: { shutdownTime: deadline, shutdownPolicy: 'Retain' } }),
    },
  }

  await createClaimCR(claim)
  const sandboxName = await waitForClaimBound(claimName)
  if (input.autoPause) await patchSandboxLifecycle(sandboxName, deadline)
  logger.info(
    { claimName, sandboxID: sandboxName, templateID: input.templateID },
    'sandbox created',
  )

  return {
    clientID: MANAGED_BY,
    envdVersion: config.envdVersion,
    envdAccessToken: config.envdAccessToken,
    sandboxID: sandboxName,
    templateID: input.templateID,
    domain: config.domain,
  }
}

async function waitForClaimBound(name: string): Promise<string> {
  const deadline = Date.now() + config.createTimeoutMs
  for (;;) {
    const claim = await getClaimCR(name)
    const status = (claim.status ?? {}) as ConditionList & { sandbox?: { name?: string } }
    if (status.sandbox?.name && hasCondition(status, 'Ready')) return status.sandbox.name
    if (Date.now() > deadline) {
      throw new Error(`claim ${name} not Ready within ${config.createTimeoutMs}ms`)
    }
    await sleep(config.createPollMs)
  }
}

export async function getSandbox(id: string): Promise<SandboxDetailResult | null> {
  const bound = await getBoundSandbox(id)
  if (!bound) return null
  return {
    ...detailFromBound(id, bound),
    domain: config.domain,
    envdAccessToken: config.envdAccessToken,
  }
}

export async function listSandboxes(input: ListInput): Promise<ListResult> {
  if (input.limit < 1 || input.limit > 100) throw new InvalidListQueryError('invalid limit')
  const metadataFilter = parseMetadataFilter(input.metadata)
  const stateFilter = parseStateFilter(input.state)
  const claims = await listClaimCRs(`app.kubernetes.io/managed-by=${MANAGED_BY}`)

  const details = await Promise.all(
    claims.map(async (claim): Promise<ListedSandboxResult | null> => {
      const claimMeta = (claim.metadata ?? {}) as { name?: string }
      const claimStatus = (claim.status ?? {}) as { sandbox?: { name?: string } }
      const sandboxID = claimStatus.sandbox?.name
      if (!claimMeta.name || !sandboxID) return null
      try {
        const sandbox = await getSandboxCR(sandboxID)
        return detailFromBound(sandboxID, { claim, claimName: claimMeta.name, sandbox })
      } catch (e) {
        if (isNotFound(e)) return null
        throw e
      }
    }),
  )

  let filtered = details.filter(
    (detail): detail is ListedSandboxResult =>
      detail !== null &&
      stateFilter.has(detail.state) &&
      Object.entries(metadataFilter).every(([key, value]) => detail.metadata?.[key] === value),
  )
  filtered.sort(
    (a, b) => b.startedAt.localeCompare(a.startedAt) || a.sandboxID.localeCompare(b.sandboxID),
  )

  if (input.nextToken) {
    const cursor = decodeCursor(input.nextToken)
    filtered = filtered.filter(
      (sandbox) =>
        sandbox.startedAt < cursor.startedAt ||
        (sandbox.startedAt === cursor.startedAt && sandbox.sandboxID > cursor.sandboxID),
    )
  }

  const hasMore = filtered.length > input.limit
  const sandboxes = filtered.slice(0, input.limit)
  return {
    sandboxes,
    ...(hasMore && sandboxes.length
      ? { nextToken: encodeCursor(sandboxes[sandboxes.length - 1]) }
      : {}),
  }
}

export async function setSandboxTimeout(
  id: string,
  timeoutSeconds: number,
): Promise<OperationResult> {
  const bound = await getBoundSandbox(id)
  if (!bound) return { status: 'not-found' }
  if (sandboxState(bound.sandbox) === 'paused') return { status: 'conflict' }

  const durationSeconds = Math.max(timeoutSeconds, 0)
  const deadline = new Date(Date.now() + durationSeconds * 1000).toISOString()
  if (claimUsesAutoPause(bound.claim)) {
    await patchSandboxLifecycle(id, deadline)
  } else {
    await patchClaimShutdownTime(bound.claimName, deadline)
  }
  logger.info(
    { claimName: bound.claimName, sandboxID: id, deadline, timeoutSeconds },
    'sandbox timeout set',
  )
  return { status: 'ok', value: undefined }
}

export async function connectSandbox(id: string, timeoutSeconds: number): Promise<ConnectResult> {
  const bound = await getBoundSandbox(id)
  if (!bound) return { status: 'not-found' }

  await extendSandboxTimeout(id, bound, timeoutSeconds)
  if (sandboxState(bound.sandbox) === 'running') {
    logger.info({ claimName: bound.claimName, sandboxID: id }, 'sandbox connected')
    return { status: 'running', value: sandboxResultFromBound(id, bound) }
  }

  await patchSandboxOperatingMode(id, 'Running')
  await waitForSandbox(id, 'connect', (sandbox) => {
    const status = (sandbox.status ?? {}) as ConditionList
    return hasCondition(status, 'Ready') && !hasCondition(status, 'Suspended')
  })
  logger.info({ claimName: bound.claimName, sandboxID: id }, 'sandbox connected and resumed')
  return { status: 'resumed', value: sandboxResultFromBound(id, bound) }
}

export async function killSandbox(id: string): Promise<boolean> {
  const bound = await getBoundSandbox(id)
  if (!bound) return false

  try {
    await deleteClaimCR(bound.claimName)
  } catch (e) {
    if (isNotFound(e)) return false
    throw e
  }
  logger.info({ claimName: bound.claimName, sandboxID: id }, 'sandbox killed')
  return true
}

export async function pauseSandbox(id: string): Promise<OperationResult> {
  const bound = await getBoundSandbox(id)
  if (!bound) return { status: 'not-found' }
  if (sandboxState(bound.sandbox) === 'paused') return { status: 'conflict' }

  await patchSandboxOperatingMode(id, 'Suspended')
  await waitForSandbox(id, 'pause', (sandbox) =>
    hasCondition((sandbox.status ?? {}) as ConditionList, 'Suspended'),
  )
  logger.info({ claimName: bound.claimName, sandboxID: id }, 'sandbox paused')
  return { status: 'ok', value: undefined }
}

export async function resumeSandbox(
  id: string,
  timeoutSeconds: number,
): Promise<OperationResult<SandboxResult>> {
  const bound = await getBoundSandbox(id)
  if (!bound) return { status: 'not-found' }
  if (sandboxState(bound.sandbox) === 'running') return { status: 'conflict' }

  const durationSeconds = Math.max(timeoutSeconds, 0)
  const deadline = new Date(Date.now() + durationSeconds * 1000).toISOString()
  if (claimUsesAutoPause(bound.claim)) {
    await patchSandboxLifecycle(id, deadline)
  } else {
    await patchClaimShutdownTime(bound.claimName, deadline)
  }
  await patchSandboxOperatingMode(id, 'Running')
  await waitForSandbox(id, 'resume', (sandbox) => {
    const status = (sandbox.status ?? {}) as ConditionList
    return hasCondition(status, 'Ready') && !hasCondition(status, 'Suspended')
  })

  logger.info({ claimName: bound.claimName, sandboxID: id }, 'sandbox resumed')
  return {
    status: 'ok',
    value: sandboxResultFromBound(id, bound),
  }
}
