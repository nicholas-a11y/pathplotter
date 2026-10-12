import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizePairingCode, createCodeClaim, pendingCodeClaim, codeClaimIdentity } from '../src/code-pairing.ts'

test('RAP code accepts only exactly three ASCII letters, with outer whitespace and case normalization', () => {
  assert.equal(normalizePairingCode(' aBc '), 'ABC')
  for (const invalid of ['', 'AB', 'ABCD', 'A B', '123', 'ＡBC', 'AßC', 'ABC!']) {
    assert.throws(() => normalizePairingCode(invalid), /exactly three letters/)
  }
})

test('private claim is persisted before it is returned and validates for recovery', () => {
  const values = new Map<string, string>()
  const storage = { setItem: (key: string, value: string) => { values.set(key, value) },
    getItem: (key: string) => values.get(key) ?? null, removeItem: (key: string) => { values.delete(key) } }
  const claim = createCodeClaim(storage)
  assert.match(claim.verifier, /^[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(pendingCodeClaim(storage), claim)
  assert.throws(() => createCodeClaim({ setItem: () => { throw new Error('storage denied') } }), /storage denied/)
  storage.setItem('pathplotter.code-claim.v1', JSON.stringify({ ...claim, expiresAt: Date.now() - 1 }))
  assert.equal(pendingCodeClaim(storage), null)
  assert.equal(values.size, 0)
  storage.setItem('pathplotter.code-claim.v1', JSON.stringify({ ...claim, verifier: 'wrong' }))
  assert.throws(() => pendingCodeClaim(storage), /invalid/)
})

test('only complete well-shaped browser credentials can become an identity', () => {
  assert.equal(codeClaimIdentity({ status: 'pending' }), null)
  const relayId = crypto.randomUUID(), credential = createCodeClaim({ setItem: () => {} }).verifier
  assert.deepEqual(codeClaimIdentity({ status: 'complete', relayId, credential }),
    { baseUrl: 'https://pathplotter-relay-test.nicholas-leqeta.workers.dev', relayId, credential })
  for (const value of [{}, { status: 'complete', relayId: 'wrong', credential }, { status: 'complete', relayId, credential: 'short' }]) {
    assert.throws(() => codeClaimIdentity(value), /Invalid code-pairing response/)
  }
})
