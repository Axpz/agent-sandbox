import { beforeEach, describe, expect, test } from 'bun:test'

const { metricsRegistry, observeLifecycleRequest } = await import('../src/metrics')

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

beforeEach(() => metricsRegistry.resetMetrics())

describe('lifecycle operation mapping', () => {
  test('counts create on both v1 and v2 routes', async () => {
    observeLifecycleRequest('POST', '/sandboxes', 201, 7.1)
    observeLifecycleRequest('POST', '/v2/sandboxes', 201, 1.0)
    observeLifecycleRequest('POST', '/sandboxes', 500, 120)
    expect(await count('create', 'success')).toBe(2)
    expect(await count('create', 'server_error')).toBe(1)
  })

  test('counts delete and classifies a missing sandbox as a client error', async () => {
    observeLifecycleRequest('DELETE', '/sandboxes/i9942b79cd6cb', 204, 0.05)
    observeLifecycleRequest('DELETE', '/sandboxes/missing', 404, 0.01)
    expect(await count('delete', 'success')).toBe(1)
    expect(await count('delete', 'client_error')).toBe(1)
  })

  test('keeps pause, resume and connect unchanged', async () => {
    observeLifecycleRequest('POST', '/sandboxes/i1/pause', 204, 9)
    observeLifecycleRequest('POST', '/sandboxes/i1/resume', 201, 4)
    observeLifecycleRequest('POST', '/sandboxes/i1/connect', 200, 0.2)
    expect(await count('pause', 'success')).toBe(1)
    expect(await count('resume', 'success')).toBe(1)
    expect(await count('connect', 'success')).toBe(1)
  })

  test('ignores reads, listing, timeout and unrelated methods', async () => {
    observeLifecycleRequest('GET', '/sandboxes/i1', 200, 0.01)
    observeLifecycleRequest('GET', '/v2/sandboxes', 200, 0.01)
    observeLifecycleRequest('GET', '/sandboxes', 200, 0.01)
    observeLifecycleRequest('POST', '/sandboxes/i1/timeout', 204, 0.01)
    observeLifecycleRequest('DELETE', '/sandboxes', 405, 0.01)
    observeLifecycleRequest('DELETE', '/sandboxes/i1/pause', 404, 0.01)
    observeLifecycleRequest('PUT', '/sandboxes/i1/pause', 404, 0.01)
    for (const operation of ['create', 'delete', 'pause', 'resume', 'connect']) {
      for (const result of ['success', 'client_error', 'server_error']) {
        expect(await count(operation, result)).toBeUndefined()
      }
    }
  })

  test('labels never contain the sandbox ID', async () => {
    observeLifecycleRequest('DELETE', '/sandboxes/i9942b79cd6cb', 204, 0.05)
    const text = await metricsRegistry.metrics()
    expect(text).not.toContain('i9942b79cd6cb')
  })
})
