# PathPlotter relay Worker

This package implements the HTTPS relay API and its per-relay SQLite Durable Object. It does not serve or modify the frontend or RAP.

## Local development and checks

```powershell
npm install
npm run check
npm test
npm run dev
```

`npm run check` regenerates the binding/runtime declarations with Wrangler and type-checks the Worker and runtime tests. `npm test` runs the HTTP contract against Cloudflare's Workers runtime with SQLite-backed Durable Objects. Root CI can run these without changing the root application scripts using `npm --prefix relay run check` and `npm --prefix relay test`.

The Worker has no public registration mode. `/v1/register` is disabled unless `BOOTSTRAP_TOKEN` is configured as a Worker secret. That operator-issued token is consumed on successful registration and its SHA-256 verifier is kept in the global control-plane DO; each client IP is limited to five registration attempts per minute. To enroll another relay, an operator must issue a new one-time token and rotate the secret. Do not put a real token in `wrangler.jsonc`, source, CI logs, or a committed `.dev.vars` file.

## API behavior

- RAP agent routes include `POST /pairing/new`, `POST /pairing/decide`, `GET /browsers`, `POST /browsers/revoke` and `POST /jobs/:jobId/status`, relative to `/v1/relays/:relayId`. The earlier `/agent/pairing/...` and `/agent/jobs/...` forms remain aliases; both require the agent credential.

- Browser origins are restricted to `https://nicholas-a11y.github.io`, `http://localhost:5173`, and `http://127.0.0.1:5173`; CORS is not used as authentication.
- Each relay ID maps to an independent SQLite DO. Agent and browser bearer credentials are random 256-bit values; only hashes are stored. Pairing approval is per relay, and the browser credential is AES-GCM wrapped using the pending token and returned only to a request authenticated by that token.
- Agent start returns `{generation,serverTime}`; each update includes `observedAtServer` and `clockUncertaintyMs`, with the latter conservatively set to the full request round trip. Connected samples without a valid calibration are rejected and clear live position/context. Snapshot positions are overwritten, never historized. At receipt, server-reported age is `max(observationAgeMs, serverNow - observedAtServer + clockUncertaintyMs)`. Delayed samples remain visible with their age but cannot create or claim import jobs once older than two seconds.
- Browser control is an explicit 15-second lease renewed by snapshot reads and stream snapshots. Jobs are validated constrained SVG documents, at most 512 KiB each. Each relay admits at most 1,000 jobs per rolling 24 hours, while retaining a separate limit of ten jobs with pending SVG payloads. A job is atomically claimed once, and only one claimed/attempting/accepted import may be active at a time; generation changes make those active jobs `unknown`, never queued for retry. Terminal SVG bodies are deleted; job metadata is retained for 24 hours. Retrying the same job ID and checksum reconciles the existing result without consuming another admission.
- Desktop launch: RAP calls agent-authenticated `POST /agent/browser-launch` with `{}` and receives `{launchToken,expiresAt}`. RAP places only this token in the URL fragment it opens; it is never printed, copied or QR-encoded. The browser (allowed origin, no bearer) calls `POST /browser/launch` with `{launchToken,credential?}` and receives `{credential}`. A supplied credential that is a valid, unrevoked browser credential of this relay is returned unchanged; otherwise a new scoped browser credential is minted. Tokens are 256-bit, stored only as hashes in a table separate from phone invitations, expire after two minutes and are consumed atomically once (`404 launch_token_not_found`, `409 launch_token_used`, `410 launch_token_expired`). Issuance is bounded separately from phone invitations: at most 5 unused tokens (`429 too_many_launch_tokens`) and 20 issued per rolling 10 minutes (`429 launch_rate_limited`); at most 20 unrevoked launch-minted browsers exist (`429 too_many_launch_browsers`; revoke one via `/browsers/revoke`). A launch token is a short-lived bearer grant, not proof of physical locality. Phone pairing (`/pairing/request` + `/pairing/decide`) is unchanged and still requires explicit approval.
- `POST /control` with `{}` claims only a free lease (`409 browser_lease_occupied` otherwise). `{"takeover":true}` explicitly switches an occupied lease. Moving control to a browser that does not already hold the live lease is refused with `409 unresolved_imports` while another browser has a queued/claimed/attempting/accepted job or an unacknowledged `unknown` job; lease expiry does not bypass this. Unknown jobs of revoked browsers do not block. The check and lease switch share one transaction with job admission, and the previous controller sees `activeBrowser:false` on its next snapshot/stream message and cannot admit jobs.
- `POST /jobs/:jobId/resolve` with `{}` (owning browser only) acknowledges an `unknown` job so it no longer blocks control moves; other statuses return `409 job_not_unknown`. Resolved unknown jobs report `resolved:true` in job results.
- `GET /v1/relays/:relayId/snapshot` returns `{serverTime,snapshot,activeBrowser,controlOccupied,job}`; `controlOccupied` is true when another browser holds the live lease. No credentials or browser IDs are included. Optional `POST /v1/relays/:relayId/ticket` issues a single-use WebSocket ticket with a 30-second TTL. `GET /v1/relays/:relayId/stream?ticket=...` consumes it and uses the Durable Object hibernation API. Stream messages have the same envelope as `/snapshot`: `{serverTime,snapshot,activeBrowser,controlOccupied,job}`. The URL contains only the short-lived ticket, never a durable credential. HTTP polling remains the supported fallback.

No remote deployment has been performed.
