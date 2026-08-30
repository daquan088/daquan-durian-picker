import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CandidateFollowUpPayload } from '../../shared/contracts'
import {
  API_MAX_REQUEST_BODY_BYTES,
  AppError,
  createIdempotencyKey,
  requestCandidates,
  requestQuota,
} from '../../src/lib/api'
import { CANDIDATE_IMAGE_MAX_BYTES } from '../../src/lib/imageProcessing'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('browser API client', () => {
  it('sends the persistent device ID to the same-origin quota endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { remaining: 4 } }), {
      headers: { 'content-type': 'application/json' },
    })))

    await expect(requestQuota()).resolves.toEqual({ remaining: 4 })
    expect(fetch).toHaveBeenCalledWith('/api/quota', expect.objectContaining({
      headers: expect.objectContaining({ 'x-device-id': expect.any(String) }),
    }))
  })

  it('turns API errors into a typed error without exposing HTML', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<h1>boom</h1>', { status: 500, headers: { 'content-type': 'text/html' } })))

    const error = await requestQuota().catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(AppError)
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR', message: '服务暂时无法连接，请稍后重试。' })
  })

  it('creates UUID v4 idempotency keys for POST callers to retain across retries', () => {
    expect(createIdempotencyKey()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  it('sends a compliant three-candidate nine-image request within the shared 25 MiB boundary', async () => {
    const encodedImage = `data:image/jpeg;base64,${'A'.repeat(Math.ceil(CANDIDATE_IMAGE_MAX_BYTES / 3) * 4)}`
    const payload = candidatePayload(encodedImage)
    const response = {
      ok: true,
      data: {
        variety: 'thai-monthong',
        result: {
          ranking: [{ candidate_id: 1, rank: 1, appearance_score: 88, evidence: ['果形完整'], risks: [], evidence_strength: 'high' }],
          summary: '一号外观证据较充分',
          limitations: ['仅判断可见外观'],
        },
      },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response), {
      headers: { 'content-type': 'application/json' },
    })))

    await expect(requestCandidates(payload, { idempotencyKey: '123e4567-e89b-42d3-a456-426614174000' })).resolves.toMatchObject({ variety: 'thai-monthong' })

    const sentBody = String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)
    expect(new TextEncoder().encode(sentBody).byteLength).toBeLessThanOrEqual(API_MAX_REQUEST_BODY_BYTES)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects an over-25 MiB candidate JSON body locally without calling fetch', async () => {
    const oversizedImage = `data:image/jpeg;base64,${'A'.repeat(3 * 1024 * 1024)}`
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestCandidates(candidatePayload(oversizedImage))).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

function candidatePayload(image: string): CandidateFollowUpPayload {
  return {
    taskToken: 'task-token',
    candidates: [1, 2, 3].map((candidateId) => ({
      candidate_id: candidateId,
      stem: image,
      body: image,
      bottom: image,
    })),
  }
}
