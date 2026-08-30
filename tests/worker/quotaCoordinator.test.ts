// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createQuotaCoordinatorClient,
  reserveWithPreparedAlarm,
  scheduleQuotaAlarm,
} from '../../worker/quota/quotaCoordinator'
import {
  createQuotaService,
  type QuotaCounterRecord,
  type QuotaCounterStore,
} from '../../worker/quota/quotaService'

class MemoryCoordinatorStore implements QuotaCounterStore {
  readonly records = new Map<string, QuotaCounterRecord>()

  transaction<T>(closure: () => T): T {
    const snapshot = new Map(this.records)
    try {
      return closure()
    } catch (error) {
      this.records.clear()
      for (const [key, value] of snapshot) {
        this.records.set(key, value)
      }
      throw error
    }
  }

  get(key: string): unknown {
    return this.records.get(key)
  }

  put(key: string, value: QuotaCounterRecord): void {
    this.records.set(key, { ...value })
  }

  deleteExpired(nowSeconds: number): void {
    for (const [key, value] of this.records) {
      if (key.startsWith('ip:') && value.expiresAt !== null && value.expiresAt <= nowSeconds) {
        this.records.delete(key)
      }
    }
  }

  getEarliestExpiry(): number | null {
    const expiries = [...this.records.entries()]
      .filter(([key, value]) => key.startsWith('ip:') && value.expiresAt !== null)
      .map(([, value]) => value.expiresAt as number)
    return expiries.length === 0 ? null : Math.min(...expiries)
  }
}

afterEach(() => {
  vi.useRealTimers()
})

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

  it('sends idempotency state operations using only salted hashes and numeric metadata', async () => {
    const hash = 'a'.repeat(64)
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json({ ok: true, remaining: 4 }))
      .mockResolvedValueOnce(Response.json({ ok: true }))
    const client = createQuotaCoordinatorClient({
      QUOTA_COORDINATOR: { getByName: () => ({ fetch }) },
    } as never)

    await client.beginOverview({ keyHash: hash, payloadHash: 'b'.repeat(64) })
    await client.commitOverview({ keyHash: hash, payloadHash: 'b'.repeat(64), deviceHash: 'c'.repeat(64), ipHash: 'd'.repeat(64), taskHash: 'e'.repeat(64) })
    await client.beginCandidate({ taskHash: 'e'.repeat(64), payloadHash: 'f'.repeat(64) })

    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string))
    expect(bodies).toEqual([
      { keyHash: hash, payloadHash: 'b'.repeat(64) },
      { keyHash: hash, payloadHash: 'b'.repeat(64), deviceHash: 'c'.repeat(64), ipHash: 'd'.repeat(64), taskHash: 'e'.repeat(64) },
      { taskHash: 'e'.repeat(64), payloadHash: 'f'.repeat(64) },
    ])
    expect(JSON.stringify(bodies)).not.toContain('data:image')
    expect(JSON.stringify(bodies)).not.toContain('203.0.113')
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

  it('does not charge quota when alarm preparation fails', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-29T12:00:00.000Z'))
    const store = new MemoryCoordinatorStore()
    const quota = createQuotaService(store, 'test-salt')
    const alarmStorage = {
      getAlarm: vi.fn().mockResolvedValue(null),
      setAlarm: vi.fn().mockRejectedValue(new Error('internal alarm details')),
      deleteAlarm: vi.fn().mockResolvedValue(undefined),
    }

    const operation = reserveWithPreparedAlarm(
      quota,
      store,
      alarmStorage,
      'device-123',
      '203.0.113.42',
    )

    await expect(operation).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    await expect(operation).rejects.not.toThrow('internal alarm details')
    await expect(quota.getRemaining('device-123')).resolves.toBe(5)
    expect(store.records.size).toBe(0)
    expect(alarmStorage.setAlarm).toHaveBeenCalledWith(1_788_177_600_000)
  })
})
