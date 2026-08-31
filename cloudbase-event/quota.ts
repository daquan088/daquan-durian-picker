import { sign } from '@cloudbase/signature-nodejs'
import type { QuotaCoordinatorClient } from '../worker/http'
import { QuotaError, type QuotaErrorCode } from '../worker/quota/quotaService'
import { hashValue } from '../worker/security/hash'

const ACTIONS = new Set([
  'get_remaining', 'begin_overview', 'release_overview', 'commit_overview',
  'begin_candidate', 'release_candidate', 'complete_candidate',
])

function errorCode(message: string): QuotaErrorCode {
  if (message.includes('DURIAN_QUOTA_EXHAUSTED')) return 'QUOTA_EXHAUSTED'
  if (message.includes('DURIAN_IP_RATE_LIMIT')) return 'IP_RATE_LIMIT'
  if (message.includes('DURIAN_OPERATION_CONFLICT')) return 'OPERATION_CONFLICT'
  if (message.includes('DURIAN_INVALID_REQUEST')) return 'INVALID_REQUEST'
  return 'INTERNAL_ERROR'
}

export function createPostgresQuotaClient(salt: string): QuotaCoordinatorClient {
  const envId = process.env.TCB_ENV
  const secretId = process.env.TENCENTCLOUD_SECRETID
  const secretKey = process.env.TENCENTCLOUD_SECRETKEY
  const sessionToken = process.env.TENCENTCLOUD_SESSIONTOKEN
  if (!envId || !secretId || !secretKey) throw new QuotaError('INTERNAL_ERROR')
  const endpoint = `https://${envId}.api.tcloudbasegateway.com/v1/rdb/rest/rpc/durian_quota`
  const tokenEndpoint = `https://${envId}.api.tcloudbasegateway.com/auth/v1/token/clientCredential`
  let cachedToken: { value: string; expiresAt: number } | undefined

  async function clientToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value
    const data = await signedRequest(tokenEndpoint, { grant_type: 'client_credentials' })
    if (typeof data.access_token !== 'string' || !data.access_token) throw new QuotaError('INTERNAL_ERROR')
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 600
    cachedToken = { value: data.access_token, expiresAt: Date.now() + expiresIn * 1000 }
    return cachedToken.value
  }

  async function signedRequest(urlString: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = new URL(urlString)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Host': url.host,
      'User-Agent': 'durian-picker-cloudbase/1.0',
      'X-Client-Timestamp': String(Date.now()),
      'X-SDK-Version': 'durian-picker-cloudbase/1.0',
      'X-TCB-Source': `${process.env.TCB_SOURCE || ''},scf`,
    }
    if (process.env.TENCENTCLOUD_REGION) headers['X-TCB-Region'] = process.env.TENCENTCLOUD_REGION
    const signed = sign({
      secretId, secretKey, method: 'POST', url: urlString, headers, params: body,
      timestamp: Math.floor(Date.now() / 1000) - 1, withSignedParams: false, isCloudApi: true,
    })
    headers.Authorization = sessionToken
      ? `${signed.authorization}, Timestamp=${signed.timestamp}, Token=${sessionToken}`
      : `${signed.authorization}, Timestamp=${signed.timestamp}`
    const response = await fetch(urlString, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    })
    const data: unknown = await response.json()
    if (!response.ok) {
      const message = typeof data === 'object' && data !== null && 'message' in data
        ? String(data.message)
        : `HTTP_${response.status}`
      throw new Error(message)
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new QuotaError('INTERNAL_ERROR')
    return data as Record<string, unknown>
  }

  async function rpc(action: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!ACTIONS.has(action)) throw new QuotaError('INVALID_REQUEST')
    const body = { p_action: action, p_payload: payload }
    const headers: Record<string, string> = {
      'Accept-Profile': 'public',
      'Content-Profile': 'public',
      'Content-Type': 'application/json',
    }

    try {
      headers.Authorization = `Bearer ${await clientToken()}`
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      })
      const data: unknown = await response.json()
      if (!response.ok) {
        const message = typeof data === 'object' && data !== null && 'message' in data
          ? String(data.message)
          : `HTTP_${response.status}`
        throw new Error(message)
      }
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new QuotaError('INTERNAL_ERROR')
      }
      return data as Record<string, unknown>
    } catch (error) {
      if (error instanceof QuotaError) throw error
      const message = error instanceof Error ? `${error.name}:${error.message}` : String(error)
      throw new QuotaError(errorCode(message))
    }
  }

  function remaining(result: Record<string, unknown>): number {
    if (!Number.isSafeInteger(result.remaining) || (result.remaining as number) < 0 || (result.remaining as number) > 5) {
      throw new QuotaError('INTERNAL_ERROR')
    }
    return result.remaining as number
  }

  return {
    async getRemaining(deviceId) {
      return remaining(await rpc('get_remaining', { device_hash: await hashValue(salt, deviceId) }))
    },
    async reserve() {
      throw new QuotaError('INTERNAL_ERROR')
    },
    async beginOverview(input) {
      const leaseId = crypto.randomUUID()
      await rpc('begin_overview', { key_hash: input.keyHash, payload_hash: input.payloadHash, lease_id: leaseId })
      return { leaseId }
    },
    async releaseOverview(input) {
      await rpc('release_overview', { key_hash: input.keyHash, payload_hash: input.payloadHash, lease_id: input.leaseId })
    },
    async commitOverview(input) {
      return { remaining: remaining(await rpc('commit_overview', {
        key_hash: input.keyHash,
        payload_hash: input.payloadHash,
        lease_id: input.leaseId,
        device_hash: input.deviceHash,
        ip_hash: input.ipHash,
        task_hash: input.taskHash,
      })) }
    },
    async beginCandidate(input) {
      const leaseId = crypto.randomUUID()
      await rpc('begin_candidate', { task_hash: input.taskHash, payload_hash: input.payloadHash, lease_id: leaseId })
      return { leaseId }
    },
    async releaseCandidate(input) {
      await rpc('release_candidate', { task_hash: input.taskHash, payload_hash: input.payloadHash, lease_id: input.leaseId })
    },
    async completeCandidate(input) {
      await rpc('complete_candidate', { task_hash: input.taskHash, payload_hash: input.payloadHash, lease_id: input.leaseId })
    },
  }
}
