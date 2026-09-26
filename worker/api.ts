import type { Match, TournamentState } from "../src/types";
import type { Identity } from "./auth";
import { jsonResponse } from "./http";
import { StoreError, type Store } from "./store";

/** JSON リクエストボディが壊れている場合に投げる。400 にマップされる。 */
class BadRequestError extends Error {}

/** ログインしていない（401）か、その操作の権限がない（403）場合に投げる。 */
class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
    readonly code: "UNAUTHENTICATED" | "FORBIDDEN" | "WRONG_COURT",
  ) {
    super(message);
  }
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequestError("request body must be valid JSON");
  }
}

function signedIn(identity: Identity | null): Identity {
  if (!identity) throw new AuthError(401, "sign in to change the tournament", "UNAUTHENTICATED");
  return identity;
}

function superadminOnly(identity: Identity | null): Identity {
  const who = signedIn(identity);
  if (who.role !== "superadmin") {
    throw new AuthError(403, "only the super-admin can do this", "FORBIDDEN");
  }
  return who;
}

/** SubAdmin は担当コートの試合だけを変更できる。存在しない試合は store が 404 にする。 */
function assertCourt(store: Store, who: Identity, matchId: string): void {
  if (who.role === "superadmin") return;
  const match = store.read().matches.find((m) => m.id === matchId);
  if (match && match.court !== who.court) {
    throw new AuthError(
      403,
      `court ${who.court} accounts cannot change a court ${match.court} match`,
      "WRONG_COURT",
    );
  }
}

/** `/api/*`（WebSocket とログイン以外）を処理する。変更が成功したら broadcast を呼ぶ。 */
export async function handleApi(
  request: Request,
  store: Store,
  identity: Identity | null,
  broadcast: (state: TournamentState) => void,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const mutated = (state: TournamentState) => {
    broadcast(state);
    return jsonResponse(200, state);
  };

  try {
    if (path === "/api/state" && request.method === "GET") {
      return jsonResponse(200, store.read());
    }

    if (path === "/api/reset" && request.method === "POST") {
      superadminOnly(identity);
      return mutated(store.reset());
    }

    if (path === "/api/matches" && request.method === "PUT") {
      superadminOnly(identity);
      const body = (await readJsonBody(request)) as { matches?: Match[] };
      if (!Array.isArray(body.matches)) {
        return jsonResponse(400, { error: "matches must be an array" });
      }
      return mutated(store.replaceMatches(body.matches));
    }

    const patchTarget = path.match(/^\/api\/matches\/(.+)$/);
    if (patchTarget && request.method === "PATCH") {
      const who = signedIn(identity);
      const id = decodeURIComponent(patchTarget[1]);
      assertCourt(store, who, id);
      const patch = (await readJsonBody(request)) as Partial<Match>;
      return mutated(store.patchMatch(id, patch));
    }

    return jsonResponse(404, { error: `no route for ${request.method} ${path}` });
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonResponse(error.status, { error: error.message, code: error.code });
    }
    if (error instanceof StoreError) {
      return jsonResponse(error.code === "UNKNOWN_MATCH" ? 404 : 400, {
        error: error.message,
        code: error.code,
      });
    }
    if (error instanceof BadRequestError) {
      return jsonResponse(400, { error: error.message });
    }
    console.error("[api] failed while handling a request", error);
    return jsonResponse(500, { error: error instanceof Error ? error.message : String(error) });
  }
}
