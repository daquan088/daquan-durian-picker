import { describe, expect, it } from 'vitest'
import { overviewSuccessPayloadSchema } from '../../shared/contracts'
import { sanitizeAndNumberBoxes } from '../../shared/geometry'

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

describe('sanitizeAndNumberBoxes', () => {
  it('drops invalid and near-duplicate boxes, then numbers rows top-to-bottom and left-to-right', () => {
    const result = sanitizeAndNumberBoxes([
      { box_2d: [510, 80, 900, 430], status: 'normal' },
      { box_2d: [80, 520, 420, 900], status: 'preferred' },
      { box_2d: [70, 40, 430, 430], status: 'preferred' },
      { box_2d: [75, 45, 425, 425], status: 'normal' },
      { box_2d: [-1, 0, 10, 10], status: 'risky' },
    ])

    expect(result.map(({ id, box_2d }) => ({ id, box_2d }))).toEqual([
      { id: 1, box_2d: [70, 40, 430, 430] },
      { id: 2, box_2d: [80, 520, 420, 900] },
      { id: 3, box_2d: [510, 80, 900, 430] },
    ])
  })

  it('returns at most twenty boxes for twenty-five valid inputs', () => {
    const boxes = Array.from({ length: 25 }, (_, index) => ({
      box_2d: [index * 30, 0, index * 30 + 25, 100],
      status: 'normal' as const,
    }))

    expect(sanitizeAndNumberBoxes(boxes)).toHaveLength(20)
  })
})

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
