import type { NormalizedBoundingBox, NumberedFruit, RawFruit } from './contracts'

const minimumArea = 400
const duplicateIou = 0.72
const rowThreshold = 120
const maximumBoxes = 20

function area([y1, x1, y2, x2]: NormalizedBoundingBox): number {
  return (y2 - y1) * (x2 - x1)
}

function isUsableBox(box: NormalizedBoundingBox): boolean {
  return box.every((coordinate) => Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1000)
    && box[2] > box[0]
    && box[3] > box[1]
    && area(box) >= minimumArea
}

function intersectionOverUnion(first: NormalizedBoundingBox, second: NormalizedBoundingBox): number {
  const y1 = Math.max(first[0], second[0])
  const x1 = Math.max(first[1], second[1])
  const y2 = Math.min(first[2], second[2])
  const x2 = Math.min(first[3], second[3])
  const intersection = Math.max(0, y2 - y1) * Math.max(0, x2 - x1)

  return intersection / Math.max(1, area(first) + area(second) - intersection)
}

function verticalCenter(box: NormalizedBoundingBox): number {
  return (box[0] + box[2]) / 2
}

export function sanitizeAndNumberBoxes(raw: readonly RawFruit[]): NumberedFruit[] {
  const validByDescendingArea = raw
    .filter(({ box_2d }) => isUsableBox(box_2d))
    .sort((left, right) => area(right.box_2d) - area(left.box_2d))

  const kept: RawFruit[] = []
  for (const fruit of validByDescendingArea) {
    if (kept.every((previous) => intersectionOverUnion(fruit.box_2d, previous.box_2d) < duplicateIou)) {
      kept.push(fruit)
    }
  }

  return kept
    .slice(0, maximumBoxes)
    .sort((left, right) => {
      const verticalDifference = verticalCenter(left.box_2d) - verticalCenter(right.box_2d)
      return Math.abs(verticalDifference) > rowThreshold
        ? verticalDifference
        : left.box_2d[1] - right.box_2d[1]
    })
    .map((fruit, index) => ({ ...fruit, id: index + 1 }))
}
