import {
  numberedFruitAssessmentSchema,
  overviewModelOutputSchema,
  type NumberedFruitAssessment,
  type OverviewFruit,
  type OverviewSuccessPayload,
} from '../../shared/contracts'
import { sanitizeAndNumberBoxes } from '../../shared/geometry'
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
  readIdempotencyKey,
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
    const idempotencyKey = readIdempotencyKey(request)
    const ipAddress = readClientIp(request)
    const body = await readJsonObject(request)
    assertExactKeys(body, ['image'])
    const image = validateImage(body.image)

    const [deviceHash, ipHash, idempotencyHash, payloadHash] = await Promise.all([
      hashValue(dependencies.env.QUOTA_SALT, deviceId),
      hashValue(dependencies.env.QUOTA_SALT, ipAddress),
      hashValue(dependencies.env.QUOTA_SALT, idempotencyKey),
      hashValue(dependencies.env.QUOTA_SALT, JSON.stringify(body)),
    ])
    const operationKeyHash = await hashValue(dependencies.env.QUOTA_SALT, `${deviceHash}:${idempotencyHash}`)
    let leaseId: string
    try {
      leaseId = (await dependencies.quota.beginOverview({ keyHash: operationKeyHash, payloadHash })).leaseId
    } catch (error) {
      throw mapQuotaError(error)
    }
    let claimed = true

    try {

    const remaining = await dependencies.quota.getRemaining(deviceId)
    if (remaining === 0) {
      throw new HttpError(429, 'QUOTA_EXHAUSTED', '体验次数已用完。')
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
    let taskId: string
    try {
      taskId = dependencies.randomUUID()
      taskToken = await signTaskToken({
        taskId,
        deviceHash: await hashValue(dependencies.env.QUOTA_SALT, deviceId),
        allowedIds: shortlistIds,
        exp: nowSeconds + 2 * 60 * 60,
      }, dependencies.env.TASK_TOKEN_SECRET)
    } catch {
      throw new HttpError(500, 'INTERNAL_ERROR', '服务暂时无法处理请求。')
    }

    let reservation: { remaining: number }
    try {
      reservation = await dependencies.quota.commitOverview({
        keyHash: operationKeyHash,
        payloadHash,
        leaseId,
        deviceHash,
        ipHash,
        taskHash: await hashValue(dependencies.env.QUOTA_SALT, taskId),
      })
      claimed = false
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
      if (claimed) {
        try {
          await dependencies.quota.releaseOverview({ keyHash: operationKeyHash, payloadHash, leaseId })
        } catch {
          // A lease bounds retained processing state; do not replace the original safe error.
        }
      }
      throw error
    }
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
  if (!matchesImageMagic(mime, decoded)) {
    throw new HttpError(400, 'INVALID_IMAGE', '图片数据无效。')
  }
  return value
}

function matchesImageMagic(mime: string, bytes: string): boolean {
  const byteAt = (index: number) => bytes.charCodeAt(index)
  if (mime === 'image/jpeg') {
    return bytes.length >= 3 && byteAt(0) === 0xff && byteAt(1) === 0xd8 && byteAt(2) === 0xff
  }
  if (mime === 'image/png') {
    return bytes.length >= 8 &&
      byteAt(0) === 0x89 && byteAt(1) === 0x50 && byteAt(2) === 0x4e && byteAt(3) === 0x47 &&
      byteAt(4) === 0x0d && byteAt(5) === 0x0a && byteAt(6) === 0x1a && byteAt(7) === 0x0a
  }
  return bytes.length >= 12 &&
    byteAt(0) === 0x52 && byteAt(1) === 0x49 && byteAt(2) === 0x46 && byteAt(3) === 0x46 &&
    byteAt(8) === 0x57 && byteAt(9) === 0x45 && byteAt(10) === 0x42 && byteAt(11) === 0x50
}

function numberFruits(fruits: readonly OverviewFruit[]): NumberedFruitAssessment[] {
  return sanitizeAndNumberBoxes(fruits).map((fruit) => {
    const parsed = numberedFruitAssessmentSchema.safeParse(fruit)
    if (!parsed.success) {
      throw new HttpError(502, 'MODEL_OUTPUT_INVALID', 'AI 返回的结果无效。')
    }
    return parsed.data
  })
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
    if (error.code === 'QUOTA_EXHAUSTED') return new HttpError(429, error.code, '体验次数已用完。')
    if (error.code === 'IP_RATE_LIMIT') return new HttpError(429, error.code, '当前网络请求过于频繁。')
    if (error.code === 'OPERATION_CONFLICT') return new HttpError(409, 'INVALID_REQUEST', '请求已处理或正在处理。')
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
