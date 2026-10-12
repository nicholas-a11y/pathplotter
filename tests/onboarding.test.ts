import { test } from 'node:test'
import assert from 'node:assert/strict'
import { releaseDownload } from '../src/onboarding.ts'

test('downloads require a published RAP release and the exact public repository asset', () => {
  const url = 'https://github.com/nicholas-a11y/pathplotter/releases/download/rap-v3.0.0/PathPlotter-RAP-Windows.zip'
  const release = { tag_name: 'rap-v3.0.0', draft: false, prerelease: false, assets: [{ name: 'PathPlotter-RAP-Windows.zip', browser_download_url: url }] }
  assert.equal(releaseDownload(release), url)
  assert.equal(releaseDownload({ ...release, draft: true }), null)
  assert.equal(releaseDownload({ ...release, tag_name: 'v1.0' }), null)
  assert.equal(releaseDownload({ ...release, assets: [{ name: 'PathPlotter-RAP-Windows.zip', browser_download_url: 'https://evil.example/file.zip' }] }), null)
})
