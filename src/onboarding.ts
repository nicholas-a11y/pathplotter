const RELEASES = 'https://github.com/nicholas-a11y/pathplotter/releases'
const RELEASE_API = 'https://api.github.com/repos/nicholas-a11y/pathplotter/releases/latest'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function releaseDownload(value: unknown): string | null {
  if (!record(value) || value.draft !== false || value.prerelease !== false ||
      typeof value.tag_name !== 'string' || !/^rap-v\d+\.\d+\.\d+$/.test(value.tag_name) || !Array.isArray(value.assets)) return null
  for (const asset of value.assets) {
    if (!record(asset) || asset.name !== 'PathPlotter-RAP-Windows.zip' || typeof asset.browser_download_url !== 'string') continue
    const url = new URL(asset.browser_download_url)
    if (url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password &&
        url.pathname.startsWith('/nicholas-a11y/pathplotter/releases/download/') && !url.search && !url.hash) return url.href
  }
  return null
}

async function latestRelease(): Promise<unknown> {
  const response = await fetch(RELEASE_API, { signal: AbortSignal.timeout(10000), cache: 'no-store', referrerPolicy: 'no-referrer' })
  if (!response.ok) throw new Error(`Release check failed (${response.status}).`)
  return response.json()
}

export function setupOnboarding(options: { onUnlink?: () => void } = {}): void {
  const dialog = document.createElement('dialog')
  dialog.id = 'startDialog'
  dialog.setAttribute('aria-labelledby', 'startTitle')
  dialog.innerHTML = `
    <header class="dialog-header"><h2 id="startTitle">Get started with PathPlotter</h2><button id="closeStart">Close</button></header>
    <p>PathPlotter reads the laser head position from LightBurn through <strong>RAP</strong>, a small Windows app that runs beside LightBurn. Any controller LightBurn can report a position for works.</p>
    <section>
      <h3>Set up the LightBurn computer</h3>
      <p id="downloadMessage" role="status">Get the latest RAP download.</p>
      <div class="row"><button id="findRap">Find Windows download</button><a id="downloadRap" hidden>Download RAP ZIP</a><a href="${RELEASES}" target="_blank" rel="noopener noreferrer">View releases</a></div>
      <ol>
        <li>Extract the ZIP to a folder you can write to, such as Documents. Do not run it from inside the ZIP.</li>
        <li>In LightBurn, enable <strong>REST API</strong> under Settings &gt; Extensions. Leave network API access off.</li>
        <li>Double-click <strong>Start RAP.cmd</strong>, paste the <strong>Invitation ID</strong> you were given and click Register. RAP then opens PathPlotter in your browser and pairs it; LightBurn does not need to be ready yet.</li>
        <li>Before capturing, open LightBurn and connect your machine. In RAP click <strong>Request local LightBurn permission</strong> and approve the prompt in LightBurn within 30 seconds (needed once).</li>
        <li>In PathPlotter choose Capture settings, jog the head and press Space to capture points.</li>
      </ol>
      <p class="hint">No administrator access is needed. RAP tells you when an update is available; click <strong>Update now</strong> in RAP to install it.</p>
    </section>
    <section><h3>Use a phone or another browser</h3><p>In RAP choose <strong>Pair phone</strong>, scan the QR code (or open its link), check that the phrase matches, then click <strong>Approve matching phrase</strong> in RAP. Only one browser is connected at a time; pairing a new one replaces the old one. Both devices need internet access, but not the same Wi-Fi.</p></section>
    <section><h3>Already set up?</h3><p>Start RAP and click <strong>Open PathPlotter</strong>, or just open PathPlotter again in a browser that was paired before; it reconnects by itself and asks you if anything needs a decision. RAP runs in the desktop widget area (system tray) — if you don't see its window, look for the tray icon near the clock. If PathPlotter cannot reach RAP, check that RAP is running and the computer is online. If it says LightBurn is not ready, read the reason in the RAP window: LightBurn must be running with its REST API on, RAP must have permission, and a machine must be connected.</p></section>
    ${options.onUnlink ? `<section><h3>This browser</h3><p>Forget this browser's pairing with RAP, for example on a shared computer. Also click <strong>Disconnect</strong> in the RAP window to remove its access on the relay.</p><button id="unlinkBrowser">Unlink this browser</button></section>` : ''}
  `
  document.body.append(dialog)
  const get = <T extends HTMLElement>(id: string): T => {
    const value = dialog.querySelector<T>(`#${id}`)
    if (!value) throw new Error(`Missing setup control: ${id}`)
    return value
  }
  document.querySelector<HTMLButtonElement>('#getStartedBtn')?.addEventListener('click', () => { if (!dialog.open) dialog.showModal() })
  get('closeStart').addEventListener('click', () => dialog.close())
  dialog.querySelector<HTMLButtonElement>('#unlinkBrowser')?.addEventListener('click', () => { dialog.close(); options.onUnlink?.() })
  get<HTMLButtonElement>('findRap').addEventListener('click', async event => {
    const button = event.currentTarget as HTMLButtonElement
    button.disabled = true
    const message = get('downloadMessage'), link = get<HTMLAnchorElement>('downloadRap')
    link.hidden = true
    try {
      const url = releaseDownload(await latestRelease())
      if (!url) throw new Error('No RAP release is available yet. Check View releases or contact the person who invited you.')
      link.href = url
      link.hidden = false
      message.textContent = 'Download the ZIP, extract it, then follow the steps below.'
    } catch (error) { message.textContent = error instanceof Error ? error.message : String(error) }
    finally { button.disabled = false }
  })
}
