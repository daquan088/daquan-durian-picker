const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const DEVICE_HASH_PATTERN = /^[a-f0-9]{64}$/
const MAX_TASK_ID_LENGTH = 128
const MAX_ALLOWED_IDS = 5

export interface TaskTokenPayload {
  taskId: string
  deviceHash: string
  allowedIds: number[]
  exp: number
}

export class TaskTokenError extends Error {
  readonly code = 'INVALID_TASK'

  constructor() {
    super('Task is invalid or expired.')
    this.name = 'TaskTokenError'
  }
}

function invalidTask(): never {
  throw new TaskTokenError()
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array {
  if (!BASE64URL_PATTERN.test(value)) {
    return invalidTask()
  }

  try {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)
    const binary = atob(padded)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return invalidTask()
  }
}

function validatePayload(value: unknown): TaskTokenPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalidTask()
  }

  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 4 || !['taskId', 'deviceHash', 'allowedIds', 'exp'].every((key) => keys.includes(key))) {
    return invalidTask()
  }

  const { taskId, deviceHash, allowedIds, exp } = record
  if (
    typeof taskId !== 'string' || taskId.trim().length === 0 || taskId !== taskId.trim() || taskId.length > MAX_TASK_ID_LENGTH ||
    typeof deviceHash !== 'string' || !DEVICE_HASH_PATTERN.test(deviceHash) ||
    !Array.isArray(allowedIds) || allowedIds.length === 0 || allowedIds.length > MAX_ALLOWED_IDS ||
    !allowedIds.every((id) => Number.isSafeInteger(id) && id > 0) || new Set(allowedIds).size !== allowedIds.length ||
    typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp < 0
  ) {
    return invalidTask()
  }

  return { taskId, deviceHash, allowedIds, exp }
}

async function hmac(message: Uint8Array, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, message))
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false
  }

  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index]
  }
  return difference === 0
}

export async function signTaskToken(payload: TaskTokenPayload, secret: string): Promise<string> {
  const validatedPayload = validatePayload(payload)
  if (secret.length === 0) {
    return invalidTask()
  }

  const encodedPayload = toBase64Url(encoder.encode(JSON.stringify(validatedPayload)))
  const signature = await hmac(encoder.encode(encodedPayload), secret)
  return `${encodedPayload}.${toBase64Url(signature)}`
}

export async function verifyTaskToken(token: string, secret: string, now = Math.floor(Date.now() / 1000)): Promise<TaskTokenPayload> {
  if (typeof token !== 'string' || secret.length === 0) {
    return invalidTask()
  }

  const parts = token.split('.')
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    return invalidTask()
  }

  const [encodedPayload, encodedSignature] = parts
  const providedSignature = fromBase64Url(encodedSignature)
  const expectedSignature = await hmac(encoder.encode(encodedPayload), secret)
  if (!constantTimeEqual(providedSignature, expectedSignature)) {
    return invalidTask()
  }

  let parsedPayload: unknown
  try {
    parsedPayload = JSON.parse(decoder.decode(fromBase64Url(encodedPayload)))
  } catch {
    return invalidTask()
  }

  const payload = validatePayload(parsedPayload)
  if (!Number.isSafeInteger(now) || payload.exp <= now) {
    return invalidTask()
  }

  return payload
}

export function assertCandidateAllowed(payload: TaskTokenPayload, candidateId: number): void {
  const validatedPayload = validatePayload(payload)
  if (!Number.isSafeInteger(candidateId) || candidateId <= 0 || !validatedPayload.allowedIds.includes(candidateId)) {
    invalidTask()
  }
}
