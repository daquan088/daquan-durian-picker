import { hashValue } from '../security/hash'

const DEVICE_LIMIT = 5
const IP_DAILY_LIMIT = 50
const IP_RETENTION_SECONDS = 172800

export interface QuotaCounterRecord {
  count: number
  expiresAt: number | null
}

export interface QuotaCounterStore {
  transaction<T>(closure: () => T): T
  get(key: string): unknown
  put(key: string, value: QuotaCounterRecord): void
  deleteExpired(nowSeconds: number): void
}

export type QuotaErrorCode =
  | 'INVALID_REQUEST'
  | 'QUOTA_EXHAUSTED'
  | 'IP_RATE_LIMIT'
  | 'INTERNAL_ERROR'

export class QuotaError extends Error {
  constructor(readonly code: QuotaErrorCode) {
    super('Request could not be processed.')
    this.name = 'QuotaError'
  }
}

function failClosed(): never {
  throw new QuotaError('INTERNAL_ERROR')
}

function readCounter(
  value: unknown,
  limit: number,
  expectsExpiry: boolean,
): QuotaCounterRecord | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return failClosed()
  }

  const record = value as Record<string, unknown>
  if (
    !Number.isSafeInteger(record.count) ||
    (record.count as number) < 0 ||
    (record.count as number) > limit
  ) {
    return failClosed()
  }

  if (expectsExpiry) {
    if (!Number.isSafeInteger(record.expiresAt) || (record.expiresAt as number) < 0) {
      return failClosed()
    }
  } else if (record.expiresAt !== null) {
    return failClosed()
  }

  return {
    count: record.count as number,
    expiresAt: record.expiresAt as number | null,
  }
}

function assertIdentifier(value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new QuotaError('INVALID_REQUEST')
  }
}

function resolveTime(date: Date): { day: string; seconds: number } {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new QuotaError('INVALID_REQUEST')
  }

  return {
    day: date.toISOString().slice(0, 10),
    seconds: Math.floor(date.getTime() / 1000),
  }
}

export function createQuotaService(store: QuotaCounterStore, salt: string) {
  if (typeof salt !== 'string' || salt.length === 0) {
    throw new QuotaError('INVALID_REQUEST')
  }

  async function deviceKey(deviceId: string): Promise<string> {
    assertIdentifier(deviceId)
    return `device:${await hashValue(salt, deviceId)}`
  }

  return {
    async getRemaining(deviceId: string): Promise<number> {
      const record = readCounter(store.get(await deviceKey(deviceId)), DEVICE_LIMIT, false)
      return DEVICE_LIMIT - (record?.count ?? 0)
    },

    async reserve(deviceId: string, ipAddress: string, now = new Date()): Promise<{ remaining: number }> {
      assertIdentifier(deviceId)
      assertIdentifier(ipAddress)
      const resolvedTime = resolveTime(now)

      const [hashedDevice, hashedIp] = await Promise.all([
        hashValue(salt, deviceId),
        hashValue(salt, ipAddress),
      ])
      const deviceKey = `device:${hashedDevice}`
      const ipKey = `ip:${resolvedTime.day}:${hashedIp}`

      return store.transaction(() => {
        store.deleteExpired(resolvedTime.seconds)

        const deviceRecord = readCounter(store.get(deviceKey), DEVICE_LIMIT, false)
        if ((deviceRecord?.count ?? 0) >= DEVICE_LIMIT) {
          throw new QuotaError('QUOTA_EXHAUSTED')
        }

        const ipRecord = readCounter(store.get(ipKey), IP_DAILY_LIMIT, true)
        if ((ipRecord?.count ?? 0) >= IP_DAILY_LIMIT) {
          throw new QuotaError('IP_RATE_LIMIT')
        }

        const nextDeviceCount = (deviceRecord?.count ?? 0) + 1
        store.put(deviceKey, { count: nextDeviceCount, expiresAt: null })
        store.put(ipKey, {
          count: (ipRecord?.count ?? 0) + 1,
          expiresAt: resolvedTime.seconds + IP_RETENTION_SECONDS,
        })

        return { remaining: DEVICE_LIMIT - nextDeviceCount }
      })
    },
  }
}
