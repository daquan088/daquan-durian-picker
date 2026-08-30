import type { NumberedFruitAssessment } from '../../shared/contracts'

export interface DurianOverlayProps {
  fruits: readonly NumberedFruitAssessment[]
  width: number
  height: number
  shortlistIds: readonly number[]
}

/** An SVG shares the processed-image pixel viewBox, so portrait photos never shift boxes. */
export function DurianOverlay({ fruits, width, height, shortlistIds }: DurianOverlayProps) {
  return (
    <svg className="durian-overlay" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" aria-label="已识别榴莲编号">
      {fruits.map((fruit) => {
        const [y1, x1, y2, x2] = fruit.box_2d
        const shortlisted = shortlistIds.includes(fruit.id)
        const statusClass = `durian-box--${fruit.status}`
        const shortlistClass = shortlisted ? ' durian-box--shortlist' : ''
        return (
          <g key={fruit.id} data-fruit-id={fruit.id} data-status={fruit.status} className={`durian-overlay-fruit durian-overlay-fruit--${fruit.status}`}>
            <rect
              data-testid={`fruit-box-${fruit.id}`}
              data-status={fruit.status}
              x={x1 * width / 1000}
              y={y1 * height / 1000}
              width={(x2 - x1) * width / 1000}
              height={(y2 - y1) * height / 1000}
              className={`durian-box ${statusClass}${shortlistClass}`}
            />
            <text
              data-testid={`fruit-label-${fruit.id}`}
              data-status={fruit.status}
              x={x1 * width / 1000 + 7}
              y={y1 * height / 1000 + 18}
              className={`durian-box-label durian-box-label--${fruit.status}${shortlisted ? ' durian-box-label--shortlist' : ''}`}
            >{fruit.id}号</text>
          </g>
        )
      })}
    </svg>
  )
}
