import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const ORIGIN = "https://nicholas-a11y.github.io";
const encoder = new TextEncoder();

type TestBindings = Env & { BOOTSTRAP_TOKEN: string };
type Relay = { relayId: string; credential: string; bindings: TestBindings };
type Agent = Relay & { generation: number; serverTime: number };
type Browser = { pairingId: string; pendingToken: string; phrase: string; credential: string };

function bindings(token: string): TestBindings {
  return Object.assign({}, env, { BOOTSTRAP_TOKEN: token }) as TestBindings;
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
    options.bindings ?? bindings(`test-bootstrap-${crypto.randomUUID()}`),
  );
  return response;
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

async function register(token = `bootstrap-${crypto.randomUUID()}`): Promise<Relay> {
  const runtime = bindings(token);
  const response = await call("/v1/register", {
    body: { bootstrapToken: token, name: "test relay" },
    bindings: runtime,
  });
  expect(response.status).toBe(201);
  const value = await json<{ relayId: string; credential: string }>(response);
  return { ...value, bindings: runtime };
}

async function startAgent(relay: Relay): Promise<Agent> {
  const response = await call(`/v1/relays/${relay.relayId}/agent/start`, {
    body: {},
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
  return call(`/v1/relays/${agent.relayId}/agent/update`, {
    credential: agent.credential,
    bindings: agent.bindings,
    body: {
      generation: agent.generation,
      sequence,
      connected: true,
      position: { x: 12, y: 34 },
      context: { revision: "workspace-v1", size: { x: 600, y: 400 } },
      observationAgeMs: 0,
      observedAtServer: Date.now(),
      clockUncertaintyMs: 20,
      ...overrides,
    },
  });
}

async function pairBrowser(agent: Agent, sequence = 1): Promise<Browser> {
  const inviteResponse = await call(`/v1/relays/${agent.relayId}/pairing/new`, {
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
  const decide = await call(`/v1/relays/${agent.relayId}/pairing/decide`, {
    credential: agent.credential,
    bindings: agent.bindings,
    body: { pairingId: pending.pairingId, approve: true },
  });
  expect(decide.status).toBe(200);
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

  it("requires a single-use bootstrap invitation and rate-limits registration attempts", async () => {
    const token = `bootstrap-${crypto.randomUUID()}`;
    const runtime = bindings(token);
    const ip = crypto.randomUUID();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rejected = await call("/v1/register", {
        body: { bootstrapToken: "incorrect-bootstrap-token", name: "test" },
        bindings: runtime,
        ip,
      });
      expect(rejected.status).toBe(401);
    }
    const limited = await call("/v1/register", {
      body: { bootstrapToken: "incorrect-bootstrap-token", name: "test" },
      bindings: runtime,
      ip,
    });
    expect(limited.status).toBe(429);

    const first = await register(token);
    const reused = await call("/v1/register", {
      body: { bootstrapToken: token, name: "second relay" },
      bindings: runtime,
    });
    expect(reused.status).toBe(409);
    expect(first.credential).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("isolates relay credentials and rejects unapproved CORS origins", async () => {
    const first = await register();
    const second = await register();
    const firstAgent = await startAgent(first);
    const wrongRelay = await call(`/v1/relays/${second.relayId}/agent/start`, {
      body: {},
      credential: firstAgent.credential,
      bindings: second.bindings,
    });
    expect(wrongRelay.status).toBe(401);

    const denied = await call(`/v1/relays/${first.relayId}/snapshot`, {
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
  }, 30_000);

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
    const competingBrowser = await pairBrowser(agent, 2);
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
    const staleSnapshot = await call(`/v1/relays/${relay.relayId}/snapshot`, {
      credential: browser.credential,
      bindings: relay.bindings,
    });
    const stale = await json<{ snapshot: { connected: boolean; observationAgeMs: number } }>(staleSnapshot);
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
    const snapshot = await call(`/v1/relays/${relay.relayId}/snapshot`, {
      credential: browser.credential,
      bindings: relay.bindings,
    });

    const result = await json<{ snapshot: { connected: boolean; position: unknown; context: unknown } }>(snapshot);
    expect(result.snapshot).toMatchObject({ connected: false, position: null, context: null });
  });

  it("accepts RAP's unprefixed pairing, browser management and import status routes", async () => {
      const relay = await register();
      const agent = await startAgent(relay);
      const browser = await pairBrowser(agent);
      const root = `/v1/relays/${relay.relayId}`;
      const listed = await call(`${root}/browsers`, { credential: relay.credential, bindings: relay.bindings });
      expect(listed.status).toBe(200);
      const browsers = await json<{ browsers: Array<{ id: string }> }>(listed);
      expect(browsers.browsers).toHaveLength(1);
      const denied = await call(`${root}/pairing/new`, { body: {}, credential: browser.credential, bindings: relay.bindings });
      expect([401, 403]).toContain(denied.status);
      expect((await call(`${root}/control`, { body: {}, credential: browser.credential, bindings: relay.bindings })).status).toBe(200);
      const payload = jobPayload();
      payload.checksum = await checksum(SVG);
      expect((await call(`${root}/jobs`, { body: payload, credential: browser.credential, bindings: relay.bindings })).status).toBe(200);
      expect((await update(agent, 2)).status).toBe(200);
      const attempting = await call(`${root}/jobs/${payload.id}/status`, {
        body: { generation: String(agent.generation), status: "attempting" }, credential: relay.credential, bindings: relay.bindings,
      });
      expect(attempting.status).toBe(200);
      const revoked = await call(`${root}/browsers/revoke`, {
        body: { browserId: browsers.browsers[0].id }, credential: relay.credential, bindings: relay.bindings,
      });
      expect(revoked.status).toBe(200);
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

function randomTokenForTest(): string {
  return btoa(crypto.randomUUID() + crypto.randomUUID()).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "").slice(0, 43);
}
