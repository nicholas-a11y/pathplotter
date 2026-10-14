import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const ORIGIN = "https://nicholas-a11y.github.io";
const encoder = new TextEncoder();

function randomTokenForTest(): string {
  return btoa(crypto.randomUUID() + crypto.randomUUID()).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "").slice(0, 43);
}

type TestBindings = Env & { OPERATOR_ADMIN_TOKEN?: string };
const ADMIN = "test-operator-admin-private-not-production-123";
type Relay = { relayId: string; credential: string; bindings: TestBindings };
type Agent = Relay & { generation: number; serverTime: number };
type Browser = { pairingId: string; pendingToken: string; phrase: string; credential: string };
const testSockets = new Map<string, { socket: WebSocket; last: number }>();
const testRelays: string[] = [];

describe("operator batch invitations", () => {
  const admin = ADMIN;
  type Invitation = { id: string; token: string; status: string; expiresAt: number };
  function runtime(): TestBindings {
    const cp = env.CONTROL_PLANE.getByName(`operator-tests-${crypto.randomUUID()}`);
    return Object.assign(bindings(), { CONTROL_PLANE: { getByName: () => cp } });
  }
  async function batch(env: TestBindings, count = 3) {
    const response = await call("/v1/operator/invitations", {
      credential: admin, origin: null, bindings: env, body: { count, label: "Test group" },
    });
    expect(response.status).toBe(201);
    return json<{ batchId: string; invitations: Invitation[] }>(response);
  }
  async function redeem(env: TestBindings, token: string, ip?: string) {
    return call("/v1/register", { bindings: env, ip, body: { invitation: token, name: "Invited PC" } });
  }

  it("requires separate admin authorization, denies browser use and bounds batches", async () => {
    const env = runtime();
    for (const credential of [undefined, "wrong-admin", "a".repeat(43)]) {
      const response = await call("/v1/operator/invitations", { credential, origin: null, bindings: env });
      expect(response.status).toBe(401); await response.text();
    }
    expect((await call("/v1/operator/invitations", { credential: admin, bindings: env })).status).toBe(403);
    for (const count of [0, 21, 1.5, "3"]) {
      expect((await call("/v1/operator/invitations", { credential: admin, origin: null, bindings: env, body: { count, label: "" } })).status).toBe(400);
    }
    const disabled = await call("/v1/operator/invitations", { credential: admin, origin: null, bindings: Object.assign(bindings(), { OPERATOR_ADMIN_TOKEN: "" }) });
    expect(disabled.status).toBe(503);
    expect((await redeem(env, admin)).status).toBe(401);
    const missing = await call(`/v1/operator/invitations/${crypto.randomUUID()}/cancel`, { origin: null, credential: admin, bindings: env, body: {} });
    expect(missing.status).toBe(404); await missing.text();
  });

  it("generates unique 256-bit invitations with seven-day expiry and stores only hashes", async () => {
    const env = runtime(), result = await batch(env);
    expect(result.invitations).toHaveLength(3);
    expect(new Set(result.invitations.map((i) => i.token)).size).toBe(3);
    for (const invitation of result.invitations) {
      expect(invitation.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(invitation.expiresAt - Date.now()).toBeGreaterThan(7 * 86400000 - 5000);
      expect(invitation.expiresAt - Date.now()).toBeLessThanOrEqual(7 * 86400000);
    }
    const stub = env.CONTROL_PLANE.getByName("registration-control");
    await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql.exec("SELECT * FROM operator_invitations WHERE batch_id=?", result.batchId).toArray();
      expect(rows).toHaveLength(3);
      for (const invitation of result.invitations) expect(JSON.stringify(rows)).not.toContain(invitation.token);
    });
    await evictDurableObject(stub);
    const listed = await json<{ invitations: Invitation[] }>(await call("/v1/operator/invitations", { origin: null, credential: admin, bindings: env }));
    expect(listed.invitations.map((i) => i.id)).toEqual(expect.arrayContaining(result.invitations.map((i) => i.id)));
    expect(JSON.stringify(listed)).not.toContain(result.invitations[0].token);
  });

  it("atomically allows one registration and refuses cancellation of used invitations", async () => {
    const env = runtime(), invitation = (await batch(env, 1)).invitations[0];
    const responses = await Promise.all([redeem(env, invitation.token), redeem(env, invitation.token)]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    const credentials: string[] = [];
    for (const response of responses) {
      const body = await json<{ relayId?: string; credential?: string }>(response);
      if (body.relayId && body.credential) { testRelays.push(body.relayId); credentials.push(body.credential); }
    }
    expect(credentials[0]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const cancelled = await call(`/v1/operator/invitations/${invitation.id}/cancel`, { origin: null, credential: admin, bindings: env, body: {} });
    expect(cancelled.status).toBe(409); await cancelled.text();
    const listed = await json<{ invitations: Invitation[] }>(await call("/v1/operator/invitations", { origin: null, credential: admin, bindings: env }));
    expect(listed.invitations.find((i) => i.id === invitation.id)?.status).toBe("used");
  });

  it("cancels unused invitations idempotently and rejects expiry without requiring alarms", async () => {
    const env = runtime(), result = await batch(env, 2);
    const [cancelled, expired] = result.invitations;
    for (let i = 0; i < 2; i++) {
      const response = await call(`/v1/operator/invitations/${cancelled.id}/cancel`, { origin: null, credential: admin, bindings: env, body: {} });
      expect(response.status).toBe(200); await response.text();
    }
    expect((await redeem(env, cancelled.token)).status).toBe(401);
    await runInDurableObject(env.CONTROL_PLANE.getByName("registration-control"), (_instance, state) => {
      state.storage.sql.exec("UPDATE operator_invitations SET expires_at=? WHERE id=?", Date.now() - 1, expired.id);
    });
    expect((await redeem(env, expired.token)).status).toBe(401);
    const listed = await json<{ invitations: Invitation[] }>(await call("/v1/operator/invitations", { origin: null, credential: admin, bindings: env }));
    expect(listed.invitations.find((i) => i.id === cancelled.id)?.status).toBe("cancelled");
    expect(listed.invitations.find((i) => i.id === expired.id)?.status).toBe("expired");
  });

  it("limits admin guessing and registration guessing independently", async () => {
    const env = runtime(), ip = crypto.randomUUID();
    const invitation = (await batch(env, 1)).invitations[0];
    for (let i = 0; i < 5; i++) {
      expect((await call("/v1/operator/invitations", { origin: null, credential: "wrong", bindings: env, ip })).status).toBe(401);
    }
    expect((await call("/v1/operator/invitations", { origin: null, credential: admin, bindings: env, ip })).status).toBe(429);
    for (let i = 0; i < 5; i++) expect((await redeem(env, "not-an-invitation-but-long-enough", ip)).status).toBe(401);
    expect((await redeem(env, invitation.token, ip)).status).toBe(429);
  });

  it("bounds outstanding invitations and preserves service registration capacity", async () => {
    const env = runtime();
    for (let i = 0; i < 5; i++) await batch(env, 20);
    expect((await call("/v1/operator/invitations", { credential: admin, origin: null, bindings: env, body: { count: 1, label: "" } })).status).toBe(429);
    const stub = env.CONTROL_PLANE.getByName("registration-control");
    const listed = await json<{ invitations: Invitation[] }>(await call("/v1/operator/invitations", { credential: admin, origin: null, bindings: env }));
    await runInDurableObject(stub, (_instance, state) => {
      for (let i = 0; i < 50; i++) state.storage.sql.exec("INSERT INTO registered_relays VALUES (?)", crypto.randomUUID());
    });
    // Token metadata is hash-only; this failed registration must not consume it.
    const hashRow = await runInDurableObject(stub, (_instance, state) => {
      return state.storage.sql.exec<{ token_hash: string }>("SELECT token_hash FROM operator_invitations WHERE id=?", listed.invitations[0].id).one();
    });
    expect(await stub.consumeRegistrationAttempt(crypto.randomUUID(), hashRow.token_hash, crypto.randomUUID(), Date.now())).toBe("capacity");
  });

  it("cleans old metadata but keeps permanent consumption", async () => {
    const env = runtime(), invitation = (await batch(env, 1)).invitations[0];
    const registered = await json<{ relayId: string }>(await redeem(env, invitation.token));
    testRelays.push(registered.relayId);
    const stub = env.CONTROL_PLANE.getByName("registration-control");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE operator_invitations SET expires_at=? WHERE id=?", Date.now() - 31 * 86400000, invitation.id);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT id FROM operator_invitations WHERE id=?", invitation.id).toArray()).toHaveLength(0);
      expect(state.storage.sql.exec("SELECT relay_id FROM consumed_invitations WHERE relay_id=?", registered.relayId).toArray()).toHaveLength(1);
    });
  });
});

describe("single saved browser policy", () => {
  async function agent() {
    return startAgent(await register());
  }
  async function ids(value: Agent) {
    const response = await call(`/v1/relays/${value.relayId}/agent/browsers`, { bindings: value.bindings, credential: value.credential });
    return (await json<{ browsers: { id: string }[] }>(response)).browsers.map((row) => row.id);
  }
  async function launch(value: Agent, replacing?: string[]) {
    const response = await call(`/v1/relays/${value.relayId}/agent/browser-launch`, {
      bindings: value.bindings, credential: value.credential,
      body: replacing === undefined ? {} : { replaceBrowserIds: replacing },
    });
    expect(response.status).toBe(200);
    return (await json<{ launchToken: string }>(response)).launchToken;
  }
  async function redeem(value: Agent, token: string, credential?: string) {
    return call(`/v1/relays/${value.relayId}/browser/launch`, {
      bindings: value.bindings, body: credential === undefined ? { launchToken: token } : { launchToken: token, credential },
    });
  }
  async function pending(value: Agent) {
    const invite = await json<{ invitation: string }>(await call(`/v1/relays/${value.relayId}/agent/pairing/new`, { credential: value.credential, bindings: value.bindings, body: {} }));
    return json<Browser>(await call(`/v1/relays/${value.relayId}/pairing/request`, { bindings: value.bindings, body: { invitation: invite.invitation } }));
  }
  async function decide(value: Agent, id: string, replacing?: string[]) {
    return call(`/v1/relays/${value.relayId}/agent/pairing/decide`, {
      credential: value.credential, bindings: value.bindings,
      body: { pairingId: id, approve: true, ...(replacing === undefined ? {} : { replaceBrowserIds: replacing }) },
    });
  }

  it("reuses a saved browser but refuses new grants without explicit replacement", async () => {
    const value = await agent();
    const first = await json<{ credential: string }>(await redeem(value, await launch(value)));
    const original = await ids(value);
    expect(await json(await redeem(value, await launch(value), first.credential))).toEqual(first);
    const denied = await redeem(value, await launch(value));
    expect(denied.status).toBe(409); await denied.text();
    const qr = await pending(value);
    const approval = await decide(value, qr.pairingId);
    expect(approval.status).toBe(409); await approval.text();
    expect(await ids(value)).toEqual(original);
  });

  it("switches to a phone only with exact confirmation and revokes old credentials and sockets", async () => {
    const value = await agent();
    const old = await json<{ credential: string }>(await redeem(value, await launch(value)));
    const oldIds = await ids(value);
    const ticket = await json<{ ticket: string }>(await call(`/v1/relays/${value.relayId}/ticket`, { bindings: value.bindings, credential: old.credential, body: {} }));
    const response = await call(`/v1/relays/${value.relayId}/stream?ticket=${ticket.ticket}`, { bindings: value.bindings, upgrade: true });
    const socket = response.webSocket!;
    socket.accept();
    const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve()));
    const stale = await launch(value, oldIds);
    const qr = await pending(value);
    const approved = await decide(value, qr.pairingId, oldIds);
    expect(approved.status).toBe(200); await approved.text();
    await closed;
    expect((await call(`/v1/relays/${value.relayId}/ticket`, { bindings: value.bindings, credential: old.credential, body: {} })).status).toBe(401);
    expect((await redeem(value, stale)).status).toBe(409);
    const current = await ids(value);
    expect(current).toHaveLength(1); expect(current).not.toEqual(oldIds);
    const replay = await decide(value, qr.pairingId, oldIds);
    expect(replay.status).toBe(200); await replay.text();
    expect(await ids(value)).toEqual(current);
  });

  it("fences concurrent desktop replacements and refuses outdated consent", async () => {
    const value = await agent();
    await (await redeem(value, await launch(value))).text();
    const oldIds = await ids(value);
    const a = await launch(value, oldIds), b = await launch(value, oldIds);
    expect(await ids(value)).toEqual(oldIds);
    const results = await Promise.all([redeem(value, a), redeem(value, b)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    for (const result of results) await result.text();
    expect(await ids(value)).toHaveLength(1);
    const qr = await pending(value);
    const outdated = await decide(value, qr.pairingId, oldIds);
    expect(outdated.status).toBe(409); await outdated.text();
    expect(await ids(value)).toHaveLength(1);
  });

  it("grants only one identity when first desktop and phone approvals race", async () => {
    const value = await agent();
    const token = await launch(value), qr = await pending(value);
    const results = await Promise.all([redeem(value, token), decide(value, qr.pairingId)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    for (const result of results) await result.text();
    expect(await ids(value)).toHaveLength(1);
  });

  it("blocks replacement for pending and unacknowledged imports, including after restart", async () => {
    const value = await agent();
    await (await redeem(value, await launch(value))).text();
    const oldIds = await ids(value), qr = await pending(value);
    const token = await launch(value, oldIds);
    const stub = env.RELAYS.getByName(value.relayId), jobId = crypto.randomUUID();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO jobs
        (id,checksum,filename,anchor,context_revision,expires_at,status,browser_id,created_at,updated_at)
        VALUES (?,'test','test.svg','{}','workspace',?,'queued',?,?,?)`, jobId, Date.now() + 60000, oldIds[0], Date.now(), Date.now());
    });
    const queued = await decide(value, qr.pairingId, oldIds);
    expect(queued.status).toBe(409); await queued.text();
    const desktop = await redeem(value, token);
    expect(desktop.status).toBe(409); await desktop.text();
    await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("UPDATE jobs SET status='unknown' WHERE id=?", jobId));
    await evictDurableObject(stub, { webSockets: "close" });
    const blocked = await decide(value, qr.pairingId, oldIds);
    expect(blocked.status).toBe(409); await blocked.text();
    expect(await ids(value)).toEqual(oldIds);
    await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("INSERT INTO job_resolutions VALUES (?,?)", jobId, Date.now()));
    const approved = await decide(value, qr.pairingId, oldIds);
    expect(approved.status).toBe(200); await approved.text();
    expect(await ids(value)).toHaveLength(1);
  });
});

describe("retired routes", () => {
  it("returns 404 for removed enrollment, HTTP fallback, snapshot and unprefixed agent routes", async () => {
    const agent = await startAgent(await register());
    const root = `/v1/relays/${agent.relayId}`;
    for (const path of ["/v1/enrollment/config", "/v1/pairing/config", `${root}/agent/update`, `${root}/agent/capture/${crypto.randomUUID()}`]) {
      const response = await call(path, { credential: agent.credential, bindings: agent.bindings, ...(path.endsWith("/config") ? {} : { body: {} }) });
      expect(response.status).toBe(404); await response.text();
    }
    for (const path of [`${root}/snapshot`, `${root}/browsers`, `${root}/capture/${crypto.randomUUID()}`]) {
      const response = await call(path, { credential: agent.credential, bindings: agent.bindings });
      expect(response.status).toBeGreaterThanOrEqual(400); await response.text();
    }
    const unprefixed = await call(`${root}/pairing/new`, { credential: agent.credential, bindings: agent.bindings, body: {} });
    expect(unprefixed.status).toBeGreaterThanOrEqual(400); await unprefixed.text();
  });
});

describe("RAP version gate", () => {
  it("refuses an outdated RAP, tells browsers to update it, and clears the flag after an update", async () => {
    const relay = await register();
    const current = await startAgent(relay);
    const browser = await launchBrowser(relay);
    expect((await snapshotOf(relay, browser)).rapUpdateRequired).toBe(false);
    for (const version of ["2.9.9", "3.0", "", undefined]) {
      const response = await call(`/v1/relays/${relay.relayId}/agent/start`, {
        credential: relay.credential, bindings: relay.bindings, body: version === undefined ? {} : { version },
      });
      expect(response.status).toBe(426);
      expect(await json(response)).toEqual({ error: "rap_update_required", minimumVersion: "3.0.0" });
    }
    expect((await snapshotOf(relay, browser)).rapUpdateRequired).toBe(true);
    const updated = await startAgent(relay, "3.0.1");
    expect(updated.generation).toBe(current.generation + 1);
    expect((await snapshotOf(relay, browser)).rapUpdateRequired).toBe(false);
  });
});

afterEach(async () => {
  for (const { socket } of testSockets.values()) socket.close();
  testSockets.clear();
  for (const id of testRelays.splice(0)) await env.CONTROL_PLANE.getByName("registration-control").preview(id, false);
});

function bindings(): TestBindings {
  return Object.assign({}, env, { OPERATOR_ADMIN_TOKEN: ADMIN }) as TestBindings;
}

async function call(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    credential?: string;
    origin?: string | null;
    bindings?: TestBindings;
    ip?: string;
    upgrade?: boolean;
  } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.credential) headers.set("Authorization", `Bearer ${options.credential}`);
  if (options.origin !== null) headers.set("Origin", options.origin ?? ORIGIN);
  if (options.upgrade) headers.set("Upgrade", "websocket");
  headers.set("CF-Connecting-IP", options.ip ?? crypto.randomUUID());
  const response = await worker.fetch(
    new Request(`https://relay.test${path}`, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    options.bindings ?? bindings(),
  );
  return response;
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

async function invitation(runtime: TestBindings): Promise<string> {
  const response = await call("/v1/operator/invitations", { credential: ADMIN, origin: null, bindings: runtime, body: { count: 1, label: "" } });
  expect(response.status).toBe(201);
  return (await json<{ invitations: Array<{ token: string }> }>(response)).invitations[0].token;
}

async function register(): Promise<Relay> {
  const runtime = bindings();
  const response = await call("/v1/register", {
    body: { invitation: await invitation(runtime), name: "test relay" },
    bindings: runtime,
  });
  expect(response.status).toBe(201);
  const value = await json<{ relayId: string; credential: string }>(response);
  testRelays.push(value.relayId);
  return { ...value, bindings: runtime };
}

async function startAgent(relay: Relay, version = "3.0.0"): Promise<Agent> {
  const response = await call(`/v1/relays/${relay.relayId}/agent/start`, {
    body: { version },
    credential: relay.credential,
    bindings: relay.bindings,
  });
  expect(response.status).toBe(200);
  const value = await json<{ generation: number; serverTime: number }>(response);
  return { ...relay, ...value };
}

async function update(
  agent: Agent,
  sequence: number,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  const key = `${agent.relayId}:${agent.generation}`;
  let connection = testSockets.get(key);
  if (connection && Date.now() - connection.last >= 45_000) { connection.socket.close(); connection = undefined; }
  if (!connection) {
    const response = await call(`/v1/relays/${agent.relayId}/agent/stream?generation=${agent.generation}`, {
      credential: agent.credential, bindings: agent.bindings, upgrade: true, origin: null,
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    connection = { socket, last: 0 }; testSockets.set(key, connection);
  }
  if (connection.last) {
    if (vi.isFakeTimers()) vi.setSystemTime(Math.max(Date.now(), connection.last + 501));
    else await new Promise((resolve) => setTimeout(resolve, 510));
  }
  connection.last = Date.now();
  const id = crypto.randomUUID();
  const socket = connection.socket;
  return new Promise<Response>((resolve) => {
    const receive = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as { id?: string; type?: string; body?: unknown; error?: string };
      if (message.id !== id) return;
      socket.removeEventListener("message", receive);
      const statuses: Record<string, number> = { stale_generation: 409, stale_sequence: 409, invalid_sequence: 400, invalid_clock_calibration: 400, message_rate_limited: 429 };
      resolve(Response.json(message.type === "error" ? { error: message.error } : message.body, { status: message.type === "error" ? statuses[message.error!] ?? 400 : 200 }));
    };
    socket.addEventListener("message", receive);
    socket.send(JSON.stringify({ v: 2, type: "update", id, body: {
      generation: agent.generation,
      sequence,
      connected: true,
      position: { x: 12, y: 34 },
      context: { revision: "workspace-v1", size: { x: 600, y: 400 } },
      observationAgeMs: 0,
      observedAtServer: Date.now(),
      clockUncertaintyMs: 20,
      ...overrides,
    } }));
  });
}

async function pairBrowser(agent: Agent, sequence = 1): Promise<Browser> {
  const inviteResponse = await call(`/v1/relays/${agent.relayId}/agent/pairing/new`, {
    credential: agent.credential,
    bindings: agent.bindings,
    body: {},
  });
  expect(inviteResponse.status).toBe(200);
  const invite = await json<{ invitation: string }>(inviteResponse);
  const pairingResponse = await call(`/v1/relays/${agent.relayId}/pairing/request`, {
    body: { invitation: invite.invitation },
    bindings: agent.bindings,
  });
  expect(pairingResponse.status).toBe(200);
  const pending = await json<{ pairingId: string; pendingToken: string; phrase: string }>(pairingResponse);
  const updateResponse = await update(agent, sequence);
  expect(updateResponse.status).toBe(200);
  const updateBody = await json<{ pairings: Array<{ id: string; phrase: string }> }>(updateResponse);
  expect(updateBody.pairings).toContainEqual({ id: pending.pairingId, phrase: pending.phrase });
  const decide = await call(`/v1/relays/${agent.relayId}/agent/pairing/decide`, {
    credential: agent.credential,
    bindings: agent.bindings,
    body: { pairingId: pending.pairingId, approve: true },
  });
  expect(decide.status).toBe(200);
  await decide.text();
  const status = await call(`/v1/relays/${agent.relayId}/pairing/status`, {
    body: { pairingId: pending.pairingId, pendingToken: pending.pendingToken },
    bindings: agent.bindings,
  });
  expect(status.status).toBe(200);
  const approved = await json<{ status: string; credential: string }>(status);
  expect(approved.status).toBe("approved");
  return { ...pending, credential: approved.credential };
}

const SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="2mm" height="2mm" viewBox="0 0 2 2">
<circle cx="1" cy="1" r="1" fill="none" stroke="#000000" stroke-width="0.1" />
</svg>`;

async function checksum(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function jobPayload(id = crypto.randomUUID()): Record<string, unknown> {
  return {
    id,
    svg: SVG,
    checksum: "",
    filename: "test-job.svg",
    anchor: { x: 12, y: 34 },
    contextRevision: "workspace-v1",
  };
}

describe("PathPlotter relay HTTP contract", () => {
  afterEach(() => vi.useRealTimers());

  it("isolates relay credentials and rejects unapproved CORS origins", async () => {
    const first = await register();
    const second = await register();
    const firstAgent = await startAgent(first);
    const wrongRelay = await call(`/v1/relays/${second.relayId}/agent/start`, {
      body: { version: "3.0.0" },
      credential: firstAgent.credential,
      bindings: second.bindings,
    });
    expect(wrongRelay.status).toBe(401);

    const denied = await call(`/v1/relays/${first.relayId}/ticket`, {
      body: {},
      credential: firstAgent.credential,
      origin: "https://attacker.example",
      bindings: first.bindings,
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("binds approved browser credential delivery to the pending token", async () => {
    const relay = await register();
    const agent = await startAgent(relay);
    const inviteResponse = await call(`/v1/relays/${relay.relayId}/agent/pairing/new`, {
      credential: relay.credential,
      bindings: relay.bindings,
      body: {},
    });
    const invite = await json<{ invitation: string }>(inviteResponse);
    const pairResponse = await call(`/v1/relays/${relay.relayId}/pairing/request`, {
      body: { invitation: invite.invitation },
      bindings: relay.bindings,
    });
    const pair = await json<{ pairingId: string; pendingToken: string; phrase: string }>(pairResponse);
    const replay = await call(`/v1/relays/${relay.relayId}/pairing/request`, {
      body: { invitation: invite.invitation },
      bindings: relay.bindings,
    });
    expect(replay.status).toBe(409);

    const updateResponse = await update(agent, 1);
    const updateBody = await json<{ pairings: Array<{ id: string; phrase: string }> }>(updateResponse);
    expect(updateBody.pairings).toContainEqual({ id: pair.pairingId, phrase: pair.phrase });
    const stranger = await call(`/v1/relays/${relay.relayId}/pairing/status`, {
      body: { pairingId: pair.pairingId, pendingToken: randomTokenForTest() },
      bindings: relay.bindings,
    });
    expect(stranger.status).toBe(404);

    const decision = await call(`/v1/relays/${relay.relayId}/agent/pairing/decide`, {
      credential: relay.credential,
      bindings: relay.bindings,
      body: { pairingId: pair.pairingId, approve: true },
    });
    expect(decision.status).toBe(200);
    const delivered = await call(`/v1/relays/${relay.relayId}/pairing/status`, {
      body: { pairingId: pair.pairingId, pendingToken: pair.pendingToken },
      bindings: relay.bindings,
    });
    const grant = await json<{ status: string; credential: string }>(delivered);
    expect(grant.status).toBe("approved");
    expect(grant.credential).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("expires unused pairing invitations and pending jobs", async () => {
    const relay = await register();
    await startAgent(relay);
    const inviteResponse = await call(`/v1/relays/${relay.relayId}/agent/pairing/new`, {
      credential: relay.credential,
      bindings: relay.bindings,
      body: {},
    });
    const invite = await json<{ invitation: string }>(inviteResponse);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    const expiredPair = await call(`/v1/relays/${relay.relayId}/pairing/request`, {
      body: { invitation: invite.invitation },
      bindings: relay.bindings,
    });
    expect(expiredPair.status).toBe(410);

    vi.useRealTimers();
    const activeRelay = await register();
    const activeAgent = await startAgent(activeRelay);
    const browser = await pairBrowser(activeAgent);
    const lease = await call(`/v1/relays/${activeRelay.relayId}/control`, {
      credential: browser.credential,
      bindings: activeRelay.bindings,
      body: {},
    });
    expect(lease.status).toBe(200);
    await update(activeAgent, 2);
    const payload = jobPayload();
    payload.checksum = await checksum(SVG);
    const queued = await call(`/v1/relays/${activeRelay.relayId}/jobs`, {
      credential: browser.credential,
      bindings: activeRelay.bindings,
      body: payload,
    });
    expect(queued.status, await queued.clone().text()).toBe(200);
    expect((await json<{ status: string }>(queued)).status).toBe("queued");
    vi.setSystemTime(Date.now() + 60_001);
    const jobId = payload.id as string;
    const expiredJob = await call(`/v1/relays/${activeRelay.relayId}/jobs/${jobId}`, {
      credential: browser.credential,
      bindings: activeRelay.bindings,
    });
    expect((await json<{ status: string }>(expiredJob)).status).toBe("expired");
  });

  it("admits exactly 1,000 jobs per rolling 24 hours and reconciles duplicates at the limit", async () => {
    const relay = await register();
    const agent = await startAgent(relay);
    const browser = await pairBrowser(agent);
    expect((await call(`/v1/relays/${relay.relayId}/control`, {
      credential: browser.credential,
      bindings: relay.bindings,
      body: {},
    })).status).toBe(200);
    await update(agent, 2);

    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    for (let index = 0; index < 999; index += 1) {
      const payload = jobPayload();
      payload.checksum = await checksum(SVG);
      const queued = await call(`/v1/relays/${relay.relayId}/jobs`, {
        credential: browser.credential,
        bindings: relay.bindings,
        body: payload,
      });
      expect(queued.status, `admission ${index + 1}`).toBe(200);
      vi.setSystemTime(now + 60_001);
      const expired = await call(`/v1/relays/${relay.relayId}/jobs/${payload.id}`, {
        credential: browser.credential,
        bindings: relay.bindings,
      });
      expect((await json<{ status: string }>(expired)).status, `expiry ${index + 1}`).toBe("expired");
      vi.setSystemTime(now);
    }

    const thousandth = jobPayload();
    thousandth.checksum = await checksum(SVG);
    const lastAllowed = await call(`/v1/relays/${relay.relayId}/jobs`, {
      credential: browser.credential,
      bindings: relay.bindings,
      body: thousandth,
    });
    expect(lastAllowed.status).toBe(200);
    expect((await json<{ status: string }>(lastAllowed)).status).toBe("queued");

    const reconciliation = await call(`/v1/relays/${relay.relayId}/jobs`, {
      credential: browser.credential,
      bindings: relay.bindings,
      body: thousandth,
    });
    expect(reconciliation.status).toBe(200);
    expect((await json<{ id: string; status: string }>(reconciliation))).toEqual({
      id: thousandth.id,
      status: "queued",
    });

    const overLimit = jobPayload();
    overLimit.checksum = thousandth.checksum;
    const rejected = await call(`/v1/relays/${relay.relayId}/jobs`, {
      credential: browser.credential,
      bindings: relay.bindings,
      body: overLimit,
    });
    expect(rejected.status).toBe(429);
    expect(await json<{ error: string }>(rejected)).toEqual({ error: "job_limit_reached" });
  }, 120_000);

  it("limits pending SVG payloads independently and releases them after expiry", async () => {
    const relay = await register();
    const agent = await startAgent(relay);
    const browser = await pairBrowser(agent);
    await call(`/v1/relays/${relay.relayId}/control`, {
      credential: browser.credential,
      bindings: relay.bindings,
      body: {},
    });
    await update(agent, 2);

    const pending: Record<string, unknown>[] = [];
    for (let index = 0; index < 10; index += 1) {
      const payload = jobPayload();
      payload.checksum = await checksum(SVG);
      const response = await call(`/v1/relays/${relay.relayId}/jobs`, {
        credential: browser.credential,
        bindings: relay.bindings,
        body: payload,
      });
      expect(response.status, `pending payload ${index + 1}`).toBe(200);
      pending.push(payload);
    }

    const reconciliation = await call(`/v1/relays/${relay.relayId}/jobs`, {
      credential: browser.credential,
      bindings: relay.bindings,
      body: pending[0],
    });
    expect(reconciliation.status).toBe(200);

    const eleventh = jobPayload();
    eleventh.checksum = await checksum(SVG);
    const full = await call(`/v1/relays/${relay.relayId}/jobs`, {
      credential: browser.credential,
      bindings: relay.bindings,
      body: eleventh,
    });
    expect(full.status).toBe(429);
    expect(await json<{ error: string }>(full)).toEqual({ error: "pending_job_limit_reached" });

    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now + 60_001);
    const expired = await call(`/v1/relays/${relay.relayId}/jobs/${pending[0].id}`, {
      credential: browser.credential,
      bindings: relay.bindings,
    });
    expect((await json<{ status: string }>(expired)).status).toBe("expired");
    vi.setSystemTime(now);
    await update(agent, 3);
    await call(`/v1/relays/${relay.relayId}/control`, {
      credential: browser.credential,
      bindings: relay.bindings,
      body: {},
    });
    const admitted = await call(`/v1/relays/${relay.relayId}/jobs`, {
      credential: browser.credential,
      bindings: relay.bindings,
      body: eleventh,
    });
    expect(admitted.status).toBe(200);
  });

  it("deletes job results after their 24-hour retention window", async () => {
    const relay = await register();
    const agent = await startAgent(relay);
    const browser = await pairBrowser(agent);
    await call(`/v1/relays/${relay.relayId}/control`, {
      credential: browser.credential,
      bindings: relay.bindings,
      body: {},
    });
    await update(agent, 2);
    const payload = jobPayload();
    payload.checksum = await checksum(SVG);
    const queued = await call(`/v1/relays/${relay.relayId}/jobs`, {
      credential: browser.credential,
      bindings: relay.bindings,
      body: payload,
    });
    expect(queued.status).toBe(200);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    const removed = await call(`/v1/relays/${relay.relayId}/jobs/${payload.id}`, {
      credential: browser.credential,
      bindings: relay.bindings,
    });
    expect(removed.status).toBe(404);

    await update(agent, 3);
    await call(`/v1/relays/${relay.relayId}/control`, {
      credential: browser.credential,
      bindings: relay.bindings,
      body: {},
    });
    const afterRetention = jobPayload();
    afterRetention.checksum = await checksum(SVG);
    const admitted = await call(`/v1/relays/${relay.relayId}/jobs`, {
      credential: browser.credential,
      bindings: relay.bindings,
      body: afterRetention,
    });
    expect(admitted.status).toBe(200);
  });

  it("accounts for delayed publication, serializes imports, and fences old generations", async () => {
    const relay = await register();
    const agent = await startAgent(relay);
    const browser = await pairBrowser(agent);
    const competingBrowser = { credential: await extraBrowser(relay) };
    const firstLease = await call(`/v1/relays/${relay.relayId}/control`, {
      credential: browser.credential,
      bindings: relay.bindings,
      body: {},
    });
    expect(firstLease.status).toBe(200);
    const secondLease = await call(`/v1/relays/${relay.relayId}/control`, {
      credential: competingBrowser.credential,
      bindings: relay.bindings,
      body: {},
    });
    expect(secondLease.status).toBe(409);

    const delayed = await update(agent, 3, {
      observedAtServer: Date.now() - 10_000,
      clockUncertaintyMs: 20,
    });
    expect(delayed.status).toBe(200);
    const stale = await snapshotOf<{ snapshot: { connected: boolean; observationAgeMs: number } }>(relay, browser.credential);
    expect(stale.snapshot.connected).toBe(true);
    expect(stale.snapshot.observationAgeMs).toBeGreaterThanOrEqual(10_000);
    const delayedPayload = jobPayload();
    delayedPayload.checksum = await checksum(SVG);
    const staleJob = await call(`/v1/relays/${relay.relayId}/jobs`, {
      credential: browser.credential,
      bindings: relay.bindings,
      body: delayedPayload,
    });
    expect(staleJob.status, await staleJob.clone().text()).toBe(409);
    expect(staleJob.status).toBe(409);

    const fresh = await update(agent, 4);
    expect(fresh.status).toBe(200);
    const payload = jobPayload();
    payload.checksum = await checksum(SVG);
    const first = await call(`/v1/relays/${relay.relayId}/jobs`, {
      credential: browser.credential,
      bindings: relay.bindings,
      body: payload,
    });
    const jobId = payload.id as string;
    expect((await json<{ id: string; status: string }>(first))).toEqual({ id: jobId, status: "queued" });
    const duplicate = await call(`/v1/relays/${relay.relayId}/jobs`, {
      credential: browser.credential,
      bindings: relay.bindings,
      body: payload,
    });
    expect((await json<{ status: string }>(duplicate)).status).toBe("queued");

    const claimedResponse = await update(agent, 5);
    const claimed = await json<{ job: { id: string; status: string; svg: string } | null }>(claimedResponse);
    expect(claimed.job).toMatchObject({ id: jobId, status: "claimed", svg: SVG });
    const competingJob = jobPayload();
    competingJob.checksum = await checksum(SVG);
    const conflict = await call(`/v1/relays/${relay.relayId}/jobs`, {
      credential: browser.credential,
      bindings: relay.bindings,
      body: competingJob,
    });
    expect(conflict.status).toBe(409);
    expect(await json<{ error: string }>(conflict)).toEqual({ error: "import_in_progress" });
    const nextUpdate = await update(agent, 6);
    expect((await json<{ job: unknown }>(nextUpdate)).job).toBeNull();

    const unknown = await call(`/v1/relays/${relay.relayId}/agent/jobs/${crypto.randomUUID()}/status`, {
      credential: relay.credential,
      bindings: relay.bindings,
      body: { generation: String(agent.generation), status: "attempting" },
    });
    expect(unknown.status).toBe(404);
    const newAgent = await startAgent(relay);
    expect(newAgent.generation).toBe(agent.generation + 1);
    const oldStatus = await call(`/v1/relays/${relay.relayId}/agent/jobs/${jobId}/status`, {
      credential: relay.credential,
      bindings: relay.bindings,
      body: { generation: String(agent.generation), status: "attempting" },
    });
    expect(oldStatus.status).toBe(409);
    const status = await call(`/v1/relays/${relay.relayId}/jobs/${jobId}`, {
      credential: browser.credential,
      bindings: relay.bindings,
    });
    expect((await json<{ id: string; status: string; error: string }>(status))).toMatchObject({
      id: jobId,
      status: "unknown",
      error: "agent_generation_changed",
    });
    const stillNotClaimed = await update(newAgent, 1);
    expect((await json<{ job: unknown }>(stillNotClaimed)).job).toBeNull();
  });

  it("clears live coordinates when a connected update lacks valid clock calibration", async () => {
    const relay = await register();
    const agent = await startAgent(relay);
    const browser = await pairBrowser(agent);
    const invalid = await update(agent, 2, { observedAtServer: undefined, clockUncertaintyMs: undefined });
    expect(invalid.status).toBe(400);
    const result = await snapshotOf<{ snapshot: { connected: boolean; position: unknown; context: unknown } }>(relay, browser.credential);
    expect(result.snapshot).toMatchObject({ connected: false, position: null, context: null });
  });

  it("consumes short-lived WebSocket tickets and sends the snapshot envelope", async () => {
    const relay = await register();
    const agent = await startAgent(relay);
    const browser = await pairBrowser(agent);
    await update(agent, 2);
    const ticketResponse = await call(`/v1/relays/${relay.relayId}/ticket`, {
      credential: browser.credential,
      bindings: relay.bindings,
      body: {},
    });
    const { ticket } = await json<{ ticket: string }>(ticketResponse);

    const noUpgrade = await call(`/v1/relays/${relay.relayId}/stream?ticket=${ticket}`, {
      bindings: relay.bindings,
    });
    expect(noUpgrade.status).toBe(426);

    const stream = await call(`/v1/relays/${relay.relayId}/stream?ticket=${ticket}`, {
      bindings: relay.bindings,
      upgrade: true,
    });
    expect(stream.status).toBe(101);
    const socket = stream.webSocket;
    expect(socket).toBeTruthy();
    socket?.accept();
    const message = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("stream snapshot timed out")), 1_000);
      socket?.addEventListener("message", (event) => {
        clearTimeout(timeout);
        resolve(String(event.data));
      }, { once: true });
    });
    expect(JSON.parse(message)).toMatchObject({
      serverTime: expect.any(Number),
      snapshot: {
        connected: true,
        context: { revision: "workspace-v1", size: { x: 600, y: 400 } },
      },
      activeBrowser: false,
      job: null,
    });
    socket?.close();

    const replay = await call(`/v1/relays/${relay.relayId}/stream?ticket=${ticket}`, {
      bindings: relay.bindings,
      upgrade: true,
    });
    expect(replay.status).toBe(401);

    const expiringResponse = await call(`/v1/relays/${relay.relayId}/ticket`, {
      credential: browser.credential,
      bindings: relay.bindings,
      body: {},
    });
    const expiringTicket = (await json<{ ticket: string }>(expiringResponse)).ticket;
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 30_001);
    const expired = await call(`/v1/relays/${relay.relayId}/stream?ticket=${expiringTicket}`, {
      bindings: relay.bindings,
      upgrade: true,
    });
    expect(expired.status).toBe(401);
  });
});

async function issueLaunch(relay: Relay | Agent, credential = relay.credential): Promise<Response> {
  return call(`/v1/relays/${relay.relayId}/agent/browser-launch`, { credential, bindings: relay.bindings, body: {} });
}

async function launchToken(relay: Relay | Agent): Promise<string> {
  const response = await issueLaunch(relay);
  expect(response.status).toBe(200);
  const value = await json<{ launchToken: string; expiresAt: number }>(response);
  expect(value.launchToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(value.expiresAt).toBeGreaterThan(Date.now());
  return value.launchToken;
}

async function redeem(relay: Relay | Agent, token: string, credential?: string, origin?: string | null): Promise<Response> {
  return call(`/v1/relays/${relay.relayId}/browser/launch`, {
    body: credential === undefined ? { launchToken: token } : { launchToken: token, credential },
    bindings: relay.bindings,
    origin,
  });
}

async function launchBrowser(relay: Relay | Agent): Promise<string> {
  const response = await redeem(relay, await launchToken(relay));
  expect(response.status).toBe(200);
  return (await json<{ credential: string }>(response)).credential;
}

async function control(relay: Relay | Agent, credential: string, body: unknown = {}): Promise<Response> {
  return call(`/v1/relays/${relay.relayId}/control`, { credential, bindings: relay.bindings, body });
}

type Envelope = { activeBrowser: boolean; controlOccupied: boolean; rapUpdateRequired: boolean; job: Record<string, unknown> | null };

async function snapshotOf<T = Envelope>(relay: Relay | Agent, credential: string): Promise<T> {
  const ticket = await json<{ ticket: string }>(await call(`/v1/relays/${relay.relayId}/ticket`, { body: {}, credential, bindings: relay.bindings }));
  const response = await call(`/v1/relays/${relay.relayId}/stream?ticket=${ticket.ticket}`, { upgrade: true, bindings: relay.bindings });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const result = new Promise<T>((resolve) => socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), { once: true }));
  socket.accept();
  const value = await result;
  socket.close();
  return value;
}

async function ticketStatus(relay: Relay | Agent, credential: string): Promise<number> {
  const response = await call(`/v1/relays/${relay.relayId}/ticket`, { credential, bindings: relay.bindings, body: {} });
  await response.text();
  return response.status;
}

// Only one browser can be approved at a time; lease fencing is still exercised by seeding a second active row.
async function extraBrowser(relay: Relay | Agent): Promise<string> {
  const credential = randomTokenForTest(), hash = await checksum(credential);
  await runInDurableObject(env.RELAYS.getByName(relay.relayId), (_instance, state) => {
    state.storage.sql.exec("INSERT INTO browsers (id, credential_hash, created_at, revoked) VALUES (?, ?, ?, 0)", crypto.randomUUID(), hash, Date.now());
  });
  return credential;
}

async function queueJob(relay: Relay | Agent, credential: string): Promise<{ response: Response; id: string }> {
  const payload = jobPayload();
  payload.checksum = await checksum(SVG);
  const response = await call(`/v1/relays/${relay.relayId}/jobs`, { credential, bindings: relay.bindings, body: payload });
  return { response, id: payload.id as string };
}

describe("desktop launch authorization", () => {
  afterEach(() => vi.useRealTimers());

  it("requires the agent credential to issue and an allowed origin to redeem", async () => {
    const relay = await register();
    const agent = await startAgent(relay);
    const browser = await pairBrowser(agent);
    expect((await issueLaunch(relay, browser.credential)).status).toBe(401);
    expect((await call(`/v1/relays/${relay.relayId}/agent/browser-launch`, { bindings: relay.bindings, body: {} })).status).toBe(401);
    const other = await register();
    expect((await issueLaunch(relay, other.credential)).status).toBe(401);
    const extra = await call(`/v1/relays/${relay.relayId}/agent/browser-launch`, {
      credential: relay.credential, bindings: relay.bindings, body: { approve: true },
    });
    expect(extra.status).toBe(400);

    const token = await launchToken(relay);
    expect((await redeem(relay, token, undefined, null)).status).toBe(403);
    expect((await redeem(relay, token, undefined, "https://attacker.example")).status).toBe(403);
    expect((await redeem(other, token)).status).toBe(404);
    expect((await redeem(relay, token, "not-a-token")).status).toBe(400);
    const granted = await redeem(relay, token, browser.credential);
    expect(granted.status).toBe(200);
    expect(granted.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    const { credential } = await json<{ credential: string }>(granted);
    expect(Object.keys(await json<Record<string, unknown>>(await redeem(relay, await launchToken(relay), credential)))).toEqual(["credential"]);
    expect(credential).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(credential).not.toBe(relay.credential);
    expect((await snapshotOf(relay, credential)).activeBrowser).toBe(false);
    expect((await call(`/v1/relays/${relay.relayId}/agent/start`, { credential, bindings: relay.bindings, body: { version: "3.0.0" } })).status).toBe(401);
    expect(await ticketStatus(other, credential)).toBe(401);
  });

  it("is single-use, expires and resists replay", async () => {
    const relay = await register();
    const token = await launchToken(relay);
    const granted = await redeem(relay, token);
    expect(granted.status).toBe(200);
    const { credential } = await json<{ credential: string }>(granted);
    const replay = await redeem(relay, token);
    expect(replay.status).toBe(409);
    expect(await json(replay)).toEqual({ error: "launch_token_used" });
    expect((await redeem(relay, randomTokenForTest())).status).toBe(404);

    const late = await launchToken(relay);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2 * 60_000 + 1);
    const expired = await redeem(relay, late);
    expect(expired.status).toBe(410);
    expect(await json(expired)).toEqual({ error: "launch_token_expired" });

    vi.useRealTimers();
    const tokens = await Promise.all(Array.from({ length: 3 }, () => launchToken(relay)));
    const concurrent = await Promise.all(tokens.flatMap((value) => [redeem(relay, value, credential), redeem(relay, value, credential)]));
    expect(concurrent.filter((response) => response.status === 200)).toHaveLength(3);
    expect(concurrent.filter((response) => response.status === 409)).toHaveLength(3);
  });

  it("reuses a valid supplied credential, refuses a second browser, and mints for revoked or foreign credentials", async () => {
    const relay = await register();
    await startAgent(relay);
    const first = await launchBrowser(relay);
    expect(await json(await redeem(relay, await launchToken(relay), first))).toEqual({ credential: first });
    const second = await redeem(relay, await launchToken(relay));
    expect(second.status).toBe(409); await second.text();
    const listed = await json<{ browsers: Array<{ id: string }> }>(await call(`/v1/relays/${relay.relayId}/agent/browsers`, {
      credential: relay.credential, bindings: relay.bindings,
    }));
    expect(listed.browsers).toHaveLength(1);
    expect((await call(`/v1/relays/${relay.relayId}/agent/browsers/revoke`, {
      credential: relay.credential, bindings: relay.bindings, body: { browserId: listed.browsers[0].id },
    })).status).toBe(200);
    expect(await ticketStatus(relay, first)).toBe(401);
    const replacement = (await json<{ credential: string }>(await redeem(relay, await launchToken(relay), first))).credential;
    expect(replacement).not.toBe(first);
    expect(await ticketStatus(relay, replacement)).toBe(200);

    const other = await register();
    const foreign = await launchBrowser(other);
    const revoked = await json<{ browsers: Array<{ id: string }> }>(await call(`/v1/relays/${relay.relayId}/agent/browsers`, { credential: relay.credential, bindings: relay.bindings }));
    for (const browser of revoked.browsers) {
      await (await call(`/v1/relays/${relay.relayId}/agent/browsers/revoke`, { credential: relay.credential, bindings: relay.bindings, body: { browserId: browser.id } })).text();
    }
    const fresh = (await json<{ credential: string }>(await redeem(relay, await launchToken(relay), foreign))).credential;
    expect(fresh).not.toBe(foreign);
    expect(await ticketStatus(other, fresh)).toBe(401);
  });

  it("keeps phone pairing approval separate and bounds launch issuance", async () => {
    const relay = await register();
    const agent = await startAgent(relay);
    const tokens = await Promise.all(Array.from({ length: 5 }, () => launchToken(relay)));
    const outstanding = await issueLaunch(relay);
    expect(outstanding.status).toBe(429);
    expect(await json(outstanding)).toEqual({ error: "too_many_launch_tokens" });
    for (let index = 0; index < 10; index += 1) {
      const invite = await call(`/v1/relays/${relay.relayId}/agent/pairing/new`, { credential: relay.credential, bindings: relay.bindings, body: {} });
      expect(invite.status, `phone invitation ${index + 1}`).toBe(200);
    }
    const { credential } = await json<{ credential: string }>(await redeem(relay, tokens[0]));
    // Granting a browser invalidates every other outstanding launch link.
    for (const token of tokens.slice(1)) {
      const stale = await redeem(relay, token, credential);
      expect(stale.status).toBe(409);
      expect(await json(stale)).toEqual({ error: "launch_token_used" });
    }
    const updated = await json<{ pairings: unknown[] }>(await update(agent, 1));
    expect(updated.pairings).toEqual([]);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    for (let index = 5; index < 20; index += 1) {
      expect((await redeem(relay, await launchToken(relay), credential)).status, `launch ${index + 1}`).toBe(200);
    }
    const rate = await issueLaunch(relay);
    expect(rate.status).toBe(429);
    expect(await json(rate)).toEqual({ error: "launch_rate_limited" });
  }, 30_000);
});

describe("browser control acquisition and takeover", () => {
  afterEach(() => vi.useRealTimers());

  it("claims free control, refuses occupied claims and switches only on explicit takeover", async () => {
    const relay = await register();
    const agent = await startAgent(relay);
    const first = await launchBrowser(relay);
    const second = await extraBrowser(relay);
    expect((await snapshotOf(relay, first))).toMatchObject({ activeBrowser: false, controlOccupied: false });
    expect((await control(relay, first)).status).toBe(200);
    expect((await control(relay, first)).status).toBe(200);
    const occupied = await control(relay, second);
    expect(occupied.status).toBe(409);
    expect(await json(occupied)).toEqual({ error: "browser_lease_occupied" });
    expect((await control(relay, second, { takeover: false })).status).toBe(409);
    expect((await control(relay, second, { takeover: "yes" })).status).toBe(400);
    expect((await control(relay, second, { takeover: true, extra: 1 })).status).toBe(400);
    expect(await snapshotOf(relay, second)).toMatchObject({ activeBrowser: false, controlOccupied: true });
    expect(await snapshotOf(relay, first)).toMatchObject({ activeBrowser: true, controlOccupied: false });

    const takeover = await control(relay, second, { takeover: true });
    expect(takeover.status).toBe(200);
    expect(await json(takeover)).toEqual({ activeBrowser: true });
    expect(await snapshotOf(relay, first)).toMatchObject({ activeBrowser: false, controlOccupied: true });
    expect(await snapshotOf(relay, second)).toMatchObject({ activeBrowser: true, controlOccupied: false });
    await update(agent, 1);
    const fenced = await queueJob(relay, first);
    expect(fenced.response.status).toBe(409);
    expect(await json(fenced.response)).toEqual({ error: "active_browser_required" });
    expect((await control(relay, first)).status).toBe(409);
  });

  function observation(agent: Agent, sequence: number): Record<string, unknown> {
    return { generation: agent.generation, sequence, connected: true, position: { x: 12, y: 34 },
      context: { revision: "workspace-v1", size: { x: 600, y: 400 } }, observationAgeMs: 0,
      observedAtServer: Date.now(), clockUncertaintyMs: 0, settled: true };
  }

  async function browserSocket(relay: Relay, credential: string): Promise<{ socket: WebSocket; messages: Record<string, unknown>[] }> {
    const t = await json<{ ticket: string }>(await call(`/v1/relays/${relay.relayId}/ticket`, { credential, bindings: relay.bindings, body: {} }));
    const response = await call(`/v1/relays/${relay.relayId}/stream?ticket=${t.ticket}`, { bindings: relay.bindings, upgrade: true });
    expect(response.status).toBe(101);
    const socket = response.webSocket!, messages: Record<string, unknown>[] = [];
    socket.addEventListener("message", (event) => { messages.push(JSON.parse(String(event.data))); });
    socket.accept();
    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));
    return { socket, messages };
  }

  describe("WebSocket transport and fresh reads", () => {
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it("keeps live coordinates out of SQL and does not revive them after hibernation", async () => {
      const relay = await register(), agent = await startAgent(relay), browser = await launchBrowser(relay);
      await update(agent, 1); await update(agent, 2); await update(agent, 3);
      const stub = env.RELAYS.getByName(relay.relayId);
      await runInDurableObject(stub, (_instance, state) => {
        const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").toArray().map((row) => row.name);
        expect(tables).not.toContain("snapshots");
      });
      const live = await snapshotOf<{ settled: boolean; snapshot: unknown }>(relay, browser);
      expect(live.settled).toBe(true); expect(live.snapshot).not.toBeNull();
      await evictDurableObject(stub);
      const asleep = await snapshotOf<{ snapshot: unknown }>(relay, browser);
      expect(asleep.snapshot).toBeNull();
      expect((await update(agent, 3)).status).toBe(409);
      expect((await update(agent, 4)).status).toBe(200);
    });

    it("atomically limits service-wide preview leases to two and recovers expired capacity", async () => {
      const cp = env.CONTROL_PLANE.getByName(`preview-test-${crypto.randomUUID()}`);
      const granted = await Promise.all(["a", "b", "c"].map((id) => cp.preview(id, true)));
      expect(granted.filter(Boolean)).toHaveLength(2);
      expect(await cp.preview("a", true)).toBe(true);
      expect(await cp.preview("c", true)).toBe(false);
      vi.useFakeTimers(); vi.setSystemTime(Date.now() + 45_001);
      expect(await cp.preview("c", true)).toBe(true);
    });

    it("leases and forwards moving previews only while watched, then publishes the settled position", async () => {
      const relay = await register(), agent = await startAgent(relay), browser = await launchBrowser(relay);
      const viewer = await browserSocket(relay, browser);
      expect(viewer.messages.at(-1)).toMatchObject({ previewActive: false });
      const still = await update(agent, 1, { settled: true, moving: false });
      expect((await json<{ previewActive: boolean }>(still)).previewActive).toBe(false);
      const moving = await update(agent, 2, { settled: false, moving: true });
      expect((await json<{ previewActive: boolean }>(moving)).previewActive).toBe(true);
      await vi.waitFor(() => expect(viewer.messages.at(-1)).toMatchObject({ previewActive: true, settled: false }));
      const stopped = await update(agent, 3, { settled: true, moving: false });
      expect((await json<{ previewActive: boolean }>(stopped)).previewActive).toBe(false);
      await vi.waitFor(() => expect(viewer.messages.at(-1)).toMatchObject({ previewActive: false, settled: true }));
      expect((await update(agent, 4, { moving: "yes" })).status).toBe(400);
      viewer.socket.close();
    });

    it("caps browser sockets, scopes roles, and releases hidden preview without taking control", async () => {
      const relay = await register(), agent = await startAgent(relay), browser = await launchBrowser(relay);
      const root = `/v1/relays/${relay.relayId}`;
      expect((await call(`${root}/agent/stream?generation=${agent.generation}`, { credential: browser, bindings: relay.bindings, upgrade: true })).status).toBe(401);
      const first = await browserSocket(relay, browser), second = await browserSocket(relay, browser);
      const ticket = await json<{ ticket: string }>(await call(`${root}/ticket`, { credential: browser, bindings: relay.bindings, body: {} }));
      expect((await call(`${root}/stream?ticket=${ticket.ticket}`, { upgrade: true, bindings: relay.bindings, origin: null })).status).toBe(403);
      const moving = await update(agent, 1, { settled: false, moving: true });
      expect((await json<{ previewActive: boolean }>(moving)).previewActive).toBe(true);
      first.socket.send(JSON.stringify({ v: 2, type: "heartbeat", watching: false }));
      second.socket.send(JSON.stringify({ v: 2, type: "heartbeat", watching: false }));
      await vi.waitFor(() => expect(second.messages.at(-1)).toMatchObject({ protocol: 2, previewActive: false, activeBrowser: false }));
      first.socket.close(); second.socket.close();
    });

    it("lets a reloading browser replace its own oldest stream instead of waiting for the liveness sweep", async () => {
      const relay = await register(), agent = await startAgent(relay), browser = await launchBrowser(relay);
      void agent;
      const first = await browserSocket(relay, browser), second = await browserSocket(relay, browser);
      const closed: { code: number; reason: string }[] = [];
      first.socket.addEventListener("close", (event) => closed.push({ code: event.code, reason: event.reason }));
      const third = await browserSocket(relay, browser);
      await vi.waitFor(() => expect(closed).toEqual([{ code: 1008, reason: "browser_replaced" }]));
      expect(third.messages.length).toBeGreaterThan(0);
      second.socket.close(); third.socket.close();
    });

    it("delivers fresh captures over WebSockets with measured wait and rejects replay", async () => {
      const relay = await register(), agent = await startAgent(relay), browser = await launchBrowser(relay);
      const root = `/v1/relays/${relay.relayId}`;
      await control(relay, browser); await update(agent, 1);
      const queued = await queueJob(relay, browser); expect(queued.response.status).toBe(200);
      const stream = await browserSocket(relay, browser), agentSocket = testSockets.get(`${relay.relayId}:${agent.generation}`)!.socket;
      const agentMessages: Record<string, unknown>[] = [];
      agentSocket.addEventListener("message", (event) => agentMessages.push(JSON.parse(String(event.data))));
      const id = crypto.randomUUID();
      expect((await call(`${root}/capture`, { credential: browser, bindings: relay.bindings, body: { requestId: id } })).status).toBe(200);
      await vi.waitFor(() => expect(agentMessages).toContainEqual({ v: 2, type: "capture", id }));
      await new Promise((resolve) => setTimeout(resolve, 150));
      agentSocket.send(JSON.stringify({ v: 2, type: "capture-result", id, body: observation(agent, 2) }));
      await vi.waitFor(() => expect(stream.messages.find((m) => m.id === id)).toBeTruthy());
      const result = stream.messages.find((m) => m.id === id) as { type: string; body: { waitMs: number; snapshot: unknown } };
      expect(result.type).toBe("capture-result"); expect(result.body.waitMs).toBeGreaterThanOrEqual(100); expect(result.body.snapshot).not.toBeNull();
      agentSocket.send(JSON.stringify({ v: 2, type: "capture-result", id, body: observation(agent, 3) }));
      await vi.waitFor(() => expect(agentMessages).toContainEqual({ v: 2, type: "error", id, error: "capture_not_pending" }));
      stream.socket.close();
    });

    it("fails capture when control changes", async () => {
      const relay = await register(), agent = await startAgent(relay), browser = await launchBrowser(relay), other = await extraBrowser(relay);
      const root = `/v1/relays/${relay.relayId}`;
      await control(relay, browser); await update(agent, 1);
      const stream = await browserSocket(relay, browser);
      const id = crypto.randomUUID();
      expect((await call(`${root}/capture`, { credential: browser, bindings: relay.bindings, body: { requestId: id } })).status).toBe(200);
      await control(relay, other, { takeover: true });
      const agentSocket = testSockets.get(`${relay.relayId}:${agent.generation}`)!.socket;
      agentSocket.send(JSON.stringify({ v: 2, type: "capture-result", id, body: observation(agent, 2) }));
      await vi.waitFor(() => expect(stream.messages.find((m) => m.id === id)).toMatchObject({ type: "error" }));
      stream.socket.close();
    });

    it("broadcasts queued and terminal jobs without renewing the browser's control lease", async () => {
      const relay = await register(), agent = await startAgent(relay), browser = await launchBrowser(relay);
      await control(relay, browser); await update(agent, 1);
      const stream = await browserSocket(relay, browser), stub = env.RELAYS.getByName(relay.relayId);
      const leaseBefore = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ lease_expires_at: number }>("SELECT lease_expires_at FROM relay_meta").one().lease_expires_at);
      const job = await queueJob(relay, browser); expect(job.response.status).toBe(200);
      await vi.waitFor(() => expect(stream.messages.at(-1)).toMatchObject({ job: { id: job.id, status: "queued" } }));
      await update(agent, 2);
      for (const status of ["attempting", "confirmed"]) {
        expect((await call(`/v1/relays/${relay.relayId}/agent/jobs/${job.id}/status`, { credential: agent.credential, bindings: relay.bindings, body: { generation: agent.generation, status } })).status).toBe(200);
      }
      await vi.waitFor(() => expect(stream.messages.at(-1)).toMatchObject({ job: { id: job.id, status: "confirmed" } }));
      const leaseAfter = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ lease_expires_at: number }>("SELECT lease_expires_at FROM relay_meta").one().lease_expires_at);
      expect(leaseAfter).toBe(leaseBefore);
      stream.socket.close();
    });

    it("does not renew an expired owner through outgoing snapshots or reconnect", async () => {
      const relay = await register(), agent = await startAgent(relay), browser = await launchBrowser(relay);
      await control(relay, browser); await update(agent, 1);
      const stream = await browserSocket(relay, browser);
      vi.useFakeTimers(); vi.setSystemTime(Date.now() + 45_001);
      await update(agent, 2);
      await vi.waitFor(() => expect(stream.messages.at(-1)).toMatchObject({ activeBrowser: false }));
      stream.socket.close();
      expect(await snapshotOf(relay, browser)).toMatchObject({ activeBrowser: false, controlOccupied: false });
    });

    it("runs alarm cleanup while preserving credentials and replay tombstones", async () => {
      const relay = await register(), agent = await startAgent(relay), browser = await launchBrowser(relay);
      await control(relay, browser); await update(agent, 1);
      const queued = await queueJob(relay, browser); expect(queued.response.status).toBe(200);
      vi.useFakeTimers(); vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
      const stub = env.RELAYS.getByName(relay.relayId);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      await runInDurableObject(stub, async (_instance, state) => {
        expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM jobs").one().n).toBe(0);
        expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM job_tombstones WHERE id=?", queued.id).one().n).toBe(1);
        expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM browsers").one().n).toBe(1);
        expect(await state.storage.getAlarm()).toBeNull();
      });
      expect((await call(`/v1/relays/${relay.relayId}/ticket`, { credential: browser, bindings: relay.bindings, body: {} })).status).toBe(200);
      expect((await startAgent(relay)).generation).toBe(agent.generation + 1);
    });

  });

  it("blocks takeover and lease-expiry claims while another browser has unresolved imports", async () => {
    const relay = await register();
    const agent = await startAgent(relay);
    const owner = await launchBrowser(relay);
    const other = await extraBrowser(relay);
    expect((await control(relay, owner)).status).toBe(200);
    await update(agent, 1);
    const queued = await queueJob(relay, owner);
    expect(queued.response.status).toBe(200);
    const refused = await control(relay, other, { takeover: true });
    expect(refused.status).toBe(409);
    expect(await json(refused)).toEqual({ error: "unresolved_imports" });

    const claimed = await json<{ job: { id: string } | null }>(await update(agent, 2));
    expect(claimed.job?.id).toBe(queued.id);
    expect((await control(relay, other, { takeover: true })).status).toBe(409);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 45_001);
    expect((await snapshotOf(relay, other)).controlOccupied).toBe(false);
    const expiredLease = await control(relay, other);
    expect(expiredLease.status).toBe(409);
    expect(await json(expiredLease)).toEqual({ error: "unresolved_imports" });
    const restarted = await startAgent(relay);
    expect(await json(await call(`/v1/relays/${relay.relayId}/jobs/${queued.id}`, { credential: owner, bindings: relay.bindings })))
      .toMatchObject({ id: queued.id, status: "unknown" });
    expect((await control(relay, other, { takeover: true })).status).toBe(409);
    expect((await control(relay, owner)).status).toBe(200);
    await update(restarted, 1);
    const ownerFollowUp = await queueJob(relay, owner);
    expect(ownerFollowUp.response.status).toBe(200);
    await update(restarted, 2);
    expect((await call(`/v1/relays/${relay.relayId}/agent/jobs/${ownerFollowUp.id}/status`, {
      credential: relay.credential, bindings: relay.bindings, body: { generation: restarted.generation, status: "attempting" },
    })).status).toBe(200);
    expect((await call(`/v1/relays/${relay.relayId}/agent/jobs/${ownerFollowUp.id}/status`, {
      credential: relay.credential, bindings: relay.bindings, body: { generation: restarted.generation, status: "confirmed" },
    })).status).toBe(200);
    expect((await control(relay, other, { takeover: true })).status).toBe(409);

    expect((await call(`/v1/relays/${relay.relayId}/jobs/${queued.id}/resolve`, { credential: other, bindings: relay.bindings, body: {} })).status).toBe(404);
    expect((await call(`/v1/relays/${relay.relayId}/jobs/${ownerFollowUp.id}/resolve`, { credential: owner, bindings: relay.bindings, body: {} })).status).toBe(409);
    expect((await call(`/v1/relays/${relay.relayId}/jobs/${queued.id}/resolve`, { credential: owner, bindings: relay.bindings, body: { force: true } })).status).toBe(400);
    expect((await call(`/v1/relays/${relay.relayId}/jobs/${queued.id}/resolve`, { credential: relay.credential, bindings: relay.bindings, body: {} })).status).toBe(401);
    const resolved = await call(`/v1/relays/${relay.relayId}/jobs/${queued.id}/resolve`, { credential: owner, bindings: relay.bindings, body: {} });
    expect(resolved.status).toBe(200);
    expect(await json(resolved)).toEqual({ id: queued.id, status: "unknown", error: "agent_generation_changed", resolved: true });
    expect((await call(`/v1/relays/${relay.relayId}/jobs/${queued.id}/resolve`, { credential: owner, bindings: relay.bindings, body: {} })).status).toBe(200);
    expect(await json(await call(`/v1/relays/${relay.relayId}/jobs/${queued.id}`, { credential: owner, bindings: relay.bindings })))
      .toMatchObject({ status: "unknown", resolved: true });

    expect((await control(relay, other, { takeover: true })).status).toBe(200);
    expect(await snapshotOf(relay, owner)).toMatchObject({ activeBrowser: false, controlOccupied: true });
  });

  it("does not let a revoked browser's unknown import block control forever", async () => {
    const relay = await register();
    const agent = await startAgent(relay);
    const owner = await launchBrowser(relay);
    const other = await extraBrowser(relay);
    await control(relay, owner);
    await update(agent, 1);
    expect((await queueJob(relay, owner)).response.status).toBe(200);
    await update(agent, 2);
    await startAgent(relay);
    expect((await control(relay, other, { takeover: true })).status).toBe(409);
    const listed = await json<{ browsers: Array<{ id: string }> }>(await call(`/v1/relays/${relay.relayId}/agent/browsers`, {
      credential: relay.credential, bindings: relay.bindings,
    }));
    await call(`/v1/relays/${relay.relayId}/agent/browsers/revoke`, {
      credential: relay.credential, bindings: relay.bindings, body: { browserId: listed.browsers[0].id },
    });
    expect((await control(relay, other)).status).toBe(200);
  });

  it("serializes takeover against concurrent job admission", async () => {
    for (let round = 0; round < 5; round += 1) {
      const relay = await register();
      const agent = await startAgent(relay);
      const owner = await launchBrowser(relay);
      const other = await extraBrowser(relay);
      expect((await control(relay, owner)).status).toBe(200);
      await update(agent, 1);
      const payload = jobPayload();
      payload.checksum = await checksum(SVG);
      const [job, takeover] = await Promise.all([
        call(`/v1/relays/${relay.relayId}/jobs`, { credential: owner, bindings: relay.bindings, body: payload }),
        control(relay, other, { takeover: true }),
      ]);
      const jobBody = await json<{ status?: string; error?: string }>(job);
      const takeoverBody = await json<{ activeBrowser?: boolean; error?: string }>(takeover);
      if (job.status === 200) {
        expect(jobBody.status).toBe("queued");
        expect(takeover.status).toBe(409);
        expect(takeoverBody.error).toBe("unresolved_imports");
        expect((await snapshotOf(relay, owner)).activeBrowser).toBe(true);
      } else {
        expect(job.status).toBe(409);
        expect(jobBody.error).toBe("active_browser_required");
        expect(takeover.status).toBe(200);
        expect((await snapshotOf(relay, owner)).activeBrowser).toBe(false);
        expect((await call(`/v1/relays/${relay.relayId}/jobs/${payload.id}`, { credential: owner, bindings: relay.bindings })).status).toBe(404);
        expect((await json<{ job: unknown }>(await update(agent, 2))).job).toBeNull();
      }
    }
  });

  it("streams controlOccupied to the previous controller after takeover", async () => {
    const relay = await register();
    const agent = await startAgent(relay);
    const first = await launchBrowser(relay);
    const second = await extraBrowser(relay);
    await control(relay, first);
    await update(agent, 1);
    const { ticket } = await json<{ ticket: string }>(await call(`/v1/relays/${relay.relayId}/ticket`, {
      credential: first, bindings: relay.bindings, body: {},
    }));
    const stream = await call(`/v1/relays/${relay.relayId}/stream?ticket=${ticket}`, { bindings: relay.bindings, upgrade: true });
    const socket = stream.webSocket;
    expect(socket).toBeTruthy();
    const messages: Array<{ activeBrowser: boolean; controlOccupied: boolean }> = [];
    socket?.addEventListener("message", (event) => { messages.push(JSON.parse(String(event.data))); });
    socket?.accept();
    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));
    expect(messages[0]).toMatchObject({ activeBrowser: true, controlOccupied: false });
    expect((await control(relay, second, { takeover: true })).status).toBe(200);
    await vi.waitFor(() => expect(messages.at(-1)).toMatchObject({ activeBrowser: false, controlOccupied: true }));
    socket?.close();
  });
});
