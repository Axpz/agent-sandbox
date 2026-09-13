// Zod schemas mirror the AgentSphere 2.1.5 generated client plus SDK 3.x connect.
// JSON field names and casing MUST match the SDK wire format exactly.
import { z } from '@hono/zod-openapi'

// models/sandbox_state.py — string enum, exactly these two values.
export const SandboxState = z.enum(['running', 'paused']).openapi('SandboxState')

// models/error.py — the envelope every failure branch returns.
export const ErrorSchema = z
  .object({
    code: z.number().int().openapi({ example: 500 }),
    message: z.string(),
  })
  .openapi('Error')

// envVars / metadata are arbitrary string maps on the wire.
const StringMap = z.record(z.string(), z.string())

// ISO-8601 datetime string (client parses via dateutil.isoparse).
const DateTime = z.string().openapi({ format: 'date-time' })

// --- POST /sandboxes request body (models/new_sandbox.py) ---
// Casing gotcha: templateID/autoPause/envVars are camelCase, but
// allow_internet_access is snake_case on the wire. Optional fields are omitted
// (not sent as null) when unset; the server applies the listed defaults.
export const NewSandbox = z
  .object({
    templateID: z.string(),
    allow_internet_access: z.boolean().optional(),
    autoPause: z.boolean().default(true),
    envVars: StringMap.optional(),
    metadata: StringMap.optional(),
    secure: z.boolean().optional(),
    timeout: z.number().int().default(7200),
  })
  .openapi('NewSandbox')

// --- 201 body shared by POST /sandboxes and POST /resume (models/sandbox.py) ---
export const Sandbox = z
  .object({
    clientID: z.string(),
    envdVersion: z.string(),
    sandboxID: z.string(),
    templateID: z.string(),
    alias: z.string().optional(),
    domain: z.string().nullable().optional(),
    envdAccessToken: z.string().optional(),
  })
  .openapi('Sandbox')

// --- GET /sandboxes/{id} 200 body (models/sandbox_detail.py) ---
export const SandboxDetail = z
  .object({
    clientID: z.string(),
    cpuCount: z.number().int(),
    diskSizeMB: z.number().int(),
    endAt: DateTime,
    envdVersion: z.string(),
    memoryMB: z.number().int(),
    sandboxID: z.string(),
    startedAt: DateTime,
    state: SandboxState,
    templateID: z.string(),
    alias: z.string().optional(),
    domain: z.string().nullable().optional(),
    envdAccessToken: z.string().optional(),
    metadata: StringMap.optional(),
  })
  .openapi('SandboxDetail')

// --- GET /v2/sandboxes 200 element (models/listed_sandbox.py) ---
// Same as SandboxDetail minus `domain` and `envdAccessToken`.
export const ListedSandbox = z
  .object({
    clientID: z.string(),
    cpuCount: z.number().int(),
    diskSizeMB: z.number().int(),
    endAt: DateTime,
    envdVersion: z.string(),
    memoryMB: z.number().int(),
    sandboxID: z.string(),
    startedAt: DateTime,
    state: SandboxState,
    templateID: z.string(),
    alias: z.string().optional(),
    metadata: StringMap.optional(),
  })
  .openapi('ListedSandbox')

export const ListedSandboxes = z.array(ListedSandbox).openapi('ListedSandboxes')

// --- POST /sandboxes/{id}/timeout request (models/post_..._timeout_body.py) ---
export const SandboxTimeout = z
  .object({
    timeout: z.number().int(),
  })
  .openapi('SandboxTimeout')

// models/connect_sandbox.py — SDK 3.x connect request body.
export const ConnectSandbox = z
  .object({
    timeout: z.number().int(),
  })
  .openapi('ConnectSandbox')

// --- POST /sandboxes/{id}/resume request (models/resumed_sandbox.py) ---
// Both fields optional; an empty {} body is valid.
export const ResumedSandbox = z
  .object({
    autoPause: z.boolean().optional(),
    timeout: z.number().int().default(7200),
  })
  .openapi('ResumedSandbox')

// --- Path param shared by id-scoped endpoints ---
export const SandboxIdParam = z.object({
  sandboxID: z.string().openapi({
    param: { name: 'sandboxID', in: 'path' },
    example: 'i1a2b3c4',
  }),
})

// --- GET /v2/sandboxes query params (api/.../get_v2_sandboxes.py) ---
// `metadata` is a double-URL-encoded `k=v&k2=v2` string; `state` is a
// comma-joined list of states; the cursor comes back via the x-next-token header.
export const ListSandboxesQuery = z.object({
  metadata: z
    .string()
    .optional()
    .openapi({ param: { name: 'metadata', in: 'query' } }),
  state: z
    .string()
    .optional()
    .openapi({ param: { name: 'state', in: 'query' }, example: 'running,paused' }),
  nextToken: z
    .string()
    .optional()
    .openapi({ param: { name: 'nextToken', in: 'query' } }),
  limit: z.coerce
    .number()
    .int()
    .default(100)
    .openapi({ param: { name: 'limit', in: 'query' } }),
})
