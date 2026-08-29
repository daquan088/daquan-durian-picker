import { hashValue } from '../security/hash'

const DEVICE_LIMIT = 5
const IP_DAILY_LIMIT = 50
const IP_EXPIRATION_TTL_SECONDS = 172800

export interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

export class QuotaError extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'QUOTA_EXHAUSTED' | 'IP_RATE_LIMIT') {
    super('Request could not be processed.')
    this.name = 'QuotaError'
  }
}

function parseCounter(value: string | null): number {
  if (value === null || !/^(?:0|[1-9]\d*)$/.test(value)) {
    return 0
  }

  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function assertIdentifier(value: string): void {
  if (value.trim().length === 0 || value.length > 256) {
    throw new QuotaError('INVALID_REQUEST')
  }
}

function utcDay(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new QuotaError('INVALID_REQUEST')
  }

  return date.toISOString().slice(0, 10)
}

export function createQuotaService(kv: KvLike, salt: string) {
  if (salt.length === 0) {
    throw new QuotaError('INVALID_REQUEST')
  }

  async function deviceKey(deviceId: string): Promise<string> {
    assertIdentifier(deviceId)
    return `device:${await hashValue(salt, deviceId)}`
  }

  return {
    async getRemaining(deviceId: string): Promise<number> {
      const count = parseCounter(await kv.get(await deviceKey(deviceId)))
      return Math.max(0, DEVICE_LIMIT - count)
    },

    async reserve(deviceId: string, ipAddress: string, now = new Date()): Promise<{ remaining: number }> {
      assertIdentifier(deviceId)
      assertIdentifier(ipAddress)

      const [hashedDevice, hashedIp] = await Promise.all([
        hashValue(salt, deviceId),
        hashValue(salt, ipAddress),
      ])
      const resolvedDay = utcDay(now)
      const currentDeviceCount = parseCounter(await kv.get(`device:${hashedDevice}`))
      if (currentDeviceCount >= DEVICE_LIMIT) {
        throw new QuotaError('QUOTA_EXHAUSTED')
      }

      const ipKey = `ip:${resolvedDay}:${hashedIp}`
      const currentIpCount = parseCounter(await kv.get(ipKey))
      if (currentIpCount >= IP_DAILY_LIMIT) {
        throw new QuotaError('IP_RATE_LIMIT')
      }

      await kv.put(ipKey, String(currentIpCount + 1), { expirationTtl: IP_EXPIRATION_TTL_SECONDS })
      await kv.put(`device:${hashedDevice}`, String(currentDeviceCount + 1))

      return { remaining: DEVICE_LIMIT - currentDeviceCount - 1 }
    },
  }
}
