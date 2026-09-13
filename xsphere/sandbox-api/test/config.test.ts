import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

const fixture = resolve(import.meta.dir, 'fixtures/offline-cluster.yaml')

// A separate process ensures lifecycle.test's Kubernetes mock cannot hide regressions.
function loadClient(explicit: string) {
  return Bun.spawnSync([process.execPath, '-e', "await import('./src/k8s/client.ts')"], {
    cwd: resolve(import.meta.dir, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      LOG_LEVEL: 'silent',
      KUBECONFIG: fixture,
      AGENTSPHERE_KUBECONFIG: explicit,
      AGENTSPHERE_K8S_SKIP_TLS_VERIFY: 'false',
      AGENTSPHERE_K8S_TOKEN: '',
    },
  })
}

test('standard KUBECONFIG discovery needs no machine-specific override', () => {
  const result = loadClient('')
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
})

test('an explicit valid kubeconfig remains supported', () => {
  expect(loadClient(fixture).exitCode).toBe(0)
})

test('an explicit missing file cannot silently fall back to another cluster', () => {
  const result = loadClient(`${fixture}.missing`)
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain('ENOENT')
})
