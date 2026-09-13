import { app } from './app'
import { logger } from './logger'

const port = Number(process.env.PORT ?? 3000)
logger.info({ port }, 'sandbox-api listening')

export default { port, fetch: app.fetch }
