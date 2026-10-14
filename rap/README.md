# PathPlotter RAP (Windows connector)

RAP is a small portable Windows app that runs beside LightBurn. It reads the laser head position through LightBurn's local REST API, sends it to PathPlotter through the hosted relay, and imports SVGs that your paired browser sends. It never jogs, fires or starts the laser.

RAP uses the built-in Windows PowerShell 5.1 and .NET Framework. It needs no installer, administrator access, Node or Python.

## First-time setup

1. Download **PathPlotter-RAP-Windows.zip** from the [latest release](https://github.com/nicholas-a11y/pathplotter/releases/latest), or use **Get started > Find Windows download** in PathPlotter.
2. Extract the whole ZIP to a folder you can write to, such as Documents. Do not run it from inside the ZIP.
3. Double-click **Start RAP.cmd**.
4. Paste the **Invitation ID** you were given and click **Register this computer**. Each Invitation ID registers one computer and expires after seven days.
5. RAP connects to the relay and opens PathPlotter in your default browser, so the browser is paired straight away. LightBurn does not need to be running yet.
6. Before capturing, connect your machine in LightBurn, click **Request local LightBurn permission**, then bring LightBurn to the foreground so its permission prompt appears. Approve it within 30 seconds. This is only needed once. Until LightBurn is ready, RAP and PathPlotter say "LightBurn not ready" and capture stays disabled.

Keep **Allow API Access From Network** off in LightBurn. RAP uses the local API and does not require that network-access setting.

Registration needs only the Invitation ID. RAP uses the hosted relay and this computer's Windows name automatically.

## Everyday use

- Start RAP with **Start RAP.cmd**. Starting it again just shows the running window.
- **Open PathPlotter** opens the app on this computer.
- While a browser is paired, the window shows **Disconnect paired browser** (under the status line) instead of **Open PathPlotter** and **Pair phone**. Disconnect it to pair a different browser, or to remove its access.
- **Pair phone** shows a QR code in the window (with **Copy link** for sending it another way). Scan it, check the phrase on the phone matches the one in RAP, then click **Approve matching phrase**.
- Only one browser is connected at a time. A paired browser reconnects by itself when you open PathPlotter again.
- Closing the window keeps RAP in the system tray. Right-click the tray icon and choose **Quit** to stop it.

## Updates

RAP checks for a new version every time it starts. You can also choose **Check for updates** from the tray menu; the version line then says "up to date" when there is nothing newer.

When a new version is available, the version line in RAP shows **Update now to vX.Y.Z**. Click it and confirm. RAP downloads the release from GitHub, checks its SHA-256 checksum, replaces its own files and restarts. Your registration and LightBurn permission are kept.

If the relay reports that this RAP is too old, RAP pauses, shows its window and asks you to click **Update now**. Updates are refused while an import is in progress.

If an update cannot be installed automatically, for example because the folder is read-only, download the new ZIP and extract it over the old folder.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Registration failed | Check the Invitation ID was pasted in full. Each ID works once; ask for a new one if it was already used or has expired. |
| "LightBurn not ready" | The browser can still be paired. Check that LightBurn is running, a machine is connected, and that you have granted RAP permission (the **Request local LightBurn permission** button). |
| "Relay disconnected" | Check the internet connection. Some company networks block WebSockets. |
| Nothing happens on start | Run **Start RAP diagnostics.cmd** to see startup errors in a console window. |
| Windows blocks the scripts | Follow your organization's approved procedure. Do not disable security protections. |

RAP considers LightBurn ready when its position API returns finite workpiece X/Y coordinates and valid project context is available. It does not require LightBurn's connection flag, which can report disconnected for a working Ruida machine. If the event stream reports disconnected or has no usable connection flag, RAP uses REST polling to verify coordinate availability instead.

This checks API coordinate availability, not physical connectivity: LightBurn may return cached coordinates. Check that the reported position follows the head when you move it in LightBurn. Failed position requests or invalid coordinates/context pause capture; existing freshness checks still apply.

The tray menu also has **Forget LightBurn permission** and **Forget local registration** for starting over. These do not revoke remote permissions.

## Privacy and safety

- Credentials are stored in `%LOCALAPPDATA%\PathPlotter\RAP`, protected for the current Windows user (DPAPI). The LightBurn API secret never leaves this computer.
- RAP accepts only the narrow SVG vocabulary PathPlotter produces: circles and M/L/Z paths, with no scripts, external references or text.
- Before uploading, each import is recorded in a protected journal. An import whose outcome is unclear (for example, the connection dropped mid-upload) is marked **unknown** and never resent automatically. Inspect LightBurn and reconcile it in PathPlotter.
- LightBurn's import event does not identify which upload it belongs to. Avoid other imports while PathPlotter is sending.

## For maintainers

### Files

| File | Purpose |
| --- | --- |
| `Start RAP.cmd`, `Start RAP.vbs` | Launchers: hidden, single-threaded-apartment GUI |
| `Start RAP diagnostics.cmd` | Same GUI with a visible console for startup errors |
| `GUI.ps1` | Windows Forms window, tray and smoke test |
| `GUIWorker.ps1` | Background worker: registration, consent, relay loop, update actions |
| `RAP.ps1` | Core library: LightBurn API, relay socket, import safety, storage |
| `Updater.ps1` | GitHub release check, checksum verification and file replacement |
| `Transport.cs`, `Desktop.cs` | Compiled helpers for sockets, the SSE stream and single-instance activation |
| `version.txt` | RAP version, compared against GitHub releases and the relay's `MIN_RAP_VERSION` |
| `Operator-Invitations.ps1` | Operator tool for batch invitations (not shipped in the ZIP) |
| elay.txt (optional) | A single https relay origin placed next to the RAP files to register against a self-hosted relay instead of the hosted one. Not shipped in the ZIP, and kept across updates |

### Tests

Run with the built-in Windows PowerShell 5.1:

```powershell
$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
& $ps -NoProfile -ExecutionPolicy Bypass -File .\rap\Test-RAP.ps1
& $ps -NoProfile -ExecutionPolicy Bypass -STA -File .\rap\Test-GUI.ps1
& $ps -NoProfile -ExecutionPolicy Bypass -File .\rap\Test-Operator-Invitations.ps1
```

They use local fixtures only. They make no cloud, GitHub or LightBurn calls and change no real credentials.

### Releasing a new RAP version

1. Update `rap/version.txt`, for example `3.1.0`.
2. Commit and push.
3. Tag the commit `rap-v3.1.0` and push the tag:

   ```powershell
   git tag rap-v3.1.0
   git push origin rap-v3.1.0
   ```

4. The [release workflow](../.github/workflows/rap-release.yml) checks that the tag matches `version.txt`, runs the web, relay and RAP tests, then publishes `PathPlotter-RAP-Windows.zip` and its `.sha256` file.
5. Running RAPs offer **Update now** at their next start or **Check for updates**.
6. Optional, for breaking relay changes: raise `MIN_RAP_VERSION` in [relay/wrangler.jsonc](../relay/wrangler.jsonc) and redeploy the relay **after** the release is published. Older RAPs then pause and ask the user to update.

To build the ZIP locally: `.\scripts\Package-RAP.ps1 -OutputPath <new path>\PathPlotter-RAP-Windows.zip`.

### Operator batch invitations

The operator holds a private `OPERATOR_ADMIN_TOKEN` (see [relay setup](../relay/README.md)). The tool asks for it securely; never type it as a command argument.

```powershell
$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
& $ps -NoProfile -ExecutionPolicy Bypass -File .\rap\Operator-Invitations.ps1 -Action Generate -Count 10 -Label "Workshop March"
& $ps -NoProfile -ExecutionPolicy Bypass -File .\rap\Operator-Invitations.ps1 -Action List
& $ps -NoProfile -ExecutionPolicy Bypass -File .\rap\Operator-Invitations.ps1 -Action Cancel -InvitationId <uuid from List>
```

**Generate** prints each Invitation ID once; hand one to each person. **List** shows status (unused, used, expired, cancelled) but never the secret values. **Cancel** takes the UUID from List, not the secret. A lost Generate reply is not retried: list, cancel the uncertain ones and generate replacements.
