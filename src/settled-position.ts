export class SettledPosition {
  private lastSample: string | null = null
  private lastPosition: { x: number; y: number } | null = null
  private count = 0

  get settled(): boolean {
    return this.count >= 3
  }

  reset(): void {
    this.lastSample = null
    this.lastPosition = null
    this.count = 0
  }

  observe(sample: string, x: number, y: number): void {
    if (sample === this.lastSample) return
    this.count = this.lastPosition?.x === x && this.lastPosition.y === y ? Math.min(3, this.count + 1) : 1
    this.lastSample = sample
    this.lastPosition = { x, y }
  }
}
