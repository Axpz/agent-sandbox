import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { runtimeConfigSchema } from './checkpoint/model'

// loadFromFile does not expand '~', so do it here.
function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2))
  return p
}

export const config = {
  checkpoint: process.env.AGENTSPHERE_CHECKPOINT_CONFIG
    ? runtimeConfigSchema.parse(JSON.parse(process.env.AGENTSPHERE_CHECKPOINT_CONFIG))
    : null,
  // --- k8s access ---
  kubeconfig: process.env.AGENTSPHERE_KUBECONFIG
    ? expandHome(process.env.AGENTSPHERE_KUBECONFIG)
    : '',
  namespace: process.env.AGENTSPHERE_NAMESPACE ?? 'default',

  // Dev-only escape hatch: a local kind API server may be reached over an SSH
  // tunnel and its CA chain isn't trusted by undici. Off by default so an
  // in-cluster deploy (loadFromDefault, real SA CA) stays strict.
  skipTlsVerify: process.env.AGENTSPHERE_K8S_SKIP_TLS_VERIFY === 'true',

  // Bearer token to authenticate as. Needed for the dev tunnel because Bun's
  // fetch can't carry the kubeconfig's client cert (mTLS goes via an undici
  // dispatcher Bun ignores); a token is a plain header Bun forwards. Empty →
  // use whatever the kubeconfig / in-cluster SA provides.
  k8sToken: process.env.AGENTSPHERE_K8S_TOKEN ?? '',

  // agent-sandbox warm pool a create() binds against (v1: single pool for all
  // templates — the required warmPoolRef; any env forces a cold start anyway).
  warmPool: process.env.AGENTSPHERE_WARMPOOL ?? 'litesandbox-warmpool',

  // subdomain root the edge routes <port>-<id>.<domain> on.
  domain: process.env.AGENTSPHERE_DOMAIN ?? 'xsphere.local',

  // SDK compatibility only: envd is not initialized with this token and does
  // not validate it. Keep sandbox-edge private while this placeholder is used.
  envdAccessToken: process.env.AGENTSPHERE_ENVD_ACCESS_TOKEN ?? 'dev',

  // reported to the SDK as the sandbox's envd build version. The SDK/dashboard
  // feature-gate on it with semver compares (e.g. inspect needs >= 0.2.9, disk
  // metrics >= 0.2.4), so report the real baked binary version, not a floor.
  // Baked image sandbox-envd:0.6.9 ships envd 0.6.9 (agentsphere-infra fork).
  envdVersion: process.env.AGENTSPHERE_ENVD_VERSION ?? '0.6.9',

  // how long create() waits for the claim to bind + go Ready before failing.
  createTimeoutMs: Number(process.env.AGENTSPHERE_CREATE_TIMEOUT_MS ?? 120_000),
  createPollMs: Number(process.env.AGENTSPHERE_CREATE_POLL_MS ?? 500),

  // resource facts echoed back in get/list — agent-sandbox templates carry no
  // fixed shape, so these are best-effort placeholders until we read podSpec.
  defaultCpuCount: Number(process.env.AGENTSPHERE_DEFAULT_CPU ?? 1),
  defaultMemoryMB: Number(process.env.AGENTSPHERE_DEFAULT_MEMORY_MB ?? 512),
  defaultDiskMB: Number(process.env.AGENTSPHERE_DEFAULT_DISK_MB ?? 0),
}

// Map a codesphere templateID onto an agent-sandbox warm pool name.
// v1: one pool for everything; templateID is not used for routing yet.
export function warmPoolFor(_templateID: string): string {
  return config.warmPool
}
