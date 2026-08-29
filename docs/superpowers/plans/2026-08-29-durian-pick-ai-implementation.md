# “大全助你选金枕榴莲” Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy an isolated WeChat-friendly H5 demo that detects and numbers up to 20 visible Monthong durians, shortlists candidates, performs three-view follow-up analysis with GPT-5.6 Terra, enforces five free tasks per browser device, and converts exhausted users to WeChat `daquan088`.

**Architecture:** A React 19 SPA and a Cloudflare Worker live in one Vite project. The browser handles capture, metadata removal, compression, overlays, and result-image export; the Worker handles validation, quota checks, signed task tokens, OpenAI Responses API calls, structured-output cleanup, and minimal Cloudflare KV counters. All code, resources, repositories, bindings, and deployment names are new and must not touch existing projects.

**Tech Stack:** Node.js 24, React 19.2.8, TypeScript 7.0.2, Vite 8.2.2, Cloudflare Vite Plugin 1.54.2, Wrangler 4.127.1, Zod 4.5.2, Vitest 4.1.11, Testing Library 16.3.3, Playwright 1.62.1, OpenAI Responses API with `gpt-5.6-terra`.

---

## File structure

```text
D:\榴莲挑选智能体\
├─ package.json
├─ package-lock.json
├─ index.html
├─ vite.config.ts
├─ vitest.config.ts
├─ playwright.config.ts
├─ tsconfig.json
├─ tsconfig.app.json
├─ tsconfig.worker.json
├─ wrangler.jsonc
├─ .gitignore
├─ .dev.vars.example
├─ public/assets/daquan-wechat-qr.jpg
├─ shared/contracts.ts
├─ shared/geometry.ts
├─ worker/env.d.ts
├─ worker/index.ts
├─ worker/http.ts
├─ worker/security/hash.ts
├─ worker/security/taskToken.ts
├─ worker/quota/quotaService.ts
├─ worker/openai/prompts.ts
├─ worker/openai/client.ts
├─ worker/analysis/overview.ts
├─ worker/analysis/candidates.ts
├─ src/main.tsx
├─ src/app/App.tsx
├─ src/app/appReducer.ts
├─ src/styles/tokens.css
├─ src/styles/global.css
├─ src/lib/api.ts
├─ src/lib/deviceId.ts
├─ src/lib/imageProcessing.ts
├─ src/lib/resultImage.ts
├─ src/components/HomeScreen.tsx
├─ src/components/OverviewScreen.tsx
├─ src/components/DurianOverlay.tsx
├─ src/components/CandidateWizard.tsx
├─ src/components/FinalResult.tsx
├─ src/components/QuotaModal.tsx
├─ src/components/ErrorPanel.tsx
├─ tests/setup.ts
├─ tests/shared/geometry.test.ts
├─ tests/worker/quotaService.test.ts
├─ tests/worker/taskToken.test.ts
├─ tests/worker/openaiClient.test.ts
├─ tests/worker/routes.test.ts
├─ tests/browser/imageProcessing.test.ts
├─ tests/browser/appReducer.test.ts
├─ tests/browser/quotaModal.test.tsx
├─ tests/browser/overviewScreen.test.tsx
├─ tests/browser/candidateWizard.test.tsx
└─ e2e/happy-path.spec.ts
```

Each file has one responsibility. Shared schemas are the only contract between browser and Worker. Do not write project code under `D:\C_Drive_Relocated\Documents\程序开发`.

### Task 1: Scaffold the isolated full-stack project

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `.dev.vars.example`
- Create: `index.html`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `tsconfig.json`
- Create: `tsconfig.app.json`
- Create: `tsconfig.worker.json`
- Create: `wrangler.jsonc`
- Create: `src/main.tsx`
- Create: `worker/index.ts`

- [ ] **Step 1: Verify isolation before writing**

```powershell
(Resolve-Path 'D:\榴莲挑选智能体').Path
git status --short --branch
```

Expected: exact path `D:\榴莲挑选智能体`, branch `main`, only approved docs present.

- [ ] **Step 2: Create the pinned package manifest**

Write `package.json`:

```json
{
  "name": "durian-pick-ai-demo",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.0.0" },
  "scripts": {
    "dev": "vite dev",
    "build": "tsc -b && vite build",
    "preview": "npm run build && vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "typecheck": "tsc -b --pretty false",
    "deploy": "npm run build && wrangler deploy"
  },
  "dependencies": {
    "exifr": "7.1.3",
    "html-to-image": "1.11.13",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "zod": "4.5.2"
  },
  "devDependencies": {
    "@cloudflare/vite-plugin": "1.54.2",
    "@cloudflare/workers-types": "5.20260829.1",
    "@playwright/test": "1.62.1",
    "@testing-library/jest-dom": "7.0.1",
    "@testing-library/react": "16.3.3",
    "@testing-library/user-event": "14.6.6",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.5",
    "@vitejs/plugin-react": "6.1.1",
    "jsdom": "30.0.1",
    "typescript": "7.0.2",
    "vite": "8.2.2",
    "vitest": "4.1.11",
    "wrangler": "4.127.1"
  }
}
```

- [ ] **Step 3: Create secret-safe configuration**

`.gitignore`:

```gitignore
node_modules/
dist/
.dev.vars
.wrangler/
playwright-report/
test-results/
coverage/
*.local
```

`.dev.vars.example`:

```dotenv
OPENAI_API_KEY=
QUOTA_SALT=
TASK_TOKEN_SECRET=
```

`wrangler.jsonc`:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "durian-pick-ai-demo",
  "compatibility_date": "2026-08-29",
  "main": "./worker/index.ts",
  "assets": { "not_found_handling": "single-page-application" },
  "vars": { "MODEL_ID": "gpt-5.6-terra" }
}
```

- [ ] **Step 4: Configure React, Cloudflare, tests, and project references**

`vite.config.ts`:

```ts
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [react(), cloudflare()] });
```

`vitest.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: { environment: "jsdom", setupFiles: ["./tests/setup.ts"] },
});
```

`tsconfig.json` references `tsconfig.app.json` and `tsconfig.worker.json`. The app config includes `src`, `shared`, `tests/browser`, and `e2e`; the Worker config includes `worker`, `shared`, and `tests/worker` with `types: ["@cloudflare/workers-types"]`.

- [ ] **Step 5: Install and prove the shell builds**

```powershell
npm install
npm run typecheck
npm run build
```

Expected: all exit 0 and `dist/` is generated.

- [ ] **Step 6: Commit**

```powershell
git add package.json package-lock.json .gitignore .dev.vars.example index.html vite.config.ts vitest.config.ts tsconfig.json tsconfig.app.json tsconfig.worker.json wrangler.jsonc src/main.tsx worker/index.ts
git commit -m "chore: scaffold isolated durian picker app"
```

### Task 2: Add shared schemas, box cleanup, and numbering

**Files:**
- Create: `shared/contracts.ts`
- Create: `shared/geometry.ts`
- Create: `tests/shared/geometry.test.ts`

- [ ] **Step 1: Write the failing geometry tests**

```ts
import { describe, expect, it } from "vitest";
import { sanitizeAndNumberBoxes } from "../../shared/geometry";

describe("sanitizeAndNumberBoxes", () => {
  it("drops invalid and duplicate boxes, then numbers rows left-to-right", () => {
    const result = sanitizeAndNumberBoxes([
      { box_2d: [510, 80, 900, 430], status: "normal" },
      { box_2d: [80, 520, 420, 900], status: "preferred" },
      { box_2d: [70, 40, 430, 430], status: "preferred" },
      { box_2d: [75, 45, 425, 425], status: "normal" },
      { box_2d: [-1, 0, 10, 10], status: "risky" }
    ]);
    expect(result.map(({ id, box_2d }) => ({ id, box_2d }))).toEqual([
      { id: 1, box_2d: [70, 40, 430, 430] },
      { id: 2, box_2d: [80, 520, 420, 900] },
      { id: 3, box_2d: [510, 80, 900, 430] }
    ]);
  });

  it("returns at most twenty boxes", () => {
    const boxes = Array.from({ length: 25 }, (_, index) => ({
      box_2d: [index * 30, 0, index * 30 + 25, 100],
      status: "normal" as const
    }));
    expect(sanitizeAndNumberBoxes(boxes)).toHaveLength(20);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npm test -- tests/shared/geometry.test.ts`

Expected: FAIL because `shared/geometry.ts` does not exist.

- [ ] **Step 3: Define strict contracts**

In `shared/contracts.ts`, create Zod schemas for normalized boxes, overview model output, numbered fruit, candidate payload, final ranking, API success envelopes, and stable error codes. Export inferred TypeScript types. Enums must exactly match `preferred | normal | risky | insufficient`, `high | medium | low`, and `good | usable | poor`.

- [ ] **Step 4: Implement cleanup and deterministic numbering**

```ts
import type { RawFruit } from "./contracts";

const area = ([y1, x1, y2, x2]: number[]) => (y2 - y1) * (x2 - x1);

const iou = (a: number[], b: number[]) => {
  const y1 = Math.max(a[0], b[0]);
  const x1 = Math.max(a[1], b[1]);
  const y2 = Math.min(a[2], b[2]);
  const x2 = Math.min(a[3], b[3]);
  const intersection = Math.max(0, y2 - y1) * Math.max(0, x2 - x1);
  return intersection / Math.max(1, area(a) + area(b) - intersection);
};

export function sanitizeAndNumberBoxes(raw: RawFruit[]) {
  const valid = raw
    .filter(({ box_2d }) => box_2d.every((n) => Number.isFinite(n) && n >= 0 && n <= 1000))
    .filter(({ box_2d }) => box_2d[2] > box_2d[0] && box_2d[3] > box_2d[1] && area(box_2d) >= 400)
    .sort((a, b) => area(b.box_2d) - area(a.box_2d));

  return valid
    .filter((item, index, all) =>
      all.slice(0, index).every((previous) => iou(item.box_2d, previous.box_2d) < 0.72))
    .slice(0, 20)
    .sort((a, b) => {
      const ay = (a.box_2d[0] + a.box_2d[2]) / 2;
      const by = (b.box_2d[0] + b.box_2d[2]) / 2;
      return Math.abs(ay - by) > 120 ? ay - by : a.box_2d[1] - b.box_2d[1];
    })
    .map((item, index) => ({ ...item, id: index + 1 }));
}
```

- [ ] **Step 5: Pass tests and commit**

```powershell
npm test -- tests/shared/geometry.test.ts
npm run typecheck
git add shared tests/shared
git commit -m "feat: add validated durian analysis contracts"
```

### Task 3: Enforce device quota, IP throttle, and signed task tokens

**Files:**
- Create: `worker/env.d.ts`
- Create: `worker/security/hash.ts`
- Create: `worker/security/taskToken.ts`
- Create: `worker/quota/quotaService.ts`
- Create: `tests/worker/quotaService.test.ts`
- Create: `tests/worker/taskToken.test.ts`

- [ ] **Step 1: Write failing quota tests**

```ts
it("allows five successful reservations and rejects the sixth", async () => {
  const quota = createQuotaService(memoryKv(), "salt");
  for (let count = 0; count < 5; count += 1) {
    await expect(quota.reserve("device-a", "203.0.113.7", now))
      .resolves.toMatchObject({ remaining: 4 - count });
  }
  await expect(quota.reserve("device-a", "203.0.113.7", now))
    .rejects.toMatchObject({ code: "QUOTA_EXHAUSTED" });
});

it("does not increment during preflight", async () => {
  const quota = createQuotaService(memoryKv(), "salt");
  expect(await quota.getRemaining("device-a")).toBe(5);
  expect(await quota.getRemaining("device-a")).toBe(5);
});
```

Add an IP test that rejects reservation 51 in one UTC day and allows it on the next UTC day.

- [ ] **Step 2: Write failing token tests**

```ts
it("rejects a modified token", async () => {
  const token = await signTaskToken(
    { taskId: "task-1", deviceHash: "abc", allowedIds: [1, 2], exp: 2000 },
    "secret"
  );
  const altered = token.slice(0, -1) + "x";
  await expect(verifyTaskToken(altered, "secret", 1000))
    .rejects.toMatchObject({ code: "INVALID_TASK" });
});
```

Also test expiry and candidate IDs outside `allowedIds`.

- [ ] **Step 3: Verify failure**

Run: `npm test -- tests/worker/quotaService.test.ts tests/worker/taskToken.test.ts`

Expected: FAIL because modules do not exist.

- [ ] **Step 4: Implement one-way hashes, counters, and HMAC**

`hash.ts` computes SHA-256 of `${salt}:${value}` and returns lowercase hex without logging input. Quota keys are `device:<hash>` and `ip:<YYYY-MM-DD>:<hash>`; IP keys get TTL 172800 seconds. Device count has a hard limit of 5 and IP count a hard limit of 50 per UTC day.

Task token payload:

```ts
export interface TaskTokenPayload {
  taskId: string;
  deviceHash: string;
  allowedIds: number[];
  exp: number;
}
```

Sign UTF-8 JSON with HMAC-SHA256 and base64url. Verification uses constant-time byte comparison and rejects malformed or expired payloads.

- [ ] **Step 5: Pass tests and commit**

```powershell
npm test -- tests/worker/quotaService.test.ts tests/worker/taskToken.test.ts
npm run typecheck
git add worker/env.d.ts worker/security worker/quota tests/worker
git commit -m "feat: enforce demo quotas with signed tasks"
```

### Task 4: Add the evidence-bounded GPT-5.6 Terra client

**Files:**
- Create: `worker/openai/prompts.ts`
- Create: `worker/openai/client.ts`
- Create: `tests/worker/openaiClient.test.ts`

- [ ] **Step 1: Write mocked Responses API tests**

Use this valid fixture and also cover 401, 429, timeout, malformed output, and one retry after invalid JSON:

```ts
const successResponse = {
  output: [{
    type: "message",
    role: "assistant",
    content: [{
      type: "output_text",
      text: JSON.stringify({
        processable: true,
        too_many: false,
        image_quality: "good",
        warnings: [],
        fruits: [{
          box_2d: [100, 100, 500, 500],
          visibility: "high",
          status: "preferred",
          evidence: ["果形较饱满"],
          risks: [],
          evidence_strength: "medium"
        }]
      })
    }]
  }]
};
```

- [ ] **Step 2: Verify failure**

Run: `npm test -- tests/worker/openaiClient.test.ts`

Expected: FAIL because the client does not exist.

- [ ] **Step 3: Implement exact prompts**

The Chinese overview and candidate prompts must permit only visible evidence. They explicitly forbid claims about smell, tapping sound, weight, sweetness, pulp, flesh ratio, and internal condition. Overview output sets `processable:false` for no durian, severe blur, or unusable darkness; it sets `too_many:true` when the visible count exceeds 20 and returns no recommendations.

- [ ] **Step 4: Implement raw Responses API fetch**

```ts
const body = {
  model: env.MODEL_ID,
  store: false,
  reasoning: { effort: "low" },
  input: [{
    role: "user",
    content: [
      { type: "input_text", text: prompt },
      ...images.map((image_url) => ({
        type: "input_image",
        image_url,
        detail: "original"
      }))
    ]
  }],
  text: {
    verbosity: "low",
    format: {
      type: "json_schema",
      name: schemaName,
      strict: true,
      schema: jsonSchema
    }
  }
};
```

POST to `https://api.openai.com/v1/responses` with Bearer auth, JSON content type, `store:false`, and 45-second timeout. Extract only assistant `output_text`, parse JSON, then validate with Zod. Map 401/403 to `PROVIDER_AUTH`, 429 to `PROVIDER_RATE_LIMIT`, timeout to `PROVIDER_TIMEOUT`, and other failures to `PROVIDER_FAILURE`. Never return upstream bodies or secrets to clients.

- [ ] **Step 5: Pass tests and commit**

```powershell
npm test -- tests/worker/openaiClient.test.ts
npm run typecheck
git add worker/openai tests/worker/openaiClient.test.ts
git commit -m "feat: add structured gpt-5.6 terra client"
```

### Task 5: Add secure Worker API routes

**Files:**
- Create: `worker/http.ts`
- Create: `worker/analysis/overview.ts`
- Create: `worker/analysis/candidates.ts`
- Modify: `worker/index.ts`
- Create: `tests/worker/routes.test.ts`

- [ ] **Step 1: Write failing route tests**

Assert invalid image is 400, valid overview is 200, four candidates is 400, tampered token is 403, and exhausted quota is 429. Also assert same-origin enforcement, 25 MB request cap, MIME allowlist, exactly three views per candidate, no quota charge for unprocessable images, and no second charge for candidate analysis.

- [ ] **Step 2: Verify failure**

Run: `npm test -- tests/worker/routes.test.ts`

Expected: FAIL because route handlers do not exist.

- [ ] **Step 3: Implement overview orchestration**

Sequence:

1. validate device UUID and one JPEG/PNG/WebP data URL;
2. read remaining quota without increment;
3. call GPT;
4. reject `processable:false` or `too_many:true` without charge;
5. clean and number boxes;
6. reserve one device task and IP count;
7. sign a two-hour token containing valid IDs;
8. return numbered fruits, 3–5 preferred IDs when available, remaining count, and token.

If fewer than three valid fruits exist, return the actual count.

- [ ] **Step 4: Implement candidate orchestration and router**

Candidates verify token, device hash, allowed IDs, maximum 3 candidates, and exact `stem`, `body`, `bottom` views. They call GPT once without reserving quota and return at most three continuous ranks.

Router:

```ts
switch (`${request.method} ${url.pathname}`) {
  case "GET /api/quota": return handleQuota(request, env);
  case "POST /api/analyze-overview": return handleOverview(request, env);
  case "POST /api/analyze-candidates": return handleCandidates(request, env);
  default: return jsonError(404, "NOT_FOUND", "请求地址不存在");
}
```

All API responses set `Cache-Control:no-store`, `X-Content-Type-Options:nosniff`, and restrictive referrer policy.

- [ ] **Step 5: Pass tests and commit**

```powershell
npm test -- tests/worker/routes.test.ts
npm run typecheck
git add worker tests/worker/routes.test.ts
git commit -m "feat: add secure durian analysis routes"
```

### Task 6: Add browser identity and private image preparation

**Files:**
- Create: `src/lib/deviceId.ts`
- Create: `src/lib/imageProcessing.ts`
- Create: `tests/browser/imageProcessing.test.ts`

- [ ] **Step 1: Write failing utility tests**

```ts
it("rejects files above 25 MB before decoding", async () => {
  const bytes = new Uint8Array(25 * 1024 * 1024 + 1);
  const file = new File([bytes], "huge.jpg", { type: "image/jpeg" });
  await expect(processImage(file))
    .rejects.toMatchObject({ code: "IMAGE_TOO_LARGE" });
});
```

Also test stable UUID, maximum 2560-pixel edge, JPEG output, and absent EXIF GPS.

- [ ] **Step 2: Verify failure**

Run: `npm test -- tests/browser/imageProcessing.test.ts`

Expected: FAIL because utilities do not exist.

- [ ] **Step 3: Implement device identity and canvas re-encoding**

Use `crypto.randomUUID()` stored as `durian-picker-device-id`. Decode with `createImageBitmap(file, { imageOrientation:"from-image" })`, draw into a fresh canvas, and export `image/jpeg` at 0.85. Scale:

```ts
const ratio = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
const width = Math.round(bitmap.width * ratio);
const height = Math.round(bitmap.height * ratio);
```

Return blob, data URL, dimensions, and preview URL. Re-encoding into a new canvas strips original metadata.

- [ ] **Step 4: Pass tests and commit**

```powershell
npm test -- tests/browser/imageProcessing.test.ts
npm run typecheck
git add src/lib tests/browser/imageProcessing.test.ts
git commit -m "feat: add private mobile image preparation"
```

### Task 7: Generate and approve the complete visual concept

**Files:**
- Create: `docs/design/durian-picker-mobile-concept.png`
- Create: `docs/design/design-tokens.md`

- [ ] **Step 1: Invoke imagegen before UI coding**

Use this brief:

```text
Design a polished Chinese mobile H5 product called “大全助你选金枕榴莲”, subtitle “泰国金枕外观AI初筛演示版”. Show six coordinated 390x844 screens: home with remaining 5 uses and camera CTA; analyzing state without fake percent; overview photo with numbered durian boxes and 3–5 shortlist cards; candidate capture wizard for stem/body/bottom; final ranked recommendation with visible-evidence disclaimer; quota-exhausted modal with copy-WeChat button and a large real-image QR area. Use durian green, pulp gold, warm ivory, excellent Chinese typography, large touch targets, trustworthy agricultural tone, no sci-fi dashboard, no invented accuracy claims, and no eyebrow badge. Controls and text must be code-native and practical in React.
```

- [ ] **Step 2: Inspect with `view_image`**

Regenerate if a screen is missing, Chinese text is unreadable, QR area is too small, or login/payment/accuracy claims appear.

- [ ] **Step 3: Obtain user approval**

Show the full concept before production UI code. Save the accepted image at the exact path above.

- [ ] **Step 4: Extract numeric design tokens**

Record exact hex colors, font stack, type scale, spacing, radii, shadows, button heights, overlay colors, content width, and modal dimensions in `design-tokens.md`.

- [ ] **Step 5: Commit**

```powershell
git add docs/design
git commit -m "design: approve mobile durian picker interface"
```

### Task 8: Build the state machine, home, and quota conversion

**Files:**
- Create: `src/app/appReducer.ts`
- Create: `src/app/App.tsx`
- Create: `src/lib/api.ts`
- Create: `src/styles/tokens.css`
- Create: `src/styles/global.css`
- Create: `src/components/HomeScreen.tsx`
- Create: `src/components/QuotaModal.tsx`
- Create: `src/components/ErrorPanel.tsx`
- Modify: `src/main.tsx`
- Copy: `D:\海报照片\微信图片_20260829221306_248_23.jpg` to `public/assets/daquan-wechat-qr.jpg`
- Create: `tests/browser/appReducer.test.ts`
- Create: `tests/browser/quotaModal.test.tsx`

- [ ] **Step 1: Write reducer and modal tests**

```ts
type Screen = "home" | "overview" | "shortlist" | "capture" | "final";
type Action =
  | { type: "START_OVERVIEW" }
  | { type: "OVERVIEW_SUCCESS"; payload: OverviewSuccess }
  | { type: "SELECT_CANDIDATES"; ids: number[] }
  | { type: "CANDIDATES_SUCCESS"; payload: CandidateSuccess }
  | { type: "RESET" };
```

Test that more than three IDs are rejected. Test exact exhausted copy, QR `<img alt="大全微信二维码">`, and clipboard value `daquan088`.

- [ ] **Step 2: Verify failure**

Run: `npm test -- tests/browser/appReducer.test.ts tests/browser/quotaModal.test.tsx`

Expected: FAIL because components do not exist.

- [ ] **Step 3: Implement typed API and app shell**

`api.ts` sends `x-device-id`, parses shared schemas, and throws typed `AppError`. `App.tsx` uses `useReducer`, reads `/api/quota` at mount, and opens the modal when remaining is zero or error is `QUOTA_EXHAUSTED`.

- [ ] **Step 4: Implement accepted visuals and copy the QR safely**

Use only approved tokens. Copy with `Copy-Item -LiteralPath`; do not modify the source. Render:

```tsx
<img
  src="/assets/daquan-wechat-qr.jpg"
  alt="大全微信二维码"
  width={760}
  height={1288}
  loading="eager"
/>
```

- [ ] **Step 5: Pass tests and commit**

```powershell
npm test -- tests/browser/appReducer.test.ts tests/browser/quotaModal.test.tsx
npm run typecheck
git add src public/assets/daquan-wechat-qr.jpg tests/browser
git commit -m "feat: add branded entry and quota conversion"
```

### Task 9: Build overview, shortlist, candidate wizard, and final result

**Files:**
- Create: `src/components/OverviewScreen.tsx`
- Create: `src/components/DurianOverlay.tsx`
- Create: `src/components/CandidateWizard.tsx`
- Create: `src/components/FinalResult.tsx`
- Modify: `src/app/App.tsx`
- Create: `tests/browser/overviewScreen.test.tsx`
- Create: `tests/browser/candidateWizard.test.tsx`

- [ ] **Step 1: Write failing overview tests**

Upload one JPEG, assert preview, mock overview API, and assert numbered labels and 3–5 reasons. Test poor image retry and quota modal.

- [ ] **Step 2: Write failing wizard tests**

Assert each selected candidate needs `stem`, `body`, and `bottom`; maximum 3 candidates/9 images; missing view disables submit; valid final response renders continuous ranks and fixed disclaimer.

- [ ] **Step 3: Verify failure**

```powershell
npm test -- tests/browser/overviewScreen.test.tsx tests/browser/candidateWizard.test.tsx
```

Expected: FAIL because components do not exist.

- [ ] **Step 4: Implement overlay and shortlist**

Render normalized boxes in a 0–1000 SVG coordinate system:

```tsx
<rect x={x1} y={y1} width={x2 - x1} height={y2 - y1}
  rx={18} className={`box box--${status}`} />
<circle cx={x1 + 34} cy={y1 + 34} r={30} className="number-dot" />
<text x={x1 + 34} y={y1 + 44} textAnchor="middle">{id}</text>
```

Preserve photograph aspect ratio. Show “识别到 N 颗；未识别或遮挡严重的榴莲不参与推荐”. Preselect preferred IDs and cap selection at three.

- [ ] **Step 5: Implement three-view payload and final semantics**

```ts
{
  taskToken,
  candidates: selectedIds.map((candidateId) => ({
    candidate_id: candidateId,
    stem: captures[candidateId].stem.dataUrl,
    body: captures[candidateId].body.dataUrl,
    bottom: captures[candidateId].bottom.dataUrl
  }))
}
```

Label rank 1 “第一推荐”, ranks 2–3 “备选”, score “外观推荐指数”, and explain that it is not sweetness or internal-quality probability.

- [ ] **Step 6: Pass tests and commit**

```powershell
npm test -- tests/browser/overviewScreen.test.tsx tests/browser/candidateWizard.test.tsx
npm run typecheck
git add src/components src/app/App.tsx tests/browser
git commit -m "feat: complete two-stage durian selection flow"
```

### Task 10: Add result export and full mobile E2E tests

**Files:**
- Create: `src/lib/resultImage.ts`
- Modify: `src/components/FinalResult.tsx`
- Create: `tests/browser/resultImage.test.ts`
- Create: `playwright.config.ts`
- Create: `e2e/happy-path.spec.ts`

- [ ] **Step 1: Write export tests**

Mock `html-to-image` and `navigator.share`. Assert supported browsers share a PNG `File`; unsupported browsers expose a real image for long-press saving; export contains title and disclaimer.

- [ ] **Step 2: Implement export fallback**

Use `toPng(element, { pixelRatio:2, cacheBust:true })`. Name file `大全助你选金枕榴莲-结果.png`. Check `navigator.canShare({ files:[file] })` before sharing; otherwise render the PNG with “长按保存结果图”.

- [ ] **Step 3: Configure Playwright mobile projects**

Use `devices["iPhone 14"]` and `devices["Pixel 7"]`, start `npm run dev -- --host 127.0.0.1`, and fail on console errors.

- [ ] **Step 4: Write mocked happy-path and exhausted-quota E2E**

Intercept all three API routes with schema-valid fixtures. Test home → upload → numbering → shortlist → three-view capture → final → export. Then return zero quota and verify exact contact copy, clipboard button, QR image, and WeChat ID.

- [ ] **Step 5: Run complete local gate and commit**

```powershell
npm test
npm run typecheck
npm run build
npx playwright install chromium
npm run test:e2e
git add src/lib/resultImage.ts src/components/FinalResult.tsx tests/browser/resultImage.test.ts playwright.config.ts e2e
git commit -m "test: cover complete mobile selection flow"
```

### Task 11: Verify provider and provision isolated Cloudflare resources

**Files:**
- Modify: `wrangler.jsonc`
- Create locally only: `.dev.vars`

- [ ] **Step 1: Smoke-test existing OpenAI access without revealing the key**

Read the existing key into process memory and send one minimal image-input Responses request to `gpt-5.6-terra` with `store:false` and schema `{ "ok": true }`. Log only HTTP status, model ID, and success category.

Expected: HTTP 200. On auth, billing, or model-access failure, stop and report; never substitute another model.

- [ ] **Step 2: Verify Cloudflare login and name safety**

```powershell
npx wrangler whoami
npx wrangler deployments list --name durian-pick-ai-demo
```

Expected: authenticated account and no existing Worker with that name. If it exists, do not overwrite it; pause for a new user-approved name.

- [ ] **Step 3: Create a new KV namespace and bind its emitted ID**

```powershell
npx wrangler kv namespace create DURIAN_PICKER_QUOTA
```

Add one `kv_namespaces` entry to `wrangler.jsonc`: its binding is exactly `QUOTA_KV` and its `id` is the exact namespace ID printed by the preceding Wrangler command. Before commit, validate the configuration with `npx wrangler deploy --dry-run` so an omitted, malformed, or guessed ID cannot pass.

- [ ] **Step 4: Create new Worker secrets**

Generate independent 32-byte random values for quota salt and task token secret, then run:

```powershell
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put QUOTA_SALT
npx wrangler secret put TASK_TOKEN_SECRET
```

Never print or commit full values. Put local copies only in ignored `.dev.vars`.

- [ ] **Step 5: Scan secrets and commit binding configuration**

```powershell
git diff --check
git grep -n -E "sk-[A-Za-z0-9_-]{20,}|OPENAI_API_KEY=.+|TASK_TOKEN_SECRET=.+|QUOTA_SALT=.+" -- . ':!package-lock.json'
git add wrangler.jsonc
git commit -m "chore: configure isolated cloudflare bindings"
```

Expected: secret scan has no matches.

### Task 12: Add CI, deploy, create GitHub repo, and verify real devices

**Files:**
- Create: `README.md`
- Create: `.github/workflows/ci.yml`
- Create: `docs/qa/2026-08-29-release-checklist.md`

- [ ] **Step 1: Write public-safe README and CI**

README covers scope, limitations, local setup from `.dev.vars.example`, commands, privacy, deployment, and prohibition on committing real store photos/secrets. CI uses Node 24 and runs `npm ci`, tests, typecheck, and build without external APIs.

- [ ] **Step 2: Run final local checks**

```powershell
npm ci
npm test
npm run typecheck
npm run build
npm run test:e2e
```

Expected: all exit 0.

- [ ] **Step 3: Deploy only the new Worker**

Run `npx wrangler deploy`. Record the new workers.dev URL. Fetch homepage and `/api/quota`. Verify it is not an existing domain or route.

- [ ] **Step 4: Create and push a new GitHub repository**

Create `durian-pick-ai-demo` in the user’s authenticated account. If it exists, stop and ask. Add only that repo as `origin`, verify `git remote -v`, and push `main`. Confirm no store photos, secrets, old-project files, or local configuration appear remotely.

- [ ] **Step 5: Perform visual fidelity review**

Capture production screens at 390×844. Use `view_image` on both the approved concept and latest screenshots. Fix mismatches until typography, spacing, colors, hierarchy, responsive behavior, and QR sizing pass sign-off. Re-run all checks after fixes.

- [ ] **Step 6: Test authorized real photos and WeChat devices**

Use one 5–10 fruit image and one 15–20 fruit casual image without committing them. Test iPhone and Android WeChat: camera/gallery, scrolling, result save fallback, copy `daquan088`, full QR display, and long-press recognition. Record pass/fail in the QA checklist.

- [ ] **Step 7: Commit final QA and push**

```powershell
git add README.md .github/workflows/ci.yml docs/qa src worker shared tests e2e
git commit -m "release: verify durian picker demo"
git push origin main
```

Skip the commit only if no tracked file changed.

- [ ] **Step 8: Final handoff**

Provide the new WeChat-openable URL, new GitHub URL, model name, quota behavior, known limitations, and update instructions. Explicitly confirm old local projects, GitHub repositories, Cloudflare projects, domains, and links were not modified.

## Plan self-review

- Spec coverage: Tasks 1–12 cover all approved workflow, branding, model, quota, QR, privacy, tests, isolation, GitHub, and Cloudflare requirements.
- Placeholder scan: no design or code placeholder remains. The Cloudflare namespace ID is an external deployment value produced by the exact Task 11 command and validated by a Wrangler dry run before commit.
- Type consistency: route names, status enums, task token fields, image view names, and API payload names remain consistent.
- Scope: login, payment, mini-program, custom domain, audio, other varieties, and custom model training remain excluded.
