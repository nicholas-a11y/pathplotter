export interface RelayIdentity {
  baseUrl: string
  relayId: string
  credential: string
}

export interface RelaySnapshot {
  generation: string | number
  sequence: number
  connected: boolean
  position: { x: number; y: number } | null
  context: { revision: string; size: { x: number; y: number } | null } | null
  observationAgeMs: number
  receivedAt: number
}

export interface RelayJob {
  id: string
  status: string
  error?: string
}
export class RelayRequestError extends Error {
  readonly status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

export const MAX_SAMPLE_AGE_MS = 2000
const IDENTITY_KEY = 'pathplotter.relay.v1'
const jobStates = ['queued', 'claimed', 'attempting', 'accepted', 'confirmed', 'failed', 'expired', 'unknown']

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function relayBaseUrl(value: string): string {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Relay URL must be an HTTPS origin (HTTP is allowed only on localhost for development).')
  }
  return url.origin
}

export function parseSnapshot(value: unknown): RelaySnapshot | null {
  if (value === null) return null
  if (!record(value) || !(typeof value.generation === 'string' || finite(value.generation)) ||
      !finite(value.sequence) || !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
      typeof value.connected !== 'boolean' || !finite(value.observationAgeMs) ||
      value.observationAgeMs < 0 || !finite(value.receivedAt)) {
    throw new Error('Invalid relay snapshot.')
  }
  let position: RelaySnapshot['position'] = null
  if (value.position !== null) {
    if (!record(value.position) || !finite(value.position.x) || !finite(value.position.y)) {
      throw new Error('Invalid relay workpiece coordinates.')
    }
    position = { x: value.position.x, y: value.position.y }
  }
  let context: RelaySnapshot['context'] = null
  if (value.context !== null) {
    if (!record(value.context) || typeof value.context.revision !== 'string' || !value.context.revision) {
      throw new Error('Invalid relay workspace context.')
    }
    let size: { x: number; y: number } | null = null
    if (value.context.size !== null) {
      const candidate = value.context.size
      if (!record(candidate) || !finite(candidate.x) || !finite(candidate.y) || candidate.x <= 0 || candidate.y <= 0) {
        throw new Error('Invalid relay workspace dimensions.')
      }
      size = { x: candidate.x, y: candidate.y }
    }
    context = { revision: value.context.revision, size }
  }
  return { generation: value.generation, sequence: value.sequence, connected: value.connected,
    position, context, observationAgeMs: value.observationAgeMs, receivedAt: value.receivedAt }
}

export function parseJob(value: unknown): RelayJob {
  if (!record(value) || typeof value.id !== 'string' || typeof value.status !== 'string' ||
      !jobStates.includes(value.status) || (value.error !== undefined && typeof value.error !== 'string')) {
    throw new Error('Invalid relay import result.')
  }
  return { id: value.id, status: value.status, ...(typeof value.error === 'string' ? { error: value.error } : {}) }
}

export function sampleAge(snapshot: RelaySnapshot, serverTime: number, roundTripMs: number, elapsedMs: number): number {
  return snapshot.observationAgeMs + Math.max(0, serverTime - snapshot.receivedAt) +
    Math.max(0, roundTripMs) + Math.max(0, elapsedMs)
}

export async function relayRequest(baseUrl: string, relayId: string, path: string, body?: unknown,
  credential?: string): Promise<unknown> {
  const response = await fetch(`${relayBaseUrl(baseUrl)}/v1/relays/${encodeURIComponent(relayId)}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  })
  if (!response.ok) {
    let message = `Relay request failed (${response.status}).`
    const payload: unknown = await response.json().catch(() => null)
    if (record(payload) && typeof payload.error === 'string') message = payload.error
    throw new RelayRequestError(message, response.status)
  }
  return response.json()
}

export function saveIdentity(identity: RelayIdentity | null): void {
  if (identity) localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity))
  else localStorage.removeItem(IDENTITY_KEY)
}

export function loadIdentity(): RelayIdentity | null {
  const raw = localStorage.getItem(IDENTITY_KEY)
  if (!raw) return null
  const value: unknown = JSON.parse(raw)
  if (!record(value) || typeof value.baseUrl !== 'string' || typeof value.relayId !== 'string' ||
      typeof value.credential !== 'string' || !value.relayId || !value.credential) {
    throw new Error('Saved relay pairing is invalid. Unlink and pair again.')
  }
  return { baseUrl: relayBaseUrl(value.baseUrl), relayId: value.relayId, credential: value.credential }
}

export function pairingInvitation(hash: string): { baseUrl: string; relayId: string; invitation: string } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  if (!params.has('invite')) return null
  const relayId = params.get('relayId')
  const invitation = params.get('invite')
  if (!relayId || !invitation) throw new Error('Incomplete RAP pairing link.')
  return { baseUrl: relayBaseUrl(params.get('relay') ?? ''), relayId, invitation }
}

export interface BrowserLink {
  baseUrl: string
  relayId: string
  token: string
  kind: 'launch' | 'phone'
}
export function browserLink(hash: string): BrowserLink | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  if (!params.has('launch') && !params.has('invite')) return null
  if (params.has('launch') && params.has('invite')) throw new Error('Ambiguous RAP connection link.')
  const relayId = params.get('relayId'), token = params.get(params.has('launch') ? 'launch' : 'invite')
  if (!relayId || !token) throw new Error('Incomplete RAP connection link.')
  return { baseUrl: relayBaseUrl(params.get('relay') ?? ''), relayId, token, kind: params.has('launch') ? 'launch' : 'phone' }
}

export async function exchangeBrowserLink(link: BrowserLink, existing: RelayIdentity | null,
  message: (text: string) => void, active: () => boolean): Promise<RelayIdentity | null> {
  const request = (path: string, body: unknown) => relayRequest(link.baseUrl, link.relayId, path, body)
  const matching = existing?.baseUrl === link.baseUrl && existing.relayId === link.relayId ? existing : null
  if (link.kind === 'launch') {
    message('Connecting this browser to RAP…')
    const result = await request('/browser/launch', { launchToken: link.token, ...(matching ? { credential: matching.credential } : {}) })
    if (!active()) return null
    if (!record(result) || typeof result.credential !== 'string' || !result.credential) throw new Error('Desktop launch returned no browser authorization.')
    return { baseUrl: link.baseUrl, relayId: link.relayId, credential: result.credential }
  }
  if (matching) {
    try {
      await relayRequest(link.baseUrl, link.relayId, '/snapshot', undefined, matching.credential)
      if (!active()) return null
      message('Using this browser’s saved RAP connection.')
      return matching
    } catch (error) {
      if (!(error instanceof RelayRequestError) || ![401, 403].includes(error.status)) throw error
    }
  }
  message('Requesting phone pairing…')
  const result = await request('/pairing/request', { invitation: link.token })
  if (!active()) return null
  if (!record(result) || typeof result.pairingId !== 'string' || typeof result.pendingToken !== 'string' || typeof result.phrase !== 'string') {
    throw new Error('Invalid pairing response.')
  }
  message(`Compare “${result.phrase}” with RAP, then click Approve on the desktop.`)
  const deadline = performance.now() + 300000
  while (active() && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    if (!active()) return null
    const status = await request('/pairing/status', { pairingId: result.pairingId, pendingToken: result.pendingToken })
    if (!active()) return null
    if (!record(status) || typeof status.status !== 'string') throw new Error('Invalid pairing status.')
    if (status.status === 'approved') {
      if (typeof status.credential !== 'string' || !status.credential) throw new Error('Browser authorization missing.')
      return { baseUrl: link.baseUrl, relayId: link.relayId, credential: status.credential }
    }
    if (status.status !== 'pending') throw new Error(status.status === 'rejected' ? 'RAP declined or expired this pairing. Use Pair phone to try again.' : 'Pairing is no longer available.')
  }
  if (active()) throw new Error('Pairing expired. Use Pair phone in RAP to create a new link.')
  return null
}

export class RelayClient {
  readonly identity: RelayIdentity
  private changed: () => void
  snapshot: RelaySnapshot | null = null
  activeBrowser = false
  controlOccupied = false
  controlError = ''
  error = ''
  private serverTime = 0
  private roundTripMs = 0
  private receivedMonotonic = 0
  private running = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private epoch = 0
  private autoClaimPending = true
  private controlLost = false
  private claimInFlight = false

  constructor(identity: RelayIdentity, changed: () => void) {
    this.identity = identity
    this.changed = changed
  }

  request(path: string, body?: unknown): Promise<unknown> {
    return relayRequest(this.identity.baseUrl, this.identity.relayId, path, body, this.identity.credential)
  }

  age(): number {
    return this.snapshot ? sampleAge(this.snapshot, this.serverTime, this.roundTripMs,
      performance.now() - this.receivedMonotonic) : Infinity
  }

  canCapture(): boolean {
    return this.running && !this.error && this.activeBrowser && this.snapshot?.connected === true &&
      this.snapshot.position !== null && this.snapshot.context !== null && this.age() <= MAX_SAMPLE_AGE_MS
  }
  hasFreshPosition(): boolean {
    return this.running && !this.error && this.snapshot?.connected === true &&
      this.snapshot.position !== null && this.snapshot.context !== null && this.age() <= MAX_SAMPLE_AGE_MS
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.autoClaimPending = !this.controlLost
    const epoch = ++this.epoch
    const poll = async () => {
      if (!this.running || epoch !== this.epoch) return
      const started = performance.now()
      try {
        const value = await this.request('/snapshot')
        if (!this.running || epoch !== this.epoch) return
        if (!record(value) || !finite(value.serverTime) || typeof value.activeBrowser !== 'boolean') {
          throw new Error('Invalid relay response.')
        }
        if (value.controlOccupied !== undefined && typeof value.controlOccupied !== 'boolean') throw new Error('Invalid relay control state.')
        const next = parseSnapshot(value.snapshot)
        if (next && this.snapshot && next.generation === this.snapshot.generation &&
            next.sequence < this.snapshot.sequence) throw new Error('Out-of-order relay snapshot.')
        this.snapshot = next
        this.serverTime = value.serverTime
        this.roundTripMs = performance.now() - started
        this.receivedMonotonic = performance.now()
        if (this.activeBrowser && !value.activeBrowser) {
          this.controlLost = true
          this.autoClaimPending = false
          this.controlError = 'Capture control was released or taken by another browser. Click Take control to continue.'
        }
        this.activeBrowser = value.activeBrowser
        this.controlOccupied = value.controlOccupied === true
        this.error = ''
        if (this.autoClaimPending && this.hasFreshPosition()) {
          this.autoClaimPending = false
          if (!this.activeBrowser && !this.controlOccupied) {
            try { await this.claimControl(false) }
            catch (error) { this.controlError = error instanceof Error ? error.message : String(error) }
          }
        }
        if (!this.running || epoch !== this.epoch) return
      } catch (error) {
        if (!this.running || epoch !== this.epoch) return
        const denied = error instanceof RelayRequestError && [401, 403].includes(error.status)
        this.error = denied ? 'Browser authorization is no longer valid. Open PathPlotter from RAP, or use Pair phone to reconnect.' :
          error instanceof Error ? error.message : String(error)
        if (denied) { this.controlLost = true; this.autoClaimPending = false; this.controlError = this.error }
        this.snapshot = null
        this.activeBrowser = false
        if (!this.controlLost) this.autoClaimPending = true
      }
      this.changed()
      if (this.running && epoch === this.epoch) this.timer = setTimeout(poll, this.error ? 2000 : 500)
    }
    void poll()
  }

  stop(): void {
    this.running = false
    ++this.epoch
    clearTimeout(this.timer)
    this.snapshot = null
    this.activeBrowser = false
  }

  async claimControl(takeover = false): Promise<void> {
    if (this.claimInFlight) throw new Error('A capture control request is already pending.')
    this.claimInFlight = true
    const epoch = this.epoch
    try {
      await this.request('/control', takeover ? { takeover: true } : {})
      if (!this.running || epoch !== this.epoch) return
      this.activeBrowser = true
      this.controlLost = false
      this.controlError = ''
      this.autoClaimPending = false
      this.changed()
    } finally { this.claimInFlight = false }
  }
}
