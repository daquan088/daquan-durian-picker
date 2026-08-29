import { describe, expect, it } from 'vitest'
import { overviewSuccessPayloadSchema } from '../../shared/contracts'

const overviewPayload = {
  variety: 'thai-monthong',
  image_quality: 'good',
  warnings: [],
  fruits: [
    {
      id: 1,
      box_2d: [10, 10, 110, 110],
      status: 'preferred',
      visibility: 'high',
      evidence: ['果形饱满'],
      risks: [],
      evidence_strength: 'high',
    },
    {
      id: 2,
      box_2d: [10, 130, 110, 230],
      status: 'preferred',
      visibility: 'high',
      evidence: ['果柄可见'],
      risks: [],
      evidence_strength: 'high',
    },
    {
      id: 3,
      box_2d: [10, 250, 110, 350],
      status: 'normal',
      visibility: 'medium',
      evidence: ['外壳清晰'],
      risks: [],
      evidence_strength: 'medium',
    },
  ],
  taskToken: 'task-token',
  remaining: 4,
} as const

describe('overviewSuccessPayloadSchema', () => {
  it('rejects duplicate shortlist IDs', () => {
    expect(overviewSuccessPayloadSchema.safeParse({
      ...overviewPayload,
      shortlist_ids: [1, 1, 1],
    }).success).toBe(false)
  })

  it('accepts a distinct shortlist of detected fruit IDs', () => {
    expect(overviewSuccessPayloadSchema.safeParse({
      ...overviewPayload,
      shortlist_ids: [1, 2, 3],
    }).success).toBe(true)
  })
})
