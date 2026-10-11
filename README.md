# PathPlotter

**Capture positions from LightBurn, plot them in your browser, and turn them into circles, open paths or closed outlines.**

PathPlotter is useful for recording positions around a workpiece, tracing an outline, or marking a series of locations. Move the head using your usual machine controls, then capture each reported **workpiece coordinate** from a computer or smartphone. Combine several capture groups, add point labels, and download an SVG or import it into the current LightBurn project.

**Open the web app:** https://nicholas-a11y.github.io/pathplotter/

PathPlotter does **not** move the machine, fire the laser or start a job. Sending artwork only imports it. Always inspect placement, layers and machine settings in LightBurn before operating the laser.

## What you need

- A Windows computer running LightBurn with its REST API available and enabled.
- A connected machine for which LightBurn reports valid workpiece X/Y coordinates and workspace context. PathPlotter uses the API rather than a controller-specific connection; this does not guarantee support for every controller or LightBurn version.
- The portable **RAP** connector running on that computer.
- An internet connection on both the LightBurn computer and the browser device. A phone does not need to be on the same Wi-Fi.
- For first-time RAP setup, an HTTPS relay address and a single-use registration invitation supplied by the relay operator.

This is a private development prototype, not an unrestricted public service. Opening the web app alone does not connect it to a laser. Real-machine placement and responsiveness must be checked with your setup; automated tests do not certify hardware behavior.

### How the connection works

```text
Browser (computer or phone)
          |
       HTTPS
          |
Cloudflare relay
          |
  outbound HTTPS from RAP
          |
RAP on the Windows computer
          |
   local LightBurn REST API
```

The web interface is hosted on GitHub Pages. RAP reads LightBurn locally and passes observations through the authenticated relay; it also imports SVGs explicitly sent by an authorized browser. The phone never connects directly to LightBurn and never receives its API secret.

Keep **Allow API Access From Network disabled** in LightBurn. RAP uses the local API, so no port forwarding or public LightBurn API is needed. Users do not need their own Cloudflare account.

## Connect for the first time

### On the LightBurn computer

1. Obtain the complete RAP folder from the project/operator, or download the **PathPlotter-RAP-Windows** artifact from a successful [Check PathPlotter and RAP workflow](https://github.com/nicholas-a11y/pathplotter/actions/workflows/checks.yml). Extract it somewhere writable; do not run it from inside the ZIP.
2. Open LightBurn and enable its REST API in **Settings > Extensions**. Leave network API access off.
3. Double-click **Start RAP.cmd**. **Start RAP.vbs** is an alternative that avoids the brief command-window flash.
4. In RAP's first-use setup, enter the operator-supplied relay address, a computer name and the registration invitation.
5. Click **Request local LightBurn permission**. Bring LightBurn to the foreground and approve its permission dialog within 30 seconds.
6. Once RAP has published a fresh, verified workpiece position, it opens PathPlotter automatically. Desktop authorization and capture control are automatic when control is free.

Subsequent RAP launches reuse protected credentials and open PathPlotter automatically. Use **Open PathPlotter** in RAP to open it again. Closing the RAP status window leaves it running in the tray; choose **Quit** to stop it. Launching RAP a second time shows the existing instance rather than starting another connector.

RAP is portable and uses Windows PowerShell 5.1 and .NET Framework; everyday use does not require Node, Python or administrator access. If Windows policy blocks its scripts, follow your organization's approved procedure rather than disabling security protections.

### On a phone or another browser

1. In RAP, choose **Pair phone**.
2. Scan the QR code or open its private, expiring link.
3. The browser requests pairing automatically. Compare its phrase with the approval card in RAP.
4. Click **Approve matching phrase** on the computer.
5. Wait for fresh coordinates and capture control. If another browser has control, use **Take control** and confirm the switch.

Phone requests always require desktop approval. Do not share pairing links or screenshots of the QR code.

The browser's **Connection** dialog also supports manual entry of the relay URL, relay ID and invitation. Its single **Pair** button pairs and requests capture control. An already paired browser can use **Pair** without another invitation. Saved same-RAP authorization is reused; reopening a same-RAP link closes Connection immediately and puts any outstanding-work reminder in the main status area.

For detailed startup, tray controls and credential recovery, see [RAP instructions](rap/README.md).

## Capture your first shape

1. Open **Capture settings**, choose a shape and its colours, then click **Apply settings**.
2. Position the head with the machine's normal controls. Watch the live crosshair and coordinate readout.
3. Click **Capture point** for each position. On a keyboard, press **Space** when no dialog, text field or button has focus.
4. Click **Finish** when the current shape has enough points. **Enter** performs the same action outside dialogs and controls.
5. To collect another shape, change settings if needed and click **Resume**. Capture the next group and finish it.
6. Use **Edit points** to adjust names, coordinates or label offsets.
7. Click **Download SVG**, or **Send to LightBurn** to import the whole collection into the current project.

| Shape | What it creates | Minimum points to finish/export |
| --- | --- | --- |
| Circles | One circle centered on each captured position, using the chosen diameter | 1 |
| Polyline | An open path joining points in capture order | 2 |
| Polygon | A closed path joining the last point back to the first | 3 |

No separate set needs to be created before capturing. **Finish** saves the current group's points and settings; **Resume** starts the next group. Groups can have different shapes, colours, circle diameters and label settings. Numbering restarts at 1 in each group.

A full SVG export includes valid current geometry as well as finished groups; a valid polygon is exported closed even before Finish. In **Live update**, its closing edge is sent only on Finish.

### Settings and editing

- Geometry and labels have separate colour pickers using LightBurn's exact 32-colour Layers palette: 00-29, T1 and T2. New collections default to black/00 geometry and red/02 labels.
- Enable **Numbers**, **Point names**, or both. Set label height and group-wide X/Y offsets in Capture settings; Edit points provides additional per-point offsets.
- Labels are single-line vector strokes, not font-dependent text. Letters render uppercase; supported characters are A-Z, 0-9, spaces and `- _ . : /`. Unsupported characters are reported and omitted from full exports; live updates reject unsupported labels.
- **Edit points** includes finished groups and stays disabled when the entire collection has zero points. Edits are applied as values change; they never move the machine.
- **Undo** removes the last point in the current unfinished capture, not a point from an older finished group.
- **Clear points** clears all groups after confirmation and keeps your current capture settings. It does not delete anything already imported into LightBurn.
- Capture settings apply only on **Apply settings**; Cancel or Escape leaves them unchanged. Changing current settings does not restyle finished groups.
- If deletion leaves a nonempty group below its shape's minimum point count, full export is blocked. Restore enough points or delete its remaining points.

### Reading the plot

Coordinates are in **millimetres**, with **+X right and +Y up**. The plot has numbered rulers, an adaptive grid and equal X/Y scale. A bed outline is shown when workpiece dimensions are available; the visible range expands to include positions and captured geometry.

The crosshair turns black after **three distinct, fresh readings with exactly the same X/Y**. It turns red when the coordinates change; stale or disconnected data clears the stable indication. Black means the *reported coordinates* are stable, not proof that the head has physically stopped.

In cloud mode, Capture point copies the latest reported sample, rather than requesting a new measurement at the instant you tap. Samples must be no more than **2 seconds old**. RAP targets a 500 ms observation cycle, but network and API latency can make updates slower. A successful API observation is not proof of a newly measured physical position.

## Send once, or draw with Live update

### Download SVG / Send to LightBurn

**Download SVG** exports the full collection and does not require a connection. Manually importing that file uses LightBurn's normal placement behavior.

**Send to LightBurn** imports the full collection with a workpiece placement anchor. It does not replace earlier artwork, save the LightBurn project or start a laser job. Sending the same collection again can add duplicates. SVG export converts Y-up coordinates to SVG's Y-down orientation while keeping labels upright; verify the actual imported placement in LightBurn.

An accepted upload is not yet a confirmed import. Wait for the reported outcome and inspect the project. Avoid unrelated imports while PathPlotter is sending: LightBurn's import event does not carry a job ID, so concurrent external imports can make confirmation ambiguous.

### Live update to LightBurn

Live update is **off by default**. Use it when you want new geometry to appear in LightBurn as you capture, rather than sending the entire collection at the end.

1. Start at a new/empty group. Finish an existing capture first if necessary.
2. Choose the shape, colours and labels.
3. Enable **Live update to LightBurn** and approve the append-only warning. A verified workspace and capture control are required.
4. Capture normally. Finish each group; for a polygon, Finish sends its last-to-first edge.
5. Turn Live update off when done. Already queued updates continue draining; subsequent captures remain local.

Each circle sends one new circle. Each path point after the first sends only the next segment. The first path point sends no edge, but can send its label. Labels are sent once per point; coincident points do not create phantom edges.

Imports are serial, with at most **20 pending updates including the in-flight update**. Capture can continue while confirmations are pending, until the queue is full. The status shows on/off, pending and confirmed counts; `Off · 0/20 pending · 0 confirmed` is normal when live mode has not been used.

**This is append-only drawing, not synchronization.** Sent edges are separate LightBurn objects; a visually closed outline may need manual joining before fills or offsets. Editing or deleting points later changes PathPlotter only, not imported artwork.

While live mode or unresolved live work locks a group, its existing points, Undo and settings cannot be changed. Finish it to choose settings for the next group; unrelated older groups remain editable. Clear points, session replacement, destination changes and full Send are blocked during live work. After live imports, a full Send warns that it will add duplicates; Download SVG still exports the complete collection when other operation/tab guards permit it.

The relay allows **1,000 imports per rolling 24 hours per RAP**. Each nonempty live delta counts as an import. Quota errors pause work explicitly. Visible latency includes network, polling, LightBurn import time and any queue backlog.

## Saved points, control and recovery

### Browser autosave and session backups

Finished groups, the current capture and live-work records are saved in this browser. They are not automatically shared between a phone and a computer, or between different browser profiles.

Use **Session > Export session JSON** for a portable backup. **Import collection JSON** replaces the current collection after confirmation when points already exist. Version 3 group backups and version 2 single-collection backups are supported; older multi-set formats are not.

Session files contain points and settings, **not pairing credentials or the LightBurn API secret**. Backups containing unresolved live work cannot be imported through Session, to prevent replaying queued imports at another destination. Export a backup before clearing browser storage; do not use clearing storage as an import-recovery shortcut.

### Why a button is disabled

The capture status and hint show the actual blocking reason; pairing successfully is not enough to bypass saved-work safeguards.

| Situation | What to do |
| --- | --- |
| Waiting for fresh coordinates | Check RAP, LightBurn and the machine connection; return the browser to the foreground and wait for fresh data. |
| Another browser has capture control | Use **Take control**, or **Connection > Pair**, and confirm. Another browser's unresolved imports must be reconciled first. |
| Workspace confirmation needed | If saved points truly belong to this machine and workpiece origin, use **Connection > Advanced / recovery > Confirm workspace for existing points**. Otherwise export a session backup and clear the old points. |
| Capture finished | Click **Resume** to start the next group. |
| Finish disabled, but the summary shows points | The summary counts all groups. Finish needs enough points in the **current** group; older finished groups do not count. |
| Edit points disabled | There are no points, or an operation/tab handover prevents editing. Finished-group points count toward enabling it. |
| Live queue full or paused | Wait for space, or follow the live recovery steps below. |

Workspace confirmation associates saved coordinates with the current context; it does **not** move, translate or remeasure them. Context checks use API workspace/device information, not a guaranteed physical workpiece identity. Manually check the origin and workpiece even when no warning appears.

### Switching tabs or devices

Only one browser holds relay capture control at a time. An explicit takeover stops the previous browser from capturing; it does not automatically take control back.

For Live update tabs in the **same browser profile and site**, click **Pair** or enable Live update in the tab you want to use. The old owner stops new captures and subsequent imports, settles its current operation, saves the queue and releases its exclusive lock. The new tab checks the original destination/workspace before continuing safe unsent work; live capture continues if it was enabled.

The old tab stays open but read-only with Live update off. Simply opening a tab or switching focus does not request takeover. Paused/unknown work stays paused and submitted artwork is never automatically resent. If transfer times out, inspect LightBurn before closing the old tab and recovering saved work. This cooperative handover needs Web Locks and BroadcastChannel; it does not transfer collections or queues between devices or profiles.

### Interrupted full imports

In **Connection > Advanced / recovery**:

- **Check last import** asks for the saved job's outcome. It does not resend artwork.
- **Acknowledge uncertain import** clears an uncertain-import guard only after you inspect LightBurn and explicitly reconcile the outcome. It neither retries the import nor deletes artwork. A still-running import cannot be acknowledged.

The browser saves the pending job ID so a reload does not silently permit another Send. Another Send after acknowledgment can duplicate artwork; missing geometry must be corrected manually.

### Interrupted Live update

On reload, Live update is off and saved queued work is paused.

1. Inspect LightBurn and RAP. Use **Check live import** when available to query a cloud import.
2. For failed, expired, uncertain or interrupted work, use **Acknowledge import outcome** after checking what appeared. This removes the update without retrying it.
3. Choose **Resume queued updates** to continue safe unsent work at its original workspace, or **Abandon unsent updates**.

Abandoning preserves captured points and never removes LightBurn artwork. Local development imports have no queryable historical confirmation, so manual inspection is required. No exactly-once import guarantee is made; unknown outcomes stop dispatch instead of automatically re-uploading.

## Privacy and operational limits

- RAP's LightBurn secret remains on the computer. RAP credentials and its import journal use current-user Windows protection.
- Browser authorization is stored separately in browser storage. **Unlink this browser** removes the local pairing; use RAP's **Connected browsers** controls to revoke server authorization.
- Relay snapshots overwrite the latest coordinates rather than retaining movement history. Captured collections remain in the browser and SVGs travel through the relay for import.
- Terminal jobs discard their SVG payloads. Temporary records expire, but storage cleanup is request-driven; shutdown does not delete the whole Durable Object. Registration and browser authorization persist until revoked/reset as applicable.
- Pairing links are private grants. Scripts served from the same GitHub Pages origin are within the browser credential trust boundary.
- The operator must budget for hosting. A 500 ms publication interval alone is about 172,800 updates/day, before browser polling and coordination. Free-tier limits can stop service; free hosting is not guaranteed.

## Development and deployment

### Frontend

Use Node.js 24 and run from the project root:

```powershell
npm ci
npm run dev
```

Local development defaults to **Local development connection**, using the loopback Vite `/lightburn` API proxy to `http://127.0.0.1:19520`. In Connection, click **Connect** with an existing secret, or leave it blank to request local pairing. Bring LightBurn to the foreground and approve within 30 seconds. The local secret stays in memory and is excluded from autosave/backups.

Keep the development server bound to loopback. Its proxy is not included in the static build and is not a phone/LAN solution. Hosted browsers use RAP because direct browser-to-LightBurn access is restricted by CORS in the tested setup.

```powershell
npm test
npm run build
npm run preview
```

### Deployment components

- **Web app:** [pages.yml](.github/workflows/pages.yml) builds and deploys `dist/` to GitHub Pages on pushes to `main`, or by manual workflow dispatch. GitHub Pages must be configured for Actions.
- **Relay:** deployed separately; a Pages push does not redeploy it. See [relay setup and API contract](relay/README.md) for operator configuration and checks.
- **RAP:** use the matching updated RAP files and restart the connector. [checks.yml](.github/workflows/checks.yml) tests all three components and packages the Windows RAP artifact.

No backend credentials belong in frontend source or Pages variables. Registration is operator-controlled, not public self-enrollment.

### Real-machine check

Use a disposable LightBurn project without running the laser. Check circle positions and diameter, horizontal/vertical segments, polygon closure, colours, upright labels and multiple groups. For Live update, verify no earlier geometry is duplicated, queued work drains, and reload/connection-loss recovery never repeats an attempted import. Confirm placement and latency on each intended controller/setup before relying on it.

## Further reading

- [Portable RAP startup, permissions, tray controls and diagnostics](rap/README.md)
- [Relay development, enrollment and API behavior](relay/README.md)
- [LightBurn REST API](https://github.com/LightBurnSoftware/LightBurn-REST)
- [Original marking-mode discussion](https://forum.lightburnsoftware.com/t/marking-mode-like-found-in-xtool-studio/193060)
