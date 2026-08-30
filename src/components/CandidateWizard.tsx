import { useEffect, useRef, useState } from 'react'
import type { CandidateFollowUpPayload, FinalRankingSuccessPayload } from '../../shared/contracts'
import { AppError, createIdempotencyKey } from '../lib/api'
import { type ProcessedImage } from '../lib/imageProcessing'
import { ErrorPanel } from './ErrorPanel'

type View = 'stem' | 'body' | 'bottom'
const views: readonly { key: View; label: string }[] = [
  { key: 'stem', label: '果柄' }, { key: 'body', label: '侧面和果刺' }, { key: 'bottom', label: '底部果瓣线' },
]
type CandidatePhotos = Partial<Record<View, ProcessedImage>>
export interface CandidateWizardProps {
  selectedIds: readonly number[]
  taskToken: string
  imageProcessor: (file: File) => Promise<ProcessedImage>
  submit: (payload: CandidateFollowUpPayload, options: { signal: AbortSignal; idempotencyKey: string }) => Promise<FinalRankingSuccessPayload>
  onSuccess: (result: FinalRankingSuccessPayload) => void
  onBack: () => void
}

export function CandidateWizard({ selectedIds, taskToken, imageProcessor, submit, onSuccess, onBack }: CandidateWizardProps) {
  const [activeId, setActiveId] = useState(selectedIds[0]!)
  const [photos, setPhotos] = useState<Record<number, CandidatePhotos>>(() => Object.fromEntries(selectedIds.map((id) => [id, {}])))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const submitKey = useRef<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const inputRefs = useRef<Partial<Record<View, HTMLInputElement | null>>>({})
  const photosRef = useRef(photos)
  photosRef.current = photos
  const activePhotos = photos[activeId] ?? {}
  const completed = views.filter(({ key }) => activePhotos[key]).length
  const allComplete = selectedIds.every((id) => views.every(({ key }) => photos[id]?.[key]))
  useEffect(() => () => { controllerRef.current?.abort(); Object.values(photosRef.current).forEach((candidate) => Object.values(candidate).forEach((photo) => photo?.revoke())) }, [])
  const choose = async (view: View, file?: File) => {
    if (!file || busy || submitting) return
    setBusy(`${activeId}-${view}`); setError(null)
    try {
      const processed = await imageProcessor(file)
      setPhotos((previous) => {
        previous[activeId]?.[view]?.revoke()
        return { ...previous, [activeId]: { ...previous[activeId], [view]: processed } }
      })
    } catch (reason) { setError(reason instanceof Error ? reason.message : '图片处理失败，请重新拍摄。') } finally { setBusy(null) }
  }
  const payload = (): CandidateFollowUpPayload => ({ taskToken, candidates: selectedIds.map((candidate_id) => ({ candidate_id, stem: photos[candidate_id]!.stem!.dataUrl, body: photos[candidate_id]!.body!.dataUrl, bottom: photos[candidate_id]!.bottom!.dataUrl })) })
  const performSubmit = async () => {
    if (!allComplete || submitting) return
    submitKey.current ??= createIdempotencyKey(); controllerRef.current?.abort(); const controller = new AbortController(); controllerRef.current = controller
    setSubmitting(true); setError(null)
    try { onSuccess(await submit(payload(), { signal: controller.signal, idempotencyKey: submitKey.current })) }
    catch (reason) { if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError(reason instanceof AppError ? reason.message : '分析暂时失败，请重试。') }
    finally { if (controllerRef.current === controller) controllerRef.current = null; setSubmitting(false) }
  }
  return <main className="app-shell flow-screen"><button type="button" className="back-button" onClick={onBack} disabled={submitting}>返回初筛结果</button>
    <h1>候选补拍 · {activeId}号</h1><p className="secondary-copy">请按要求补拍以下部位（{completed}/3）</p>
    <div className="candidate-tabs" role="tablist">{selectedIds.map((id) => <button key={id} type="button" role="tab" aria-selected={id === activeId} className={id === activeId ? 'is-active' : ''} onClick={() => setActiveId(id)}>{id}号</button>)}</div>
    <section className="capture-grid" aria-label={`${activeId}号补拍`}>
      {views.map(({ key, label }) => <div className="capture-slot" key={key}><input ref={(node) => { inputRefs.current[key] = node }} id={`capture-${activeId}-${key}`} hidden type="file" accept="image/*" capture="environment" onChange={(event) => { void choose(key, event.currentTarget.files?.[0]); event.currentTarget.value = '' }} />
        <button type="button" onClick={() => inputRefs.current[key]?.click()} disabled={Boolean(busy) || submitting} aria-label={`为${activeId}号拍摄${label}`}>
          {activePhotos[key] ? <img src={activePhotos[key]!.previewUrl} alt={`${activeId}号${label}预览`} /> : <span>{busy === `${activeId}-${key}` ? '正在处理照片…' : `拍${label}`}</span>}
          {activePhotos[key] ? <i aria-hidden="true">✓</i> : null}
        </button><strong>{label}</strong></div>)}
    </section>
    {error ? <ErrorPanel message={error} onRetry={allComplete ? () => { void performSubmit() } : undefined} /> : null}
    <button className="primary-button" type="button" disabled={!allComplete || submitting} onClick={() => { void performSubmit() }}>{submitting ? '正在生成外观初筛建议…' : '提交补拍并生成建议'}</button>
  </main>
}
