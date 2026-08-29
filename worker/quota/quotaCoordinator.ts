import type { Env } from '../env'
import {
  createQuotaService,
  QuotaError,
  type QuotaCounterRecord,
  type QuotaCounterStore,
  type QuotaErrorCode,
} from './quotaService'

const GLOBAL_COORDINATOR_NAME = 'global'
const INTERNAL_URL = 'https://quota-coordinator.internal'

type CoordinatorSuccess = { ok: true; remaining: number }
type CoordinatorFailure = { ok: false; error: { code: QuotaErrorCode; message: string } }
type CoordinatorResponse = CoordinatorSuccess | CoordinatorFailure

class SqliteQuotaCounterStore implements QuotaCounterStore {
  constructor(private readonly storage: DurableObjectStorage) {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS quota_counters (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        expires_at INTEGER
      ) STRICT
    `)
  }

  transaction<T>(closure: () => T): T {
    return this.storage.transactionSync(closure)
  }

  get(key: string): unknown {
    const rows = this.storage.sql.exec<{
      count: SqlStorageValue
      expiresAt: SqlStorageValue
    }>(
      'SELECT count, expires_at AS expiresAt FROM quota_counters WHERE key = ?',
      key,
    ).toArray()

    if (rows.length === 0) {
      return undefined
    }

    if (rows.length !== 1) {
      throw new QuotaError('INTERNAL_ERROR')
    }

    return rows[0]
  }

  put(key: string, value: QuotaCounterRecord): void {
    this.storage.sql.exec(
      `INSERT INTO quota_counters (key, count, expires_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET count = excluded.count, expires_at = excluded.expires_at`,
      key,
      value.count,
      value.expiresAt,
    )
  }

  deleteExpired(nowSeconds: number): void {
    this.storage.sql.exec(
      `DELETE FROM quota_counters
       WHERE key LIKE 'ip:%' AND typeof(expires_at) = 'integer' AND expires_at <= ?`,
      nowSeconds,
    )
  }
}

function safeFailure(error: unknown): Response {
  const code = error instanceof QuotaError ? error.code : 'INTERNAL_ERROR'
  const status = code === 'INVALID_REQUEST'
    ? 400
    : code === 'QUOTA_EXHAUSTED' || code === 'IP_RATE_LIMIT'
      ? 429
      : 500

  return Response.json({
    ok: false,
    error: { code, message: 'Request could not be processed.' },
  }, { status })
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new QuotaError('INVALID_REQUEST')
  }
  return value as Record<string, unknown>
}

export class QuotaCoordinator implements DurableObject {
  private readonly quota: ReturnType<typeof createQuotaService>

  constructor(state: DurableObjectState, env: Env) {
    this.quota = createQuotaService(new SqliteQuotaCounterStore(state.storage), env.QUOTA_SALT)
  }

  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== 'POST') {
        throw new QuotaError('INVALID_REQUEST')
      }

      let requestBody: unknown
      try {
        requestBody = await request.json()
      } catch {
        throw new QuotaError('INVALID_REQUEST')
      }
      const body = asRecord(requestBody)
      const pathname = new URL(request.url).pathname

      if (pathname === '/reserve') {
        const now = typeof body.now === 'number' ? new Date(body.now) : new Date(Number.NaN)
        const result = await this.quota.reserve(
          body.deviceId as string,
          body.ipAddress as string,
          now,
        )
        return Response.json({ ok: true, remaining: result.remaining } satisfies CoordinatorSuccess)
      }

      if (pathname === '/remaining') {
        const remaining = await this.quota.getRemaining(body.deviceId as string)
        return Response.json({ ok: true, remaining } satisfies CoordinatorSuccess)
      }

      throw new QuotaError('INVALID_REQUEST')
    } catch (error) {
      return safeFailure(error)
    }
  }
}

function parseCoordinatorResponse(value: unknown): CoordinatorResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new QuotaError('INTERNAL_ERROR')
  }

  const response = value as Record<string, unknown>
  if (
    response.ok === true &&
    Number.isInteger(response.remaining) &&
    (response.remaining as number) >= 0 &&
    (response.remaining as number) <= 5
  ) {
    return { ok: true, remaining: response.remaining as number }
  }

  if (
    response.ok === false &&
    typeof response.error === 'object' && response.error !== null && !Array.isArray(response.error)
  ) {
    const error = response.error as Record<string, unknown>
    if (
      error.code === 'INVALID_REQUEST' ||
      error.code === 'QUOTA_EXHAUSTED' ||
      error.code === 'IP_RATE_LIMIT' ||
      error.code === 'INTERNAL_ERROR'
    ) {
      return {
        ok: false,
        error: { code: error.code, message: 'Request could not be processed.' },
      }
    }
  }

  throw new QuotaError('INTERNAL_ERROR')
}

export function createQuotaCoordinatorClient(env: Pick<Env, 'QUOTA_COORDINATOR'>) {
  const coordinator = env.QUOTA_COORDINATOR.getByName(GLOBAL_COORDINATOR_NAME)

  async function call(path: '/reserve' | '/remaining', body: Record<string, unknown>): Promise<number> {
    try {
      const response = await coordinator.fetch(`${INTERNAL_URL}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const result = parseCoordinatorResponse(await response.json())
      if (!result.ok) {
        throw new QuotaError(result.error.code)
      }
      return result.remaining
    } catch (error) {
      if (error instanceof QuotaError) {
        throw error
      }
      throw new QuotaError('INTERNAL_ERROR')
    }
  }

  return {
    async getRemaining(deviceId: string): Promise<number> {
      return call('/remaining', { deviceId })
    },

    async reserve(deviceId: string, ipAddress: string, now = new Date()): Promise<{ remaining: number }> {
      const remaining = await call('/reserve', { deviceId, ipAddress, now: now.getTime() })
      return { remaining }
    },
  }
}
