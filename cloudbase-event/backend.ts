import { createApp } from '../worker/http'
import type { Env } from '../worker/env.d'
import { createPostgresQuotaClient } from './quota'

type CloudBaseEvent = {
  path?: string
  httpMethod?: string
  headers?: Record<string, string | undefined>
  queryStringParameters?: Record<string, string | undefined>
  body?: string
  isBase64Encoded?: boolean
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function clientIp(headers: Record<string, string | undefined>): string {
  const direct = headers['x-scf-remote-addr'] || headers['X-Scf-Remote-Addr']
  if (direct?.startsWith('[')) {
    const closingBracket = direct.indexOf(']')
    if (closingBracket > 1) return direct.slice(1, closingBracket)
  }
  if (direct) {
    const colonCount = (direct.match(/:/g) || []).length
    return colonCount === 1 ? direct.slice(0, direct.lastIndexOf(':')) : direct
  }
  const forwarded = headers['x-forwarded-for'] || headers['X-Forwarded-For']
  return forwarded?.split(',')[0]?.trim() || '127.0.0.1'
}

function requestFromEvent(event: CloudBaseEvent): Request {
  const path = typeof event.path === 'string' ? event.path : '/'
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(event.queryStringParameters || {})) {
    if (typeof value === 'string') query.append(key, value)
  }
  const url = `https://cloudbase.local${path}${query.size ? `?${query}` : ''}`
  const headers = new Headers()
  for (const [name, value] of Object.entries(event.headers || {})) {
    if (typeof value === 'string') headers.set(name, value)
  }
  headers.set('origin', 'https://cloudbase.local')
  headers.set('cf-connecting-ip', clientIp(event.headers || {}))
  const method = (event.httpMethod || 'GET').toUpperCase()
  const body = method === 'POST'
    ? (event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : event.body || '')
    : undefined
  return new Request(url, { method, headers, body })
}

function eventResponse(response: Response, body: string) {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => { headers[name] = value })
  return { statusCode: response.status, headers, body, isBase64Encoded: false }
}

let app: ReturnType<typeof createApp> | undefined

function getApp() {
  if (app) return app
  const quotaSalt = required('QUOTA_SALT')
  const env = {
    OPENAI_API_KEY: required('OPENAI_API_KEY'),
    OPENAI_BASE_URL: required('OPENAI_BASE_URL'),
    MODEL_ID: required('MODEL_ID'),
    QUOTA_SALT: quotaSalt,
    TASK_TOKEN_SECRET: required('TASK_TOKEN_SECRET'),
    ASSETS: { fetch: () => Promise.resolve(new Response('Not Found', { status: 404 })) },
  } as unknown as Env
  app = createApp({ env, quota: createPostgresQuotaClient(quotaSalt) })
  return app
}

export async function apiMain(event: CloudBaseEvent) {
  try {
    const response = await getApp().fetch(requestFromEvent(event))
    return eventResponse(response, await response.text())
  } catch {
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      body: JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: '服务暂时无法处理请求。' } }),
      isBase64Encoded: false,
    }
  }
}
