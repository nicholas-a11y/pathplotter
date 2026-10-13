import { test } from 'node:test'
import assert from 'node:assert/strict'
import { layerPalette, isLayerColor, nearestLayerColor } from '../src/layer-palette.ts'

test('all LightBurn palette entries retain their exact RGB values and order', () => {
  assert.deepEqual(layerPalette.map(entry => entry.color), [
    '#000000', '#0000ff', '#ff0000', '#00e000', '#d0d000', '#ff8000', '#00e0e0', '#ff00ff',
    '#b4b4b4', '#0000a0', '#a00000', '#00a000', '#a0a000', '#c08000', '#00a0ff', '#a000a0',
    '#808080', '#7d87b9', '#bb7784', '#4a6fe3', '#d33f6a', '#8cd78c', '#f0b98d', '#f6c4e1',
    '#fa9ed4', '#500a78', '#b45a00', '#004754', '#86fa88', '#ffdb66', '#f36926', '#0c96d9',
  ])
  assert.deepEqual(layerPalette.map(entry => entry.label), [
    ...Array.from({ length: 30 }, (_, index) => String(index).padStart(2, '0')), 'T1', 'T2',
  ])
  assert.equal(isLayerColor('#FF0000'), true)
  assert.equal(isLayerColor('#2e7dd7'), false)
})

test('custom colours snap to the nearest LightBurn palette colour', () => {
  assert.equal(nearestLayerColor('#2e7dd7'), '#4a6fe3')
  assert.equal(nearestLayerColor('#c0392b'), '#b45a00')
  assert.equal(nearestLayerColor('#FF0000'), '#ff0000')
  assert.equal(isLayerColor(nearestLayerColor('#123456')), true)
})