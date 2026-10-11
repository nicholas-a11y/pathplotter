import type { CaptureGroup, Point } from './capture-groups'

export type Primitive =
  | { kind: 'polyline'; points: Array<{ x: number; y: number }>; color: string; close: boolean }
  | { kind: 'circle'; cx: number; cy: number; r: number; color: string }

export interface BuiltSvg {
  svg: string
  anchor: { x: number; y: number }
  unsupportedCharacters: string[]
}

const glyphStrokes: Record<string, string[]> = {
  A: ['0,1 0.5,0 1,1', '0.2,0.6 0.8,0.6'],
  B: ['0,0 0,1', '0,0 0.65,0 0.8,0.15 0.8,0.35 0.65,0.5 0,0.5', '0,0.5 0.65,0.5 0.8,0.65 0.8,0.85 0.65,1 0,1'],
  C: ['1,0.1 0.8,0 0.2,0 0,0.2 0,0.8 0.2,1 0.8,1 1,0.9'],
  D: ['0,0 0,1', '0,0 0.7,0 1,0.3 1,0.7 0.7,1 0,1'],
  E: ['1,0 0,0 0,1 1,1', '0,0.5 0.7,0.5'],
  F: ['0,0 0,1', '0,0 1,0', '0,0.5 0.7,0.5'],
  G: ['1,0.2 0.8,0 0.2,0 0,0.2 0,0.8 0.2,1 0.8,1 1,0.8 1,0.6 0.6,0.6'],
  H: ['0,0 0,1', '1,0 1,1', '0,0.5 1,0.5'],
  I: ['0,0 1,0', '0.5,0 0.5,1', '0,1 1,1'],
  J: ['1,0 1,0.8 0.8,1 0.3,1 0,0.7'],
  K: ['0,0 0,1', '1,0 0,0.5 1,1'],
  L: ['0,0 0,1 1,1'],
  M: ['0,1 0,0 0.5,0.6 1,0 1,1'],
  N: ['0,1 0,0 1,1 1,0'],
  O: ['0.2,0 0.8,0 1,0.2 1,0.8 0.8,1 0.2,1 0,0.8 0,0.2 0.2,0'],
  P: ['0,1 0,0 0.7,0 1,0.25 1,0.45 0.7,0.65 0,0.65'],
  Q: ['0.2,0 0.8,0 1,0.2 1,0.8 0.8,1 0.2,1 0,0.8 0,0.2 0.2,0', '0.6,0.75 1,1'],
  R: ['0,1 0,0 0.7,0 1,0.25 1,0.45 0.7,0.65 0,0.65', '0.45,0.65 1,1'],
  S: ['1,0.15 0.8,0 0.2,0 0,0.2 0.2,0.45 0.8,0.55 1,0.8 0.8,1 0.2,1 0,0.85'],
  T: ['0,0 1,0', '0.5,0 0.5,1'],
  U: ['0,0 0,0.8 0.2,1 0.8,1 1,0.8 1,0'],
  V: ['0,0 0.5,1 1,0'],
  W: ['0,0 0.25,1 0.5,0.4 0.75,1 1,0'],
  X: ['0,0 1,1', '1,0 0,1'],
  Y: ['0,0 0.5,0.5 1,0', '0.5,0.5 0.5,1'],
  Z: ['0,0 1,0 0,1 1,1'],
  0: ['0.2,0 0.8,0 1,0.2 1,0.8 0.8,1 0.2,1 0,0.8 0,0.2 0.2,0'],
  1: ['0.5,0 0.5,1', '0.25,0.2 0.5,0', '0.25,1 0.75,1'],
  2: ['0,0.2 0.2,0 0.8,0 1,0.2 1,0.4 0,1 1,1'],
  3: ['0,0.1 0.25,0 0.8,0 1,0.2 0.75,0.5 1,0.8 0.8,1 0.25,1 0,0.9'],
  4: ['0.85,0 0.85,1', '0,0.65 1,0.65', '0,0.65 0.7,0'],
  5: ['1,0 0.2,0 0,0.45 0.75,0.45 1,0.65 0.8,1 0.2,1 0,0.85'],
  6: ['1,0.2 0.8,0 0.2,0 0,0.2 0,0.8 0.2,1 0.8,1 1,0.8 0.8,0.55 0,0.55'],
  7: ['0,0 1,0 0.25,1'],
  8: ['0.2,0 0.8,0 1,0.2 0.8,0.5 0.2,0.5 0,0.2 0.2,0', '0.2,0.5 0.8,0.5 1,0.8 0.8,1 0.2,1 0,0.8 0.2,0.5'],
  9: ['1,0.2 0.8,0 0.2,0 0,0.2 0,0.4 0.2,0.6 0.8,0.6 1,0.4 1,0.2', '1,0.4 1,0.8 0.8,1 0.2,1 0,0.8'],
  '-': ['0.1,0.5 0.9,0.5'],
  '_': ['0,1 1,1'],
  '.': ['0.45,1 0.55,1'],
  ':': ['0.45,0.25 0.55,0.25', '0.45,0.8 0.55,0.8'],
  '/': ['0,1 1,0'],
  ' ': [],
}

export function hasEnoughPoints(group: CaptureGroup): boolean {
  return group.points.length >= (group.type === 'circles' ? 1 : group.type === 'polyline' ? 2 : 3)
}

function appendLabel(group: CaptureGroup, point: Point, index: number, primitives: Primitive[], unsupported: string[]): void {
  const label = [group.showNumbers ? String(index + 1) : '', group.showNames ? point.name.trim() : '']
    .filter(Boolean).join(':')
  let cursor = point.x + group.labelOffsetX + point.labelOffsetX
  const y = point.y + group.labelOffsetY + point.labelOffsetY
  const scale = Math.max(0.2, group.labelHeightMm)
  for (const character of label.toUpperCase()) {
    const strokes = glyphStrokes[character]
    if (!strokes) unsupported.push(character)
    else for (const stroke of strokes) {
      const points = stroke.split(' ').map(token => {
        const [sx, sy] = token.split(',').map(Number)
        return { x: cursor + sx! * scale, y: y - sy! * scale }
      })
      primitives.push({ kind: 'polyline', points, close: false, color: group.labelColor })
    }
    cursor += scale * 1.25
  }
}

function circle(group: CaptureGroup, point: Point): Primitive {
  return { kind: 'circle', cx: point.x, cy: point.y, r: Math.max(0.01, group.circleDiameterMm / 2), color: group.strokeColor }
}

export function appendCollectionPrimitives(group: CaptureGroup, primitives: Primitive[], unsupported: string[]): void {
  if (hasEnoughPoints(group)) {
    if (group.type === 'circles') primitives.push(...group.points.map(point => circle(group, point)))
    else primitives.push({ kind: 'polyline', points: group.points.map(({ x, y }) => ({ x, y })),
      close: group.type === 'polygon', color: group.strokeColor })
  }
  group.points.forEach((point, index) => appendLabel(group, point, index, primitives, unsupported))
}

export function buildDelta(group: CaptureGroup, action: 'capture' | 'finish'): BuiltSvg | null {
  const primitives: Primitive[] = []
  const unsupported: string[] = []
  const last = group.points.at(-1)
  if (!last) return null
  if (action === 'finish' && (group.type !== 'polygon' || !hasEnoughPoints(group))) return null
  const previous = action === 'finish' ? group.points[0] : group.points.at(-2)
  if (action === 'capture' && group.type === 'circles') primitives.push(circle(group, last))
  else if (previous && (previous.x !== last.x || previous.y !== last.y)) {
    const points = action === 'finish' ? [last, previous] : [previous, last]
    primitives.push({ kind: 'polyline', points: points.map(({ x, y }) => ({ x, y })),
      close: false, color: group.strokeColor })
  }
  if (action === 'capture') appendLabel(group, last, group.points.length - 1, primitives, unsupported)
  return serializeSvg(primitives, unsupported)
}

export function primitiveBounds(primitives: Primitive[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const primitive of primitives) {
    if (primitive.kind === 'circle') {
      minX = Math.min(minX, primitive.cx - primitive.r); minY = Math.min(minY, primitive.cy - primitive.r)
      maxX = Math.max(maxX, primitive.cx + primitive.r); maxY = Math.max(maxY, primitive.cy + primitive.r)
    } else for (const point of primitive.points) {
      minX = Math.min(minX, point.x); minY = Math.min(minY, point.y)
      maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y)
    }
  }
  return { minX, minY, maxX, maxY }
}

export function fmt(value: number): string { return Number(value.toFixed(6)).toString() }
function color(value: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error('Invalid SVG stroke colour.')
  return value
}

export function serializeSvg(primitives: Primitive[], unsupportedCharacters: string[] = []): BuiltSvg | null {
  if (!primitives.length) return null
  const bounds = primitiveBounds(primitives)
  if (!Object.values(bounds).every(Number.isFinite)) throw new Error('SVG geometry must have finite bounds.')
  const width = Math.max(0.001, bounds.maxX - bounds.minX), height = Math.max(0.001, bounds.maxY - bounds.minY)
  const anchor = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
  const body = primitives.map(primitive => {
    const stroke = `fill="none" stroke="${color(primitive.color)}" stroke-width="0.2"`
    if (primitive.kind === 'circle') {
      return `<circle cx="${fmt(primitive.cx - bounds.minX)}" cy="${fmt(bounds.maxY - primitive.cy)}" r="${fmt(primitive.r)}" ${stroke} />`
    }
    const path = primitive.points.map((point, index) =>
      `${index === 0 ? 'M' : 'L'} ${fmt(point.x - bounds.minX)} ${fmt(bounds.maxY - point.y)}`).join(' ')
    return `<path d="${path}${primitive.close ? ' Z' : ''}" ${stroke} />`
  }).join('\n')
  return { svg: `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}mm" height="${fmt(height)}mm" viewBox="0 0 ${fmt(width)} ${fmt(height)}">\n${body}\n</svg>`, anchor, unsupportedCharacters }
}
