import type { NormalizedBoundingBox, NumberedFruit, RawFruit } from './contracts'

const minimumArea = 400
const duplicateIou = 0.72
const rowThreshold = 120
const maximumBoxes = 20
const statusOrder: Record<RawFruit['status'], number> = {
  preferred: 0,
  normal: 1,
  risky: 2,
  insufficient: 3,
}

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

function compareCoordinates(left: NormalizedBoundingBox, right: NormalizedBoundingBox): number {
  return left[0] - right[0]
    || left[1] - right[1]
    || left[2] - right[2]
    || left[3] - right[3]
}

function compareStatus(left: RawFruit, right: RawFruit): number {
  return statusOrder[left.status] - statusOrder[right.status]
}

function compareForDuplicateSuppression(left: RawFruit, right: RawFruit): number {
  return area(right.box_2d) - area(left.box_2d)
    || compareCoordinates(left.box_2d, right.box_2d)
    || compareStatus(left, right)
}

function compareVertically(left: RawFruit, right: RawFruit): number {
  return verticalCenter(left.box_2d) - verticalCenter(right.box_2d)
    || compareCoordinates(left.box_2d, right.box_2d)
    || compareStatus(left, right)
}

function compareWithinRow(left: RawFruit, right: RawFruit): number {
  return left.box_2d[1] - right.box_2d[1]
    || compareCoordinates(left.box_2d, right.box_2d)
    || compareStatus(left, right)
}

function groupIntoRows(fruits: readonly RawFruit[]): RawFruit[][] {
  const rows: RawFruit[][] = []
  let rowAnchor: number | undefined

  for (const fruit of fruits.slice().sort(compareVertically)) {
    const center = verticalCenter(fruit.box_2d)
    if (rowAnchor === undefined || center - rowAnchor > rowThreshold) {
      rows.push([fruit])
      rowAnchor = center
    } else {
      rows.at(-1)!.push(fruit)
    }
  }

  return rows
}

export function sanitizeAndNumberBoxes(raw: readonly RawFruit[]): NumberedFruit[] {
  const validByDescendingArea = raw
    .filter(({ box_2d }) => isUsableBox(box_2d))
    .sort(compareForDuplicateSuppression)

  const kept: RawFruit[] = []
  for (const fruit of validByDescendingArea) {
    if (kept.every((previous) => intersectionOverUnion(fruit.box_2d, previous.box_2d) < duplicateIou)) {
      kept.push(fruit)
    }
  }

  return groupIntoRows(kept
    .slice(0, maximumBoxes)
  )
    .flatMap((row) => row.sort(compareWithinRow))
    .map((fruit, index) => ({ ...fruit, id: index + 1 }))
}
