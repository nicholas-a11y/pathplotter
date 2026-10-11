import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SettledPosition } from '../src/settled-position.ts'

test('three distinct identical readings settle the marker; duplicates do not count', () => {
  const position = new SettledPosition()
  position.observe('1', 40, 20)
  position.observe('1', 40, 20)
  position.observe('1', 40, 20)
  assert.equal(position.settled, false)
  position.observe('2', 40, 20)
  assert.equal(position.settled, false)
  position.observe('3', 40, 20)
  assert.equal(position.settled, true)
})

test('changes to either axis reset stability without rounding away movement', () => {
  const position = new SettledPosition()
  for (const id of ['1', '2', '3']) position.observe(id, 40, 20)
  position.observe('4', 40.0001, 20)
  assert.equal(position.settled, false)
  position.observe('5', 40.0001, 20)
  position.observe('6', 40.0001, 20)
  assert.equal(position.settled, true)
  position.observe('7', 40.0001, 21)
  assert.equal(position.settled, false)
})

test('stale data or a new context requires three new readings', () => {
  const position = new SettledPosition()
  for (const id of ['1', '2', '3']) position.observe(id, 40, 20)
  position.reset()
  assert.equal(position.settled, false)
  position.observe('3', 40, 20)
  position.observe('4', 40, 20)
  assert.equal(position.settled, false)
  position.observe('5', 40, 20)
  assert.equal(position.settled, true)
})
