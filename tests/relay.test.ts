import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RelayClient, parseSnapshot, parseJob, relayBaseUrl, sampleAge, browserLink, exchangeBrowserLink, MAX_SAMPLE_AGE_MS } from '../src/relay.ts'

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

test('browser switching errors explain confirmation, stale consent and unresolved imports', async () => {
  const original = globalThis.fetch
  const link = { baseUrl: 'https://relay.example', relayId: 'test', token: 'once', kind: 'launch' as const }
  try {
    for (const [code, expected] of [
      ['browser_replacement_required', /explicitly replace/],
      ['browser_changed', /confirm replacement again/],
      ['unresolved_imports', /resolve unknown outcomes/],
    ] as const) {
      globalThis.fetch = async () => Response.json({ error: code }, { status: 409 })
      await assert.rejects(exchangeBrowserLink(link, null, () => {}, () => true), expected)
    }
  } finally { globalThis.fetch = original }
})

test('desktop links distinguish launch grants from phone invitations and reject ambiguity', () => {
  assert.deepEqual(browserLink('#relay=https%3A%2F%2Frelay.example&relayId=abc&launch=once'), {
    baseUrl: 'https://relay.example', relayId: 'abc', token: 'once', kind: 'launch',
  })
  assert.equal(browserLink(''), null)
  assert.throws(() => browserLink('#launch=one&invite=two'))
  assert.throws(() => browserLink('#launch=one'))
})

test('desktop launch reuses only same-RAP authorization and never saves cancelled exchanges', async () => {
  const original = globalThis.fetch
  const bodies: unknown[] = []
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(String(options?.body)))
    return Response.json({ credential: 'authorized' })
  }
  const link = { baseUrl: 'https://relay.example', relayId: 'test', token: 'one-use', kind: 'launch' as const }
  try {
    const existing = { baseUrl: link.baseUrl, relayId: 'test', credential: 'saved' }
    assert.deepEqual(await exchangeBrowserLink(link, existing, () => {}, () => true), { ...existing, credential: 'authorized' })
    assert.deepEqual(bodies[0], { launchToken: 'one-use', credential: 'saved' })
    assert.equal(await exchangeBrowserLink(link, { ...existing, relayId: 'different' }, () => {}, () => false), null)
    assert.deepEqual(bodies[1], { launchToken: 'one-use' })
  } finally { globalThis.fetch = original }
})

test('phone links reuse valid saved authorization and otherwise wait for exact desktop approval', async () => {
  const original = globalThis.fetch
  const paths: string[] = [], messages: string[] = []
  const link = { baseUrl: 'https://relay.example', relayId: 'test', token: 'phone-only', kind: 'phone' as const }
  const existing = { baseUrl: link.baseUrl, relayId: link.relayId, credential: 'saved' }
  let revoked = false
  globalThis.fetch = async url => {
    const path = String(url).split('/test')[1]!
    paths.push(path)
    if (path === '/ticket') return Response.json(revoked ? { error: 'Revoked' } : {}, { status: revoked ? 403 : 200 })
    if (path === '/pairing/request') return Response.json({ pairingId: 'exact-request', pendingToken: 'pending-only', phrase: 'compare-this-phrase' })
    return Response.json({ status: 'approved', credential: 'phone-authorized' })
  }
  try {
    assert.deepEqual(await exchangeBrowserLink(link, existing, text => messages.push(text), () => true), existing)
    assert.deepEqual(paths, ['/ticket'])
    revoked = true
    const paired = await exchangeBrowserLink(link, existing, text => messages.push(text), () => true)
    assert.equal(paired?.credential, 'phone-authorized')
    assert.deepEqual(paths.slice(1), ['/ticket', '/pairing/request', '/pairing/status'])
    assert.ok(messages.includes('compare-this-phrase\n\nTo finish pairing, open the PathPlotter RAP in the Windows system tray\nand click “Approve matching phrase”.'))
  } finally { globalThis.fetch = original }
})

test('import acceptance is not confirmation and invalid job states are rejected', () => {
  assert.deepEqual(parseJob({ id: 'job', status: 'accepted' }), { id: 'job', status: 'accepted' })
  assert.deepEqual(parseJob({ id: 'job', status: 'unknown', error: 'Disconnected' }), {
    id: 'job', status: 'unknown', error: 'Disconnected',
  })
  assert.throws(() => parseJob({ id: 'job', status: 'success' }))
})
