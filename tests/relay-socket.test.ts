import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RelayClient, responseTransitMs } from '../src/relay.ts'

class SocketFixture {
  static latest: SocketFixture
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []
  closed = false
  url: string
  constructor(url: string | URL) { this.url = String(url); SocketFixture.latest = this }
  send(text: string) { this.sent.push(text) }
  close() { if (this.closed) return; this.closed = true; this.onclose?.() }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
}

const fixture = {
  protocol: 2, serverTime: 10000, agentOnline: true, activeBrowser: true, controlOccupied: false,
  previewActive: true, settled: true, job: null, waitMs: 0,
  snapshot: {
    generation: 1, sequence: 1, connected: true, position: { x: 24, y: 18 },
    context: { revision: 'workspace-1', size: { x: 400, y: 400 } }, observationAgeMs: 0, receivedAt: 10000,
  },
}
const flush = async () => { await new Promise(resolve => setTimeout(resolve, 10)) }

test('waiting for RAP is not coordinate age, but invalid wait claims never remove transport delay', () => {
  assert.equal(responseTransitMs(5100, 5000), 100)
  assert.equal(responseTransitMs(200, 0), 200)
  for (const wait of [-1, NaN, Infinity, 201, 10001, undefined, '100']) {
    assert.throws(() => responseTransitMs(200, wait), /Invalid relay coordinate wait/)
  }
})

async function setup() {
  const original = globalThis.fetch
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')
  const paths: string[] = []
  let captureId = ''
  Object.defineProperty(globalThis, 'WebSocket', { value: SocketFixture, configurable: true, writable: true })
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname
    paths.push(path)
    if (path.endsWith('/ticket')) return Response.json({ ticket: 'one-use-ticket' })
    if (path.endsWith('/capture')) {
      captureId = JSON.parse(String(init?.body)).requestId
      return Response.json({ requestId: captureId })
    }
    if (path.endsWith('/control')) return Response.json({ ok: true })
    throw new Error(`Unexpected polling: ${path}`)
  }
  const client = new RelayClient({ baseUrl: 'https://relay.example', relayId: 'test', credential: 'test-only' }, () => {})
  client.start()
  await flush()
  const socket = SocketFixture.latest
  socket.onopen?.()
  socket.receive(fixture)
  await flush()
  return {
    client, socket, paths, captureId: () => captureId,
    cleanup: () => {
      client.stop()
      globalThis.fetch = original
      if (descriptor) Object.defineProperty(globalThis, 'WebSocket', descriptor)
      else Reflect.deleteProperty(globalThis, 'WebSocket')
    },
  }
}

test('socket transport consumes events without HTTP snapshot polling or durable credentials in URL', async () => {
  const env = await setup()
  try {
    assert.equal(env.client.canCapture(), true)
    assert.equal(env.client.settled, true)
    assert.equal(new URL(env.socket.url).protocol, 'wss:')
    assert.ok(!env.socket.url.includes('test-only'))
    await new Promise(resolve => setTimeout(resolve, 600))
    assert.deepEqual(env.paths, ['/v1/relays/test/ticket'])
    assert.equal(env.socket.sent.length, 1)
  } finally { env.cleanup() }
})

test('fresh capture accepts only matched fresh results and never resolves from cached preview', async () => {
  const env = await setup()
  try {
    let resolved = false
    const read = env.client.freshPosition().then(value => { resolved = true; return value })
    await flush()
    env.socket.receive({ v: 2, type: 'capture-result', id: 'unrelated', body: fixture })
    await flush()
    assert.equal(resolved, false)
    const next = { ...fixture, snapshot: { ...fixture.snapshot, sequence: 2, position: { x: 25, y: 20 } } }
    env.socket.receive({ v: 2, type: 'capture-result', id: env.captureId(), body: next })
    const result = await read
    assert.deepEqual(result.position, { x: 25, y: 20 })
    assert.equal(resolved, true)
  } finally { env.cleanup() }
})

test('fresh capture fails on stale results, disconnect and control loss without retry', async () => {
  for (const failure of ['stale', 'disconnect', 'control'] as const) {
    const env = await setup()
    try {
      const read = env.client.freshPosition()
      const rejected = assert.rejects(read, /delayed|interrupted|control/)
      await flush()
      if (failure === 'disconnect') env.socket.close()
      else env.socket.receive({
        v: 2, type: 'capture-result', id: env.captureId(),
        body: { ...fixture, activeBrowser: failure !== 'control',
          snapshot: { ...fixture.snapshot, observationAgeMs: failure === 'stale' ? 2001 : 0 } },
      })
      await rejected
      assert.equal(env.paths.filter(path => path.endsWith('/capture')).length, 1)
    } finally { env.cleanup() }
  }
})

test('stale stationary preview is not a new observation; malformed events fail closed', async () => {
  const env = await setup()
  try {
    env.socket.receive({ ...fixture, snapshot: { ...fixture.snapshot, observationAgeMs: 30000 } })
    await flush()
    assert.equal(env.client.canCapture(), true)
    assert.equal(env.client.hasFreshPosition(), false)
    env.socket.receive({ ...fixture, protocol: 999 })
    await flush()
    assert.equal(env.client.canCapture(), false)
    assert.match(env.client.error, /compatible|update/i)
  } finally { env.cleanup() }
})

test('import progress follows socket notifications without HTTP result polling', async () => {
  const env = await setup()
  try {
    const waiting = env.client.waitForJob({ id: 'test-job', status: 'queued' })
    env.socket.receive({ ...fixture, job: { id: 'test-job', status: 'confirmed' } })
    assert.deepEqual(await waiting, { id: 'test-job', status: 'confirmed' })
    assert.deepEqual(env.paths, ['/v1/relays/test/ticket'])
  } finally { env.cleanup() }
})

test('a paused moving preview does not block a new verified coordinate request', async () => {
  const env = await setup()
  try {
    env.socket.receive({ ...fixture, previewActive: false, snapshot: { ...fixture.snapshot, observationAgeMs: 15000 } })
    await flush()
    assert.equal(env.client.previewActive, false)
    env.socket.receive({ v: 2, type: 'error', error: 'preview_busy' })
    await flush()
    assert.equal(env.socket.closed, false)
    assert.match(env.client.connectionNotice, /preview limit/)
    assert.equal(env.client.canCapture(), true)
    const read = env.client.freshPosition()
    await flush()
    env.socket.receive({ v: 2, type: 'capture-result', id: env.captureId(), body: { ...fixture, previewActive: false } })
    assert.deepEqual((await read).position, fixture.snapshot.position)
  } finally { env.cleanup() }
})

test('explicit HTTP fallback keeps protocol 2 health polling at least five seconds apart', async () => {
  const originalFetch = globalThis.fetch
  const polls: number[] = []
  globalThis.fetch = async () => {
    polls.push(performance.now())
    return Response.json(fixture)
  }
  const client = new RelayClient({ baseUrl: 'https://relay.example', relayId: 'test', credential: 'test-only' }, () => {}, 'http')
  try {
    client.start()
    await flush()
    assert.equal(client.canCapture(), true)
    await new Promise(resolve => setTimeout(resolve, 5100))
    assert.equal(polls.length, 2)
    assert.ok(polls[1]! - polls[0]! >= 5000)
  } finally { client.stop(); globalThis.fetch = originalFetch }
})

test('HTTP capture starts long-poll immediately and accepts only a genuinely fresh result after server waiting', async () => {
  const originalFetch = globalThis.fetch
  let requestedId = '', postAt = 0, getAt = 0
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path.endsWith('/snapshot')) return Response.json(fixture)
    if (path.endsWith('/capture')) {
      requestedId = JSON.parse(String(init?.body)).requestId
      postAt = performance.now()
      return Response.json({ requestId: requestedId })
    }
    assert.ok(path.endsWith(`/capture/${requestedId}`))
    getAt = performance.now()
    await new Promise(resolve => setTimeout(resolve, 2200))
    return Response.json({ status: 'complete', waitMs: Math.floor(performance.now() - getAt),
      body: { ...fixture, snapshot: { ...fixture.snapshot, sequence: 2 } } })
  }
  const client = new RelayClient({ baseUrl: 'https://relay.example', relayId: 'test', credential: 'test-only' }, () => {}, 'http')
  try {
    client.start()
    await flush()
    const result = await client.freshPosition()
    assert.equal(result.sequence, 2)
    assert.ok(getAt - postAt < 100, 'The first capture GET must not wait for the five-second regular poll.')
    assert.ok(client.age() < 100)
  } finally { client.stop(); globalThis.fetch = originalFetch }
})

test('socket capture subtracts only matched server waiting, never old observation age', async () => {
  const env = await setup()
  try {
    const read = env.client.freshPosition()
    await flush()
    await new Promise(resolve => setTimeout(resolve, 2200))
    env.socket.receive({ v: 2, type: 'capture-result', id: env.captureId(),
      body: { ...fixture, waitMs: 2200, snapshot: { ...fixture.snapshot, sequence: 2 } } })
    assert.equal((await read).sequence, 2)
    const stale = env.client.freshPosition()
    const rejected = assert.rejects(stale, /delayed/)
    await flush()
    env.socket.receive({ v: 2, type: 'capture-result', id: env.captureId(),
      body: { ...fixture, waitMs: 0, snapshot: { ...fixture.snapshot, sequence: 3, observationAgeMs: 2001 } } })
    await rejected
  } finally { env.cleanup() }
})
