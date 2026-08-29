// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import worker, { type Env } from '../../worker/index'

describe('Worker routing', () => {
  it('delegates non-API paths, including /apix, to SPA assets', async () => {
    const assetResponse = new Response('SPA shell')
    const assets = { fetch: vi.fn().mockResolvedValue(assetResponse) }
    const env = { ASSETS: assets, MODEL_ID: 'test-model' } as unknown as Env

    const response = await worker.fetch(new Request('https://example.com/apix'), env)

    expect(response).toBe(assetResponse)
    expect(assets.fetch).toHaveBeenCalledOnce()
  })

  it('returns JSON 404 responses for API paths', async () => {
    const assets = { fetch: vi.fn() }
    const env = { ASSETS: assets, MODEL_ID: 'test-model' } as unknown as Env

    const response = await worker.fetch(new Request('https://example.com/api/pick'), env)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: '请求地址不存在。' },
    })
    expect(assets.fetch).not.toHaveBeenCalled()
  })
})
