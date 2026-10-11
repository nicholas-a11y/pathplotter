import './style.css'
import { captureGroups, allPoints, finishCapture, type Collection, type CaptureGroup, type Point, type ShapeType } from './capture-groups'
import { layerPalette, isLayerColor } from './layer-palette'
import { SettledPosition } from './settled-position'
import { RelayClient, loadIdentity, saveIdentity, pairingInvitation, relayRequest, relayBaseUrl, parseJob } from './relay'

interface LivePosition {
  x: number
  y: number
  updatedAt: number
}

interface PolylinePrimitive {
  kind: 'polyline'
  points: Array<{ x: number; y: number }>
  color: string
  close: boolean
}

interface CirclePrimitive {
  kind: 'circle'
  cx: number
  cy: number
  r: number
  color: string
}

type Primitive = PolylinePrimitive | CirclePrimitive

const CAPABILITIES = ['state', 'project', 'upload']
const STORAGE_KEY = 'pathplotter.collection.v3'
const STROKE_WIDTH_MM = 0.2

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

const glyphStrokes: Record<string, string[]> = {
  A: ['0,1 0.5,0 1,1', '0.2,0.6 0.8,0.6'],
  B: ['0,0 0,1', '0,0 0.65,0 0.8,0.15 0.8,0.35 0.65,0.5 0,0.5', '0,0.5 0.65,0.5 0.8,0.65 0.8,0.85 0.65,1 0,1'],
  C: ['1,0.1 0.8,0 0.2,0 0,0.2 0,0.8 0.2,1 0.8,1 1,0.9'],
  D: ['0,0 0,1', '0,0 0.7,0 1,0.3 1,0.7 0.7,1 0,1'],
  E: ['1,0 0,0 0,1 1,1', '0,0.5 0.7,0.5'],
  F: ['0,0 0,1', '0,0 1,0', '0,0.5 0.7,0.5'],
  G: ['1,0.2 0.8,0 0.2,0 0,0.2 0,0.8 0.2,1 0.8,1 1,0.8 1,0.6 0.6,0.6'],
  H: ['0,0 0,1', '1,0 1,1', '0,0.5 1,0.5'],
  I: ['0,0 1,0', '0.5,0 0.5,1', '0,1 1,1'],
  J: ['1,0 1,0.8 0.8,1 0.3,1 0,0.7'],
  K: ['0,0 0,1', '1,0 0,0.5 1,1'],
  L: ['0,0 0,1 1,1'],
  M: ['0,1 0,0 0.5,0.6 1,0 1,1'],
  N: ['0,1 0,0 1,1 1,0'],
  O: ['0.2,0 0.8,0 1,0.2 1,0.8 0.8,1 0.2,1 0,0.8 0,0.2 0.2,0'],
  P: ['0,1 0,0 0.7,0 1,0.25 1,0.45 0.7,0.65 0,0.65'],
  Q: ['0.2,0 0.8,0 1,0.2 1,0.8 0.8,1 0.2,1 0,0.8 0,0.2 0.2,0', '0.6,0.75 1,1'],
  R: ['0,1 0,0 0.7,0 1,0.25 1,0.45 0.7,0.65 0,0.65', '0.45,0.65 1,1'],
  S: ['1,0.15 0.8,0 0.2,0 0,0.2 0.2,0.45 0.8,0.55 1,0.8 0.8,1 0.2,1 0,0.85'],
  T: ['0,0 1,0', '0.5,0 0.5,1'],
  U: ['0,0 0,0.8 0.2,1 0.8,1 1,0.8 1,0'],
  V: ['0,0 0.5,1 1,0'],
  W: ['0,0 0.25,1 0.5,0.4 0.75,1 1,0'],
  X: ['0,0 1,1', '1,0 0,1'],
  Y: ['0,0 0.5,0.5 1,0', '0.5,0.5 0.5,1'],
  Z: ['0,0 1,0 0,1 1,1'],
  0: ['0.2,0 0.8,0 1,0.2 1,0.8 0.8,1 0.2,1 0,0.8 0,0.2 0.2,0'],
  1: ['0.5,0 0.5,1', '0.25,0.2 0.5,0', '0.25,1 0.75,1'],
  2: ['0,0.2 0.2,0 0.8,0 1,0.2 1,0.4 0,1 1,1'],
  3: ['0,0.1 0.25,0 0.8,0 1,0.2 0.75,0.5 1,0.8 0.8,1 0.25,1 0,0.9'],
  4: ['0.85,0 0.85,1', '0,0.65 1,0.65', '0,0.65 0.7,0'],
  5: ['1,0 0.2,0 0,0.45 0.75,0.45 1,0.65 0.8,1 0.2,1 0,0.85'],
  6: ['1,0.2 0.8,0 0.2,0 0,0.2 0,0.8 0.2,1 0.8,1 1,0.8 0.8,0.55 0,0.55'],
  7: ['0,0 1,0 0.25,1'],
  8: ['0.2,0 0.8,0 1,0.2 0.8,0.5 0.2,0.5 0,0.2 0.2,0', '0.2,0.5 0.8,0.5 1,0.8 0.8,1 0.2,1 0,0.8 0.2,0.5'],
  9: ['1,0.2 0.8,0 0.2,0 0,0.2 0,0.4 0.2,0.6 0.8,0.6 1,0.4 1,0.2', '1,0.4 1,0.8 0.8,1 0.2,1 0,0.8'],
  '-': ['0.1,0.5 0.9,0.5'],
  '_': ['0,1 1,1'],
  '.': ['0.45,1 0.55,1'],
  ':': ['0.45,0.25 0.55,0.25', '0.45,0.8 0.55,0.8'],
  '/': ['0,1 1,0'],
  ' ': [],
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
    <button id="finishBtn">Finish</button>
    <button id="undoBtn" class="secondary">Undo</button>
    <button id="settingsBtn" class="secondary">Capture settings</button>
    <button id="pointsBtn" class="secondary">Edit points</button>
    <button id="clearBtn" class="secondary">Clear points</button>
  </nav>
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
      <p class="hint">Run RAP on the LightBurn computer and open its pairing link on this browser. Compare the verification phrase and approve in RAP. Pairing is saved only in this browser.</p>
      <label>Relay API URL<input id="relayUrl" type="url" placeholder="https://pathplotter-relay.example.workers.dev" /></label>
      <label>Relay ID<input id="relayId" /></label>
      <label>Pairing invitation<input id="relayInvitation" type="password" autocomplete="off" /></label>
      <div class="row">
        <button id="pairRelayBtn" class="primary">Pair with RAP</button>
        <button id="takeControlBtn">Use this browser</button>
        <button id="unlinkRelayBtn">Unlink this browser</button>
        <button id="revalidateBtn">Confirm workspace for existing points</button>
        <button id="checkImportBtn">Check last import</button>
        <button id="resolveImportBtn">Acknowledge uncertain import</button>
      </div>
      <p id="relayMessage" role="status"></p>
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

let state: Collection = loadState()
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
const modeInput = must<HTMLSelectElement>('connectionMode')
modeInput.value = mode

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
  const relayContext = snapshot && relay ? `${relay.identity.relayId}:${snapshot.generation}:${snapshot.context?.revision}` : null
  if (!fresh || relayContext !== settledRelayContext) settledPosition.reset()
  settledRelayContext = relayContext
  if (fresh && snapshot?.position) {
    settledPosition.observe(`${snapshot.generation}:${snapshot.sequence}`, snapshot.position.x, snapshot.position.y)
  }
  livePosition = fresh && snapshot?.position ? { ...snapshot.position, updatedAt: Date.now() } : null
  workspaceSize = snapshot?.context?.size ?? null
  connectionStateEl.textContent = fresh ? 'RAP connected' : 'Capture unavailable'
  connectionStateEl.classList.toggle('ok', fresh)
  liveTextEl.textContent = relay?.error ? `Relay: ${relay.error}` :
    snapshot?.position ? `Latest reported: X ${snapshot.position.x.toFixed(3)}, Y ${snapshot.position.y.toFixed(3)} mm · age ${(relay!.age() / 1000).toFixed(1)} s${fresh ? '' : ' · stale, offline or another browser has control'}` :
    'Waiting for a fresh RAP workpiece position.'
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
  if (uploadInFlight || requestInFlight || connectionInFlight) { modeInput.value = mode; setStatus('Wait for the current request before changing connection.'); return }
  mode = modeInput.value === 'local' ? 'local' : 'relay'
  ++pairingEpoch
  updateConnectionMode()
})
must<HTMLButtonElement>('pairRelayBtn').addEventListener('click', async () => {
  const button = must<HTMLButtonElement>('pairRelayBtn')
  const message = must<HTMLParagraphElement>('relayMessage')
  button.disabled = true
  const epoch = ++pairingEpoch
  try {
    if (relay && !window.confirm('Replace this browser’s existing relay pairing?')) return
    const baseUrl = relayBaseUrl(must<HTMLInputElement>('relayUrl').value)
    const relayId = must<HTMLInputElement>('relayId').value.trim()
    if (!relayId) throw new Error('Relay ID is required.')
    const value = await relayRequest(baseUrl, relayId, '/pairing/request', {
      invitation: must<HTMLInputElement>('relayInvitation').value.trim(),
    })
    if (!isRecord(value) || typeof value.pairingId !== 'string' ||
        typeof value.pendingToken !== 'string' || typeof value.phrase !== 'string') throw new Error('Invalid pairing response.')
    message.textContent = `Compare "${value.phrase}" with RAP, then approve on the desktop. Waiting up to 5 minutes.`
    const deadline = performance.now() + 300000
    while (epoch === pairingEpoch && performance.now() < deadline) {
      await new Promise(resolve => window.setTimeout(resolve, 1000))
      if (epoch !== pairingEpoch) return
      const result = await relayRequest(baseUrl, relayId, '/pairing/status', {
        pairingId: value.pairingId, pendingToken: value.pendingToken,
      })
      if (!isRecord(result) || typeof result.status !== 'string') throw new Error('Invalid pairing status.')
      if (result.status === 'rejected') throw new Error('RAP rejected the pairing invitation.')
      if (result.status === 'approved') {
        if (typeof result.credential !== 'string') throw new Error('Pairing credential missing.')
        if (epoch !== pairingEpoch) return
        const identity = { baseUrl, relayId, credential: result.credential }
        saveIdentity(identity)
        attachRelay(identity)
        must<HTMLInputElement>('relayInvitation').value = ''
        message.textContent = 'Paired. Click Use this browser to enable capture.'
        return
      }
      if (result.status !== 'pending') throw new Error('Pairing expired or is invalid.')
    }
    if (epoch === pairingEpoch) throw new Error('Pairing expired. Generate a new invitation in RAP.')
  } catch (error) { message.textContent = errorToMessage(error) }
  finally { button.disabled = false }
})
must<HTMLButtonElement>('takeControlBtn').addEventListener('click', async () => {
  try {
    if (!relay) throw new Error('Pair with RAP first.')
    await relay.claimControl()
    must<HTMLParagraphElement>('relayMessage').textContent = 'This browser has capture control.'
  } catch (error) { must<HTMLParagraphElement>('relayMessage').textContent = errorToMessage(error) }
})
must<HTMLButtonElement>('unlinkRelayBtn').addEventListener('click', async () => {
  if (uploadInFlight) { setStatus('Wait for the import result before unlinking.'); return }
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
  if (uploadInFlight || requestInFlight) return
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
  try {
    if (!pendingImport) throw new Error('No pending relay import is saved in this browser.')
    if (!relay || relay.identity.relayId !== pendingImport.relayId) throw new Error('Reconnect to the relay used for the pending import.')
    const job = parseJob(await relay.request(`/jobs/${encodeURIComponent(pendingImport.id)}`))
    setExportStatus(`RAP import ${job.id}: ${job.status}${job.error ? ` — ${job.error}` : ''}.`)
    if (['confirmed', 'failed', 'expired'].includes(job.status)) clearPendingImport()
  } catch (error) { setExportStatus(errorToMessage(error)) }
})
must<HTMLButtonElement>('resolveImportBtn').addEventListener('click', () => {
  if (uploadInFlight || !pendingImport) return
  if (window.confirm(`Check RAP and LightBurn for job ${pendingImport.id} first. Confirm you have reconciled its outcome and understand another Send may duplicate artwork.`)) {
    try { clearPendingImport() }
    catch (error) { setExportStatus(errorToMessage(error)) }
  }
})

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

renderAll()
updateConnectionMode()
function consumePairingLink(): boolean {
  const invitation = pairingInvitation(location.hash)
  if (invitation) {
    if (uploadInFlight) throw new Error('Wait for the import outcome before opening a different pairing invitation.')
    history.replaceState(null, '', location.pathname + location.search)
    mode = 'relay'
    modeInput.value = mode
    must<HTMLInputElement>('relayUrl').value = invitation.baseUrl
    must<HTMLInputElement>('relayId').value = invitation.relayId
    must<HTMLInputElement>('relayInvitation').value = invitation.invitation
    updateConnectionMode()
    const dialog = must<HTMLDialogElement>('connectionDialog')
    if (!dialog.open) dialog.showModal()
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
  if (requestInFlight || uploadInFlight) return
  if (allPoints(state).length > 0 && !window.confirm('Clear all captured groups and points? Capture settings will be kept.')) return
  state.points = []
  state.groups = []
  delete state.coordinateContext
  state.finished = false
  persistAndRender()
  setStatus('Points cleared.')
})

must<HTMLButtonElement>('captureBtn').addEventListener('click', () => {
  void capturePoint()
})

must<HTMLButtonElement>('finishBtn').addEventListener('click', () => {
  if (requestInFlight || uploadInFlight) {
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
  finishCapture(state)
  persistAndRender()
  setStatus('Group finished. Change settings if needed, then Resume to capture a new group.')
})

must<HTMLButtonElement>('undoBtn').addEventListener('click', () => {
  if (requestInFlight || uploadInFlight) return
  if (state.points.length === 0) {
    setStatus('Nothing to undo.')
    return
  }
  state.points.pop()
  state.finished = false
  persistAndRender()
  setStatus('Removed last point.')
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
    if (requestInFlight || uploadInFlight) throw new Error('Wait for the current request before importing.')
    const parsed = JSON.parse(text) as { version?: unknown; state?: unknown }
    if (parsed.version !== 2 && parsed.version !== 3) throw new Error('Only version 2 or 3 session files are supported.')
    const imported = validateCollection(parsed.state)
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
  const project = await projectResponse.json() as { workspace?: { workpiece_size?: { x?: number; y?: number } } }
  const size = project.workspace?.workpiece_size
  workspaceSize = size && typeof size.x === 'number' && typeof size.y === 'number' &&
    Number.isFinite(size.x) && Number.isFinite(size.y) && size.x > 0 && size.y > 0
    ? { x: size.x, y: size.y } : null
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
  if (requestInFlight) {
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
      state.points.push({ id: makeId('pt'), name: '', x: position.x, y: position.y, labelOffsetX: 0, labelOffsetY: 0 })
      state.coordinateContext = key
      persistAndRender()
      setStatus(`Captured point ${state.points.length} from latest RAP sample.`)
      return
    }
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
    state.points.push(point)
    delete state.coordinateContext
    livePosition = { x, y, updatedAt: Date.now() }
    settledPosition.observe(`local:${++localObservationSequence}`, x, y)
    persistAndRender()
    setStatus(`Captured point ${state.points.length}.`)
  } catch (error) {
    setStatus(errorToMessage(error))
  } finally {
    requestInFlight = false
    renderControls()
  }
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
  if (uploadInFlight || requestInFlight) return
  const built = buildSvgForCollection()
  if (!built) {
    setExportStatus('Capture enough points for the selected shape before sending.')
    return
  }
  uploadInFlight = true
  renderControls()
  try {
    if (built.unsupportedCharacters.length && !window.confirm(`Unsupported label characters will be omitted: ${[...new Set(built.unsupportedCharacters)].join(', ')}. Send anyway?`)) return
    if (mode === 'relay') {
      if (pendingImport) throw new Error(`Previous import ${pendingImport.id} is unresolved. Use Check last import in Connection before sending again.`)
      const key = requireRelayContext()
      const client = relay
      if (!client) throw new Error('Pair with RAP first.')
      const bytes = new TextEncoder().encode(built.svg)
      if (bytes.byteLength > 512 * 1024) throw new Error('SVG exceeds the 512 KiB relay limit. Download it for manual import.')
      const checksum = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map(value => value.toString(16).padStart(2, '0')).join('')
      requireRelayContext()
      const id = crypto.randomUUID()
      const revision = client.snapshot?.context?.revision
      if (!revision || contextKey() !== key) throw new Error('Workspace changed while preparing SVG.')
      pendingImport = { id, relayId: client.identity.relayId }
      try { localStorage.setItem(PENDING_IMPORT_KEY, JSON.stringify(pendingImport)) }
      catch (error) {
        pendingImport = null
        throw new Error(`Cannot save import journal; no job was sent: ${errorToMessage(error)}`)
      }
      setExportStatus(`Submitting relay job ${id}.`)
      let result: ReturnType<typeof parseJob>
      try {
        result = parseJob(await client.request('/jobs', {
          id, svg: built.svg, checksum, filename: `pathplotter-${Date.now()}.svg`, anchor: built.anchor, contextRevision: revision,
        }))
      } catch (error) {
        throw new Error(`Job ${id} submission outcome is unresolved: ${errorToMessage(error)}. Use Check last import; do not resubmit blindly.`)
      }
      await followRelayJob(client, result)
      return
    }
    await fetchStatus()
    setExportStatus('Uploading SVG to LightBurn...')
    const confirmation = waitForFileImported(20000)
    const response = await authorizedFetch('/api/file/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Filename': `pathplotter-${Date.now()}.svg`,
        'X-Position-X': String(built.anchor.x),
        'X-Position-Y': String(built.anchor.y),
        'X-Origin': 'center',
      },
      body: new TextEncoder().encode(built.svg),
    })
    if (response.status !== 202) {
      setExportStatus(`Upload was rejected (${response.status}).`)
      return
    }

    async function followRelayJob(client: RelayClient, initial: ReturnType<typeof parseJob>): Promise<void> {
      let job = initial
      const deadline = performance.now() + 90000
      while (true) {
        setExportStatus(`RAP import ${job.id}: ${job.status}${job.error ? ` — ${job.error}` : ''}.`)
        if (['confirmed', 'failed', 'expired', 'unknown'].includes(job.status)) {
          if (job.status !== 'unknown') clearPendingImport()
          return
        }
        if (performance.now() > deadline) {
          setExportStatus(`RAP job ${job.id}: outcome not yet known. Check RAP before submitting another import; do not retry blindly.`)
          return
        }
        await new Promise(resolve => window.setTimeout(resolve, 1000))
        try { job = parseJob(await client.request(`/jobs/${encodeURIComponent(job.id)}`)) }
        catch (error) { throw new Error(`Cannot determine outcome of RAP job ${job.id}: ${errorToMessage(error)}. Check RAP; do not retry blindly.`) }
      }
    }
    const imported = await confirmation
    if (imported.status === 'confirmed') {
      setExportStatus('LightBurn confirmed import success.')
    } else if (imported.status === 'failed') {
      setExportStatus(`LightBurn reported import failure: ${imported.error ?? 'unknown error'}`)
    } else {
      setExportStatus(`Upload accepted (202), but import confirmation is unknown: ${imported.error ?? 'timed out waiting for file_imported event'}`)
    }
  } catch (error) {
    setExportStatus(errorToMessage(error))
  } finally {
    uploadInFlight = false
    renderControls()
  }
}

async function waitForFileImported(timeoutMs: number): Promise<{ status: 'confirmed' | 'failed' | 'unknown'; error?: string }> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await authorizedFetch('/api/events', {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    })
    if (!response.ok || !response.body) {
      return { status: 'unknown', error: `events stream unavailable (${response.status})` }
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let currentEvent = 'message'
    let dataLines: string[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        return { status: 'unknown', error: 'event stream closed before confirmation' }
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim()
          continue
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim())
          continue
        }
        if (line.trim() !== '') {
          continue
        }
        if (dataLines.length > 0) {
          const raw = dataLines.join('\n')
          dataLines = []
          const payload = safeJson(raw)
          const isImportEvent =
            currentEvent === 'file_imported' ||
            (payload && typeof payload === 'object' && ('success' in payload || payload.type === 'file_imported'))
          if (isImportEvent && payload && typeof payload === 'object' && 'success' in payload) {
            const success = Boolean(payload.success)
            if (success) {
              return { status: 'confirmed' }
            }
            return { status: 'failed', error: typeof payload.error === 'string' ? payload.error : 'file_imported reported failure' }
          }
        }
        currentEvent = 'message'
      }
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      return { status: 'unknown', error: 'timed out waiting for file_imported event' }
    }
    return { status: 'unknown', error: errorToMessage(error) }
  } finally {
    window.clearTimeout(timeout)
    controller.abort()
  }
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function buildSvgForCollection(): { svg: string; anchor: { x: number; y: number }; unsupportedCharacters: string[] } | null {
  if (!hasExportGeometry()) {
    return null
  }
  const primitives: Primitive[] = []
  const unsupportedCharacters: string[] = []
  for (const group of captureGroups(state)) appendCollectionPrimitives(group, primitives, unsupportedCharacters)
  if (primitives.length === 0) {
    return null
  }
  const bounds = primitiveBounds(primitives)
  const width = Math.max(0.001, bounds.maxX - bounds.minX)
  const height = Math.max(0.001, bounds.maxY - bounds.minY)
  const anchor = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
  const svgBody = primitives
    .map(primitive => {
      if (primitive.kind === 'circle') {
        return `<circle cx="${fmt(primitive.cx - bounds.minX)}" cy="${fmt(bounds.maxY - primitive.cy)}" r="${fmt(primitive.r)}" fill="none" stroke="${escapeXml(primitive.color)}" stroke-width="${fmt(STROKE_WIDTH_MM)}" />`
      }
      const path = primitive.points
        .map((point, index) => `${index === 0 ? 'M' : 'L'} ${fmt(point.x - bounds.minX)} ${fmt(bounds.maxY - point.y)}`)
        .join(' ')
      const closed = primitive.close ? ' Z' : ''
      return `<path d="${path}${closed}" fill="none" stroke="${escapeXml(primitive.color)}" stroke-width="${fmt(STROKE_WIDTH_MM)}" />`
    })
    .join('\n')
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}mm" height="${fmt(height)}mm" viewBox="0 0 ${fmt(width)} ${fmt(height)}">\n${svgBody}\n</svg>`
  return { svg, anchor, unsupportedCharacters }
}

function appendCollectionPrimitives(set: CaptureGroup, primitives: Primitive[], unsupportedCharacters: string[]): void {
  if (!hasEnoughPoints(set)) {
    return
  }
  if (set.type === 'circles') {
    for (const point of set.points) {
      primitives.push({
        kind: 'circle',
        cx: point.x,
        cy: point.y,
        r: Math.max(0.01, set.circleDiameterMm / 2),
        color: set.strokeColor,
      })
    }
  } else {
    primitives.push({
      kind: 'polyline',
      points: set.points.map(point => ({ x: point.x, y: point.y })),
      close: set.type === 'polygon',
      color: set.strokeColor,
    })
  }
  if (!set.showNumbers && !set.showNames) {
    return
  }
  for (let index = 0; index < set.points.length; index += 1) {
    const point = set.points[index]
    const parts: string[] = []
    if (set.showNumbers) {
      parts.push(String(index + 1))
    }
    if (set.showNames && point.name.trim()) {
      parts.push(point.name.trim())
    }
    const label = parts.join(':')
    if (!label) {
      continue
    }
    const labelPolylines = strokeTextPolylines(
      label,
      point.x + set.labelOffsetX + point.labelOffsetX,
      point.y + set.labelOffsetY + point.labelOffsetY,
      set.labelHeightMm,
      unsupportedCharacters,
    )
    for (const line of labelPolylines) {
      primitives.push({
        kind: 'polyline',
        points: line,
        close: false,
        color: set.labelColor,
      })
    }
  }
}

function strokeTextPolylines(
  text: string,
  x: number,
  y: number,
  height: number,
  unsupportedCharacters: string[],
): Array<Array<{ x: number; y: number }>> {
  const upper = text.toUpperCase()
  const polylines: Array<Array<{ x: number; y: number }>> = []
  const scale = Math.max(0.2, height)
  let cursor = x
  for (const character of upper) {
    const strokes = glyphStrokes[character]
    if (!strokes) {
      unsupportedCharacters.push(character)
      cursor += scale * 1.25
      continue
    }
    for (const stroke of strokes) {
      const points = stroke.split(' ').map(token => {
        const [sx, sy] = token.split(',').map(Number)
        return { x: cursor + sx * scale, y: y - sy * scale }
      })
      polylines.push(points)
    }
    cursor += scale * 1.25
  }
  return polylines
}

function primitiveBounds(primitives: Primitive[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const primitive of primitives) {
    if (primitive.kind === 'circle') {
      minX = Math.min(minX, primitive.cx - primitive.r)
      minY = Math.min(minY, primitive.cy - primitive.r)
      maxX = Math.max(maxX, primitive.cx + primitive.r)
      maxY = Math.max(maxY, primitive.cy + primitive.r)
      continue
    }
    for (const point of primitive.points) {
      minX = Math.min(minX, point.x)
      minY = Math.min(minY, point.y)
      maxX = Math.max(maxX, point.x)
      maxY = Math.max(maxY, point.y)
    }
  }
  return { minX, minY, maxX, maxY }
}

function hasEnoughPoints(set: CaptureGroup): boolean {
  if (set.type === 'circles') {
    return set.points.length >= 1
  }
  if (set.type === 'polyline') {
    return set.points.length >= 2
  }
  return set.points.length >= 3
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function fmt(value: number): string {
  return Number(value.toFixed(6)).toString()
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
    setStatus(`Saved collection could not be loaded: ${errorToMessage(error)}`)
    return emptyCollection()
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
      !finiteNumber(value.labelOffsetX) || !finiteNumber(value.labelOffsetY)) {
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
      ...(typeof value.coordinateContext === 'string' ? { coordinateContext: value.coordinateContext } : {}) }
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
  const busy = requestInFlight || uploadInFlight
  must<HTMLSpanElement>('collectionSummary').textContent =
    `${state.type} · ${allPoints(state).length} points · ${state.groups.length} finished groups`
  const relayReady = mode !== 'relay' || relay?.canCapture() === true
  const contextMatches = mode !== 'relay' || !allPoints(state).length || state.coordinateContext === contextKey()
  must<HTMLButtonElement>('captureBtn').disabled = busy || state.finished || !relayReady || !contextMatches
  must<HTMLButtonElement>('finishBtn').textContent = state.finished ? 'Resume' : 'Finish'
  must<HTMLButtonElement>('finishBtn').disabled = busy || (!state.finished && !hasEnoughPoints(state))
  must<HTMLButtonElement>('undoBtn').disabled = busy || state.points.length === 0
  must<HTMLButtonElement>('clearBtn').disabled = busy || allPoints(state).length === 0
  must<HTMLButtonElement>('settingsBtn').disabled = busy
  must<HTMLButtonElement>('pointsBtn').disabled = busy
  must<HTMLButtonElement>('sendBtn').disabled = busy || !hasExportGeometry() || !relayReady || !contextMatches ||
    (mode === 'relay' && pendingImport !== null)
  must<HTMLButtonElement>('downloadSvgBtn').disabled = busy || !hasExportGeometry()
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
    input.addEventListener('change', () => {
      updatePointFromInput(input)
    })
  })
  pointsTableEl.querySelectorAll<HTMLButtonElement>('button[data-point="delete"]').forEach(button => {
    button.addEventListener('click', () => {
      const pointId = button.dataset.id
      if (!pointId) {
        return
      }
      for (const group of captureGroups(state)) group.points = group.points.filter(point => point.id !== pointId)
      state.groups = state.groups.filter(group => group.points.length > 0)
      if (captureGroups(state).some(group => group.points.length > 0 && !hasEnoughPoints(group))) {
        setStatus('A group has too few points for its shape. Delete the rest of that group before exporting.')
      }
      persistAndRender()
    })
  })
}

function updatePointFromInput(input: HTMLInputElement): void {
  const pointId = input.dataset.id
  const key = input.dataset.point as keyof Point | undefined
  if (!pointId || !key) {
    return
  }
  const point = allPoints(state).find(entry => entry.id === pointId)
  if (!point) {
    return
  }
  if (key === 'name') {
    point.name = input.value
    persistAndRender()
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
