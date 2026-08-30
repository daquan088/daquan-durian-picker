import { z } from 'zod'
import {
  finalRankingSchema,
  overviewModelOutputSchema,
  type FinalRanking,
  type OverviewModelOutput,
} from '../../shared/contracts'
import { candidatePromptForIds, overviewPrompt } from './prompts'

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
const REQUEST_TIMEOUT_MS = 45_000

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>
type OutputSchema<T> = z.ZodType<T>

export type OpenAIClientErrorCode =
  | 'PROVIDER_AUTH'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_FAILURE'
  | 'MODEL_OUTPUT_INVALID'

export class OpenAIClientError extends Error {
  readonly code: OpenAIClientErrorCode

  constructor(code: OpenAIClientErrorCode) {
    super(safeMessageFor(code))
    this.name = 'OpenAIClientError'
    this.code = code
  }
}

class ModelOutputError extends Error {}

export interface OpenAIResponsesClientEnvironment {
  OPENAI_API_KEY: string
  MODEL_ID: string
  OPENAI_BASE_URL?: string
}

export interface OpenAIImageInput {
  images: readonly string[]
  signal?: AbortSignal
}

export interface CandidateImageInput {
  candidate_id: number
  stem: string
  body: string
  bottom: string
}

export interface CandidateAnalysisInput {
  candidates: readonly CandidateImageInput[]
  signal?: AbortSignal
}

export interface OpenAIResponsesClientOptions {
  env: OpenAIResponsesClientEnvironment
  fetch?: FetchLike
  signal?: AbortSignal
}

export interface OpenAIResponsesClient {
  analyzeOverview(input: OpenAIImageInput): Promise<OverviewModelOutput>
  analyzeCandidates(input: CandidateAnalysisInput): Promise<FinalRanking>
}

export function createOpenAIResponsesClient(options: OpenAIResponsesClientOptions): OpenAIResponsesClient {
  const fetcher = options.fetch ?? fetch

  return {
    analyzeOverview: ({ images, signal }) => requestStructuredOutput({
      env: options.env,
      fetcher,
      prompt: overviewPrompt,
      images,
      schema: overviewModelOutputSchema,
      schemaName: 'durian_overview_output',
      signals: [options.signal, signal],
    }),
    analyzeCandidates: ({ candidates, signal }) => requestStructuredOutput({
      env: options.env,
      fetcher,
      prompt: candidatePromptForIds(candidates.map(({ candidate_id }) => candidate_id)),
      images: candidates.flatMap(({ stem, body, bottom }) => [stem, body, bottom]),
      schema: finalRankingSchema,
      schemaName: 'durian_candidate_ranking_output',
      signals: [options.signal, signal],
    }),
  }
}

interface StructuredRequest<T> {
  env: OpenAIResponsesClientEnvironment
  fetcher: FetchLike
  prompt: string
  images: readonly string[]
  schema: OutputSchema<T>
  schemaName: string
  signals: Array<AbortSignal | undefined>
}

async function requestStructuredOutput<T>(request: StructuredRequest<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let outputText: string
    try {
      outputText = await requestResponse(request, attempt === 1)
    } catch (error) {
      if (error instanceof OpenAIClientError) throw error
      if (error instanceof ModelOutputError) continue
      throw new OpenAIClientError('PROVIDER_FAILURE')
    }

    try {
      const parsed = JSON.parse(outputText) as unknown
      const result = request.schema.safeParse(parsed)
      if (result.success) return result.data
    } catch {
      // Malformed JSON is eligible for one retry.
    }
  }

  throw new OpenAIClientError('MODEL_OUTPUT_INVALID')
}

async function requestResponse<T>(request: StructuredRequest<T>, isRetry: boolean): Promise<string> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const activeSignals = request.signals.filter((signal): signal is AbortSignal => Boolean(signal))
  const timer = setTimeout(abort, REQUEST_TIMEOUT_MS)

  for (const signal of activeSignals) {
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  }

  try {
    const response = await request.fetcher(endpointFor(request.env), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${request.env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: request.env.MODEL_ID,
        store: false,
        reasoning: { effort: 'low' },
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: isRetry ? retryPrompt(request.prompt) : request.prompt },
            ...request.images.map((image_url) => ({ type: 'input_image', image_url, detail: 'original' })),
          ],
        }],
        text: {
          verbosity: 'low',
          format: {
            type: 'json_schema',
            name: request.schemaName,
            strict: true,
            schema: z.toJSONSchema(request.schema),
          },
        },
      }),
    })

    if (!response.ok) throw new OpenAIClientError(codeForStatus(response.status))
    try {
      return extractAssistantOutputText(await response.json())
    } catch {
      throw new ModelOutputError()
    }
  } catch (error) {
    if (error instanceof OpenAIClientError) throw error
    if (controller.signal.aborted || isAbortError(error)) {
      throw new OpenAIClientError('PROVIDER_TIMEOUT')
    }
    throw error
  } finally {
    clearTimeout(timer)
    for (const signal of activeSignals) signal.removeEventListener('abort', abort)
  }
}

function endpointFor(env: OpenAIResponsesClientEnvironment): string {
  const baseUrl = (env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '')
  return `${baseUrl}/responses`
}

function extractAssistantOutputText(response: unknown): string {
  if (!isRecord(response) || !Array.isArray(response.output)) throw new ModelOutputError()

  const assistantMessages = response.output.filter((item) =>
    isRecord(item) && item.type === 'message' && item.role === 'assistant',
  )
  if (assistantMessages.length !== 1) throw new ModelOutputError()

  const content = assistantMessages[0].content
  if (!Array.isArray(content) || content.length !== 1) throw new ModelOutputError()
  const [item] = content
  if (!isRecord(item) || item.type !== 'output_text' || typeof item.text !== 'string') {
    throw new ModelOutputError()
  }
  return item.text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function retryPrompt(prompt: string): string {
  return `${prompt}\n\n上一次输出无法被安全解析。只返回符合所给 JSON schema 的有效 JSON；不要包含 Markdown、解释或额外文本。`
}

function codeForStatus(status: number): OpenAIClientErrorCode {
  if (status === 401 || status === 403) return 'PROVIDER_AUTH'
  if (status === 429) return 'PROVIDER_RATE_LIMIT'
  return 'PROVIDER_FAILURE'
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError'
}

function safeMessageFor(code: OpenAIClientErrorCode): string {
  switch (code) {
    case 'PROVIDER_AUTH': return 'The AI provider could not authenticate the request.'
    case 'PROVIDER_RATE_LIMIT': return 'The AI provider is temporarily rate limited.'
    case 'PROVIDER_TIMEOUT': return 'The AI provider request timed out.'
    case 'PROVIDER_FAILURE': return 'The AI provider request failed.'
    case 'MODEL_OUTPUT_INVALID': return 'The AI provider returned an invalid structured result.'
  }
}
