import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enrollmentLink, releaseDownload, HOSTED_RELAY } from '../src/onboarding.ts'

test('device setup links expose no private verifier and restrict relay destinations', () => {
  const id = '12345678-1234-1234-1234-123456789abc'
  assert.deepEqual(enrollmentLink(`#enroll=${id}`), { baseUrl: HOSTED_RELAY, requestId: id })
  assert.equal(enrollmentLink('#invite=phone'), null)
  assert.throws(() => enrollmentLink('#enroll=invalid'))
  assert.throws(() => enrollmentLink(`#enroll=${id}&invite=phone`))
  assert.throws(() => enrollmentLink(`#enroll=${id}&relay=https%3A%2F%2Funtrusted.example`))
})

test('downloads require a compatible published release and the exact public repository asset', () => {
  const url = 'https://github.com/nicholas-a11y/pathplotter/releases/download/rap-v2.0.0/PathPlotter-RAP-Windows.zip'
  const release = { tag_name: 'rap-v2.0.0', draft: false, prerelease: false, assets: [{ name: 'PathPlotter-RAP-Windows.zip', browser_download_url: url }] }
  assert.equal(releaseDownload(release), url)
  assert.equal(releaseDownload({ ...release, draft: true }), null)
  assert.equal(releaseDownload({ ...release, tag_name: 'v1.0' }), null)
  assert.equal(releaseDownload({ ...release, assets: [{ name: 'PathPlotter-RAP-Windows.zip', browser_download_url: 'https://evil.example/file.zip' }] }), null)
})
