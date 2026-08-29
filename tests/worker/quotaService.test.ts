// @vitest-environment node

import { beforeEach, describe, expect, it } from 'vitest'
import { createQuotaService, type KvLike } from '../../worker/quota/quotaService'

class MemoryKv implements KvLike {
  readonly puts: Array<{ key: string; value: string; options?: { expirationTtl?: number } }> = []
  private readonly values = new Map<string, string>()

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.values.set(key, value)
    this.puts.push({ key, value, options })
  }
}

describe('quotaService', () => {
  let kv: MemoryKv
  const deviceId = 'device-123'
  const ipAddress = '203.0.113.42'

  beforeEach(() => {
    kv = new MemoryKv()
  })

  it('allows five successful reservations for a device then rejects the sixth', async () => {
    const quota = createQuotaService(kv, 'test-salt')

    await expect(quota.reserve(deviceId, ipAddress)).resolves.toEqual({ remaining: 4 })
    await expect(quota.reserve(deviceId, ipAddress)).resolves.toEqual({ remaining: 3 })
    await expect(quota.reserve(deviceId, ipAddress)).resolves.toEqual({ remaining: 2 })
    await expect(quota.reserve(deviceId, ipAddress)).resolves.toEqual({ remaining: 1 })
    await expect(quota.reserve(deviceId, ipAddress)).resolves.toEqual({ remaining: 0 })
    await expect(quota.reserve(deviceId, ipAddress)).rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED' })
  })

  it('keeps getRemaining read-only before a reservation', async () => {
    const quota = createQuotaService(kv, 'test-salt')

    await expect(quota.getRemaining(deviceId)).resolves.toBe(5)
    await expect(quota.getRemaining(deviceId)).resolves.toBe(5)
    expect(kv.puts).toEqual([])
  })

  it('throttles the 51st reservation from an IP on a UTC day and resets the next day', async () => {
    const quota = createQuotaService(kv, 'test-salt')
    const dayOne = new Date('2026-08-29T23:59:59.000Z')
    const dayTwo = new Date('2026-08-30T00:00:00.000Z')

    for (let index = 0; index < 50; index += 1) {
      await expect(quota.reserve(`device-${index}`, ipAddress, dayOne)).resolves.toMatchObject({ remaining: 4 })
    }

    await expect(quota.reserve('device-51', ipAddress, dayOne)).rejects.toMatchObject({ code: 'IP_RATE_LIMIT' })
    await expect(quota.reserve('device-51', ipAddress, dayTwo)).resolves.toEqual({ remaining: 4 })
  })

  it('uses only salted hash keys and applies the IP TTL', async () => {
    const quota = createQuotaService(kv, 'test-salt')

    await quota.reserve(deviceId, ipAddress, new Date('2026-08-29T12:00:00.000Z'))

    expect(kv.puts).toHaveLength(2)
    expect(kv.puts[0]).toMatchObject({
      key: expect.stringMatching(/^ip:2026-08-29:[a-f0-9]{64}$/),
      options: { expirationTtl: 172800 },
    })
    expect(kv.puts[1]).toMatchObject({ key: expect.stringMatching(/^device:[a-f0-9]{64}$/) })
    expect(kv.puts.map(({ key }) => key).join(' ')).not.toContain(deviceId)
    expect(kv.puts.map(({ key }) => key).join(' ')).not.toContain(ipAddress)
    expect(kv.puts[1].options).toBeUndefined()
  })

  it('does not reserve quota after validation fails and handles malformed counters safely', async () => {
    const quota = createQuotaService(kv, 'test-salt')

    await expect(quota.reserve('', ipAddress)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(quota.getRemaining(deviceId)).resolves.toBe(5)

    await kv.put('device:invalid', 'not-a-number')
    await expect(quota.getRemaining('invalid')).resolves.toBe(5)
  })
})
