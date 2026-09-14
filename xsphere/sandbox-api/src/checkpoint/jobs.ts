import { dirname } from 'node:path'
import type { V1ConfigMap, V1Job } from '@kubernetes/client-node'
import { config } from '../config'
import { batchApi, coreApi, isNotFound } from '../k8s/client'
import { checkpointSchema, MEMORY_LABEL, type RuntimeConfig, type WorkerRequest } from './model'

export class WorkerFailed extends Error {}
const OWNER_LABEL = 'xsphere.io/checkpoint-owner'

export function jobManifest(
  runtime: RuntimeConfig,
  owner: V1ConfigMap,
  operationID: string,
  request: WorkerRequest,
): V1Job {
  if (!owner.metadata?.name || !owner.metadata.uid)
    throw new Error('Job owner must be a persisted journal')
  const name = `checkpoint-${operationID}-${request.action}`
  const paths = [dirname(runtime.runscBinary), runtime.runscRoot, runtime.artifactRoot]
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name,
      namespace: config.namespace,
      labels: { [MEMORY_LABEL]: 'true', [OWNER_LABEL]: owner.metadata.uid },
      ownerReferences: [
        {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          name: owner.metadata.name,
          uid: owner.metadata.uid,
          controller: true,
        },
      ],
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: runtime.timeoutSeconds,
      template: {
        metadata: { labels: { [MEMORY_LABEL]: 'true' } },
        spec: {
          nodeName: runtime.nodeName,
          hostPID: true,
          restartPolicy: 'Never',
          serviceAccountName: 'sandbox-checkpoint-worker',
          automountServiceAccountToken: false,
          terminationGracePeriodSeconds: 10,
          containers: [
            {
              name: 'worker',
              image: runtime.workerImage,
              imagePullPolicy: 'IfNotPresent',
              command: ['bun', 'run', 'src/checkpoint/worker.ts'],
              env: [
                { name: 'CHECKPOINT_RUNTIME', value: JSON.stringify(runtime) },
                { name: 'CHECKPOINT_REQUEST', value: JSON.stringify(request) },
              ],
              securityContext: {
                runAsUser: 0,
                runAsGroup: 0,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ['ALL'], add: ['KILL', 'DAC_READ_SEARCH', 'DAC_OVERRIDE'] },
                seccompProfile: { type: 'RuntimeDefault' },
              },
              resources: {
                requests: { cpu: '100m', memory: '128Mi' },
                limits: { cpu: '1', memory: '512Mi' },
              },
              volumeMounts: paths.map((path, index) => ({
                name: `host-${index}`,
                mountPath: path,
                readOnly: index === 0,
              })),
            },
          ],
          volumes: paths.map((path, index) => ({
            name: `host-${index}`,
            hostPath: { path, type: 'Directory' },
          })),
        },
      },
    },
  }
}

// Jobs are retained until the next operation; replay reads the original result.
// A Kubernetes timeout is a failure, never proof that a save completed.
export async function pollWorker(
  runtime: RuntimeConfig,
  owner: V1ConfigMap,
  operationID: string,
  request: WorkerRequest,
) {
  const body = jobManifest(runtime, owner, operationID, request)
  const name = body.metadata?.name
  if (!name) throw new Error('checkpoint Job name is missing')
  let job: V1Job
  try {
    job = await batchApi.readNamespacedJob({ namespace: config.namespace, name })
  } catch (error) {
    if (!isNotFound(error)) throw error
    try {
      await batchApi.createNamespacedJob({ namespace: config.namespace, body })
    } catch (createError) {
      if ((createError as { code?: number }).code !== 409) throw createError
    }
    return { done: false as const }
  }
  const failed = job.status?.conditions?.find(
    (condition) => condition.type === 'Failed' && condition.status === 'True',
  )
  if (
    job.metadata?.ownerReferences?.[0]?.uid !== owner.metadata?.uid ||
    job.spec?.template.spec?.containers[0]?.env?.find(
      (entry) => entry.name === 'CHECKPOINT_REQUEST',
    )?.value !== JSON.stringify(request)
  )
    throw new Error('checkpoint Job identity mismatch')
  if (failed) throw new WorkerFailed(`checkpoint Job failed: ${failed.reason ?? 'unknown'}`)
  if (
    job.spec?.template.spec?.containers[0]?.env?.find(
      (entry) => entry.name === 'CHECKPOINT_RUNTIME',
    )?.value !== JSON.stringify(runtime)
  ) {
    throw new Error('checkpoint Job identity mismatch')
  }
  const pods = await coreApi.listNamespacedPod({
    namespace: config.namespace,
    labelSelector: `batch.kubernetes.io/job-name=${name}`,
    limit: 2,
  })
  const pod = pods.items.find((item) =>
    item.metadata?.ownerReferences?.some((ref) => ref.uid === job.metadata?.uid),
  )
  const terminated = pod?.status?.containerStatuses?.[0]?.state?.terminated
  if (terminated) {
    if (terminated.exitCode !== 0)
      throw new WorkerFailed(terminated.message || 'checkpoint worker failed')
    try {
      const result = JSON.parse(terminated.message || '{}') as {
        ok?: boolean
        checkpoint?: unknown
      }
      if (!result.ok) throw new Error('missing successful result')
      return {
        done: true as const,
        checkpoint:
          request.action === 'save' ? checkpointSchema.parse(result.checkpoint) : undefined,
      }
    } catch (error) {
      throw new WorkerFailed(`checkpoint worker result was invalid: ${String(error)}`)
    }
  }
  return { done: false as const }
}

export async function cleanJobs(owner: V1ConfigMap): Promise<void> {
  if (!owner.metadata?.uid) throw new Error('Job owner must be a persisted journal')
  const jobs = await batchApi.listNamespacedJob({
    namespace: config.namespace,
    labelSelector: `${OWNER_LABEL}=${owner.metadata.uid}`,
    limit: 100,
  })
  for (const job of jobs.items) {
    if (
      job.metadata?.name &&
      job.metadata.ownerReferences?.some((ref) => ref.uid === owner.metadata?.uid)
    ) {
      await batchApi.deleteNamespacedJob({
        namespace: config.namespace,
        name: job.metadata.name,
        propagationPolicy: 'Background',
      })
    }
  }
}
