import { useEffect, useRef, useState } from 'react'
import type { FinalRankingSuccessPayload, OverviewSuccessPayload } from '../../shared/contracts'
import type { ProcessedImage } from '../lib/imageProcessing'
import { exportResultImage, type ResultImageExportOutcome } from '../lib/resultImage'
import { DurianOverlay } from './DurianOverlay'
export const FINAL_DISCLAIMER = '本工具仅根据照片中可见的外观特征提供初筛建议，不能保证榴莲的甜度、肉量，也不能排除生包、死包或内部变质。最终选择请结合门店专业人员判断。'
export type ResultImageExporter = (element: HTMLElement) => Promise<ResultImageExportOutcome>

export interface FinalResultProps {
  result: FinalRankingSuccessPayload
  overview: OverviewSuccessPayload
  overviewImage: Pick<ProcessedImage, 'dataUrl' | 'width' | 'height'>
  onRestart: () => void
  exportResult?: ResultImageExporter
}

export function FinalResult({ result, overview, overviewImage, onRestart, exportResult = exportResultImage }: FinalResultProps) {
  const captureRef = useRef<HTMLElement>(null)
  const mountedRef = useRef(true)
  const [busy, setBusy] = useState(false)
  const [fallbackDataUrl, setFallbackDataUrl] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    mountedRef.current = true
    setFallbackDataUrl(null)
    setMessage(null)
    return () => { mountedRef.current = false }
  }, [result])

  const generate = async () => {
    if (busy || !captureRef.current) return
    setBusy(true)
    setMessage(null)
    try {
      const outcome = await exportResult(captureRef.current)
      if (!mountedRef.current) return
      if (outcome.kind === 'shared') {
        setFallbackDataUrl(null)
        setMessage('已打开系统分享。')
      } else {
        setFallbackDataUrl(outcome.dataUrl)
        setMessage(outcome.kind === 'cancelled' ? '已取消分享，可长按保存结果图。' : outcome.error ? '分享未完成，已生成可保存的结果图。' : null)
      }
    } catch (error) {
      if (mountedRef.current) setMessage(error instanceof Error ? error.message : '结果图生成失败，请重新生成。')
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  const ranked = result.result.ranking.slice().sort((a, b) => a.rank - b.rank)
  return <main className="app-shell flow-screen"><section ref={captureRef} className="result-capture-card" data-testid="result-capture-card"><p className="result-capture-card__brand">大全助你选金枕榴莲</p><h1>外观初筛建议</h1>
    <figure className="result-capture-overview"><figcaption>原图编号</figcaption><div className="analysis-image analysis-image--result"><img src={overviewImage.dataUrl} alt="带编号的榴莲合照" /><DurianOverlay fruits={overview.fruits} width={overviewImage.width} height={overviewImage.height} shortlistIds={overview.shortlist_ids} /></div></figure>
    {ranked.map((item) => <article className="final-card" key={item.candidate_id}><h2>{item.rank === 1 ? '第一推荐' : `备选 ${item.rank - 1}`} · {item.candidate_id}号</h2><p className="score">外观推荐指数 <strong>{item.appearance_score}</strong></p><p><b>可见证据：</b>{item.evidence.join('；')}</p>{item.risks.length ? <p className="risk-text"><b>风险提示：</b>{item.risks.join('；')}</p> : null}<p className="secondary-copy">证据充分度：{item.evidence_strength === 'high' ? '充分' : item.evidence_strength === 'medium' ? '一般' : '有限'}</p></article>)}
    <section className="summary-card"><p>{result.result.summary}</p><p className="secondary-copy">{result.result.limitations.join('；')}</p><p className="relative-note">外观推荐指数仅表示同批候选的可见外观相对排序，不是甜度、成熟度或内部品质概率。</p><p className="risk-text final-disclaimer">{FINAL_DISCLAIMER}</p></section>
  </section>
    {message ? <p className="export-message" role="status" aria-live="polite">{message}</p> : null}
    {fallbackDataUrl ? <section className="result-image-preview" aria-label="结果图预览"><p>长按保存结果图</p><img src={fallbackDataUrl} alt="可长按保存的榴莲挑选结果图" /><button type="button" className="secondary-button" onClick={() => setFallbackDataUrl(null)} aria-label="关闭结果图预览">关闭预览</button></section> : null}
    <button type="button" className="primary-button" onClick={() => { void generate() }} disabled={busy}>{busy ? '正在生成结果图…' : '保存或分享结果'}</button><button type="button" className="secondary-button" onClick={() => { void generate() }} disabled={busy}>重新生成结果图</button><button type="button" className="secondary-button" onClick={onRestart} disabled={busy}>重新开始</button>
  </main>
}
