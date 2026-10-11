import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RelayClient, parseSnapshot, parseJob, relayBaseUrl, sampleAge, pairingInvitation, MAX_SAMPLE_AGE_MS } from '../src/relay.ts'

const snapshot = {
  generation: 'boot-1', sequence: 1, connected: true, position: { x: 24, y: 18 },
  context: { revision: 'workspace-1', size: { x: 400, y: 400 } },
  observationAgeMs: 100, receivedAt: 10000,
}

test('latest snapshot preserves workpiece coordinates and validates dimensions', () => {
  assert.deepEqual(parseSnapshot(snapshot), snapshot)
  assert.equal(parseSnapshot(null), null)
  assert.throws(() => parseSnapshot({ ...snapshot, position: { x: NaN, y: 0 } }))
  assert.throws(() => parseSnapshot({ ...snapshot, observationAgeMs: -1 }))
  assert.throws(() => parseSnapshot({ ...snapshot, context: { revision: 'x', size: { x: 0, y: 1 } } }))
})

test('freshness includes observation, server residence, transport and monotonic elapsed', () => {
  const parsed = parseSnapshot(snapshot)!
  assert.equal(sampleAge(parsed, 10500, 200, 1200), MAX_SAMPLE_AGE_MS)
  assert.ok(sampleAge(parsed, 10500, 200, 1201) > MAX_SAMPLE_AGE_MS)
  assert.equal(sampleAge(parsed, 9900, 10, 0), 110)
})

test('relay configuration refuses unencrypted remote origins and embedded credentials', () => {
  assert.equal(relayBaseUrl('https://relay.example/'), 'https://relay.example')
  assert.equal(relayBaseUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787')
  for (const value of ['http://relay.example', 'https://user:password@relay.example', 'https://relay.example/api', 'https://relay.example/?secret=x']) {
    assert.throws(() => relayBaseUrl(value))
  }
})

test('pairing invitation is separate from durable credentials', () => {
  assert.deepEqual(pairingInvitation('#relay=https%3A%2F%2Frelay.example&relayId=abc&invite=once'), {
    baseUrl: 'https://relay.example', relayId: 'abc', invitation: 'once',
  })
  assert.equal(pairingInvitation(''), null)
  assert.throws(() => pairingInvitation('#invite=once'))
})

test('import acceptance is not confirmation and invalid job states are rejected', () => {
  assert.deepEqual(parseJob({ id: 'job', status: 'accepted' }), { id: 'job', status: 'accepted' })
  assert.deepEqual(parseJob({ id: 'job', status: 'unknown', error: 'Disconnected' }), {
    id: 'job', status: 'unknown', error: 'Disconnected',
  })
  assert.throws(() => parseJob({ id: 'job', status: 'success' }))
})

test('client enables latest-sample capture, rejects stale records and clears state on stop', async () => {
    const originalFetch = globalThis.fetch
    let age = 0
    globalThis.fetch = async () => Response.json({
      serverTime: 10000, snapshot: { ...snapshot, observationAgeMs: age }, activeBrowser: true, job: null,
    })
    let changed!: () => void
    let update = new Promise<void>(resolve => { changed = resolve })
    const client = new RelayClient({ baseUrl: 'https://relay.example', relayId: 'test', credential: 'test-only' }, () => changed())
    try {
      client.start()
      await update
      assert.equal(client.canCapture(), true)
      client.stop()
      assert.equal(client.canCapture(), false)
      assert.equal(client.snapshot, null)
      age = 2001
      update = new Promise<void>(resolve => { changed = resolve })
      client.start()
      await update
      assert.equal(client.canCapture(), false)
    } finally {
      client.stop()
      globalThis.fetch = originalFetch
    }
  })

test('client fails closed on malformed or failed relay responses', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => Response.json({ error: 'Relay access revoked' }, { status: 403 })
    let changed!: () => void
    const update = new Promise<void>(resolve => { changed = resolve })
    const client = new RelayClient({ baseUrl: 'https://relay.example', relayId: 'test', credential: 'test-only' }, changed)
    try {
      client.start()
      await update
      assert.equal(client.canCapture(), false)
      assert.equal(client.error, 'Relay access revoked')
    } finally {
      client.stop()
      globalThis.fetch = originalFetch
    }
  })
