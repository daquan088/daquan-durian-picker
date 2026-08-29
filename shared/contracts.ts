import { z } from 'zod'

const visibleTextSchema = z.string().trim().min(1).max(500)
const identifierSchema = z.number().int().positive()

export const durianVarietySchema = z.literal('thai-monthong')
export const fruitStatusSchema = z.enum(['preferred', 'normal', 'risky', 'insufficient'])
export const confidenceSchema = z.enum(['high', 'medium', 'low'])
export const photoQualitySchema = z.enum(['good', 'usable', 'poor'])

export const normalizedBoundingBoxSchema = z.tuple([
  z.number().finite().min(0).max(1000),
  z.number().finite().min(0).max(1000),
  z.number().finite().min(0).max(1000),
  z.number().finite().min(0).max(1000),
]).refine(([y1, x1, y2, x2]) => y2 > y1 && x2 > x1, {
  message: 'Bounding boxes must have positive width and height.',
})

export const rawFruitSchema = z.object({
  box_2d: normalizedBoundingBoxSchema,
  status: fruitStatusSchema,
}).strict()

export const overviewFruitSchema = rawFruitSchema.extend({
  visibility: confidenceSchema,
  evidence: z.array(visibleTextSchema).max(12),
  risks: z.array(visibleTextSchema).max(12),
  evidence_strength: confidenceSchema,
}).strict()

export const overviewModelOutputSchema = z.object({
  processable: z.boolean(),
  too_many: z.boolean(),
  image_quality: photoQualitySchema,
  warnings: z.array(visibleTextSchema).max(12),
  fruits: z.array(overviewFruitSchema).max(20),
}).strict().superRefine(({ processable, too_many, fruits }, context) => {
  if ((!processable || too_many) && fruits.length > 0) {
    context.addIssue({
      code: 'custom',
      path: ['fruits'],
      message: 'Unprocessable or too-many overviews must not contain fruits.',
    })
  }

  if (too_many && processable) {
    context.addIssue({
      code: 'custom',
      path: ['processable'],
      message: 'A too-many overview must not be processable.',
    })
  }
})

export const numberedFruitSchema = rawFruitSchema.extend({
  id: identifierSchema,
}).strict()

export const numberedFruitAssessmentSchema = overviewFruitSchema.extend({
  id: identifierSchema,
}).strict()

const imageValueSchema = z.string().trim().min(1).max(8_000_000)

export const imagePayloadDescriptorSchema = z.object({
  kind: z.enum(['data_url', 'reference']),
  value: imageValueSchema,
}).strict()

export const imageReferenceOrPayloadSchema = z.union([
  imageValueSchema,
  imagePayloadDescriptorSchema,
])

export const candidateFollowUpSchema = z.object({
  candidate_id: identifierSchema,
  stem: imageReferenceOrPayloadSchema,
  body: imageReferenceOrPayloadSchema,
  bottom: imageReferenceOrPayloadSchema,
}).strict()

export const candidateFollowUpPayloadSchema = z.object({
  taskToken: z.string().trim().min(1).max(4096),
  candidates: z.array(candidateFollowUpSchema).min(1).max(3)
    .refine((candidates) => new Set(candidates.map(({ candidate_id }) => candidate_id)).size === candidates.length, {
      message: 'Candidate IDs must be unique.',
    }),
}).strict()

export const finalRankingItemSchema = z.object({
  candidate_id: identifierSchema,
  rank: z.number().int().min(1).max(3),
  appearance_score: z.number().finite().min(0).max(100),
  evidence: z.array(visibleTextSchema).min(1).max(12),
  risks: z.array(visibleTextSchema).max(12),
  evidence_strength: confidenceSchema,
}).strict()

export const finalRankingSchema = z.object({
  ranking: z.array(finalRankingItemSchema).min(1).max(3)
    .superRefine((ranking, context) => {
      const candidateIds = new Set(ranking.map(({ candidate_id }) => candidate_id))
      const ranks = ranking.map(({ rank }) => rank).sort((left, right) => left - right)

      if (candidateIds.size !== ranking.length) {
        context.addIssue({ code: 'custom', message: 'Candidate IDs must be unique.' })
      }

      if (!ranks.every((rank, index) => rank === index + 1)) {
        context.addIssue({ code: 'custom', message: 'Ranks must be continuous and start at one.' })
      }
    }),
  summary: visibleTextSchema,
  limitations: z.array(visibleTextSchema).min(1).max(12),
}).strict()

export const overviewSuccessPayloadSchema = z.object({
  variety: durianVarietySchema,
  image_quality: photoQualitySchema,
  warnings: z.array(visibleTextSchema).max(12),
  fruits: z.array(numberedFruitAssessmentSchema).max(20),
  shortlist_ids: z.array(identifierSchema).max(5),
  taskToken: z.string().trim().min(1).max(4096),
  remaining: z.number().int().min(0).max(5),
}).strict().superRefine(({ fruits, shortlist_ids }, context) => {
  const fruitIds = fruits.map(({ id }) => id).sort((left, right) => left - right)
  if (!fruitIds.every((id, index) => id === index + 1)) {
    context.addIssue({
      code: 'custom',
      path: ['fruits'],
      message: 'Fruit IDs must be unique and continuous from one.',
    })
  }

  const eligibleIds = new Set(fruits
    .filter(({ status, evidence }) => status !== 'insufficient' && evidence.length > 0)
    .map(({ id }) => id))
  const minimumShortlistCount = Math.min(3, eligibleIds.size)
  if (shortlist_ids.length < minimumShortlistCount) {
    context.addIssue({
      code: 'custom',
      path: ['shortlist_ids'],
      message: 'The shortlist must include all eligible fruits when fewer than three are eligible.',
    })
  }

  if (new Set(shortlist_ids).size !== shortlist_ids.length) {
    context.addIssue({
      code: 'custom',
      path: ['shortlist_ids'],
      message: 'Shortlisted IDs must be unique.',
    })
  }

  if (shortlist_ids.some((id) => !eligibleIds.has(id))) {
    context.addIssue({
      code: 'custom',
      path: ['shortlist_ids'],
      message: 'Shortlisted IDs must refer to eligible fruits with visible evidence.',
    })
  }
})

export const finalRankingSuccessPayloadSchema = z.object({
  variety: durianVarietySchema,
  result: finalRankingSchema,
}).strict()

export const quotaSuccessPayloadSchema = z.object({
  remaining: z.number().int().min(0).max(5),
}).strict()

export const apiSuccessEnvelopeSchema = <TSchema extends z.ZodType>(dataSchema: TSchema) =>
  z.object({ ok: z.literal(true), data: dataSchema }).strict()

export const overviewSuccessEnvelopeSchema = apiSuccessEnvelopeSchema(overviewSuccessPayloadSchema)
export const finalRankingSuccessEnvelopeSchema = apiSuccessEnvelopeSchema(finalRankingSuccessPayloadSchema)
export const quotaSuccessEnvelopeSchema = apiSuccessEnvelopeSchema(quotaSuccessPayloadSchema)

export const apiErrorCodeSchema = z.enum([
  'INVALID_REQUEST',
  'INVALID_IMAGE',
  'IMAGE_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'INVALID_TASK',
  'QUOTA_EXHAUSTED',
  'IP_RATE_LIMIT',
  'NOT_FOUND',
  'PROVIDER_AUTH',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_TIMEOUT',
  'PROVIDER_FAILURE',
  'MODEL_OUTPUT_INVALID',
  'INTERNAL_ERROR',
])

export const apiErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: apiErrorCodeSchema,
    message: visibleTextSchema,
  }).strict(),
}).strict()

export type DurianVariety = z.infer<typeof durianVarietySchema>
export type FruitStatus = z.infer<typeof fruitStatusSchema>
export type Confidence = z.infer<typeof confidenceSchema>
export type PhotoQuality = z.infer<typeof photoQualitySchema>
export type NormalizedBoundingBox = z.infer<typeof normalizedBoundingBoxSchema>
export type RawFruit = z.infer<typeof rawFruitSchema>
export type OverviewFruit = z.infer<typeof overviewFruitSchema>
export type OverviewModelOutput = z.infer<typeof overviewModelOutputSchema>
export type NumberedFruit = z.infer<typeof numberedFruitSchema>
export type NumberedFruitAssessment = z.infer<typeof numberedFruitAssessmentSchema>
export type ImagePayloadDescriptor = z.infer<typeof imagePayloadDescriptorSchema>
export type ImageReferenceOrPayload = z.infer<typeof imageReferenceOrPayloadSchema>
export type CandidateFollowUp = z.infer<typeof candidateFollowUpSchema>
export type CandidateFollowUpPayload = z.infer<typeof candidateFollowUpPayloadSchema>
export type FinalRankingItem = z.infer<typeof finalRankingItemSchema>
export type FinalRanking = z.infer<typeof finalRankingSchema>
export type OverviewSuccessPayload = z.infer<typeof overviewSuccessPayloadSchema>
export type FinalRankingSuccessPayload = z.infer<typeof finalRankingSuccessPayloadSchema>
export type QuotaSuccessPayload = z.infer<typeof quotaSuccessPayloadSchema>
export type OverviewSuccessEnvelope = z.infer<typeof overviewSuccessEnvelopeSchema>
export type FinalRankingSuccessEnvelope = z.infer<typeof finalRankingSuccessEnvelopeSchema>
export type QuotaSuccessEnvelope = z.infer<typeof quotaSuccessEnvelopeSchema>
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>
export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>
