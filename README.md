# PathPlotter

PathPlotter is a static web tool for collecting LightBurn workpiece coordinates and turning them into SVG geometry that can be imported back into LightBurn.

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
- LightBurn pairing (`POST /api/connect`) is localhost-only, so phone workflows must use a secret created on the LightBurn computer.
- LightBurn owns the pairing consent dialog. In the tested setup it may not appear until its window receives focus; the browser cannot activate that desktop window. If consent times out, foreground LightBurn and retry pairing.
- Browser access for hosted pages and phone-to-LAN usage still depends on your browser + network policy setup.

## Run locally

```bash
npm install
npm run dev
```

Build:

```bash
npm run build
```

Preview build:

```bash
npm run preview
```

## Deploy to GitHub Pages

1. Build with `npm run build`.
2. Publish the `dist/` folder with your preferred Pages flow (Actions, `gh-pages`, or manual upload).
3. Use HTTPS Pages URL in your real browser tests for CORS/network behavior validation.

## Connection notes

- Default API URL: `http://localhost:19520`.
- Local development defaults to a same-origin `/lightburn` proxy forwarding only API requests to `127.0.0.1:19520`. This avoids LightBurn's missing CORS support during desktop testing without disabling browser protections. Keep the development server bound to loopback.
- The development proxy is not included in the static production build. Direct browser access was blocked by CORS on the tested LightBurn installation; GitHub Pages and phone support require a separately implemented and tested secure connector.
- For same-Wi-Fi phone testing, use the LightBurn computer's LAN address (for example `http://192.168.1.50:19520`) and enable LightBurn network API access.
- Keep your secret private; session JSON export intentionally excludes it.
