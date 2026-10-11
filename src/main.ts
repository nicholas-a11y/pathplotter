import './style.css'
import { captureGroups, allPoints, finishCapture, type Collection, type CaptureGroup, type Point, type ShapeType } from './capture-groups'
import { layerPalette, isLayerColor } from './layer-palette'
import { SettledPosition } from './settled-position'
import { RelayClient, RelayRequestError, loadIdentity, saveIdentity, browserLink, exchangeBrowserLink, relayBaseUrl, parseJob, type BrowserLink } from './relay'
import { appendCollectionPrimitives, primitiveBounds, hasEnoughPoints, serializeSvg, buildDelta, fmt, type BuiltSvg, type Primitive } from './geometry'
import { LIVE_QUEUE_LIMIT, emptyLiveQueue, makeUpdate, enqueue, recordOutcome, parseLiveQueue, type LiveUpdate, type ImportTarget, type LiveQueue } from './live-updates'
import { openImportStream, type ImportResult } from './import-stream'

interface LivePosition {
  x: number
  y: number
  updatedAt: number
}

const CAPABILITIES = ['state', 'project', 'upload']
const STORAGE_KEY = 'pathplotter.collection.v3'

function colorPicker(inputId: string, label: string): string {
  return `<div class="color-picker-field">
    <span>${label}</span>
    <input id="${inputId}" type="hidden" />
    <details class="color-picker" data-color-input="${inputId}">
      <summary aria-label="${label} picker"><span class="selected-color-swatch"></span><span class="selected-color-label"></span></summary>
      <div class="layer-palette" role="group" aria-label="${label} LightBurn colours">
        ${layerPalette.map(entry => `<button type="button" data-layer-color="${entry.color}" aria-label="Layer ${entry.label}, ${entry.color}" aria-pressed="false" title="Layer ${entry.label} · ${entry.color}" style="background:${entry.color};color:${entry.textColor}">${entry.label}</button>`).join('')}
      </div>
    </details>
    <p class="color-picker-message hint" role="status"></p>
  </div>`
}

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) {
  throw new Error('App root not found')
}

app.innerHTML = `
  <header class="app-header">
    <h1>PathPlotter</h1>
    <span id="collectionSummary"></span>
    <div class="status-chip" id="connectionState">Disconnected</div>
    <button id="connectionBtn" class="secondary">Connection</button>
  </header>

  <nav class="toolbar" aria-label="Capture actions">
    <button id="captureBtn" class="primary">Capture point</button>
    <button id="quickControlBtn" class="primary" hidden>Take control</button>
    <button id="finishBtn">Finish</button>
    <button id="undoBtn" class="secondary">Undo</button>
    <button id="settingsBtn" class="secondary">Capture settings</button>
    <button id="pointsBtn" class="secondary">Edit points</button>
    <button id="clearBtn" class="secondary">Clear points</button>
  </nav>
  <section class="live-update-bar" aria-label="Live update controls">
    <label class="check"><input id="liveUpdateToggle" type="checkbox" />Live update to LightBurn</label>
    <span id="liveUpdateStatus" role="status">Off. Enable at a new group to append circles or segments.</span>
    <button id="liveCheckBtn" class="secondary" hidden>Check live import</button>
    <button id="liveResumeBtn" class="secondary" hidden>Resume queued updates</button>
    <button id="liveReconcileBtn" class="secondary" hidden>Acknowledge import outcome</button>
    <button id="liveAbandonBtn" class="danger" hidden>Abandon unsent updates</button>
  </section>
  <div class="workspace-status">
    <p id="statusText" role="status">Ready. Connect to LightBurn to capture.</p>
    <p id="liveText">No head position available.</p>
  </div>
  <section class="plot-shell" aria-label="Workpiece workspace">
    <svg id="plot" role="img" aria-label="Workpiece coordinates plot"></svg>
  </section>
  <footer class="export-bar">
    <span class="hint">mm · +X right · +Y up</span>
    <button id="downloadSvgBtn" class="secondary">Download SVG</button>
    <button id="sendBtn" class="primary">Send to LightBurn</button>
    <button id="sessionBtn" class="secondary">Session</button>
    <p id="exportStatus" role="status"></p>
  </footer>

  <dialog id="connectionDialog" aria-labelledby="connectionTitle">
    <header class="dialog-header">
      <h2 id="connectionTitle">Connection</h2>
      <button data-close="connectionDialog" aria-label="Close connection">Close</button>
    </header>
    <label>Connection type
      <select id="connectionMode">
        <option value="relay">Cloud relay (RAP)</option>
        <option value="local">Local development connection</option>
      </select>
    </label>
    <section id="relayConnection">
      <p class="hint">Double-click RAP to open and connect this computer. For a phone, use Pair phone in RAP, scan its QR and click Approve on the desktop. Capture control is automatic when free.</p>
      <label>Relay API URL<input id="relayUrl" type="url" placeholder="https://pathplotter-relay.example.workers.dev" /></label>
      <label>Relay ID<input id="relayId" /></label>
      <label>Pairing invitation<input id="relayInvitation" type="password" autocomplete="off" /></label>
      <div class="row">
        <button id="pairRelayBtn" class="primary">Pair</button>
      </div>
      <p id="relayMessage" role="status"></p>
      <details>
        <summary>Advanced / recovery</summary>
        <p class="hint">Only needed when changing workspace, recovering an interrupted import, or removing this browser's connection. These actions never move points or resend artwork.</p>
        <div class="row">
        <button id="unlinkRelayBtn">Unlink this browser</button>
        <button id="revalidateBtn">Confirm workspace for existing points</button>
        <button id="checkImportBtn">Check last import</button>
        <button id="resolveImportBtn">Acknowledge uncertain import</button>
      </div>
      </details>
    </section>
    <section id="localConnection">
    <div class="form-grid">
      <label>LightBurn base URL
        <input id="baseUrl" type="url" value="http://localhost:19520" />
      </label>
      <label>Shared secret
        <input id="secret" type="password" placeholder="Optional: paste an existing secret" />
      </label>
      <label>Application name
        <input id="applicationName" type="text" value="PathPlotter" />
      </label>
    </div>
    <p class="hint">Pair on the LightBurn computer. The local development proxy avoids CORS restrictions; hosted and phone access need a secure connector.</p>
    <p class="hint">Connect uses the entered secret, or pairs locally if blank. For pairing, bring LightBurn to the foreground (click its window or use Alt+Tab) and approve within 30 seconds. Clear an invalid secret to pair again. Live preview starts automatically.</p>
    <div class="row">
      <button id="connectBtn" class="primary">Connect</button>
    </div>
    <p id="connectionMessage" role="status"></p>
    </section>
  </dialog>

  <dialog id="settingsDialog" aria-labelledby="settingsTitle">
    <form id="settingsForm">
      <header class="dialog-header">
        <h2 id="settingsTitle">Capture settings</h2>
        <button type="button" data-close="settingsDialog">Cancel</button>
      </header>
      <div class="form-grid">
      <label>Shape
        <select id="shapeType">
          <option value="circles">Circles (one circle per point)</option>
          <option value="polyline">Polyline (open path)</option>
          <option value="polygon">Polygon (closed path)</option>
        </select>
      </label>
      ${colorPicker('strokeColor', 'Geometry colour')}
      <label id="diameterField">Circle diameter (mm)<input id="circleDiameterMm" type="number" min="0.01" step="any" required /></label>
      </div>
      <fieldset>
        <legend>Point labels</legend>
        <div class="row">
          <label class="check"><input id="showNumbers" type="checkbox" /> Numbers</label>
          <label class="check"><input id="showNames" type="checkbox" /> Point names</label>
        </div>
        <div class="form-grid">
          ${colorPicker('labelColor', 'Label colour')}
          <label>Label height (mm)<input id="labelHeightMm" type="number" min="0.2" step="any" required /></label>
          <label>Label offset X (mm)<input id="labelOffsetX" type="number" step="any" required /></label>
          <label>Label offset Y (mm)<input id="labelOffsetY" type="number" step="any" required /></label>
        </div>
      </fieldset>
      <p class="hint">Finish locks the current group's shape and settings. Resume starts a new group using these settings. Finished points remain editable. Space captures; Enter finishes outside dialogs and text fields.</p>
      <button type="submit" class="primary">Apply settings</button>
    </form>
  </dialog>

  <dialog id="pointsDialog" aria-labelledby="pointsTitle">
    <header class="dialog-header">
      <h2 id="pointsTitle">Edit points</h2>
      <button data-close="pointsDialog">Close</button>
    </header>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Group</th>
            <th>#</th>
            <th>Name</th>
            <th>X (mm)</th>
            <th>Y (mm)</th>
            <th>Label ΔX</th>
            <th>Label ΔY</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="pointsTable"></tbody>
      </table>
    </div>
    <p class="hint">Coordinate edits change geometry only, not the machine position.</p>
  </dialog>

  <dialog id="sessionDialog" aria-labelledby="sessionTitle">
    <header class="dialog-header">
      <h2 id="sessionTitle">Session backup</h2>
      <button data-close="sessionDialog">Close</button>
    </header>
    <p class="hint">All finished groups and the current capture are saved in this browser. Session files contain points and settings, never pairing credentials. Version 2 single-collection backups can also be imported.</p>
    <div class="row">
      <button id="saveSessionBtn" class="secondary">Export session JSON</button>
      <label>Import collection JSON<input id="loadSessionInput" type="file" accept="application/json" /></label>
    </div>
    <p id="sessionMessage" role="status"></p>
  </dialog>
`

const baseUrlInput = must<HTMLInputElement>('baseUrl')
if (import.meta.env.DEV) {
  baseUrlInput.value = `${location.origin}/lightburn`
}
const secretInput = must<HTMLInputElement>('secret')
const appNameInput = must<HTMLInputElement>('applicationName')
const connectionStateEl = must<HTMLDivElement>('connectionState')
const statusTextEl = must<HTMLParagraphElement>('statusText')
const liveTextEl = must<HTMLParagraphElement>('liveText')
const plotEl = must<SVGSVGElement>('plot')
const pointsTableEl = must<HTMLTableSectionElement>('pointsTable')
const exportStatusEl = must<HTMLParagraphElement>('exportStatus')

let savedStateError = ''
let state: Collection = loadState()
let liveEnabled = false
let liveTarget: ImportTarget | null = null
let liveDispatching = false
let liveRecoveryInFlight = false
let releaseLiveLock: (() => void) | null = null
let otherTabOwnsLive = captureGroups(state).some(group => group.liveLocked) || !!state.liveQueue?.items.length
let localContextRevision: string | null = null
if (state.liveQueue?.items.length) state.liveQueue.paused = 'Saved updates found. Check the last import, then explicitly resume or abandon.'
let livePosition: LivePosition | null = null
const settledPosition = new SettledPosition()
let localObservationSequence = 0
let settledRelayContext: string | null = null
let pollHandle: number | null = null
let requestInFlight = false
let uploadInFlight = false
let connectionInFlight = false
let workspaceSize: { x: number; y: number } | null = null
let connectionCloseTimer: number | null = null
let relay: RelayClient | null = null
let mode: 'relay' | 'local' = import.meta.env.DEV ? 'local' : 'relay'
if (state.liveQueue?.items[0]) mode = state.liveQueue.items[0].target.mode
let pairingEpoch = 0
const PENDING_IMPORT_KEY = 'pathplotter.relay.pending-import.v1'
let pendingImport: { id: string; relayId: string } | null = null
try {
  const raw = localStorage.getItem(PENDING_IMPORT_KEY)
  if (raw) {
    const saved: unknown = JSON.parse(raw)
    if (!isRecord(saved) || typeof saved.id !== 'string' || typeof saved.relayId !== 'string') {
      throw new Error('Saved relay import journal is invalid. Do not send until you verify the last import in RAP.')
    }
    pendingImport = { id: saved.id, relayId: saved.relayId }
  }
} catch (error) {
  pendingImport = { id: 'unreadable-journal', relayId: '' }
  setExportStatus(errorToMessage(error))
}
const savedLiveHead = state.liveQueue?.items[0]
if (savedLiveHead && savedLiveHead.id === pendingImport?.id) savedLiveHead.phase = 'submitted'
const modeInput = must<HTMLSelectElement>('connectionMode')
modeInput.value = mode

function liveQueue(): LiveQueue { return state.liveQueue ?? emptyLiveQueue() }
async function acquireLiveLock(): Promise<void> {
  if (releaseLiveLock) return
  if (!navigator.locks) throw new Error('This browser cannot safely lock live updates across tabs. Use a browser with Web Locks support.')
  await new Promise<void>((resolve, reject) => {
    void navigator.locks.request('pathplotter-live-update', { ifAvailable: true }, async lock => {
      if (!lock) { reject(new Error('Another PathPlotter tab owns Live update. Close or reconcile it first.')); return }
      await new Promise<void>(release => { releaseLiveLock = release; resolve() })
      releaseLiveLock = null
    }).catch(reject)
  })
}
function liveOwnsWork(): boolean { return otherTabOwnsLive || liveEnabled || liveQueue().items.length > 0 || !!liveQueue().paused }
function liveCaptureBlocked(): boolean {
  return otherTabOwnsLive || liveRecoveryInFlight || !!liveQueue().paused || (liveEnabled && liveQueue().items.length >= LIVE_QUEUE_LIMIT)
}
function liveFinishBlocked(): boolean {
  if (otherTabOwnsLive || liveRecoveryInFlight || liveQueue().paused) return true
  return liveEnabled && liveQueue().items.length >= LIVE_QUEUE_LIMIT && !state.finished && !!buildDelta(state, 'finish')
}
function unlockLiveGroups(next: Collection): void {
  if (!liveEnabled && !next.liveQueue?.items.length && !next.liveQueue?.paused) {
    for (const group of captureGroups(next)) delete group.liveLocked
  }
}
function commitCollection(next: Collection): void {
  unlockLiveGroups(next)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  state = next
  renderAll()
  if (!liveOwnsWork()) releaseLiveLock?.()
}

async function currentImportTarget(): Promise<ImportTarget> {
  if (mode === 'relay') {
    requireRelayContext()
    if (!relay?.snapshot?.context) throw new Error('No fresh relay workspace.')
    return { mode, baseUrl: relay.identity.baseUrl, relayId: relay.identity.relayId, contextRevision: relay.snapshot.context.revision }
  }
  await fetchStatus()
  if (!localContextRevision) throw new Error('LightBurn workspace identity is unavailable.')
  return { mode, baseUrl: normalizeBaseUrl(baseUrlInput.value), contextRevision: localContextRevision }
}

async function verifyImportTarget(target: ImportTarget): Promise<void> {
  if (mode !== target.mode || (mode === 'local' && normalizeBaseUrl(baseUrlInput.value) !== target.baseUrl) ||
      (mode === 'relay' && (relay?.identity.baseUrl !== target.baseUrl || relay.identity.relayId !== target.relayId))) {
    throw new Error('Reconnect to the original Live update destination; queued artwork must not be retargeted.')
  }
  const current = await currentImportTarget()
  if (current.contextRevision !== target.contextRevision) throw new Error('LightBurn workspace changed. Inspect it before abandoning or continuing live work.')
}

must<HTMLInputElement>('liveUpdateToggle').addEventListener('change', async event => {
  const toggle = event.currentTarget as HTMLInputElement
  if (!toggle.checked) {
    liveEnabled = false
    const next = structuredClone(state)
    try { commitCollection(next) }
    catch (error) { setStatus(`Cannot save Live update state: ${errorToMessage(error)}`) }
    renderControls()
    void drainLiveQueue()
    return
  }
  try {
    if (requestInFlight || uploadInFlight || pendingImport || liveQueue().items.length || liveQueue().paused) {
      throw new Error('Resolve pending imports and wait for current work before enabling Live update.')
    }
    if (state.points.length) throw new Error('Finish the existing capture, then enable Live update at a new group.')
    requestInFlight = true
    renderControls()
    await acquireLiveLock()
    liveTarget = await currentImportTarget()
    if (!window.confirm('Live update adds new circles/segments to the current LightBurn project. Sent points cannot be deleted or updated through the API. Avoid other imports while this mode is active. Enable?')) return
    liveEnabled = true
    const next = structuredClone(state)
    next.liveQueue = emptyLiveQueue()
    commitCollection(next)
  } catch (error) { liveEnabled = false; setStatus(errorToMessage(error)) }
  finally { requestInFlight = false; toggle.checked = liveEnabled; if (!liveOwnsWork()) releaseLiveLock?.(); renderControls() }
})

async function drainLiveQueue(): Promise<void> {
  if (liveRecoveryInFlight || liveDispatching || uploadInFlight || liveQueue().paused || !liveQueue().items.length) return
  liveDispatching = true
  uploadInFlight = true
  renderControls()
  try {
    await acquireLiveLock()
    while (liveQueue().items.length && !liveQueue().paused) {
      const update = liveQueue().items[0]!
      if (update.phase !== 'queued') throw new Error('Check and reconcile the submitted live import before continuing.')
      const result = await submitImport(update, () => {
        const next = structuredClone(state)
        const head = next.liveQueue?.items[0]
        if (!head || head.id !== update.id) throw new Error('Live queue changed before submission.')
        head.phase = 'submitted'
        for (const group of captureGroups(next)) if (group.liveLocked) group.liveImported = true
        commitCollection(next)
      })
      const next = structuredClone(state)
      if (!next.liveQueue) throw new Error('Live journal is missing.')
      recordOutcome(next.liveQueue, update.id, result.status, result.error)
      commitCollection(next)
    }
  } catch (error) {
    const next = structuredClone(state)
    next.liveQueue ??= emptyLiveQueue()
    next.liveQueue.paused = errorToMessage(error)
    try { commitCollection(next) }
    catch (saveError) {
      state.liveQueue = next.liveQueue
      setStatus(`Live update stopped; journal save failed: ${errorToMessage(saveError)}. Inspect LightBurn before reloading.`)
    }
  } finally {
    uploadInFlight = false
    liveDispatching = false
    renderAll()
  }
}

must<HTMLButtonElement>('liveCheckBtn').addEventListener('click', async () => {
  const head = liveQueue().items[0]
  if (!head || liveDispatching || liveRecoveryInFlight) return
  liveRecoveryInFlight = true
  renderControls()
  try {
    await acquireLiveLock()
    if (head.target.mode !== 'relay') throw new Error('Local imports have no queryable result. Inspect LightBurn and acknowledge the outcome.')
    const client = relay
    if (!client || client.identity.relayId !== head.target.relayId || client.identity.baseUrl !== head.target.baseUrl) throw new Error('Reconnect to the original relay to check this import.')
    const job = parseJob(await client.request(`/jobs/${encodeURIComponent(head.id)}`))
    const result = await followRelayJob(client, job, head.id)
    const next = structuredClone(state)
    if (!next.liveQueue) throw new Error('Live queue is missing.')
    recordOutcome(next.liveQueue, head.id, result.status, result.error)
    next.liveQueue.paused ||= 'Import checked. Explicitly resume remaining queued updates.'
    commitCollection(next)
    if (result.status !== 'unknown' && pendingImport?.id === head.id) clearPendingImport()
  } catch (error) { setStatus(`Live import check: ${errorToMessage(error)}`) }
  finally { liveRecoveryInFlight = false; renderAll() }
})
must<HTMLButtonElement>('liveResumeBtn').addEventListener('click', async () => {
  if (liveRecoveryInFlight || liveDispatching || requestInFlight || pendingImport) { setStatus('Resolve the saved import before resuming the live queue.'); return }
  liveRecoveryInFlight = true
  renderControls()
  try {
    await acquireLiveLock()
    const head = liveQueue().items[0]
    if (head && head.phase !== 'queued') throw new Error('Check or acknowledge the previous import first. It will not be resent.')
    if (head) await verifyImportTarget(head.target)
    if (!window.confirm('Continue sending saved updates to their original LightBurn workspace? No previously submitted update will be retried.')) return
    const next = structuredClone(state)
    next.liveQueue ??= emptyLiveQueue()
    next.liveQueue.paused = ''
    commitCollection(next)
  } catch (error) { setStatus(errorToMessage(error)) }
  finally { liveRecoveryInFlight = false; renderControls(); void drainLiveQueue() }
})
must<HTMLButtonElement>('liveReconcileBtn').addEventListener('click', async () => {
  const head = liveQueue().items[0]
  if (!head || head.phase === 'queued' || liveDispatching || liveRecoveryInFlight) return
  if (!window.confirm(`Inspect RAP/LightBurn for import ${head.id}. Acknowledge its outcome and remove it from the queue WITHOUT resending it? Missing geometry must be corrected manually. Remaining updates stay paused.`)) return
  liveRecoveryInFlight = true
  renderControls()
  try {
    await acquireLiveLock()
    if (head.target.mode === 'relay') {
      if (!head.target.relayId) throw new Error('Saved update has no original RAP identifier.')
      await acknowledgeRelayImport(head.id, head.target.relayId, head.target.baseUrl)
    }
    const next = structuredClone(state)
    next.liveQueue!.items.shift()
    next.liveQueue!.paused = 'Outcome acknowledged without retry. Explicitly resume remaining updates.'
    commitCollection(next)
    if (pendingImport?.id === head.id) clearPendingImport()
  } catch (error) { setStatus(errorToMessage(error)) }
  finally { liveRecoveryInFlight = false; renderControls() }
})
must<HTMLButtonElement>('liveAbandonBtn').addEventListener('click', async () => {
  if (liveRecoveryInFlight || liveDispatching || requestInFlight) return
  const head = liveQueue().items[0]
  if (head && head.phase !== 'queued') { setStatus('Check or acknowledge the submitted import before abandoning unsent updates.'); return }
  if (!window.confirm('Abandon unsent updates? Captured points stay saved. Objects already imported into LightBurn are NOT removed.')) return
  try {
    await acquireLiveLock()
    liveEnabled = false
    const next = structuredClone(state)
    next.liveQueue = emptyLiveQueue()
    commitCollection(next)
    savedStateError = ''
    setStatus('Unsent updates abandoned. Point edits now affect PathPlotter only, not LightBurn.')
  } catch (error) { setStatus(errorToMessage(error)) }
})
window.addEventListener('storage', async event => {
  if (event.key !== STORAGE_KEY) return
  liveEnabled = false
  otherTabOwnsLive = true
  renderControls()
  try {
    if (liveDispatching) throw new Error('Saved live state changed in another tab during import. Inspect LightBurn; do not resend.')
    const locks = await navigator.locks?.query()
    otherTabOwnsLive = locks?.held?.some(lock => lock.name === 'pathplotter-live-update') ?? false
    state = loadState()
    if (state.liveQueue?.items.length) state.liveQueue.paused = 'Saved state changed in another tab. Check the import before resuming.'
    if (otherTabOwnsLive) setStatus('Another tab owns Live update. Use that tab until it finishes or closes.')
    renderAll()
  } catch (error) { setStatus(errorToMessage(error)) }
})

function updateConnectionMode(): void {
  must<HTMLElement>('relayConnection').hidden = mode !== 'relay'
  must<HTMLElement>('localConnection').hidden = mode !== 'local'
  if (pollHandle !== null) {
    window.clearInterval(pollHandle)
    pollHandle = null
  }
  relay?.stop()
  livePosition = null
  settledPosition.reset()
  settledRelayContext = null
  workspaceSize = null
  connectionStateEl.textContent = 'Disconnected'
  connectionStateEl.classList.remove('ok')
  if (mode === 'relay') relay?.start()
  renderAll()
}

function relayChanged(): void {
  if (mode !== 'relay') return
  const snapshot = relay?.snapshot
  const fresh = relay?.canCapture() === true
  if ((liveEnabled || (liveQueue().items.length > 0 && !liveQueue().paused)) && relay?.controlError && !relay.activeBrowser) {
    liveEnabled = false
    const next = structuredClone(state)
    next.liveQueue ??= emptyLiveQueue()
    next.liveQueue.paused = 'Capture control was lost. Reacquire it explicitly, then reconcile or resume queued updates.'
    try { commitCollection(next) }
    catch (error) { state.liveQueue = next.liveQueue; setStatus(`Live work paused; cannot save: ${errorToMessage(error)}`) }
  }
  const relayContext = snapshot && relay ? `${relay.identity.relayId}:${snapshot.generation}:${snapshot.context?.revision}` : null
  if (!fresh || relayContext !== settledRelayContext) settledPosition.reset()
  settledRelayContext = relayContext
  if (fresh && snapshot?.position) {
    settledPosition.observe(`${snapshot.generation}:${snapshot.sequence}`, snapshot.position.x, snapshot.position.y)
  }
  livePosition = fresh && snapshot?.position ? { ...snapshot.position, updatedAt: Date.now() } : null
  workspaceSize = snapshot?.context?.size ?? null
  connectionStateEl.textContent = fresh ? 'Ready to capture' : relay?.hasFreshPosition() ? 'Read-only · Take control' : 'Capture unavailable'
  connectionStateEl.classList.toggle('ok', fresh)
  liveTextEl.textContent = relay?.error ? `Relay: ${relay.error}` :
    snapshot?.position ? `Latest reported: X ${snapshot.position.x.toFixed(3)}, Y ${snapshot.position.y.toFixed(3)} mm · age ${(relay!.age() / 1000).toFixed(1)} s${fresh ? '' : ' · stale, offline or another browser has control'}` :
    'Waiting for a fresh RAP workpiece position.'
  if (relay?.controlError) must<HTMLElement>('relayMessage').textContent = relay.controlError
  renderControls()
  renderPlot()
}

function contextKey(): string | null {
  return relay?.snapshot?.context ? `${relay.identity.relayId}:${relay.snapshot.context.revision}` : null
}

function requireRelayContext(): string {
  if (!relay?.canCapture()) throw new Error('Cannot capture/send: RAP is offline, the sample is over 2 seconds old, or this browser has no control.')
  const key = contextKey()
  if (!key) throw new Error('Workspace context is unavailable.')
  if (allPoints(state).length && state.coordinateContext !== key) {
    throw new Error('Existing points belong to an unknown or different workspace. Clear them, or explicitly confirm the workspace in Connection.')
  }
  return key
}

function attachRelay(identity: NonNullable<ReturnType<typeof loadIdentity>>): void {
  relay?.stop()
  relay = new RelayClient(identity, relayChanged)
  must<HTMLInputElement>('relayUrl').value = identity.baseUrl
  must<HTMLInputElement>('relayId').value = identity.relayId
  if (mode === 'relay') relay.start()
}

modeInput.addEventListener('change', () => {
  if (liveOwnsWork() || uploadInFlight || requestInFlight || connectionInFlight) { modeInput.value = mode; setStatus('Finish/reconcile live updates and wait for current work before changing connection.'); return }
  mode = modeInput.value === 'local' ? 'local' : 'relay'
  ++pairingEpoch
  updateConnectionMode()
})
async function connectBrowserLink(link: BrowserLink, requestControl = false): Promise<void> {
  const button = must<HTMLButtonElement>('pairRelayBtn')
  const message = must<HTMLParagraphElement>('relayMessage')
  button.disabled = true
  const epoch = ++pairingEpoch
  try {
    const existing = relay?.identity ?? loadIdentity()
    const matching = existing?.baseUrl === link.baseUrl && existing.relayId === link.relayId
    if (!matching && (liveOwnsWork() || uploadInFlight || pendingImport)) throw new Error('Reconcile pending work before connecting a different RAP.')
    if (!matching && existing && !window.confirm('Connect this browser to a different RAP? Existing captured points will not be transformed.')) return
    if (matching && (liveOwnsWork() || uploadInFlight || pendingImport)) {
      if (existing && !relay) attachRelay(existing)
      message.textContent = 'Saved RAP connection retained. Reconcile pending live work before starting new captures.'
      if (requestControl) await takeCaptureControl()
      return
    }
    const identity = await exchangeBrowserLink(link, existing, text => { message.textContent = text; setStatus(text) }, () => epoch === pairingEpoch)
    if (!identity || epoch !== pairingEpoch) return
    saveIdentity(identity)
    attachRelay(identity)
    must<HTMLInputElement>('relayInvitation').value = ''
    message.textContent = 'Connected. Capture control is acquired automatically when free.'
    setStatus('Connected to RAP. Capture becomes available automatically when control is free.')
    if (requestControl) {
      const client = relay
      const deadline = performance.now() + 10000
      while (client === relay && !client?.hasFreshPosition() && performance.now() < deadline) {
        await new Promise(resolve => window.setTimeout(resolve, 100))
      }
      if (epoch !== pairingEpoch || client !== relay) return
      if (!client?.hasFreshPosition()) throw new Error('Paired, but RAP has no fresh position. Check LightBurn and RAP, then click Pair again.')
      if (!client.activeBrowser && !await takeCaptureControl()) return
    }
    must<HTMLDialogElement>('connectionDialog').close()
  } catch (error) { message.textContent = errorToMessage(error); setStatus(errorToMessage(error)) }
  finally { button.disabled = false }
}
must<HTMLButtonElement>('pairRelayBtn').addEventListener('click', async () => {
  const button = must<HTMLButtonElement>('pairRelayBtn')
  try {
    const baseUrl = relayBaseUrl(must<HTMLInputElement>('relayUrl').value)
    const relayId = must<HTMLInputElement>('relayId').value.trim()
    const token = must<HTMLInputElement>('relayInvitation').value.trim()
    if (relay && relay.identity.baseUrl === baseUrl && relay.identity.relayId === relayId && !token) {
      button.disabled = true
      await takeCaptureControl()
      return
    }
    if (!relayId || !token) throw new Error('Enter a relay ID and invitation, or open the link from RAP.')
    await connectBrowserLink({ baseUrl, relayId, token, kind: 'phone' }, true)
  } catch (error) { setStatus(errorToMessage(error)) }
  finally { button.disabled = false }
})
async function takeCaptureControl(): Promise<boolean> {
  try {
    if (!relay) throw new Error('Pair with RAP first.')
    if (relay.activeBrowser && relay.canCapture()) { setStatus('Already paired and ready to capture.'); return true }
    if (!relay.hasFreshPosition()) throw new Error('RAP has no fresh position. Check LightBurn and RAP, then click Pair again.')
    if (uploadInFlight || liveDispatching || liveRecoveryInFlight) throw new Error('Wait for the import result before requesting control.')
    const takeover = relay.controlOccupied
    if (takeover && !window.confirm('Take capture control from the other browser? Its capture stops; pending or unresolved imports must be reconciled first.')) return false
    await relay.claimControl(takeover)
    must<HTMLParagraphElement>('relayMessage').textContent = 'This browser has capture control.'
    setStatus('Capture control acquired.')
    return true
  } catch (error) { must<HTMLParagraphElement>('relayMessage').textContent = errorToMessage(error); setStatus(errorToMessage(error)); return false }
}
must<HTMLButtonElement>('quickControlBtn').addEventListener('click', () => { void takeCaptureControl() })
must<HTMLButtonElement>('unlinkRelayBtn').addEventListener('click', async () => {
  if (liveOwnsWork() || uploadInFlight) { setStatus('Finish or reconcile live updates before unlinking.'); return }
  if (!window.confirm('Remove this browser’s local pairing? Revoke its grant in RAP to remove server access.')) return
  ++pairingEpoch
  try {
    saveIdentity(null)
    relay?.stop()
    relay = null
    updateConnectionMode()
    must<HTMLParagraphElement>('relayMessage').textContent = 'Unlinked locally. Pair again to reconnect.'
  } catch (error) { setStatus(errorToMessage(error)) }
})
must<HTMLButtonElement>('revalidateBtn').addEventListener('click', () => {
  if (liveOwnsWork() || uploadInFlight || requestInFlight) return
  const key = contextKey()
  if (!key || !relay?.canCapture()) { setStatus('A fresh RAP workspace and capture control are required.'); return }
  if (window.confirm('Confirm all existing point coordinates belong to the currently connected machine and workpiece origin? This does not move or transform any points.')) {
    state.coordinateContext = key
    persistAndRender()
    setStatus('Existing points explicitly associated with this workspace.')
  }
})
must<HTMLButtonElement>('checkImportBtn').addEventListener('click', async () => {
  if (uploadInFlight) return
  if (liveQueue().items.length) { must<HTMLButtonElement>('liveCheckBtn').click(); return }
  try {
    if (!pendingImport) throw new Error('No pending relay import is saved in this browser.')
    if (!relay || relay.identity.relayId !== pendingImport.relayId) throw new Error('Reconnect to the relay used for the pending import.')
    const job = parseJob(await relay.request(`/jobs/${encodeURIComponent(pendingImport.id)}`))
    setExportStatus(`RAP import ${job.id}: ${job.status}${job.error ? ` — ${job.error}` : ''}.`)
    if (['confirmed', 'failed', 'expired'].includes(job.status)) clearPendingImport()
  } catch (error) { setExportStatus(errorToMessage(error)) }
})
must<HTMLButtonElement>('resolveImportBtn').addEventListener('click', async () => {
  if (uploadInFlight || liveRecoveryInFlight || !pendingImport) return
  if (liveQueue().items.length) { must<HTMLButtonElement>('liveReconcileBtn').click(); return }
  if (window.confirm(`Check RAP and LightBurn for job ${pendingImport.id} first. Confirm you have reconciled its outcome and understand another Send may duplicate artwork.`)) {
    liveRecoveryInFlight = true
    renderControls()
    try {
      await acknowledgeRelayImport(pendingImport.id, pendingImport.relayId)
      clearPendingImport()
    }
    catch (error) { setExportStatus(errorToMessage(error)) }
    finally { liveRecoveryInFlight = false; renderControls() }
  }
})

async function acknowledgeRelayImport(id: string, relayId: string, baseUrl?: string): Promise<void> {
  const client = relay
  if (!client || client.identity.relayId !== relayId || (baseUrl && client.identity.baseUrl !== baseUrl)) {
    throw new Error('Reconnect to the original RAP before acknowledging this import.')
  }
  let job: ReturnType<typeof parseJob>
  try { job = parseJob(await client.request(`/jobs/${encodeURIComponent(id)}`)) }
  catch (error) {
    if (error instanceof RelayRequestError && error.status === 404) return
    throw error
  }
  if (job.id !== id) throw new Error('Import result ID does not match the saved journal.')
  if (['queued', 'claimed', 'attempting', 'accepted'].includes(job.status)) throw new Error('Import is still in progress. Wait for its result before acknowledging it.')
  if (job.status === 'unknown') await client.request(`/jobs/${encodeURIComponent(id)}/resolve`, {})
}

function clearPendingImport(): void {
  localStorage.removeItem(PENDING_IMPORT_KEY)
  pendingImport = null
  renderControls()
}
document.addEventListener('visibilitychange', () => {
  if (mode !== 'relay') return
  relay?.stop()
  if (!document.hidden) relay?.start()
  relayChanged()
})
window.setInterval(() => { if (mode === 'relay') relayChanged() }, 200)

function cancelConnectionClose(): void {
  if (connectionCloseTimer !== null) {
    window.clearTimeout(connectionCloseTimer)
    connectionCloseTimer = null
  }
}
must<HTMLDialogElement>('connectionDialog').addEventListener('close', cancelConnectionClose)
for (const input of [baseUrlInput, secretInput, appNameInput]) {
  input.addEventListener('input', cancelConnectionClose)
}

if (navigator.locks) {
  void navigator.locks.query().then(locks => {
    otherTabOwnsLive = locks.held?.some(lock => lock.name === 'pathplotter-live-update') ?? false
    if (!otherTabOwnsLive) unlockLiveGroups(state)
    renderAll()
  }).catch(error => { otherTabOwnsLive = true; setStatus(`Cannot determine Live update ownership: ${errorToMessage(error)}`); renderControls() })
}
window.setInterval(() => {
  if (!otherTabOwnsLive || !navigator.locks) return
  void navigator.locks.query().then(locks => {
    if (!locks.held?.some(lock => lock.name === 'pathplotter-live-update')) {
      otherTabOwnsLive = false
      unlockLiveGroups(state)
      renderAll()
    }
  }).catch(error => setStatus(`Cannot check live ownership: ${errorToMessage(error)}`))
}, 1000)
renderAll()
updateConnectionMode()
function consumePairingLink(): boolean {
  const link = browserLink(location.hash)
  if (link) {
    history.replaceState(null, '', location.pathname + location.search)
    if (mode !== 'relay' && (liveOwnsWork() || uploadInFlight || pendingImport)) throw new Error('Reconcile existing work before changing connection mode.')
    mode = 'relay'
    modeInput.value = mode
    must<HTMLInputElement>('relayUrl').value = link.baseUrl
    must<HTMLInputElement>('relayId').value = link.relayId
    must<HTMLInputElement>('relayInvitation').value = link.kind === 'phone' ? link.token : ''
    updateConnectionMode()
    const dialog = must<HTMLDialogElement>('connectionDialog')
    if (!dialog.open) dialog.showModal()
    void connectBrowserLink(link)
    return true
  }
  return false
}
window.addEventListener('hashchange', () => {
  try { consumePairingLink() }
  catch (error) { history.replaceState(null, '', location.pathname + location.search); setStatus(errorToMessage(error)) }
})
try {
  if (!consumePairingLink()) {
    const identity = loadIdentity()
    if (identity) attachRelay(identity)
  }
} catch (error) {
  history.replaceState(null, '', location.pathname + location.search)
  setStatus(errorToMessage(error))
}
new ResizeObserver(() => renderPlot()).observe(plotEl)

for (const [button, dialog] of [
  ['connectionBtn', 'connectionDialog'],
  ['settingsBtn', 'settingsDialog'],
  ['pointsBtn', 'pointsDialog'],
  ['sessionBtn', 'sessionDialog'],
]) {
  must<HTMLButtonElement>(button).addEventListener('click', () => {
    if (dialog === 'settingsDialog') {
      populateSettings()
    }
    must<HTMLDialogElement>(dialog).showModal()
  })
}
document.querySelectorAll<HTMLButtonElement>('[data-close]').forEach(button => {
  button.addEventListener('click', () => must<HTMLDialogElement>(button.dataset.close!).close())
})
must<HTMLSelectElement>('shapeType').addEventListener('change', updateDiameterVisibility)
document.querySelectorAll<HTMLDetailsElement>('.color-picker').forEach(picker => {
  picker.addEventListener('click', event => {
    const target = event.target
    if (!(target instanceof HTMLButtonElement) || !target.dataset.layerColor || !picker.dataset.colorInput) return
    must<HTMLInputElement>(picker.dataset.colorInput).value = target.dataset.layerColor
    renderPaletteSelection()
    picker.open = false
    picker.querySelector('summary')?.focus()
  })
  picker.addEventListener('toggle', () => {
    if (picker.open) document.querySelectorAll<HTMLDetailsElement>('.color-picker').forEach(other => {
      if (other !== picker) other.open = false
    })
  })
})

function renderPaletteSelection(): void {
  document.querySelectorAll<HTMLDetailsElement>('.color-picker').forEach(picker => {
    const color = must<HTMLInputElement>(picker.dataset.colorInput!).value.toLowerCase()
    picker.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.layerColor === color))
    })
    const entry = layerPalette.find(layer => layer.color === color)
    picker.querySelector<HTMLElement>('.selected-color-swatch')!.style.background = color
    picker.querySelector<HTMLElement>('.selected-color-label')!.textContent = entry ? `Layer ${entry.label}` : color
    picker.parentElement!.querySelector<HTMLElement>('.color-picker-message')!.textContent = entry ? '' :
      'Existing custom colour. Choose a LightBurn colour before applying settings.'
  })
}
must<HTMLFormElement>('settingsForm').addEventListener('submit', event => {
  event.preventDefault()
  if (otherTabOwnsLive || savedStateError || requestInFlight || (state.liveLocked && state.points.length)) { setStatus('Resolve saved work or finish this live group before changing capture settings.'); return }
  const type = must<HTMLSelectElement>('shapeType').value as ShapeType
  const diameter = must<HTMLInputElement>('circleDiameterMm').valueAsNumber
  const height = must<HTMLInputElement>('labelHeightMm').valueAsNumber
  const offsetX = must<HTMLInputElement>('labelOffsetX').valueAsNumber
  const offsetY = must<HTMLInputElement>('labelOffsetY').valueAsNumber
  if (!isLayerColor(must<HTMLInputElement>('strokeColor').value) || !isLayerColor(must<HTMLInputElement>('labelColor').value)) {
    setStatus('Choose Geometry and Label colours from the LightBurn layer palette before applying settings.')
    return
  }
  if (![diameter, height, offsetX, offsetY].every(Number.isFinite) || diameter <= 0 || height < 0.2) {
    setStatus('Enter valid numeric capture settings.')
    return
  }
  Object.assign(state, {
    type,
    strokeColor: must<HTMLInputElement>('strokeColor').value,
    circleDiameterMm: diameter,
    showNumbers: must<HTMLInputElement>('showNumbers').checked,
    showNames: must<HTMLInputElement>('showNames').checked,
    labelColor: must<HTMLInputElement>('labelColor').value,
    labelHeightMm: height,
    labelOffsetX: offsetX,
    labelOffsetY: offsetY,
  })
  persistAndRender()
  must<HTMLDialogElement>('settingsDialog').close()
})

function populateSettings(): void {
  must<HTMLSelectElement>('shapeType').value = state.type
  for (const key of ['strokeColor', 'circleDiameterMm', 'labelColor', 'labelHeightMm', 'labelOffsetX', 'labelOffsetY'] as const) {
    must<HTMLInputElement>(key).value = String(state[key])
  }
  must<HTMLInputElement>('showNumbers').checked = state.showNumbers
  must<HTMLInputElement>('showNames').checked = state.showNames
  renderPaletteSelection()
  document.querySelectorAll<HTMLDetailsElement>('.color-picker').forEach(picker => { picker.open = false })
  updateDiameterVisibility()
}

function updateDiameterVisibility(): void {
  must<HTMLLabelElement>('diameterField').hidden = must<HTMLSelectElement>('shapeType').value !== 'circles'
}

must<HTMLButtonElement>('connectBtn').addEventListener('click', async () => {
  if (liveEnabled || liveDispatching) { setStatus('Turn live mode off and wait for import completion before connecting again.'); return }
  if (liveQueue().items.length && !secretInput.value.trim()) { setStatus('Enter the existing LightBurn secret to check queued work; new pairing is blocked until reconciliation.'); return }
  const baseUrl = normalizeBaseUrl(baseUrlInput.value)
  const appName = appNameInput.value.trim() || 'PathPlotter'
  const connectButton = must<HTMLButtonElement>('connectBtn')
  connectButton.disabled = true
  connectionInFlight = true
  cancelConnectionClose()
  try {
    if (!secretInput.value.trim()) {
      setStatus('Pairing requested. Bring LightBurn to the foreground (click its window or Alt+Tab) and approve within 30 seconds.')
      const response = await fetch(`${baseUrl}/api/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ application_name: appName, capabilities: CAPABILITIES }),
      })
      if (response.status === 403) {
        throw new Error('Pairing declined or timed out. Bring LightBurn to the foreground, then retry Connect and approve within 30 seconds.')
      }
      if (!response.ok) {
        throw new Error(`Pairing failed (${response.status})`)
      }
      const payload = (await response.json()) as { secret?: string }
      if (!payload.secret) {
        throw new Error('Pairing response did not include a secret')
      }
      secretInput.value = payload.secret
    } else {
      setStatus('Connecting with the entered secret...')
    }
    await connectWithPreview()
    setStatus('Connected. Live preview is automatic. Closing this dialog in 2 seconds.')
    connectionCloseTimer = window.setTimeout(() => {
      connectionCloseTimer = null
      must<HTMLDialogElement>('connectionDialog').close()
    }, 2000)
  } catch (error) {
    setStatus(errorToMessage(error))
    connectionStateEl.textContent = 'Disconnected'
    connectionStateEl.classList.remove('ok')
  } finally {
    connectButton.disabled = false
    connectionInFlight = false
  }
})

must<HTMLButtonElement>('clearBtn').addEventListener('click', () => {
  if (liveOwnsWork() || requestInFlight || uploadInFlight) return
  const liveWarning = captureGroups(state).some(group => group.liveImported) ? ' Previously imported LightBurn artwork will NOT be removed.' : ''
  if (allPoints(state).length > 0 && !window.confirm(`Clear all captured groups and points? Capture settings will be kept.${liveWarning}`)) return
  state.points = []
  state.groups = []
  delete state.liveImported
  delete state.liveLocked
  delete state.liveQueue
  delete state.coordinateContext
  state.finished = false
  persistAndRender()
  setStatus('Points cleared.')
})

must<HTMLButtonElement>('captureBtn').addEventListener('click', () => {
  void capturePoint()
})

must<HTMLButtonElement>('finishBtn').addEventListener('click', async () => {
  if (liveFinishBlocked()) { setStatus('Resolve the paused/full live queue before closing this polygon.'); return }
  if (requestInFlight || (uploadInFlight && !liveDispatching)) {
    setStatus('Wait for the current request to finish.')
    return
  }
  if (state.finished) {
    state.finished = false
    persistAndRender()
    setStatus('Capture resumed.')
    return
  }
  if (!hasEnoughPoints(state)) {
    setStatus(`Not enough points to finish ${state.type}.`)
    return
  }
  requestInFlight = true
  renderControls()
  try {
    const built = liveEnabled ? buildDelta(state, 'finish') : null
    const update = built && liveTarget ? await makeUpdate(built, liveTarget) : null
    const next = structuredClone(state)
    if (update) { next.liveQueue ??= emptyLiveQueue(); enqueue(next.liveQueue, update) }
    finishCapture(next)
    commitCollection(next)
    setStatus('Group finished. Change settings if needed, then Resume to capture a new group.')
    void drainLiveQueue()
  } catch (error) { setStatus(`Could not finish: ${errorToMessage(error)}`) }
  finally { requestInFlight = false; renderControls() }
})

must<HTMLButtonElement>('undoBtn').addEventListener('click', () => {
  if (state.liveLocked || requestInFlight || uploadInFlight) return
  if (state.points.length === 0) {
    setStatus('Nothing to undo.')
    return
  }
  state.points.pop()
  state.finished = false
  persistAndRender()
  setStatus(state.liveImported ? 'Removed last point in PathPlotter only. Imported LightBurn artwork was not removed.' : 'Removed last point.')
})

must<HTMLButtonElement>('downloadSvgBtn').addEventListener('click', () => {
  const built = buildSvgForCollection()
  if (!built) {
    setExportStatus('Capture enough points for the selected shape first.')
    return
  }
  const blob = new Blob([built.svg], { type: 'image/svg+xml;charset=utf-8' })
  const name = `pathplotter-${new Date().toISOString().replace(/[:]/g, '-')}.svg`
  downloadBlob(blob, name)
  if (built.unsupportedCharacters.length > 0) {
    setExportStatus(
      `SVG downloaded with unsupported label characters omitted: ${Array.from(new Set(built.unsupportedCharacters)).join(', ')}.`,
    )
  } else {
    setExportStatus('SVG downloaded.')
  }
})

must<HTMLButtonElement>('sendBtn').addEventListener('click', () => {
  void sendToLightBurn()
})

must<HTMLButtonElement>('saveSessionBtn').addEventListener('click', () => {
  const payload = {
    version: 3,
    exportedAt: new Date().toISOString(),
    state,
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const name = `pathplotter-session-${new Date().toISOString().replace(/[:]/g, '-')}.json`
  downloadBlob(blob, name)
  setExportStatus('Session exported. API secret was not included.')
})

must<HTMLInputElement>('loadSessionInput').addEventListener('change', async event => {
  const input = event.currentTarget as HTMLInputElement | null
  const file = input?.files?.[0]
  if (!file) {
    return
  }
  try {
    const text = await file.text()
    if (liveOwnsWork() || requestInFlight || uploadInFlight) throw new Error('Reconcile live work and wait for the current request before importing.')
    const parsed = JSON.parse(text) as { version?: unknown; state?: unknown }
    if (parsed.version !== 2 && parsed.version !== 3) throw new Error('Only version 2 or 3 session files are supported.')
    const imported = validateCollection(parsed.state)
    if (imported.liveQueue?.items.length || imported.liveQueue?.paused) {
      throw new Error('This backup contains live import work. Restore it only after reconciling its LightBurn destination; queued imports cannot be imported through Session.')
    }
    for (const group of captureGroups(imported)) delete group.liveLocked
    if (allPoints(state).length > 0 && !window.confirm('Replace all current groups with this session?')) return
    state = imported
    persistAndRender()
    setExportStatus('Session imported.')
  } catch (error) {
    setExportStatus(errorToMessage(error))
  } finally {
    if (input) {
      input.value = ''
    }
  }
})

document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog[open]')) {
    return
  }
  const target = event.target as HTMLElement | null
  if (target && (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName) || target.isContentEditable)) {
    return
  }
  if (event.code === 'Space') {
    event.preventDefault()
    void capturePoint()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    must<HTMLButtonElement>('finishBtn').click()
  }
})

function must<T extends Element>(id: string): T {
  const element = document.querySelector(`#${id}`)
  if (!element) {
    throw new Error(`Missing element: ${id}`)
  }
  return element as T
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function setStatus(message: string): void {
  statusTextEl.textContent = message
  must<HTMLParagraphElement>('connectionMessage').textContent = message
}

function setExportStatus(message: string): void {
  exportStatusEl.textContent = message
  must<HTMLParagraphElement>('sessionMessage').textContent = message
}

async function fetchStatus(): Promise<void> {
  const response = await authorizedFetch('/api/status')
  if (!response.ok) {
    throw new Error(`Status request failed (${response.status})`)
  }
  const status = await response.json() as { connected?: boolean }
  if (status.connected !== true) throw new Error('LightBurn is available, but no machine is connected.')
  const projectResponse = await authorizedFetch('/api/project')
  if (!projectResponse.ok) throw new Error(`Workspace request failed (${projectResponse.status})`)
  const project = await projectResponse.json() as { filename?: unknown; device?: unknown; workspace?: {
    machine_size?: { x?: number; y?: number }; workpiece_size?: { x?: number; y?: number };
    workpiece_offset?: { x?: number; y?: number }; machine_view?: unknown
  } }
  const size = project.workspace?.workpiece_size
  workspaceSize = size && typeof size.x === 'number' && typeof size.y === 'number' &&
    Number.isFinite(size.x) && Number.isFinite(size.y) && size.x > 0 && size.y > 0
    ? { x: size.x, y: size.y } : null
  const workspace = project.workspace
  localContextRevision = null
  if (workspace && finiteNumber(workspace.machine_size?.x) && finiteNumber(workspace.machine_size?.y) &&
      finiteNumber(workspace.workpiece_offset?.x) && finiteNumber(workspace.workpiece_offset?.y) &&
      typeof workspace.machine_view === 'boolean') {
    const stable = { workspace: { machine_size: workspace.machine_size, workpiece_size: workspaceSize,
      workpiece_offset: workspace.workpiece_offset, machine_view: workspace.machine_view },
      filename: project.filename, device: project.device }
    const bytes = new TextEncoder().encode(JSON.stringify(stable))
    localContextRevision = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map(value => value.toString(16).padStart(2, '0')).join('')
  }
  renderPlot()
  connectionStateEl.textContent = 'Connected'
  connectionStateEl.classList.add('ok')
}

async function refreshLivePosition(): Promise<void> {
  if (mode !== 'local') return
  try {
    const response = await authorizedFetch('/api/position')
    if (!response.ok) {
      throw new Error(`Position request failed (${response.status})`)
    }
    const payload = (await response.json()) as { workpiece?: { x?: number; y?: number } }
    if (mode !== 'local') return
    const x = payload.workpiece?.x
    const y = payload.workpiece?.y
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      livePosition = null
      settledPosition.reset()
      liveTextEl.textContent = 'Workpiece X/Y are unavailable for the current device.'
      renderPlot()
      return
    }
    livePosition = { x, y, updatedAt: Date.now() }
    settledPosition.observe(`local:${++localObservationSequence}`, x, y)
    liveTextEl.textContent = `Live workpiece position: X ${x.toFixed(3)} mm, Y ${y.toFixed(3)} mm`
    renderPlot()
  } catch (error) {
    if (mode !== 'local') return
    settledPosition.reset()
    livePosition = null
    renderPlot()
    liveTextEl.textContent = `Live preview error: ${errorToMessage(error)}`
  }
}

async function connectWithPreview(): Promise<void> {
  await fetchStatus()
  await refreshLivePosition()
  startPreview()
  setStatus('Connected. Live preview is automatic.')
}

function startPreview(): void {
  if (pollHandle === null) {
    pollHandle = window.setInterval(() => { void refreshLivePosition() }, 1500)
  }
}

async function capturePoint(): Promise<void> {
  if (requestInFlight || (uploadInFlight && !liveDispatching) || liveCaptureBlocked()) {
    return
  }
  if (state.finished) {
    setStatus('Resume capture before adding another point.')
    return
  }
  requestInFlight = true
  renderControls()
  try {
    if (mode === 'relay') {
      const key = requireRelayContext()
      const position = relay?.snapshot?.position
      if (!position) throw new Error('No fresh workpiece coordinates.')
      await saveCapturedPoint({ id: makeId('pt'), name: '', x: position.x, y: position.y, labelOffsetX: 0, labelOffsetY: 0 }, key)
      setStatus(`Captured point ${state.points.length} from latest RAP sample.`)
      return
    }
    if (liveEnabled && liveTarget) await verifyImportTarget(liveTarget)
    const response = await authorizedFetch('/api/position')
    if (!response.ok) {
      throw new Error(`Position request failed (${response.status})`)
    }
    const payload = (await response.json()) as { workpiece?: { x?: number; y?: number } }
    const x = payload.workpiece?.x
    const y = payload.workpiece?.y
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error('Cannot capture: workpiece X/Y unavailable.')
    }
    const point: Point = {
      id: makeId('pt'),
      name: '',
      x,
      y,
      labelOffsetX: 0,
      labelOffsetY: 0,
    }
    await saveCapturedPoint(point)
    livePosition = { x, y, updatedAt: Date.now() }
    settledPosition.observe(`local:${++localObservationSequence}`, x, y)
    setStatus(`Captured point ${state.points.length}.`)
  } catch (error) {
    setStatus(errorToMessage(error))
  } finally {
    requestInFlight = false
    renderControls()
  }
}

async function saveCapturedPoint(point: Point, coordinateContext?: string): Promise<void> {
  if (liveEnabled && mode === 'relay' && liveTarget?.contextRevision !== relay?.snapshot?.context?.revision) {
    throw new Error('Workspace changed during Live update. Turn it off and reconcile queued work.')
  }
  const group = { ...state, points: [...state.points, point] }
  const built = liveEnabled ? buildDelta(group, 'capture') : null
  if (liveEnabled && !liveTarget) throw new Error('Live update destination is unavailable.')
  const update = built && liveTarget ? await makeUpdate(built, liveTarget) : null
  const next = structuredClone(state)
  next.points.push(point)
  if (coordinateContext) next.coordinateContext = coordinateContext
  else delete next.coordinateContext
  if (liveEnabled) {
    next.liveLocked = true
    next.liveQueue ??= emptyLiveQueue()
    if (update) enqueue(next.liveQueue, update)
  }
  commitCollection(next)
  void drainLiveQueue()
}

async function authorizedFetch(path: string, init?: RequestInit): Promise<Response> {
  const baseUrl = normalizeBaseUrl(baseUrlInput.value)
  const secret = secretInput.value.trim()
  if (!baseUrl) {
    throw new Error('Base URL is required.')
  }
  if (!secret) {
    throw new Error('Shared secret is required.')
  }
  const token = await bearerToken(secret)
  const headers = new Headers(init?.headers ?? {})
  headers.set('Authorization', `Bearer ${token}`)
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
  })
}

async function bearerToken(secret: string): Promise<string> {
  const message = new TextEncoder().encode(String(Math.floor(Date.now() / 1000 / 60)))
  const keyData = new TextEncoder().encode(secret)
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, message)
  return [...new Uint8Array(signature)].map(value => value.toString(16).padStart(2, '0')).join('')
}

async function sendToLightBurn(): Promise<void> {
  if (otherTabOwnsLive || uploadInFlight || requestInFlight || liveEnabled || liveQueue().items.length || liveQueue().paused) return
  const built = buildSvgForCollection()
  if (!built) {
    setExportStatus('Capture enough points for the selected shape before sending.')
    return
  }
  uploadInFlight = true
  renderControls()
  try {
    if (captureGroups(state).some(group => group.liveImported) &&
        !window.confirm('Some geometry was already sent by Live update. Sending the whole collection adds duplicates in LightBurn. Send anyway?')) return
    if (built.unsupportedCharacters.length && !window.confirm(`Unsupported label characters will be omitted: ${[...new Set(built.unsupportedCharacters)].join(', ')}. Send anyway?`)) return
    const update = await makeUpdate({ ...built, unsupportedCharacters: [] }, await currentImportTarget())
    const imported = await submitImport(update, () => {})
    setExportStatus(`LightBurn import ${imported.status}${imported.error ? `: ${imported.error}` : '.'}`)
  } catch (error) {
    setExportStatus(errorToMessage(error))
  } finally {
    uploadInFlight = false
    renderControls()
  }
}

async function submitImport(update: LiveUpdate, beforeSubmission: () => void): Promise<ImportResult> {
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(update.svg)))]
    .map(value => value.toString(16).padStart(2, '0')).join('')
  if (digest !== update.checksum) throw new Error('Saved live geometry checksum does not match. No update was sent.')
  await verifyImportTarget(update.target)
  if (update.target.mode === 'relay') {
    const client = relay
    if (!client) throw new Error('Pair with RAP first.')
    if (pendingImport) throw new Error(`Import ${pendingImport.id} is unresolved. Check it before sending more geometry.`)
    pendingImport = { id: update.id, relayId: client.identity.relayId }
    try { localStorage.setItem(PENDING_IMPORT_KEY, JSON.stringify(pendingImport)) }
    catch (error) {
      pendingImport = null
      throw new Error(`Cannot save import journal; no job was sent: ${errorToMessage(error)}`)
    }
    try { beforeSubmission() }
    catch (error) { clearPendingImport(); throw error }
    const job = parseJob(await client.request('/jobs', {
      id: update.id, svg: update.svg, checksum: update.checksum,
      filename: `pathplotter-${update.id}.svg`, anchor: update.anchor, contextRevision: update.target.contextRevision,
    }))
    const imported = await followRelayJob(client, job, update.id)
    if (imported.status !== 'unknown') clearPendingImport()
    return imported
  }
  const stream = await openImportStream(signal => authorizedFetch('/api/events', { headers: { Accept: 'text/event-stream' }, signal }))
  try {
    await verifyImportTarget(update.target)
    beforeSubmission()
    stream.arm()
    const response = await authorizedFetch('/api/file/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream',
        'X-Filename': `pathplotter-${update.id}.svg`, 'X-Position-X': String(update.anchor.x),
        'X-Position-Y': String(update.anchor.y), 'X-Origin': 'center' },
      body: new TextEncoder().encode(update.svg),
      signal: AbortSignal.timeout(10000),
    })
    if (response.status !== 202) return { status: 'unknown', error: `Upload returned ${response.status}. Inspect LightBurn before continuing.` }
    return await stream.result
  } finally { stream.close() }
}

async function followRelayJob(client: RelayClient, initial: ReturnType<typeof parseJob>, expectedId: string): Promise<ImportResult> {
  let job = initial
  const deadline = performance.now() + 90000
  while (true) {
    if (job.id !== expectedId) throw new Error('Relay returned a different import ID. Inspect RAP before continuing.')
    setExportStatus(`RAP import ${job.id}: ${job.status}${job.error ? ` — ${job.error}` : ''}.`)
    if (['confirmed', 'failed', 'expired', 'unknown'].includes(job.status)) return { status: job.status as ImportResult['status'], error: job.error }
    if (performance.now() > deadline) return { status: 'unknown', error: 'Import outcome not yet known. Check RAP before continuing.' }
    await new Promise(resolve => window.setTimeout(resolve, 500))
    job = parseJob(await client.request(`/jobs/${encodeURIComponent(job.id)}`))
  }
}

function buildSvgForCollection(): BuiltSvg | null {
  if (!hasExportGeometry()) {
    return null
  }
  const primitives: Primitive[] = []
  const unsupportedCharacters: string[] = []
  for (const group of captureGroups(state)) appendCollectionPrimitives(group, primitives, unsupportedCharacters)
  return serializeSvg(primitives, unsupportedCharacters)
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function persistAndRender(): void {
  if (otherTabOwnsLive || savedStateError) { setStatus(savedStateError || 'Another tab owns Live update.'); return }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch (error) {
    setStatus(`Autosave failed: ${errorToMessage(error)}. Export a session backup.`)
  }
  renderAll()
}

function loadState(): Collection {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem('pathplotter.collection.v2')
    return raw ? validateCollection(JSON.parse(raw)) : emptyCollection()
  } catch (error) {
    savedStateError = `Saved collection could not be loaded: ${errorToMessage(error)}. Preserve its browser storage and inspect LightBurn before abandoning saved work.`
    setStatus(savedStateError)
    return { ...emptyCollection(), liveQueue: { ...emptyLiveQueue(), paused: savedStateError } }
  }
}

function emptyCollection(): Collection {
  return {
    name: '', type: 'circles', points: [], groups: [], finished: false,
    strokeColor: '#000000', circleDiameterMm: 2,
    showNumbers: false, showNames: false, labelColor: '#ff0000',
    labelHeightMm: 2, labelOffsetX: 1.5, labelOffsetY: -1.5,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function validateCaptureGroup(value: unknown): CaptureGroup {
  if (!isRecord(value) || !Array.isArray(value.points) ||
      typeof value.name !== 'string' || typeof value.finished !== 'boolean' ||
      !['circles', 'polyline', 'polygon'].includes(String(value.type)) ||
      !isColor(value.strokeColor) || !isColor(value.labelColor) ||
      typeof value.showNumbers !== 'boolean' || typeof value.showNames !== 'boolean' ||
      !finiteNumber(value.circleDiameterMm) || value.circleDiameterMm <= 0 ||
      !finiteNumber(value.labelHeightMm) || value.labelHeightMm < 0.2 ||
      !finiteNumber(value.labelOffsetX) || !finiteNumber(value.labelOffsetY) ||
      (value.liveLocked !== undefined && typeof value.liveLocked !== 'boolean') ||
      (value.liveImported !== undefined && typeof value.liveImported !== 'boolean')) {
    throw new Error('Invalid collection settings.')
  }
  const ids = new Set<string>()
  const points = value.points.map((point: unknown): Point => {
    if (!isRecord(point) || typeof point.id !== 'string' || ids.has(point.id) ||
        typeof point.name !== 'string' || !finiteNumber(point.x) || !finiteNumber(point.y) ||
        !finiteNumber(point.labelOffsetX) || !finiteNumber(point.labelOffsetY)) {
      throw new Error('Invalid point in session. No points were imported.')
    }
    ids.add(point.id)
    return {
      id: point.id, name: point.name, x: point.x, y: point.y,
      labelOffsetX: point.labelOffsetX, labelOffsetY: point.labelOffsetY,
    }
  })
  return {
    name: value.name, type: value.type as ShapeType, points, finished: value.finished,
    strokeColor: value.strokeColor, circleDiameterMm: value.circleDiameterMm,
    showNumbers: value.showNumbers, showNames: value.showNames,
    labelColor: value.labelColor, labelHeightMm: value.labelHeightMm,
    labelOffsetX: value.labelOffsetX, labelOffsetY: value.labelOffsetY,
    ...(typeof value.liveLocked === 'boolean' ? { liveLocked: value.liveLocked } : {}),
    ...(typeof value.liveImported === 'boolean' ? { liveImported: value.liveImported } : {}),
  }
}

function validateCollection(value: unknown): Collection {
    const active = validateCaptureGroup(value)
    if (!isRecord(value) || (value.groups !== undefined && !Array.isArray(value.groups)) ||
        (value.coordinateContext !== undefined && typeof value.coordinateContext !== 'string')) {
      throw new Error('Invalid collection groups or coordinate context.')
    }
    const groups = Array.isArray(value.groups) ? value.groups.map(validateCaptureGroup) : []
    if (groups.some(group => !group.finished) || (groups.length > 0 && active.finished && active.points.length > 0)) {
      throw new Error('Invalid finished capture groups.')
    }
    const result: Collection = { ...active, groups,
      ...(typeof value.coordinateContext === 'string' ? { coordinateContext: value.coordinateContext } : {}),
      ...(value.liveQueue !== undefined ? { liveQueue: parseLiveQueue(value.liveQueue) } : {}) }
    const ids = new Set<string>()
    for (const group of captureGroups(result)) {
      for (const point of group.points) {
        if (ids.has(point.id)) throw new Error('Duplicate point ID across capture groups.')
        ids.add(point.id)
      }
    }
    if (value.groups === undefined && result.finished && result.points.length) finishCapture(result)
    return result
  }

function hasExportGeometry(): boolean {
    const groups = captureGroups(state).filter(group => group.points.length > 0)
    return groups.length > 0 && groups.every(hasEnoughPoints)
  }
function isColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
}

function renderAll(): void {
  renderControls()
  renderEditor()
  renderPlot()
}

function renderControls(): void {
  const busy = otherTabOwnsLive || requestInFlight || (uploadInFlight && !liveDispatching)
  must<HTMLSpanElement>('collectionSummary').textContent =
    `${state.type} · ${allPoints(state).length} points · ${state.groups.length} finished groups`
  const relayReady = mode !== 'relay' || relay?.canCapture() === true
  must<HTMLButtonElement>('quickControlBtn').hidden = mode !== 'relay' || !relay || relay.activeBrowser
  must<HTMLButtonElement>('quickControlBtn').disabled = busy || uploadInFlight || !relay?.hasFreshPosition()
  const contextMatches = mode !== 'relay' || !allPoints(state).length || state.coordinateContext === contextKey()
  must<HTMLButtonElement>('captureBtn').disabled = busy || state.finished || !relayReady || !contextMatches || liveCaptureBlocked()
  must<HTMLButtonElement>('finishBtn').textContent = state.finished ? 'Resume' : 'Finish'
  must<HTMLButtonElement>('finishBtn').disabled = busy || liveFinishBlocked() || (!state.finished && !hasEnoughPoints(state))
  must<HTMLButtonElement>('undoBtn').disabled = busy || !!state.liveLocked || state.points.length === 0
  must<HTMLButtonElement>('clearBtn').disabled = busy || liveOwnsWork() || allPoints(state).length === 0
  must<HTMLButtonElement>('settingsBtn').disabled = busy || !!savedStateError || !!(state.liveLocked && state.points.length)
  must<HTMLButtonElement>('pointsBtn').disabled = busy
  must<HTMLButtonElement>('sendBtn').disabled = busy || uploadInFlight || liveOwnsWork() || !hasExportGeometry() || !relayReady || !contextMatches ||
    (mode === 'relay' && pendingImport !== null)
  must<HTMLButtonElement>('downloadSvgBtn').disabled = busy || !hasExportGeometry()
  const queue = liveQueue()
  if (!requestInFlight) must<HTMLInputElement>('liveUpdateToggle').checked = liveEnabled
  must<HTMLInputElement>('liveUpdateToggle').disabled = requestInFlight || (!liveEnabled && (uploadInFlight || !!queue.items.length || !!queue.paused))
  must<HTMLElement>('liveUpdateStatus').textContent = otherTabOwnsLive ? 'Another tab owns Live update. Use that tab or wait for it to close.' : queue.paused ? `Paused: ${queue.paused} · ${queue.items.length} pending` :
    `${liveEnabled ? 'On' : queue.items.length ? 'Off · draining' : 'Off'} · ${queue.items.length}/${LIVE_QUEUE_LIMIT} pending · ${queue.confirmed} confirmed${queue.items.length >= LIVE_QUEUE_LIMIT ? ' · Queue full; wait for imports' : ''}`
  const head = queue.items[0]
  must<HTMLButtonElement>('liveCheckBtn').hidden = !queue.paused || !head || head.phase === 'queued'
  must<HTMLButtonElement>('liveReconcileBtn').hidden = !queue.paused || !head || head.phase === 'queued'
  must<HTMLButtonElement>('liveResumeBtn').hidden = !queue.paused || !!(head && head.phase !== 'queued') || !!savedStateError
  must<HTMLButtonElement>('liveAbandonBtn').hidden = !queue.paused && !queue.items.length
  for (const id of ['liveCheckBtn', 'liveReconcileBtn', 'liveResumeBtn', 'liveAbandonBtn']) must<HTMLButtonElement>(id).disabled = liveRecoveryInFlight || liveDispatching || requestInFlight
  must<HTMLInputElement>('loadSessionInput').disabled = busy || liveOwnsWork()
  baseUrlInput.disabled = liveEnabled || liveDispatching
  secretInput.disabled = liveEnabled || liveDispatching
  modeInput.disabled = liveOwnsWork() || busy || uploadInFlight
}

function renderEditor(): void {
  if (allPoints(state).length === 0) {
    pointsTableEl.innerHTML = '<tr><td colspan="8" class="hint">No points yet.</td></tr>'
    return
  }
  pointsTableEl.innerHTML = captureGroups(state).map((group, groupIndex) => group.points.map(
      (point, index) => `
      <tr>
        <td>${groupIndex < state.groups.length ? `${groupIndex + 1} · ${group.type}` : `Current · ${group.type}`}</td>
        <td>${index + 1}</td>
        <td><input aria-label="Point ${index + 1} name" data-point="name" data-id="${escapeHtml(point.id)}" value="${escapeHtml(point.name)}" /></td>
        <td><input aria-label="Point ${index + 1} X" data-point="x" data-id="${escapeHtml(point.id)}" type="number" step="any" value="${point.x}" required /></td>
        <td><input aria-label="Point ${index + 1} Y" data-point="y" data-id="${escapeHtml(point.id)}" type="number" step="any" value="${point.y}" required /></td>
        <td><input aria-label="Point ${index + 1} label offset X" data-point="labelOffsetX" data-id="${escapeHtml(point.id)}" type="number" step="any" value="${point.labelOffsetX}" required /></td>
        <td><input aria-label="Point ${index + 1} label offset Y" data-point="labelOffsetY" data-id="${escapeHtml(point.id)}" type="number" step="any" value="${point.labelOffsetY}" required /></td>
        <td><button data-point="delete" data-id="${escapeHtml(point.id)}" class="danger">Delete</button></td>
      </tr>`,
    ).join(''))
    .join('')
  pointsTableEl.querySelectorAll<HTMLInputElement>('input[data-point]').forEach(input => {
    input.disabled = otherTabOwnsLive || captureGroups(state).some(group => group.liveLocked && group.points.some(point => point.id === input.dataset.id))
    input.addEventListener('change', () => {
      updatePointFromInput(input)
    })
  })
  pointsTableEl.querySelectorAll<HTMLButtonElement>('button[data-point="delete"]').forEach(button => {
    button.disabled = otherTabOwnsLive || captureGroups(state).some(group => group.liveLocked && group.points.some(point => point.id === button.dataset.id))
    button.addEventListener('click', () => {
      const pointId = button.dataset.id
      if (!pointId) {
        return
      }
      if (otherTabOwnsLive || requestInFlight || captureGroups(state).some(group => group.liveLocked && group.points.some(point => point.id === pointId))) {
        setStatus('Live group points are locked until live mode is off and pending work is reconciled.')
        return
      }
      const wasImported = captureGroups(state).some(group => group.liveImported && group.points.some(point => point.id === pointId))
      for (const group of captureGroups(state)) group.points = group.points.filter(point => point.id !== pointId)
      state.groups = state.groups.filter(group => group.points.length > 0)
      if (captureGroups(state).some(group => group.points.length > 0 && !hasEnoughPoints(group))) {
        setStatus('A group has too few points for its shape. Delete the rest of that group before exporting.')
      }
      persistAndRender()
      if (wasImported) setStatus('Point deleted in PathPlotter only. Previously imported LightBurn geometry was not removed.')
    })
  })
}

function updatePointFromInput(input: HTMLInputElement): void {
  const pointId = input.dataset.id
  const key = input.dataset.point as keyof Point | undefined
  if (!pointId || !key) {
    return
  }
  if (otherTabOwnsLive || requestInFlight || captureGroups(state).some(group => group.liveLocked && group.points.some(point => point.id === pointId))) {
    setStatus('Live group points are locked until live mode is off and pending work is reconciled.')
    return
  }
  const point = allPoints(state).find(entry => entry.id === pointId)
  if (!point) {
    return
  }
  if (key === 'name') {
    point.name = input.value
    persistAndRender()
    if (captureGroups(state).some(group => group.liveImported && group.points.some(entry => entry.id === pointId))) {
      setStatus('Name edited in PathPlotter only. Previously imported LightBurn labels were not updated.')
    }
    return
  }
  if (key === 'id') {
    return
  }
  const numeric = input.valueAsNumber
  if (!Number.isFinite(numeric)) {
    input.reportValidity()
    setStatus('Point coordinates and offsets must be finite numbers.')
    return
  }
  point[key] = numeric
  persistAndRender()
  if (captureGroups(state).some(group => group.liveImported && group.points.some(entry => entry.id === pointId))) {
    setStatus('Point edited in PathPlotter only. Previously imported LightBurn geometry was not updated.')
  }
}

function renderPlot(): void {
  const pixelWidth = Math.max(160, plotEl.clientWidth)
  const pixelHeight = Math.max(160, plotEl.clientHeight)
  const marginX = 55
  const marginY = 28
  const innerWidth = pixelWidth - marginX * 2
  const innerHeight = pixelHeight - marginY * 2
  const primitives: Primitive[] = []
  for (const group of captureGroups(state)) {
    const start = primitives.length
    appendCollectionPrimitives(group, primitives, [])
    if (!group.finished && group.type === 'polygon') {
      const outline = primitives[start]
      if (outline?.kind === 'polyline') outline.close = false
    }
  }
  let minX = 0
  let minY = 0
  let maxX = workspaceSize?.x ?? 0
  let maxY = workspaceSize?.y ?? 0
  const locations = allPoints(state)
  if (livePosition) locations.push({ ...livePosition, id: '', name: '', labelOffsetX: 0, labelOffsetY: 0 })
  for (const point of locations) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  if (primitives.length > 0) {
    const bounds = primitiveBounds(primitives)
    minX = Math.min(minX, bounds.minX)
    minY = Math.min(minY, bounds.minY)
    maxX = Math.max(maxX, bounds.maxX)
    maxY = Math.max(maxY, bounds.maxY)
  }
  const spanX = Math.max(20, maxX - minX || 100)
  const spanY = Math.max(20, maxY - minY || 100)
  const padding = Math.max(2, Math.max(spanX, spanY) * 0.04)
  const scale = Math.min(innerWidth / (spanX + 2 * padding), innerHeight / (spanY + 2 * padding))
  const centerX = (minX + Math.max(maxX, minX + spanX)) / 2
  const centerY = (minY + Math.max(maxY, minY + spanY)) / 2
  const left = centerX - innerWidth / scale / 2
  const top = centerY + innerHeight / scale / 2
  const right = left + innerWidth / scale
  const bottom = top - innerHeight / scale
  const screenX = (x: number) => marginX + (x - left) * scale
  const screenY = (y: number) => marginY + (top - y) * scale
  const step = chooseGridStep(70 / scale)
  const minorStep = step / 5
  plotEl.setAttribute('viewBox', `0 0 ${pixelWidth} ${pixelHeight}`)
  let grid = ''
  let rulers = ''
  for (let i = Math.ceil(left / minorStep); i <= Math.floor(right / minorStep); i++) {
    const x = i * minorStep
    grid += `<line x1="${screenX(x)}" y1="${marginY}" x2="${screenX(x)}" y2="${pixelHeight - marginY}" class="${i % 5 === 0 ? 'major' : 'minor'}" />`
  }
  for (let i = Math.ceil(bottom / minorStep); i <= Math.floor(top / minorStep); i++) {
    const y = i * minorStep
    grid += `<line x1="${marginX}" y1="${screenY(y)}" x2="${pixelWidth - marginX}" y2="${screenY(y)}" class="${i % 5 === 0 ? 'major' : 'minor'}" />`
  }
  for (let i = Math.ceil(left / step); i <= Math.floor(right / step); i++) {
    const value = i * step
    for (const y of [17, pixelHeight - 10]) {
      rulers += `<text class="ruler-x" data-value="${fmt(value)}" x="${screenX(value)}" y="${y}" text-anchor="middle">${fmt(value)}</text>`
    }
  }
  for (let i = Math.ceil(bottom / step); i <= Math.floor(top / step); i++) {
    const value = i * step
    rulers += `<text class="ruler-y" data-value="${fmt(value)}" x="${marginX - 8}" y="${screenY(value)}" text-anchor="end" dominant-baseline="middle">${fmt(value)}</text>`
    rulers += `<text class="ruler-y" data-value="${fmt(value)}" x="${pixelWidth - marginX + 8}" y="${screenY(value)}" text-anchor="start" dominant-baseline="middle">${fmt(value)}</text>`
  }
  let geometry = primitives.map(primitive => {
    if (primitive.kind === 'circle') {
      return `<circle cx="${primitive.cx}" cy="${primitive.cy}" r="${primitive.r}" stroke="${primitive.color}" />`
    }
    const points = primitive.points.map(point => `${point.x},${point.y}`).join(' ')
    const tag = primitive.close ? 'polygon' : 'polyline'
    return `<${tag} points="${points}" stroke="${primitive.color}" />`
  }).join('')
  for (const group of captureGroups(state)) {
    if (group.type !== 'circles' && group.points.length > 1 && !hasEnoughPoints(group)) {
      geometry += `<polyline points="${group.points.map(p => `${p.x},${p.y}`).join(' ')}" stroke="${group.strokeColor}" />`
    }
  }
  const pointDots = captureGroups(state).map(group => group.points.map((point, index) =>
    `<circle class="point-dot" cx="${screenX(point.x)}" cy="${screenY(point.y)}" r="3" fill="${group.strokeColor}"><title>Point ${index + 1}${point.name ? `: ${escapeXml(point.name)}` : ''} · X ${point.x}, Y ${point.y}</title></circle>`
  ).join('')).join('')
  const head = livePosition
    ? `<g class="head-marker${settledPosition.settled ? ' settled' : ''}" transform="translate(${screenX(livePosition.x)} ${screenY(livePosition.y)})"><title>${settledPosition.settled ? 'Reported position unchanged for three readings' : 'Reported position not yet settled'}</title><circle r="5" /><path d="M -9 0 H 9 M 0 -9 V 9" /></g>` : ''
  const workspace = workspaceSize
    ? `<rect class="bed-outline" x="${screenX(0)}" y="${screenY(workspaceSize.y)}" width="${workspaceSize.x * scale}" height="${workspaceSize.y * scale}" />` : ''
  plotEl.innerHTML = `
    <defs><clipPath id="workspaceClip"><rect x="${marginX}" y="${marginY}" width="${innerWidth}" height="${innerHeight}" /></clipPath></defs>
    <rect class="plot-background" x="${marginX}" y="${marginY}" width="${innerWidth}" height="${innerHeight}" />
    <g clip-path="url(#workspaceClip)">
      <g class="grid">${grid}</g>
      <g class="origin-axes"><path d="M ${screenX(0)} ${marginY} V ${pixelHeight - marginY} M ${marginX} ${screenY(0)} H ${pixelWidth - marginX}" /></g>
      ${workspace}
      <g class="geometry" transform="translate(${screenX(0)} ${screenY(0)}) scale(${scale} ${-scale})">${geometry}</g>
      ${pointDots}${head}
    </g>
    <g class="rulers">${rulers}</g>`
}

function chooseGridStep(minimum: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(minimum))
  for (const factor of [1, 2, 5, 10]) {
    if (factor * magnitude >= minimum) return factor * magnitude
  }
  return magnitude * 10
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
