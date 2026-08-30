import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { CandidateFollowUpPayload, FinalRankingSuccessPayload, OverviewSuccessPayload } from '../../shared/contracts'
import { CandidateWizard } from '../components/CandidateWizard'
import { FinalResult } from '../components/FinalResult'
import { HomeScreen } from '../components/HomeScreen'
import { OverviewScreen } from '../components/OverviewScreen'
import { QuotaModal } from '../components/QuotaModal'
import { createIdempotencyKey, isAppError, requestCandidates, requestOverview, requestQuota } from '../lib/api'
import { processCandidateImage, processImage, type ProcessedImage } from '../lib/imageProcessing'
import { appReducer, initialAppState } from './appReducer'

export type QuotaLoader = (options: { signal: AbortSignal }) => Promise<{ remaining: number }>

export interface AppProps {
  quotaLoader?: QuotaLoader
  overviewLoader?: (payload: { image: string }, options: { signal: AbortSignal; idempotencyKey: string }) => Promise<OverviewSuccessPayload>
  candidateLoader?: (payload: CandidateFollowUpPayload, options: { signal: AbortSignal; idempotencyKey: string }) => Promise<FinalRankingSuccessPayload>
  overviewImageProcessor?: (file: File) => Promise<ProcessedImage>
  candidateImageProcessor?: (file: File) => Promise<ProcessedImage>
}

export function App({ quotaLoader = requestQuota, overviewLoader = requestOverview, candidateLoader = requestCandidates, overviewImageProcessor = processImage, candidateImageProcessor = processCandidateImage }: AppProps) {
  const [state, dispatch] = useReducer(appReducer, initialAppState)
  const [remaining, setRemaining] = useState<number | null>(null)
  const [quotaLoading, setQuotaLoading] = useState(true)
  const [quotaError, setQuotaError] = useState<string | null>(null)
  const [quotaModalOpen, setQuotaModalOpen] = useState(false)
  const mountedRef = useRef(false)
  const requestSequenceRef = useRef(0)
  const activeControllerRef = useRef<AbortController | null>(null)
  const analysisControllerRef = useRef<AbortController | null>(null)
  const overviewImageRef = useRef<ProcessedImage | null>(null)
  const overviewInputRef = useRef<HTMLInputElement | null>(null)
  const [overviewImage, setOverviewImage] = useState<ProcessedImage | null>(null)
  const [overviewBusy, setOverviewBusy] = useState(false)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const overviewKeyRef = useRef<string | null>(null)
  const analysisSequenceRef = useRef(0)
  const shouldOpenOverviewPickerRef = useRef(false)

  const loadQuota = useCallback(async () => {
    const sequence = ++requestSequenceRef.current
    activeControllerRef.current?.abort()
    const controller = new AbortController()
    activeControllerRef.current = controller
    setQuotaLoading(true)
    setQuotaError(null)
    try {
      const quota = await quotaLoader({ signal: controller.signal })
      if (!mountedRef.current || sequence !== requestSequenceRef.current) return
      setRemaining(quota.remaining)
      setQuotaModalOpen(quota.remaining === 0)
    } catch (error) {
      if (!mountedRef.current || sequence !== requestSequenceRef.current || (error instanceof DOMException && error.name === 'AbortError')) return
      if (isAppError(error) && error.code === 'QUOTA_EXHAUSTED') setQuotaModalOpen(true)
      setQuotaError(isAppError(error) ? error.message : '体验次数暂时无法获取，请稍后重试。')
    } finally {
      if (mountedRef.current && sequence === requestSequenceRef.current) {
        setQuotaLoading(false)
        if (activeControllerRef.current === controller) activeControllerRef.current = null
      }
    }
  }, [quotaLoader])

  useEffect(() => {
    mountedRef.current = true
    void loadQuota()
    return () => {
      mountedRef.current = false
      requestSequenceRef.current += 1
      analysisSequenceRef.current += 1
      activeControllerRef.current?.abort()
      analysisControllerRef.current?.abort()
      overviewImageRef.current?.revoke()
      overviewImageRef.current = null
      activeControllerRef.current = null
      analysisControllerRef.current = null
    }
  }, [loadQuota])

  const canStart = !quotaLoading && remaining !== null && remaining > 0
  const startOverview = () => {
    if (!canStart) return
    shouldOpenOverviewPickerRef.current = true
    dispatch({ type: 'START_OVERVIEW' })
  }
  const closeQuotaModal = useCallback(() => setQuotaModalOpen(false), [])
  const reset = useCallback(() => {
    analysisSequenceRef.current += 1
    analysisControllerRef.current?.abort()
    analysisControllerRef.current = null
    overviewImageRef.current?.revoke()
    overviewImageRef.current = null
    setOverviewImage(null); setOverviewBusy(false); setOverviewError(null); overviewKeyRef.current = null
    if (remaining === 0) setQuotaModalOpen(true)
    dispatch({ type: 'RESET' })
  }, [remaining])
  const runOverview = useCallback(async (file?: File) => {
    if (!file) return
    const sequence = ++analysisSequenceRef.current
    const idempotencyKey = createIdempotencyKey()
    analysisControllerRef.current?.abort()
    analysisControllerRef.current = null
    overviewImageRef.current?.revoke(); overviewImageRef.current = null
    setOverviewImage(null); setOverviewError(null); setOverviewBusy(true); overviewKeyRef.current = idempotencyKey
    try {
      const image = await overviewImageProcessor(file)
      if (!mountedRef.current || sequence !== analysisSequenceRef.current) { image.revoke(); return }
      overviewImageRef.current = image; setOverviewImage(image)
      const controller = new AbortController(); analysisControllerRef.current = controller
      const overview = await overviewLoader({ image: image.dataUrl }, { signal: controller.signal, idempotencyKey })
      if (!mountedRef.current || sequence !== analysisSequenceRef.current) return
      setRemaining(overview.remaining)
      dispatch({ type: 'OVERVIEW_SUCCESS', payload: overview })
    } catch (error) {
      if (!mountedRef.current || sequence !== analysisSequenceRef.current || (error instanceof DOMException && error.name === 'AbortError')) return
      if (isAppError(error) && error.code === 'QUOTA_EXHAUSTED') setQuotaModalOpen(true)
      setOverviewError(isAppError(error) ? error.message : error instanceof Error ? error.message : '图片分析失败，请重试。')
    } finally { if (mountedRef.current && sequence === analysisSequenceRef.current) setOverviewBusy(false) }
  }, [overviewImageProcessor, overviewLoader])
  const retryOverview = useCallback(() => {
    const image = overviewImageRef.current
    if (!image || overviewBusy || !overviewKeyRef.current) return
    const sequence = ++analysisSequenceRef.current; setOverviewBusy(true); setOverviewError(null)
    const controller = new AbortController(); analysisControllerRef.current?.abort(); analysisControllerRef.current = controller
    void overviewLoader({ image: image.dataUrl }, { signal: controller.signal, idempotencyKey: overviewKeyRef.current }).then((overview) => {
      if (!mountedRef.current || sequence !== analysisSequenceRef.current) return; setRemaining(overview.remaining); dispatch({ type: 'OVERVIEW_SUCCESS', payload: overview })
    }).catch((error: unknown) => { if (mountedRef.current && sequence === analysisSequenceRef.current && !(error instanceof DOMException && error.name === 'AbortError')) { if (isAppError(error) && error.code === 'QUOTA_EXHAUSTED') setQuotaModalOpen(true); setOverviewError(isAppError(error) ? error.message : '图片分析失败，请重试。') } }).finally(() => { if (mountedRef.current && sequence === analysisSequenceRef.current) setOverviewBusy(false) })
  }, [overviewBusy, overviewLoader])

  useEffect(() => {
    if (state.screen === 'overview' && shouldOpenOverviewPickerRef.current) {
      shouldOpenOverviewPickerRef.current = false
      overviewInputRef.current?.click()
    }
  }, [state.screen])

  if (state.screen === 'overview') return <main className="app-shell flow-screen"><button className="back-button" type="button" onClick={reset}>返回首页</button><h1>拍照识别</h1><input ref={overviewInputRef} hidden type="file" accept="image/*" capture="environment" onChange={(event) => { void runOverview(event.currentTarget.files?.[0]); event.currentTarget.value = '' }} />
    {overviewImage ? <div className="analysis-image"><img src={overviewImage.previewUrl} alt="用户上传的榴莲合照预览" /></div> : <button className="capture-overview" type="button" onClick={() => overviewInputRef.current?.click()}>拍摄或选择榴莲合照</button>}
    {overviewBusy ? <section className="analysis-wait" aria-live="polite"><span className="loading-ring" aria-hidden="true" /><h2>正在识别可见榴莲…</h2><p>识别榴莲</p><p>自动编号</p><p>筛选候选</p></section> : null}
    {overviewError ? <div className="error-panel" role="alert"><p>{overviewError}</p><button className="secondary-button" type="button" onClick={overviewImage ? retryOverview : () => overviewInputRef.current?.click()}>{overviewImage ? '重试分析' : '重新拍摄'}</button></div> : null}
    {overviewImage && !overviewBusy ? <button className="secondary-button" type="button" onClick={() => overviewInputRef.current?.click()}>重新拍摄</button> : null}<QuotaModal open={quotaModalOpen} onClose={closeQuotaModal} /></main>
  if (state.screen === 'shortlist' && state.overview && overviewImage) return <><OverviewScreen image={overviewImage} overview={state.overview} onRestart={reset} onContinue={(ids) => dispatch({ type: 'SELECT_CANDIDATES', ids })} /><QuotaModal open={quotaModalOpen} onClose={closeQuotaModal} /></>
  if (state.screen === 'capture' && state.overview) return <CandidateWizard selectedIds={state.selectedCandidateIds} taskToken={state.overview.taskToken} imageProcessor={candidateImageProcessor} submit={candidateLoader} onBack={() => dispatch({ type: 'BACK_TO_SHORTLIST' })} onSuccess={(result) => dispatch({ type: 'CANDIDATES_SUCCESS', payload: result })} />
  if (state.screen === 'final' && state.finalResult) return <FinalResult result={state.finalResult} onRestart={reset} />

  return (
    <>
      <HomeScreen
        remaining={remaining}
        quotaLoading={quotaLoading}
        quotaError={quotaError}
        canStart={canStart}
        onStart={startOverview}
        onRetryQuota={() => { void loadQuota() }}
      />
      <QuotaModal open={quotaModalOpen} onClose={closeQuotaModal} />
    </>
  )
}
