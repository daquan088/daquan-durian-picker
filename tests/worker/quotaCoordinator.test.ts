// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import {
  createQuotaCoordinatorClient,
  scheduleQuotaAlarm,
} from '../../worker/quota/quotaCoordinator'

describe('quotaCoordinator client', () => {
  it('routes every operation to the one global coordinator instance', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, remaining: 4 }))
      .mockResolvedValueOnce(Response.json({ ok: true, remaining: 4 }))
    const getByName = vi.fn().mockReturnValue({ fetch })
    const client = createQuotaCoordinatorClient({
      QUOTA_COORDINATOR: { getByName },
    } as never)

    const reserveWithCallerTime = client.reserve as unknown as (
      deviceId: string,
      ipAddress: string,
      callerTime: Date,
    ) => Promise<{ remaining: number }>
    await expect(reserveWithCallerTime('device-123', '203.0.113.42', new Date(0))).resolves.toEqual({ remaining: 4 })
    await expect(client.getRemaining('device-123')).resolves.toBe(4)

    expect(getByName).toHaveBeenCalledTimes(1)
    expect(getByName).toHaveBeenCalledWith('global')
    expect(fetch).toHaveBeenCalledTimes(2)
    const reserveInit = fetch.mock.calls[0][1] as RequestInit
    expect(JSON.parse(reserveInit.body as string)).toEqual({
      deviceId: 'device-123',
      ipAddress: '203.0.113.42',
    })
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

  it('schedules an earlier expiry without replacing an already earlier alarm', async () => {
    const setAlarm = vi.fn().mockResolvedValue(undefined)
    const deleteAlarm = vi.fn().mockResolvedValue(undefined)
    const storage = {
      getAlarm: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(50_000),
      setAlarm,
      deleteAlarm,
    }

    await scheduleQuotaAlarm(storage, 100)
    await scheduleQuotaAlarm(storage, 100)

    expect(setAlarm).toHaveBeenCalledOnce()
    expect(setAlarm).toHaveBeenCalledWith(100_000)
    expect(deleteAlarm).not.toHaveBeenCalled()
  })

  it('clears the alarm when no IP expiry remains', async () => {
    const storage = {
      getAlarm: vi.fn().mockResolvedValue(100_000),
      setAlarm: vi.fn().mockResolvedValue(undefined),
      deleteAlarm: vi.fn().mockResolvedValue(undefined),
    }

    await scheduleQuotaAlarm(storage, null)

    expect(storage.deleteAlarm).toHaveBeenCalledOnce()
    expect(storage.setAlarm).not.toHaveBeenCalled()
  })

  it('replaces a fired alarm with the next remaining expiry', async () => {
    const storage = {
      getAlarm: vi.fn().mockResolvedValue(50_000),
      setAlarm: vi.fn().mockResolvedValue(undefined),
      deleteAlarm: vi.fn().mockResolvedValue(undefined),
    }

    await scheduleQuotaAlarm(storage, 100, true)

    expect(storage.setAlarm).toHaveBeenCalledWith(100_000)
  })
})
