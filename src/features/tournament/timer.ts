import type { Match, MatchStatus } from "../../types";

/**
 * 試合タイマーの経過秒。`timerElapsedSecondsAtPause` は直近の一時停止までに
 * 積み上げた秒数で、試合中はそこに `timerServerStartedAt` からの経過を足す。
 */
export function elapsedSeconds(match: Match, nowMs: number): number {
  const banked = match.timerElapsedSecondsAtPause ?? 0;
  if (match.status !== "LIVE" || !match.timerServerStartedAt) return banked;
  const startedAt = Date.parse(match.timerServerStartedAt);
  // A clock that has not ticked past the (re)start must not count backwards.
  return banked + Math.floor((Math.max(nowMs, startedAt) - startedAt) / 1_000);
}

/** 状態を変えるときに送る PATCH。試合中から離れるときは経過秒を保存する。 */
export function statusPatch(match: Match, status: MatchStatus, nowMs = Date.now()): Partial<Match> {
  if (status === "LIVE") {
    return {
      status,
      timerServerStartedAt: new Date(nowMs).toISOString(),
      timerElapsedSecondsAtPause:
        match.status === "SCHEDULED" ? 0 : (match.timerElapsedSecondsAtPause ?? 0),
    };
  }
  return { status, timerElapsedSecondsAtPause: elapsedSeconds(match, nowMs) };
}
