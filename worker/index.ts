import type { Env } from './env'
import { createApp } from './http'

export type { Env } from './env'
export { QuotaCoordinator } from './quota/quotaCoordinator'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return createApp({ env }).fetch(request)
  },
} satisfies ExportedHandler<Env>
