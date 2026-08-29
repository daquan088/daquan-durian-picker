// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createOpenAIResponsesClient,
  type OpenAIClientError,
} from '../../worker/openai/client'

const overviewFixture = {
  processable: true,
  too_many: false,
  image_quality: 'good',
  warnings: [],
  fruits: [{
    box_2d: [100, 100, 500, 500],
    status: 'preferred',
    visibility: 'high',
    evidence: ['果形较饱满'],
    risks: [],
    evidence_strength: 'medium',
  }],
}

const candidateFixture = {
  ranking: [{
    candidate_id: 1,
    rank: 1,
    appearance_score: 78,
    evidence: ['果柄完整可见'],
    risks: ['底部视角略不清晰'],
    evidence_strength: 'medium',
  }],
  summary: '仅按可见外观，候选 1 的可见证据相对更充分。',
  limitations: ['无法凭照片判断气味、甜度或内部情况。'],
}

const env = { OPENAI_API_KEY: 'test-secret-key', MODEL_ID: 'gpt-5.6-terra' }
const image = 'data:image/jpeg;base64,photo-one'

function assistantResponse(value: unknown) {
  return new Response(JSON.stringify({
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: JSON.stringify(value) }],
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function makeClient(responses: Array<Response | Error>, options: { signal?: AbortSignal } = {}) {
  const fetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () => {
    const next = responses.shift()
    if (next instanceof Error) throw next
    if (!next) throw new Error('Unexpected fetch call')
    return next
  })
  return { client: createOpenAIResponsesClient({ env, fetch, signal: options.signal }), fetch }
}

function expectCode(error: unknown, code: string) {
  expect(error).toBeInstanceOf(Error)
  expect((error as OpenAIClientError).code).toBe(code)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('OpenAI Responses client', () => {
  it('returns validated overview output and sends the required strict Responses request body', async () => {
    const { client, fetch } = makeClient([assistantResponse(overviewFixture)])

    await expect(client.analyzeOverview({ images: [image] })).resolves.toEqual(overviewFixture)

    expect(fetch).toHaveBeenCalledOnce()
    const [url, request] = fetch.mock.calls[0]!
    expect(url).toBe('https://api.openai.com/v1/responses')
    expect(request?.headers).toMatchObject({
      authorization: 'Bearer test-secret-key',
      'content-type': 'application/json',
    })
    const body = JSON.parse(String(request?.body))
    expect(body).toMatchObject({
      model: 'gpt-5.6-terra',
      store: false,
      reasoning: { effort: 'low' },
      text: {
        verbosity: 'low',
        format: { type: 'json_schema', name: 'durian_overview_output', strict: true },
      },
    })
    expect(body.input).toHaveLength(1)
    expect(body.input[0].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'input_text' }),
      { type: 'input_image', image_url: image, detail: 'original' },
    ]))
    expect(body.text.format.schema).toBeTypeOf('object')
  })

  it('returns validated candidate output and passes all supplied images unchanged', async () => {
    const images = { stem: 'stem-image', body: 'body-image', bottom: 'bottom-image' }
    const { client, fetch } = makeClient([assistantResponse(candidateFixture)])

    await expect(client.analyzeCandidates({ candidates: [{ candidate_id: 1, ...images }] })).resolves.toEqual(candidateFixture)

    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))
    expect(body.text).toMatchObject({
      verbosity: 'low',
      format: { type: 'json_schema', name: 'durian_candidate_ranking_output', strict: true },
    })
    expect(body.input[0].content.filter((item: { type: string }) => item.type === 'input_image'))
      .toEqual([
        { type: 'input_image', image_url: images.stem, detail: 'original' },
        { type: 'input_image', image_url: images.body, detail: 'original' },
        { type: 'input_image', image_url: images.bottom, detail: 'original' },
      ])
  })

  it.each([
    [401, 'PROVIDER_AUTH'],
    [403, 'PROVIDER_AUTH'],
    [429, 'PROVIDER_RATE_LIMIT'],
    [500, 'PROVIDER_FAILURE'],
  ])('maps HTTP %i to %s without returning an upstream body', async (status, code) => {
    const { client, fetch } = makeClient([new Response('provider secret body', { status })])

    await expect(client.analyzeOverview({ images: [image] })).rejects.toSatisfy((error: unknown) => {
      expectCode(error, code)
      expect((error as Error).message).not.toContain('provider secret body')
      expect((error as Error).message).not.toContain(env.OPENAI_API_KEY)
      return true
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('maps network failures to a safe provider failure', async () => {
    const { client } = makeClient([new Error('network contains provider details')])

    await expect(client.analyzeOverview({ images: [image] })).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'PROVIDER_FAILURE')
      expect((error as Error).message).not.toContain('provider details')
      return true
    })
  })

  it('aborts a request after 45 seconds and maps AbortError to PROVIDER_TIMEOUT', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const client = createOpenAIResponsesClient({ env, fetch })
    const promise = client.analyzeOverview({ images: [image] })
    const assertion = expect(promise).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'PROVIDER_TIMEOUT')
      return true
    })

    await vi.advanceTimersByTimeAsync(45_000)
    await assertion
  })

  it('cascades an optional caller abort signal', async () => {
    const controller = new AbortController()
    const fetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const client = createOpenAIResponsesClient({ env, fetch, signal: controller.signal })
    const promise = client.analyzeOverview({ images: [image] })

    controller.abort()
    await expect(promise).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'PROVIDER_TIMEOUT')
      return true
    })
  })

  it('retries once after malformed JSON and returns a later valid response', async () => {
    const malformed = new Response(JSON.stringify({
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{not-json' }] }],
    }))
    const { client, fetch } = makeClient([malformed, assistantResponse(overviewFixture)])

    await expect(client.analyzeOverview({ images: [image] })).resolves.toEqual(overviewFixture)
    expect(fetch).toHaveBeenCalledTimes(2)
    const retryBody = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))
    expect(retryBody.input[0].content[0].text).toContain('JSON')
  })

  it('rejects schema-invalid model output after exactly one retry', async () => {
    const invalid = { ...overviewFixture, fruits: [{ ...overviewFixture.fruits[0], status: 'invented' }] }
    const { client, fetch } = makeClient([assistantResponse(invalid), assistantResponse(invalid)])

    await expect(client.analyzeOverview({ images: [image] })).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'MODEL_OUTPUT_INVALID')
      return true
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    [{ output: [] }],
    { output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] }] },
    { output: [{ type: 'message', role: 'assistant', content: [
      { type: 'output_text', text: JSON.stringify(overviewFixture) },
      { type: 'output_text', text: JSON.stringify(overviewFixture) },
    ] }] },
  ])('rejects missing, refusal, or ambiguous assistant output safely', async (body) => {
    const { client } = makeClient([
      new Response(JSON.stringify(body)),
      new Response(JSON.stringify(body)),
    ])

    await expect(client.analyzeOverview({ images: [image] })).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'MODEL_OUTPUT_INVALID')
      expect((error as Error).message).not.toContain('refusal')
      return true
    })
  })
})
