import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { parseAllDocuments } from 'yaml'

const root = resolve(import.meta.dir, '..')
const apiImage = process.env.API_IMAGE ?? 'sandbox-api:xsphere-dev'
const edgeImage = process.env.EDGE_IMAGE ?? 'nginx:1.28.0-alpine'
const edgePlatform = process.env.EDGE_PLATFORM
const apiName = `xsphere-api-smoke-${randomUUID()}`
const edgeName = `xsphere-edge-smoke-${randomUUID()}`
const temporary = mkdtempSync(resolve(tmpdir(), 'xsphere-image-smoke-'))

function docker(...args: string[]) {
  return execFileSync('docker', args, { timeout: 60000, encoding: 'utf8', stdio: 'pipe' })
}

// Never pull implicitly or expose ports. Images must be present before testing.
try {
  docker('image', 'inspect', apiImage)
  docker('image', 'inspect', edgeImage)
  const result = docker(
    'run',
    '--rm',
    '--name',
    apiName,
    '--pull=never',
    '--network=none',
    '--mount',
    `type=bind,source=${root}/test/fixtures/offline-cluster.yaml,target=/tmp/offline-cluster.yaml,readonly`,
    '-e',
    'KUBECONFIG=/tmp/offline-cluster.yaml',
    '-e',
    'LOG_LEVEL=silent',
    apiImage,
    'bun',
    '-e',
    `const {app} = await import('./src/app.ts');
     const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: app.fetch});
     try {
       const health = await fetch(new URL('/health', server.url));
       if (health.status !== 200 || (await health.json()).status !== 'ok') throw Error('health');
       const spec = await fetch(new URL('/openapi.json', server.url));
       if ((await spec.json()).info.title !== 'sandbox-api') throw Error('contract');
       console.log('PASS: production API image health and OpenAPI');
     } finally { server.stop(true); }`,
  )
  process.stdout.write(result)
  const rendered = execFileSync(
    process.env.HELM ?? 'helm',
    [
      'template',
      'xsphere-smoke',
      '../deploy/chart',
      '--namespace',
      'isolated',
      '-f',
      '../deploy/values-dev.yaml',
      '--set',
      'edge.frontend.enabled=true,edge.frontend.host=app.example.invalid,edge.frontend.upstream=http://frontend.isolated.svc.cluster.local:80',
    ],
    { cwd: root, env: { ...process.env, KUBECONFIG: '/dev/null' }, encoding: 'utf8' },
  )
  const config = parseAllDocuments(rendered)
    .map((doc) => doc.toJS())
    .find((object) => object.kind === 'ConfigMap').data['default.conf']
  const configFile = resolve(temporary, 'default.conf')
  writeFileSync(configFile, config)
  docker(
    'run',
    '--rm',
    '--name',
    edgeName,
    ...(edgePlatform ? ['--platform', edgePlatform] : []),
    '--pull=never',
    '--network=none',
    '--add-host',
    'sandbox-router-svc.isolated.svc.cluster.local:127.0.0.1',
    '--add-host',
    'frontend.isolated.svc.cluster.local:127.0.0.1',
    '--mount',
    `type=bind,source=${configFile},target=/etc/nginx/conf.d/default.conf,readonly`,
    edgeImage,
    'nginx',
    '-t',
  )
  console.log('PASS: rendered Edge Nginx configuration, including optional frontend')
} finally {
  for (const name of [apiName, edgeName]) {
    try {
      docker('rm', '--force', name)
    } catch {
      // --rm normally removed the container; this also covers interrupted runs.
    }
  }
  rmSync(temporary, { recursive: true, force: true })
}
