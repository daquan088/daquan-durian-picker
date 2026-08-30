import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError, createIdempotencyKey, requestQuota } from '../../src/lib/api'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('browser API client', () => {
  it('sends the persistent device ID to the same-origin quota endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { remaining: 4 } }), {
      headers: { 'content-type': 'application/json' },
    })))

    await expect(requestQuota()).resolves.toEqual({ remaining: 4 })
    expect(fetch).toHaveBeenCalledWith('/api/quota', expect.objectContaining({
      headers: expect.objectContaining({ 'x-device-id': expect.any(String) }),
    }))
  })

  it('turns API errors into a typed error without exposing HTML', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<h1>boom</h1>', { status: 500, headers: { 'content-type': 'text/html' } })))

    const error = await requestQuota().catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(AppError)
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR', message: '服务暂时无法连接，请稍后重试。' })
  })

  it('creates UUID v4 idempotency keys for POST callers to retain across retries', () => {
    expect(createIdempotencyKey()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })
})
