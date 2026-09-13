// OpenAPI routes for the AgentSphere 2.1.5 API plus the SDK 3.x connect endpoint.
// Paths, methods, status codes and auth mirror the SDK contracts:
//   - only GET /v2/sandboxes carries the /v2 prefix; the rest are unprefixed
//   - auth is a raw `X-API-KEY` header (no Bearer)
//   - connect returns 200 when running and 201 when it resumes a paused sandbox
import { createRoute, z } from '@hono/zod-openapi'
import {
  ConnectSandbox,
  ErrorSchema,
  ListedSandboxes,
  ListSandboxesQuery,
  NewSandbox,
  ResumedSandbox,
  Sandbox,
  SandboxDetail,
  SandboxIdParam,
  SandboxTimeout,
} from './schemas'

const security = [{ ApiKeyAuth: [] as string[] }]

// Shared error response (models/error.py) for a given description.
const err = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorSchema } },
})

export const createSandbox = createRoute({
  method: 'post',
  path: '/sandboxes',
  tags: ['sandboxes'],
  summary: 'Create a sandbox',
  security,
  request: {
    body: { content: { 'application/json': { schema: NewSandbox } }, required: true },
  },
  responses: {
    201: { description: 'Sandbox created', content: { 'application/json': { schema: Sandbox } } },
    400: err('Bad request'),
    401: err('Unauthorized'),
    500: err('Server error'),
  },
})

export const getSandbox = createRoute({
  method: 'get',
  path: '/sandboxes/{sandboxID}',
  tags: ['sandboxes'],
  summary: 'Get sandbox info',
  security,
  request: { params: SandboxIdParam },
  responses: {
    200: {
      description: 'Sandbox detail',
      content: { 'application/json': { schema: SandboxDetail } },
    },
    401: err('Unauthorized'),
    404: err('Not found'),
    500: err('Server error'),
  },
})

export const listSandboxes = createRoute({
  method: 'get',
  path: '/v2/sandboxes',
  tags: ['sandboxes'],
  summary: 'List sandboxes',
  security,
  request: { query: ListSandboxesQuery },
  responses: {
    200: {
      description: 'Sandboxes',
      headers: z.object({
        'x-next-token': z.string().optional().openapi({ description: 'Pagination cursor' }),
      }),
      content: { 'application/json': { schema: ListedSandboxes } },
    },
    400: err('Bad request'),
    401: err('Unauthorized'),
    500: err('Server error'),
  },
})

export const killSandbox = createRoute({
  method: 'delete',
  path: '/sandboxes/{sandboxID}',
  tags: ['sandboxes'],
  summary: 'Kill a sandbox',
  security,
  request: { params: SandboxIdParam },
  responses: {
    204: { description: 'Killed' },
    401: err('Unauthorized'),
    404: err('Not found'),
    500: err('Server error'),
  },
})

export const setSandboxTimeout = createRoute({
  method: 'post',
  path: '/sandboxes/{sandboxID}/timeout',
  tags: ['sandboxes'],
  summary: 'Set sandbox timeout',
  security,
  request: {
    params: SandboxIdParam,
    body: { content: { 'application/json': { schema: SandboxTimeout } }, required: true },
  },
  responses: {
    204: { description: 'Timeout set' },
    401: err('Unauthorized'),
    404: err('Not found'),
    409: err('Sandbox is paused'),
    500: err('Server error'),
  },
})

export const connectSandbox = createRoute({
  method: 'post',
  path: '/sandboxes/{sandboxID}/connect',
  tags: ['sandboxes'],
  summary: 'Ensure a sandbox is running',
  security,
  request: {
    params: SandboxIdParam,
    body: { content: { 'application/json': { schema: ConnectSandbox } }, required: true },
  },
  responses: {
    200: { description: 'Already running', content: { 'application/json': { schema: Sandbox } } },
    201: { description: 'Resumed', content: { 'application/json': { schema: Sandbox } } },
    400: err('Invalid request'),
    401: err('Unauthorized'),
    404: err('Not found'),
    500: err('Server error'),
  },
})

export const pauseSandbox = createRoute({
  method: 'post',
  path: '/sandboxes/{sandboxID}/pause',
  tags: ['sandboxes'],
  summary: 'Pause a sandbox (beta)',
  security,
  request: { params: SandboxIdParam },
  responses: {
    204: { description: 'Paused' },
    401: err('Unauthorized'),
    404: err('Not found'),
    409: err('Already paused'),
    500: err('Server error'),
  },
})

export const resumeSandbox = createRoute({
  method: 'post',
  path: '/sandboxes/{sandboxID}/resume',
  tags: ['sandboxes'],
  summary: 'Resume a paused sandbox',
  security,
  request: {
    params: SandboxIdParam,
    body: { content: { 'application/json': { schema: ResumedSandbox } }, required: false },
  },
  responses: {
    201: { description: 'Resumed', content: { 'application/json': { schema: Sandbox } } },
    401: err('Unauthorized'),
    404: err('Not found'),
    409: err('Already running'),
    500: err('Server error'),
  },
})
