// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  assertCandidateAllowed,
  signTaskToken,
  verifyTaskToken,
  type TaskTokenPayload,
} from '../../worker/security/taskToken'

const secret = 'test-task-token-secret'
const payload: TaskTokenPayload = {
  taskId: 'task_123',
  deviceHash: 'a'.repeat(64),
  allowedIds: [1, 3, 5],
  exp: 1_800_000_000,
}

describe('taskToken', () => {
  it('signs and verifies a task payload', async () => {
    const token = await signTaskToken(payload, secret)

    await expect(verifyTaskToken(token, secret, 1_799_999_999)).resolves.toEqual(payload)
  })

  it('rejects a modified token without exposing token internals', async () => {
    const token = await signTaskToken(payload, secret)
    const modified = `${token.startsWith('A') ? 'B' : 'A'}${token.slice(1)}`

    await expect(verifyTaskToken(modified, secret, 1_799_999_999)).rejects.toMatchObject({ code: 'INVALID_TASK' })
  })

  it('rejects expired task tokens', async () => {
    const token = await signTaskToken(payload, secret)

    await expect(verifyTaskToken(token, secret, payload.exp)).rejects.toMatchObject({ code: 'INVALID_TASK' })
  })

  it('rejects candidate IDs that were not signed into the task', async () => {
    const token = await signTaskToken(payload, secret)
    const verified = await verifyTaskToken(token, secret, 1_799_999_999)

    expect(() => assertCandidateAllowed(verified, 3)).not.toThrow()
    expect(() => assertCandidateAllowed(verified, 2)).toThrow(expect.objectContaining({ code: 'INVALID_TASK' }))
  })

  it('rejects malformed payloads and duplicate candidate IDs', async () => {
    await expect(signTaskToken({ ...payload, allowedIds: [1, 1] }, secret)).rejects.toMatchObject({ code: 'INVALID_TASK' })
    await expect(verifyTaskToken('not-a-token', secret, 1_799_999_999)).rejects.toMatchObject({ code: 'INVALID_TASK' })
  })
})
