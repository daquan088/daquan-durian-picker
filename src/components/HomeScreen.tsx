import { ErrorPanel } from './ErrorPanel'

export interface HomeScreenProps {
  remaining: number | null
  quotaLoading: boolean
  quotaError?: string | null
  canStart: boolean
  onStart: () => void
  onRetryQuota: () => void
}

function CameraIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  )
}

export function HomeScreen({ remaining, quotaLoading, quotaError, canStart, onStart, onRetryQuota }: HomeScreenProps) {
  const quotaLabel = quotaLoading
    ? '正在获取体验次数…'
    : remaining === null
      ? '体验次数暂时无法获取'
      : `剩余体验 ${remaining} 次`

  return (
    <main className="app-shell">
      <section className="home-screen" aria-labelledby="home-title">
        <header className="home-header">
          <div>
            <h1 id="home-title">大全助你选金枕榴莲</h1>
            <p>泰国金枕外观 AI 初筛演示版</p>
          </div>
          <p className="quota-pill" aria-live="polite">{quotaLabel}</p>
        </header>

        <div className="hero-media" aria-hidden="true">
          <img src="/assets/durian-home-hero.png" alt="" />
        </div>

        <div className="home-content">
          <button className="primary-button home-start" type="button" onClick={onStart} disabled={!canStart}>
            <CameraIcon />
            <span>拍照开始选榴莲</span>
          </button>
          <p className="home-tip"><strong>随手拍，最多 20 颗</strong><span>遮挡严重或未识别的榴莲不会被编号</span></p>
          {quotaError ? <ErrorPanel message={quotaError} onRetry={onRetryQuota} /> : null}
        </div>
        <footer>由大全提供 · 实体 AI 赋能陪做教练</footer>
      </section>
    </main>
  )
}
