export type ShapeType = 'circles' | 'polyline' | 'polygon'

export interface Point {
  id: string
  name: string
  x: number
  y: number
  labelOffsetX: number
  labelOffsetY: number
}

export interface CaptureGroup {
  name: string
  type: ShapeType
  points: Point[]
  finished: boolean
  strokeColor: string
  circleDiameterMm: number
  showNumbers: boolean
  showNames: boolean
  labelColor: string
  labelHeightMm: number
  labelOffsetX: number
  labelOffsetY: number
}

export interface Collection extends CaptureGroup {
  coordinateContext?: string
  groups: CaptureGroup[]
}

export function captureGroups(collection: Collection): CaptureGroup[] {
  return [...collection.groups, collection]
}

export function allPoints(collection: Collection): Point[] {
  return captureGroups(collection).flatMap(group => group.points)
}

export function finishCapture(collection: Collection): void {
  const { groups: _groups, coordinateContext: _context, ...group } = collection
  collection.groups.push({ ...group, finished: true, points: group.points.map(point => ({ ...point })) })
  collection.points = []
  collection.finished = true
}
