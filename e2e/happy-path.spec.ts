import { expect, test, type Page } from '@playwright/test'
import { candidateFollowUpPayloadSchema, finalRankingSuccessPayloadSchema, overviewSuccessPayloadSchema, quotaSuccessPayloadSchema } from '../shared/contracts'

const hero = 'public/assets/durian-home-hero.png'
const browserErrors = new WeakMap<Page, string[]>()

test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  browserErrors.set(page, errors)
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) })
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined })
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value: string) => { (window as typeof window & { copiedWechat?: string }).copiedWechat = value } },
    })
  })
})

test.afterEach(({ page }) => {
  expect(browserErrors.get(page) ?? []).toEqual([])
})

function ok(data: unknown) { return { ok: true, data } }

test('complete mobile selection keeps one task token, uses follow-up photos, and exports a long-press PNG', async ({ page }) => {
  let quotaRequests = 0
  let overviewBody: unknown
  let followupBody: unknown
  const overview = {
    variety: 'thai-monthong' as const, image_quality: 'good' as const, warnings: [],
    fruits: [
      { id: 1, box_2d: [80, 80, 420, 320] as [number, number, number, number], status: 'preferred' as const, visibility: 'high' as const, evidence: ['果形匀称'], risks: [], evidence_strength: 'high' as const },
      { id: 2, box_2d: [160, 360, 560, 650] as [number, number, number, number], status: 'normal' as const, visibility: 'high' as const, evidence: ['果刺可见'], risks: [], evidence_strength: 'medium' as const },
      { id: 3, box_2d: [260, 680, 720, 960] as [number, number, number, number], status: 'risky' as const, visibility: 'medium' as const, evidence: ['果形可见'], risks: ['局部遮挡'], evidence_strength: 'medium' as const },
    ], shortlist_ids: [1, 2, 3], taskToken: 'task-token-for-one-complete-job', remaining: 4,
  }
  const final = { variety: 'thai-monthong' as const, result: { ranking: [
    { candidate_id: 1, rank: 1, appearance_score: 92, evidence: ['果形匀称'], risks: [], evidence_strength: 'high' as const },
    { candidate_id: 2, rank: 2, appearance_score: 80, evidence: ['果刺可见'], risks: [], evidence_strength: 'medium' as const },
    { candidate_id: 3, rank: 3, appearance_score: 70, evidence: ['外观可见'], risks: ['局部遮挡'], evidence_strength: 'medium' as const },
  ], summary: '优先选择 1 号。', limitations: ['仅根据可见外观判断'] } }
  expect(overviewSuccessPayloadSchema.safeParse(overview).success).toBe(true)
  expect(finalRankingSuccessPayloadSchema.safeParse(final).success).toBe(true)
  expect(quotaSuccessPayloadSchema.safeParse({ remaining: 5 }).success).toBe(true)

  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/quota') { quotaRequests += 1; await route.fulfill({ json: ok({ remaining: 5 }) }); return }
    if (path === '/api/analyze-overview') { overviewBody = route.request().postDataJSON(); await route.fulfill({ json: ok(overview) }); return }
    if (path === '/api/analyze-candidates') { followupBody = route.request().postDataJSON(); await route.fulfill({ json: ok(final) }); return }
    await route.fallback()
  })

  await page.goto('/')
  await expect(page.getByText('剩余体验 5 次')).toBeVisible()
  const quotaRequestsAfterBootstrap = quotaRequests
  await page.getByRole('button', { name: '拍照开始选榴莲' }).click()
  await page.locator('input[type="file"]').setInputFiles(hero)
  await expect(page.getByRole('heading', { name: '初筛编号结果' })).toBeVisible()
  expect((overviewBody as { image?: string }).image).toMatch(/^data:image\/jpeg;base64,/)
  await expect(page.getByTestId('fruit-box-1')).toBeVisible()
  await page.getByRole('button', { name: '选择候选继续补拍' }).click()

  const labels = { stem: '果柄', body: '侧面和果刺', bottom: '底部果瓣线' }
  for (const id of [1, 2, 3]) {
    await page.getByRole('tab', { name: `${id}号` }).click()
    for (const view of ['stem', 'body', 'bottom'] as const) {
      await page.locator(`#capture-${id}-${view}`).setInputFiles(hero)
      await expect(page.getByAltText(`${id}号${labels[view]}预览`)).toBeVisible()
    }
  }
  await page.getByRole('button', { name: '提交补拍并生成建议' }).click()
  await expect(page.getByRole('heading', { name: '外观初筛建议' })).toBeVisible()
  const followup = candidateFollowUpPayloadSchema.parse(followupBody)
  expect(followup.taskToken).toBe(overview.taskToken)
  expect(followup.candidates.map(({ candidate_id }) => candidate_id)).toEqual([1, 2, 3])
  for (const candidate of followup.candidates) for (const photo of [candidate.stem, candidate.body, candidate.bottom]) expect(photo).toMatch(/^data:image\/jpeg;base64,/)
  expect(quotaRequests).toBe(quotaRequestsAfterBootstrap)

  await page.getByRole('button', { name: '保存或分享结果' }).click()
  await expect(page.getByText('长按保存结果图')).toBeVisible()
  await expect(page.getByRole('img', { name: '可长按保存的榴莲挑选结果图' })).toBeVisible()
  await page.getByRole('button', { name: '重新开始' }).click()
  await expect(page.getByText('剩余体验 4 次')).toBeVisible()
  expect(quotaRequests).toBe(quotaRequestsAfterBootstrap)
})

test('exhausted quota shows the real QR and copy action but cannot start a new task', async ({ page }) => {
  let apiRequests = 0
  expect(quotaSuccessPayloadSchema.safeParse({ remaining: 0 }).success).toBe(true)
  await page.route('**/api/**', async (route) => {
    apiRequests += 1
    await route.fulfill({ json: ok({ remaining: 0 }) })
  })
  await page.goto('/')
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('免费体验额度已用完。想获得更多额度，可添加微信 daquan088。')).toBeVisible()
  const apiRequestsAfterBootstrap = apiRequests
  await expect(dialog.getByRole('button', { name: '复制微信号 daquan088' })).toBeVisible()
  await dialog.getByRole('button', { name: '复制微信号 daquan088' }).click()
  await expect(dialog.getByRole('status')).toHaveText('微信号已复制')
  expect(await page.evaluate(() => (window as typeof window & { copiedWechat?: string }).copiedWechat)).toBe('daquan088')
  const qr = dialog.getByRole('img', { name: '大全微信二维码' })
  await expect(qr).toHaveAttribute('src', '/assets/daquan-wechat-qr.jpg')
  const bounds = await qr.boundingBox()
  expect(bounds?.width).toBeGreaterThanOrEqual(250)
  expect(bounds?.height).toBeGreaterThan(300)
  await dialog.getByRole('button', { name: '关闭弹窗' }).click()
  const start = page.getByRole('button', { name: '拍照开始选榴莲' })
  await expect(start).toBeDisabled()
  await start.click({ force: true })
  expect(apiRequests).toBe(apiRequestsAfterBootstrap)
})
