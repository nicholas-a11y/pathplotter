# PathPlotter relay Worker

A Cloudflare Worker with SQLite-backed Durable Objects that connects PathPlotter browsers to RAP. Each registered RAP has its own `RelayDO`. A single `ControlPlaneDO` handles registration, invitations, capacity and preview limits. The relay does not serve the web app or RAP.

## Deploy

The hosted Worker is `pathplotter-relay-v3` at `https://pathplotter-relay-v3.nicholas-leqeta.workers.dev`. The web app ([src/onboarding.ts](../src/onboarding.ts)) and RAP ([rap/GUI.ps1](../rap/GUI.ps1)) default to this address.

```powershell
cd relay
npm ci
npm run check
npm test
npx wrangler deploy --config .\wrangler.jsonc --keep-vars
npx wrangler secret put OPERATOR_ADMIN_TOKEN   # once; at least 32 random characters
```

`OPERATOR_ADMIN_TOKEN` authorizes creating invitations. Keep it private and never hand it out. Enter it only at the secret prompt, not as a command argument.

Configuration in [wrangler.jsonc](./wrangler.jsonc):

| Variable | Meaning |
| --- | --- |
| `MIN_RAP_VERSION` | Oldest RAP allowed to connect. Older RAPs get HTTP 426 and ask the user to click **Update now**. Raise it only after the matching RAP release is published. |

Registrations are stored in this Worker's Durable Objects. Deploying under a new Worker name starts with no registrations, so every RAP must register again with a new Invitation ID.

## Invitations

New computers register only with an operator-issued **Invitation ID**. Use [rap/Operator-Invitations.ps1](../rap/README.md#operator-batch-invitations) to generate, list and cancel them.

- Up to 20 invitations per batch, each single-use and valid for seven days. At most 100 unused invitations can be outstanding.
- Only hashes are stored, so an invitation's secret cannot be recovered after creation.
- The service is capped at 50 registered computers.
- Registration and operator requests are each limited to five per IP per minute. Operator routes reject any browser `Origin`.

## API summary

All bodies are JSON. Allowed browser origins are `https://nicholas-a11y.github.io` and local Vite development origins.

**Registration and operator**

- `POST /v1/register {invitation, name}` returns `{relayId, credential}`.
- `POST /v1/operator/invitations {count, label}`, `GET /v1/operator/invitations` and `POST /v1/operator/invitations/:id/cancel`, all with `Authorization: Bearer <OPERATOR_ADMIN_TOKEN>`.

**RAP** (`/v1/relays/:relayId/agent/...`, bearer RAP credential)

- `start {version}` begins a new generation. It returns 426 if `version` is below `MIN_RAP_VERSION`.
- `stream` is the RAP WebSocket for observations, captures and jobs.
- `browser-launch` creates a two-minute, single-use link for **Open PathPlotter**.
- `pairing/new` and `pairing/decide` create and approve phone QR pairings.
- `browsers` and `browsers/revoke` list and revoke the paired browser.
- `jobs/:id/status` reports import progress.

**Browser** (`/v1/relays/:relayId/...`)

- `pairing/request` and `pairing/status` handle QR pairing. `browser/launch` redeems a RAP launch link.
- `ticket` and then `stream` open the browser WebSocket.
- `control` and `control/release` claim and release capture control. `capture` requests a fresh observation (at most 2 s old).
- `jobs`, `jobs/:id` and `jobs/:id/resolve` handle SVG imports, limited to 512 KiB each and 1,000 per RAP per 24 hours.

Only one browser identity is authorized per RAP. Approving a new browser replaces the previous one. Moving previews are limited to two updates per second, and to two previewing RAPs service-wide. Temporary snapshots, jobs and pairing requests are deleted by Durable Object alarms within 24 hours.

## Development

```powershell
npm ci
npm run check   # wrangler types + tsc
npm test        # Vitest in the Workers runtime
npm run dev
```

Never commit secrets or a `.dev.vars` file containing real values.
