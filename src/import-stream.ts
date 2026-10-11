import type { ImportOutcome } from './live-updates'

export interface ImportResult { status: ImportOutcome; error?: string }

export async function openImportStream(fetchEvents: (signal: AbortSignal) => Promise<Response>): Promise<{
  arm: () => void
  result: Promise<ImportResult>
  close: () => void
}> {
  const controller = new AbortController()
  let armed = false
  let settled = false
  let ready = false
  let finish: (result: ImportResult) => void = () => {}
  const result = new Promise<ImportResult>(resolve => { finish = resolve })
  let resolveReady: () => void = () => {}
  let rejectReady: (error: Error) => void = () => {}
  const readiness = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const complete = (value: ImportResult): void => {
    if (settled) return
    settled = true
    finish(value)
    if (!ready) rejectReady(new Error(value.error || 'LightBurn event stream did not become ready.'))
    controller.abort()
  }
  let timeout = setTimeout(() => complete({ status: 'unknown', error: 'LightBurn SSE readiness timed out; nothing was uploaded.' }), 3000)
  const read = async (): Promise<void> => {
    try {
      const response = await fetchEvents(controller.signal)
      if (!response.ok || !response.body) throw new Error(`LightBurn event stream unavailable (${response.status}).`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = '', event = 'message', data: string[] = [], dataLength = 0
      try {
        while (!settled) {
          const next = await reader.read()
          if (next.done) throw new Error('LightBurn event stream closed before confirmation.')
          buffer += decoder.decode(next.value, { stream: true })
          if (buffer.length > 1024 * 1024) throw new Error('LightBurn event stream frame exceeds its limit.')
          const lines = buffer.split(/\r?\n/)
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (line.startsWith(':') && line.slice(1).trim() === 'connected') {
              if (!ready) { ready = true; clearTimeout(timeout); resolveReady() }
            } else if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) {
              dataLength += line.length
              if (dataLength > 1024 * 1024) throw new Error('LightBurn event data exceeds its limit.')
              data.push(line.slice(5).trim())
            }
            else if (line === '') {
              if (armed && event === 'file_imported' && data.length) {
                const value: unknown = JSON.parse(data.join('\n'))
                if (!value || typeof value !== 'object' || !('success' in value) || typeof value.success !== 'boolean') {
                  throw new Error('Invalid file_imported confirmation.')
                }
                complete(value.success ? { status: 'confirmed' } : { status: 'failed',
                  error: 'error' in value && typeof value.error === 'string' ? value.error : 'LightBurn reported import failure.' })
              }
              event = 'message'; data = []; dataLength = 0
            }
          }
        }
      } finally { await reader.cancel(); reader.releaseLock() }
    } catch (error) {
      if (!settled) complete({ status: 'unknown', error: error instanceof Error ? error.message : String(error) })
    } finally { clearTimeout(timeout) }
  }
  void read()
  await readiness
  return {
    arm: () => {
      if (settled || controller.signal.aborted) throw new Error('LightBurn event stream closed before upload.')
      armed = true
      timeout = setTimeout(() => complete({ status: 'unknown', error: 'No file_imported confirmation. Inspect LightBurn; do not resend blindly.' }), 20000)
    },
    result,
    close: () => { clearTimeout(timeout); complete({ status: 'unknown', error: 'Import event stream cancelled.' }) },
  }
}
