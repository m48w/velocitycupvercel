import { DurableObject } from "cloudflare:workers";
import type { ServerMessage, TournamentState } from "../src/types";
import { handleApi } from "./api";
import { createLoginAttempts, type LoginAttempts } from "./attempts";
import { readIdentity } from "./auth";
import { jsonResponse } from "./http";
import { handleLogin } from "./login";
import { createSqlStore, type Store } from "./store";

const serialize = (state: TournamentState) =>
  JSON.stringify({ type: "state", state } satisfies ServerMessage);

export class TournamentRoom extends DurableObject<Env> {
  private readonly store: Store;
  private readonly attempts: LoginAttempts;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = createSqlStore(ctx.storage);
    this.attempts = createLoginAttempts(ctx.storage.sql);
    // Answered by the runtime without waking the object, so client heartbeats stay free.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/api/ws") return this.accept(request);
    if (path === "/api/login" && request.method === "POST") {
      return handleLogin(request, this.attempts, this.env, Date.now());
    }
    return handleApi(request, this.store, readIdentity(request.headers), (state) =>
      this.broadcast(state),
    );
  }

  private accept(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse(426, { error: "expected a websocket upgrade" });
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.send(serialize(this.store.read()));
    return new Response(null, { status: 101, webSocket: client });
  }

  private broadcast(state: TournamentState): void {
    const message = serialize(state);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        // A socket that is closing must not stop the others from being told.
      }
    }
  }

  async webSocketMessage(): Promise<void> {
    // Clients only send "ping", which the auto-response answers.
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    try {
      socket.close(code, reason);
    } catch {
      // Codes such as 1005/1006 cannot be echoed back; the socket is gone anyway.
    }
  }
}
