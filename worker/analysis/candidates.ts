import { finalRankingSchema } from '../../shared/contracts'
import { OpenAIClientError, type CandidateImageInput } from '../openai/client'
import { hashValue } from '../security/hash'
import { assertCandidateAllowed, verifyTaskToken } from '../security/taskToken'
import {
  HttpError,
  assertExactKeys,
  assertRequestOrigin,
  jsonSuccess,
  readDeviceId,
  readJsonObject,
  safeError,
  type AppDependencies,
} from '../http'
import { validateImage } from './overview'

type CandidateDependencies = Required<Pick<AppDependencies, 'env' | 'ai' | 'now'>>

export async function handleCandidates(request: Request, dependencies: CandidateDependencies): Promise<Response> {
  try {
    assertRequestOrigin(request, true)
    const deviceId = readDeviceId(request)
    const body = await readJsonObject(request)
    assertExactKeys(body, ['taskToken', 'candidates'])
    if (typeof body.taskToken !== 'string' || body.taskToken.length === 0 || body.taskToken.length > 4096) {
      throw new HttpError(400, 'INVALID_REQUEST', '请求参数无效。')
    }
    const candidates = parseCandidates(body.candidates)

    let task
    try {
      task = await verifyTaskToken(body.taskToken, dependencies.env.TASK_TOKEN_SECRET, Math.floor(dependencies.now().getTime() / 1000))
      if (task.deviceHash !== await hashValue(dependencies.env.QUOTA_SALT, deviceId)) {
        throw new Error('device mismatch')
      }
      for (const candidate of candidates) assertCandidateAllowed(task, candidate.candidate_id)
    } catch {
      throw new HttpError(403, 'INVALID_TASK', '任务无效或已过期。')
    }

    let result: unknown
    try {
      result = await dependencies.ai.analyzeCandidates({ candidates, signal: request.signal })
    } catch (error) {
      throw mapProviderError(error)
    }
    const parsed = finalRankingSchema.safeParse(result)
    if (!parsed.success || parsed.data.ranking.some(({ candidate_id }) => !candidates.some((candidate) => candidate.candidate_id === candidate_id))) {
      throw new HttpError(502, 'MODEL_OUTPUT_INVALID', 'AI 返回的结果无效。')
    }
    return jsonSuccess({ variety: 'thai-monthong', result: parsed.data })
  } catch (error) {
    return safeError(error)
  }
}

function parseCandidates(value: unknown): CandidateImageInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    throw new HttpError(400, 'INVALID_REQUEST', '候选榴莲数量无效。')
  }
  const ids = new Set<number>()
  return value.map((candidate) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new HttpError(400, 'INVALID_REQUEST', '候选榴莲参数无效。')
    }
    const record = candidate as Record<string, unknown>
    assertExactKeys(record, ['candidate_id', 'stem', 'body', 'bottom'])
    if (!Number.isSafeInteger(record.candidate_id) || (record.candidate_id as number) <= 0 || ids.has(record.candidate_id as number)) {
      throw new HttpError(400, 'INVALID_REQUEST', '候选榴莲参数无效。')
    }
    const candidate_id = record.candidate_id as number
    ids.add(candidate_id)
    return {
      candidate_id,
      stem: validateImage(record.stem),
      body: validateImage(record.body),
      bottom: validateImage(record.bottom),
    }
  })
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
