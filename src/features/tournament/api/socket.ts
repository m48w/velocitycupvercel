import type { TournamentState } from "../../../types";

const MAX_RECONNECT_DELAY_MS = 10_000;

/** ページと同じホストの WebSocket URL。https のページでは wss:// でないとブラウザーが拒否する。 */
export function socketUrl(location: { protocol: string; host: string }): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/ws`;
}

/** 再接続までの待ち時間。1秒から倍々に延ばし、10秒で頭打ち。 */
export function reconnectDelay(attempt: number): number {
  return Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** attempt);
}

/** サーバーからのメッセージを読む。state 以外（pong や壊れたデータ）は null。 */
export function parseServerMessage(data: unknown): TournamentState | null {
  if (typeof data !== "string") return null;
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof message !== "object" || message === null) return null;
  const { type, state } = message as { type?: unknown; state?: Partial<TournamentState> };
  if (type !== "state" || typeof state !== "object" || state === null) return null;
  if (typeof state.version !== "number" || !Array.isArray(state.matches)) return null;
  return state as TournamentState;
}
