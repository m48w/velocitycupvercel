import type { Role, SessionInfo } from "../src/types";

/** Secret は本番で設定し忘れることがあるので、すべて省略可能として扱う。 */
export interface AuthEnv {
  SUPERADMIN_PASSWORD?: string;
  SUBADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
}

export interface Account {
  role: Role;
  court: number | null;
}

export const ACCOUNTS: Readonly<Record<string, Account>> = {
  superadmin: { role: "superadmin", court: null },
  subadmin1: { role: "subadmin", court: 1 },
  subadmin2: { role: "subadmin", court: 1 },
  subadmin3: { role: "subadmin", court: 2 },
  subadmin4: { role: "subadmin", court: 2 },
  subadmin5: { role: "subadmin", court: 3 },
  subadmin6: { role: "subadmin", court: 3 },
};

export interface Session extends SessionInfo {
  deviceId: string;
  /** UNIX 秒。 */
  exp: number;
}

export interface Identity extends SessionInfo {
  deviceId: string;
}

export const SESSION_TTL_SECONDS = 12 * 60 * 60;
const SESSION_COOKIE = "session";
const COOKIE_ATTRIBUTES = "HttpOnly; Secure; SameSite=Strict; Path=/";
const USERNAME_HEADER = "x-auth-username";
const DEVICE_HEADER = "x-auth-device";

const encoder = new TextEncoder();

/** `ACCOUNTS["constructor"]` のような組み込みプロパティを拾わないよう、自前のキーだけを見る。 */
export function accountFor(username: unknown): Account | undefined {
  return typeof username === "string" && Object.hasOwn(ACCOUNTS, username)
    ? ACCOUNTS[username]
    : undefined;
}

export function passwordFor(username: string, env: AuthEnv): string | undefined {
  const account = accountFor(username);
  if (!account) return undefined;
  const secret = account.role === "superadmin" ? env.SUPERADMIN_PASSWORD : env.SUBADMIN_PASSWORD;
  return secret ? secret : undefined;
}

/** 先に両方をハッシュして長さを揃える。timingSafeEqual は長さが違うと例外を投げ、長さそのものも漏らさない。 */
export async function passwordMatches(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all(
    [given, expected].map((text) => crypto.subtle.digest("SHA-256", encoder.encode(text))),
  );
  return crypto.subtle.timingSafeEqual(a, b);
}

export function newSession(username: string, now: number): Session {
  const account = accountFor(username);
  if (!account) throw new Error(`unknown account: ${username}`);
  return {
    username,
    role: account.role,
    court: account.court,
    deviceId: crypto.randomUUID(),
    exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
  };
}

const toBase64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fromBase64url = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));

const hmacKey = (secret: string) =>
  crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);

export async function signSession(session: Session, secret: string): Promise<string> {
  const payload = toBase64url(encoder.encode(JSON.stringify(session)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(payload),
  );
  return `${payload}.${toBase64url(new Uint8Array(signature))}`;
}

/** 署名・期限・アカウント表との一致をすべて確かめる。1つでも欠ければ null。 */
export async function verifySession(
  token: string,
  secret: string | undefined,
  now: number,
): Promise<Session | null> {
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;

  let session: Partial<Session>;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      fromBase64url(signature),
      encoder.encode(payload),
    );
    if (!valid) return null;
    session = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as Partial<Session>;
  } catch {
    return null;
  }

  const account = accountFor(session?.username);
  if (!account || account.role !== session.role || account.court !== session.court) return null;
  if (typeof session.deviceId !== "string" || typeof session.exp !== "number") return null;
  if (session.exp * 1000 <= now) return null;
  return session as Session;
}

export const publicSession = ({ username, role, court }: SessionInfo): SessionInfo => ({
  username,
  role,
  court,
});

export const sessionCookie = (token: string) =>
  `${SESSION_COOKIE}=${token}; ${COOKIE_ATTRIBUTES}; Max-Age=${SESSION_TTL_SECONDS}`;

export const CLEARED_SESSION_COOKIE = `${SESSION_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;

export function readSessionToken(cookieHeader: string | null): string | null {
  for (const part of (cookieHeader ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=");
  }
  return null;
}

/** Durable Object へ転送するリクエスト。利用者ヘッダーは外から偽装できないよう必ず付け直す。 */
export function withIdentity(request: Request, session: Session | null): Request {
  const headers = new Headers(request.headers);
  headers.delete(USERNAME_HEADER);
  headers.delete(DEVICE_HEADER);
  if (session) {
    headers.set(USERNAME_HEADER, session.username);
    headers.set(DEVICE_HEADER, session.deviceId);
  }
  return new Request(request, { headers });
}

/** 役割とコートはヘッダーではなくアカウント表から決める。 */
export function readIdentity(headers: Headers): Identity | null {
  const username = headers.get(USERNAME_HEADER);
  const deviceId = headers.get(DEVICE_HEADER);
  const account = accountFor(username);
  if (!account || !username || !deviceId) return null;
  return { username, role: account.role, court: account.court, deviceId };
}
