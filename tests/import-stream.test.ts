import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openImportStream } from '../src/import-stream.ts'

function events() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
  return { response: new Response(stream), send(text: string) { controller.enqueue(new TextEncoder().encode(text)) }, end() { controller.close() } }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('SSE is ready before upload; only an armed genuine boolean file_imported confirms', async () => {
  const source = events()
  const opening = openImportStream(async () => source.response)
  source.send(': connected\n\n')
  const listener = await opening
  source.send('event: file_imported\ndata: {"success":true}\n\n')
  await tick()
  listener.arm()
  let completed = false
  void listener.result.then(() => { completed = true })
  source.send('event: status\ndata: {"success":true}\n\n')
  await tick()
  assert.equal(completed, false)
  source.send('event: file_imported\ndata: {"success":true}\n\n')
  assert.deepEqual(await listener.result, { status: 'confirmed' })
  listener.close()
})

test('false import results are failures, not acceptance-shaped success', async () => {
  const source = events()
  const opening = openImportStream(async () => source.response)
  source.send(': connected\r\n\r\n')
  const listener = await opening
  listener.arm()
  source.send('event: file_imported\ndata: {"success":false,"error":"bad SVG"}\n\n')
  assert.deepEqual(await listener.result, { status: 'failed', error: 'bad SVG' })
})

test('malformed confirmation, EOF and unavailable stream produce explicit unknown/failure', async () => {
  for (const raw of ['event: file_imported\ndata: {"success":"true"}\n\n', 'event: file_imported\ndata: not-json\n\n']) {
    const source = events()
    const opening = openImportStream(async () => source.response)
    source.send(': connected\n\n')
    const listener = await opening
    listener.arm()
    source.send(raw)
    assert.equal((await listener.result).status, 'unknown')
  }
  const source = events()
  const opening = openImportStream(async () => source.response)
  source.end()
  await assert.rejects(opening, /closed/)
  await assert.rejects(openImportStream(async () => new Response('', { status: 401 })), /401/)
})

test('readiness and confirmation deadlines explicitly fail closed', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const unready = events()
  const opening = openImportStream(async () => unready.response)
  const rejected = assert.rejects(opening, /readiness timed out/)
  context.mock.timers.tick(3000)
  await rejected
  const ready = events()
  const secondOpening = openImportStream(async () => ready.response)
  ready.send(': connected\n\n')
  const listener = await secondOpening
  listener.arm()
  context.mock.timers.tick(20000)
  assert.equal((await listener.result).status, 'unknown')
  listener.close()
})
