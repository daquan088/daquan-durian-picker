import { useMemo, useState } from 'react'
import type { OverviewSuccessPayload } from '../../shared/contracts'
import type { ProcessedImage } from '../lib/imageProcessing'
import { DurianOverlay } from './DurianOverlay'

export interface OverviewScreenProps {
  image: ProcessedImage
  overview: OverviewSuccessPayload
  onContinue: (ids: readonly number[]) => void
  onRestart: () => void
}

const strength: Record<string, string> = { high: '充分', medium: '一般', low: '有限' }
const status: Record<string, string> = { preferred: '优先候选', normal: '可补拍', risky: '谨慎考虑', insufficient: '证据不足' }

export function OverviewScreen({ image, overview, onContinue, onRestart }: OverviewScreenProps) {
  const [selected, setSelected] = useState<number[]>(() => overview.shortlist_ids.slice(0, 1))
  const [selectionMessage, setSelectionMessage] = useState('')
  const shortlist = useMemo(() => overview.shortlist_ids
    .map((id) => overview.fruits.find((fruit) => fruit.id === id))
    .filter((fruit): fruit is NonNullable<typeof fruit> => fruit !== undefined), [overview])
  const toggle = (id: number) => {
    if (selected.includes(id)) { setSelected(selected.filter((item) => item !== id)); setSelectionMessage(''); return }
    if (selected.length >= 1) { setSelectionMessage('演示版每次精拍 1 颗候选榴莲。'); return }
    setSelected([...selected, id]); setSelectionMessage('')
  }
  return <main className="app-shell flow-screen">
    <button type="button" className="back-button" onClick={onRestart}>重新拍照</button>
    <h1>初筛编号结果</h1>
    <div className="analysis-image analysis-image--result">
      <img src={image.previewUrl} alt="用户上传的榴莲合照" />
      <DurianOverlay fruits={overview.fruits} width={image.width} height={image.height} shortlistIds={overview.shortlist_ids} />
    </div>
    <p className="result-count">识别到 {overview.fruits.length} 颗；未识别或遮挡严重的榴莲不参与推荐</p>
    {overview.warnings.length ? <div className="notice-card" role="status">{overview.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div> : null}
    <section aria-labelledby="shortlist-title"><h2 id="shortlist-title">优先补拍候选</h2>
      <p className="secondary-copy">演示版选择 1 颗，补拍果柄、侧面和果刺、底部果瓣线。</p>
      <div className="shortlist-list">
        {shortlist.map((fruit) => <label className={`candidate-card candidate-card--${fruit.status}`} key={fruit.id}>
          <input type="checkbox" checked={selected.includes(fruit.id)} disabled={fruit.status === 'insufficient'} onChange={() => toggle(fruit.id)} />
          <span className="candidate-card__content"><span className="candidate-card__heading"><strong>{fruit.id}号</strong><em>{status[fruit.status]}</em></span>
            <span><b>可见证据：</b>{fruit.evidence.join('；') || '未获得足够可见证据'}</span>
            {fruit.risks.length ? <span className="risk-text"><b>风险提示：</b>{fruit.risks.join('；')}</span> : null}
            <span className="secondary-copy">证据充分度：{strength[fruit.evidence_strength]}</span>
          </span>
        </label>)}
      </div>
      <p className="selection-message" aria-live="polite">{selectionMessage}</p>
      <button className="primary-button" type="button" disabled={selected.length === 0} onClick={() => onContinue(selected)}>选择候选继续补拍</button>
    </section>
  </main>
}
