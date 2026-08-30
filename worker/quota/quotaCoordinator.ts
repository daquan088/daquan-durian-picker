import type { Env } from '../env'
import {
  cleanupExpiredQuota,
  createQuotaService,
  IP_RETENTION_SECONDS,
  QuotaError,
  reserveHashedQuota,
  type QuotaCounterRecord,
  type QuotaCounterStore,
  type QuotaErrorCode,
} from './quotaService'

const GLOBAL_COORDINATOR_NAME = 'global'
const INTERNAL_URL = 'https://quota-coordinator.internal'
const OPERATION_RETENTION_SECONDS = 2 * 60 * 60
const PROCESSING_LEASE_SECONDS = 180
const LEASE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

interface AlarmStorage {
  getAlarm(): Promise<number | null>
  setAlarm(scheduledTime: number | Date): Promise<void>
  deleteAlarm(): Promise<void>
}

interface CoordinatorQuotaStore extends QuotaCounterStore {
  getEarliestExpiry(): number | null
}

type CoordinatorSuccess = { ok: true; remaining?: number; leaseId?: string }
type CoordinatorFailure = { ok: false; error: { code: QuotaErrorCode; message: string } }
type CoordinatorResponse = CoordinatorSuccess | CoordinatorFailure

class SqliteQuotaCounterStore implements CoordinatorQuotaStore {
  constructor(private readonly storage: DurableObjectStorage) {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS quota_counters (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        expires_at INTEGER
      ) STRICT
    `)
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS operation_states (
        key_hash TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        lease_expires_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT
    `)
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS task_states (
        task_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
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

  deleteExpiredOperations(nowSeconds: number): void {
    this.storage.sql.exec('DELETE FROM operation_states WHERE expires_at <= ?', nowSeconds)
    this.storage.sql.exec('DELETE FROM task_states WHERE expires_at <= ?', nowSeconds)
  }

  getOperation(keyHash: string): { payloadHash: string; kind: string; state: string; leaseId: string; leaseExpiresAt: number; expiresAt: number } | undefined {
    const rows = this.storage.sql.exec<{
      payloadHash: SqlStorageValue
      kind: SqlStorageValue
      state: SqlStorageValue
      leaseId: SqlStorageValue
      leaseExpiresAt: SqlStorageValue
      expiresAt: SqlStorageValue
    }>('SELECT payload_hash AS payloadHash, kind, state, lease_id AS leaseId, lease_expires_at AS leaseExpiresAt, expires_at AS expiresAt FROM operation_states WHERE key_hash = ?', keyHash).toArray()
    if (rows.length === 0) return undefined
    if (rows.length !== 1 || !isOperationRecord(rows[0])) throw new QuotaError('INTERNAL_ERROR')
    return rows[0]
  }

  putOperation(keyHash: string, payloadHash: string, kind: 'overview' | 'candidate', state: 'processing' | 'completed', leaseId: string, leaseExpiresAt: number, expiresAt: number): void {
    this.storage.sql.exec(
      `INSERT INTO operation_states (key_hash, payload_hash, kind, state, lease_id, lease_expires_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key_hash) DO UPDATE SET payload_hash = excluded.payload_hash, kind = excluded.kind, state = excluded.state, lease_id = excluded.lease_id, lease_expires_at = excluded.lease_expires_at, expires_at = excluded.expires_at`,
      keyHash, payloadHash, kind, state, leaseId, leaseExpiresAt, expiresAt,
    )
  }

  deleteProcessingOperation(keyHash: string, payloadHash: string, leaseId: string): void {
    this.storage.sql.exec("DELETE FROM operation_states WHERE key_hash = ? AND payload_hash = ? AND lease_id = ? AND state = 'processing'", keyHash, payloadHash, leaseId)
  }

  hasTask(taskHash: string, nowSeconds: number): boolean {
    const rows = this.storage.sql.exec<{ expiresAt: SqlStorageValue }>('SELECT expires_at AS expiresAt FROM task_states WHERE task_hash = ?', taskHash).toArray()
    if (rows.length === 0) return false
    if (rows.length !== 1 || !Number.isSafeInteger(rows[0].expiresAt) || (rows[0].expiresAt as number) <= nowSeconds) {
      throw new QuotaError('INTERNAL_ERROR')
    }
    return true
  }

  putTask(taskHash: string, expiresAt: number): void {
    this.storage.sql.exec('INSERT INTO task_states (task_hash, expires_at) VALUES (?, ?)', taskHash, expiresAt)
  }

  getEarliestExpiry(): number | null {
    const row = this.storage.sql.exec<{
      expiresAt: SqlStorageValue
      malformed: SqlStorageValue
    }>(
      `SELECT MIN(expires_at) AS expiresAt,
              SUM(CASE WHEN expires_at IS NULL OR typeof(expires_at) != 'integer' THEN 1 ELSE 0 END) AS malformed
       FROM quota_counters
       WHERE key LIKE 'ip:%'`,
    ).one()

    if (row.malformed !== null && row.malformed !== 0) {
      throw new QuotaError('INTERNAL_ERROR')
    }

    const stateRow = this.storage.sql.exec<{ earliest: SqlStorageValue }>(`
      SELECT MIN(expires_at) AS earliest FROM (
        SELECT expires_at FROM operation_states
        UNION ALL SELECT expires_at FROM task_states
      )
    `).one()
    const quotaExpiry = row.expiresAt === null ? null : row.expiresAt as number
    const stateExpiry = stateRow.earliest === null ? null : stateRow.earliest as number
    if ((quotaExpiry !== null && (!Number.isSafeInteger(quotaExpiry) || quotaExpiry < 0)) ||
      (stateExpiry !== null && (!Number.isSafeInteger(stateExpiry) || stateExpiry < 0))) throw new QuotaError('INTERNAL_ERROR')
    if (quotaExpiry === null) return stateExpiry
    if (stateExpiry === null) return quotaExpiry
    return Math.min(quotaExpiry, stateExpiry)
  }
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isOperationRecord(value: Record<string, unknown>): value is { payloadHash: string; kind: string; state: string; leaseId: string; leaseExpiresAt: number; expiresAt: number } {
  return isHash(value.payloadHash) && (value.kind === 'overview' || value.kind === 'candidate') &&
    (value.state === 'processing' || value.state === 'completed') && typeof value.leaseId === 'string' && LEASE_ID_PATTERN.test(value.leaseId) &&
    Number.isSafeInteger(value.leaseExpiresAt) && Number.isSafeInteger(value.expiresAt)
}

export async function scheduleQuotaAlarm(
  storage: AlarmStorage,
  nextExpirySeconds: number | null,
  replaceExisting = false,
): Promise<void> {
  const existingAlarm = await storage.getAlarm()
  if (nextExpirySeconds === null) {
    if (existingAlarm !== null) {
      await storage.deleteAlarm()
    }
    return
  }

  if (!Number.isSafeInteger(nextExpirySeconds) || nextExpirySeconds < 0) {
    throw new QuotaError('INTERNAL_ERROR')
  }

  const nextAlarm = nextExpirySeconds * 1000
  if (replaceExisting || existingAlarm === null || nextAlarm < existingAlarm) {
    await storage.setAlarm(nextAlarm)
  }
}

export async function reserveWithPreparedAlarm(
  quota: ReturnType<typeof createQuotaService>,
  store: CoordinatorQuotaStore,
  alarmStorage: AlarmStorage,
  deviceId: string,
  ipAddress: string,
): Promise<{ remaining: number }> {
  const now = new Date()
  const nowSeconds = Math.floor(now.getTime() / 1000)

  cleanupExpiredQuota(store, nowSeconds)
  const existingExpiry = store.getEarliestExpiry()
  const proposedExpiry = nowSeconds + IP_RETENTION_SECONDS
  const earliestExpiry = existingExpiry === null
    ? proposedExpiry
    : Math.min(existingExpiry, proposedExpiry)

  try {
    await scheduleQuotaAlarm(alarmStorage, earliestExpiry)
  } catch {
    throw new QuotaError('INTERNAL_ERROR')
  }

  return quota.reserve(deviceId, ipAddress, now)
}

function safeFailure(error: unknown): Response {
  const code = error instanceof QuotaError ? error.code : 'INTERNAL_ERROR'
  const status = code === 'INVALID_REQUEST'
    ? 400
    : code === 'OPERATION_CONFLICT'
      ? 409
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
  private readonly state: DurableObjectState
  private readonly store: SqliteQuotaCounterStore
  private readonly quota: ReturnType<typeof createQuotaService>

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.store = new SqliteQuotaCounterStore(state.storage)
    this.quota = createQuotaService(this.store, env.QUOTA_SALT)
  }

  private async synchronizeAlarm(replaceExisting = false): Promise<void> {
    await scheduleQuotaAlarm(
      this.state.storage,
      this.store.getEarliestExpiry(),
      replaceExisting,
    )
  }

  private async prepareOperationAlarm(nowSeconds: number): Promise<void> {
    try {
      const existing = this.store.getEarliestExpiry()
      const proposed = nowSeconds + OPERATION_RETENTION_SECONDS
      await scheduleQuotaAlarm(this.state.storage, existing === null ? proposed : Math.min(existing, proposed))
    } catch {
      throw new QuotaError('INTERNAL_ERROR')
    }
  }

  private beginOperation(kind: 'overview' | 'candidate', keyHash: string, payloadHash: string, taskHash: string | undefined, nowSeconds: number): string {
    return this.store.transaction(() => {
      this.store.deleteExpired(nowSeconds)
      this.store.deleteExpiredOperations(nowSeconds)
      if (taskHash !== undefined && !this.store.hasTask(taskHash, nowSeconds)) throw new QuotaError('OPERATION_CONFLICT')
      const existing = this.store.getOperation(keyHash)
      if (existing !== undefined) {
        if (existing.payloadHash !== payloadHash || existing.kind !== kind || existing.state === 'completed' || existing.leaseExpiresAt > nowSeconds) {
          throw new QuotaError('OPERATION_CONFLICT')
        }
      }
      const leaseId = crypto.randomUUID()
      this.store.putOperation(keyHash, payloadHash, kind, 'processing', leaseId, nowSeconds + PROCESSING_LEASE_SECONDS, nowSeconds + OPERATION_RETENTION_SECONDS)
      return leaseId
    })
  }

  private releaseOperation(keyHash: string, payloadHash: string, leaseId: string): void {
    this.store.transaction(() => {
      const operation = this.store.getOperation(keyHash)
      if (operation === undefined || operation.payloadHash !== payloadHash || operation.leaseId !== leaseId || operation.state !== 'processing') throw new QuotaError('OPERATION_CONFLICT')
      this.store.deleteProcessingOperation(keyHash, payloadHash, leaseId)
    })
  }

  private completeCandidate(keyHash: string, payloadHash: string, leaseId: string, nowSeconds: number): void {
    this.store.transaction(() => {
      const operation = this.store.getOperation(keyHash)
      if (operation === undefined || operation.kind !== 'candidate' || operation.state !== 'processing' || operation.payloadHash !== payloadHash || operation.leaseId !== leaseId) {
        throw new QuotaError('OPERATION_CONFLICT')
      }
      this.store.putOperation(keyHash, payloadHash, 'candidate', 'completed', leaseId, nowSeconds, operation.expiresAt)
    })
  }

  private commitOverview(
    keyHash: string,
    payloadHash: string,
    leaseId: string,
    deviceHash: string,
    ipHash: string,
    taskHash: string,
    taskExpiresAt: number,
    now: Date,
  ): { remaining: number } {
    const nowSeconds = Math.floor(now.getTime() / 1000)
    return this.store.transaction(() => {
      const operation = this.store.getOperation(keyHash)
      if (operation === undefined || operation.kind !== 'overview' || operation.state !== 'processing' || operation.payloadHash !== payloadHash || operation.leaseId !== leaseId) {
        throw new QuotaError('OPERATION_CONFLICT')
      }
      const result = reserveHashedQuota(this.store, deviceHash, ipHash, now)
      this.store.putOperation(keyHash, payloadHash, 'overview', 'completed', leaseId, nowSeconds, operation.expiresAt)
      this.store.putTask(taskHash, taskExpiresAt)
      return result
    })
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
      const now = new Date()
      const nowSeconds = Math.floor(now.getTime() / 1000)

      if (pathname === '/reserve') {
        if (Object.keys(body).length !== 2 || !('deviceId' in body) || !('ipAddress' in body)) {
          throw new QuotaError('INVALID_REQUEST')
        }
        const result = await reserveWithPreparedAlarm(
          this.quota,
          this.store,
          this.state.storage,
          body.deviceId as string,
          body.ipAddress as string,
        )
        return Response.json({ ok: true, remaining: result.remaining } satisfies CoordinatorSuccess)
      }

      if (pathname === '/remaining') {
        if (Object.keys(body).length !== 1 || !('deviceId' in body)) {
          throw new QuotaError('INVALID_REQUEST')
        }
        const remaining = await this.quota.getRemaining(body.deviceId as string)
        return Response.json({ ok: true, remaining } satisfies CoordinatorSuccess)
      }

      if (pathname === '/overview/begin') {
        if (!hasExactHashes(body, ['keyHash', 'payloadHash'])) throw new QuotaError('INVALID_REQUEST')
        await this.prepareOperationAlarm(nowSeconds)
        const leaseId = this.beginOperation('overview', body.keyHash as string, body.payloadHash as string, undefined, nowSeconds)
        return Response.json({ ok: true, leaseId } satisfies CoordinatorSuccess)
      }
      if (pathname === '/overview/release') {
        if (!hasExactHashes(body, ['keyHash', 'payloadHash'], ['leaseId'])) throw new QuotaError('INVALID_REQUEST')
        this.releaseOperation(body.keyHash as string, body.payloadHash as string, body.leaseId as string)
        return Response.json({ ok: true } satisfies CoordinatorSuccess)
      }
      if (pathname === '/overview/commit') {
        if (!hasExactHashes(body, ['keyHash', 'payloadHash', 'deviceHash', 'ipHash', 'taskHash'], ['leaseId'])) throw new QuotaError('INVALID_REQUEST')
        await this.prepareOperationAlarm(nowSeconds)
        const result = this.commitOverview(body.keyHash as string, body.payloadHash as string, body.leaseId as string, body.deviceHash as string, body.ipHash as string, body.taskHash as string, nowSeconds + OPERATION_RETENTION_SECONDS, now)
        return Response.json({ ok: true, remaining: result.remaining } satisfies CoordinatorSuccess)
      }
      if (pathname === '/candidate/begin') {
        if (!hasExactHashes(body, ['taskHash', 'payloadHash'])) throw new QuotaError('INVALID_REQUEST')
        await this.prepareOperationAlarm(nowSeconds)
        const leaseId = this.beginOperation('candidate', body.taskHash as string, body.payloadHash as string, body.taskHash as string, nowSeconds)
        return Response.json({ ok: true, leaseId } satisfies CoordinatorSuccess)
      }
      if (pathname === '/candidate/release') {
        if (!hasExactHashes(body, ['taskHash', 'payloadHash'], ['leaseId'])) throw new QuotaError('INVALID_REQUEST')
        this.releaseOperation(body.taskHash as string, body.payloadHash as string, body.leaseId as string)
        return Response.json({ ok: true } satisfies CoordinatorSuccess)
      }
      if (pathname === '/candidate/complete') {
        if (!hasExactHashes(body, ['taskHash', 'payloadHash'], ['leaseId'])) throw new QuotaError('INVALID_REQUEST')
        this.completeCandidate(body.taskHash as string, body.payloadHash as string, body.leaseId as string, nowSeconds)
        return Response.json({ ok: true } satisfies CoordinatorSuccess)
      }

      throw new QuotaError('INVALID_REQUEST')
    } catch (error) {
      return safeFailure(error)
    }
  }

  async alarm(): Promise<void> {
    const nowSeconds = Math.floor(Date.now() / 1000)
    cleanupExpiredQuota(this.store, nowSeconds)
    this.store.deleteExpiredOperations(nowSeconds)
    await this.synchronizeAlarm(true)
  }
}

function hasExactHashes(body: Record<string, unknown>, hashes: readonly string[], leaseKeys: readonly string[] = []): boolean {
  return Object.keys(body).length === hashes.length + leaseKeys.length && hashes.every((key) => isHash(body[key])) && leaseKeys.every((key) => typeof body[key] === 'string' && LEASE_ID_PATTERN.test(body[key] as string))
}

function parseCoordinatorResponse(value: unknown): CoordinatorResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new QuotaError('INTERNAL_ERROR')
  }

  const response = value as Record<string, unknown>
  if (
    response.ok === true &&
    (response.remaining === undefined || (Number.isInteger(response.remaining) && (response.remaining as number) >= 0 && (response.remaining as number) <= 5)) &&
    (response.leaseId === undefined || (typeof response.leaseId === 'string' && LEASE_ID_PATTERN.test(response.leaseId)))
  ) {
    return { ok: true, ...(response.remaining === undefined ? {} : { remaining: response.remaining as number }), ...(response.leaseId === undefined ? {} : { leaseId: response.leaseId as string }) }
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
      error.code === 'OPERATION_CONFLICT' ||
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

  async function call(path: string, body: Record<string, unknown>): Promise<CoordinatorSuccess> {
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
      return result
    } catch (error) {
      if (error instanceof QuotaError) {
        throw error
      }
      throw new QuotaError('INTERNAL_ERROR')
    }
  }

  return {
    async getRemaining(deviceId: string): Promise<number> {
      const result = await call('/remaining', { deviceId })
      if (result.remaining === undefined) throw new QuotaError('INTERNAL_ERROR')
      return result.remaining
    },

    async reserve(deviceId: string, ipAddress: string): Promise<{ remaining: number }> {
      const result = await call('/reserve', { deviceId, ipAddress })
      if (result.remaining === undefined) throw new QuotaError('INTERNAL_ERROR')
      return { remaining: result.remaining }
    },

    async beginOverview(input: { keyHash: string; payloadHash: string }): Promise<{ leaseId: string }> {
      const result = await call('/overview/begin', input)
      if (result.leaseId === undefined) throw new QuotaError('INTERNAL_ERROR')
      return { leaseId: result.leaseId }
    },
    async releaseOverview(input: { keyHash: string; payloadHash: string; leaseId: string }): Promise<void> {
      await call('/overview/release', input)
    },
    async commitOverview(input: { keyHash: string; payloadHash: string; leaseId: string; deviceHash: string; ipHash: string; taskHash: string }): Promise<{ remaining: number }> {
      const result = await call('/overview/commit', input)
      if (result.remaining === undefined) throw new QuotaError('INTERNAL_ERROR')
      return { remaining: result.remaining }
    },
    async beginCandidate(input: { taskHash: string; payloadHash: string }): Promise<{ leaseId: string }> {
      const result = await call('/candidate/begin', input)
      if (result.leaseId === undefined) throw new QuotaError('INTERNAL_ERROR')
      return { leaseId: result.leaseId }
    },
    async releaseCandidate(input: { taskHash: string; payloadHash: string; leaseId: string }): Promise<void> {
      await call('/candidate/release', input)
    },
    async completeCandidate(input: { taskHash: string; payloadHash: string; leaseId: string }): Promise<void> {
      await call('/candidate/complete', input)
    },
  }
}
