import { BatchV1Api, CoreV1Api, CustomObjectsApi, KubeConfig } from '@kubernetes/client-node'
import { config } from '../config'
import { logger } from '../logger'

// agent-sandbox CRD coordinates.
export const SANDBOX_GVR = {
  group: 'agents.x-k8s.io',
  version: 'v1beta1',
  plural: 'sandboxes',
} as const

export const CLAIM_GVR = {
  group: 'extensions.agents.x-k8s.io',
  version: 'v1beta1',
  plural: 'sandboxclaims',
} as const

export type JsonObject = Record<string, unknown>

function loadConfig(): KubeConfig {
  const kc = new KubeConfig()
  if (config.kubeconfig) {
    // An explicit file must fail closed, never select a different cluster.
    kc.loadFromFile(config.kubeconfig)
    logger.info(
      { kubeconfig: config.kubeconfig, context: kc.getCurrentContext() },
      'k8s: loaded kubeconfig from file',
    )
  } else {
    // Use client-node's KUBECONFIG, in-cluster and standard file discovery.
    kc.loadFromDefault()
  }
  if (config.k8sToken) {
    // Swap the current user for a token-only user; drops the kubeconfig's
    // client cert (which Bun's fetch can't send anyway).
    const name = kc.getCurrentUser()?.name ?? 'sandbox-api'
    const others = kc.users.filter((u) => u.name !== name)
    kc.users = [...others, { name, token: config.k8sToken }]
    logger.info({ user: name }, 'k8s: authenticating with bearer token')
  }
  if (config.skipTlsVerify) {
    // Under Bun, client-node 1.x wires CA/rejectUnauthorized through an undici
    // dispatcher that Bun's fetch ignores, so skipTLSVerify on the cluster
    // isn't enough — NODE_TLS_REJECT_UNAUTHORIZED is what Bun actually honors.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    const current = kc.getCurrentCluster()
    if (current) {
      kc.clusters = kc.clusters.map((cl) =>
        cl.name === current.name ? { ...cl, skipTLSVerify: true } : cl,
      )
    }
    logger.warn('k8s: TLS verification disabled (dev)')
  }
  return kc
}

const kc = loadConfig()
const api = kc.makeApiClient(CustomObjectsApi)
export const coreApi = kc.makeApiClient(CoreV1Api)
export const batchApi = kc.makeApiClient(BatchV1Api)

// ApiException carries the HTTP status on `.code`; duck-type it so we don't
// depend on the class being re-exported at the package root.
export function isNotFound(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: number }).code === 404
}

export async function createClaimCR(body: JsonObject): Promise<JsonObject> {
  return (await api.createNamespacedCustomObject({
    ...CLAIM_GVR,
    namespace: config.namespace,
    body,
  })) as JsonObject
}

export async function deleteClaimCR(name: string): Promise<void> {
  await api.deleteNamespacedCustomObject({
    ...CLAIM_GVR,
    namespace: config.namespace,
    name,
    propagationPolicy: 'Background',
  })
}

export async function getClaimCR(name: string): Promise<JsonObject> {
  return (await api.getNamespacedCustomObject({
    ...CLAIM_GVR,
    namespace: config.namespace,
    name,
  })) as JsonObject
}

export async function listClaimCRs(labelSelector: string): Promise<JsonObject[]> {
  const result = (await api.listNamespacedCustomObject({
    ...CLAIM_GVR,
    namespace: config.namespace,
    labelSelector,
  })) as { items?: JsonObject[] }
  return result.items ?? []
}

export async function patchClaimShutdownTime(
  name: string,
  shutdownTime: string,
): Promise<JsonObject> {
  return (await api.patchNamespacedCustomObject({
    ...CLAIM_GVR,
    namespace: config.namespace,
    name,
    body: [
      {
        op: 'replace',
        path: '/spec/lifecycle/shutdownTime',
        value: shutdownTime,
      },
    ],
  })) as JsonObject
}

export async function getSandboxCR(name: string): Promise<JsonObject> {
  return (await api.getNamespacedCustomObject({
    ...SANDBOX_GVR,
    namespace: config.namespace,
    name,
  })) as JsonObject
}

export async function patchSandboxLifecycle(
  name: string,
  shutdownTime: string,
): Promise<JsonObject> {
  return (await api.patchNamespacedCustomObject({
    ...SANDBOX_GVR,
    namespace: config.namespace,
    name,
    body: [
      {
        op: 'add',
        path: '/spec/shutdownTime',
        value: shutdownTime,
      },
      {
        op: 'add',
        path: '/spec/shutdownPolicy',
        value: 'Retain',
      },
    ],
  })) as JsonObject
}

export async function patchSandboxOperatingMode(
  name: string,
  operatingMode: 'Running' | 'Suspended',
): Promise<JsonObject> {
  return (await api.patchNamespacedCustomObject({
    ...SANDBOX_GVR,
    namespace: config.namespace,
    name,
    body: [
      {
        op: 'replace',
        path: '/spec/operatingMode',
        value: operatingMode,
      },
    ],
  })) as JsonObject
}

export async function patchClaimRestore(
  name: string,
  resourceVersion: string,
  path: string,
): Promise<void> {
  const claim = await getClaimCR(name)
  const spec = claim.spec as { additionalPodMetadata?: { annotations?: Record<string, string> } }
  await api.patchNamespacedCustomObject({
    ...CLAIM_GVR,
    namespace: config.namespace,
    name,
    body: [
      { op: 'test', path: '/metadata/resourceVersion', value: resourceVersion },
      {
        op: 'add',
        path: '/spec/additionalPodMetadata',
        value: {
          ...spec.additionalPodMetadata,
          annotations: {
            ...spec.additionalPodMetadata?.annotations,
            'dev.gvisor.internal.restore.host-image-path': path,
          },
        },
      },
    ],
  })
}
