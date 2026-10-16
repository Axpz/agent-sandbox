import { config } from '../config'
import { logger } from '../logger'
import { coreApi } from './client'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function podIP(sandboxID: string): Promise<string | undefined> {
  try {
    const pod = await coreApi.readNamespacedPod({ namespace: config.namespace, name: sandboxID })
    return pod.status?.podIP
  } catch {
    return undefined
  }
}

// /init state lives in the envd process, so it must be re-sent whenever envd
// starts again: after create (a warm Pod's envd started before the claim
// existed) and after every resume (envd-recover replaces the restored envd).
export async function initEnvd(sandboxID: string, envVars: Record<string, string>): Promise<void> {
  const init = config.envdInit
  if (!init) return
  const body = JSON.stringify({
    envVars,
    ...(init.defaultUser ? { defaultUser: init.defaultUser } : {}),
    ...(init.defaultWorkdir ? { defaultWorkdir: init.defaultWorkdir } : {}),
  })
  const deadline = Date.now() + init.timeoutMs
  let last = 'Pod has no IP'
  for (;;) {
    const ip = await podIP(sandboxID)
    if (ip) {
      try {
        const res = await fetch(`http://${ip}:${init.port}/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(2_000),
        })
        if (res.ok) {
          logger.info({ sandboxID, envVars: Object.keys(envVars).length }, 'envd initialized')
          return
        }
        last = `envd /init returned HTTP ${res.status}`
      } catch (e) {
        last = e instanceof Error ? e.message : String(e)
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`envd /init for sandbox ${sandboxID} failed: ${last}`)
    }
    await sleep(config.createPollMs)
  }
}
