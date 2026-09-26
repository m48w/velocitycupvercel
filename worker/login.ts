import type { LoginAttempts } from "./attempts";
import {
  accountFor,
  newSession,
  passwordFor,
  passwordMatches,
  publicSession,
  sessionCookie,
  signSession,
  type AuthEnv,
} from "./auth";
import { jsonResponse } from "./http";

const invalidLogin = () =>
  jsonResponse(400, { error: "username and password are required", code: "INVALID_LOGIN" });
const invalidCredentials = () =>
  jsonResponse(401, { error: "incorrect username or password", code: "INVALID_CREDENTIALS" });

/** `POST /api/login`。Durable Object の中で呼ぶ（試行回数を SQLite に持つため）。 */
export async function handleLogin(
  request: Request,
  attempts: LoginAttempts,
  env: AuthEnv,
  now: number,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidLogin();
  }
  const { username: rawUsername, password } = (body ?? {}) as {
    username?: unknown;
    password?: unknown;
  };
  if (typeof rawUsername !== "string" || typeof password !== "string") return invalidLogin();

  // Phone keyboards capitalise the first letter and add trailing spaces; account names are lower case.
  const username = rawUsername.trim().toLowerCase();
  if (!accountFor(username)) {
    // Unknown names are not counted, so random names cannot grow the attempts table.
    return invalidCredentials();
  }

  const expected = passwordFor(username, env);
  if (!expected || !env.SESSION_SECRET) {
    console.error("[auth] SUPERADMIN_PASSWORD, SUBADMIN_PASSWORD or SESSION_SECRET is not set");
    return jsonResponse(500, {
      error: "sign-in is not configured on the server",
      code: "AUTH_NOT_CONFIGURED",
    });
  }

  const matches = await passwordMatches(password, expected);

  // Checking and recording happen with no await in between, so parallel guesses that were all
  // waiting on the hash above are still counted one by one and cannot slip past the limit.
  const retryAfterSeconds = attempts.retryAfterSeconds(username, now);
  if (retryAfterSeconds > 0) {
    return jsonResponse(
      429,
      { error: "too many failed attempts", code: "TOO_MANY_ATTEMPTS", retryAfterSeconds },
      { "retry-after": String(retryAfterSeconds) },
    );
  }
  if (!matches) {
    attempts.recordFailure(username, now);
    return invalidCredentials();
  }

  attempts.clear(username);
  const session = newSession(username, now);
  const token = await signSession(session, env.SESSION_SECRET);
  return jsonResponse(
    200,
    { session: publicSession(session) },
    { "set-cookie": sessionCookie(token) },
  );
}
