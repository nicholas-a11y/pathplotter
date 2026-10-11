import type { ImportTarget } from './live-updates'

export const HANDOVER_TIMEOUT_MS = 45_000
export interface LiveHandoverState {
  enabled: boolean
  target: ImportTarget | null
}
export interface HandoverChannel {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  close(): void
}

function parseState(value: unknown): LiveHandoverState {
  if (!record(value) || typeof value.enabled !== 'boolean') throw new Error('Invalid live ownership response.')
  const target = value.target
  if (target === null && !value.enabled) return { enabled: false, target: null }
  if (!record(target) || !['local', 'relay'].includes(String(target.mode)) ||
      typeof target.baseUrl !== 'string' || typeof target.contextRevision !== 'string' || !target.contextRevision ||
      (target.mode === 'relay' && (typeof target.relayId !== 'string' || !target.relayId))) {
    throw new Error('Invalid live ownership destination.')
  }
  const url = new URL(target.baseUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new Error('Invalid live ownership destination.')
  }
  return { enabled: value.enabled, target: { mode: target.mode as ImportTarget['mode'],
    baseUrl: target.baseUrl, contextRevision: target.contextRevision,
    ...(typeof target.relayId === 'string' ? { relayId: target.relayId } : {}) } }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export class LiveHandover {
  private channel: HandoverChannel
  private tabId: string
  private relinquish: () => Promise<LiveHandoverState | null>
  private owns: () => boolean
  private outgoing = false
  private pending: { id: string; resolve: (state: LiveHandoverState) => void; reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> } | null = null
  private closed = false

  constructor(channel: HandoverChannel, tabId: string, owns: () => boolean,
    relinquish: () => Promise<LiveHandoverState | null>) {
    this.channel = channel
    this.tabId = tabId
    this.relinquish = relinquish
    this.owns = owns
    channel.addEventListener('message', this.receive)
  }

  request(timeoutMs = HANDOVER_TIMEOUT_MS): Promise<LiveHandoverState> {
    if (this.closed) return Promise.reject(new Error('Live ownership channel is closed.'))
    if (this.pending) return Promise.reject(new Error('Live ownership transfer is already pending.'))
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID()
      const timer = setTimeout(() => {
        this.pending = null
        reject(new Error('The other tab did not release Live update. Close it, inspect LightBurn, then try again; no import has been resent.'))
      }, timeoutMs)
      this.pending = { id, resolve, reject, timer }
      try { this.channel.postMessage({ type: 'request', id, sender: this.tabId }) }
      catch (error) { this.finish(undefined, error instanceof Error ? error : new Error(String(error))) }
    })
  }

  private receive = (event: MessageEvent): void => {
    const message: unknown = event.data
    if (this.closed || !record(message) || typeof message.id !== 'string' || typeof message.sender !== 'string' ||
        message.sender === this.tabId) return
    if (message.type === 'request') {
      if (!this.owns()) return
      if (this.outgoing) {
        this.channel.postMessage({ type: 'reply', id: message.id, sender: this.tabId, to: message.sender,
          error: 'Another tab is already taking ownership. Wait for it to finish.' })
        return
      }
      this.outgoing = true
      void this.relinquish().then(state => {
        if (state && !this.closed) this.channel.postMessage({ type: 'reply', id: message.id,
          sender: this.tabId, to: message.sender, state })
      }).catch(error => {
        if (!this.closed) this.channel.postMessage({ type: 'reply', id: message.id,
          sender: this.tabId, to: message.sender, error: error instanceof Error ? error.message : String(error) })
      }).finally(() => { this.outgoing = false })
    } else if (message.type === 'reply' && message.to === this.tabId && message.id === this.pending?.id) {
      try {
        if (typeof message.error === 'string') throw new Error(message.error)
        this.finish(parseState(message.state))
      } catch (error) { this.finish(undefined, error instanceof Error ? error : new Error(String(error))) }
    }
  }

  private finish(state?: LiveHandoverState, error?: Error): void {
    const pending = this.pending
    if (!pending) return
    this.pending = null
    clearTimeout(pending.timer)
    if (error) pending.reject(error)
    else if (state) pending.resolve(state)
  }

  close(): void {
    this.closed = true
    this.finish(undefined, new Error('Live ownership transfer cancelled because this tab closed.'))
    this.channel.removeEventListener('message', this.receive)
    this.channel.close()
  }
}
