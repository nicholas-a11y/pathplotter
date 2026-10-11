# PathPlotter

PathPlotter is a static web tool for collecting LightBurn workpiece coordinates and turning them into SVG geometry that can be imported back into LightBurn.

## Cloud relay prototype

The hosted web app stays at https://nicholas-a11y.github.io/pathplotter/. The new cloud transport uses a Cloudflare Worker and one private Durable Object per Windows RAP installation. RAP runs beside LightBurn and makes outbound HTTPS requests; the phone never calls LightBurn directly. No port forwarding, public LightBurn API, Firebase or per-user Cloudflare account is needed.

This is a development prototype, not an already deployed service. Deploy and configure the backend before attempting cloud pairing. Real Windows/phone/LightBurn testing is required before general release.

Backend setup and checks are in [relay/README.md](relay/README.md). Windows startup, consent, console commands and recovery are in [rap/README.md](rap/README.md). The prototype prints a private pairing URL; local QR generation is not implemented yet.

Budget for usage before leaving RAP running continuously. A 500 ms publication interval alone is approximately 172,800 updates per day; browser polling and coordination add requests and storage operations. This is not a promise of free hosting. Free-tier limits can stop the relay rather than merely slow it down; measure actual use and choose a suitable Workers plan.

### Pair a browser

1. Run the Windows RAP on the LightBurn computer and approve its access in LightBurn.
2. Generate a pairing invitation in RAP and open its link on the phone or desktop browser. The link contains a short-lived invitation, not the LightBurn secret. Treat it as private until consumed.
3. Click **Pair with RAP**, compare the verification phrase, and approve the request in the RAP console.
4. Click **Use this browser**. Only one browser has capture control at a time; another browser must wait for its lease to expire.
5. Position the head using the usual machine controls. **Capture point** copies the latest reported workpiece sample, rather than taking a fresh reading at tap time.
6. **Send to LightBurn** creates a bounded, expiring SVG job. The result distinguishes acceptance from confirmed import.

The cloud connection dialog also allows entering the relay URL, ID and invitation manually. The hosted build defaults to cloud mode; localhost development defaults to the existing local proxy.

### Freshness and workspace protection

- RAP targets a successful read every 500 ms without overlapping requests. Actual frequency depends on LightBurn and network latency.
- Capture requires a connected machine, browser control, a valid context and a sample no more than **2 seconds** old. The browser includes observation duration, server residence, round-trip time and elapsed time in its conservative age estimate.
- The age indicates a successful API observation, not proof that the controller just measured the physical position.
- The live crosshair turns black after three consecutive distinct fresh readings have exactly the same X/Y. It turns red on a coordinate change; stale/disconnected data clears this indication. Repeated receipt of the same relay sequence does not count. Black means stable reported coordinates, not proof that the machine has physically stopped.
- Errors, browser background/resume and disconnected relays disable capture until fresh data arrives.
- Existing/imported points from an unknown or different relay workspace cannot be mixed or sent silently. Clear them or use **Confirm workspace for existing points** after checking the machine and workpiece origin.
- SVG download remains available without a relay connection.

### Import uncertainty

Only one import is active per relay. Jobs expire before starting; uncertain uploads are never automatically repeated. The browser saves a pending job ID before submission so refreshing the page does not silently permit another Send.

If disconnected during submission or confirmation, use **Check last import** in Connection and inspect RAP/LightBurn. **Acknowledge uncertain import** clears the browser's guard only after explicit manual reconciliation; another Send could duplicate artwork.

LightBurn's API does not provide documented import idempotency or reliable per-job event correlation. Even serialized RAP uploads cannot eliminate ambiguity from unrelated concurrent imports. No exactly-once guarantee is made.

### Privacy and credentials

Only the latest coordinates are retained, not movement history. SVG jobs and bounded result metadata are temporary. The LightBurn secret stays on the desktop; local RAP credentials use current-user Windows protection. Browser pairing credentials are separate, stored in browser storage and excluded from collection/session JSON.

Clear browser data or **Unlink this browser** to remove local pairing. Revoke the browser in RAP to remove its server authorization. Account-free pairing means a new phone or cleared browser must pair again. Scripts served by the same GitHub Pages origin are part of the browser credential trust boundary.

The Cloudflare backend must enforce authorization on every operation; relay IDs and storage paths are not access controls. The private prototype uses operator-issued enrollment invitations instead of unrestricted public registration. Do not put Cloudflare account tokens, enrollment secrets or LightBurn secrets into Pages build variables or frontend source.

## What this first version does

- Reads live position from LightBurn `GET /api/position` (workpiece X/Y in mm).
- Captures points into one collection, with an optional name that starts blank.
- A single **Capture settings** modal controls the whole collection:
  - Circles (one circle per point)
  - Polyline (open path)
  - Polygon (closed path)
- Lets you edit point names and numeric coordinates.
- The plot uses Cartesian orientation: increasing X goes right and increasing Y goes up. Stored workpiece coordinates remain unchanged. SVG export converts Y-up to SVG's Y-down direction using the complete geometry bounds, including circles and upright labels. Import placement still needs verification in LightBurn.
- Optional point numbering and point-name labels.
- Labels are exported as single-line vector strokes (no installed font dependency).
- Labels use uppercase letters with a quarter-glyph gap between characters. Number/name separators are short line strokes, not zero-length paths, so they survive SVG import.
- The workspace has numbered X rulers along the top/bottom and Y rulers on the left/right. Grid spacing adapts to screen size, with equal X/Y scale. Available LightBurn workpiece dimensions show a bed outline; incoming positions and captured geometry automatically expand the visible range.
- Downloads the collection as SVG.
- Sends the collection to LightBurn using `POST /api/file/upload`, preserving its workpiece placement. Downloaded SVGs imported manually use LightBurn's normal placement instead.

## Compact workspace workflow

1. Open **Connection** and click **Connect**. It uses an entered secret, or pairs locally when the field is blank. For pairing, bring LightBurn to the foreground (click its window or use Alt+Tab) and approve within 30 seconds. Live preview starts automatically and the dialog closes after two seconds on success. Errors leave it open; clear an invalid secret to pair again. There are no separate Test or preview controls.
2. Open **Capture settings** to choose circles, polyline, or polygon, and optional naming/labels.
3. Click **Capture point** (or Space outside controls/dialogs) at each desired position. No set needs to be created first.
4. Click **Finish** (or Enter) to finish capture; a polygon closes its last-to-first edge. Click **Resume** to add more points.
5. Open **Edit points** for numeric coordinate, point name, and label-offset edits.
6. Download SVG or **Send to LightBurn**. **Clear points** starts a new collection while preserving capture settings.
7. Use **Session** for JSON backups/import. The single-collection version 2 format does not load or migrate old multi-set sessions.

Settings dialogs apply on **Apply settings**; Cancel/Escape leaves the collection unchanged. Coordinates and labels remain editable after finishing. The connection secret stays in memory only and is not part of browser autosave or session backups.

## Important constraints

- This app does not jog/move the machine and does not start jobs.
- Capture is blocked if `workpiece.x`/`workpiece.y` are unavailable.
- LightBurn pairing (`POST /api/connect`) is localhost-only. Cloud-mode pairing is performed by RAP; the phone never receives the LightBurn secret.
- LightBurn owns the pairing consent dialog. In the tested setup it may not appear until its window receives focus; the browser cannot activate that desktop window. If consent times out, foreground LightBurn and retry pairing.
- Direct hosted-browser access to LightBurn remains blocked by its missing CORS support in the tested setup. Use RAP/cloud mode for phone access.

## Run locally

```bash
npm install
npm run dev
```

Build:

```bash
npm run build
```

Focused frontend transport tests (Node.js 24):

```bash
npm test
```

Preview build:

```bash
npm run preview
```

## Deploy to GitHub Pages

1. Build with `npm run build`.
2. Publish the `dist/` folder with your preferred Pages flow (Actions, `gh-pages`, or manual upload).
3. Deploy the relay separately and use its HTTPS origin in RAP/pairing. Pages contains no backend or LightBurn credentials.
4. Verify pairing, capture and correct SVG placement from a real phone before releasing.

## Connection notes

- Default API URL: `http://localhost:19520`.
- Local development defaults to a same-origin `/lightburn` proxy forwarding only API requests to `127.0.0.1:19520`. This avoids LightBurn's missing CORS support during desktop testing without disabling browser protections. Keep the development server bound to loopback.
- The development proxy is not included in the static production build. It remains a loopback desktop testing option, not a phone/LAN server.
- Keep LightBurn loopback-only with RAP. Both RAP and the phone need internet for cloud mode; they do not need the same Wi-Fi.
- Keep your secret private; session JSON export intentionally excludes it.
