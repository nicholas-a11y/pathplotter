# PathPlotter RAP (portable Windows tray app)

RAP relays **workpiece** observations from local LightBurn to an authenticated
HTTPS relay, and imports SVGs explicitly sent by a paired browser into the
current LightBurn project. It never jogs, fires, starts a job, or opens/replaces
a project. No Node, Python, packages, installation, administrator permission,
or global Windows configuration changes are required. Windows PowerShell 5.1
and the Windows .NET Framework are used.

## Start and consent

1. Extract the complete `rap` folder somewhere writable. Double-click
   **Start RAP.cmd** (or **Start RAP.vbs** to avoid even a brief command-window
   flash). RAP starts a small Windows Forms status window and tray icon, with no
   everyday console. A second launch activates the existing status window.
2. On first use, choose a computer name and **Register this computer**. The
   current relay is prefilled; leave the invitation blank for guided browser
   enrollment. RAP opens the hosted setup page and displays a comparison phrase.
   Verify the exact phrase for this computer, complete the browser verification
   and explicitly approve there, then confirm the matching phrase in RAP.
   Setup checks are at least five seconds apart. **Advanced: override relay
   origin** and an optional masked operator invitation retain existing setup paths.
   The service must have enrollment enabled; unavailable/full setup is not a
   reason to approve a different phrase or silently register another computer.
3. Open LightBurn, enable its REST API in Settings > Extensions, and keep
   **Allow API Access From Network disabled**. Click **Request local LightBurn
   permission** to consent to `state`, `project`, and `upload`. Bring
   LightBurn to the foreground and approve its dialog within 30 seconds.
4. Once a fresh verified LightBurn workpiece/context has been published
   successfully, RAP automatically opens hosted PathPlotter **once per launch**.
   Saved current-user DPAPI credentials are reused on subsequent launches.
   **Open PathPlotter** creates a fresh, short-lived desktop authorization each
   time you explicitly click it. It does not consume a phone invitation.
   The updated relay and browser handle single-use authorization, reuse valid
   browser identity and claim capture control if free; occupied control requires
   the browser's explicit Take control confirmation.
5. To pair another browser/phone, select **Pair phone**. Scan the locally
   generated expiring QR or copy its private link. Compare the exact browser
   phrase with its approval card in RAP, then click **Approve matching phrase**
   or **Reject**. Ordinary phone requests are never automatically approved.
6. Browser **Send** is authorization to import that SVG. Inspect the project
   and placement before independently deciding to operate the laser.

Do not record diagnostic sessions, enable PowerShell transcripts, or share pairing URL
screenshots: the URL intentionally displays a short-lived invitation. Durable
credentials, raw response errors, SVGs and coordinates are not printed.
QR generation uses the bundled MIT-licensed Net.Codecrete QR encoder v1.6.1
(a Project Nayuki port; source/license in `Vendor\QrCodeGenerator`). No external
QR service receives invitation material. The phone QR/link is cleared on expiry
or close; RAP clears its copied link only if the clipboard still contains that
exact link. Desktop launch URLs are never displayed, copied or QR encoded.

Closing the status window keeps RAP running in the tray. Tray actions are
**Open PathPlotter**, **Pair phone**, **Connected browsers**, **Status**, explicit
local permission resets, and **Quit**. Connected browsers provides revocation
buttons. Local resets preserve the journal and are not remote revocation:
also use LightBurn **Manage API Security** and ask the relay operator to revoke
old agent credentials. Invalid/unreadable saved registration requires explicit
graphical replacement consent; an unreadable journal remains a blocking error.
For cloud authorization failures, use the explicit local-registration reset
after consulting the operator; no automatic enrollment or import retry occurs.

The STA UI only handles controls and messages. One controlled MTA PowerShell
runspace owns all protocol operations and serialized imports; synchronous
network calls never run on the form/tray thread. First-time LightBurn's own
consent dialog and bounded HTTP requests can delay worker actions, not the UI.
Quit waits for worker cleanup, fences incomplete imports, disposes retained
streams/sockets, and removes the tray icon. Socket closure reports disconnect;
slow HTTP mode only sends a disconnected update if its five-second interval permits.
It does not force-kill an upload or erase uncertain outcomes.

The launcher does **not** use an execution-policy bypass. If Windows policy
blocks the script, use an organization-approved signed distribution and consult
your administrator. For downloaded files, verify the release source/signature
and follow your organization's file-unblocking procedure. RAP does not set
execution policy, unblock files, install certificates, or modify global policy.

## Console commands and revocation

Use **Start RAP diagnostics.cmd** for the original typed console workflow.
Quit the tray instance before starting diagnostics (both retain the same durable
instance lock and protected state). Diagnostics intentionally keeps manual
`pair`/`open`/approval commands; it is not the everyday auto-launch workflow.

Commands run between serialized observations. Import setup still performs
bounded synchronous HTTP requests and SSE readiness checks; commands can be
delayed during setup, but not by the 20-second confirmation wait.

| Command | Effect |
| --- | --- |
| `help` | Show commands. |
| `pair` / `open` | Create a five-minute single-use invitation / open the last displayed URL. |
| `approve ID` / `reject ID` | Decide a currently pending, phrase-verified pairing. |
| `browsers` | List paired browser IDs. |
| `revoke ID` | Revoke a browser through the authenticated relay contract. |
| `slow-http` | Explicitly opt into HTTP updates at least five seconds apart; capture, approval and job delivery are slower. |
| `socket` | Restore normal socket transport; reconnect with a new generation. |
| `forget-lightburn` | Forget the local LightBurn secret and stop. **Also revoke** PathPlotter RAP in LightBurn's **Manage API Security**. Restarting requires explicit pairing consent. |
| `forget-relay` | Delete local credentials and stop, preserving the import journal. **Ask the operator to revoke the old relay agent credential**, and revoke the LightBurn entry in its UI. |
| `quit` / Ctrl+C | Stop; publish a disconnected heartbeat when possible. |

The v1 relay contract has **no agent-credential self-revocation endpoint**,
and LightBurn has no documented HTTP secret-revocation endpoint. Forget commands
do not pretend to revoke those remote credentials. Browser revocation does use
the documented endpoint. An ambiguous pairing/revocation request is not
automatically repeated; inspect the browser list/status before trying again.

## State, reconnect and freshness

Current-user DPAPI encrypts credentials and the durable import journal in
`%LOCALAPPDATA%\PathPlotter\RAP`. The directory grants access only to the current
Windows user and disables inherited ACLs. A file lock excludes duplicate RAP
protocol workers. The desktop additionally uses a current-user mutex and
ACL-restricted named pipe with a single fixed **show status** action, excluding
network logons. No arbitrary command, URL or credential is accepted via IPC.
These protections do not defend against software running as your
Windows user or an administrator.

Enrollment additionally protects `enrollment.dpapi` **before** sending its
random 32-byte verifier. A lost start/claim reply is resumed explicitly using
the same relay, computer name and verifier, not a new identity. The verifier
never enters the browser URL. Claimed credentials are flushed to
`credentials.dpapi` before the pending enrollment is removed. **Discard expired
enrollment setup** requires explicit consent: discarding an ambiguous verifier
can forfeit registration recovery. Existing credentials and journals are untouched.

RAP targets **500 ms local observations**, without overlapping status/project/position
reads, independently of publication and reconnect backoff. With authorized
preview active, changed observations are published at **at most 2 Hz**. Three
distinct identical local observations establish settled state; it is published
once, then stationary updates wait for **15-second fresh health** or explicit
server work. Without preview, ordinary coordinates are not continuously pushed.
Latency and synchronous import setup can make actual observation intervals longer.
Confirmation is cooperatively polled without waiting across main-loop iterations,
retaining one SSE stream while local observation and socket work continue.
This is not a hard 500 ms delivery guarantee, and the **2-second stale cutoff
is unchanged**. API success is an observation, not proof of a newly measured controller
position. Missing workpiece X/Y never fall back to machine coordinates or zero.
Missing workpiece dimensions remain `null`; missing machine size, workpiece
offset or machine-view context fails closed.

Timed `/agent/start` and socket `update-result` responses supply `serverTime`. RAP
calibrates a monotonic server-clock estimate with **full roundtrip duration**
as its uncertainty, never the desktop wall clock. Each connected update includes
`observedAtServer` (back-projected to the earliest instant of the local read)
and `clockUncertaintyMs`, as well as elapsed read age. The backend computes
`max(reported age, serverNow - observedAtServer + clockUncertaintyMs)` at receipt,
so a buffered/delayed observation cannot look newly observed. Socket connect
and send deadlines are five seconds; unacknowledged updates fail after five seconds.
HTTP fallback updates retain a whole-request 1000 ms abort deadline. Missing calibration or a local sample
exceeding 2 seconds publishes disconnected with no position/context. Browsers
still account for receipt age and their own server-clock calibration.
Socket reconnect uses bounded backoff (0.5–30 s); HTTP fallback reconnect never
accelerates its five-second update interval. Local observations continue independently.
A new agent generation fences old sessions; fresh observations are required.

The built-in .NET `ClientWebSocket` authenticates
`/v1/relays/{relayId}/agent/stream?generation=N` using the Authorization header,
not credentials in a URL. Transport helpers only enqueue text: **16 KiB outgoing
/ 1 MiB incoming per message** (incoming includes the existing 512 KiB SVG job),
**16 outgoing / 32 incoming messages, 4 MiB total incoming payload**,
strict UTF-8 and text-only receive,
including bounded fragmented messages. All v2 JSON, pairing, capture and job
handling remains in the single MTA worker. `work` requests force a fresh update
even when stationary so pending jobs can be safely claimed. `capture` requests
perform a **new local read**, correlated by UUID, and return `capture-result` with
the original observation timing, never a cached preview or a restamped result.
The server enforces request lifetime/context/owner/generation; a late read fails
instead of weakening the browser's two-second freshness requirement.

There is **no automatic HTTP fallback**. Expand **Advanced connection settings**
in the status window, choose **WebSockets (recommended; reconnects automatically)**
or **Compatibility mode - slower HTTP**, then click **Apply**. Selecting a radio
button alone does not reconnect. Apply is unavailable during imports, and the
worker also refuses transport changes while an import is active. The status
reports the actual transport separately from the selected, unapplied choice.
Select the same transport in PathPlotter. WebSockets is the default at startup.
Use `slow-http` in diagnostics to explicitly enable reduced-rate updates
and capture work, no faster than every five seconds. Socket mode restores normal
operation with a new generation. No transport switch retries an uncertain upload.
The fallback can miss a ten-second capture deadline during slow local reads,
setup or uploads; request a new capture explicitly, never commit an old preview.

API authorization failure, no machine connection, network refusal/timeouts,
and invalid context/coordinates are distinct fixed local error categories.
No automatic LightBurn pairing is performed on authorization failure. Check
the Windows clock, API capability grants, and which LightBurn copy has focus.
Use `forget-lightburn` and restart only when you intend to pair again.

## Optional website-first code pairing

The status window offers **Allow code pairing** while RAP is healthy and no import is active. The operator must first enable `CODE_PAIRING_ENABLED="true"` on the relay; it is off by default. Browser code pairing does not require Turnstile. This is separate from transport settings and guided computer enrollment, which still uses verification.

1. On the static website, choose **Connection > Cloud relay (RAP) > Start code pairing**.
2. In RAP, explicitly choose **Allow code pairing**.
3. Enter the displayed three letters in the website within the **60-second** countdown. No relay ID or QR is needed.
4. Compare the browser's phrase with the request in RAP and **Approve**, or **Reject** an unwanted request. The request expires two minutes after submission. No access is granted until approval; RAP must still be healthy, idle and in the same session generation.
5. The website checks approval automatically every seven seconds. An approved browser retains access until revoked through **Connected browsers**. Capture-control takeover remains a separate explicit browser action.

**A code alone never grants access.** Someone who guesses it can consume the window and create an unwanted approval request. Reject any phrase that does not match your own browser. Strict limits remain in place, and this does not prove the browser is on the same LAN. **Pair phone** with its longer random invitation remains available.

**Cancel code** closes an unclaimed window. Once a request appears, use **Reject**; approved access must be revoked separately. Expiry does not renew the code. RAP hides codes when disconnected and attempts cancellation of open windows on disconnect/orderly quit; failure to reach the relay cannot guarantee immediate cancellation, so server expiry still applies. Closing the status window merely hides RAP in the tray and is not Quit.

If issuance is interrupted, explicitly retry **Allow code pairing** to recover the same window within its lifetime. If the browser loses a reply, use its **Recover pairing**, not the short code again. Recovery lasts two minutes after acceptance. Existing QR/desktop links and saved pairing remain unchanged.

Service admission is limited to five live windows globally, three initial submissions/IP/minute and ten globally/minute; new windows are separately capped at three/RAP and thirty globally per rolling ten minutes. Limits can temporarily block legitimate users. No code is automatically issued on startup or reconnect.

## Import safety and limitations

Every claimed job is serialized and checked for expiry, context revision,
finite anchor, safe filename, immutable UTF-8 SHA-256 checksum, 512 KiB limit,
and the existing application's constrained SVG vocabulary (root SVG, outline
circles and M/L/Z paths only). No external references, DTDs, scripts, styles,
embedded text, nested SVGs or arbitrary path commands are accepted.

RAP opens authenticated SSE and waits for the documented **`:connected`**
comment **before** uploading. It rechecks workpiece/context after readiness and
after the cloud acknowledges `attempting`. A DPAPI journal is atomically
replaced and flushed before any upload attempt. Uploads use an unbuffered,
non-pipelined fresh connection with redirects disabled, avoiding automatic
buffered POST replay. Only HTTP 202 is accepted;
only the exact SSE **`event: file_imported`** with JSON boolean `success` confirms
or explicitly fails import. Generic success/type fields are not confirmations.
An unavailable SSE stream prevents upload; there is no polling fallback for
import confirmation.

Only one import is active, including its confirmation window. The SSE reader
is retained after HTTP 202 and checked nonblockingly until a genuine event,
stream closure, or a monotonic 20-second deadline after the upload response.
The main loop continues publishing fresh observations during that window; it
does not start a second import until the first is terminal. Terminal status is
journaled before releasing the stream and reconciled with the cloud on subsequent
updates. Stop, unexpected exit, or cloud generation loss disposes the stream;
an attempted import becomes unknown, while a setup aborted before upload fails.

An accepted upload without confirmation, timeout/disconnect around upload,
unexpected upload response, or restart during claimed/attempting/accepted state
becomes **unknown**. RAP never automatically resends it. Inspect LightBurn and
reconcile manually; a deliberate resend must be a new browser job. Journal
tombstones remain locally indefinitely (no SVGs or coordinates), including
failed jobs, to prevent duplicate delivery from repeating a side effect.
Do not delete or restore an older journal to retry a job. Corrupt DPAPI/journal
state blocks startup rather than silently resetting.

LightBurn does **not** document event-to-job correlation or import idempotency.
RAP serializes its own jobs, but cannot distinguish unrelated imports producing
`file_imported` during its upload window. Avoid other imports or API clients
while RAP is importing. Context can also change between the final check and
LightBurn applying the upload; undocumented origin changes cannot be promised
detectable. These are protocol limitations, not an exactly-once guarantee.

Cloud timestamps accept epoch milliseconds or ISO-8601 UTC strings; numeric
generation and increasing sequence preserve fencing under the v2 transport. The tray's
desktop launch requires the updated authenticated
`POST /v1/relays/{relayId}/agent/browser-launch` endpoint: `{}` returns
`{launchToken, expiresAt}`. RAP opens `#relay=...&relayId=...&launch=TOKEN`
only in the default browser. The grant expires after two minutes and is
single-use; it is a bearer grant, not proof of physical locality.
Ordinary phones continue using `/pairing/new` and explicit `/pairing/decide`.
The local SVG allowlist is intentionally narrow and
matches the current app exporter; unsupported future SVG variants are rejected,
not silently imported.

## Deterministic Windows checks

From the project root, run:

```powershell
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -File ".\rap\Test-RAP.ps1"
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -STA -File ".\rap\Test-GUI.ps1"
```

The standalone script returns a nonzero exit code on failure and requires
actual PS5.1. It parses all RAP scripts, compiles the in-memory .NET helpers,
tests DPAPI/atomic state/ACLs, exact HMAC/SVG/freshness/context validation
(including delayed-publication and missing-calibration cases),
strict SSE recognition, raw HTTP transport and real ClientWebSocket
Authorization/send/fragmentation/size/cancellation against ephemeral loopback
**test fixtures**, and mocked approval/revocation/import ordering, fencing,
nonblocking main-loop publication during confirmation, serial imports, timeout,
stop/exit cleanup, duplicate delivery and restart reconciliation. Scheduling checks
verify independent 500 ms reads, 2 Hz maximum pushes, settled-once/15-second
health, stationary fresh capture and pairing work, explicit >=5-second HTTP
fallback, and verifier-bound ambiguous enrollment recovery.
It never contacts LightBurn/cloud, requests hardware
pairing, uploads to hardware, or changes the user's real RAP state. Its isolated
test state and compilation scratch files stay within `rap` and are removed.
No test framework or runtime installation is needed.

`Test-GUI.ps1` compiles the bundled local QR encoder, rejects desktop-grant QR
generation, verifies fixed-action duplicate activation, and runs a real STA
form/tray with a mocked protocol runspace. It exercises guided graphical enrollment,
matching-phrase confirmation and >=5-second pending claim checks,
denied and then explicitly retried local consent, healthy auto-open once,
phone QR/link expiry, exact-phrase targeting (mismatches cannot approve),
explicit rejection, responsive worker/UI scheduling, and graceful disconnected
shutdown with lock/IPC release. All test state stays under `rap` and is removed;
no real browser opens, networking, user credentials or hardware are used.
Real-phone scanning, default-browser launch, actual LightBurn consent/hardware
and policy-restricted distribution still require an operator-led smoke test.

### Live update rollout

The tray keeps the existing coordinate-publication and import protocol; it does
not itself enable browser Live update, alter relay admission limits, or accept
additional SVG vocabulary. Deploy it alongside the updated desktop-launch,
browser pairing/control, browser queue and relay changes, with Live update
default off. Before enabling live
drawing on hardware, verify fresh coordinates during delayed confirmation,
ordered imports, timeout/stop/restart recovery, and unchanged existing LightBurn
objects. Inspect uncertain outcomes manually; never replay an attempted job.

API shapes were verified against official
[LightBurn-REST documentation](https://github.com/LightBurnSoftware/LightBurn-REST/tree/43d3a4ec5aeb14219f0acaefc8fe01ede57f63ac/docs)
(`authentication.md`, `api-reference.md`, `uploading.md`, `openapi.yaml`).
No real hardware pairing/upload or deployment has been performed.
