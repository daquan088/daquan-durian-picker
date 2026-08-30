import type { FinalRankingSuccessPayload } from '../../shared/contracts'
export const FINAL_DISCLAIMER = '本工具仅根据照片中可见的外观特征提供初筛建议，不能保证榴莲的甜度、肉量，也不能排除生包、死包或内部变质。最终选择请结合门店专业人员判断。'
export function FinalResult({ result, onRestart, onShare }: { result: FinalRankingSuccessPayload; onRestart: () => void; onShare?: () => void }) {
  return <main className="app-shell flow-screen"><h1>外观初筛建议</h1>
    {result.result.ranking.slice().sort((a, b) => a.rank - b.rank).map((item) => <article className="final-card" key={item.candidate_id}><h2>{item.rank === 1 ? '第一推荐' : `备选 ${item.rank - 1}`} · {item.candidate_id}号</h2><p className="score">外观推荐指数 <strong>{item.appearance_score}</strong></p><p><b>可见证据：</b>{item.evidence.join('；')}</p>{item.risks.length ? <p className="risk-text"><b>风险提示：</b>{item.risks.join('；')}</p> : null}<p className="secondary-copy">证据充分度：{item.evidence_strength === 'high' ? '充分' : item.evidence_strength === 'medium' ? '一般' : '有限'}</p></article>)}
    <section className="summary-card"><p>{result.result.summary}</p><p className="secondary-copy">{result.result.limitations.join('；')}</p><p className="relative-note">外观推荐指数仅表示同批候选的可见外观相对排序，不是甜度、成熟度或内部品质概率。</p><p className="risk-text final-disclaimer">{FINAL_DISCLAIMER}</p></section>
    <button type="button" className="primary-button" onClick={onShare} disabled={!onShare} title={onShare ? undefined : '演示版暂未开放保存或分享'}>保存或分享结果</button><button type="button" className="secondary-button" onClick={onRestart}>重新开始</button>
  </main>
}
