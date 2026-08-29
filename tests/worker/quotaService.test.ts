// @vitest-environment node

import { beforeEach, describe, expect, it } from 'vitest'
import {
  createQuotaService,
  type QuotaCounterRecord,
  type QuotaCounterStore,
} from '../../worker/quota/quotaService'
import { hashValue } from '../../worker/security/hash'

class MemoryTransactionalStore implements QuotaCounterStore {
  readonly records = new Map<string, unknown>()
  writes = 0

  transaction<T>(closure: () => T): T {
    const snapshot = new Map(this.records)
    const writes = this.writes

    try {
      return closure()
    } catch (error) {
      this.records.clear()
      for (const [key, value] of snapshot) {
        this.records.set(key, value)
      }
      this.writes = writes
      throw error
    }
  }

  get(key: string): unknown {
    return this.records.get(key)
  }

  put(key: string, value: QuotaCounterRecord): void {
    this.records.set(key, { ...value })
    this.writes += 1
  }

  deleteExpired(nowSeconds: number): void {
    for (const [key, value] of this.records) {
      if (
        key.startsWith('ip:') &&
        typeof value === 'object' && value !== null &&
        typeof (value as { expiresAt?: unknown }).expiresAt === 'number' &&
        (value as { expiresAt: number }).expiresAt <= nowSeconds
      ) {
        this.records.delete(key)
      }
    }
  }

  seed(key: string, value: unknown): void {
    this.records.set(key, value)
  }
}

describe('quotaService', () => {
  let store: MemoryTransactionalStore
  const deviceId = 'device-123'
  const ipAddress = '203.0.113.42'

  beforeEach(() => {
    store = new MemoryTransactionalStore()
  })

  it('allows five successful reservations for a device then rejects the sixth', async () => {
    const quota = createQuotaService(store, 'test-salt')

    await expect(quota.reserve(deviceId, ipAddress)).resolves.toEqual({ remaining: 4 })
    await expect(quota.reserve(deviceId, ipAddress)).resolves.toEqual({ remaining: 3 })
    await expect(quota.reserve(deviceId, ipAddress)).resolves.toEqual({ remaining: 2 })
    await expect(quota.reserve(deviceId, ipAddress)).resolves.toEqual({ remaining: 1 })
    await expect(quota.reserve(deviceId, ipAddress)).resolves.toEqual({ remaining: 0 })
    await expect(quota.reserve(deviceId, ipAddress)).rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED' })
  })

  it('allows exactly five of six simultaneous same-device reservations', async () => {
    const quota = createQuotaService(store, 'test-salt')

    const outcomes = await Promise.all(Array.from({ length: 6 }, async () => {
      try {
        return { ok: true as const, result: await quota.reserve(deviceId, ipAddress) }
      } catch (error) {
        return { ok: false as const, error }
      }
    }))

    expect(outcomes.filter(({ ok }) => ok)).toHaveLength(5)
    expect(outcomes.filter(({ ok }) => !ok)).toHaveLength(1)
    expect(outcomes.find(({ ok }) => !ok)).toMatchObject({
      error: { code: 'QUOTA_EXHAUSTED' },
    })
    await expect(quota.getRemaining(deviceId)).resolves.toBe(0)
  })

  it('keeps getRemaining read-only before a reservation', async () => {
    const quota = createQuotaService(store, 'test-salt')

    await expect(quota.getRemaining(deviceId)).resolves.toBe(5)
    await expect(quota.getRemaining(deviceId)).resolves.toBe(5)
    expect(store.writes).toBe(0)
    expect(store.records.size).toBe(0)
  })

  it('throttles the 51st reservation from an IP atomically and resets the next UTC day', async () => {
    const quota = createQuotaService(store, 'test-salt')
    const dayOne = new Date('2026-08-29T23:59:59.000Z')
    const dayTwo = new Date('2026-08-30T00:00:00.000Z')

    const outcomes = await Promise.all(Array.from({ length: 51 }, async (_, index) => {
      const candidateDevice = `device-${index}`
      try {
        await quota.reserve(candidateDevice, ipAddress, dayOne)
        return { ok: true as const, candidateDevice }
      } catch (error) {
        return { ok: false as const, candidateDevice, error }
      }
    }))

    expect(outcomes.filter(({ ok }) => ok)).toHaveLength(50)
    const rejected = outcomes.find(({ ok }) => !ok)
    expect(rejected).toMatchObject({ error: { code: 'IP_RATE_LIMIT' } })
    await expect(quota.getRemaining(rejected!.candidateDevice)).resolves.toBe(5)
    await expect(quota.reserve(rejected!.candidateDevice, ipAddress, dayTwo)).resolves.toEqual({ remaining: 4 })
  })

  it('persists only exact logical hash keys and gives IP rows a two-day expiry', async () => {
    const quota = createQuotaService(store, 'test-salt')
    const now = new Date('2026-08-29T12:00:00.000Z')
    const deviceHash = await hashValue('test-salt', deviceId)
    const ipHash = await hashValue('test-salt', ipAddress)

    await quota.reserve(deviceId, ipAddress, now)

    expect([...store.records.keys()].sort()).toEqual([
      `device:${deviceHash}`,
      `ip:2026-08-29:${ipHash}`,
    ])
    expect(store.records.get(`device:${deviceHash}`)).toEqual({ count: 1, expiresAt: null })
    expect(store.records.get(`ip:2026-08-29:${ipHash}`)).toEqual({
      count: 1,
      expiresAt: Math.floor(now.getTime() / 1000) + 172800,
    })
    expect([...store.records.keys()].join(' ')).not.toContain(deviceId)
    expect([...store.records.keys()].join(' ')).not.toContain(ipAddress)
  })

  it('removes expired IP rows inside a later reservation transaction', async () => {
    const quota = createQuotaService(store, 'test-salt')
    const firstReservation = new Date('2026-08-29T12:00:00.000Z')
    const afterExpiry = new Date('2026-08-31T12:00:01.000Z')
    const ipHash = await hashValue('test-salt', ipAddress)
    const expiredKey = `ip:2026-08-29:${ipHash}`

    await quota.reserve(deviceId, ipAddress, firstReservation)
    expect(store.records.has(expiredKey)).toBe(true)

    await quota.reserve('another-device', ipAddress, afterExpiry)
    expect(store.records.has(expiredKey)).toBe(false)
  })

  it('does not reserve after input validation fails', async () => {
    const quota = createQuotaService(store, 'test-salt')

    await expect(quota.reserve('', ipAddress)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(quota.getRemaining(deviceId)).resolves.toBe(5)
    expect(store.writes).toBe(0)
  })

  it.each([
    { count: 'not-a-number', expiresAt: null },
    { count: 6, expiresAt: null },
  ])('fails closed for malformed or out-of-range counters at the production key', async (storedValue) => {
    const quota = createQuotaService(store, 'test-salt')
    const key = `device:${await hashValue('test-salt', deviceId)}`
    store.seed(key, storedValue)

    await expect(quota.getRemaining(deviceId)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    await expect(quota.reserve(deviceId, ipAddress)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(store.records).toEqual(new Map([[key, storedValue]]))
    expect(store.writes).toBe(0)
  })
})

describe('hashValue', () => {
  it('returns lowercase SHA-256 hex for the UTF-8 salt:value bytes', async () => {
    await expect(hashValue('salt', 'value')).resolves.toBe(
      'dba76fca79c1eadce36084f8b227f5d453105ac879409ff6362d1b09a678f492',
    )
  })
})
