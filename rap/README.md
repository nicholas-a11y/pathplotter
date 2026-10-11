# PathPlotter RAP (Windows prototype)

RAP relays **workpiece** observations from local LightBurn to an authenticated
HTTPS relay, and imports SVGs explicitly sent by a paired browser into the
current LightBurn project. It never jogs, fires, starts a job, or opens/replaces
a project. No Node, Python, packages, installation, administrator permission,
or global Windows configuration changes are required. Windows PowerShell 5.1
and the Windows .NET Framework are used.

## Start and consent

1. Extract the complete `rap` folder somewhere writable. Double-click
   **Start RAP.cmd**. Keep the console open.
2. Enter the operator-supplied HTTPS relay origin, a computer name, and a
   single-use bootstrap registration token (hidden input).
3. Open LightBurn, enable its REST API in Settings > Extensions, and keep
   **Allow API Access From Network disabled**. Type `PAIR` in RAP to consent
   to requesting the `state`, `project`, and `upload` capabilities. Bring
   LightBurn to the foreground and approve its dialog within 30 seconds.
4. Type `pair`. Open the displayed private URL on your phone, or type `open`
   to open it on this computer. Compare the browser's verification phrase
   with RAP's phrase. Type `approve ID` only for a matching request; otherwise
   `reject ID`. Browser pairing is never automatically approved.
5. Browser **Send** is authorization to import that SVG. Inspect the project
   and placement before independently deciding to operate the laser.

Do not record the console, enable PowerShell transcripts, or share pairing URL
screenshots: the URL intentionally displays a short-lived invitation. Durable
credentials, raw response errors, SVGs and coordinates are not printed.
QR generation is deliberately omitted in this prototype; no external QR
service receives invitation material.

The launcher does **not** use an execution-policy bypass. If Windows policy
blocks the script, use an organization-approved signed distribution and consult
your administrator. For downloaded files, verify the release source/signature
and follow your organization's file-unblocking procedure. RAP does not set
execution policy, unblock files, install certificates, or modify global policy.

## Console commands and revocation

Commands run between serialized observations; imports can occupy the console
for up to approximately 40 seconds while confirmation is awaited.

| Command | Effect |
| --- | --- |
| `help` | Show commands. |
| `pair` / `open` | Create a five-minute single-use invitation / open the last displayed URL. |
| `approve ID` / `reject ID` | Decide a currently pending, phrase-verified pairing. |
| `browsers` | List paired browser IDs. |
| `revoke ID` | Revoke a browser through the authenticated relay contract. |
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
instances. These protections do not defend against software running as your
Windows user or an administrator.

RAP targets a **500 ms cycle**, without overlapping status/project/position
reads. It validates status and documented workspace/device context each cycle.
Latency, cloud requests and import confirmation can make the actual interval
longer. API success is an observation, not proof of a newly measured controller
position. Missing workpiece X/Y never fall back to machine coordinates or zero.
Missing workpiece dimensions remain `null`; missing machine size, workpiece
offset or machine-view context fails closed.

Timed `/agent/start` and `/agent/update` responses supply `serverTime`. RAP
calibrates a monotonic server-clock estimate with **full roundtrip duration**
as its uncertainty, never the desktop wall clock. Each connected update includes
`observedAtServer` (back-projected to the earliest instant of the local read)
and `clockUncertaintyMs`, as well as elapsed read age. The backend computes
`max(reported age, serverNow - observedAtServer + clockUncertaintyMs)` at receipt,
so a buffered/delayed observation cannot look newly observed. Updates have a
whole-request 1000 ms abort deadline. Missing calibration or a local sample
exceeding 2 seconds publishes disconnected with no position/context. Browsers
still account for receipt age and their own server-clock calibration.
Reads and cloud reconnect use bounded backoff (0.5–30 s).
A new agent generation fences old sessions; fresh observations are required.

API authorization failure, no machine connection, network refusal/timeouts,
and invalid context/coordinates are distinct fixed local error categories.
No automatic LightBurn pairing is performed on authorization failure. Check
the Windows clock, API capability grants, and which LightBurn copy has focus.
Use `forget-lightburn` and restart only when you intend to pair again.

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
generation and increasing sequence implement the v1 contract. No extra relay
endpoints are required. The local SVG allowlist is intentionally narrow and
matches the current app exporter; unsupported future SVG variants are rejected,
not silently imported.

## Deterministic Windows checks

From the project root, run:

```powershell
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -File ".\rap\Test-RAP.ps1"
```

The standalone script returns a nonzero exit code on failure and requires
actual PS5.1. It parses all RAP scripts, compiles the in-memory .NET helpers,
tests DPAPI/atomic state/ACLs, exact HMAC/SVG/freshness/context validation
(including delayed-publication and missing-calibration cases),
strict SSE recognition and raw HTTP transport against ephemeral loopback
**test fixtures**, and mocked approval/revocation/import ordering, fencing,
missing confirmation, duplicate delivery and
restart reconciliation. It never contacts LightBurn/cloud, requests hardware
pairing, uploads to hardware, or changes the user's real RAP state. Its isolated
test state and compilation scratch files stay within `rap` and are removed.
No test framework or runtime installation is needed.

API shapes were verified against official
[LightBurn-REST documentation](https://github.com/LightBurnSoftware/LightBurn-REST/tree/43d3a4ec5aeb14219f0acaefc8fe01ede57f63ac/docs)
(`authentication.md`, `api-reference.md`, `uploading.md`, `openapi.yaml`).
No real hardware pairing/upload or deployment has been performed.
