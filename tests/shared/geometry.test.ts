import { describe, expect, it } from 'vitest'
import { overviewModelOutputSchema, overviewSuccessPayloadSchema } from '../../shared/contracts'
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

const overviewModelOutput = {
  processable: true,
  too_many: false,
  image_quality: 'good',
  warnings: [],
  fruits: [{
    box_2d: [10, 10, 110, 110],
    status: 'preferred',
    visibility: 'high',
    evidence: ['果形饱满'],
    risks: [],
    evidence_strength: 'high',
  }],
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

  it('assigns stable rows for cyclic center proximity regardless of input order', () => {
    const boxes = [
      { box_2d: [50, 300, 150, 400], status: 'normal' as const },
      { box_2d: [150, 200, 250, 300], status: 'preferred' as const },
      { box_2d: [250, 100, 350, 200], status: 'risky' as const },
    ]
    const permutations = [
      boxes,
      [boxes[0], boxes[2], boxes[1]],
      [boxes[1], boxes[0], boxes[2]],
      [boxes[1], boxes[2], boxes[0]],
      [boxes[2], boxes[0], boxes[1]],
      [boxes[2], boxes[1], boxes[0]],
    ]
    const expected = [
      { id: 1, box_2d: [150, 200, 250, 300] },
      { id: 2, box_2d: [50, 300, 150, 400] },
      { id: 3, box_2d: [250, 100, 350, 200] },
    ]

    for (const permutation of permutations) {
      expect(sanitizeAndNumberBoxes(permutation).map(({ id, box_2d }) => ({ id, box_2d }))).toEqual(expected)
    }
  })

  it('uses coordinate and status tie-breakers when retaining overlapping boxes', () => {
    const preferred = { box_2d: [100, 100, 200, 200], status: 'preferred' as const }
    const normal = { box_2d: [100, 100, 200, 200], status: 'normal' as const }

    for (const permutation of [[normal, preferred], [preferred, normal]]) {
      expect(sanitizeAndNumberBoxes(permutation)).toEqual([{ ...preferred, id: 1 }])
    }
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

  it('rejects duplicate or skipped fruit IDs', () => {
    expect(overviewSuccessPayloadSchema.safeParse({
      ...overviewPayload,
      fruits: [
        overviewPayload.fruits[0],
        { ...overviewPayload.fruits[1], id: 1 },
        overviewPayload.fruits[2],
      ],
      shortlist_ids: [1, 2, 3],
    }).success).toBe(false)

    expect(overviewSuccessPayloadSchema.safeParse({
      ...overviewPayload,
      fruits: [
        overviewPayload.fruits[0],
        overviewPayload.fruits[1],
        { ...overviewPayload.fruits[2], id: 4 },
      ],
      shortlist_ids: [1, 2, 4],
    }).success).toBe(false)
  })

  it('requires every available eligible fruit when fewer than three are eligible', () => {
    const oneEligible = [
      overviewPayload.fruits[0],
      { ...overviewPayload.fruits[1], status: 'insufficient' },
      { ...overviewPayload.fruits[2], status: 'insufficient' },
    ]
    const twoEligible = [
      overviewPayload.fruits[0],
      overviewPayload.fruits[1],
      { ...overviewPayload.fruits[2], status: 'insufficient' },
    ]

    expect(overviewSuccessPayloadSchema.safeParse({
      ...overviewPayload,
      fruits: oneEligible,
      shortlist_ids: [1],
    }).success).toBe(true)
    expect(overviewSuccessPayloadSchema.safeParse({
      ...overviewPayload,
      fruits: oneEligible,
      shortlist_ids: [],
    }).success).toBe(false)
    expect(overviewSuccessPayloadSchema.safeParse({
      ...overviewPayload,
      fruits: twoEligible,
      shortlist_ids: [1, 2],
    }).success).toBe(true)
    expect(overviewSuccessPayloadSchema.safeParse({
      ...overviewPayload,
      fruits: twoEligible,
      shortlist_ids: [1],
    }).success).toBe(false)
  })

  it('rejects shortlist IDs for insufficient fruit or fruit without visible evidence', () => {
    const twoEligible = [
      overviewPayload.fruits[0],
      overviewPayload.fruits[1],
      { ...overviewPayload.fruits[2], status: 'insufficient' },
    ]
    const fruitWithoutEvidence = [
      overviewPayload.fruits[0],
      overviewPayload.fruits[1],
      { ...overviewPayload.fruits[2], evidence: [] },
    ]

    expect(overviewSuccessPayloadSchema.safeParse({
      ...overviewPayload,
      fruits: twoEligible,
      shortlist_ids: [1, 3],
    }).success).toBe(false)
    expect(overviewSuccessPayloadSchema.safeParse({
      ...overviewPayload,
      fruits: fruitWithoutEvidence,
      shortlist_ids: [1, 3],
    }).success).toBe(false)
  })
})

describe('overviewModelOutputSchema', () => {
  it('rejects populated fruits when the overview is not processable or has too many fruits', () => {
    expect(overviewModelOutputSchema.safeParse({
      ...overviewModelOutput,
      processable: false,
    }).success).toBe(false)
    expect(overviewModelOutputSchema.safeParse({
      ...overviewModelOutput,
      processable: false,
      too_many: true,
    }).success).toBe(false)
  })

  it('rejects a too-many state that is marked processable', () => {
    expect(overviewModelOutputSchema.safeParse({
      ...overviewModelOutput,
      too_many: true,
      fruits: [],
    }).success).toBe(false)
  })
})
