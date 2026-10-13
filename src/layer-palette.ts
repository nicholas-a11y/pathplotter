const colors: Array<[string, number, number, number]> = [
  ['00', 0, 0, 0], ['01', 0, 0, 255], ['02', 255, 0, 0], ['03', 0, 224, 0],
  ['04', 208, 208, 0], ['05', 255, 128, 0], ['06', 0, 224, 224], ['07', 255, 0, 255],
  ['08', 180, 180, 180], ['09', 0, 0, 160], ['10', 160, 0, 0], ['11', 0, 160, 0],
  ['12', 160, 160, 0], ['13', 192, 128, 0], ['14', 0, 160, 255], ['15', 160, 0, 160],
  ['16', 128, 128, 128], ['17', 125, 135, 185], ['18', 187, 119, 132], ['19', 74, 111, 227],
  ['20', 211, 63, 106], ['21', 140, 215, 140], ['22', 240, 185, 141], ['23', 246, 196, 225],
  ['24', 250, 158, 212], ['25', 80, 10, 120], ['26', 180, 90, 0], ['27', 0, 71, 84],
  ['28', 134, 250, 136], ['29', 255, 219, 102], ['T1', 243, 105, 38], ['T2', 12, 150, 217],
]

export const layerPalette = colors.map(([label, r, g, b]) => {
  const [red, green, blue] = [r, g, b].map(value => {
    const channel = value / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!
  return {
    label,
    color: '#' + [r, g, b].map(value => value.toString(16).padStart(2, '0')).join(''),
    textColor: luminance > 0.179 ? '#000000' : '#ffffff',
  }
})

export function isLayerColor(color: string): boolean {
  return layerPalette.some(entry => entry.color === color.toLowerCase())
}

export function nearestLayerColor(color: string): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color)
  if (!match) return layerPalette[0]!.color
  const [r, g, b] = [match[1]!, match[2]!, match[3]!].map(hex => parseInt(hex, 16)) as [number, number, number]
  let best = layerPalette[0]!
  let bestDistance = Infinity
  for (const entry of layerPalette) {
    const distance = (parseInt(entry.color.slice(1, 3), 16) - r) ** 2 + (parseInt(entry.color.slice(3, 5), 16) - g) ** 2 + (parseInt(entry.color.slice(5, 7), 16) - b) ** 2
    if (distance < bestDistance) { best = entry; bestDistance = distance }
  }
  return best.color
}