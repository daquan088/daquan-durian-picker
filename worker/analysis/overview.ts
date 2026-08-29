import { overviewModelOutputSchema, type NumberedFruitAssessment, type OverviewFruit, type OverviewSuccessPayload } from '../../shared/contracts'
import { OpenAIClientError } from '../openai/client'
import { QuotaError } from '../quota/quotaService'
import { hashValue } from '../security/hash'
import { signTaskToken } from '../security/taskToken'
import {
  HttpError,
  assertExactKeys,
  assertRequestOrigin,
  jsonError,
  jsonSuccess,
  readClientIp,
  readDeviceId,
  readJsonObject,
  safeError,
  type AppDependencies,
} from '../http'

const MAX_IMAGE_BYTES = 6 * 1024 * 1024
const DATA_URL_PATTERN = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const STATUS_PRIORITY = { preferred: 0, normal: 1, risky: 2, insufficient: 3 } as const

type OverviewDependencies = Required<Pick<AppDependencies, 'env' | 'ai' | 'quota' | 'now' | 'randomUUID'>>

export async function handleOverview(request: Request, dependencies: OverviewDependencies): Promise<Response> {
  try {
    assertRequestOrigin(request, true)
    const deviceId = readDeviceId(request)
    const ipAddress = readClientIp(request)
    const body = await readJsonObject(request)
    assertExactKeys(body, ['image'])
    const image = validateImage(body.image)

    const remaining = await dependencies.quota.getRemaining(deviceId)
    if (remaining === 0) {
      throw new HttpError(429, 'QUOTA_EXHAUSTED', '今日试用次数已用完。')
    }

    let modelOutput: unknown
    try {
      modelOutput = await dependencies.ai.analyzeOverview({ images: [image], signal: request.signal })
    } catch (error) {
      throw mapProviderError(error)
    }
    const parsed = overviewModelOutputSchema.safeParse(modelOutput)
    if (!parsed.success) {
      throw new HttpError(502, 'MODEL_OUTPUT_INVALID', 'AI 返回的结果无效。')
    }
    if (!parsed.data.processable) {
      if (parsed.data.too_many) {
        throw new HttpError(422, 'INVALID_IMAGE', '画面中的榴莲过多，请减少榴莲数量后重试。')
      }
      throw new HttpError(400, 'INVALID_IMAGE', '图片无法用于识别。')
    }

    const fruits = numberFruits(parsed.data.fruits)
    const shortlistIds = chooseShortlist(fruits)
    if (shortlistIds.length === 0) {
      throw new HttpError(400, 'INVALID_IMAGE', '未识别到可推荐的榴莲。')
    }

    const now = dependencies.now()
    const nowSeconds = Math.floor(now.getTime() / 1000)
    if (!Number.isSafeInteger(nowSeconds)) {
      throw new HttpError(500, 'INTERNAL_ERROR', '服务暂时无法处理请求。')
    }

    let taskToken: string
    try {
      taskToken = await signTaskToken({
        taskId: dependencies.randomUUID(),
        deviceHash: await hashValue(dependencies.env.QUOTA_SALT, deviceId),
        allowedIds: shortlistIds,
        exp: nowSeconds + 2 * 60 * 60,
      }, dependencies.env.TASK_TOKEN_SECRET)
    } catch {
      throw new HttpError(500, 'INTERNAL_ERROR', '服务暂时无法处理请求。')
    }

    let reservation: { remaining: number }
    try {
      reservation = await dependencies.quota.reserve(deviceId, ipAddress)
    } catch (error) {
      throw mapQuotaError(error)
    }

    const data: OverviewSuccessPayload = {
      variety: 'thai-monthong',
      image_quality: parsed.data.image_quality,
      warnings: parsed.data.warnings,
      fruits,
      shortlist_ids: shortlistIds,
      taskToken,
      remaining: reservation.remaining,
    }
    return jsonSuccess(data)
  } catch (error) {
    return safeError(error)
  }
}

export function validateImage(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, 'INVALID_IMAGE', '图片数据无效。')
  }
  const match = DATA_URL_PATTERN.exec(value)
  if (!match) {
    if (value.startsWith('data:')) {
      const mime = /^data:([^;,]+)/.exec(value)?.[1]?.toLowerCase()
      if (mime !== undefined && !ALLOWED_IMAGE_TYPES.has(mime)) {
        throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '仅支持 JPEG、PNG 或 WebP 图片。')
      }
    }
    throw new HttpError(400, 'INVALID_IMAGE', '图片数据无效。')
  }
  const [, rawMime, encoded] = match
  const mime = rawMime.toLowerCase()
  if (!ALLOWED_IMAGE_TYPES.has(mime)) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '仅支持 JPEG、PNG 或 WebP 图片。')
  }
  if (encoded.length === 0 || encoded.length % 4 === 1) {
    throw new HttpError(400, 'INVALID_IMAGE', '图片数据无效。')
  }

  let decoded: string
  try {
    decoded = atob(encoded)
  } catch {
    throw new HttpError(400, 'INVALID_IMAGE', '图片数据无效。')
  }
  if (decoded.length === 0 || decoded.length > MAX_IMAGE_BYTES) {
    throw new HttpError(413, 'IMAGE_TOO_LARGE', '图片超过大小限制。')
  }
  return value
}

function numberFruits(fruits: readonly OverviewFruit[]): NumberedFruitAssessment[] {
  return [...fruits]
    .sort((left, right) =>
      left.box_2d[0] - right.box_2d[0] ||
      left.box_2d[1] - right.box_2d[1] ||
      left.box_2d[2] - right.box_2d[2] ||
      left.box_2d[3] - right.box_2d[3],
    )
    .map((fruit, index) => ({ ...fruit, id: index + 1 }))
}

function chooseShortlist(fruits: readonly NumberedFruitAssessment[]): number[] {
  return fruits
    .filter((fruit) => fruit.status !== 'insufficient' && fruit.evidence.length > 0)
    .sort((left, right) => STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status] || left.id - right.id)
    .slice(0, 5)
    .map(({ id }) => id)
}

function mapQuotaError(error: unknown): HttpError {
  if (error instanceof QuotaError) {
    if (error.code === 'QUOTA_EXHAUSTED') return new HttpError(429, error.code, '今日试用次数已用完。')
    if (error.code === 'IP_RATE_LIMIT') return new HttpError(429, error.code, '当前网络请求过于频繁。')
    if (error.code === 'INVALID_REQUEST') return new HttpError(400, error.code, '请求参数无效。')
  }
  return new HttpError(500, 'INTERNAL_ERROR', '服务暂时无法处理请求。')
}

function mapProviderError(error: unknown): HttpError {
  if (error instanceof OpenAIClientError) {
    switch (error.code) {
      case 'PROVIDER_RATE_LIMIT': return new HttpError(429, error.code, 'AI 服务暂时繁忙。')
      case 'PROVIDER_TIMEOUT': return new HttpError(504, error.code, 'AI 服务响应超时。')
      case 'PROVIDER_AUTH': return new HttpError(502, error.code, 'AI 服务暂时不可用。')
      case 'PROVIDER_FAILURE': return new HttpError(502, error.code, 'AI 服务暂时不可用。')
      case 'MODEL_OUTPUT_INVALID': return new HttpError(502, error.code, 'AI 返回的结果无效。')
    }
  }
  return new HttpError(502, 'PROVIDER_FAILURE', 'AI 服务暂时不可用。')
}
