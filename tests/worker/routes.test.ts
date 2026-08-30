// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../worker/http'
import { OpenAIClientError, type OpenAIResponsesClient } from '../../worker/openai/client'
import { QuotaError } from '../../worker/quota/quotaService'
import { verifyTaskToken } from '../../worker/security/taskToken'

const origin = 'https://picker.example'
const deviceId = '123e4567-e89b-42d3-a456-426614174000'
const otherDeviceId = '123e4567-e89b-42d3-a456-426614174001'
const idempotencyKey = '123e4567-e89b-42d3-a456-426614174099'
const image = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='

const overview = {
  processable: true,
  too_many: false,
  image_quality: 'good' as const,
  warnings: [],
  fruits: [
    { box_2d: [500, 100, 800, 400] as [number, number, number, number], visibility: 'high' as const, status: 'normal' as const, evidence: ['果形完整'], risks: [], evidence_strength: 'high' as const },
    { box_2d: [100, 500, 400, 800] as [number, number, number, number], visibility: 'high' as const, status: 'preferred' as const, evidence: ['刺形均匀'], risks: [], evidence_strength: 'high' as const },
    { box_2d: [100, 100, 400, 400] as [number, number, number, number], visibility: 'medium' as const, status: 'risky' as const, evidence: ['果柄可见'], risks: [], evidence_strength: 'medium' as const },
  ],
}

const ranking = {
  ranking: [{ candidate_id: 1, rank: 1, appearance_score: 88, evidence: ['果形完整'], risks: [], evidence_strength: 'high' as const }],
  summary: '优先选择 1 号。',
  limitations: ['仅根据可见外观判断。'],
}

function makeApp(options: {
  remaining?: number
  overviewResult?: unknown
  candidateResult?: unknown
  overviewError?: Error
  candidateError?: Error
} = {}) {
  const ai = {
    analyzeOverview: vi.fn().mockImplementation(async () => {
      if (options.overviewError) throw options.overviewError
      return options.overviewResult ?? overview
    }),
    analyzeCandidates: vi.fn().mockImplementation(async () => {
      if (options.candidateError) throw options.candidateError
      return options.candidateResult ?? ranking
    }),
  } satisfies OpenAIResponsesClient
  const operations = new Map<string, { payloadHash: string; state: 'processing' | 'completed' }>()
  const taskHashes = new Set<string>()
  const quota = {
    getRemaining: vi.fn().mockResolvedValue(options.remaining ?? 5),
    reserve: vi.fn().mockResolvedValue({ remaining: 4 }),
    beginOverview: vi.fn(async ({ keyHash, payloadHash }: { keyHash: string; payloadHash: string }) => {
      if (operations.has(keyHash)) throw new QuotaError('OPERATION_CONFLICT')
      operations.set(keyHash, { payloadHash, state: 'processing' })
    }),
    releaseOverview: vi.fn(async ({ keyHash, payloadHash }: { keyHash: string; payloadHash: string }) => {
      const operation = operations.get(keyHash)
      if (operation?.state === 'processing' && operation.payloadHash === payloadHash) operations.delete(keyHash)
    }),
    commitOverview: vi.fn(async ({ keyHash, payloadHash, taskHash }: { keyHash: string; payloadHash: string; taskHash: string }) => {
      const operation = operations.get(keyHash)
      if (operation?.state !== 'processing' || operation.payloadHash !== payloadHash) throw new QuotaError('OPERATION_CONFLICT')
      const result = await quota.reserve(deviceId, '203.0.113.7')
      operation.state = 'completed'
      taskHashes.add(taskHash)
      return result
    }),
    beginCandidate: vi.fn(async ({ taskHash, payloadHash }: { taskHash: string; payloadHash: string }) => {
      if (!taskHashes.has(taskHash) || operations.has(taskHash)) throw new QuotaError('OPERATION_CONFLICT')
      operations.set(taskHash, { payloadHash, state: 'processing' })
    }),
    releaseCandidate: vi.fn(async ({ taskHash, payloadHash }: { taskHash: string; payloadHash: string }) => {
      const operation = operations.get(taskHash)
      if (operation?.state === 'processing' && operation.payloadHash === payloadHash) operations.delete(taskHash)
    }),
    completeCandidate: vi.fn(async ({ taskHash, payloadHash }: { taskHash: string; payloadHash: string }) => {
      const operation = operations.get(taskHash)
      if (operation?.state !== 'processing' || operation.payloadHash !== payloadHash) throw new QuotaError('OPERATION_CONFLICT')
      operation.state = 'completed'
    }),
  }
  const assets = { fetch: vi.fn().mockResolvedValue(new Response('asset')) }
  const app = createApp({
    env: {
      ASSETS: assets,
      MODEL_ID: 'test-model',
      OPENAI_API_KEY: 'test-key',
      QUOTA_SALT: 'test-salt',
      TASK_TOKEN_SECRET: 'test-secret',
    } as never,
    ai,
    quota,
    now: () => new Date('2026-08-30T00:00:00.000Z'),
    randomUUID: () => '00000000-0000-4000-8000-000000000001',
  })
  return { app, ai, quota, assets }
}

function apiRequest(path: string, body?: unknown, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers)
  if (!headers.has('origin')) headers.set('origin', origin)
  if (!headers.has('x-device-id')) headers.set('x-device-id', deviceId)
  if (!headers.has('x-idempotency-key')) headers.set('x-idempotency-key', idempotencyKey)
  if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', '203.0.113.7')
  if (body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8')
  return new Request(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...init,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status)
  await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code } })
}

describe('secure analysis routes', () => {
  it('rejects invalid images and returns a validated overview without exposing body data', async () => {
    const { app, ai, quota } = makeApp()
    await expectError(await app.fetch(apiRequest('/api/analyze-overview', { image: 'not-an-image' })), 400, 'INVALID_IMAGE')
    expect(ai.analyzeOverview).not.toHaveBeenCalled()
    expect(quota.reserve).not.toHaveBeenCalled()

    const response = await app.fetch(apiRequest('/api/analyze-overview', { image }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { variety: 'thai-monthong', shortlist_ids: [2, 3, 1], remaining: 4 },
    })
    expect(quota.reserve).toHaveBeenCalledWith(deviceId, '203.0.113.7')
  })

  it('rejects cross-origin or originless mutations and mismatched quota reads', async () => {
    const { app, ai, quota } = makeApp()
    const crossOrigin = apiRequest('/api/analyze-overview', { image }, { headers: { origin: 'https://evil.example', 'x-device-id': deviceId, 'cf-connecting-ip': '203.0.113.7', 'content-type': 'application/json' } })
    await expectError(await app.fetch(crossOrigin), 400, 'INVALID_REQUEST')
    const originless = new Request(`${origin}/api/analyze-overview`, { method: 'POST', headers: { 'x-device-id': deviceId, 'cf-connecting-ip': '203.0.113.7', 'content-type': 'application/json' }, body: JSON.stringify({ image }) })
    await expectError(await app.fetch(originless), 400, 'INVALID_REQUEST')
    await expectError(await app.fetch(apiRequest('/api/quota', undefined, { headers: { origin: 'https://evil.example', 'x-device-id': deviceId } })), 400, 'INVALID_REQUEST')
    expect(ai.analyzeOverview).not.toHaveBeenCalled()
    expect(quota.getRemaining).not.toHaveBeenCalled()
  })

  it('allows an originless quota read through the documented x-device-id header contract without reserving', async () => {
    const { app, quota } = makeApp({ remaining: 3 })
    const response = await app.fetch(new Request(`${origin}/api/quota`, { headers: { 'x-device-id': deviceId } }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, data: { remaining: 3 } })
    expect(quota.getRemaining).toHaveBeenCalledWith(deviceId)
    expect(quota.reserve).not.toHaveBeenCalled()
  })

  it('enforces the total 25 MiB request cap before JSON parsing', async () => {
    const { app, ai } = makeApp()
    const request = new Request(`${origin}/api/analyze-overview`, {
      method: 'POST',
      headers: { origin, 'x-device-id': deviceId, 'x-idempotency-key': idempotencyKey, 'cf-connecting-ip': '203.0.113.7', 'content-type': 'application/json', 'content-length': String(25 * 1024 * 1024 + 1) },
      body: JSON.stringify({ image }),
    })
    await expectError(await app.fetch(request), 413, 'IMAGE_TOO_LARGE')
    expect(ai.analyzeOverview).not.toHaveBeenCalled()
  })

  it('cancels a declared oversized request body before returning 413', async () => {
    const { app, ai } = makeApp()
    const cancelled = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(1)) },
      cancel: cancelled,
    })
    const request = new Request(`${origin}/api/analyze-overview`, {
      method: 'POST',
      headers: { origin, 'x-device-id': deviceId, 'x-idempotency-key': idempotencyKey, 'cf-connecting-ip': '203.0.113.7', 'content-type': 'application/json', 'content-length': String(25 * 1024 * 1024 + 1) },
      body,
      duplex: 'half',
    } as RequestInit)
    await expectError(await app.fetch(request), 413, 'IMAGE_TOO_LARGE')
    expect(cancelled).toHaveBeenCalledOnce()
    expect(ai.analyzeOverview).not.toHaveBeenCalled()
  })

  it('enforces the 25 MiB cap while reading an unbounded streaming body without Content-Length', async () => {
    const { app, ai } = makeApp()
    const chunk = new Uint8Array(1024 * 1024)
    let emitted = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted === 26) {
          controller.close()
          return
        }
        emitted += 1
        controller.enqueue(chunk)
      },
    })
    const request = new Request(`${origin}/api/analyze-overview`, {
      method: 'POST',
      headers: { origin, 'x-device-id': deviceId, 'x-idempotency-key': idempotencyKey, 'cf-connecting-ip': '203.0.113.7', 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit)

    expect(request.headers.get('content-length')).toBeNull()
    await expectError(await app.fetch(request), 413, 'IMAGE_TOO_LARGE')
    expect(ai.analyzeOverview).not.toHaveBeenCalled()
  })

  it('cancels an oversized streaming request after crossing the body limit', async () => {
    const { app, ai } = makeApp()
    const cancelled = vi.fn()
    const chunk = new Uint8Array(1024 * 1024)
    let emitted = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted === 26) return controller.close()
        emitted += 1
        controller.enqueue(chunk)
      },
      cancel: cancelled,
    })
    const request = new Request(`${origin}/api/analyze-overview`, {
      method: 'POST',
      headers: { origin, 'x-device-id': deviceId, 'x-idempotency-key': idempotencyKey, 'cf-connecting-ip': '203.0.113.7', 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit)
    await expectError(await app.fetch(request), 413, 'IMAGE_TOO_LARGE')
    expect(cancelled).toHaveBeenCalledOnce()
    expect(ai.analyzeOverview).not.toHaveBeenCalled()
  })

  it('allows only JPEG, PNG, or WebP base64 data URLs', async () => {
    const { app, ai } = makeApp()
    await expectError(await app.fetch(apiRequest('/api/analyze-overview', { image: 'data:image/gif;base64,R0lGODlh' })), 415, 'UNSUPPORTED_MEDIA_TYPE')
    await expectError(await app.fetch(apiRequest('/api/analyze-overview', { image: 'data:image/png;base64,***' })), 400, 'INVALID_IMAGE')
    expect(ai.analyzeOverview).not.toHaveBeenCalled()
  })

  it('rejects MIME-spoofed and random image bytes before quota or AI preflight', async () => {
    const { app, ai, quota } = makeApp()
    await expectError(await app.fetch(apiRequest('/api/analyze-overview', { image: 'data:image/jpeg;base64,R0lGODlh' })), 400, 'INVALID_IMAGE')
    await expectError(await app.fetch(apiRequest('/api/analyze-overview', { image: 'data:image/png;base64,AAAAAA==' })), 400, 'INVALID_IMAGE')
    expect(ai.analyzeOverview).not.toHaveBeenCalled()
    expect(quota.getRemaining).not.toHaveBeenCalled()
  })

  it('rejects four candidates and candidates that do not contain exactly three named views', async () => {
    const { app } = makeApp()
    const four = { taskToken: 'invalid', candidates: [1, 2, 3, 4].map((candidate_id) => ({ candidate_id, stem: image, body: image, bottom: image })) }
    await expectError(await app.fetch(apiRequest('/api/analyze-candidates', four)), 400, 'INVALID_REQUEST')
    const missingView = { taskToken: 'invalid', candidates: [{ candidate_id: 1, stem: image, body: image }] }
    await expectError(await app.fetch(apiRequest('/api/analyze-candidates', missingView)), 400, 'INVALID_REQUEST')
  })

  it('rejects tampered tokens, a device mismatch, and IDs outside the signed shortlist', async () => {
    const { app, ai } = makeApp()
    const overviewResponse = await app.fetch(apiRequest('/api/analyze-overview', { image }))
    const token = (await overviewResponse.json() as { data: { taskToken: string } }).data.taskToken
    const candidates = [{ candidate_id: 2, stem: image, body: image, bottom: image }]
    await expectError(await app.fetch(apiRequest('/api/analyze-candidates', { taskToken: `${token}x`, candidates })), 403, 'INVALID_TASK')
    await expectError(await app.fetch(apiRequest('/api/analyze-candidates', { taskToken: token, candidates }, { headers: { origin, 'x-device-id': otherDeviceId, 'cf-connecting-ip': '203.0.113.7', 'content-type': 'application/json' } })), 403, 'INVALID_TASK')
    await expectError(await app.fetch(apiRequest('/api/analyze-candidates', { taskToken: token, candidates: [{ ...candidates[0], candidate_id: 99 }] })), 403, 'INVALID_TASK')
    expect(ai.analyzeCandidates).not.toHaveBeenCalled()
  })

  it('does not call AI when quota is exhausted and does not charge rejected overview results', async () => {
    const exhausted = makeApp({ remaining: 0 })
    const exhaustedResponse = await exhausted.app.fetch(apiRequest('/api/analyze-overview', { image }))
    expect(exhaustedResponse.status).toBe(429)
    await expect(exhaustedResponse.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'QUOTA_EXHAUSTED', message: '体验次数已用完。' },
    })
    expect(exhausted.ai.analyzeOverview).not.toHaveBeenCalled()
    expect(exhausted.quota.reserve).not.toHaveBeenCalled()

    for (const modelResult of [
      { ...overview, processable: false, fruits: [] },
      { ...overview, processable: false, too_many: true, fruits: [] },
    ]) {
      const app = makeApp({ overviewResult: modelResult })
      const response = await app.app.fetch(apiRequest('/api/analyze-overview', { image }))
      expect([400, 422]).toContain(response.status)
      expect(app.quota.reserve).not.toHaveBeenCalled()
    }
  })

  it('maps provider failures safely without charging quota', async () => {
    const { app, quota } = makeApp({ overviewError: new OpenAIClientError('PROVIDER_FAILURE') })
    await expectError(await app.fetch(apiRequest('/api/analyze-overview', { image })), 502, 'PROVIDER_FAILURE')
    expect(quota.reserve).not.toHaveBeenCalled()
  })

  it('does not charge quota for candidate analysis and rejects ranking IDs not submitted', async () => {
    const { app, quota, ai } = makeApp({ candidateResult: { ...ranking, ranking: [{ ...ranking.ranking[0], candidate_id: 3 }] } })
    const overviewResponse = await app.fetch(apiRequest('/api/analyze-overview', { image }))
    const token = (await overviewResponse.json() as { data: { taskToken: string } }).data.taskToken
    const chargesBeforeCandidate = quota.reserve.mock.calls.length
    await expectError(await app.fetch(apiRequest('/api/analyze-candidates', { taskToken: token, candidates: [{ candidate_id: 2, stem: image, body: image, bottom: image }] })), 502, 'MODEL_OUTPUT_INVALID')
    expect(ai.analyzeCandidates).toHaveBeenCalledOnce()
    expect(quota.reserve).toHaveBeenCalledTimes(chargesBeforeCandidate)
  })

  it('uses shared box sanitization before shortlist selection and task signing', async () => {
    const sanitizedOverview = {
      ...overview,
      fruits: [
        { box_2d: [10, 10, 20, 20] as [number, number, number, number], visibility: 'high' as const, status: 'preferred' as const, evidence: ['面积过小'], risks: [], evidence_strength: 'high' as const },
        { box_2d: [100, 100, 300, 300] as [number, number, number, number], visibility: 'high' as const, status: 'normal' as const, evidence: ['左上'], risks: [], evidence_strength: 'high' as const },
        { box_2d: [100, 400, 300, 600] as [number, number, number, number], visibility: 'high' as const, status: 'preferred' as const, evidence: ['右上'], risks: [], evidence_strength: 'high' as const },
        { box_2d: [105, 405, 305, 605] as [number, number, number, number], visibility: 'high' as const, status: 'preferred' as const, evidence: ['重复框'], risks: [], evidence_strength: 'high' as const },
        { box_2d: [500, 100, 700, 300] as [number, number, number, number], visibility: 'medium' as const, status: 'risky' as const, evidence: ['下一排'], risks: [], evidence_strength: 'medium' as const },
      ],
    }
    const { app, quota } = makeApp({ overviewResult: sanitizedOverview })
    const response = await app.fetch(apiRequest('/api/analyze-overview', { image }))
    expect(response.status).toBe(200)
    const payload = await response.json() as {
      data: { fruits: Array<{ id: number; box_2d: number[] }>; shortlist_ids: number[]; taskToken: string }
    }
    expect(payload.data.fruits.map(({ id, box_2d }) => ({ id, box_2d }))).toEqual([
      { id: 1, box_2d: [100, 100, 300, 300] },
      { id: 2, box_2d: [100, 400, 300, 600] },
      { id: 3, box_2d: [500, 100, 700, 300] },
    ])
    expect(payload.data.shortlist_ids).toEqual([2, 1, 3])
    await expect(verifyTaskToken(payload.data.taskToken, 'test-secret', 0)).resolves.toMatchObject({ allowedIds: [2, 1, 3] })
    expect(quota.reserve).toHaveBeenCalledOnce()
  })

  it('sets hardened JSON headers on every API response and delegates non-api paths unchanged', async () => {
    const { app, assets } = makeApp()
    const apiResponse = await app.fetch(apiRequest('/api/missing'))
    await expectError(apiResponse, 404, 'NOT_FOUND')
    expect(apiResponse.headers.get('cache-control')).toBe('no-store')
    expect(apiResponse.headers.get('x-content-type-options')).toBe('nosniff')
    expect(apiResponse.headers.get('referrer-policy')).toBe('no-referrer')
    expect(apiResponse.headers.get('content-type')).toBe('application/json; charset=utf-8')

    const asset = await app.fetch(new Request(`${origin}/apix`))
    expect(await asset.text()).toBe('asset')
    expect(assets.fetch).toHaveBeenCalledOnce()
  })

  it('maps concurrent quota exhaustion to 429 after model analysis', async () => {
    const { app, ai } = makeApp()
    const state = makeApp()
    state.quota.reserve.mockRejectedValue(new QuotaError('QUOTA_EXHAUSTED'))
    await expectError(await state.app.fetch(apiRequest('/api/analyze-overview', { image })), 429, 'QUOTA_EXHAUSTED')
    expect(ai.analyzeOverview).not.toHaveBeenCalled()
    expect(state.ai.analyzeOverview).toHaveBeenCalledOnce()
  })

  it('rejects a repeated overview before a second AI call or quota reservation', async () => {
    const { app, ai, quota } = makeApp()
    expect((await app.fetch(apiRequest('/api/analyze-overview', { image }))).status).toBe(200)
    await expectError(await app.fetch(apiRequest('/api/analyze-overview', { image })), 409, 'INVALID_REQUEST')
    expect(ai.analyzeOverview).toHaveBeenCalledOnce()
    expect(quota.reserve).toHaveBeenCalledOnce()
  })

  it('rejects concurrent overview attempts with the same idempotency key before AI', async () => {
    let resolveOverview: ((value: typeof overview) => void) | undefined
    const pending = new Promise<typeof overview>((resolve) => { resolveOverview = resolve })
    const { app, ai, quota } = makeApp()
    ai.analyzeOverview.mockReturnValueOnce(pending)
    const first = app.fetch(apiRequest('/api/analyze-overview', { image }))
    await vi.waitFor(() => expect(ai.analyzeOverview).toHaveBeenCalledOnce())
    await expectError(await app.fetch(apiRequest('/api/analyze-overview', { image })), 409, 'INVALID_REQUEST')
    resolveOverview!(overview)
    expect((await first).status).toBe(200)
    expect(quota.reserve).toHaveBeenCalledOnce()
  })

  it('rejects a changed overview payload for an existing idempotency key', async () => {
    const { app, ai, quota } = makeApp()
    expect((await app.fetch(apiRequest('/api/analyze-overview', { image }))).status).toBe(200)
    const changedImage = 'data:image/jpeg;base64,/9j/4AABSkZJRg=='
    await expectError(await app.fetch(apiRequest('/api/analyze-overview', { image: changedImage })), 409, 'INVALID_REQUEST')
    expect(ai.analyzeOverview).toHaveBeenCalledOnce()
    expect(quota.reserve).toHaveBeenCalledOnce()
  })

  it('allows candidate provider failures to release the replay claim, then blocks a completed replay without quota', async () => {
    const { app, ai, quota } = makeApp({ candidateError: new OpenAIClientError('PROVIDER_FAILURE') })
    const overviewResponse = await app.fetch(apiRequest('/api/analyze-overview', { image }))
    const token = (await overviewResponse.json() as { data: { taskToken: string } }).data.taskToken
    const payload = { taskToken: token, candidates: [{ candidate_id: 2, stem: image, body: image, bottom: image }] }
    await expectError(await app.fetch(apiRequest('/api/analyze-candidates', payload)), 502, 'PROVIDER_FAILURE')
    ai.analyzeCandidates.mockResolvedValueOnce({ ...ranking, ranking: [{ ...ranking.ranking[0], candidate_id: 2 }] })
    expect((await app.fetch(apiRequest('/api/analyze-candidates', payload))).status).toBe(200)
    await expectError(await app.fetch(apiRequest('/api/analyze-candidates', payload)), 409, 'INVALID_TASK')
    await expectError(await app.fetch(apiRequest('/api/analyze-candidates', {
      ...payload,
      candidates: [{ ...payload.candidates[0], stem: 'data:image/jpeg;base64,/9j/4AABSkZJRg==' }],
    })), 409, 'INVALID_TASK')
    expect(ai.analyzeCandidates).toHaveBeenCalledTimes(2)
    expect(quota.reserve).toHaveBeenCalledOnce()
  })
})
