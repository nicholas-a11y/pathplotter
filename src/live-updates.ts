import type { BuiltSvg } from './geometry'

export const LIVE_QUEUE_LIMIT = 20
export type ImportOutcome = 'confirmed' | 'failed' | 'expired' | 'unknown'
export interface ImportTarget {
  mode: 'local' | 'relay'
  baseUrl: string
  relayId?: string
  contextRevision: string
}
export interface LiveUpdate extends BuiltSvg {
  id: string
  checksum: string
  target: ImportTarget
  phase: 'queued' | 'submitted' | ImportOutcome
}
export interface LiveQueue {
  items: LiveUpdate[]
  paused: string
  confirmed: number
}

export function emptyLiveQueue(): LiveQueue { return { items: [], paused: '', confirmed: 0 } }

export async function makeUpdate(built: BuiltSvg, target: ImportTarget): Promise<LiveUpdate> {
  if (built.unsupportedCharacters.length) throw new Error('Live update labels contain unsupported characters. Change the label settings before capturing.')
  const bytes = new TextEncoder().encode(built.svg)
  if (bytes.byteLength > 512 * 1024) throw new Error('Live update exceeds the 512 KiB SVG limit.')
  const checksum = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(value => value.toString(16).padStart(2, '0')).join('')
  return { ...structuredClone(built), target: { ...target }, id: crypto.randomUUID(), checksum, phase: 'queued' }
}

export function enqueue(queue: LiveQueue, update: LiveUpdate): void {
  if (queue.paused) throw new Error(`Live update paused: ${queue.paused}`)
  if (queue.items.length >= LIVE_QUEUE_LIMIT) throw new Error('Live update queue is full (20). Wait for imports before capturing or finishing.')
  if (queue.items.some(item => item.id === update.id)) throw new Error('Duplicate live update ID.')
  queue.items.push(structuredClone(update))
}

export function recordOutcome(queue: LiveQueue, id: string, outcome: ImportOutcome, error = ''): void {
  const item = queue.items[0]
  if (!item || item.id !== id) throw new Error('Live update outcome does not match the queue head.')
  if (outcome === 'confirmed') {
    queue.items.shift()
    queue.confirmed++
  } else {
    item.phase = outcome
    queue.paused = error || `Import ${outcome}. Inspect LightBurn and reconcile before continuing.`
  }
}

export function parseLiveQueue(value: unknown): LiveQueue {
  const invalid = (): never => { throw new Error('Invalid live update journal. Inspect LightBurn before replacing this saved session.') }
  if (!record(value) || !Array.isArray(value.items) || value.items.length > LIVE_QUEUE_LIMIT ||
      typeof value.paused !== 'string' || !Number.isSafeInteger(value.confirmed) || Number(value.confirmed) < 0) return invalid()
  const ids = new Set<string>()
  const items = value.items.map((item: unknown): LiveUpdate => {
    if (!record(item) || typeof item.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(item.id) || ids.has(item.id) ||
        typeof item.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(item.checksum) ||
        typeof item.svg !== 'string' || !item.svg.startsWith('<?xml') || new TextEncoder().encode(item.svg).length > 512 * 1024 ||
        !Array.isArray(item.unsupportedCharacters) || item.unsupportedCharacters.length ||
        !record(item.anchor) || !finite(item.anchor.x) || !finite(item.anchor.y) ||
        !record(item.target) || !['local', 'relay'].includes(String(item.target.mode)) ||
        typeof item.target.baseUrl !== 'string' || typeof item.target.contextRevision !== 'string' || !item.target.contextRevision ||
        (item.target.mode === 'relay' && (typeof item.target.relayId !== 'string' || !item.target.relayId)) ||
        !['queued', 'submitted', 'confirmed', 'failed', 'expired', 'unknown'].includes(String(item.phase))) return invalid()
    const url = new URL(item.target.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return invalid()
    ids.add(item.id)
    return {
      id: item.id, checksum: item.checksum, svg: item.svg, unsupportedCharacters: [],
      anchor: { x: item.anchor.x, y: item.anchor.y },
      phase: item.phase as LiveUpdate['phase'],
      target: { mode: item.target.mode as ImportTarget['mode'], baseUrl: item.target.baseUrl,
        contextRevision: item.target.contextRevision, ...(typeof item.target.relayId === 'string' ? { relayId: item.target.relayId } : {}) },
    }
  })
  if (items.slice(1).some(item => item.phase !== 'queued')) return invalid()
  return { items, paused: value.paused, confirmed: Number(value.confirmed) }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) }
