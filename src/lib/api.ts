import {
  apiErrorEnvelopeSchema,
  finalRankingSuccessEnvelopeSchema,
  overviewSuccessEnvelopeSchema,
  quotaSuccessEnvelopeSchema,
  type ApiErrorCode,
  type CandidateFollowUpPayload,
  type FinalRankingSuccessPayload,
  type OverviewSuccessPayload,
} from '../../shared/contracts'
import { getDeviceId } from './deviceId'

/** Must stay aligned with worker/http.ts MAX_REQUEST_BODY_BYTES. */
export const API_MAX_REQUEST_BODY_BYTES = 96 * 1024

export class AppError extends Error {
  constructor(
    readonly code: ApiErrorCode | 'NETWORK_ERROR' | 'INVALID_RESPONSE' | 'PAYLOAD_TOO_LARGE',
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export interface RequestOptions {
  signal?: AbortSignal
  /** Keep this value for a transport retry of the same logical POST action. */
  idempotencyKey?: string
}

export interface OverviewRequest {
  image: string
}

const SAFE_NETWORK_MESSAGE = '服务暂时无法连接，请稍后重试。'

export function createIdempotencyKey(): string {
  return globalThis.crypto.randomUUID()
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}

async function readApiResponse<T>(response: Response, parseSuccess: (value: unknown) => { success: boolean; data?: T }): Promise<T> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new AppError('INTERNAL_ERROR', SAFE_NETWORK_MESSAGE, response.status)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new AppError('INVALID_RESPONSE', SAFE_NETWORK_MESSAGE, response.status)
  }

  const error = apiErrorEnvelopeSchema.safeParse(body)
  if (error.success) throw new AppError(error.data.error.code, error.data.error.message, response.status)

  const success = parseSuccess(body)
  if (success.success && success.data !== undefined) return success.data
  throw new AppError('INVALID_RESPONSE', SAFE_NETWORK_MESSAGE, response.status)
}

async function request<T>(
  path: string,
  init: RequestInit,
  parseSuccess: (value: unknown) => { success: boolean; data?: T },
): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        'x-device-id': getDeviceId(),
        ...init.headers,
      },
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new AppError('NETWORK_ERROR', SAFE_NETWORK_MESSAGE)
  }
  return readApiResponse(response, parseSuccess)
}

export async function requestQuota(options: Pick<RequestOptions, 'signal'> = {}): Promise<{ remaining: number }> {
  return request('/api/quota', { method: 'GET', signal: options.signal }, (value) => {
    const parsed = quotaSuccessEnvelopeSchema.safeParse(value)
    return parsed.success ? { success: true, data: parsed.data.data } : { success: false }
  })
}

export async function requestOverview(payload: OverviewRequest, options: RequestOptions = {}): Promise<OverviewSuccessPayload> {
  return request('/api/analyze-overview', {
    method: 'POST',
    signal: options.signal,
    headers: {
      'content-type': 'application/json',
      'x-idempotency-key': options.idempotencyKey ?? createIdempotencyKey(),
    },
    body: JSON.stringify(payload),
  }, (value) => {
    const parsed = overviewSuccessEnvelopeSchema.safeParse(value)
    return parsed.success ? { success: true, data: parsed.data.data } : { success: false }
  })
}

export async function requestCandidates(payload: CandidateFollowUpPayload, options: RequestOptions = {}): Promise<FinalRankingSuccessPayload> {
  const body = JSON.stringify(payload)
  if (new TextEncoder().encode(body).byteLength > API_MAX_REQUEST_BODY_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', '补拍图片总大小超过限制，请重新拍摄或减少图片大小。')
  }
  return request('/api/analyze-candidates', {
    method: 'POST',
    signal: options.signal,
    headers: {
      'content-type': 'application/json',
      'x-idempotency-key': options.idempotencyKey ?? createIdempotencyKey(),
    },
    body,
  }, (value) => {
    const parsed = finalRankingSuccessEnvelopeSchema.safeParse(value)
    return parsed.success ? { success: true, data: parsed.data.data } : { success: false }
  })
}
