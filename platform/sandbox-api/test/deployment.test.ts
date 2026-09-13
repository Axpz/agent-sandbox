import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { parseAllDocuments } from 'yaml'

const chart = resolve(import.meta.dir, '../../deploy/chart')
const devValues = resolve(import.meta.dir, '../../deploy/values-dev.yaml')

function render(overrides: string[] = [], development = true) {
  return Bun.spawnSync(
    [
      process.env.HELM ?? 'helm',
      'template',
      'xsphere-test',
      chart,
      '--namespace',
      'isolated',
      ...(development ? ['-f', devValues] : []),
      ...overrides,
    ],
    { env: { ...process.env, KUBECONFIG: '/dev/null' } },
  )
}

function resources(overrides: string[] = []) {
  const result = render(overrides)
  expect(result.exitCode).toBe(0)
  return parseAllDocuments(result.stdout.toString()).map((doc) => {
    expect(doc.errors).toEqual([])
    return doc.toJS()
  })
}

describe('private development chart', () => {
  test('the unified entry renders the existing controller chart with extensions', () => {
    const result = Bun.spawnSync(
      [
        'make',
        '-s',
        '-C',
        resolve(chart, '../..'),
        'controller-render',
        'CONTROLLER_NAMESPACE=controller-test',
      ],
      { env: { ...process.env, KUBECONFIG: '/dev/null' } },
    )
    expect(result.exitCode).toBe(0)
    const objects = parseAllDocuments(result.stdout.toString()).map((doc) => doc.toJS())
    const controller = objects.find((obj) => obj.kind === 'Deployment')
    expect(controller.metadata.namespace).toBe('controller-test')
    expect(controller.spec.template.spec.containers[0].args).toContain('--extensions=true')
    expect(controller.spec.template.spec.containers[0].image).toEndWith(':v0.5.4')
  })

  test('refuses implicit unauthenticated deployment or missing images', () => {
    const result = render([], false)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('no end-to-end authentication')
    expect(render(['--set', 'api.image=']).exitCode).not.toBe(0)
    expect(render(['--set-string', 'development.allowUnauthenticated=false']).exitCode).not.toBe(0)
  })

  test('preserves component names and scopes RBAC, API, Router and Edge together', () => {
    const objects = resources()
    expect(
      objects
        .filter((o) => o.kind === 'Deployment')
        .map((o) => o.metadata.name)
        .sort(),
    ).toEqual(['sandbox-api', 'sandbox-edge', 'sandbox-router'])
    for (const obj of objects) expect(obj.metadata.namespace).toBe('isolated')
    for (const binding of objects.filter((o) => o.kind === 'RoleBinding')) {
      expect(binding.subjects[0].namespace).toBe('isolated')
      expect(
        objects.some((o) => o.kind === 'Role' && o.metadata.name === binding.roleRef.name),
      ).toBe(true)
    }
    const deployments = objects.filter((o) => o.kind === 'Deployment')
    const api = deployments.find((o) => o.metadata.name === 'sandbox-api')
    expect(api.spec.template.spec.containers[0].env).toContainEqual({
      name: 'AGENTSPHERE_NAMESPACE',
      value: 'isolated',
    })
    expect(api.spec.template.spec.containers[0].env).toContainEqual({
      name: 'AGENTSPHERE_K8S_SKIP_TLS_VERIFY',
      value: 'false',
    })
    const router = deployments.find((o) => o.metadata.name === 'sandbox-router')
    expect(router.spec.template.spec.containers[0].args).toContain('--cache-namespace=isolated')
    const nginx = objects.find((o) => o.kind === 'ConfigMap').data['default.conf']
    expect(nginx).toContain('sandbox-router-svc.isolated.svc.cluster.local:8080')
    expect(nginx).toContain('X-Sandbox-Namespace isolated;')
    expect(nginx).toContain('X-Sandbox-ID $http_e2b_sandbox_id;')
    expect(nginx).toContain('X-Sandbox-Port $sbport;')
  })

  test('does not install controllers, CRDs, Secrets, runtime classes or existing business templates', () => {
    const objects = resources()
    expect([...new Set(objects.map((o) => o.kind))].sort()).toEqual([
      'ConfigMap',
      'Deployment',
      'Role',
      'RoleBinding',
      'Service',
      'ServiceAccount',
    ])
    for (const svc of objects.filter((o) => o.kind === 'Service')) {
      expect(svc.spec.type).toBe('ClusterIP')
      expect(svc.spec.ports[0].nodePort).toBeUndefined()
    }
    const serialized = JSON.stringify(objects)
    expect(serialized).not.toContain('hostPath')
    expect(serialized).not.toContain('"privileged":true')
    expect(serialized).not.toContain('dev.gvisor.internal')
  })

  test('domain changes restart Edge and optional NodePort stays explicit', () => {
    const base = resources()
    const changed = resources(['--set', 'domain=runtime.example.invalid,edge.serviceType=NodePort'])
    const edge = (objects: ReturnType<typeof resources>) =>
      objects.find((o) => o.kind === 'Deployment' && o.metadata.name === 'sandbox-edge')
    expect(edge(base).spec.template.metadata.annotations['checksum/config']).not.toBe(
      edge(changed).spec.template.metadata.annotations['checksum/config'],
    )
    expect(changed.find((o) => o.kind === 'ConfigMap').data['default.conf']).toContain(
      'runtime\\.example\\.invalid',
    )
    expect(
      changed.find((o) => o.kind === 'Service' && o.metadata.name === 'sandbox-edge').spec.ports[0]
        .nodePort,
    ).toBe(30080)
  })

  test('runtime is opt-in with an explicit image and one PVC per Sandbox', () => {
    expect(render(['--set', 'runtime.enabled=true']).exitCode).not.toBe(0)
    const objects = resources([
      '--set',
      'runtime.enabled=true,runtime.image=runtime:arm64,runtime.runtimeClassName=gvisor-l2',
    ])
    const template = objects.find((o) => o.kind === 'SandboxTemplate')
    const pool = objects.find((o) => o.kind === 'SandboxWarmPool')
    expect(pool.spec.sandboxTemplateRef.name).toBe(template.metadata.name)
    expect(pool.spec.replicas).toBe(0)
    expect(template.spec.podTemplate.spec.runtimeClassName).toBe('gvisor-l2')
    expect(template.spec.podTemplate.spec.automountServiceAccountToken).toBe(false)
    expect(template.spec.volumeClaimTemplates[0].metadata.name).toBe('workspace')
    expect(template.spec.podTemplate.spec.containers[0].securityContext).toBeUndefined()
  })

  test('rejects malformed domain and Nginx upstream configuration', () => {
    expect(render(['--set-string', 'domain=bad;name']).exitCode).not.toBe(0)
    expect(render(['--set', 'edge.frontend.enabled=true']).exitCode).not.toBe(0)
    expect(render(['--set-string', 'edge.frontend.upstream=http://bad;include']).exitCode).not.toBe(
      0,
    )
  })
})
