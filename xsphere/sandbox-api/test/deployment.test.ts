import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { parseAllDocuments } from 'yaml'

const chart = resolve(import.meta.dir, '../../deploy/chart')
const devValues = resolve(import.meta.dir, '../../deploy/values-dev.yaml')
const dashboardDir = resolve(import.meta.dir, '../../deploy/chart/files/dashboards')
const dashboardFiles = [
  'sandbox-overview.json',
  'sandbox-details.json',
  'control-plane.json',
  'snapshot-warmpool.json',
]

type Panel = {
  type: string
  title: string
  targets?: { expr: string; instant?: boolean; datasource?: { uid: string } }[]
  fieldConfig?: { defaults: { custom?: { spanNulls?: boolean } } }
  options?: Record<string, any>
  transformations?: { id: string }[]
}

async function dashboards(): Promise<[string, { panels: Panel[]; [key: string]: any }][]> {
  return Promise.all(
    dashboardFiles.map(
      async (file) => [file, await Bun.file(resolve(dashboardDir, file)).json()] as const,
    ),
  )
}

function queries(dashboard: { panels: Panel[] }) {
  return dashboard.panels.flatMap((panel) =>
    (panel.targets ?? []).map((target) => ({ panel, target })),
  )
}

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
  test('metrics use a separate internal port and ServiceMonitor is opt-in', () => {
    expect(resources().some((obj) => obj.kind === 'ServiceMonitor')).toBe(false)
    const objects = resources(['--set', 'api.serviceMonitor.enabled=true'])
    const monitor = objects.find((obj) => obj.kind === 'ServiceMonitor')
    expect(monitor.spec.endpoints).toEqual([{ port: 'metrics', path: '/metrics', interval: '15s' }])
    const service = objects.find(
      (obj) => obj.kind === 'Service' && obj.metadata.name === 'sandbox-api',
    )
    expect(service.spec.type).toBe('ClusterIP')
    expect(service.spec.ports).toContainEqual({
      name: 'metrics',
      port: 9090,
      targetPort: 'metrics',
    })
  })
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
    expect(template.spec.podTemplate.spec.containers[0].securityContext.capabilities.add).toEqual([
      'SYS_ADMIN',
    ])
  })

  test('rejects malformed domain and Nginx upstream configuration', () => {
    expect(render(['--set-string', 'domain=bad;name']).exitCode).not.toBe(0)
    expect(render(['--set', 'edge.frontend.enabled=true']).exitCode).not.toBe(0)
    expect(render(['--set-string', 'edge.frontend.upstream=http://bad;include']).exitCode).not.toBe(
      0,
    )
  })
})

describe('monitoring dashboards', () => {
  test('the chart delivers every dashboard file for the Grafana sidecar, opt-in', () => {
    expect(resources().some((obj) => obj.metadata?.labels?.grafana_dashboard)).toBe(false)
    const maps = resources(['--set', 'monitoring.dashboards.enabled=true']).filter(
      (obj) => obj.kind === 'ConfigMap' && obj.metadata.labels?.grafana_dashboard === '1',
    )
    expect(maps).toHaveLength(dashboardFiles.length)
    for (const map of maps) {
      const [file] = Object.keys(map.data)
      expect(dashboardFiles).toContain(file)
      // The sidecar can only place these in a folder if it reads the annotation.
      expect(map.metadata.annotations.grafana_folder).toBe('xsphere')
      expect(map.metadata.namespace).toBe('isolated')
      expect(JSON.parse(map.data[file]).uid).toMatch(/^xsphere-/)
    }
  })

  test('router metrics stay on a separate port behind an opt-in ServiceMonitor', () => {
    const objects = resources(['--set', 'router.serviceMonitor.enabled=true'])
    const monitor = objects.find(
      (obj) => obj.kind === 'ServiceMonitor' && obj.metadata.name === 'sandbox-router',
    )
    expect(monitor.spec.endpoints).toEqual([{ port: 'metrics', path: '/metrics', interval: '15s' }])
    const service = objects.find(
      (obj) => obj.kind === 'Service' && obj.metadata.name === 'sandbox-router-svc',
    )
    expect(service.spec.ports).toContainEqual({
      name: 'metrics',
      port: 9090,
      targetPort: 'metrics',
    })
  })

  test('every dashboard keeps a stable URL and one Prometheus datasource', async () => {
    const uids = new Set<string>()
    for (const [file, dashboard] of await dashboards()) {
      expect(dashboard.uid).toMatch(/^xsphere-/)
      expect(uids.has(dashboard.uid)).toBe(false)
      uids.add(dashboard.uid)
      expect(dashboard.id).toBeNull()
      expect(dashboard.version).toBe(0)
      expect(dashboard.tags).toContain('xsphere')
      for (const { target } of queries(dashboard)) {
        expect(target.datasource?.uid, `${file}: ${target.expr}`).toBe('prometheus')
      }
    }
  })

  test('sandbox resource queries count only Pod roots', async () => {
    // gVisor exposes no per-container cgroup, and summing parent and child
    // cgroups double-counts a Pod that does expose both.
    const cgroup = /container_(memory_working_set_bytes|cpu_usage_seconds_total|fs_\w+_bytes_total)/
    let checked = 0
    for (const [file, dashboard] of await dashboards()) {
      for (const { target } of queries(dashboard)) {
        if (!cgroup.test(target.expr)) continue
        // Control-plane containers are selected by name and do report per-container.
        if (target.expr.includes('container=~"api|router|nginx"')) continue
        checked++
        for (const matcher of ['container=""', 'image=""', 'name=""']) {
          expect(target.expr, `${file}: ${target.expr}`).toContain(matcher)
        }
        expect(target.expr).not.toContain('container="runtime"')
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  test('controller metrics filter the workload namespace, not the controller Pod', async () => {
    // Prometheus renames the colliding series label, so `namespace` on these
    // families is the controller's own namespace.
    const renamed = /agent_sandboxes|agent_sandbox_claim_creation_total/
    const bare = /(?<!exported_)namespace=/
    let renamedQueries = 0
    let startupQueries = 0
    for (const [file, dashboard] of await dashboards()) {
      for (const { target } of queries(dashboard)) {
        if (renamed.test(target.expr)) {
          renamedQueries++
          expect(target.expr, `${file}: ${target.expr}`).toContain('exported_namespace=~"$ns"')
          expect(target.expr, `${file}: ${target.expr}`).not.toMatch(bare)
        }
        if (!target.expr.includes('agent_sandbox_claim_controller_startup_latency_ms_')) continue
        startupQueries++
        // The startup histograms carry no workload namespace label at all.
        expect(target.expr, `${file}: ${target.expr}`).not.toMatch(/namespace=/)
        expect(target.expr, `${file}: ${target.expr}`).toContain('sandbox_template=~"$template"')
      }
    }
    expect(renamedQueries).toBeGreaterThan(0)
    expect(startupQueries).toBeGreaterThan(0)
  })

  test('lifecycle request panels keep the namespace selector and stay out of the template filter', async () => {
    let checked = 0
    for (const [file, dashboard] of await dashboards()) {
      for (const { target } of queries(dashboard)) {
        if (!target.expr.includes('sandbox_api_lifecycle_request_duration_seconds_')) continue
        checked++
        expect(target.expr, `${file}: ${target.expr}`).toContain('namespace="$ns"')
        expect(target.expr, `${file}: ${target.expr}`).not.toContain('$template')
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  test('range summaries stay instant and bounded by the selected window', async () => {
    for (const [file, dashboard] of await dashboards()) {
      for (const { panel, target } of queries(dashboard)) {
        if (!target.instant) continue
        if (!target.expr.includes('increase(')) continue
        expect(target.expr, `${file}/${panel.title}`).toContain('[$__range]')
      }
    }
  })

  test('heatmaps keep zero buckets and leave missing observations as gaps', async () => {
    let heatmaps = 0
    for (const [, dashboard] of await dashboards()) {
      for (const panel of dashboard.panels) {
        if (panel.type === 'heatmap') {
          heatmaps++
          // Dropping zero timestamps can leave a single point with no cell width,
          // so the empty-window guard evaluates the whole range at its end instead.
          expect(panel.targets![0].expr).toContain('[$__range] @ end())) > 0)')
          expect(panel.options!.filterValues.le).toBeGreaterThanOrEqual(0)
          expect(panel.options!.legend.show).toBe(false)
        }
        if (panel.type !== 'timeseries') continue
        expect(panel.fieldConfig!.defaults.custom!.spanNulls).toBe(false)
      }
    }
    expect(heatmaps).toBeGreaterThan(0)
  })

  test('single-query tables do not join, so equal keys stay separate rows', async () => {
    let single = 0
    for (const [, dashboard] of await dashboards()) {
      for (const panel of dashboard.panels) {
        if (panel.type !== 'table') continue
        const joins = (panel.transformations ?? []).filter(
          (step: { id: string }) => step.id === 'joinByField',
        )
        if ((panel.targets ?? []).length > 1) {
          // Several queries are only readable side by side once joined on a key.
          expect(joins).toHaveLength(1)
          continue
        }
        // Joining one frame on a label silently collapses rows sharing it —
        // two alerts of the same name, or one container terminated twice.
        single++
        expect(joins).toHaveLength(0)
      }
    }
    expect(single).toBeGreaterThan(0)
  })

  test('the overview links to a drill-down dashboard that exists', async () => {
    const loaded = await dashboards()
    const uids = new Set(loaded.map(([, dashboard]) => dashboard.uid))
    const links = JSON.stringify(loaded).match(/\/d\/[\w-]+/g) ?? []
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(uids.has(link.slice('/d/'.length))).toBe(true)
    }
  })
})
