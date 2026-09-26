import type { Role, SessionInfo, Match, TournamentState } from "../src/types";
import { initialMatches } from "../src/features/tournament/data";

type RequestHandler = (request: Request) => Promise<Response>;
const numberInt = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0;
type Db = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;
const TTL = 12 * 60 * 60;
const cookieAttrs = "HttpOnly; Secure; SameSite=Strict; Path=/";
const CLEARED_SESSION_COOKIE = `session=; ${cookieAttrs}; Max-Age=0`;
const accounts: Record<string, { role: Role; court: number | null }> = {
  superadmin: { role: "superadmin", court: null }, subadmin1: { role: "subadmin", court: 1 }, subadmin2: { role: "subadmin", court: 1 },
  subadmin3: { role: "subadmin", court: 2 }, subadmin4: { role: "subadmin", court: 2 }, subadmin5: { role: "subadmin", court: 3 }, subadmin6: { role: "subadmin", court: 3 },
};
type Session = SessionInfo & { deviceId: string; exp: number };
type Identity = SessionInfo & { deviceId: string };
const b64 = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
async function hmac(secret: string) { return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]); }
async function tokenFor(session: Session, secret: string) { const payload = b64(new TextEncoder().encode(JSON.stringify(session))); const signature = await crypto.subtle.sign("HMAC", await hmac(secret), new TextEncoder().encode(payload)); return `${payload}.${b64(new Uint8Array(signature))}`; }
async function readSession(request: Request): Promise<Session | null> {
  const secret = process.env.SESSION_SECRET; if (!secret) return null;
  const token = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith("session="))?.slice(8);
  if (!token) return null; const [payload, signature, ...rest] = token.split("."); if (!payload || !signature || rest.length) return null;
  try { if (!await crypto.subtle.verify("HMAC", await hmac(secret), unb64(signature), new TextEncoder().encode(payload))) return null;
    const session = JSON.parse(new TextDecoder().decode(unb64(payload))) as Session; const account = accounts[session.username];
    return account && account.role === session.role && account.court === session.court && session.exp * 1000 > Date.now() && typeof session.deviceId === "string" ? session : null;
  } catch { return null; }
}
function neonHttp(databaseUrl: string): Db {
  const endpoint = new URL(databaseUrl);
  const connectionString = `${endpoint.protocol}//${endpoint.username}:${endpoint.password}@${endpoint.host}${endpoint.pathname}${endpoint.search}`;
  return async (strings, ...values) => {
    let query = "";
    for (let i = 0; i < strings.length; i += 1) query += `${strings[i]}${i < values.length ? `$${i + 1}` : ""}`;
    const response = await fetch("https://sql.neon.tech/sql", { method: "POST", headers: { "content-type": "application/json", "neon-connection-string": connectionString }, body: JSON.stringify({ query, params: values }) });
    if (!response.ok) throw new Error(`database request failed (${response.status})`);
    const result = await response.json() as { rows?: Record<string, unknown>[] };
    return result.rows ?? [];
  };
}
const json = (status: number, data: unknown, headers?: Record<string, string>) => {
  const resultHeaders = new Headers(headers);
  resultHeaders.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers: resultHeaders });
};

async function ensureSchema(sql: Db) {
  await sql`CREATE TABLE IF NOT EXISTS tournament_state (id integer PRIMARY KEY, version integer NOT NULL, updated_at text NOT NULL, matches jsonb NOT NULL)`;
  await sql`CREATE TABLE IF NOT EXISTS login_attempts (username text PRIMARY KEY, failures integer NOT NULL, last_failed_at bigint NOT NULL)`;
}

function createStore(sql: Db) {
  let ready: Promise<void> | undefined;
  const init = () => (ready ??= ensureSchema(sql));
  const snapshot = async (): Promise<TournamentState> => {
    await init();
    let rows = await sql`SELECT version, updated_at, matches FROM tournament_state WHERE id = 1`;
    if (!rows.length) {
      const matches = initialMatches;
      rows = await sql`INSERT INTO tournament_state (id, version, updated_at, matches) VALUES (1, 1, ${new Date().toISOString()}, ${JSON.stringify(matches)}::jsonb) ON CONFLICT (id) DO UPDATE SET id = 1 RETURNING version, updated_at, matches`;
    }
    const row = rows[0] as { version: number; updated_at: string; matches: Match[] | string };
    return { version: Number(row.version), updatedAt: row.updated_at, matches: typeof row.matches === "string" ? JSON.parse(row.matches) : row.matches };
  };
  const write = async (matches: Match[]) => {
    await init();
    const now = new Date().toISOString();
    const result = await sql`INSERT INTO tournament_state (id, version, updated_at, matches) VALUES (1, 1, ${now}, ${JSON.stringify(matches)}::jsonb) ON CONFLICT (id) DO UPDATE SET version = tournament_state.version + 1, updated_at = EXCLUDED.updated_at, matches = EXCLUDED.matches RETURNING version, updated_at, matches`;
    const row = result[0] as { version: number; updated_at: string; matches: Match[] | string };
    return { version: Number(row.version), updatedAt: row.updated_at, matches: typeof row.matches === "string" ? JSON.parse(row.matches) : row.matches } as TournamentState;
  };
  return {
    read: snapshot,
    patchMatch: async (id: string, patch: Partial<Match>) => {
      const state = await snapshot();
      const match = state.matches.find((item) => item.id === id);
      if (!match) throw new Error(`unknown match: ${id}`);
      return write(state.matches.map((item) => item.id === id ? { ...item, ...patch } : item));
    },
    replaceMatches: write,
    reset: () => write(initialMatches),
  };
}

function attemptsFor(sql: Db) {
  let ready: Promise<void> | undefined;
  const init = () => (ready ??= ensureSchema(sql));
  return {
    retryAfterSeconds: async (username: string, now: number) => {
      await init(); const rows = await sql`SELECT failures, last_failed_at FROM login_attempts WHERE username = ${username}`;
      const row = rows[0] as { failures: number; last_failed_at: number } | undefined;
      return row && row.failures >= 5 ? Math.ceil(Math.max(0, Number(row.last_failed_at) + 60_000 - now) / 1000) : 0;
    },
    recordFailure: async (username: string, now: number) => {
      await init(); const rows = await sql`SELECT failures, last_failed_at FROM login_attempts WHERE username = ${username}`;
      const row = rows[0] as { failures: number; last_failed_at: number } | undefined;
      const lockedMs = row && row.failures >= 5 ? Math.max(0, Number(row.last_failed_at) + 60_000 - now) : 0;
      const failures = row && !lockedMs ? row.failures + 1 : 1;
      await sql`INSERT INTO login_attempts (username, failures, last_failed_at) VALUES (${username}, ${failures}, ${now}) ON CONFLICT (username) DO UPDATE SET failures = ${failures}, last_failed_at = ${now}`;
    },
    clear: async (username: string) => { await init(); await sql`DELETE FROM login_attempts WHERE username = ${username}`; },
  };
}

export function apiHandler(route: "state" | "matches" | "match" | "reset" | "session" | "login" | "logout"): RequestHandler {
  return async (request) => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) return json(503, { error: "DATABASE_URL must be configured for Vercel Postgres (Neon)." });
    const sql = neonHttp(databaseUrl);
    const path = new URL(request.url).pathname;
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      return json(415, { error: "requests that change data must send content-type: application/json", code: "UNSUPPORTED_MEDIA_TYPE" });
    }
    const session = await readSession(request);
    const publicSession = session ? { username: session.username, role: session.role, court: session.court } : null;
    if (route === "session" && request.method === "GET") return json(200, { session: publicSession });
    if (route === "logout" && request.method === "POST") return json(200, { session: null }, { "set-cookie": CLEARED_SESSION_COOKIE });
    if (route === "login" && request.method === "POST") {
      let body: { username?: unknown; password?: unknown };
      try { body = await request.json() as typeof body; } catch { return json(400, { error: "username and password are required", code: "INVALID_LOGIN" }); }
      if (typeof body?.username !== "string" || typeof body.password !== "string") return json(400, { error: "username and password are required", code: "INVALID_LOGIN" });
      const username = body.username.trim().toLowerCase();
      const account = accounts[username];
      if (!account) return json(401, { error: "incorrect username or password", code: "INVALID_CREDENTIALS" });
      const expected = account.role === "superadmin" ? process.env.SUPERADMIN_PASSWORD : process.env.SUBADMIN_PASSWORD;
      const secret = process.env.SESSION_SECRET;
      if (!expected || !secret) return json(500, { error: "sign-in is not configured on the server", code: "AUTH_NOT_CONFIGURED" });
      const attempts = attemptsFor(sql);
      const [givenHash, expectedHash] = await Promise.all([body.password, expected].map((text) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
      const matches = givenHash.byteLength === expectedHash.byteLength && new Uint8Array(givenHash).every((byte, index) => byte === new Uint8Array(expectedHash)[index]);
      const retry = await attempts.retryAfterSeconds(username, Date.now());
      if (retry > 0) return json(429, { error: "too many failed attempts", code: "TOO_MANY_ATTEMPTS", retryAfterSeconds: retry }, { "retry-after": String(retry) });
      if (!matches) { await attempts.recordFailure(username, Date.now()); return json(401, { error: "incorrect username or password", code: "INVALID_CREDENTIALS" }); }
      await attempts.clear(username);
      const signedIn: Session = { username, role: account.role, court: account.court, deviceId: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + TTL };
      const signedToken = await tokenFor(signedIn, secret);
      return json(200, { session: { username, role: account.role, court: account.court } }, { "set-cookie": `session=${signedToken}; ${cookieAttrs}; Max-Age=${TTL}` });
    }
    const identity: Identity | null = session ? { username: session.username, role: session.role, court: session.court, deviceId: session.deviceId } : null;
    const store = createStore(sql);
    const state = await store.read();
    const sendState = (next: TournamentState) => json(200, next);
    if (path === "/api/state" && request.method === "GET") return sendState(state);
    if (path === "/api/reset" && request.method === "POST") {
      if (!identity) return json(401, { error: "sign in to change the tournament", code: "UNAUTHENTICATED" });
      if (identity.role !== "superadmin") return json(403, { error: "only the super-admin can do this", code: "FORBIDDEN" });
      return sendState(await store.reset());
    }
    if (path === "/api/matches" && request.method === "PUT") {
      if (!identity) return json(401, { error: "sign in to change the tournament", code: "UNAUTHENTICATED" });
      if (identity.role !== "superadmin") return json(403, { error: "only the super-admin can do this", code: "FORBIDDEN" });
      let body: { matches?: Match[] }; try { body = await request.json() as typeof body; } catch { return json(400, { error: "request body must be valid JSON" }); }
      if (!Array.isArray(body.matches)) return json(400, { error: "matches must be an array" });
      if (new Set(body.matches.map((item) => item.id)).size !== body.matches.length) return json(400, { error: "match ids must be unique", code: "INVALID_MATCHES" });
      return sendState(await store.replaceMatches(body.matches));
    }
    const patchTarget = path.match(/^\/api\/matches\/(.+)$/);
    if (patchTarget && request.method === "PATCH") {
      if (!identity) return json(401, { error: "sign in to change the tournament", code: "UNAUTHENTICATED" });
      const id = decodeURIComponent(patchTarget[1]);
      const target = state.matches.find((item) => item.id === id);
      if (!target) return json(404, { error: `unknown match: ${id}`, code: "UNKNOWN_MATCH" });
      if (identity.role !== "superadmin" && target.court !== identity.court) return json(403, { error: `court ${identity.court} accounts cannot change a court ${target.court} match`, code: "WRONG_COURT" });
      let patch: Partial<Match>; try { patch = await request.json() as typeof patch; } catch { return json(400, { error: "request body must be valid JSON" }); }
      const validators: Record<string, (value: unknown) => boolean> = {
        status: (value) => ["SCHEDULED", "LIVE", "PAUSED", "FINISHED"].includes(String(value)),
        homeScore: numberInt, awayScore: numberInt, penaltyHomeScore: numberInt, penaltyAwayScore: numberInt,
        timerServerStartedAt: (value) => value === undefined || (typeof value === "string" && !Number.isNaN(Date.parse(value))),
        timerElapsedSecondsAtPause: (value) => value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0),
        isPenaltyShootout: (value) => typeof value === "boolean",
      };
      const invalid = Object.entries(patch).find(([key, value]) => !validators[key] || !validators[key](value));
      if (invalid) return json(400, { error: `invalid or non-patchable field: ${invalid[0]}`, code: "INVALID_FIELD_VALUE" });
      return sendState(await store.patchMatch(id, patch));
    }
    return json(404, { error: `no route for ${request.method} ${path}` });
  };
}
