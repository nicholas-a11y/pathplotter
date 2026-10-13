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
const BROWSER_LEASE_MS = 45_000;
const PAIRING_LIFETIME_MS = 5 * 60_000;
const JOB_LIFETIME_MS = 60_000;
const JOB_RETENTION_MS = 24 * 60 * 60_000;
const JOB_LIMIT = 1_000;
const PENDING_JOB_LIMIT = 10;
const LAUNCH_TOKEN_LIFETIME_MS = 2 * 60_000;
const LAUNCH_OUTSTANDING_LIMIT = 5;
const LAUNCH_RATE_WINDOW_MS = 10 * 60_000;
const LAUNCH_RATE_LIMIT = 20;
const LIVENESS_MS = 45_000;
const JOB_REAP_MS = 5_000;
const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60_000;
type OperatorInvitation = { id: string; batchId: string; label: string; createdAt: number; expiresAt: number; status: "unused" | "used" | "cancelled" | "expired" };
type SocketIdentity = { role: "agent" | "browser"; browserId?: string; generation?: number; seen: number; lastMessage?: number; sequence?: number; watching?: boolean };
type Capture = { browserId: string; generation: number; revision: string | null; created: number; sequence: number; observedAt: number; status: "pending" | "complete" | "failed"; body?: unknown; error?: string };

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
  // RPC preserves Error messages, not application subclasses/properties.
  if (error instanceof Error) {
    const codes: Record<string, number> = { registration_rate_limited: 429, registration_capacity: 429, unauthorized: 401 };
    const code = Object.keys(codes).find((c) => error.message === c || error.message.endsWith(`: ${c}`));
    if (code) return jsonResponse({ error: code }, codes[code]);
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
        CREATE TABLE IF NOT EXISTS preview_leases (relay_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS registered_relays (relay_id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS operator_invitations (
          id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, label TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0
        );
      `);
      if (await ctx.storage.getAlarm() === null) await ctx.storage.setAlarm(Date.now() + 60_000);
    });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM preview_leases WHERE expires_at <= ?", now);
    this.ctx.storage.sql.exec("DELETE FROM registration_rates WHERE window_start <= ?", now - 5 * 60_000);
    this.ctx.storage.sql.exec("DELETE FROM operator_invitations WHERE expires_at <= ?", now - 30 * JOB_RETENTION_MS);
    await this.ctx.storage.setAlarm(now + 60_000);
  }

  async preview(relayId: string, wanted: boolean): Promise<boolean> {
    const now = Date.now();
    const accepted = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM preview_leases WHERE expires_at <= ? OR (relay_id = ? AND ? = 0)", now, relayId, wanted ? 1 : 0);
      if (!wanted) return false;
      const exists = this.ctx.storage.sql.exec("SELECT relay_id FROM preview_leases WHERE relay_id = ?", relayId).toArray().length > 0;
      if (!exists && this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM preview_leases").one().n >= 2) return false;
      this.ctx.storage.sql.exec("INSERT INTO preview_leases VALUES (?, ?) ON CONFLICT(relay_id) DO UPDATE SET expires_at = excluded.expires_at", relayId, now + LIVENESS_MS);
      return true;
    });
    await this.ctx.storage.setAlarm(now + 60_000);
    return accepted;
  }

  inventory(relayId: string): void {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO registered_relays VALUES (?)", relayId);
  }

  async invitationBatch(count: number, label: string): Promise<{ error: "invitation_capacity" } | { batchId: string; invitations: (OperatorInvitation & { token: string })[] }> {
    const batchId = crypto.randomUUID(), now = Date.now();
    const items = await Promise.all(Array.from({ length: count }, async () => {
      const token = randomToken();
      return { id: crypto.randomUUID(), token, hash: await hashToken(token) };
    }));
    const admitted = this.ctx.storage.transactionSync(() => {
      const active = this.ctx.storage.sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM operator_invitations WHERE cancelled=0 AND expires_at>?
         AND token_hash NOT IN (SELECT token_hash FROM consumed_invitations)`, now).one().n;
      if (active + count > 100) return false;
      for (const item of items) this.ctx.storage.sql.exec(
        "INSERT INTO operator_invitations (id,batch_id,label,token_hash,created_at,expires_at) VALUES (?,?,?,?,?,?)",
        item.id, batchId, label, item.hash, now, now + INVITATION_LIFETIME_MS);
      return true;
    });
    if (!admitted) return { error: "invitation_capacity" };
    return { batchId, invitations: items.map(({ id, token }) => ({
      id, token, batchId, label, createdAt: now, expiresAt: now + INVITATION_LIFETIME_MS, status: "unused",
    })) };
  }

  invitationList(): { invitations: OperatorInvitation[]; truncated: boolean } {
    const rows = this.ctx.storage.sql.exec<{ id: string; batch_id: string; label: string; created_at: number; expires_at: number; cancelled: number; used: number }>(
      `SELECT i.id,i.batch_id,i.label,i.created_at,i.expires_at,i.cancelled,
       EXISTS(SELECT 1 FROM consumed_invitations c WHERE c.token_hash=i.token_hash) AS used
       FROM operator_invitations i ORDER BY created_at DESC,id LIMIT 1001`).toArray();
    const now = Date.now();
    return { truncated: rows.length > 1000, invitations: rows.slice(0, 1000).map((row) => ({
      id: row.id, batchId: row.batch_id, label: row.label, createdAt: row.created_at, expiresAt: row.expires_at,
      status: row.used ? "used" : row.cancelled ? "cancelled" : row.expires_at <= now ? "expired" : "unused",
    })) };
  }

  invitationCancel(id: string): { status: "cancelled" } | { error: "invitation_not_found" | "invitation_already_used" } {
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<{ token_hash: string }>("SELECT token_hash FROM operator_invitations WHERE id=?", id).toArray()[0];
      if (!row) return { error: "invitation_not_found" };
      if (this.ctx.storage.sql.exec("SELECT token_hash FROM consumed_invitations WHERE token_hash=?", row.token_hash).toArray().length) {
        return { error: "invitation_already_used" };
      }
      this.ctx.storage.sql.exec("UPDATE operator_invitations SET cancelled=1 WHERE id=?", id);
      return { status: "cancelled" };
    });
  }

  consumeRegistrationAttempt(ipHash: string, tokenHash: string | null, relayId: string, now: number): "allowed" | "invalid" | "consumed" | "rate_limited" | "capacity" {
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
      this.ctx.storage.sql.exec("DELETE FROM registration_rates WHERE window_start < ?", now - 5 * 60_000);
      if (!tokenHash) return "invalid";
      if (!this.ctx.storage.sql.exec(
        "SELECT id FROM operator_invitations WHERE token_hash=? AND cancelled=0 AND expires_at>?", tokenHash, now).toArray().length) return "invalid";
      const consumed = this.ctx.storage.sql.exec<{ token_hash: string }>(
        "SELECT token_hash FROM consumed_invitations WHERE token_hash = ?",
        tokenHash,
      ).toArray()[0];
      if (consumed) return "consumed";
      const total = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM (SELECT relay_id FROM registered_relays UNION SELECT relay_id FROM consumed_invitations)").one().n;
      if (total >= 50) return "capacity";
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
  private transient: Snapshot | null = null;
  private sequence = 0;
  private settled = false;
  private identical = 0;
  private previewUntil = 0;
  private lastPreviewRenew = 0;
  private lastJobReap = 0;
  private agentUpdateAt = 0;
  private observedAt = 0;
  private previewEpoch = 0;
  private readonly captures = new Map<string, Capture>();
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
          lease_expires_at INTEGER,
          rap_update_required INTEGER NOT NULL DEFAULT 0
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
        CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at);
        CREATE INDEX IF NOT EXISTS pairings_created ON pairings(created_at);
        CREATE TABLE IF NOT EXISTS job_resolutions (
          job_id TEXT PRIMARY KEY,
          resolved_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS browser_launches (
          token_hash TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          used INTEGER NOT NULL DEFAULT 0,
          replace_browser_ids TEXT
        );
        CREATE INDEX IF NOT EXISTS browser_launches_created ON browser_launches(created_at);
        CREATE TABLE IF NOT EXISTS job_tombstones (id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS captures (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS captures_created ON captures(created_at);
      `);
      this.sequence = Math.max(0, ...ctx.getWebSockets().map((s) => this.attachment(s)?.sequence ?? 0));
      this.agentUpdateAt = Math.max(0, ...ctx.getWebSockets().filter((s) => this.attachment(s)?.role === "agent").map((s) => this.attachment(s)?.lastMessage ?? 0));
      for (const row of ctx.storage.sql.exec<{ id: string; payload: string }>("SELECT id,payload FROM captures WHERE created_at > ?", Date.now() - JOB_RETENTION_MS).toArray()) {
        const c = JSON.parse(row.payload) as Capture;
        if (c.status === "pending") { c.status = "failed"; c.error = "fresh_observation_required"; }
        this.captures.set(row.id, c);
      }
      if (await ctx.storage.getAlarm() === null) await ctx.storage.setAlarm(Date.now() + 60_000);
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
      if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 60_000);

      if (request.method === "POST" && route === "/pairing/request") return await this.pairingRequest(request);
      if (request.method === "POST" && route === "/pairing/status") return await this.pairingStatus(request);
      if (request.method === "POST" && route === "/browser/launch") return await this.browserLaunch(request);
      if (request.method === "GET" && route === "/stream") return await this.stream(request);

      if (route.startsWith("/agent/")) {
        const identity = await this.authenticateAgent(request);
        if (request.method === "GET" && route === "/agent/stream") return await this.agentStream(request, identity);
        if (request.method === "POST" && route === "/agent/start") return await this.agentStart(request, identity);
        if (request.method === "POST" && route === "/agent/browser-launch") return await this.browserLaunchNew(request);
        if (request.method === "POST" && route === "/agent/pairing/new") return await this.pairingNew(request);
        if (request.method === "POST" && route === "/agent/pairing/decide") return await this.pairingDecide(request);
        if (request.method === "GET" && route === "/agent/browsers") return this.listBrowsers();
        if (request.method === "POST" && route === "/agent/browsers/revoke") return await this.revokeBrowser(request);
        const agentStatus = route.match(/^\/agent\/jobs\/([0-9a-f-]{36})\/status$/iu);
        if (request.method === "POST" && agentStatus) return await this.agentJobStatus(request, agentStatus[1].toLowerCase(), identity);
        throw new HttpError(404, "not_found");
      }

      if (route === "/capture" && request.method === "POST") return await this.captureNew(request, await this.authenticateBrowser(request));
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
    rap_update_required: number;
  } | null {
    return this.ctx.storage.sql.exec<{
      relay_id: string;
      agent_hash: string;
      generation: number;
      lease_browser_id: string | null;
      lease_expires_at: number | null;
      rap_update_required: number;
    }>(
      "SELECT relay_id, agent_hash, generation, lease_browser_id, lease_expires_at, rap_update_required FROM relay_meta WHERE singleton = 1",
    ).toArray()[0] ?? null;
  }

  private async authenticateAgent(request: Request): Promise<AgentIdentity> {
    const tokenHash = await hashToken(bearer(request));
    const meta = this.meta();
    if (!meta || !constantTimeEqual(tokenHash, meta.agent_hash)) throw new HttpError(401, "unauthorized");
    return { generation: meta.generation };
  }

  private async authenticateBrowser(request: Request): Promise<BrowserIdentity> {
    requireAllowedOrigin(request);
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

  private async agentStart(request: Request, identity: AgentIdentity): Promise<Response> {
    const body = requiredObject(await readJson(request));
    jsonBody(body, ["version"]);
    const minimum = envString(this.env, "MIN_RAP_VERSION");
    if (minimum && compareVersions(body.version, minimum) < 0) {
      if (this.meta()?.rap_update_required !== 1) {
        this.ctx.storage.sql.exec("UPDATE relay_meta SET rap_update_required = 1 WHERE singleton = 1");
        this.broadcast();
      }
      return jsonResponse({ error: "rap_update_required", minimumVersion: minimum }, 426);
    }
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
      this.ctx.storage.sql.exec("UPDATE relay_meta SET generation = ?, rap_update_required = 0 WHERE singleton = 1", next);
      return next;
    });
    this.transient = null;
    this.sequence = 0;
    this.agentUpdateAt = 0;
    this.settled = false;
    for (const socket of this.ctx.getWebSockets()) {
      const a = this.attachment(socket);
      if (a?.role === "agent") socket.close(1008, "stale_generation");
    }
    this.failCaptures("stale_generation", () => true);
    this.broadcast();
    return jsonResponse({ generation, serverTime });
  }

  private async agentUpdate(request: Request, identity: AgentIdentity, deliverWork = true): Promise<Response> {
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
      "settled",
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
    if ((sequence as number) <= this.sequence) throw new HttpError(409, "stale_sequence");

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
      const same = this.transient?.connected === snapshot.connected && JSON.stringify(this.transient.position) === JSON.stringify(snapshot.position) && this.transient.context?.revision === snapshot.context?.revision;
      this.identical = same ? this.identical + (typeof observedAtServer === "number" && observedAtServer > this.observedAt ? 1 : 0) : 1;
      if (typeof observedAtServer === "number") this.observedAt = observedAtServer;
      this.settled = connected && (body.settled === true || (body.settled === undefined && this.identical >= 3));
      this.transient = snapshot;
      this.sequence = snapshot.sequence;
      if (receivedAt - this.lastJobReap >= JOB_REAP_MS) { this.reapJobs(receivedAt); this.lastJobReap = receivedAt; }
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
      if (deliverWork && fresh && !active) {
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
    for (const socket of this.ctx.getWebSockets()) {
      const a = this.attachment(socket);
      if (a?.role === "agent" && a.generation === parsedGeneration) { a.sequence = snapshot.sequence; socket.serializeAttachment(a); }
    }
    if (deliverWork) this.broadcast();
    if (invalidClockForLiveSample) throw new HttpError(400, "invalid_clock_calibration");
    return jsonResponse({ serverTime: receivedAt, pairings, job: claimed, previewActive: this.previewUntil > receivedAt, captures: [...this.captures.entries()].filter(([, c]) => c.status === "pending" && c.generation === parsedGeneration && receivedAt - c.created < 10_000).map(([id]) => id) });
  }

  private clearSnapshotForGeneration(generation: number): void {
    this.ctx.storage.transactionSync(() => {
      const meta = this.meta();
      if (meta && meta.generation === generation) { this.transient = null; this.settled = false; }
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
    this.notifyWork();
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
    jsonBody(body, ["pairingId", "approve", "replaceBrowserIds"]);
    const replacing = this.replacementIds(body.replaceBrowserIds);
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
        this.replaceBrowsers(replacing);
        this.ctx.storage.sql.exec(
          "INSERT INTO browsers (id, credential_hash, created_at, revoked) VALUES (?, ?, ?, 0)",
          pairing.browser_id,
          pairing.credential_hash,
          now,
        );
      }
      this.ctx.storage.sql.exec("UPDATE pairings SET status = ? WHERE id = ?", body.approve ? "approved" : "rejected", pairingId);
    });
    this.closeRevokedBrowsers();
    this.notifyWork();
    return jsonResponse({});
  }

  private async browserLaunchNew(request: Request): Promise<Response> {
    this.requireMethod(request, "POST");
    const body = requiredObject(await readJson(request));
    jsonBody(body, ["replaceBrowserIds"]);
    const replacing = this.replacementIds(body.replaceBrowserIds);
    const launchToken = randomToken();
    const tokenHash = await hashToken(launchToken);
    const now = Date.now();
    const expiresAt = now + LAUNCH_TOKEN_LIFETIME_MS;
    this.ctx.storage.transactionSync(() => {
      this.reapLaunches(now);
      if (replacing !== null) this.checkReplacement(replacing);
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
        "INSERT INTO browser_launches (token_hash, expires_at, created_at, used, replace_browser_ids) VALUES (?, ?, ?, 0, ?)",
        tokenHash,
        expiresAt,
        now,
        replacing === null ? null : JSON.stringify(replacing),
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
      const launch = this.ctx.storage.sql.exec<{ expires_at: number; used: number; replace_browser_ids: string | null }>(
        "SELECT expires_at, used,replace_browser_ids FROM browser_launches WHERE token_hash = ?",
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
      this.replaceBrowsers(launch.replace_browser_ids === null ? null : this.replacementIds(JSON.parse(launch.replace_browser_ids)));
      this.ctx.storage.sql.exec(
        "INSERT INTO browsers (id, credential_hash, created_at, revoked) VALUES (?, ?, ?, 0)",
        mintedId,
        mintedHash,
        now,
      );
      return false;
    });
    this.closeRevokedBrowsers();
    return jsonResponse({ credential: reused ? supplied : minted });
  }

  private replacementIds(value: unknown): string[] | null {
    if (value === undefined) return null;
    if (!Array.isArray(value) || value.length > 50) throw new HttpError(400, "invalid_request");
    const ids = value.map(requireUuid);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, "invalid_request");
    return ids.sort();
  }

  private checkReplacement(expected: string[] | null): string[] {
    const current = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM browsers WHERE revoked=0 ORDER BY id").toArray().map((row) => row.id);
    if (current.length && expected === null) throw new HttpError(409, "browser_replacement_required");
    if (expected !== null && JSON.stringify(current) !== JSON.stringify(expected)) throw new HttpError(409, "browser_changed");
    this.reapJobs(Date.now());
    if (current.length && this.hasBlockingJobs("")) throw new HttpError(409, "unresolved_imports");
    return current;
  }

  private replaceBrowsers(expected: string[] | null): void {
    for (const id of this.checkReplacement(expected)) this.revokeBrowserState(id);
    this.ctx.storage.sql.exec("UPDATE browser_launches SET used=1 WHERE used=0");
  }

  private revokeBrowserState(id: string): void {
    this.ctx.storage.sql.exec("UPDATE browsers SET revoked=1 WHERE id=?", id);
    this.ctx.storage.sql.exec("DELETE FROM tickets WHERE browser_id=?", id);
    this.ctx.storage.sql.exec("UPDATE relay_meta SET lease_browser_id=NULL,lease_expires_at=NULL WHERE lease_browser_id=?", id);
  }

  private closeRevokedBrowsers(): void {
    const active = new Set(this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM browsers WHERE revoked=0").toArray().map((row) => row.id));
    this.failCaptures("revoked", (capture) => !active.has(capture.browserId));
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.attachment(socket);
      if (attachment?.role === "browser" && attachment.browserId &&
          !active.has(attachment.browserId)) {
        socket.close(1008, "revoked");
      }
    }
    this.broadcast();
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
      this.revokeBrowserState(browserId);
      return true;
    });
    if (!revoked) throw new HttpError(404, "browser_not_found");
    this.failCaptures("revoked", (c) => c.browserId === browserId);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment: unknown = socket.deserializeAttachment();
      if (isObject(attachment) && attachment.browserId === browserId) socket.close(1008, "revoked");
    }
    this.broadcast();
    return jsonResponse({});
  }

  private snapshotEnvelope(browserId: string, serverTime: number, renewLease: boolean): {
    serverTime: number;
    snapshot: Snapshot | null;
    activeBrowser: boolean;
    controlOccupied: boolean;
    job: JobResult | null;
    protocol: 2;
    agentOnline: boolean;
    previewActive: boolean;
    settled: boolean;
    rapUpdateRequired: boolean;
  } {
    return this.ctx.storage.transactionSync(() => {
      const meta = this.meta();
      if (!meta) throw new HttpError(404, "not_found");
      const ownsLiveLease = meta.lease_browser_id === browserId && (meta.lease_expires_at ?? 0) > serverTime;
      if (ownsLiveLease && renewLease) {
        this.ctx.storage.sql.exec(
          "UPDATE relay_meta SET lease_expires_at = ? WHERE singleton = 1 AND lease_browser_id = ?",
          serverTime + BROWSER_LEASE_MS,
          browserId,
        );
      } else if (renewLease && (meta.lease_expires_at ?? 0) <= serverTime) {
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
        snapshot: this.transient && serverTime - this.transient.receivedAt < JOB_RETENTION_MS ? this.transient : null,
        activeBrowser: ownsLiveLease,
        controlOccupied,
        job: latest ? jobResult(latest, this.isResolved(latest.id)) : null,
        protocol: 2,
        agentOnline: this.ctx.getWebSockets().some((s) => { const a = this.attachment(s); return a?.role === "agent" && a.generation === meta.generation && serverTime - a.seen < LIVENESS_MS; }) || !!(this.transient && serverTime - this.transient.receivedAt < LIVENESS_MS),
        previewActive: this.previewUntil > serverTime,
        settled: this.settled,
        rapUpdateRequired: meta.rap_update_required === 1,
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
    if (changed) { this.failCaptures("capture_expired", (c) => c.browserId !== browser.id); this.broadcast(); }
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
    this.failCaptures("capture_expired", (c) => c.browserId === browser.id);
    this.broadcast();
    this.notifyWork();
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
      if (this.ctx.storage.sql.exec("SELECT id FROM job_tombstones WHERE id = ?", id).toArray().length) throw new HttpError(409, "job_id_retired");
      const meta = this.meta();
      if (!meta || meta.lease_browser_id !== browser.id || (meta.lease_expires_at ?? 0) <= now) {
        throw new HttpError(409, "active_browser_required");
      }
      const snapshot = this.transient;
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
      this.ctx.storage.sql.exec("INSERT INTO job_tombstones VALUES (?)", id);
      return { id, status: "queued" };
    });
    this.notifyWork();
    this.broadcast();
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
    this.broadcast();
    this.notifyWork();
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
    this.ctx.storage.sql.exec("DELETE FROM pairings WHERE created_at <= ?", now - JOB_RETENTION_MS);
  }

  private async createTicket(browser: BrowserIdentity): Promise<Response> {
    const ticket = randomToken();
    const hash = await hashToken(ticket);
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.reapJobs(now);
      if (this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM tickets WHERE expires_at > ?", now).one().n >= 20) throw new HttpError(429, "too_many_tickets");
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
    this.checkViewerCapacity(browserId);
    const viewers = this.ctx.getWebSockets().filter((s) => this.attachment(s)?.role === "browser");
    // Newest wins for the same browser: a reload leaves its old stream open until the liveness sweep, and must not be refused meanwhile.
    const replaced = viewers.length >= 2
      ? viewers.filter((s) => this.attachment(s)?.browserId === browserId).sort((a, b) => this.attachment(a)!.seen - this.attachment(b)!.seen).slice(0, 1)
      : [];
    if (viewers.length - replaced.length >= 2) throw new HttpError(429, "too_many_viewers");
    for (const socket of replaced) {
      try { socket.close(1008, "browser_replaced"); } catch { /* Already closed. */ }
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role: "browser", browserId, seen: now, watching: true } satisfies SocketIdentity);
    await this.renewPreview(true);
    const envelope = this.snapshotEnvelope(browserId, now, true);
    server.send(JSON.stringify(envelope));
    if (this.previewUntil <= now) server.send(JSON.stringify({ v: 2, type: "error", error: "preview_busy" }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private attachment(socket: WebSocket): SocketIdentity | null {
    const a: unknown = socket.deserializeAttachment();
    return isObject(a) && (a.role === "browser" || a.role === "agent") ? a as SocketIdentity : null;
  }

  private checkViewerCapacity(browserId: string): void {
    const viewers = new Set(this.ctx.getWebSockets().map((s) => this.attachment(s)).filter((a) => a?.role === "browser" && Date.now() - a.seen < LIVENESS_MS).map((a) => a!.browserId!));
    if (!viewers.has(browserId) && viewers.size >= 2) throw new HttpError(429, "too_many_viewers");
  }

  private async renewPreview(wanted: boolean): Promise<void> {
    const now = Date.now();
    if (wanted && now - this.lastPreviewRenew < 15_000 && this.previewUntil > now) return;
    this.lastPreviewRenew = now;
    const epoch = ++this.previewEpoch;
    const meta = this.meta();
    if (!meta) return;
    const accepted = await this.env.CONTROL_PLANE.getByName("registration-control").preview(meta.relay_id, wanted);
    if (epoch !== this.previewEpoch) return;
    this.previewUntil = accepted ? now + LIVENESS_MS : 0;
    this.notifyWork();
  }

  private hasWatchers(exclude?: WebSocket): boolean {
    const now = Date.now();
    return this.ctx.getWebSockets().some((s) => { const a = this.attachment(s); return s !== exclude && a?.role === "browser" && a.watching !== false && now - a.seen < LIVENESS_MS; });
  }

  private notifyWork(): void {
    const now = Date.now();
    const pairings = this.ctx.storage.sql.exec<{ id: string; phrase: string }>("SELECT id,phrase FROM pairings WHERE status='pending' AND expires_at > ? LIMIT 20", now).toArray();
    for (const socket of this.ctx.getWebSockets()) {
      const a = this.attachment(socket);
      if (a?.role === "agent" && a.generation === this.meta()?.generation && now - a.seen < LIVENESS_MS) {
        this.send(socket, { v: 2, type: "work", body: { pairings, job: null, previewActive: this.previewUntil > now } });
      }

    }
  }

  private send(socket: WebSocket, value: unknown): void {
    try { socket.send(JSON.stringify(value)); }
    catch { try { socket.close(1011, "send_failed"); } catch { /* Already closed. */ } }
  }

  private async agentStream(request: Request, identity: AgentIdentity): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "websocket_upgrade_required");
    if (Number(new URL(request.url).searchParams.get("generation")) !== identity.generation) throw new HttpError(409, "stale_generation");
    for (const socket of this.ctx.getWebSockets()) if (this.attachment(socket)?.role === "agent") socket.close(1008, "agent_replaced");
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ role: "agent", generation: identity.generation, seen: Date.now(), sequence: this.sequence, lastMessage: this.agentUpdateAt } satisfies SocketIdentity);
    this.notifyWork();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let id: string | undefined;
    try {
      const a = this.attachment(socket);
      if (!a || Date.now() - a.seen >= LIVENESS_MS) throw new HttpError(401, "socket_expired");
      if (a.role === "agent" && a.generation !== this.meta()?.generation) throw new HttpError(409, "stale_generation");
      if (a.role === "browser" && !this.ctx.storage.sql.exec("SELECT id FROM browsers WHERE id=? AND revoked=0", a.browserId!).toArray().length) throw new HttpError(401, "revoked");
      if (typeof message !== "string" || encoder.encode(message).length > MAX_JSON_BYTES) throw new HttpError(413, "message_too_large");
      if (a.role === "browser" && message === "ping") { socket.send("pong"); return; }
      const body = requiredObject(JSON.parse(message));
      if (body.id !== undefined) id = requireUuid(body.id);
      if (body.v !== 2) throw new HttpError(400, "unsupported_protocol");
      const now = Date.now();
      const hiding = a.role === "browser" && body.type === "heartbeat" && body.watching === false && a.watching !== false;
      if (a.role === "browser" && !hiding && a.lastMessage && now - a.lastMessage < 100) throw new HttpError(429, "message_rate_limited");
      a.seen = now; a.lastMessage = now; socket.serializeAttachment(a);
      if (a.role === "browser" && body.type === "heartbeat") {
        if (body.watching !== undefined && typeof body.watching !== "boolean") throw new HttpError(400, "invalid_message");
        if (typeof body.watching === "boolean") { a.watching = body.watching; socket.serializeAttachment(a); }
        await this.renewPreview(this.hasWatchers());
        socket.send(JSON.stringify(this.snapshotEnvelope(a.browserId!, now, true)));
        if (a.watching !== false && this.previewUntil <= now) socket.send(JSON.stringify({ v: 2, type: "error", error: "preview_busy" }));
        if (!this.transient || now - this.transient.receivedAt > 15_000) this.notifyWork();
      } else if (a.role === "agent" && body.type === "update" && id) {
        if (this.agentUpdateAt && now - this.agentUpdateAt < 500) throw new HttpError(429, "message_rate_limited");
        this.agentUpdateAt = now;
        const response = await this.agentUpdate(this.messageRequest(body.body), { generation: a.generation! });
        a.sequence = this.sequence; socket.serializeAttachment(a);
        socket.send(JSON.stringify({ v: 2, type: "update-result", id, body: await response.json() }));
      } else if (a.role === "agent" && body.type === "capture-result" && id) {
        await this.captureResult(this.messageRequest(body.body), id, { generation: a.generation! });
        a.sequence = this.sequence; socket.serializeAttachment(a);
      } else throw new HttpError(400, "invalid_message");
    } catch (error) {
      this.send(socket, { v: 2, type: "error", error: error instanceof HttpError ? error.code : "invalid_message", ...(id ? { id } : {}) });
      if (error instanceof HttpError && ["socket_expired", "revoked", "stale_generation"].includes(error.code)) socket.close(1008, error.code);
    }
  }

  private messageRequest(body: unknown): Request {
    return new Request("https://internal/operation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  private saveCapture(id: string, c: Capture): void {
    this.captures.set(id, c);
    this.ctx.storage.sql.exec("INSERT INTO captures VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", id, JSON.stringify(c), c.created);
  }

  private failCaptures(error: string, matches: (capture: Capture) => boolean): void {
    for (const [id, c] of this.captures) {
      if (c.status !== "pending" || !matches(c)) continue;
      c.status = "failed"; c.error = error; this.saveCapture(id, c);
      for (const socket of this.ctx.getWebSockets()) if (this.attachment(socket)?.browserId === c.browserId) this.send(socket, { v: 2, type: "error", id, error });
    }
  }

  private async captureNew(request: Request, browser: BrowserIdentity): Promise<Response> {
    const body = requiredObject(await readJson(request)); jsonBody(body, ["requestId"]);
    const id = requireUuid(body.requestId), now = Date.now(), meta = this.meta();
    if (!meta || meta.lease_browser_id !== browser.id || (meta.lease_expires_at ?? 0) <= now) throw new HttpError(409, "active_browser_required");
    const existing = this.captures.get(id);
    if (existing) {
      if (existing.browserId === browser.id && existing.status === "pending" && now - existing.created < 10_000) return jsonResponse({ requestId: id });
      throw new HttpError(409, "capture_id_used");
    }
    for (const c of this.captures.values()) if (c.status === "pending" && now - c.created >= 10_000) { c.status = "failed"; c.error = "capture_timeout"; }
    if ([...this.captures.values()].some((c) => c.status === "pending" && c.browserId === browser.id)) throw new HttpError(409, "capture_pending");
    if ([...this.captures.values()].filter((c) => c.status === "pending").length >= 10 || this.captures.size >= 1000) throw new HttpError(429, "capture_busy");
    this.saveCapture(id, { browserId: browser.id, generation: meta.generation, revision: this.transient?.context?.revision ?? null, created: now, sequence: this.sequence, observedAt: this.observedAt, status: "pending" });
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > now + 10_000) await this.ctx.storage.setAlarm(now + 10_000);
    for (const s of this.ctx.getWebSockets()) if (this.attachment(s)?.role === "agent") this.send(s, { v: 2, type: "capture", id });
    return jsonResponse({ requestId: id });
  }

  private async captureResult(request: Request, id: string, identity: AgentIdentity): Promise<Response> {
    const c = this.captures.get(id), now = Date.now(), meta = this.meta();
    if (!c || c.status !== "pending") throw new HttpError(409, "capture_not_pending");
    if (now - c.created >= 10_000 || c.generation !== identity.generation || meta?.generation !== c.generation || meta?.lease_browser_id !== c.browserId || (meta.lease_expires_at ?? 0) <= now) {
      c.status = "failed"; c.error = "capture_expired"; this.saveCapture(id, c); throw new HttpError(409, c.error);
    }
    const body = requiredObject(await readJson(request));
    if (typeof body.observedAtServer !== "number" || typeof body.clockUncertaintyMs !== "number" ||
      typeof body.sequence !== "number" || body.sequence <= c.sequence || body.observedAtServer <= c.observedAt ||
      body.observedAtServer + body.clockUncertaintyMs < c.created) throw new HttpError(409, "fresh_observation_required");
    await this.agentUpdate(this.messageRequest(body), identity, false);
    const s = this.transient;
    const currentMeta = this.meta();
    if (currentMeta?.generation !== c.generation || currentMeta.lease_browser_id !== c.browserId || (currentMeta.lease_expires_at ?? 0) <= Date.now()) {
      c.status = "failed"; c.error = "capture_expired";
    } else if (!s?.connected || !s.position || !s.context || (c.revision !== null && c.revision !== s.context.revision) || s.observationAgeMs + Date.now() - s.receivedAt > SNAPSHOT_MAX_AGE_MS) {
      c.status = "failed"; c.error = "fresh_matching_context_required";
    } else {
      c.status = "complete";
      const completedAt = Date.now();
      c.body = { ...this.snapshotEnvelope(c.browserId, completedAt, false), waitMs: Math.max(0, completedAt - c.created) };
    }
    this.saveCapture(id, c);
    for (const socket of this.ctx.getWebSockets()) if (this.attachment(socket)?.browserId === c.browserId) this.send(socket, c.status === "complete" ? { v: 2, type: "capture-result", id, body: c.body } : { v: 2, type: "error", id, error: c.error });
    return jsonResponse({ status: c.status });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.reapJobs(now); this.reapPairings(now); this.reapLaunches(now);
    this.ctx.storage.sql.exec("DELETE FROM captures WHERE created_at <= ?", now - JOB_RETENTION_MS + 60_000);
    if (this.transient && now - this.transient.receivedAt >= JOB_RETENTION_MS - 60_000) this.transient = null;
    for (const [id, c] of this.captures) {
      if (now - c.created >= JOB_RETENTION_MS - 60_000) this.captures.delete(id);
      else if (c.status === "pending" && now - c.created >= 10_000) {
        c.status = "failed"; c.error = "capture_timeout"; this.saveCapture(id, c);
        for (const socket of this.ctx.getWebSockets()) if (this.attachment(socket)?.browserId === c.browserId) this.send(socket, { v: 2, type: "error", id, error: c.error });
      }
    }
    for (const s of this.ctx.getWebSockets()) { const a = this.attachment(s); if (!a || now - a.seen >= LIVENESS_MS) s.close(1008, "socket_expired"); }
    if (!this.hasWatchers()) await this.renewPreview(false);
    this.broadcast();
    const active = this.ctx.getWebSockets().some((s) => { const a = this.attachment(s); return a && now - a.seen < LIVENESS_MS; }) || this.hasWatchers();
    const captureDeadline = Math.min(Infinity, ...[...this.captures.values()].filter((c) => c.status === "pending").map((c) => c.created + 10_000));
    const deadline = (query: string, ...values: number[]): number => {
      const value = this.ctx.storage.sql.exec<{ deadline: number | null }>(query, ...values).one().deadline;
      return value !== null && value > now ? value : Infinity;
    };
    const retainedDeadline = Math.min(
      deadline("SELECT MIN(created_at) + ? AS deadline FROM jobs", JOB_RETENTION_MS),
      deadline("SELECT MIN(expires_at) AS deadline FROM jobs WHERE status IN ('queued','claimed')"),
      deadline("SELECT MIN(created_at) + ? AS deadline FROM pairings", JOB_RETENTION_MS),
      deadline("SELECT MIN(expires_at) AS deadline FROM pairings WHERE status='pending'"),
      deadline("SELECT MIN(expires_at) AS deadline FROM invitations"),
      deadline("SELECT MIN(expires_at) AS deadline FROM tickets"),
      deadline("SELECT MIN(MAX(expires_at, created_at + ?)) AS deadline FROM browser_launches", LAUNCH_RATE_WINDOW_MS),
      deadline("SELECT MIN(created_at) + ? AS deadline FROM captures", JOB_RETENTION_MS - 60_000),
    );
    const next = Math.min(active ? now + 60_000 : Infinity, captureDeadline, retainedDeadline, this.transient ? this.transient.receivedAt + JOB_RETENTION_MS - 60_000 : Infinity);
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(Math.max(now + 1, next));
    else await this.ctx.storage.deleteAlarm();
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    try {
      socket.close(code, reason);
    } catch {
      // Socket is already closed.
    }
    if (!this.hasWatchers(socket)) await this.renewPreview(false);
    this.broadcast();
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
      if (isObject(attachment) && attachment.role === "agent") continue;
      if (!isObject(attachment) || typeof attachment.browserId !== "string" || !active.has(attachment.browserId)) {
        socket.close(1008, "revoked");
        continue;
      }
      try {
        socket.send(JSON.stringify(this.snapshotEnvelope(attachment.browserId, Date.now(), false)));
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

async function register(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
  const body = requiredObject(await readJson(request));
  jsonBody(body, ["invitation", "name"]);
  if (typeof body.invitation !== "string" || typeof body.name !== "string" ||
      body.invitation.length < 16 || body.invitation.length > 256 ||
      body.name.trim().length < 1 || body.name.length > 64 || /[\u0000-\u001f\u007f]/u.test(body.name)) {
    throw new HttpError(400, "invalid_request");
  }
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const ipHash = toHex(await sha256(ip));
  const relayId = crypto.randomUUID();
  const decision = await env.CONTROL_PLANE.getByName("registration-control").consumeRegistrationAttempt(
    ipHash,
    await hashToken(body.invitation),
    relayId,
    Date.now(),
  );
  if (decision === "rate_limited") throw new HttpError(429, "registration_rate_limited");
  if (decision === "invalid" && envString(env, "OPERATOR_ADMIN_TOKEN").length < 32) throw new HttpError(503, "registration_unavailable");
  if (decision === "invalid") throw new HttpError(401, "invalid_invitation");
  if (decision === "consumed") throw new HttpError(409, "invitation_used");
  if (decision === "capacity") throw new HttpError(429, "registration_capacity");
  const credential = randomToken();
  const name = body.name.trim();
  const initialized = await env.RELAYS.getByName(relayId).initializeRelay(relayId, name, await hashToken(credential));
  if (!initialized) throw new HttpError(503, "registration_failed");
  await env.CONTROL_PLANE.getByName("registration-control").inventory(relayId);
  return jsonResponse({ relayId, credential }, 201);
}

function compareVersions(value: unknown, minimum: string): number {
  const parse = (text: unknown) => typeof text === "string" && /^\d+\.\d+\.\d+$/u.test(text) ? text.split(".").map(Number) : null;
  const a = parse(value), b = parse(minimum);
  if (!b) return 0;
  if (!a) return -1;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function envString(env: Env, key: string): string {
  const value: unknown = Reflect.get(env, key);
  return typeof value === "string" ? value.trim() : "";
}

async function operatorInvitations(request: Request, env: Env, path: string): Promise<Response> {
  if (request.headers.has("Origin")) throw new HttpError(403, "operator_browser_forbidden");
  const cp = env.CONTROL_PLANE.getByName("registration-control");
  const ipHash = await hashToken(request.headers.get("CF-Connecting-IP") ?? "unknown");
  if (await cp.consumeRegistrationAttempt(`operator:${ipHash}`, null, "", Date.now()) === "rate_limited") {
    throw new HttpError(429, "operator_rate_limited");
  }
  const secret = envString(env, "OPERATOR_ADMIN_TOKEN");
  if (secret.length < 32) throw new HttpError(503, "operator_unavailable");
  const supplied = request.headers.get("Authorization") ?? "";
  if (!supplied.startsWith("Bearer ") || !constantTimeEqual(await hashToken(supplied.slice(7)), await hashToken(secret))) {
    throw new HttpError(401, "unauthorized");
  }
  if (path === "/v1/operator/invitations") {
    if (request.method === "GET") return jsonResponse(await cp.invitationList());
    if (request.method === "POST") {
      const body = requiredObject(await readJson(request));
      jsonBody(body, ["count", "label"]);
      if (!Number.isInteger(body.count) || typeof body.count !== "number" || body.count < 1 || body.count > 20 ||
        typeof body.label !== "string" || body.label.length > 64 || /[\u0000-\u001f\u007f]/u.test(body.label)) throw new HttpError(400, "invalid_request");
      const result = await cp.invitationBatch(body.count, body.label.trim());
      if ("error" in result) throw new HttpError(429, result.error);
      return jsonResponse(result, 201);
    }
    throw new HttpError(405, "method_not_allowed");
  }
  const match = path.match(/^\/v1\/operator\/invitations\/([0-9a-f-]{36})\/cancel$/iu);
  if (!match) throw new HttpError(404, "not_found");
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
  jsonBody(requiredObject(await readJson(request)), []);
  const result = await cp.invitationCancel(requireUuid(match[1]));
  if ("error" in result) throw new HttpError(result.error === "invitation_not_found" ? 404 : 409, result.error);
  return jsonResponse(result);
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
      } else if (url.pathname.startsWith("/v1/operator/")) {
        response = await operatorInvitations(request, env, url.pathname);
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
