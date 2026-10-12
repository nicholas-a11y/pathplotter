import { HOSTED_RELAY } from './onboarding.ts'
import { saveIdentity, type RelayIdentity } from './relay.ts'

const CLAIM_KEY = 'pathplotter.code-claim.v1'
interface PendingClaim { requestId: string; verifier: string; expiresAt: number }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizePairingCode(value: string): string {
  const trimmed = value.trim()
  if (!/^[A-Za-z]{3}$/.test(trimmed)) throw new Error('Enter exactly three letters from RAP.')
  return trimmed.toUpperCase()
}

export function pendingCodeClaim(storage: Pick<Storage, 'getItem' | 'removeItem'> = localStorage): PendingClaim | null {
  const raw = storage.getItem(CLAIM_KEY)
  if (!raw) return null
  const value: unknown = JSON.parse(raw)
  if (!record(value) || typeof value.requestId !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.requestId) ||
      typeof value.verifier !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.verifier) ||
      typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) throw new Error('Saved code-pairing recovery is invalid. Discard it explicitly before trying a new code.')
  if (value.expiresAt <= Date.now()) { storage.removeItem(CLAIM_KEY); return null }
  return { requestId: value.requestId, verifier: value.verifier, expiresAt: value.expiresAt }
}

export function createCodeClaim(storage: Pick<Storage, 'setItem'> = localStorage): PendingClaim {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const verifier = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  const claim = { requestId: crypto.randomUUID(), verifier, expiresAt: Date.now() + 180000 }
  storage.setItem(CLAIM_KEY, JSON.stringify(claim))
  return claim
}

class PairingError extends Error {
  readonly status: number
  constructor(status: number, code: string) {
    const messages: Record<string, string> = {
      code_pairing_unavailable: 'Code pairing is not enabled. Use the QR/link from RAP instead.',
      code_unavailable: 'Code unavailable, expired or already used. Ask RAP for a new window.',
      code_pairing_busy: 'Code pairing is busy. Wait, or use the QR/link from RAP.',
      code_rate_limited: 'Pairing attempts are limited. Wait at least a minute before trying again.',
      code_claim_unavailable: 'Pairing recovery is unavailable, expired or revoked.',
    }
    super(messages[code] ?? `Pairing failed (${status}): ${code}`)
    this.status = status
  }
}

async function request(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${HOSTED_RELAY}/v1/pairing/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000), cache: 'no-store', referrerPolicy: 'no-referrer',
  })
  const result: unknown = await response.json()
  if (!response.ok) throw new PairingError(response.status, record(result) && typeof result.error === 'string' ? result.error : 'invalid_response')
  return result
}

export function codeClaimIdentity(value: unknown): RelayIdentity | null {
  if (record(value) && value.status === 'pending' && typeof value.phrase === 'string' && /^[A-Za-z0-9 -]{1,120}$/.test(value.phrase)) return null
  if (!record(value) || value.status !== 'complete' || typeof value.relayId !== 'string' ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.relayId) ||
      typeof value.credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.credential)) throw new Error('Invalid code-pairing response. Recover the saved request; do not resubmit the code.')
  return { baseUrl: HOSTED_RELAY, relayId: value.relayId, credential: value.credential }
}

export function setupCodePairing(options: {
  container: HTMLElement
  dialog: HTMLDialogElement
  begin: () => (() => boolean) | null
  connected: (identity: RelayIdentity) => void
  finished: () => void
}): void {
  const section = document.createElement('section')
  section.innerHTML = `
    <h3>Connect with RAP code</h3>
    <p class="hint">In RAP choose Allow code pairing, then enter its three letters within 60 seconds. Compare the phrase shown here with RAP and approve the request there. Internet is required on both devices. Approved browser access stays saved until revoked.</p>
    <label>Three-letter RAP code<input id="rapCode" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="3" placeholder="ABC" /></label>
    <div class="row"><button id="prepareCodePairing">Start code pairing</button><button id="submitCodePairing" class="primary" disabled>Connect with code</button><button id="recoverCodePairing" hidden>Recover pairing</button><button id="discardCodePairing" hidden>Discard recovery</button></div>
    <p id="codePairingMessage" role="status"></p>
  `
  options.container.prepend(section)
  const get = <T extends HTMLElement>(id: string): T => {
    const element = section.querySelector<T>(`#${id}`)
    if (!element) throw new Error(`Missing pairing control: ${id}`)
    return element
  }
  const message = get('codePairingMessage')
  const submit = get<HTMLButtonElement>('submitCodePairing')
  const prepare = get<HTMLButtonElement>('prepareCodePairing')
  const recover = get<HTMLButtonElement>('recoverCodePairing')
  const discard = get<HTMLButtonElement>('discardCodePairing')
  let available = false, busy = false, epoch = 0, lastRecovery = -Infinity
  let waiting: AbortController | null = null
  const update = () => {
    let pending = false
    try { pending = pendingCodeClaim() !== null }
    catch (error) { pending = true; message.textContent = error instanceof Error ? error.message : String(error) }
    submit.disabled = busy || !available || pending
    prepare.disabled = busy || pending
    recover.hidden = discard.hidden = !pending
    recover.disabled = discard.disabled = busy
  }
  const stopWaiting = () => {
    ++epoch
    waiting?.abort()
    waiting = null; available = false; update()
  }
  options.dialog.addEventListener('close', stopWaiting)
  prepare.addEventListener('click', async () => {
    stopWaiting()
    const current = epoch
    busy = true; update(); message.textContent = 'Checking code-pairing availability...'
    try {
      const config = await request('config')
      if (current !== epoch) return
      if (!record(config) || config.enabled !== true || config.approvalRequired !== true) throw new Error('Approval-based code pairing is not enabled. Use Pair phone or Open PathPlotter in RAP instead.')
      available = true
      message.textContent = 'Enable a code window in RAP, enter its three letters, then approve the matching phrase in RAP.'
    } catch (error) { if (current === epoch) message.textContent = error instanceof Error ? error.message : String(error) }
    finally { busy = false; update() }
  })
  const exchange = async (recovery: boolean) => {
    if (busy) return
    const current = epoch
    let active: (() => boolean) | null = null
    let initial = false
    let submitted = false
    try {
      const code = recovery ? '' : normalizePairingCode(get<HTMLInputElement>('rapCode').value)
      if (!recovery && !available) throw new Error('Start code pairing first.')
      if (recovery && performance.now() - lastRecovery < 5000) throw new Error('Wait five seconds before checking recovery again.')
      active = options.begin()
      if (!active) return
      busy = true
      let claim = pendingCodeClaim()
      if (!recovery) {
        if (claim) throw new Error('Recover or explicitly discard the previous request first.')
        claim = createCodeClaim()
        initial = true
      }
      if (!claim) throw new Error('No pending code pairing to recover.')
      update()
      const controller = new AbortController()
      waiting = controller
      message.textContent = recovery ? 'Checking the saved approval request...' : 'Requesting approval in RAP...'
      if (recovery) lastRecovery = performance.now()
      submitted = true
      let result = await request(recovery ? 'claim' : 'code', recovery ? { requestId: claim.requestId, verifier: claim.verifier } :
        { code, requestId: claim.requestId, verifier: claim.verifier })
      if (!active() || current !== epoch) return
      let identity = codeClaimIdentity(result)
      while (!identity) {
        if (!record(result) || typeof result.phrase !== 'string') throw new Error('Invalid approval phrase.')
        message.textContent = `Compare "${result.phrase}" with RAP, then Approve there. Waiting for approval (up to two minutes)...`
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve() }
          const timer = setTimeout(done, 7000)
          controller.signal.addEventListener('abort', done, { once: true })
        })
        if (controller.signal.aborted || !active() || current !== epoch) return
        if (!pendingCodeClaim()) throw new Error('Pairing recovery expired. Request a new code in RAP.')
        lastRecovery = performance.now()
        initial = false
        result = await request('claim', { requestId: claim.requestId, verifier: claim.verifier })
        if (!active() || current !== epoch) return
        identity = codeClaimIdentity(result)
      }
      saveIdentity(identity)
      // Keep recovery data until both the grant and browser identity are persistent.
      localStorage.removeItem(CLAIM_KEY)
      options.connected(identity)
      get<HTMLInputElement>('rapCode').value = ''
      message.textContent = 'Browser paired. Use Take control to capture; another browser will not be displaced automatically.'
    } catch (error) {
      if (current !== epoch || waiting?.signal.aborted) return
      message.textContent = error instanceof Error ? error.message : String(error)
      if (error instanceof PairingError && ((initial && [400, 403, 409, 429, 503].includes(error.status)) || (!initial && error.status === 409))) {
        try { localStorage.removeItem(CLAIM_KEY) }
        catch (storageError) { message.textContent += ` Recovery cleanup failed: ${storageError instanceof Error ? storageError.message : String(storageError)}` }
      } else if (submitted) message.textContent += ' Recovery is saved; use Recover pairing, not the code again.'
    } finally {
      if (active) options.finished()
      busy = false; waiting = null
      update()
    }
  }
  submit.addEventListener('click', () => { void exchange(false) })
  recover.addEventListener('click', () => { void exchange(true) })
  discard.addEventListener('click', () => {
    if (window.confirm('Discard only this pairing recovery? An already-authorized browser remains in RAP until revoked. Saved points and the previous connection are unchanged.')) {
      try { localStorage.removeItem(CLAIM_KEY); update() }
      catch (error) { message.textContent = `Recovery could not be discarded: ${error instanceof Error ? error.message : String(error)}` }
    }
  })
  options.dialog.addEventListener('toggle', update)
  document.querySelector('#connectionMode')?.addEventListener('change', stopWaiting)
  update()
}
