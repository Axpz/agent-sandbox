import { isAbsolute, normalize } from 'node:path'
import { z } from 'zod'

const hostPath = z
  .string()
  .refine(
    (value: string) =>
      isAbsolute(value) && normalize(value) === value && value.split('/').length >= 4,
    'expected a specific, normalized absolute path',
  )
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const id = z.string().uuid()

export const runtimeConfigSchema = z.object({
  runtimeClassName: z.string().min(1),
  nodeName: z.string().min(1),
  runscBinary: hostPath,
  runscSha256: digest,
  runscRoot: hostPath,
  artifactRoot: hostPath,
  workerImage: z.string().min(1),
  timeoutSeconds: z.number().int().min(30).max(600).default(180),
})
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>

export const sourceSchema = z.object({
  namespace: z.string().min(1),
  sandboxName: z.string().min(1),
  sandboxUID: id,
  podName: z.string().min(1),
  podUID: id,
  nodeName: z.string().min(1),
  containerID: digest,
  image: z.string().includes('@sha256:'),
})
export type Source = z.infer<typeof sourceSchema>

export const checkpointSchema = z.object({
  id,
  source: sourceSchema,
  path: hostPath,
  rootID: digest,
  runscSha256: digest,
  createdAt: z.string().datetime(),
  files: z
    .array(
      z.object({
        name: z.enum(['checkpoint.img', 'pages.img', 'pages_meta.img']),
        size: z.number().int().nonnegative(),
        sha256: digest,
      }),
    )
    .length(3),
})
export type Checkpoint = z.infer<typeof checkpointSchema>

export const workerRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), id, source: sourceSchema }),
  z.object({ action: z.literal('verify'), checkpoint: checkpointSchema }),
])
export type WorkerRequest = z.infer<typeof workerRequestSchema>

// Existing SDK metadata can convey the policy without changing its HTTP schema.
export const MEMORY_METADATA_KEY = 'xsphere.io/pause-mode'
export const MEMORY_LABEL = 'xsphere.io/memory-lifecycle'
export const RESTORE_ANNOTATION = 'dev.gvisor.internal.restore.host-image-path'

// Private operation journal, not a replacement for the Sandbox API status.
export const recordSchema = z.object({
  version: z.literal(2),
  claimName: z.string().min(1),
  claimUID: id.optional(),
  sandboxName: z.string().min(1).optional(),
  sandboxUID: id.optional(),
  autoPause: z.boolean(),
  deadline: z.string().datetime(),
  state: z.enum(['running', 'paused']),
  checkpoint: checkpointSchema.optional(),
  operation: z
    .object({
      id,
      action: z.enum(['pause', 'resume']),
      stage: z.enum(['save', 'suspend', 'verify', 'start']),
      source: sourceSchema,
      startedAt: z.string().datetime(),
      resumeTimeoutSeconds: z.number().nonnegative().optional(),
    })
    .optional(),
  error: z.string().optional(),
})
export type MemoryRecord = z.infer<typeof recordSchema>

export class MemoryConflict extends Error {}
