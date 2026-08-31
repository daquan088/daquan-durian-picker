// @ts-nocheck The CloudBase event function is a CommonJS deployment artifact.
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createHandler } = require('../../cloudbase-event/index.js')

describe('CloudBase event gateway', () => {
  it('routes a supported quota request to the local CloudBase backend', async () => {
    const apiHandler = vi.fn(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true,"data":{"remaining":5}}',
      isBase64Encoded: false,
    }))
    const handler = createHandler({ apiHandler })
    const result = await handler({
      path: '/api/quota',
      httpMethod: 'GET',
      headers: {
        'x-device-id': '414f9d65-e59e-4a22-94bf-57ae9b6c6f57',
        'x-scf-remote-addr': '203.0.113.25:12345',
      },
    })

    expect(result.statusCode).toBe(200)
    expect(apiHandler).toHaveBeenCalledOnce()
    expect(apiHandler.mock.calls[0][0].path).toBe('/api/quota')
  })

  it('rejects unknown API routes without contacting the upstream', async () => {
    const apiHandler = vi.fn()
    const handler = createHandler({ apiHandler })
    const result = await handler({ path: '/api/unknown', httpMethod: 'GET', headers: {} })
    expect(result.statusCode).toBe(404)
    expect(apiHandler).not.toHaveBeenCalled()
  })
})
