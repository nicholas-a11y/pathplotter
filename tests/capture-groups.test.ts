import { test } from 'node:test'
import assert from 'node:assert/strict'
import { finishCapture, allPoints, captureGroups, type Collection } from '../src/capture-groups.ts'

function collection(): Collection {
  return { name: '', type: 'circles', points: [{ id: 'p1', name: '', x: 40, y: 20, labelOffsetX: 0, labelOffsetY: 0 }],
    groups: [], finished: false, strokeColor: '#000000', circleDiameterMm: 2, showNumbers: true,
    showNames: false, labelColor: '#ff0000', labelHeightMm: 2, labelOffsetX: 1.5, labelOffsetY: -1.5,
    coordinateContext: 'relay:workspace' }
}

test('Finish saves points and all settings independently from resumed capture', () => {
  const state = collection()
  finishCapture(state)
  assert.equal(state.finished, true)
  assert.equal(state.points.length, 0)
  assert.equal(state.groups.length, 1)
  state.type = 'polygon'
  state.strokeColor = '#0000ff'
  state.labelColor = '#00e000'
  state.circleDiameterMm = 10
  state.finished = false
  state.points.push({ id: 'p2', name: '', x: 10, y: 12, labelOffsetX: 0, labelOffsetY: 0 })
  assert.equal(state.groups[0]!.type, 'circles')
  assert.equal(state.groups[0]!.strokeColor, '#000000')
  assert.equal(state.groups[0]!.labelColor, '#ff0000')
  assert.equal(state.groups[0]!.circleDiameterMm, 2)
  assert.deepEqual(allPoints(state).map(point => point.id), ['p1', 'p2'])
  assert.equal(state.coordinateContext, 'relay:workspace')
})

test('finished points remain editable and groups survive serialization', () => {
  const state = collection()
  finishCapture(state)
  allPoints(state)[0]!.x = 45
  assert.equal(state.groups[0]!.points[0]!.x, 45)
  const restored: Collection = JSON.parse(JSON.stringify(state))
  assert.deepEqual(captureGroups(restored), captureGroups(state))
})
