import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDelta, appendCollectionPrimitives, serializeSvg, type Primitive } from '../src/geometry.ts'
import { emptyLiveQueue, makeUpdate, enqueue, recordOutcome, parseLiveQueue } from '../src/live-updates.ts'
import type { CaptureGroup } from '../src/capture-groups.ts'

function group(type: CaptureGroup['type'] = 'polygon'): CaptureGroup {
  return { name: '', type, points: [], finished: false, strokeColor: '#000000', circleDiameterMm: 2,
    showNumbers: false, showNames: false, labelColor: '#ff0000', labelHeightMm: 2, labelOffsetX: 1.5, labelOffsetY: -1.5 }
}
function point(x: number, y: number) {
  return { id: crypto.randomUUID(), name: '', x, y, labelOffsetX: 0, labelOffsetY: 0 }
}
const target = { mode: 'relay' as const, baseUrl: 'https://relay.example', relayId: 'example', contextRevision: 'revision' }

test('live paths send only the next edge and Finish sends only the closing edge', () => {
  const state = group()
  state.points.push(point(10, 20))
  assert.equal(buildDelta(state, 'capture'), null)
  state.points.push(point(30, 20))
  const horizontal = buildDelta(state, 'capture')!
  assert.deepEqual(horizontal.anchor, { x: 20, y: 20 })
  assert.match(horizontal.svg, /d="M 0 0 L 20 0"/)
  assert.match(horizontal.svg, /height="0.001mm"/)
  state.points.push(point(30, 40))
  const vertical = buildDelta(state, 'capture')!
  assert.deepEqual(vertical.anchor, { x: 30, y: 30 })
  assert.match(vertical.svg, /d="M 0 20 L 0 0"/)
  assert.equal((vertical.svg.match(/<path/g) || []).length, 1)
  const closing = buildDelta(state, 'finish')!
  assert.match(closing.svg, /d="M 20 0 L 0 20"/)
  assert.equal((closing.svg.match(/<path/g) || []).length, 1)
  assert.equal(buildDelta({ ...state, type: 'polyline' }, 'finish'), null)
})

test('circles, per-point labels and colours are emitted once without earlier geometry', () => {
  const state = group('circles')
  state.showNumbers = true
  state.points.push(point(10, 20), point(50, 60))
  const delta = buildDelta(state, 'capture')!
  assert.equal((delta.svg.match(/<circle/g) || []).length, 1)
  assert.match(delta.svg, /#000000/)
  assert.match(delta.svg, /#ff0000/)
  assert.equal((delta.svg.match(/<path/g) || []).length, 1) // Glyph 2 has one stroke.
  assert.equal(buildDelta(state, 'finish'), null)
  const path = group('polyline')
  path.points.push(point(5, 8))
  path.showNumbers = true
  assert.equal((buildDelta(path, 'capture')!.svg.match(/<path/g) || []).length, 3)
})

test('coincident points add no phantom edges, but retain requested labels', () => {
  const state = group()
  state.points.push(point(5, 8), point(5, 8))
  assert.equal(buildDelta(state, 'capture'), null)
  state.showNumbers = true
  assert.ok(buildDelta(state, 'capture'))
})

test('full export remains a single closed polygon with labels', () => {
  const state = group()
  state.points.push(point(10, 20), point(30, 20), point(30, 40))
  const primitives: Primitive[] = []
  appendCollectionPrimitives(state, primitives, [])
  assert.equal(primitives.length, 1)
  assert.equal(serializeSvg(primitives)!.svg.includes(' Z"'), true)
})

test('20 pending updates are accepted; 21st is refused without changing the queue', async () => {
  const state = group('circles')
  state.points.push(point(10, 20))
  const queue = emptyLiveQueue()
  for (let i = 0; i < 20; i++) enqueue(queue, await makeUpdate(buildDelta(state, 'capture')!, target))
  const twentyFirst = await makeUpdate(buildDelta(state, 'capture')!, target)
  assert.throws(() => enqueue(queue, twentyFirst), /full/)
  assert.equal(queue.items.length, 20)
  assert.deepEqual(parseLiveQueue(JSON.parse(JSON.stringify(queue))), queue)
  const first = queue.items[0]!
  recordOutcome(queue, first.id, 'confirmed')
  assert.equal(queue.items.length, 19)
  assert.equal(queue.confirmed, 1)
  enqueue(queue, twentyFirst)
  assert.equal(queue.items.length, 20)
})

test('queued geometry is frozen and unknown results pause without dropping or resending the head', async () => {
  const state = group('circles')
  state.points.push(point(10, 20))
  const queue = emptyLiveQueue()
  const built = buildDelta(state, 'capture')!
  const update = await makeUpdate(built, target)
  enqueue(queue, update)
  built.svg = 'edited'
  update.target.baseUrl = 'https://other.example'
  assert.notEqual(queue.items[0]!.svg, 'edited')
  assert.equal(queue.items[0]!.target.baseUrl, target.baseUrl)
  recordOutcome(queue, update.id, 'unknown', 'Inspect LightBurn')
  assert.equal(queue.items[0]!.phase, 'unknown')
  assert.equal(queue.paused, 'Inspect LightBurn')
  assert.throws(() => enqueue(queue, update), /paused/)
  assert.throws(() => recordOutcome(queue, crypto.randomUUID(), 'confirmed'), /head/)
})

test('invalid journals, oversized SVG and unsupported labels fail explicitly', async () => {
  assert.throws(() => parseLiveQueue({ items: [], paused: '', confirmed: -1 }), /Invalid/)
  const state = group('circles')
  state.points.push({ ...point(10, 20), name: '🙂' })
  state.showNames = true
  await assert.rejects(makeUpdate(buildDelta(state, 'capture')!, target), /unsupported/)
  await assert.rejects(makeUpdate({ svg: 'x'.repeat(512 * 1024 + 1), anchor: { x: 0, y: 0 }, unsupportedCharacters: [] }, target), /512/)
})
