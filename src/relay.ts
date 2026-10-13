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
export const RELAY_HEARTBEAT_MS = 15000
export const RELAY_HEALTH_MS = 45000
const JOB_WAIT_MS = 5000
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

export function responseTransitMs(elapsedMs: number, waitMs: unknown): number {
  if (!finite(waitMs) || waitMs < 0 || waitMs > 10000 || waitMs > elapsedMs) {
    throw new Error('Invalid relay coordinate wait timing. No point was saved.')
  }
  return elapsedMs - waitMs
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
    if (record(payload) && typeof payload.error === 'string') {
      const pairingErrors: Record<string, string> = {
        browser_replacement_required: 'A browser is already paired. Use RAP to explicitly replace it.',
        browser_changed: 'The paired browser changed. Open a fresh RAP link and confirm replacement again.',
        unresolved_imports: 'Finish pending imports or resolve unknown outcomes in the paired browser before switching.',
      }
      message = pairingErrors[payload.error] ?? payload.error
    }
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
      await relayRequest(link.baseUrl, link.relayId, '/ticket', {}, matching.credential)
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
  // True once the relay has sent its first state message for this connection.
  hasReportedState = false
  private serverTime = 0
  private roundTripMs = 0
  private receivedMonotonic = 0
  private running = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private epoch = 0
  private autoClaimPending = true
  private controlLost = false
  private claimInFlight = false
  private socket: WebSocket | null = null
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private healthMonotonic = -Infinity
  private online = false
  private reconnectDelay = 1000
  private pendingRead: { id: string; epoch: number; started: number; resolve: (snapshot: RelaySnapshot) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null
  settled = false
  previewActive = false
  connectionNotice = ''
  rapUpdateRequired = false
  private observedJob: RelayJob | null = null
  private jobListeners = new Set<() => void>()

  constructor(identity: RelayIdentity, changed: () => void) {
    this.identity = identity
    this.changed = changed
  }

  request(path: string, body?: unknown): Promise<unknown> {
    return relayRequest(this.identity.baseUrl, this.identity.relayId, path, body, this.identity.credential)
  }

  async waitForJob(previous: RelayJob): Promise<RelayJob | null> {
    const changedJob = () => this.observedJob?.id === previous.id &&
      (this.observedJob.status !== previous.status || this.observedJob.error !== previous.error) ? this.observedJob : null
    const current = changedJob()
    if (current) return current
    return new Promise(resolve => {
      const finish = (job: RelayJob | null) => {
        clearTimeout(timer)
        this.jobListeners.delete(listener)
        resolve(job)
      }
      const listener = () => { const job = changedJob(); if (job) finish(job) }
      const timer = setTimeout(() => finish(null), JOB_WAIT_MS)
      this.jobListeners.add(listener)
    })
  }

  age(): number {
    return this.snapshot ? sampleAge(this.snapshot, this.serverTime, this.roundTripMs,
      performance.now() - this.receivedMonotonic) : Infinity
  }

  canCapture(): boolean {
    return this.running && !this.error && this.activeBrowser && this.snapshot?.connected === true &&
      this.snapshot.position !== null && this.snapshot.context !== null && this.isOnline()
  }
  isOnline(): boolean { return this.online && performance.now() - this.healthMonotonic <= RELAY_HEALTH_MS }
  hasFreshPosition(): boolean {
    return this.running && !this.error && this.snapshot?.connected === true &&
      this.snapshot.position !== null && this.snapshot.context !== null && this.age() <= MAX_SAMPLE_AGE_MS
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.autoClaimPending = !this.controlLost
    const epoch = ++this.epoch
    void this.connectSocket(epoch)
  }

  // Restart now with a fresh backoff, instead of waiting out a retry timer that can be 30 s away.
  reconnect(): void {
    this.stop()
    this.reconnectDelay = 1000
    this.error = ''
    this.start()
  }

  stop(): void {
    this.running = false
    ++this.epoch
    clearTimeout(this.timer)
    clearInterval(this.heartbeat)
    const socket = this.socket
    this.socket = null
    socket?.close()
    this.rejectRead(new Error('Connection stopped. Capture was not saved.'))
    this.snapshot = null
    this.activeBrowser = false
    this.hasReportedState = false
    this.online = false
    this.settled = false
    this.previewActive = false
    this.connectionNotice = ''
    this.observedJob = null
    this.claimInFlight = false
  }

  private rejectRead(error: Error): void {
    const pending = this.pendingRead
    if (!pending) return
    this.pendingRead = null
    clearTimeout(pending.timer)
    pending.reject(error)
  }

  private async applyEnvelope(value: unknown, transitMs: number, epoch: number): Promise<void> {
    if (!this.running || epoch !== this.epoch) return
    if (!record(value) || !finite(value.serverTime) || typeof value.activeBrowser !== 'boolean' ||
        typeof value.controlOccupied !== 'boolean' || typeof value.agentOnline !== 'boolean' ||
        value.protocol !== 2) throw new Error('The relay sent an unexpected update. Reload PathPlotter.')
    const next = parseSnapshot(value.snapshot)
    const job = value.job === null ? null : parseJob(value.job)
    if (next && this.snapshot && next.generation === this.snapshot.generation && next.sequence < this.snapshot.sequence) {
      throw new Error('Out-of-order relay snapshot.')
    }
    if (this.activeBrowser && !value.activeBrowser) {
      this.controlLost = true
      this.autoClaimPending = false
      this.controlError = 'Capture control was released or taken by another browser. Click Take control to continue.'
      this.rejectRead(new Error('Capture control changed. Capture was not saved.'))
    }
    this.snapshot = next
    this.serverTime = value.serverTime
    this.roundTripMs = transitMs
    this.receivedMonotonic = performance.now()
    this.healthMonotonic = performance.now()
    this.hasReportedState = true
    this.online = value.agentOnline
    this.settled = value.settled === true
    this.rapUpdateRequired = value.rapUpdateRequired === true
    this.previewActive = value.previewActive === true
    if (this.previewActive) this.connectionNotice = ''
    this.activeBrowser = value.activeBrowser
    this.controlOccupied = value.controlOccupied
    this.observedJob = job
    for (const listener of this.jobListeners) listener()
    this.error = ''
    if (this.autoClaimPending && this.isOnline() && next?.context) {
      this.autoClaimPending = false
      if (!this.activeBrowser && !this.controlOccupied) {
        try { await this.claimControl(false) }
        catch (error) {
          if (this.running && epoch === this.epoch) this.controlError = error instanceof Error ? error.message : String(error)
        }
      }
      if (this.running && epoch === this.epoch) this.changed()
    }
  }

  private async connectSocket(epoch: number): Promise<void> {
    const handshakeStarted = performance.now()
    let transportBound = 0
    try {
      if (typeof WebSocket === 'undefined') throw new Error('This browser does not support WebSockets, which PathPlotter needs to reach RAP.')
      const ticket = await this.request('/ticket', {})
      transportBound = performance.now() - handshakeStarted
      if (!this.running || epoch !== this.epoch) return
      if (!record(ticket) || typeof ticket.ticket !== 'string' || !ticket.ticket) throw new Error('Invalid relay stream ticket.')
      const url = new URL(`${this.identity.baseUrl}/v1/relays/${encodeURIComponent(this.identity.relayId)}/stream`)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('ticket', ticket.ticket)
      const socket = new WebSocket(url)
      this.socket = socket
      let socketHeartbeat: ReturnType<typeof setInterval> | undefined
      let receivedEnvelope = false
      const timeout = setTimeout(() => {
        if (this.socket === socket && !receivedEnvelope) socket.close()
      }, 10000)
      const sendHeartbeat = () => {
        if (!this.running || this.socket !== socket) return
        try {
          socket.send(JSON.stringify({ v: 2, type: 'heartbeat',
            watching: typeof document === 'undefined' || document.visibilityState === 'visible' }))
        } catch (error) {
          this.error = `Relay heartbeat failed: ${error instanceof Error ? error.message : String(error)}`
          this.online = false
          this.changed()
          socket.close()
        }
      }
      socket.onopen = () => {
        if (!this.running || epoch !== this.epoch) { socket.close(); return }
        this.reconnectDelay = 1000
        sendHeartbeat()
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', sendHeartbeat)
        socketHeartbeat = this.heartbeat = setInterval(() => {
          if (!this.running || this.socket !== socket) return
          if (!this.isOnline() && performance.now() - this.healthMonotonic > RELAY_HEALTH_MS) {
            this.online = false
            this.changed()
          }
          sendHeartbeat()
        }, RELAY_HEARTBEAT_MS)
      }
      let chain = Promise.resolve()
      socket.onmessage = event => {
        chain = chain.then(async () => {
          if (!this.running || epoch !== this.epoch || this.socket !== socket) return
          if (typeof event.data !== 'string' || event.data.length > 32768) throw new Error('Invalid or oversized relay event.')
          const value: unknown = JSON.parse(event.data)
          if (record(value) && value.v === 2 && value.type === 'error') {
            if (value.error === 'preview_busy' && value.id === undefined) {
              this.previewActive = false
              this.connectionNotice = 'Moving preview is paused: the service preview limit is busy. Capture still requests a new verified reading.'
              this.changed()
              return
            }
            const error = new Error(typeof value.error === 'string' ? value.error : 'Relay operation failed.')
            if (this.pendingRead && value.id === this.pendingRead.id) { this.rejectRead(error); return }
            throw error
          }
          if (record(value) && value.v === 2 && value.type === 'capture-result') {
            const pending = this.pendingRead
            if (!pending || value.id !== pending.id || pending.epoch !== epoch) return
            if (!record(value.body)) throw new Error('Invalid coordinate response.')
            await this.applyEnvelope(value.body,
              responseTransitMs(performance.now() - pending.started, value.body.waitMs), epoch)
            this.completeRead()
          } else {
            await this.applyEnvelope(value, transportBound, epoch)
          }
          receivedEnvelope = true
          clearTimeout(timeout)
        }).catch(error => {
          if (!this.running || epoch !== this.epoch || this.socket !== socket) return
          this.error = error instanceof Error ? error.message : String(error)
          this.rejectRead(new Error(this.error))
          this.online = false
          this.changed()
          // Browsers only allow 1000 or 3000-4999 from a client; 1008 throws and would leave the socket open forever.
          try { socket.close(4000, 'invalid_event') } catch { /* Already closing. */ }
        })
      }
      socket.onerror = () => {
        if (epoch !== this.epoch) return
        this.error = 'WebSocket connection failed. Check your network connection; PathPlotter will keep retrying.'
        this.changed()
      }
      socket.onclose = (event?: { reason?: string }) => {
        clearTimeout(timeout)
        clearInterval(socketHeartbeat)
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', sendHeartbeat)
        if (!this.running || epoch !== this.epoch || this.socket !== socket) return
        this.socket = null
        this.online = false
        this.snapshot = null
        this.activeBrowser = false
        this.hasReportedState = false
        this.settled = false
        this.previewActive = false
        this.rejectRead(new Error('Connection interrupted. Capture was not saved.'))
        if (event?.reason === 'browser_replaced') {
          // Retrying would just take the connection back from the newer tab and start a tug-of-war.
          this.error = 'PathPlotter was opened in another tab or window, which took over this connection. Click Connection > Reconnect to take it back.'
          this.changed()
          return
        }
        this.error ||= 'Relay disconnected. Reconnecting; uncertain imports will not be resent.'
        this.changed()
        this.timer = setTimeout(() => { void this.connectSocket(epoch) }, this.reconnectDelay + Math.random() * 250)
        this.reconnectDelay = Math.min(30000, this.reconnectDelay * 2)
      }
    } catch (error) {
      if (!this.running || epoch !== this.epoch) return
      this.online = false
      this.error = error instanceof Error ? error.message : String(error)
      this.changed()
      if (!(error instanceof RelayRequestError && [401, 403].includes(error.status))) {
        this.timer = setTimeout(() => { void this.connectSocket(epoch) }, this.reconnectDelay)
        this.reconnectDelay = Math.min(30000, this.reconnectDelay * 2)
      }
    }
  }

  private completeRead(): void {
    const pending = this.pendingRead
    if (!pending) return
    if (!this.hasFreshPosition() || !this.activeBrowser || !this.snapshot) {
      this.rejectRead(new Error('Fresh RAP observation was delayed, unavailable or lost control. Capture was not saved.'))
      return
    }
    this.pendingRead = null
    clearTimeout(pending.timer)
    pending.resolve(this.snapshot)
  }

  async freshPosition(): Promise<RelaySnapshot> {
    if (!this.canCapture()) throw new Error('RAP is offline or this browser has no capture control.')
    if (this.pendingRead) throw new Error('A fresh coordinate request is already pending.')
    const id = crypto.randomUUID(), epoch = this.epoch, started = performance.now()
    const result = new Promise<RelaySnapshot>((resolve, reject) => {
      const timer = setTimeout(() => this.rejectRead(new Error('RAP coordinate request timed out. No point was saved.')), 10000)
      this.pendingRead = { id, epoch, started, resolve, reject, timer }
    })
    void this.request('/capture', { requestId: id }).then(response => {
      if (!record(response) || response.requestId !== id) throw new Error('Invalid fresh-coordinate acknowledgment.')
    }).catch(error => {
      if (this.pendingRead?.id === id) this.rejectRead(error instanceof Error ? error : new Error(String(error)))
    })
    return result
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
    } finally { if (epoch === this.epoch) this.claimInFlight = false }
  }
}
