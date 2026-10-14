import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RelayClient, responseTransitMs } from '../src/relay.ts'

class SocketFixture {
  static latest: SocketFixture
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event?: { reason?: string }) => void) | null = null
  sent: string[] = []
  closed = false
  closeCode: number | undefined
  url: string
  constructor(url: string | URL) { this.url = String(url); SocketFixture.latest = this }
  send(text: string) { this.sent.push(text) }
  // Like a real browser, a client may only close with 1000 or 3000-4999.
  close(code?: number, reason?: string) {
    if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999)) throw new Error(`InvalidAccessError: close code ${code}`)
    if (this.closed) return
    this.closed = true
    this.closeCode = code
    this.onclose?.({ reason })
  }
  closeFromServer(reason: string) { if (this.closed) return; this.closed = true; this.onclose?.({ reason }) }
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

async function setup(initial: Record<string, unknown> = fixture, control: () => Response = () => Response.json({ ok: true })) {
  const original = globalThis.fetch
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')
  const paths: string[] = []
  let captureId = ''
  let claims = 0
  Object.defineProperty(globalThis, 'WebSocket', { value: SocketFixture, configurable: true, writable: true })
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname
    paths.push(path)
    if (path.endsWith('/ticket')) return Response.json({ ticket: 'one-use-ticket' })
    if (path.endsWith('/capture')) {
      captureId = JSON.parse(String(init?.body)).requestId
      return Response.json({ requestId: captureId })
    }
    if (path.endsWith('/control')) { claims++; return control() }
    throw new Error(`Unexpected polling: ${path}`)
  }
  const client = new RelayClient({ baseUrl: 'https://relay.example', relayId: 'test', credential: 'test-only' }, () => {})
  client.start()
  await flush()
  const socket = SocketFixture.latest
  socket.onopen?.()
  socket.receive(initial)
  await flush()
  return {
    client, socket, paths, captureId: () => captureId, claims: () => claims,
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

test('stopping the client closes the socket and clears capture state while retaining pairing', async () => {
  const env = await setup()
  try {
    env.client.stop()
    assert.equal(env.socket.closed, true)
    assert.equal(env.client.canCapture(), false)
    assert.equal(env.client.snapshot, null)
    assert.equal(env.client.identity.credential, 'test-only')
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

test('free capture control is claimed automatically once; losing it never starts a stealing loop', async () => {
  const env = await setup({ ...fixture, activeBrowser: false })
  try {
    assert.equal(env.claims(), 1)
    assert.equal(env.client.canCapture(), true)
    env.socket.receive({ ...fixture, activeBrowser: false, controlOccupied: true })
    await flush()
    assert.match(env.client.controlError, /another browser/)
    env.socket.receive({ ...fixture, activeBrowser: false, controlOccupied: false })
    await flush()
    assert.equal(env.claims(), 1)
    assert.equal(env.client.canCapture(), false)
    await env.client.claimControl(true)
    assert.equal(env.client.canCapture(), true)
    assert.equal(env.claims(), 2)
  } finally { env.cleanup() }
})

test('occupied control stays read-only and a refused automatic claim is explained', async () => {
  const occupied = await setup({ ...fixture, activeBrowser: false, controlOccupied: true })
  try {
    assert.equal(occupied.claims(), 0)
    assert.equal(occupied.client.canCapture(), false)
  } finally { occupied.cleanup() }
  const refused = await setup({ ...fixture, activeBrowser: false },
    () => Response.json({ error: 'Unresolved import prevents capture handover' }, { status: 409 }))
  try {
    assert.equal(refused.claims(), 1)
    assert.match(refused.client.controlError, /Unresolved import/)
    assert.equal(refused.client.canCapture(), false)
  } finally { refused.cleanup() }
})

test('an old preview is never treated as a fresh position', async () => {
  const env = await setup({ ...fixture, snapshot: { ...fixture.snapshot, observationAgeMs: 2001 } })
  try {
    assert.equal(env.client.canCapture(), true)
    assert.equal(env.client.hasFreshPosition(), false)
    env.client.stop()
    assert.equal(env.client.canCapture(), false)
    assert.equal(env.client.snapshot, null)
  } finally { env.cleanup() }
})

test('malformed relay updates and refused tickets fail closed', async () => {
  const env = await setup()
  try {
    env.socket.receive({ protocol: 1 })
    await flush()
    assert.match(env.client.error, /unexpected update/)
    assert.equal(env.client.canCapture(), false)
    // The socket must really close (with a client-legal code) so the client can retry instead of hanging.
    assert.equal(env.socket.closed, true)
    assert.equal(env.socket.closeCode, 4000)
  } finally { env.cleanup() }
  const original = globalThis.fetch
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')
  Object.defineProperty(globalThis, 'WebSocket', { value: SocketFixture, configurable: true, writable: true })
  globalThis.fetch = async () => Response.json({ error: 'Relay access revoked' }, { status: 403 })
  const client = new RelayClient({ baseUrl: 'https://relay.example', relayId: 'test', credential: 'test-only' }, () => {})
  try {
    client.start()
    await flush()
    assert.match(client.error, /revoked/)
    assert.equal(client.canCapture(), false)
    // A rejected credential is reported separately, because reconnecting can never fix it.
    assert.equal(client.unauthorized, true)
    client.reconnect()
    await flush()
    assert.equal(client.unauthorized, true)
  } finally {
    client.stop()
    globalThis.fetch = original
    if (descriptor) Object.defineProperty(globalThis, 'WebSocket', descriptor)
    else Reflect.deleteProperty(globalThis, 'WebSocket')
  }
})

test('a stream taken over by a newer tab stops retrying until Reconnect, which restarts at once', async () => {
  const env = await setup()
  try {
    const first = env.socket
    first.closeFromServer('browser_replaced')
    await new Promise(resolve => setTimeout(resolve, 1400))
    assert.equal(SocketFixture.latest, first)
    assert.match(env.client.error, /another tab/)
    env.client.reconnect()
    await flush()
    assert.notEqual(SocketFixture.latest, first)
    assert.equal(env.client.error, '')
    SocketFixture.latest.onopen?.()
    SocketFixture.latest.receive(fixture)
    await flush()
    assert.equal(env.client.canCapture(), true)
  } finally { env.cleanup() }
})

test('an ordinary disconnect keeps retrying on its own', async () => {
  const env = await setup()
  try {
    const first = env.socket
    first.closeFromServer('socket_expired')
    await new Promise(resolve => setTimeout(resolve, 1400))
    assert.notEqual(SocketFixture.latest, first)
  } finally { env.cleanup() }
})

test('the relay can ask for a RAP update', async () => {
  const env = await setup({ ...fixture, rapUpdateRequired: true })
  try { assert.equal(env.client.rapUpdateRequired, true) }
  finally { env.cleanup() }
})
