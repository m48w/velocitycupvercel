import { ApiError } from "../../utils/http";

/** Shown when `POST /api/logout` fails; the session is kept so the console stays usable. */
export const SIGN_OUT_FAILED = "Could not sign out — check the connection and try again.";

export function loginErrorMessage(cause: unknown): string {
  if (!(cause instanceof ApiError)) {
    return "Could not reach the server. Check the connection and try again.";
  }
  if (cause.status === 401) return "Incorrect username or password.";
  if (cause.status === 429) {
    return `Too many failed attempts. Try again in ${cause.retryAfterSeconds ?? 60} seconds.`;
  }
  if (cause.code === "AUTH_NOT_CONFIGURED") {
    return "Sign-in is not set up on the server yet. Ask the organiser to set the passwords.";
  }
  return cause.message;
}
