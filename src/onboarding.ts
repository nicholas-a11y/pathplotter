import { relayBaseUrl } from './relay.ts'

export const HOSTED_RELAY = 'https://pathplotter-relay-v2.nicholas-leqeta.workers.dev'
const RELEASES = 'https://github.com/nicholas-a11y/pathplotter/releases'
const RELEASE_API = 'https://api.github.com/repos/nicholas-a11y/pathplotter/releases/latest'

interface Turnstile {
  render(container: HTMLElement, options: { sitekey: string; action: string; callback: (token: string) => void; 'expired-callback': () => void; 'error-callback': () => void }): string
  reset(id: string): void
  remove(id: string): void
}

declare global {
  interface Window { turnstile?: Turnstile }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function enrollmentLink(hash: string): { baseUrl: string; requestId: string } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  if (!params.has('enroll')) return null
  if (params.has('invite') || params.has('launch')) throw new Error('Ambiguous setup link.')
  const requestId = params.get('enroll')
  if (!requestId || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('Invalid RAP setup request.')
  const baseUrl = relayBaseUrl(params.get('relay') ?? HOSTED_RELAY)
  if (baseUrl !== HOSTED_RELAY && !['localhost', '127.0.0.1'].includes(new URL(baseUrl).hostname)) {
    throw new Error('This setup link is not for the published PathPlotter service.')
  }
  return { baseUrl, requestId }
}

export function releaseDownload(value: unknown): string | null {
  if (!record(value) || value.draft !== false || value.prerelease !== false ||
      typeof value.tag_name !== 'string' || !value.tag_name.startsWith('rap-v2.') || !Array.isArray(value.assets)) return null
  for (const asset of value.assets) {
    if (!record(asset) || asset.name !== 'PathPlotter-RAP-Windows.zip' || typeof asset.browser_download_url !== 'string') continue
    const url = new URL(asset.browser_download_url)
    if (url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password &&
        url.pathname.startsWith('/nicholas-a11y/pathplotter/releases/download/') && !url.search && !url.hash) return url.href
  }
  return null
}

async function json(url: string, body?: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000), cache: 'no-store', referrerPolicy: 'no-referrer',
  })
  const value: unknown = await response.json()
  if (!response.ok) throw new Error(record(value) && typeof value.error === 'string' ? value.error : `Setup request failed (${response.status}).`)
  return value
}

let turnstileLoading: Promise<void> | null = null
export function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve()
  if (!turnstileLoading) {
    turnstileLoading = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
      script.async = true
      const timeout = setTimeout(() => { script.remove(); reject(new Error('Verification could not load. Check your connection and reopen setup.')) }, 10000)
      script.onload = () => { clearTimeout(timeout); resolve() }
      script.onerror = () => { clearTimeout(timeout); script.remove(); reject(new Error('Verification could not load. Check your network or content blocker.')) }
      document.head.append(script)
    }).catch(error => { turnstileLoading = null; throw error })
  }
  return turnstileLoading
}

export function setupOnboarding(options: { fallback: () => void; sockets: () => void; canChangeTransport: () => boolean; status: (text: string) => void }): void {
  const dialog = document.createElement('dialog')
  dialog.id = 'startDialog'
  dialog.setAttribute('aria-labelledby', 'startTitle')
  dialog.innerHTML = `
    <header class="dialog-header"><h2 id="startTitle">Get started with PathPlotter</h2><button id="closeStart">Close</button></header>
    <p>PathPlotter is a free service. For ordinary browsers and phones, the Windows RAP connector runs beside LightBurn. Inside LightBurn as a Webtool, use the direct connection instead.</p>
    <section><h3>Using LightBurn's built-in Webtool browser</h3><p>Open PathPlotter inside LightBurn, then choose <strong>Connection &gt; LightBurn Webtool (direct API, no RAP)</strong>. Enable REST API in LightBurn, leave network API access off, and click Connect. Leave the secret blank to request permission and approve in LightBurn. Capture, preview and SVG imports use the local API directly; no RAP, relay enrollment or cloud pairing is required. This depends on LightBurn's embedded browser permitting local API requests; ordinary hosted browsers may block them.</p></section>
    <section>
      <h3>Set up a Windows LightBurn computer</h3>
      <p id="downloadMessage" role="status">Check for a compatible portable RAP download.</p>
      <div class="row"><button id="findRap">Find Windows download</button><a id="downloadRap" hidden>Download RAP ZIP</a><a href="${RELEASES}" target="_blank" rel="noopener noreferrer">View releases</a></div>
      <ol>
        <li>Download the ZIP and extract the complete folder somewhere writable. Do not run it inside the ZIP.</li>
        <li>Open LightBurn. Enable REST API in Settings &gt; Extensions; keep Allow API Access From Network off.</li>
        <li>Double-click <strong>Start RAP.cmd</strong>. Choose guided setup, compare its setup phrase with the browser, enter the enrollment code and complete verification.</li>
        <li>In RAP, request local LightBurn permission. Bring LightBurn forward and approve within 30 seconds.</li>
        <li>RAP opens PathPlotter when ready. Choose Capture settings, position the head using normal controls, then Capture point.</li>
      </ol>
      <p class="hint">No administrator access or extra runtime installation is normally needed. This page cannot install or start RAP automatically. If Windows or your organization blocks scripts, follow its approved procedure; do not disable protections.</p>
    </section>
    <section><h3>Connect a phone or another browser</h3><p>Start RAP on the Windows LightBurn computer. Choose <strong>Open PathPlotter</strong> for that computer's browser. For a phone or another browser, choose <strong>Pair phone</strong>, scan its QR or open its private link, compare the phrase, then approve in RAP. The link contains all pairing details; no manual codes are needed. Both devices need internet, but not the same Wi-Fi. Browser access stays saved until revoked in RAP.</p></section>
    <section><h3>Already set up?</h3><p>Use <strong>Open PathPlotter</strong> in RAP, or Pair in Connection. A disconnected browser cannot tell whether RAP is missing or just offline. Check RAP, LightBurn and your network first.</p></section>
    <section id="enrollSection" hidden>
      <h3>Authorize this RAP setup</h3><p id="enrollDescription"></p>
      <label class="check"><input id="enrollMatch" type="checkbox"> This computer name and phrase match the setup shown in RAP.</label>
      <label>Enrollment code<input id="enrollCode" type="password" autocomplete="off" maxlength="256"></label>
      <div id="enrollWidget"></div>
      <button id="approveEnrollment" disabled>Approve matching RAP setup</button>
      <p id="enrollMessage" role="status"></p>
    </section>
    <details><summary>Connection troubleshooting</summary><p>If your network blocks WebSockets, you can explicitly choose slower HTTP communication here and in RAP. Responses may take several seconds; no uncertain artwork is automatically resent.</p><div class="row"><button id="httpFallback">Use slower HTTP connection</button><button id="socketConnection">Use WebSockets</button></div></details>
  `
  document.body.append(dialog)
  const get = <T extends HTMLElement>(id: string): T => {
    const value = dialog.querySelector<T>(`#${id}`)
    if (!value) throw new Error(`Missing setup control: ${id}`)
    return value
  }
  let widget: string | null = null
  let token = ''
  let setupEpoch = 0
  let current: ReturnType<typeof enrollmentLink> = null
  const approve = get<HTMLButtonElement>('approveEnrollment')
  const updateApproval = () => { approve.disabled = !current || !token || !get<HTMLInputElement>('enrollMatch').checked || !get<HTMLInputElement>('enrollCode').value.trim() }
  const clearWidget = () => {
    if (widget !== null) window.turnstile?.remove(widget)
    widget = null
    token = ''
    updateApproval()
  }
  const open = () => { if (!dialog.open) dialog.showModal() }
  document.querySelector<HTMLButtonElement>('#getStartedBtn')?.addEventListener('click', open)
  get('closeStart').addEventListener('click', () => dialog.close())
  dialog.addEventListener('close', () => {
    ++setupEpoch
    clearWidget()
    get<HTMLInputElement>('enrollCode').value = ''
    if (current) get('enrollMessage').textContent = 'Setup closed. Return to RAP and reopen its setup link to continue.'
    current = null
    updateApproval()
  })
  get('enrollMatch').addEventListener('change', updateApproval)
  get('enrollCode').addEventListener('input', updateApproval)
  get('httpFallback').addEventListener('click', () => {
    if (!options.canChangeTransport()) { options.status('Wait for current work and reconcile pending imports before changing transport.'); return }
    options.fallback()
  })
  get('socketConnection').addEventListener('click', () => {
    if (!options.canChangeTransport()) { options.status('Wait for current work and reconcile pending imports before changing transport.'); return }
    options.sockets()
  })
  get<HTMLButtonElement>('findRap').addEventListener('click', async event => {
    const button = event.currentTarget as HTMLButtonElement
    button.disabled = true
    const message = get('downloadMessage'), link = get<HTMLAnchorElement>('downloadRap')
    link.hidden = true
    try {
      const url = releaseDownload(await json(RELEASE_API))
      if (!url) throw new Error('No compatible public RAP release is available yet. Check View releases or contact the operator.')
      link.href = url
      link.hidden = false
      message.textContent = 'Download the ZIP, extract it, then start RAP using the steps below.'
    } catch (error) { message.textContent = error instanceof Error ? error.message : String(error) }
    finally { button.disabled = false }
  })
  approve.addEventListener('click', async () => {
    if (!current || approve.disabled) return
    const link = current, epoch = setupEpoch
    approve.disabled = true
    const message = get('enrollMessage')
    try {
      await json(`${link.baseUrl}/v1/enrollment/${encodeURIComponent(link.requestId)}/approve`, {
        code: get<HTMLInputElement>('enrollCode').value, turnstileToken: token,
      })
      if (epoch !== setupEpoch) return
      message.textContent = 'Setup authorized. Return to RAP to finish registration and approve LightBurn access. This browser has not received RAP credentials.'
      get<HTMLInputElement>('enrollCode').value = ''
      current = null
    } catch (error) { if (epoch === setupEpoch) message.textContent = error instanceof Error ? error.message : String(error) }
    finally {
      if (epoch === setupEpoch) {
        token = ''
        if (widget !== null) window.turnstile?.reset(widget)
        updateApproval()
      }
    }
  })
  const consume = async () => {
    const link = enrollmentLink(location.hash)
    if (!link) return
    history.replaceState(null, '', location.pathname + location.search)
    clearWidget()
    current = link
    const epoch = ++setupEpoch
    get('enrollSection').hidden = false
    get<HTMLInputElement>('enrollMatch').checked = false
    get<HTMLInputElement>('enrollCode').value = ''
    get('enrollMessage').textContent = 'Checking this setup request...'
    open()
    try {
      const [config, request] = await Promise.all([
        json(`${link.baseUrl}/v1/enrollment/config`), json(`${link.baseUrl}/v1/enrollment/${encodeURIComponent(link.requestId)}`),
      ])
      if (epoch !== setupEpoch) return
      if (!record(config) || config.enabled !== true || typeof config.siteKey !== 'string' || !config.siteKey) {
        throw new Error('Guided enrollment is not available yet. Contact the operator; existing paired connections can still be used.')
      }
      if (!record(request) || typeof request.name !== 'string' || typeof request.phrase !== 'string' ||
          typeof request.expiresAt !== 'number' || !Number.isFinite(request.expiresAt) || request.status !== 'pending') {
        throw new Error('This setup request is unavailable, already approved or expired. Return to RAP for recovery or a new setup request.')
      }
      get('enrollDescription').textContent = `${request.name} - ${request.phrase}. Compare both with RAP before approving.`
      await loadTurnstile()
      if (epoch !== setupEpoch) return
      if (!window.turnstile) throw new Error('Verification did not initialize. Check your network or content blocker and reopen setup.')
      widget = window.turnstile.render(get('enrollWidget'), {
        sitekey: config.siteKey, action: 'enrollment',
        callback: value => { if (epoch === setupEpoch) { token = value; updateApproval() } },
        'expired-callback': () => { if (epoch === setupEpoch) { token = ''; updateApproval(); get('enrollMessage').textContent = 'Verification expired. Complete it again.' } },
        'error-callback': () => { if (epoch === setupEpoch) { token = ''; updateApproval(); get('enrollMessage').textContent = 'Verification failed. Check your network and retry setup.' } },
      })
      get('enrollMessage').textContent = 'Confirm the matching RAP phrase, enter the code and complete verification.'
    } catch (error) {
      if (epoch !== setupEpoch) return
      current = null
      get('enrollMessage').textContent = error instanceof Error ? error.message : String(error)
      updateApproval()
    }
  }
  window.addEventListener('hashchange', () => { void consume().catch(error => options.status(error instanceof Error ? error.message : String(error))) })
  void consume().catch(error => {
    history.replaceState(null, '', location.pathname + location.search)
    options.status(error instanceof Error ? error.message : String(error))
  })
}
