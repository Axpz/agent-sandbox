import { Histogram, Registry } from '@prometheus-io/client'
import { Hono } from 'hono'

export const metricsRegistry = new Registry()
const lifecycleDuration = new Histogram({
  name: 'sandbox_api_lifecycle_request_duration_seconds',
  help: 'Completed pause, resume and connect HTTP request durations, not background transitions.',
  labelNames: ['operation', 'result'] as const,
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 240],
  registers: [metricsRegistry],
})

// Export zeros before the first request so a later scrape can observe its increase.
for (const operation of ['pause', 'resume', 'connect']) {
  for (const result of ['success', 'client_error', 'server_error']) {
    lifecycleDuration.zero({ operation, result })
  }
}

export function observeLifecycleRequest(
  method: string,
  path: string,
  status: number,
  seconds: number,
): void {
  if (method !== 'POST') return
  const operation = /^\/sandboxes\/[^/]+\/(pause|resume|connect)$/.exec(path)?.[1]
  if (!operation) return
  const result = status >= 500 ? 'server_error' : status >= 400 ? 'client_error' : 'success'
  lifecycleDuration.observe({ operation, result }, seconds)
}

// A separate listener keeps /metrics off the business API and Edge routes.
export const metricsApp = new Hono()
metricsApp.get('/metrics', async (c) => {
  c.header('Content-Type', metricsRegistry.contentType)
  return c.body(await metricsRegistry.metrics())
})
