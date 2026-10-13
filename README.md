# PathPlotter

**Capture positions from LightBurn, plot them in your browser, and turn them into circles, open paths or closed outlines.**

PathPlotter is useful for recording positions around a workpiece, tracing an outline, or marking a series of locations. Move the head with your usual machine controls, then capture each reported **workpiece coordinate** from a computer or phone. Combine several capture groups, add point labels, and download an SVG or import it into the current LightBurn project.

**Open the web app:** https://nicholas-a11y.github.io/pathplotter/

PathPlotter does **not** move the machine, fire the laser or start a job. Sending artwork only imports it. Always inspect placement, layers and machine settings in LightBurn before running the laser.

## What you need

- A Windows computer running LightBurn with its REST API enabled and a connected machine. PathPlotter reads positions through LightBurn's API, so it does not depend on the controller type. Placement should still be checked on your own setup.
- The portable **RAP** connector running on that computer.
- An **Invitation ID** from the PathPlotter operator to register your computer.
- An internet connection on the computer and on any phone you use. The phone does not need to be on the same Wi-Fi.

PathPlotter is a free service for up to 50 registered computers.

### How the connection works

```text
Browser (computer or phone)
          |  secure WebSocket
Cloudflare relay
          |  secure WebSocket (outbound from RAP)
RAP on the Windows computer
          |
   local LightBurn REST API
```

The web app is hosted on GitHub Pages. RAP and the browser both make outbound connections to the relay. RAP reads LightBurn locally, sends moving previews only while a browser is watching, and imports only the SVGs that your paired browser sends. Phones never connect to LightBurn and never see its API secret. No port forwarding or firewall rule is needed; some company networks block WebSockets.

Keep LightBurn's **Allow API Access From Network** setting **off**.

## Connect for the first time

1. In the web app click **Help > Find Windows download**, or go to the [latest release](https://github.com/nicholas-a11y/pathplotter/releases/latest). Download **PathPlotter-RAP-Windows.zip** and extract the whole ZIP somewhere writable.
2. In LightBurn enable **REST API** in **Settings > Extensions**.
3. Double-click **Start RAP.cmd**.
4. Paste your **Invitation ID** and click **Register this computer**.
5. RAP connects to the relay and opens PathPlotter in your browser, which pairs automatically. LightBurn does not need to be ready yet.
6. Before capturing, connect your machine in LightBurn, click **Request local LightBurn permission** in RAP, bring LightBurn to the front and approve within 30 seconds. This is needed once. Until LightBurn is ready, PathPlotter shows **LightBurn not ready** and capture stays disabled.

Later, start RAP and click **Open PathPlotter**. A browser that was paired before reconnects by itself when you open PathPlotter. If the connection is lost, PathPlotter shows a window offering **Reconnect now**.

RAP keeps itself up to date: when a new version is published it shows **Update now**. See the [RAP guide](rap/README.md) for updates, the tray menu and troubleshooting.

### Using a phone

1. In RAP click **Pair phone**.
2. Scan the QR code or open its private link on the phone.
3. Check that the phrase on the phone matches RAP, then click **Approve matching phrase**.

Only one browser is connected to a RAP at a time; pairing a phone replaces the computer's browser (and the other way round) after you confirm. Finish or acknowledge any pending imports in the old browser before switching. Do not share pairing links or photos of the QR code.

## Capture your first shape

1. Open **Capture settings**, choose a shape and its colours, then click **Apply settings**.
2. Position the head with the machine's normal controls. Watch the live crosshair and coordinate readout.
3. Click **Capture point** for each position, or press **Space** when no dialog, text field or button has focus.
4. Click **Finish** (or press **Enter**) when the shape has enough points.
5. To collect another shape, change settings if needed and click **Capture point** again to start a new group, then capture and finish.
6. Use **Edit points** to adjust names, coordinates or label offsets.
7. Click **Download SVG**, or **Send to LightBurn** to import the whole collection into the current project.

| Shape | What it creates | Minimum points |
| --- | --- | --- |
| Circles | A circle of the chosen diameter centred on each point | 1 |
| Polyline | An open path joining points in capture order | 2 |
| Polygon | A closed path joining the last point back to the first | 3 |

Each group keeps its own shape, colours, circle diameter and label settings. Numbering restarts at 1 in each group. A full export includes the current unfinished group as long as it has enough points.

### Settings and editing

- Geometry and labels have separate colour pickers using LightBurn's 32 layer colours (00-29, T1, T2). New collections default to black (00) geometry and red (02) labels.
- Enable **Numbers**, **Point names**, or both. Set label height and group X/Y offsets in Capture settings; Edit points adds per-point offsets.
- Labels are single-line vector strokes, not fonts. Letters render uppercase; supported characters are A-Z, 0-9, space and `- _ . : /`. Unsupported characters are reported and left out.
- **Undo** removes the last point of the current unfinished group.
- **Clear points** removes all groups after confirmation and keeps your settings. It never deletes anything already imported into LightBurn.
- Settings change only when you click **Apply settings**, and only affect the current and later groups.

### Reading the plot

Coordinates are in **millimetres**, with **+X right and +Y up**. The plot has rulers, an adaptive grid and equal X/Y scale. A bed outline appears when LightBurn reports the workspace size.

The crosshair turns black once LightBurn reports the same X/Y three times in a row, and red while coordinates change. Black means the *reported coordinates* are stable, not proof the head has physically stopped.

**Capture point asks RAP for a fresh reading** rather than reusing the preview. The reading must be no more than 2 seconds old; otherwise no point is saved. Moving previews are limited to 2 updates per second.

## Send to LightBurn

**Download SVG** exports the full collection and works without a connection.

**Send to LightBurn** imports the full collection at its workpiece position. It does not replace earlier artwork, save the project or start a job; sending again adds duplicates. Wait for the reported outcome before sending again, and avoid other imports while PathPlotter is sending: LightBurn's import event does not say which upload it belongs to.

## Saved points and recovery

### Autosave

Your groups and current capture are saved in this browser only. They are not shared between devices or browser profiles.

### Why a button is disabled

The status line explains the actual reason. When something needs a decision, PathPlotter opens a window for it automatically; click the status chip at the top to open it again if you closed it. Common cases:

| Situation | What to do |
| --- | --- |
| Waiting for fresh coordinates | Check RAP, LightBurn and the machine connection. |
| Another tab or browser has capture control | Choose **Take control** in the window that opens (or the **Take control** button). |
| Workspace confirmation needed | In the window that opens, choose **They belong to this workspace** if the saved points belong to this machine and origin. Otherwise choose **Download backup**, then **Clear points**. Confirming does not move or re-measure points. |
| Finish disabled but points exist | Finish needs enough points in the **current** group. |

### Interrupted imports

If a full Send is interrupted, PathPlotter opens a **Check the last import** window with:

- **Check import** asks RAP for the outcome. It never resends.
- **Acknowledge outcome** is for when the outcome is unknown. Inspect LightBurn first; this clears the warning without retrying or deleting anything.

PathPlotter never resends an import whose outcome is unknown, so a missing piece may need adding manually but nothing is silently duplicated.

## Privacy

- LightBurn's API secret never leaves the computer. RAP's credentials and import journal are protected for the current Windows user.
- **Help > Unlink this browser** forgets the pairing in this browser. RAP's **Paired browser** list (under Advanced connection settings) revokes it on the relay.
- The relay keeps only the latest coordinates, not movement history. SVGs pass through the relay for import, and temporary coordinates, jobs and pairing requests are deleted within 24 hours.

## Development

Use Node.js 24 from the project root:

```powershell
npm ci
npm run dev      # http://127.0.0.1:5173/pathplotter/
npm test
npm run build
```

The dev server connects to the hosted relay like the live site. To pair it, click **Pair phone** in RAP, then **Copy private phone link**. In the copied link, replace `https://nicholas-a11y.github.io/pathplotter/` with `http://127.0.0.1:5173/pathplotter/`, keeping everything from `#` onwards. Open the edited link and approve the matching phrase in RAP.

| Component | Deployment |
| --- | --- |
| Web app | [pages.yml](.github/workflows/pages.yml) publishes `dist/` to GitHub Pages on each push to `main`. |
| Relay | Deployed separately with Wrangler. See [relay/README.md](relay/README.md). |
| RAP | Released by pushing a `rap-vX.Y.Z` tag; users then click **Update now**. See [rap/README.md](rap/README.md#releasing-a-new-rap-version). |

[checks.yml](.github/workflows/checks.yml) runs the web, relay and RAP tests on every push.

### Real-machine check

Use a disposable LightBurn project without running the laser. Check circle positions and diameter, horizontal and vertical segments, polygon closure, colours, upright labels and multiple groups.

## Further reading

- [RAP guide: setup, updates, troubleshooting, releases and invitations](rap/README.md)
- [Relay deployment and API](relay/README.md)
- [LightBurn REST API](https://github.com/LightBurnSoftware/LightBurn-REST)
- [Original marking-mode discussion](https://forum.lightburnsoftware.com/t/marking-mode-like-found-in-xtool-studio/193060)
- [Hidden UI features](HIDDEN-FEATURES.md) — Live update, Backup, and other features that are present in the code but hidden from the default UI
