// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { createQuotaCoordinatorClient } from '../../worker/quota/quotaCoordinator'

describe('quotaCoordinator client', () => {
  it('routes every operation to the one global coordinator instance', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, remaining: 4 }))
      .mockResolvedValueOnce(Response.json({ ok: true, remaining: 4 }))
    const getByName = vi.fn().mockReturnValue({ fetch })
    const client = createQuotaCoordinatorClient({
      QUOTA_COORDINATOR: { getByName },
    } as never)

    await expect(client.reserve('device-123', '203.0.113.42', new Date(0))).resolves.toEqual({ remaining: 4 })
    await expect(client.getRemaining('device-123')).resolves.toBe(4)

    expect(getByName).toHaveBeenCalledTimes(1)
    expect(getByName).toHaveBeenCalledWith('global')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('converts coordinator RPC failures to a safe error', async () => {
    const client = createQuotaCoordinatorClient({
      QUOTA_COORDINATOR: {
        getByName: () => ({
          fetch: vi.fn().mockRejectedValue(new Error('database path and secret internals')),
        }),
      },
    } as never)

    const operation = client.getRemaining('device-123')

    await expect(operation).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    await expect(operation).rejects.not.toThrow('database path and secret internals')
  })

  it('treats malformed coordinator responses as internal failures', async () => {
    const client = createQuotaCoordinatorClient({
      QUOTA_COORDINATOR: {
        getByName: () => ({ fetch: vi.fn().mockResolvedValue(Response.json(null)) }),
      },
    } as never)

    await expect(client.getRemaining('device-123')).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  })
})
