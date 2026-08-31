import type { ApiErrorCode } from '../shared/contracts'
import { createOpenAIResponsesClient, type OpenAIResponsesClient } from './openai/client'
import { handleCandidates } from './analysis/candidates'
import { handleOverview } from './analysis/overview'
import { createQuotaCoordinatorClient } from './quota/quotaCoordinator'
import type { Env } from './env'

export const MAX_REQUEST_BODY_BYTES = 96 * 1024
/** Browser-generated canonical UUID required on every API request, including GET /api/quota. */
export const DEVICE_ID_HEADER = 'x-device-id'
/** Browser-generated canonical UUID required once per POST action and reused for transport retries. */
export const IDEMPOTENCY_KEY_HEADER = 'x-idempotency-key'

const JSON_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export interface QuotaCoordinatorClient {
  getRemaining(deviceId: string): Promise<number>
  reserve(deviceId: string, ipAddress: string): Promise<{ remaining: number }>
  beginOverview(input: { keyHash: string; payloadHash: string }): Promise<{ leaseId: string }>
  releaseOverview(input: { keyHash: string; payloadHash: string; leaseId: string }): Promise<void>
  commitOverview(input: { keyHash: string; payloadHash: string; leaseId: string; deviceHash: string; ipHash: string; taskHash: string }): Promise<{ remaining: number }>
  beginCandidate(input: { taskHash: string; payloadHash: string }): Promise<{ leaseId: string }>
  releaseCandidate(input: { taskHash: string; payloadHash: string; leaseId: string }): Promise<void>
  completeCandidate(input: { taskHash: string; payloadHash: string; leaseId: string }): Promise<void>
}

export interface AppDependencies {
  env: Env
  ai?: OpenAIResponsesClient
  quota?: QuotaCoordinatorClient
  now?: () => Date
  randomUUID?: () => string
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    readonly message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export function jsonSuccess(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status, headers: JSON_HEADERS })
}

export function jsonError(status: number, code: ApiErrorCode, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), { status, headers: JSON_HEADERS })
}

export function safeError(error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonError(error.status, error.code, error.message)
  }
  return jsonError(500, 'INTERNAL_ERROR', '服务暂时无法处理请求。')
}

export function assertRequestOrigin(request: Request, isMutation: boolean): void {
  const origin = request.headers.get('origin')
  if (origin === null && !isMutation) return
  if (origin === null || origin !== new URL(request.url).origin) {
    throw new HttpError(400, 'INVALID_REQUEST', '请求来源无效。')
  }
}

export function readDeviceId(request: Request): string {
  const deviceId = request.headers.get(DEVICE_ID_HEADER)
  if (deviceId === null || !UUID_V4_PATTERN.test(deviceId)) {
    throw new HttpError(400, 'INVALID_REQUEST', '设备标识无效。')
  }
  return deviceId
}

export function readIdempotencyKey(request: Request): string {
  const key = request.headers.get(IDEMPOTENCY_KEY_HEADER)
  if (key === null || !UUID_V4_PATTERN.test(key)) {
    throw new HttpError(400, 'INVALID_REQUEST', '幂等请求标识无效。')
  }
  return key
}

export function readClientIp(request: Request): string {
  const ipAddress = request.headers.get('cf-connecting-ip')
  if (ipAddress === null || ipAddress.length === 0 || ipAddress.length > 128) {
    throw new HttpError(400, 'INVALID_REQUEST', '请求无法验证。')
  }
  return ipAddress
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type')
  if (contentType === null || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType.trim())) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '请求必须使用 JSON 格式。')
  }

  const contentLength = request.headers.get('content-length')
  if (contentLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(contentLength) || Number(contentLength) > MAX_REQUEST_BODY_BYTES) {
      await cancelRequestBody(request, 'request body exceeds the maximum size')
      throw new HttpError(413, 'IMAGE_TOO_LARGE', '请求内容超过大小限制。')
    }
  }

  let text = ''
  let total = 0
  const reader = request.body?.getReader()
  if (reader) {
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_REQUEST_BODY_BYTES) {
          throw new HttpError(413, 'IMAGE_TOO_LARGE', '请求内容超过大小限制。')
        }
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
    } catch (error) {
      try {
        await reader.cancel(error)
      } catch {
        // The request is already failing; cancellation errors are not client-visible.
      }
      throw error
    } finally {
      reader.releaseLock()
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'INVALID_REQUEST', '请求 JSON 无效。')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'INVALID_REQUEST', '请求参数无效。')
  }
  return parsed as Record<string, unknown>
}

async function cancelRequestBody(request: Request, reason: string): Promise<void> {
  try {
    await request.body?.cancel(reason)
  } catch {
    // The response remains a size error even if the transport is already closed.
  }
}

export function assertExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): void {
  const keys = Object.keys(value)
  if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !Object.hasOwn(value, key))) {
    throw new HttpError(400, 'INVALID_REQUEST', '请求参数无效。')
  }
}

export function createApp(dependencies: AppDependencies) {
  const { env } = dependencies
  let ai = dependencies.ai
  let quota = dependencies.quota
  const now = dependencies.now ?? (() => new Date())
  const randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID())

  const getAi = (): OpenAIResponsesClient => {
    ai ??= createOpenAIResponsesClient({ env })
    return ai
  }
  const getQuota = (): QuotaCoordinatorClient => {
    quota ??= createQuotaCoordinatorClient(env)
    return quota
  }

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)
      if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
        return env.ASSETS.fetch(request)
      }

      try {
        if (request.method === 'GET' && url.pathname === '/api/quota') {
          assertRequestOrigin(request, false)
          const deviceId = readDeviceId(request)
          const remaining = await getQuota().getRemaining(deviceId)
          return jsonSuccess({ remaining })
        }
        if (request.method === 'POST' && url.pathname === '/api/analyze-overview') {
          return await handleOverview(request, { env, ai: getAi(), quota: getQuota(), now, randomUUID })
        }
        if (request.method === 'POST' && url.pathname === '/api/analyze-candidates') {
          return await handleCandidates(request, { env, ai: getAi(), quota: getQuota(), now })
        }
        return jsonError(404, 'NOT_FOUND', '请求地址不存在。')
      } catch (error) {
        return safeError(error)
      }
    },
  }
}
