import { DurableObject } from "cloudflare:workers";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const ALLOWED_ORIGINS = new Set([
  "https://nicholas-a11y.github.io",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);
const MAX_JSON_BYTES = 16 * 1024;
const MAX_JOB_JSON_BYTES = 540 * 1024;
const MAX_SVG_BYTES = 512 * 1024;
const SNAPSHOT_MAX_AGE_MS = 2_000;
const BROWSER_LEASE_MS = 15_000;
const PAIRING_LIFETIME_MS = 5 * 60_000;
const JOB_LIFETIME_MS = 60_000;
const JOB_RETENTION_MS = 24 * 60 * 60_000;
const JOB_LIMIT = 1_000;
const PENDING_JOB_LIMIT = 10;
const LAUNCH_TOKEN_LIFETIME_MS = 2 * 60_000;
const LAUNCH_OUTSTANDING_LIMIT = 5;
const LAUNCH_RATE_WINDOW_MS = 10 * 60_000;
const LAUNCH_RATE_LIMIT = 20;
const LAUNCH_BROWSER_LIMIT = 20;

type JsonObject = Record<string, unknown>;
type Snapshot = {
  generation: number;
  sequence: number;
  connected: boolean;
  position: { x: number; y: number } | null;
  context: { revision: string; size: { x: number; y: number } | null } | null;
  observationAgeMs: number;
  receivedAt: number;
};
type JobStatus = "queued" | "claimed" | "attempting" | "accepted" | "confirmed" | "failed" | "unknown" | "expired";
type JobResult = { id: string; status: JobStatus; error?: string; resolved?: true };
type StoredJob = {
  id: string;
  svg: string | null;
  checksum: string;
  filename: string;
  anchor: string;
  context_revision: string;
  expires_at: number;
  status: JobStatus;
  error: string | null;
  browser_id: string;
  generation: number | null;
  created_at: number;
  updated_at: number;
};
type BrowserIdentity = { id: string };
type AgentIdentity = { generation: number };
type ErrorShape = { status: number; code: string };

class HttpError extends Error implements ErrorShape {
  status: number;
  code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonResponse({ error: error.code }, error.status);
  }
  return jsonResponse({ error: "internal_error" }, 500);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredObject(value: unknown): JsonObject {
  if (!isObject(value)) throw new HttpError(400, "invalid_request");
  return value;
}

function isFiniteBounded(value: unknown, bound = 10_000_000): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= bound;
}

function isRevision(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function randomToken(byteLength = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function randomPhrase(): string {
  const words = [
    "amber", "birch", "cedar", "delta", "ember", "fern", "glade", "harbor",
    "iris", "juniper", "kestrel", "lantern", "maple", "nectar", "oasis", "pebble",
    "quartz", "ripple", "summit", "thistle", "umber", "violet", "willow", "yonder",
    "zephyr", "acorn", "brook", "cobalt", "dawn", "elm", "flint", "grove",
    "hazel", "island", "jasper", "kingfisher", "lilac", "meadow", "north", "orchid",
    "prairie", "quiet", "redwood", "silver", "timber", "upland", "valley", "water",
    "yellow", "zenith", "apricot", "boulder", "canyon", "drift", "eagle", "frost",
    "garden", "heather", "indigo", "lake", "marble", "novel", "oyster", "pine",
  ];
  const picks = crypto.getRandomValues(new Uint8Array(4));
  return [...picks].map((pick) => words[pick % words.length]).join("-");
}

async function sha256(value: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  const maxLength = Math.max(a.length, b.length);
  for (let i = 0; i < maxLength; i += 1) {
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return difference === 0;
}

async function hashToken(token: string): Promise<string> {
  return toHex(await sha256(token));
}

async function readBytesLimited(request: Request, maxBytes: number): Promise<Uint8Array> {
  const length = request.headers.get("Content-Length");
  if (length && /^\d+$/u.test(length) && Number(length) > maxBytes) {
    throw new HttpError(413, "request_too_large");
  }
  if (!request.body) throw new HttpError(400, "invalid_request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "request_too_large");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function readJson(request: Request, maxBytes = MAX_JSON_BYTES): Promise<unknown> {
  const type = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "json_required");
  const bytes = await readBytesLimited(request, maxBytes);
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

async function forwardRequest(request: Request): Promise<Request> {
  if (request.method === "GET") return request;
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
  const body = await readBytesLimited(request, MAX_JOB_JSON_BYTES);
  const headers = new Headers(request.headers);
  headers.delete("Content-Length");
  headers.delete("Transfer-Encoding");
  return new Request(request.url, {
    method: "POST",
    headers,
    body: toArrayBuffer(body),
    redirect: request.redirect,
  });
}

function jsonBody(value: JsonObject, allowedKeys: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new HttpError(400, "invalid_request");
  }
}

function bearer(request: Request): string {
  const value = request.headers.get("Authorization");
  const match = value?.match(/^Bearer ([A-Za-z0-9_-]{43})$/u);
  if (!match) throw new HttpError(401, "unauthorized");
  return match[1];
}

function requireAllowedOrigin(request: Request): string {
  const origin = request.headers.get("Origin");
  if (!origin || !ALLOWED_ORIGINS.has(origin)) throw new HttpError(403, "origin_not_allowed");
  return origin;
}

function currentSnapshot(sql: SqlStorage): Snapshot | null {
  const row = sql.exec<{ payload: string }>("SELECT payload FROM snapshots WHERE singleton = 1").toArray()[0];
  if (!row) return null;
  try {
    const parsed: unknown = JSON.parse(row.payload);
    return isObject(parsed) ? parsed as unknown as Snapshot : null;
  } catch {
    return null;
  }
}

function jobResult(job: Pick<StoredJob, "id" | "status" | "error">, resolved = false): JobResult {
  const result: JobResult = job.error ? { id: job.id, status: job.status, error: job.error } : { id: job.id, status: job.status };
  if (resolved && job.status === "unknown") result.resolved = true;
  return result;
}

function requireToken(value: unknown): string {
  if (typeof value !== "string" || fromBase64Url(value)?.byteLength !== 32) throw new HttpError(400, "invalid_request");
  return value;
}

function requireUuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new HttpError(400, "invalid_request");
  }
  return value.toLowerCase();
}

function parseGeneration(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) return value;
  if (typeof value === "string" && /^[1-9]\d{0,15}$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function parsePoint(value: unknown): { x: number; y: number } | null | undefined {
  if (value === null) return null;
  if (!isObject(value) || !isFiniteBounded(value.x) || !isFiniteBounded(value.y)) return undefined;
  return { x: value.x, y: value.y };
}

function parseContext(value: unknown): Snapshot["context"] | undefined {
  if (value === null) return null;
  if (!isObject(value) || !isRevision(value.revision)) return undefined;
  let size: { x: number; y: number } | null;
  if (value.size === null) size = null;
  else {
    const point = parsePoint(value.size);
    if (!point) return undefined;
    size = point;
  }
  return { revision: value.revision, size };
}

function validSvg(svg: string): boolean {
  const bytes = encoder.encode(svg);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SVG_BYTES) return false;
  if (/<!DOCTYPE|<!ENTITY|<!--|-->|&|javascript:|data:|file:|url\s*\(|on[a-z]+\s*=|<\s*(?:script|foreignObject|image|text|use|style|iframe)\b/iu.test(svg)) {
    return false;
  }
  const lines = svg.split("\n");
  if (lines.length < 4 || lines.length > 20_002 || lines[0] !== '<?xml version="1.0" encoding="UTF-8"?>' || lines.at(-1) !== "</svg>") {
    return false;
  }
  const root = lines[1].match(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="((?:0|[1-9]\d*)(?:\.\d+)?)mm" height="((?:0|[1-9]\d*)(?:\.\d+)?)mm" viewBox="0 0 \1 \2">$/u);
  if (!root) return false;
  const width = Number(root[1]);
  const height = Number(root[2]);
  if (!(width > 0 && height > 0 && width <= 1_000_000 && height <= 1_000_000)) return false;
  const number = "(-?(?:0|[1-9]\\d*)(?:\\.\\d+)?)";
  let vertexCount = 0;
  for (const line of lines.slice(2, -1)) {
    if (!line) continue;
    const circle = line.match(new RegExp(`^<circle cx="${number}" cy="${number}" r="${number}" fill="none" stroke="#[0-9a-fA-F]{6}" stroke-width="${number}" />$`, "u"));
    if (circle) {
      const [, cxText, cyText, rText, strokeWidthText] = circle;
      const cx = Number(cxText), cy = Number(cyText), radius = Number(rText), strokeWidth = Number(strokeWidthText);
      if (![cx, cy, radius, strokeWidth].every(Number.isFinite) || radius <= 0 || radius > 100_000 || strokeWidth <= 0 || strokeWidth > 10 ||
          cx - radius < -0.001 || cy - radius < -0.001 || cx + radius > width + 0.001 || cy + radius > height + 0.001) return false;
      vertexCount += 1;
      continue;
    }
    const path = line.match(/^<path d="([^"]+)" fill="none" stroke="#[0-9a-fA-F]{6}" stroke-width="((?:0|[1-9]\d*)(?:\.\d+)?)" \/>$/u);
    if (!path || Number(path[2]) <= 0 || Number(path[2]) > 10) return false;
    const tokens = path[1].trim().split(/\s+/u);
    if (tokens.length < 5 || tokens[0] !== "M" || (tokens.length - (tokens.at(-1) === "Z" ? 1 : 0)) % 3 !== 0) return false;
    if (tokens.at(-1) === "Z") tokens.pop();
    for (let i = 0; i < tokens.length;) {
      const command = tokens[i];
      if ((i === 0 && command !== "M") || (i > 0 && command !== "L") || i + 2 >= tokens.length) return false;
      const x = Number(tokens[i + 1]), y = Number(tokens[i + 2]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < -0.001 || y < -0.001 || x > width + 0.001 || y > height + 0.001) return false;
      vertexCount += 1;
      i += 3;
    }
    if (vertexCount > 100_000) return false;
  }
  return vertexCount > 0;
}

async function wrapCredential(pendingToken: string, credential: string): Promise<{ iv: string; ciphertext: string }> {
  const keyBytes = await sha256(pendingToken);
  const key = await crypto.subtle.importKey("raw", toArrayBuffer(keyBytes), { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(encoder.encode(credential)),
  );
  return { iv: toBase64Url(iv), ciphertext: toBase64Url(new Uint8Array(ciphertext)) };
}

async function unwrapCredential(pendingToken: string, iv: string, ciphertext: string): Promise<string> {
  const keyBytes = await sha256(pendingToken);
  const key = await crypto.subtle.importKey("raw", toArrayBuffer(keyBytes), { name: "AES-GCM" }, false, ["decrypt"]);
  const ivBytes = fromBase64Url(iv);
  const encryptedBytes = fromBase64Url(ciphertext);
  if (!ivBytes || !encryptedBytes) throw new HttpError(500, "credential_unavailable");
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(ivBytes) },
      key,
      toArrayBuffer(encryptedBytes),
    );
    return decoder.decode(plaintext);
  } catch {
    throw new HttpError(500, "credential_unavailable");
  }
}

export class ControlPlaneDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS registration_rates (
          ip_hash TEXT NOT NULL,
          window_start INTEGER NOT NULL,
          attempts INTEGER NOT NULL,
          PRIMARY KEY (ip_hash, window_start)
        );
        CREATE TABLE IF NOT EXISTS consumed_invitations (
          token_hash TEXT PRIMARY KEY,
          relay_id TEXT NOT NULL,
          consumed_at INTEGER NOT NULL
        );
      `);
    });
  }

  consumeRegistrationAttempt(ipHash: string, tokenHash: string | null, relayId: string, now: number): "allowed" | "invalid" | "consumed" | "rate_limited" {
    return this.ctx.storage.transactionSync(() => {
      const windowStart = Math.floor(now / 60_000) * 60_000;
      const row = this.ctx.storage.sql.exec<{ attempts: number }>(
        "SELECT attempts FROM registration_rates WHERE ip_hash = ? AND window_start = ?",
        ipHash,
        windowStart,
      ).toArray()[0];
      const attempts = row?.attempts ?? 0;
      if (attempts >= 5) return "rate_limited";
      this.ctx.storage.sql.exec(
        `INSERT INTO registration_rates (ip_hash, window_start, attempts) VALUES (?, ?, 1)
         ON CONFLICT(ip_hash, window_start) DO UPDATE SET attempts = attempts + 1`,
        ipHash,
        windowStart,
      );
      this.ctx.storage.sql.exec("DELETE FROM registration_rates WHERE window_start < ?", now - 24 * 60 * 60_000);
      if (!tokenHash) return "invalid";
      const consumed = this.ctx.storage.sql.exec<{ token_hash: string }>(
        "SELECT token_hash FROM consumed_invitations WHERE token_hash = ?",
        tokenHash,
      ).toArray()[0];
      if (consumed) return "consumed";
      this.ctx.storage.sql.exec(
        "INSERT INTO consumed_invitations (token_hash, relay_id, consumed_at) VALUES (?, ?, ?)",
        tokenHash,
        relayId,
        now,
      );
      return "allowed";
    });
  }
}

export class RelayDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS relay_meta (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          relay_id TEXT NOT NULL,
          name TEXT NOT NULL,
          agent_hash TEXT NOT NULL,
          generation INTEGER NOT NULL DEFAULT 0,
          lease_browser_id TEXT,
          lease_expires_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS snapshots (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          generation INTEGER NOT NULL,
          sequence INTEGER NOT NULL,
          payload TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS invitations (
          token_hash TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          used INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS pairings (
          id TEXT PRIMARY KEY,
          pending_hash TEXT NOT NULL,
          credential_hash TEXT NOT NULL,
          browser_id TEXT NOT NULL,
          wrapped_iv TEXT NOT NULL,
          wrapped_credential TEXT NOT NULL,
          phrase TEXT NOT NULL,
          status TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS pairings_status_expiry ON pairings(status, expires_at);
        CREATE TABLE IF NOT EXISTS browsers (
          id TEXT PRIMARY KEY,
          credential_hash TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          revoked INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS tickets (
          ticket_hash TEXT PRIMARY KEY,
          browser_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          svg TEXT,
          checksum TEXT NOT NULL,
          filename TEXT NOT NULL,
          anchor TEXT NOT NULL,
          context_revision TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          status TEXT NOT NULL,
          error TEXT,
          browser_id TEXT NOT NULL,
          generation INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS jobs_status_expiry ON jobs(status, expires_at);
        CREATE INDEX IF NOT EXISTS jobs_browser_created ON jobs(browser_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS job_resolutions (
          job_id TEXT PRIMARY KEY,
          resolved_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS browser_launches (
          token_hash TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          used INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS browser_launches_created ON browser_launches(created_at);
        CREATE TABLE IF NOT EXISTS launch_browsers (
          browser_id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL
        );
      `);
    });
  }

  initializeRelay(relayId: string, name: string, agentHash: string): boolean {
    return this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql.exec<{ relay_id: string }>(
        "SELECT relay_id FROM relay_meta WHERE singleton = 1",
      ).toArray()[0];
      if (existing) return false;
      this.ctx.storage.sql.exec(
        "INSERT INTO relay_meta (singleton, relay_id, name, agent_hash) VALUES (1, ?, ?, ?)",
        relayId,
        name,
        agentHash,
      );
      return true;
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const match = url.pathname.match(/^\/v1\/relays\/([0-9a-f-]{36})(\/.*)$/iu);
      if (!match) throw new HttpError(404, "not_found");
      const relayId = match[1].toLowerCase();
      const route = match[2];
      const meta = this.meta();
      if (!meta || meta.relay_id !== relayId) throw new HttpError(404, "not_found");

      if (request.method === "POST" && route === "/pairing/request") return await this.pairingRequest(request);
      if (request.method === "POST" && route === "/pairing/status") return await this.pairingStatus(request);
      if (request.method === "POST" && route === "/browser/launch") return await this.browserLaunch(request);
      if (request.method === "GET" && route === "/stream") return await this.stream(request);

      const agentStatus = route.match(/^\/(?:agent\/)?jobs\/([0-9a-f-]{36})\/status$/iu);
      if (route.startsWith("/agent/") || route === "/pairing/new" || route === "/pairing/decide" ||
          route === "/browsers" || route.startsWith("/browsers/") || agentStatus) {
        const identity = await this.authenticateAgent(request);
        if (request.method === "POST" && route === "/agent/start") return this.agentStart(identity);
        if (request.method === "POST" && route === "/agent/update") return await this.agentUpdate(request, identity);
        if (request.method === "POST" && route === "/agent/browser-launch") return await this.browserLaunchNew(request);
        if (request.method === "POST" && (route === "/pairing/new" || route === "/agent/pairing/new")) return await this.pairingNew(request);
        if (request.method === "POST" && (route === "/pairing/decide" || route === "/agent/pairing/decide")) return await this.pairingDecide(request);
        if (request.method === "GET" && route === "/browsers") return this.listBrowsers();
        if (request.method === "POST" && route === "/browsers/revoke") return await this.revokeBrowser(request);
        if (request.method === "POST" && agentStatus) return await this.agentJobStatus(request, agentStatus[1].toLowerCase(), identity);
        throw new HttpError(404, "not_found");
      }

      if (route === "/snapshot" && request.method === "GET") {
        const browser = await this.authenticateBrowser(request);
        return this.browserSnapshot(browser);
      }
      if (route === "/control" && request.method === "POST") {
        const browser = await this.authenticateBrowser(request);
        return await this.browserControl(request, browser);
      }
      if (route === "/control/release" && request.method === "POST") {
        const browser = await this.authenticateBrowser(request);
        return this.releaseControl(browser);
      }
      if (route === "/jobs" && request.method === "POST") {
        const browser = await this.authenticateBrowser(request);
        return await this.createJob(request, browser);
      }
      const resolveJob = route.match(/^\/jobs\/([0-9a-f-]{36})\/resolve$/iu);
      if (request.method === "POST" && resolveJob) {
        const browser = await this.authenticateBrowser(request);
        return await this.resolveJob(request, resolveJob[1].toLowerCase(), browser);
      }
      const browserJob = route.match(/^\/jobs\/([0-9a-f-]{36})$/iu);
      if (request.method === "GET" && browserJob) {
        const browser = await this.authenticateBrowser(request);
        return this.getBrowserJob(browserJob[1].toLowerCase(), browser);
      }
      if (route === "/ticket" && request.method === "POST") {
        const browser = await this.authenticateBrowser(request);
        return await this.createTicket(browser);
      }
      throw new HttpError(405, "method_not_allowed");
    } catch (error) {
      return errorResponse(error);
    }
  }

  private meta(): {
    relay_id: string;
    agent_hash: string;
    generation: number;
    lease_browser_id: string | null;
    lease_expires_at: number | null;
  } | null {
    return this.ctx.storage.sql.exec<{
      relay_id: string;
      agent_hash: string;
      generation: number;
      lease_browser_id: string | null;
      lease_expires_at: number | null;
    }>(
      "SELECT relay_id, agent_hash, generation, lease_browser_id, lease_expires_at FROM relay_meta WHERE singleton = 1",
    ).toArray()[0] ?? null;
  }

  private async authenticateAgent(request: Request): Promise<AgentIdentity> {
    const tokenHash = await hashToken(bearer(request));
    const meta = this.meta();
    if (!meta || !constantTimeEqual(tokenHash, meta.agent_hash)) throw new HttpError(401, "unauthorized");
    return { generation: meta.generation };
  }

  private async authenticateBrowser(request: Request): Promise<BrowserIdentity> {
    const tokenHash = await hashToken(bearer(request));
    const rows = this.ctx.storage.sql.exec<{ id: string; credential_hash: string }>(
      "SELECT id, credential_hash FROM browsers WHERE revoked = 0",
    ).toArray();
    for (const row of rows) {
      if (constantTimeEqual(tokenHash, row.credential_hash)) return { id: row.id };
    }
    throw new HttpError(401, "unauthorized");
  }

  private requireMethod(request: Request, method: string): void {
    if (request.method !== method) throw new HttpError(405, "method_not_allowed");
  }

  private agentStart(identity: AgentIdentity): Response {
    const serverTime = Date.now();
    const generation = this.ctx.storage.transactionSync(() => {
      const meta = this.meta();
      if (!meta || meta.generation !== identity.generation) throw new HttpError(409, "stale_generation");
      this.reapJobs(serverTime);
      const next = meta.generation + 1;
      this.ctx.storage.sql.exec(
        `UPDATE jobs SET status = 'unknown', svg = NULL, error = 'agent_generation_changed', updated_at = ?
         WHERE status IN ('claimed', 'attempting', 'accepted')`,
        serverTime,
      );
      this.ctx.storage.sql.exec("UPDATE relay_meta SET generation = ? WHERE singleton = 1", next);
      this.ctx.storage.sql.exec("DELETE FROM snapshots WHERE singleton = 1");
      return next;
    });
    this.broadcast();
    return jsonResponse({ generation, serverTime });
  }

  private async agentUpdate(request: Request, identity: AgentIdentity): Promise<Response> {
    this.requireMethod(request, "POST");
    const body = requiredObject(await readJson(request));
    jsonBody(body, [
      "generation",
      "sequence",
      "connected",
      "position",
      "context",
      "observationAgeMs",
      "observedAtServer",
      "clockUncertaintyMs",
      "error",
    ]);
    const generation = body.generation;
    const sequence = body.sequence;
    const parsedGeneration = parseGeneration(generation);
    if (parsedGeneration === null || parsedGeneration !== identity.generation) throw new HttpError(409, "stale_generation");
    if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) {
      this.clearSnapshotForGeneration(parsedGeneration);
      throw new HttpError(400, "invalid_sequence");
    }

    const meta = this.meta();
    if (!meta || meta.generation !== parsedGeneration) throw new HttpError(409, "stale_generation");
    const prior = this.ctx.storage.sql.exec<{ sequence: number }>(
      "SELECT sequence FROM snapshots WHERE singleton = 1 AND generation = ?",
      parsedGeneration,
    ).toArray()[0];
    if (prior && (sequence as number) <= prior.sequence) throw new HttpError(409, "stale_sequence");

    let connected = body.connected === true;
    let position = parsePoint(body.position);
    let context = parseContext(body.context);
    const age = body.observationAgeMs;
    const validAge = typeof age === "number" && Number.isFinite(age) && age >= 0 && age <= 24 * 60 * 60_000;
    const observedAtServer = body.observedAtServer;
    const uncertainty = body.clockUncertaintyMs;
    const validClock = typeof observedAtServer === "number" && Number.isFinite(observedAtServer) && observedAtServer > 0 &&
      typeof uncertainty === "number" && Number.isFinite(uncertainty) && uncertainty >= 0 && uncertainty <= 24 * 60 * 60_000;
    const serverTime = Date.now();
    const invalidClockForLiveSample = body.connected === true &&
      (!validClock || (observedAtServer as number) > serverTime + (uncertainty as number));
    if (typeof body.connected !== "boolean" || position === undefined || context === undefined || !validAge) {
      connected = false;
      position = null;
      context = null;
    }
    if (invalidClockForLiveSample) {
      connected = false;
      position = null;
      context = null;
    }
    if (!connected) {
      position = null;
      context = null;
    }
    const receivedAt = serverTime;
    const conservativeAge = validAge && validClock
      ? Math.max(age, Math.max(0, receivedAt - (observedAtServer as number) + (uncertainty as number)))
      : validAge ? age : 0;
    const snapshot: Snapshot = {
      generation: parsedGeneration,
      sequence: sequence as number,
      connected,
      position: position ?? null,
      context: context ?? null,
      observationAgeMs: conservativeAge,
      receivedAt,
    };
    let pairings: Array<{ id: string; phrase: string }> = [];
    let claimed: null | {
      id: string;
      svg: string;
      checksum: string;
      filename: string;
      anchor: { x: number; y: number };
      contextRevision: string;
      expiresAt: number;
      status: "claimed";
    } = null;
    this.ctx.storage.transactionSync(() => {
      const currentMeta = this.meta();
      if (!currentMeta || currentMeta.generation !== parsedGeneration) throw new HttpError(409, "stale_generation");
      this.ctx.storage.sql.exec(
        `INSERT INTO snapshots (singleton, generation, sequence, payload) VALUES (1, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation,
           sequence = excluded.sequence, payload = excluded.payload`,
        parsedGeneration,
        sequence,
        JSON.stringify(snapshot),
      );
      this.reapJobs(receivedAt);
      pairings = this.ctx.storage.sql.exec<{ id: string; phrase: string }>(
        "SELECT id, phrase FROM pairings WHERE status = 'pending' AND expires_at > ? ORDER BY created_at LIMIT 20",
        receivedAt,
      ).toArray();
      claimed = null;
      const fresh = snapshot.connected && snapshot.position !== null && snapshot.context !== null &&
        snapshot.observationAgeMs + (Date.now() - snapshot.receivedAt) <= SNAPSHOT_MAX_AGE_MS;
      const active = this.ctx.storage.sql.exec<{ id: string }>(
        "SELECT id FROM jobs WHERE status IN ('claimed', 'attempting', 'accepted') LIMIT 1",
      ).toArray()[0];
      if (fresh && !active) {
        const job = this.ctx.storage.sql.exec<StoredJob>(
          "SELECT * FROM jobs WHERE status = 'queued' AND expires_at > ? ORDER BY created_at LIMIT 1",
          receivedAt,
        ).toArray()[0];
        if (job && job.context_revision === snapshot.context?.revision && job.svg !== null) {
          this.ctx.storage.sql.exec(
            "UPDATE jobs SET status = 'claimed', generation = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
            parsedGeneration,
            receivedAt,
            job.id,
          );
          claimed = {
            id: job.id,
            svg: job.svg,
            checksum: job.checksum,
            filename: job.filename,
            anchor: JSON.parse(job.anchor) as { x: number; y: number },
            contextRevision: job.context_revision,
            expiresAt: job.expires_at,
            status: "claimed",
          };
        }
      }
    });
    this.broadcast();
    if (invalidClockForLiveSample) throw new HttpError(400, "invalid_clock_calibration");
    return jsonResponse({ serverTime: receivedAt, pairings, job: claimed });
  }

  private clearSnapshotForGeneration(generation: number): void {
    this.ctx.storage.transactionSync(() => {
      const meta = this.meta();
      if (meta && meta.generation === generation) this.ctx.storage.sql.exec("DELETE FROM snapshots WHERE singleton = 1");
    });
  }

  private async pairingNew(request: Request): Promise<Response> {
    this.requireMethod(request, "POST");
    const body = requiredObject(await readJson(request));
    jsonBody(body, []);
    const invitation = randomToken();
    const tokenHash = await hashToken(invitation);
    const now = Date.now();
    const expiresAt = now + PAIRING_LIFETIME_MS;
    const created = this.ctx.storage.transactionSync(() => {
      this.reapPairings(now);
      const count = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM invitations WHERE used = 0 AND expires_at > ?",
        now,
      ).one().count;
      if (count >= 10) throw new HttpError(429, "too_many_invitations");
      this.ctx.storage.sql.exec(
        "INSERT INTO invitations (token_hash, expires_at, created_at, used) VALUES (?, ?, ?, 0)",
        tokenHash,
        expiresAt,
        now,
      );
      return true;
    });
    if (!created) throw new HttpError(500, "internal_error");
    return jsonResponse({ invitation, expiresAt });
  }

  private async pairingRequest(request: Request): Promise<Response> {
    this.requireMethod(request, "POST");
    requireAllowedOrigin(request);
    const body = requiredObject(await readJson(request));
    jsonBody(body, ["invitation"]);
    const invitation = body.invitation;
    if (typeof invitation !== "string" || fromBase64Url(invitation)?.byteLength !== 32) throw new HttpError(400, "invalid_request");
    const inviteHash = await hashToken(invitation);
    const pendingToken = randomToken();
    const credential = randomToken();
    const pairingId = crypto.randomUUID();
    const browserId = crypto.randomUUID();
    const phrase = randomPhrase();
    const pendingHash = await hashToken(pendingToken);
    const credentialHash = await hashToken(credential);
    const wrapped = await wrapCredential(pendingToken, credential);
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const invitationRow = this.ctx.storage.sql.exec<{ expires_at: number; used: number }>(
        "SELECT expires_at, used FROM invitations WHERE token_hash = ?",
        inviteHash,
      ).toArray()[0];
      if (!invitationRow) throw new HttpError(404, "invitation_not_found");
      if (invitationRow.expires_at <= now) throw new HttpError(410, "invitation_expired");
      if (invitationRow.used) throw new HttpError(409, "invitation_used");
      const pendingCount = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM pairings WHERE status = 'pending' AND expires_at > ?",
        now,
      ).one().count;
      if (pendingCount >= 20) throw new HttpError(429, "too_many_pairing_requests");
      this.ctx.storage.sql.exec("UPDATE invitations SET used = 1 WHERE token_hash = ?", inviteHash);
      this.ctx.storage.sql.exec(
        `INSERT INTO pairings
          (id, pending_hash, credential_hash, browser_id, wrapped_iv, wrapped_credential, phrase, status, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        pairingId,
        pendingHash,
        credentialHash,
        browserId,
        wrapped.iv,
        wrapped.ciphertext,
        phrase,
        invitationRow.expires_at,
        now,
      );
    });
    return jsonResponse({ pairingId, pendingToken, phrase });
  }

  private async pairingStatus(request: Request): Promise<Response> {
    this.requireMethod(request, "POST");
    requireAllowedOrigin(request);
    const body = requiredObject(await readJson(request));
    jsonBody(body, ["pairingId", "pendingToken"]);
    const pairingId = requireUuid(body.pairingId);
    if (typeof body.pendingToken !== "string" || fromBase64Url(body.pendingToken)?.byteLength !== 32) {
      throw new HttpError(400, "invalid_request");
    }
    const pendingHash = await hashToken(body.pendingToken);
    const now = Date.now();
    const row = this.ctx.storage.transactionSync(() => {
      const pairing = this.ctx.storage.sql.exec<{
        pending_hash: string;
        status: string;
        expires_at: number;
        wrapped_iv: string;
        wrapped_credential: string;
      }>(
        "SELECT pending_hash, status, expires_at, wrapped_iv, wrapped_credential FROM pairings WHERE id = ?",
        pairingId,
      ).toArray()[0];
      if (!pairing || !constantTimeEqual(pendingHash, pairing.pending_hash)) throw new HttpError(404, "not_found");
      if (pairing.status === "pending" && pairing.expires_at <= now) {
        this.ctx.storage.sql.exec("UPDATE pairings SET status = 'rejected' WHERE id = ?", pairingId);
        return { ...pairing, status: "rejected" };
      }
      return pairing;
    });
    if (row.status === "approved") {
      const credential = await unwrapCredential(body.pendingToken as string, row.wrapped_iv, row.wrapped_credential);
      return jsonResponse({ status: "approved", credential });
    }
    if (row.status === "rejected") return jsonResponse({ status: "rejected" });
    return jsonResponse({ status: "pending" });
  }

  private async pairingDecide(request: Request): Promise<Response> {
    this.requireMethod(request, "POST");
    const body = requiredObject(await readJson(request));
    jsonBody(body, ["pairingId", "approve"]);
    const pairingId = requireUuid(body.pairingId);
    if (typeof body.approve !== "boolean") throw new HttpError(400, "invalid_request");
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const pairing = this.ctx.storage.sql.exec<{
        browser_id: string;
        credential_hash: string;
        status: string;
        expires_at: number;
      }>(
        "SELECT browser_id, credential_hash, status, expires_at FROM pairings WHERE id = ?",
        pairingId,
      ).toArray()[0];
      if (!pairing) throw new HttpError(404, "not_found");
      if (pairing.status !== "pending") {
        if ((body.approve && pairing.status === "approved") || (!body.approve && pairing.status === "rejected")) return;
        throw new HttpError(409, "pairing_already_decided");
      }
      if (pairing.expires_at <= now) {
        this.ctx.storage.sql.exec("UPDATE pairings SET status = 'rejected' WHERE id = ?", pairingId);
        throw new HttpError(410, "pairing_expired");
      }
      if (body.approve) {
        this.ctx.storage.sql.exec(
          "INSERT INTO browsers (id, credential_hash, created_at, revoked) VALUES (?, ?, ?, 0)",
          pairing.browser_id,
          pairing.credential_hash,
          now,
        );
      }
      this.ctx.storage.sql.exec("UPDATE pairings SET status = ? WHERE id = ?", body.approve ? "approved" : "rejected", pairingId);
    });
    return jsonResponse({});
  }

  private async browserLaunchNew(request: Request): Promise<Response> {
    this.requireMethod(request, "POST");
    const body = requiredObject(await readJson(request));
    jsonBody(body, []);
    const launchToken = randomToken();
    const tokenHash = await hashToken(launchToken);
    const now = Date.now();
    const expiresAt = now + LAUNCH_TOKEN_LIFETIME_MS;
    this.ctx.storage.transactionSync(() => {
      this.reapLaunches(now);
      const outstanding = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM browser_launches WHERE used = 0 AND expires_at > ?",
        now,
      ).one().count;
      if (outstanding >= LAUNCH_OUTSTANDING_LIMIT) throw new HttpError(429, "too_many_launch_tokens");
      const recent = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM browser_launches WHERE created_at > ?",
        now - LAUNCH_RATE_WINDOW_MS,
      ).one().count;
      if (recent >= LAUNCH_RATE_LIMIT) throw new HttpError(429, "launch_rate_limited");
      this.ctx.storage.sql.exec(
        "INSERT INTO browser_launches (token_hash, expires_at, created_at, used) VALUES (?, ?, ?, 0)",
        tokenHash,
        expiresAt,
        now,
      );
    });
    return jsonResponse({ launchToken, expiresAt });
  }

  private async browserLaunch(request: Request): Promise<Response> {
    this.requireMethod(request, "POST");
    requireAllowedOrigin(request);
    const body = requiredObject(await readJson(request));
    jsonBody(body, ["launchToken", "credential"]);
    const launchToken = requireToken(body.launchToken);
    const supplied = body.credential === undefined ? null : requireToken(body.credential);
    const tokenHash = await hashToken(launchToken);
    const suppliedHash = supplied === null ? null : await hashToken(supplied);
    const minted = randomToken();
    const mintedHash = await hashToken(minted);
    const mintedId = crypto.randomUUID();
    const now = Date.now();
    const reused = this.ctx.storage.transactionSync((): boolean => {
      const launch = this.ctx.storage.sql.exec<{ expires_at: number; used: number }>(
        "SELECT expires_at, used FROM browser_launches WHERE token_hash = ?",
        tokenHash,
      ).toArray()[0];
      if (!launch) throw new HttpError(404, "launch_token_not_found");
      if (launch.used) throw new HttpError(409, "launch_token_used");
      if (launch.expires_at <= now) throw new HttpError(410, "launch_token_expired");
      this.ctx.storage.sql.exec("UPDATE browser_launches SET used = 1 WHERE token_hash = ? AND used = 0", tokenHash);
      if (suppliedHash !== null) {
        const rows = this.ctx.storage.sql.exec<{ credential_hash: string }>(
          "SELECT credential_hash FROM browsers WHERE revoked = 0",
        ).toArray();
        let valid = false;
        for (const row of rows) valid = constantTimeEqual(suppliedHash, row.credential_hash) || valid;
        if (valid) return true;
      }
      const launchBrowsers = this.ctx.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM launch_browsers
         JOIN browsers ON browsers.id = launch_browsers.browser_id WHERE browsers.revoked = 0`,
      ).one().count;
      if (launchBrowsers >= LAUNCH_BROWSER_LIMIT) throw new HttpError(429, "too_many_launch_browsers");
      this.ctx.storage.sql.exec(
        "INSERT INTO browsers (id, credential_hash, created_at, revoked) VALUES (?, ?, ?, 0)",
        mintedId,
        mintedHash,
        now,
      );
      this.ctx.storage.sql.exec("INSERT INTO launch_browsers (browser_id, created_at) VALUES (?, ?)", mintedId, now);
      return false;
    });
    return jsonResponse({ credential: reused ? supplied : minted });
  }

  private reapLaunches(now: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM browser_launches WHERE expires_at <= ? AND created_at <= ?",
      now,
      now - LAUNCH_RATE_WINDOW_MS,
    );
  }

  private listBrowsers(): Response {
    const browsers = this.ctx.storage.sql.exec<{ id: string }>(
      "SELECT id FROM browsers WHERE revoked = 0 ORDER BY created_at",
    ).toArray();
    return jsonResponse({ browsers });
  }

  private async revokeBrowser(request: Request): Promise<Response> {
    this.requireMethod(request, "POST");
    const body = requiredObject(await readJson(request));
    jsonBody(body, ["browserId"]);
    const browserId = requireUuid(body.browserId);
    const revoked = this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<{ id: string }>(
        "SELECT id FROM browsers WHERE id = ? AND revoked = 0",
        browserId,
      ).toArray()[0];
      if (!row) return false;
      this.ctx.storage.sql.exec("UPDATE browsers SET revoked = 1 WHERE id = ?", browserId);
      this.ctx.storage.sql.exec("DELETE FROM tickets WHERE browser_id = ?", browserId);
      this.ctx.storage.sql.exec("DELETE FROM launch_browsers WHERE browser_id = ?", browserId);
      this.ctx.storage.sql.exec(
        "UPDATE relay_meta SET lease_browser_id = NULL, lease_expires_at = NULL WHERE lease_browser_id = ?",
        browserId,
      );
      return true;
    });
    if (!revoked) throw new HttpError(404, "browser_not_found");
    for (const socket of this.ctx.getWebSockets()) {
      const attachment: unknown = socket.deserializeAttachment();
      if (isObject(attachment) && attachment.browserId === browserId) socket.close(1008, "revoked");
    }
    this.broadcast();
    return jsonResponse({});
  }

  private browserSnapshot(browser: BrowserIdentity): Response {
    const now = Date.now();
    return jsonResponse(this.snapshotEnvelope(browser.id, now, true));
  }

  private snapshotEnvelope(browserId: string, serverTime: number, renewLease: boolean): {
    serverTime: number;
    snapshot: Snapshot | null;
    activeBrowser: boolean;
    controlOccupied: boolean;
    job: JobResult | null;
  } {
    return this.ctx.storage.transactionSync(() => {
      this.reapJobs(serverTime);
      const meta = this.meta();
      if (!meta) throw new HttpError(404, "not_found");
      const ownsLiveLease = meta.lease_browser_id === browserId && (meta.lease_expires_at ?? 0) > serverTime;
      if (ownsLiveLease && renewLease) {
        this.ctx.storage.sql.exec(
          "UPDATE relay_meta SET lease_expires_at = ? WHERE singleton = 1 AND lease_browser_id = ?",
          serverTime + BROWSER_LEASE_MS,
          browserId,
        );
      } else if ((meta.lease_expires_at ?? 0) <= serverTime) {
        this.ctx.storage.sql.exec(
          "UPDATE relay_meta SET lease_browser_id = NULL, lease_expires_at = NULL WHERE singleton = 1 AND lease_expires_at <= ?",
          serverTime,
        );
      }
      const latest = this.ctx.storage.sql.exec<StoredJob>(
        "SELECT * FROM jobs WHERE browser_id = ? ORDER BY created_at DESC LIMIT 1",
        browserId,
      ).toArray()[0];
      const controlOccupied = !ownsLiveLease && meta.lease_browser_id !== null && meta.lease_browser_id !== browserId &&
        (meta.lease_expires_at ?? 0) > serverTime;
      return {
        serverTime,
        snapshot: currentSnapshot(this.ctx.storage.sql),
        activeBrowser: ownsLiveLease,
        controlOccupied,
        job: latest ? jobResult(latest, this.isResolved(latest.id)) : null,
      };
    });
  }

  private isResolved(jobId: string): boolean {
    return this.ctx.storage.sql.exec<{ job_id: string }>(
      "SELECT job_id FROM job_resolutions WHERE job_id = ?",
      jobId,
    ).toArray().length > 0;
  }

  // Jobs of other browsers that must finish or be acknowledged before control can move.
  private hasBlockingJobs(browserId: string): boolean {
    return this.ctx.storage.sql.exec<{ id: string }>(
      `SELECT jobs.id FROM jobs
       LEFT JOIN job_resolutions ON job_resolutions.job_id = jobs.id
       LEFT JOIN browsers ON browsers.id = jobs.browser_id
       WHERE jobs.browser_id != ? AND (
         jobs.status IN ('queued', 'claimed', 'attempting', 'accepted') OR
         (jobs.status = 'unknown' AND job_resolutions.job_id IS NULL AND COALESCE(browsers.revoked, 1) = 0)
       ) LIMIT 1`,
      browserId,
    ).toArray().length > 0;
  }

  private async browserControl(request: Request, browser: BrowserIdentity): Promise<Response> {
    this.requireMethod(request, "POST");
    const body = requiredObject(await readJson(request));
    jsonBody(body, ["takeover"]);
    if (body.takeover !== undefined && typeof body.takeover !== "boolean") throw new HttpError(400, "invalid_request");
    const takeover = body.takeover === true;
    const now = Date.now();
    const changed = this.ctx.storage.transactionSync((): boolean => {
      this.reapJobs(now);
      const meta = this.meta();
      if (!meta) throw new HttpError(404, "not_found");
      const ownsLiveLease = meta.lease_browser_id === browser.id && (meta.lease_expires_at ?? 0) > now;
      const occupied = !ownsLiveLease && meta.lease_browser_id !== null && (meta.lease_expires_at ?? 0) > now;
      if (occupied && !takeover) throw new HttpError(409, "browser_lease_occupied");
      if (!ownsLiveLease && this.hasBlockingJobs(browser.id)) throw new HttpError(409, "unresolved_imports");
      this.ctx.storage.sql.exec(
        "UPDATE relay_meta SET lease_browser_id = ?, lease_expires_at = ? WHERE singleton = 1",
        browser.id,
        now + BROWSER_LEASE_MS,
      );
      return !ownsLiveLease;
    });
    if (changed) this.broadcast();
    return jsonResponse({ activeBrowser: true });
  }

  private async resolveJob(request: Request, id: string, browser: BrowserIdentity): Promise<Response> {
    this.requireMethod(request, "POST");
    const body = requiredObject(await readJson(request));
    jsonBody(body, []);
    const now = Date.now();
    const result = this.ctx.storage.transactionSync((): JobResult => {
      this.reapJobs(now);
      const job = this.ctx.storage.sql.exec<StoredJob>(
        "SELECT * FROM jobs WHERE id = ? AND browser_id = ?",
        id,
        browser.id,
      ).toArray()[0];
      if (!job) throw new HttpError(404, "not_found");
      if (job.status !== "unknown") throw new HttpError(409, "job_not_unknown");
      this.ctx.storage.sql.exec(
        "INSERT INTO job_resolutions (job_id, resolved_at) VALUES (?, ?) ON CONFLICT(job_id) DO NOTHING",
        id,
        now,
      );
      return jobResult(job, true);
    });
    this.broadcast();
    return jsonResponse(result);
  }

  private releaseControl(browser: BrowserIdentity): Response {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE relay_meta SET lease_browser_id = NULL, lease_expires_at = NULL WHERE singleton = 1 AND lease_browser_id = ?",
        browser.id,
      );
    });
    return jsonResponse({});
  }

  private async createJob(request: Request, browser: BrowserIdentity): Promise<Response> {
    this.requireMethod(request, "POST");
    const body = requiredObject(await readJson(request, MAX_JOB_JSON_BYTES));
    jsonBody(body, ["id", "svg", "checksum", "filename", "anchor", "contextRevision"]);
    const id = requireUuid(body.id);
    if (typeof body.svg !== "string" || !validSvg(body.svg)) throw new HttpError(400, "invalid_svg");
    const svgBytes = encoder.encode(body.svg);
    if (svgBytes.byteLength > MAX_SVG_BYTES) throw new HttpError(413, "svg_too_large");
    if (typeof body.checksum !== "string" || !/^[0-9a-f]{64}$/u.test(body.checksum)) throw new HttpError(400, "invalid_checksum");
    const checksum = toHex(await sha256(svgBytes));
    if (!constantTimeEqual(checksum, body.checksum)) throw new HttpError(400, "checksum_mismatch");
    if (typeof body.filename !== "string" || body.filename.length > 100 ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.svg$/u.test(body.filename) || body.filename.includes("..")) {
      throw new HttpError(400, "invalid_filename");
    }
    const anchor = parsePoint(body.anchor);
    if (!anchor) throw new HttpError(400, "invalid_anchor");
    if (!isRevision(body.contextRevision)) throw new HttpError(400, "invalid_context_revision");
    const now = Date.now();
    const result = this.ctx.storage.transactionSync((): JobResult => {
      this.reapJobs(now);
      const existing = this.ctx.storage.sql.exec<StoredJob>("SELECT * FROM jobs WHERE id = ?", id).toArray()[0];
      if (existing) {
        if (existing.browser_id !== browser.id) throw new HttpError(404, "not_found");
        if (!constantTimeEqual(existing.checksum, checksum)) throw new HttpError(409, "job_id_conflict");
        return jobResult(existing, this.isResolved(existing.id));
      }
      const meta = this.meta();
      if (!meta || meta.lease_browser_id !== browser.id || (meta.lease_expires_at ?? 0) <= now) {
        throw new HttpError(409, "active_browser_required");
      }
      const snapshot = currentSnapshot(this.ctx.storage.sql);
      if (!snapshot || !snapshot.connected || !snapshot.position || !snapshot.context ||
          snapshot.context.revision !== body.contextRevision ||
          snapshot.observationAgeMs + (now - snapshot.receivedAt) > SNAPSHOT_MAX_AGE_MS) {
        throw new HttpError(409, "fresh_matching_context_required");
      }
      const active = this.ctx.storage.sql.exec<{ id: string }>(
        "SELECT id FROM jobs WHERE status IN ('claimed', 'attempting', 'accepted') LIMIT 1",
      ).toArray()[0];
      if (active) throw new HttpError(409, "import_in_progress");
      const pending = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM jobs WHERE svg IS NOT NULL",
      ).one().count;
      if (pending >= PENDING_JOB_LIMIT) throw new HttpError(429, "pending_job_limit_reached");
      const retained = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM jobs WHERE created_at > ?",
        now - JOB_RETENTION_MS,
      ).one().count;
      if (retained >= JOB_LIMIT) throw new HttpError(429, "job_limit_reached");
      this.ctx.storage.sql.exec(
        `INSERT INTO jobs
          (id, svg, checksum, filename, anchor, context_revision, expires_at, status, error, browser_id, generation, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, NULL, ?, ?)`,
        id,
        body.svg,
        checksum,
        body.filename,
        JSON.stringify(anchor),
        body.contextRevision,
        now + JOB_LIFETIME_MS,
        browser.id,
        now,
        now,
      );
      return { id, status: "queued" };
    });
    return jsonResponse(result);
  }

  private getBrowserJob(id: string, browser: BrowserIdentity): Response {
    const now = Date.now();
    const job = this.ctx.storage.transactionSync(() => {
      this.reapJobs(now);
      return this.ctx.storage.sql.exec<StoredJob>(
        "SELECT * FROM jobs WHERE id = ? AND browser_id = ?",
        id,
        browser.id,
      ).toArray()[0] ?? null;
    });
    if (!job) throw new HttpError(404, "not_found");
    return jsonResponse(jobResult(job, this.isResolved(job.id)));
  }

  private async agentJobStatus(request: Request, id: string, identity: AgentIdentity): Promise<Response> {
    this.requireMethod(request, "POST");
    const body = requiredObject(await readJson(request));
    jsonBody(body, ["generation", "status", "error"]);
    const generation = parseGeneration(body.generation);
    if (generation === null || generation !== identity.generation) {
      throw new HttpError(409, "stale_generation");
    }
    const requested = body.status;
    const allowed = ["attempting", "accepted", "confirmed", "failed", "unknown"] as const;
    if (typeof requested !== "string" || !allowed.includes(requested as typeof allowed[number])) {
      throw new HttpError(400, "invalid_status");
    }
    const error = typeof body.error === "string" ? body.error.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 200) : undefined;
    const now = Date.now();
    const result = this.ctx.storage.transactionSync(() => {
      this.reapJobs(now);
      const job = this.ctx.storage.sql.exec<StoredJob>("SELECT * FROM jobs WHERE id = ?", id).toArray()[0];
      if (!job) throw new HttpError(404, "job_not_found");
      if (job.generation !== generation) throw new HttpError(409, "stale_generation");
      if (["confirmed", "failed", "unknown", "expired"].includes(job.status)) {
        if (job.status === requested) return jobResult(job);
        throw new HttpError(409, "job_already_terminal");
      }
      const transitions: Record<string, readonly string[]> = {
        claimed: ["attempting", "failed", "unknown"],
        attempting: ["accepted", "confirmed", "failed", "unknown"],
        accepted: ["confirmed", "failed", "unknown"],
      };
      if (job.status === requested) return jobResult(job);
      if (!transitions[job.status]?.includes(requested)) throw new HttpError(409, "invalid_job_transition");
      const isTerminal = ["confirmed", "failed", "unknown"].includes(requested);
      this.ctx.storage.sql.exec(
        "UPDATE jobs SET status = ?, error = ?, svg = ?, updated_at = ? WHERE id = ?",
        requested,
        error || null,
        isTerminal ? null : job.svg,
        now,
        id,
      );
      return error ? { id, status: requested as JobStatus, error } : { id, status: requested as JobStatus };
    });
    return jsonResponse(result);
  }

  private reapJobs(now: number): void {
    this.ctx.storage.sql.exec(
      `UPDATE jobs SET status = 'expired', svg = NULL, error = 'expired', updated_at = ?
       WHERE status = 'queued' AND expires_at <= ?`,
      now,
      now,
    );
    this.ctx.storage.sql.exec(
      `UPDATE jobs SET status = 'expired', svg = NULL, error = 'expired', updated_at = ?
       WHERE status = 'claimed' AND expires_at <= ?`,
      now,
      now,
    );
    this.ctx.storage.sql.exec("DELETE FROM jobs WHERE created_at <= ?", now - JOB_RETENTION_MS);
    this.ctx.storage.sql.exec("DELETE FROM job_resolutions WHERE job_id NOT IN (SELECT id FROM jobs)");
    this.ctx.storage.sql.exec("DELETE FROM tickets WHERE expires_at <= ?", now);
  }

  private reapPairings(now: number): void {
    this.ctx.storage.sql.exec(
      "UPDATE pairings SET status = 'rejected' WHERE status = 'pending' AND expires_at <= ?",
      now,
    );
    this.ctx.storage.sql.exec("DELETE FROM invitations WHERE expires_at <= ?", now);
    this.ctx.storage.sql.exec("DELETE FROM pairings WHERE expires_at <= ?", now - JOB_RETENTION_MS);
  }

  private async createTicket(browser: BrowserIdentity): Promise<Response> {
    const ticket = randomToken();
    const hash = await hashToken(ticket);
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.reapJobs(now);
      this.ctx.storage.sql.exec(
        "INSERT INTO tickets (ticket_hash, browser_id, expires_at) VALUES (?, ?, ?)",
        hash,
        browser.id,
        now + 30_000,
      );
      const sockets = this.ctx.getWebSockets().filter((socket) => {
        const attachment: unknown = socket.deserializeAttachment();
        return isObject(attachment) && attachment.browserId === browser.id;
      });
      if (sockets.length >= 4) throw new HttpError(429, "too_many_streams");
    });
    return jsonResponse({ ticket });
  }

  private async stream(request: Request): Promise<Response> {
    requireAllowedOrigin(request);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      throw new HttpError(426, "websocket_upgrade_required");
    }
    const ticket = new URL(request.url).searchParams.get("ticket");
    if (!ticket || fromBase64Url(ticket)?.byteLength !== 32) throw new HttpError(401, "unauthorized");
    const hash = await hashToken(ticket);
    const now = Date.now();
    const browserId = this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<{ browser_id: string; expires_at: number }>(
        `SELECT tickets.browser_id, tickets.expires_at FROM tickets
         JOIN browsers ON browsers.id = tickets.browser_id
         WHERE tickets.ticket_hash = ? AND browsers.revoked = 0`,
        hash,
      ).toArray()[0];
      this.ctx.storage.sql.exec("DELETE FROM tickets WHERE ticket_hash = ?", hash);
      if (!row || row.expires_at <= now) throw new HttpError(401, "unauthorized");
      return row.browser_id;
    });
    const socketCount = this.ctx.getWebSockets().length;
    if (socketCount >= 8) throw new HttpError(429, "too_many_streams");
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ browserId });
    const envelope = this.snapshotEnvelope(browserId, now, true);
    server.send(JSON.stringify(envelope));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const text = typeof message === "string" ? message : "";
    if (text === "ping") {
      try {
        socket.send("pong");
      } catch {
        socket.close(1011, "send_failed");
      }
    }
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // Socket is already closed.
    }
  }

  webSocketError(socket: WebSocket): void {
    try {
      socket.close(1011, "stream_error");
    } catch {
      // Socket is already closed.
    }
  }

  private broadcast(): void {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    const active = new Set(this.ctx.storage.sql.exec<{ id: string }>(
      "SELECT id FROM browsers WHERE revoked = 0",
    ).toArray().map((row) => row.id));
    for (const socket of sockets) {
      const attachment: unknown = socket.deserializeAttachment();
      if (!isObject(attachment) || typeof attachment.browserId !== "string" || !active.has(attachment.browserId)) {
        socket.close(1008, "revoked");
        continue;
      }
      try {
        socket.send(JSON.stringify(this.snapshotEnvelope(attachment.browserId, Date.now(), true)));
      } catch {
        socket.close(1011, "send_failed");
      }
    }
  }
}

function corsResponse(response: Response, origin: string | null): Response {
  if (!origin || response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Max-Age", "600");
  headers.append("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function bootstrapSecret(env: Env): string | null {
  if (!("BOOTSTRAP_TOKEN" in env) || typeof env.BOOTSTRAP_TOKEN !== "string" || env.BOOTSTRAP_TOKEN.length < 16) {
    return null;
  }
  return env.BOOTSTRAP_TOKEN;
}

async function register(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
  const body = requiredObject(await readJson(request));
  jsonBody(body, ["bootstrapToken", "name"]);
  if (typeof body.bootstrapToken !== "string" || typeof body.name !== "string" ||
      body.bootstrapToken.length < 16 || body.bootstrapToken.length > 256 ||
      body.name.trim().length < 1 || body.name.length > 64 || /[\u0000-\u001f\u007f]/u.test(body.name)) {
    throw new HttpError(400, "invalid_request");
  }
  const configured = bootstrapSecret(env);
  const suppliedHash = await hashToken(body.bootstrapToken);
  const valid = configured !== null && constantTimeEqual(suppliedHash, await hashToken(configured));
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const ipHash = toHex(await sha256(ip));
  const relayId = crypto.randomUUID();
  const invitationHash = valid ? suppliedHash : null;
  const decision = await env.CONTROL_PLANE.getByName("registration-control").consumeRegistrationAttempt(
    ipHash,
    invitationHash,
    relayId,
    Date.now(),
  );
  if (decision === "rate_limited") throw new HttpError(429, "registration_rate_limited");
  if (!configured) throw new HttpError(503, "registration_unavailable");
  if (!valid || decision === "invalid") throw new HttpError(401, "invalid_bootstrap_token");
  if (decision === "consumed") throw new HttpError(409, "bootstrap_token_used");
  const credential = randomToken();
  const name = body.name.trim();
  const initialized = await env.RELAYS.getByName(relayId).initializeRelay(relayId, name, await hashToken(credential));
  if (!initialized) throw new HttpError(503, "registration_failed");
  return jsonResponse({ relayId, credential }, 201);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin");
    if (origin && !ALLOWED_ORIGINS.has(origin)) return errorResponse(new HttpError(403, "origin_not_allowed"));
    if (request.method === "OPTIONS") {
      if (!origin) return errorResponse(new HttpError(403, "origin_not_allowed"));
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Max-Age": "600",
          "Cache-Control": "no-store",
          Vary: "Origin",
        },
      });
    }
    try {
      const url = new URL(request.url);
      let response: Response;
      if (url.pathname === "/v1/register") {
        response = await register(request, env);
      } else {
        const match = url.pathname.match(/^\/v1\/relays\/([0-9a-f-]{36})\/.*$/iu);
        if (!match) throw new HttpError(404, "not_found");
        response = await env.RELAYS.getByName(match[1].toLowerCase()).fetch(await forwardRequest(request));
      }
      return corsResponse(response, origin);
    } catch (error) {
      return corsResponse(errorResponse(error), origin);
    }
  },
} satisfies ExportedHandler<Env>;
