import { app } from './app'
import { startMemoryReconciler } from './checkpoint/lifecycle'
import { logger } from './logger'
import { metricsApp } from './metrics'

const port = Number(process.env.PORT ?? 3000)
const metricsServer = Bun.serve({
  port: Number(process.env.METRICS_PORT ?? 9090),
  fetch: metricsApp.fetch,
})
logger.info({ port }, 'sandbox-api listening')
const stopReconciler = startMemoryReconciler()
const shutdown = () => {
  stopReconciler()
  metricsServer.stop()
  process.exit(0)
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)

export default { port, idleTimeout: 255, fetch: app.fetch }
