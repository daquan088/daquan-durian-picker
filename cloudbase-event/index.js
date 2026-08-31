const { readFile, stat } = require('node:fs/promises')
const { extname, join, normalize } = require('node:path')

const { apiMain } = require('./backend.cjs')
const PUBLIC_DIR = join(__dirname, 'public')
const API_ROUTES = new Set([
  'GET /api/quota',
  'POST /api/analyze-overview',
  'POST /api/analyze-candidates',
])
const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'], ['.jpeg', 'image/jpeg'], ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'], ['.svg', 'image/svg+xml'], ['.webp', 'image/webp'],
])
const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.svg'])

function response(statusCode, headers, body, isBase64Encoded = false) {
  return { statusCode, headers, body, isBase64Encoded }
}

function errorResponse(statusCode, message) {
  return response(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  }, JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message } }))
}

function requestPath(event) {
  const raw = typeof event.path === 'string' ? event.path : '/'
  return new URL(raw, 'https://cloudbase.local').pathname
}

function requestQuery(event) {
  const values = event.queryStringParameters || event.queryString || {}
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') query.append(key, value)
  }
  const text = query.toString()
  return text ? `?${text}` : ''
}

function clientIp(event) {
  const headers = event.headers || {}
  const direct = headers['x-scf-remote-addr'] || headers['X-Scf-Remote-Addr']
  if (typeof direct === 'string' && direct) return direct.split(':')[0]
  const forwarded = headers['x-forwarded-for'] || headers['X-Forwarded-For']
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim()
  return '127.0.0.1'
}

async function proxyApi(event, apiHandler) {
  const path = requestPath(event)
  const method = typeof event.httpMethod === 'string' ? event.httpMethod.toUpperCase() : 'GET'
  if (!API_ROUTES.has(`${method} ${path}`)) return errorResponse(404, '请求地址不存在。')

  return apiHandler(event)
}

async function serveStatic(event, publicDir) {
  let pathname = decodeURIComponent(requestPath(event))
  if (pathname === '/') pathname = '/index.html'
  const relative = normalize(pathname).replace(/^([/\\])+/, '')
  const candidate = join(publicDir, relative)
  if (!candidate.startsWith(publicDir)) return response(404, { 'content-type': 'text/plain; charset=utf-8' }, 'Not Found')
  try {
    if (!(await stat(candidate)).isFile()) throw new Error('not a file')
    const content = await readFile(candidate)
    const extension = extname(candidate).toLowerCase()
    const headers = {
      'cache-control': candidate.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
      'content-type': MIME_TYPES.get(extension) || 'application/octet-stream',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    }
    if (TEXT_EXTENSIONS.has(extension)) return response(200, headers, content.toString('utf8'))
    return response(200, headers, content.toString('base64'), true)
  } catch {
    return response(404, { 'content-type': 'text/plain; charset=utf-8' }, 'Not Found')
  }
}

function createHandler(options = {}) {
  const publicDir = options.publicDir || PUBLIC_DIR
  const apiHandler = options.apiHandler || apiMain
  return async (event) => requestPath(event).startsWith('/api/')
    ? proxyApi(event, apiHandler)
    : serveStatic(event, publicDir)
}

exports.createHandler = createHandler
exports.main = createHandler()
