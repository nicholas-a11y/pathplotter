import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LiveHandover, type HandoverChannel, type LiveHandoverState } from '../src/live-handover.ts'

class TestChannel implements HandoverChannel {
  peers: TestChannel[]
  listeners = new Set<(event: MessageEvent) => void>()
  constructor(peers: TestChannel[]) { this.peers = peers; peers.push(this) }
  postMessage(data: unknown): void {
    for (const peer of this.peers) if (peer !== this) {
      queueMicrotask(() => { for (const listener of peer.listeners) listener({ data } as MessageEvent) })
    }
  }
  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void { this.listeners.add(listener) }
  removeEventListener(_type: 'message', listener: (event: MessageEvent) => void): void { this.listeners.delete(listener) }
  close(): void { this.listeners.clear() }
}
const state: LiveHandoverState = { enabled: true, target: {
  mode: 'relay', baseUrl: 'https://relay.example', relayId: 'test', contextRevision: 'original',
} }

test('Webtool live ownership preserves its direct API destination without cloud identity', async () => {
  const peers: TestChannel[] = []
  const direct: LiveHandoverState = { enabled: true, target: {
    mode: 'webtool', baseUrl: 'http://localhost:19520', contextRevision: 'original',
  } }
  const owner = new LiveHandover(new TestChannel(peers), 'old', () => true, async () => direct)
  const requester = new LiveHandover(new TestChannel(peers), 'new', () => false, async () => null)
  try { assert.deepEqual(await requester.request(1000), direct) }
  finally { owner.close(); requester.close() }
})

test('handover replies only after the owner has finished its current operation', async () => {
  const peers: TestChannel[] = []
  let settle!: () => void
  const settled = new Promise<void>(resolve => { settle = resolve })
  let owns = true, resolved = false
  const owner = new LiveHandover(new TestChannel(peers), 'old', () => owns, async () => {
    await settled
    owns = false
    return state
  })
  const requester = new LiveHandover(new TestChannel(peers), 'new', () => false, async () => null)
  const observer = new LiveHandover(new TestChannel(peers), 'observer', () => false, async () => { throw new Error('Not an owner') })
  try {
    const result = requester.request(1000).then(value => { resolved = true; return value })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(resolved, false)
    settle()
    assert.deepEqual(await result, state)
    assert.equal(owns, false)
  } finally { owner.close(); requester.close(); observer.close() }
})

test('simultaneous requesters cannot both receive permission from an owner', async () => {
  const peers: TestChannel[] = []
  let settle!: () => void
  const settled = new Promise<void>(resolve => { settle = resolve })
  let owns = true, transfers = 0
  const owner = new LiveHandover(new TestChannel(peers), 'old', () => owns, async () => {
    transfers++
    await settled
    owns = false
    return state
  })
  const first = new LiveHandover(new TestChannel(peers), 'first', () => false, async () => null)
  const second = new LiveHandover(new TestChannel(peers), 'second', () => false, async () => null)
  try {
    const result = first.request(1000)
    const rejected = assert.rejects(second.request(1000), /already taking ownership/)
    await rejected
    settle()
    assert.deepEqual(await result, state)
    assert.equal(transfers, 1)
  } finally { owner.close(); first.close(); second.close() }
})

test('owner failures and unresponsive owners explicitly refuse transfer', async () => {
  const peers: TestChannel[] = []
  const owner = new LiveHandover(new TestChannel(peers), 'old', () => true, async () => { throw new Error('Journal cannot be saved') })
  const requester = new LiveHandover(new TestChannel(peers), 'new', () => false, async () => null)
  try {
    await assert.rejects(requester.request(1000), /Journal cannot be saved/)
    owner.close()
    await assert.rejects(requester.request(5), /did not release/)
  } finally { requester.close() }
})

test('stale replies, invalid destinations and channel closure cannot grant ownership', async () => {
  const peers: TestChannel[] = []
  const attacker = new TestChannel(peers)
  const requester = new LiveHandover(new TestChannel(peers), 'new', () => false, async () => null)
  const sent: Record<string, unknown>[] = []
  attacker.addEventListener('message', event => { sent.push(event.data) })
  try {
    const timed = requester.request(5)
    attacker.postMessage({ type: 'reply', id: 'wrong', sender: 'old', to: 'new', state })
    await assert.rejects(timed, /did not release/)
    const invalid = requester.request(1000)
    await new Promise(resolve => setTimeout(resolve, 0))
    attacker.postMessage({ type: 'reply', id: sent.at(-1)!.id, sender: 'old', to: 'new',
      state: { ...state, target: { ...state.target, baseUrl: 'https://relay.example/?secret=bad' } } })
    await assert.rejects(invalid, /Invalid live ownership destination/)
    const closed = requester.request(1000)
    requester.close()
    await assert.rejects(closed, /cancelled/)
    await assert.rejects(requester.request(), /closed/)
  } finally { attacker.close(); requester.close() }
})
