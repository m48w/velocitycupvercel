import { useCallback, useEffect, useRef, useState } from "react";
import * as client from "../api/client";
import { shouldApply } from "../api/version";
import { initialMatches } from "../data";
import { applyMatchPatch } from "../logic";
import type { Match, TournamentState } from "../../../types";
import { ApiError } from "../../../utils/http";

export type ConnectionState = "connecting" | "live" | "offline";

const POLL_INTERVAL_MS = 2_000;

/** マウント時に旧バージョンが localStorage に残した試合データを捨てる。
 *  StrictMode などで複数回呼ばれても removeItem は冪等なので安全。 */
function dropLegacyStorage(): void {
  try {
    localStorage.removeItem("cupflow-matches");
  } catch {
    // プライベートモードなどで localStorage が使えなくても続行する。
  }
}

export function useTournamentState({ onUnauthorized }: { onUnauthorized?: () => void } = {}) {
  const [matches, setMatches] = useState<Match[]>(initialMatches);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const versionRef = useRef(0);

  /** The server's current truth. */
  const applyState = useCallback((state: TournamentState) => {
    versionRef.current = state.version;
    setMatches(state.matches);
  }, []);

  /** A mutating call's response, which may land after a newer SSE push. */
  const applyIfNewer = useCallback(
    (state: TournamentState) => {
      if (!shouldApply(state.version, versionRef.current, "response")) return;
      applyState(state);
    },
    [applyState],
  );

  useEffect(() => {
    dropLegacyStorage();

    let disposed = false;
    let inFlight = false;
    const poll = async () => {
      if (inFlight || disposed) return;
      inFlight = true;
      try {
        const state = await client.fetchState();
        if (disposed) return;
        setConnection("live");
        setError(null);
        if (shouldApply(state.version, versionRef.current, "push")) applyState(state);
      } catch (cause) {
        if (disposed) return;
        setConnection("offline");
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), POLL_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [applyState]);

  const run = useCallback(
    async (work: () => Promise<TournamentState>, onError?: () => Promise<void>) => {
      try {
        applyIfNewer(await work());
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        // The session ran out (12 hours) or was never valid: re-read it so the page shows the sign-in form.
        if (cause instanceof ApiError && cause.status === 401) onUnauthorized?.();
        await onError?.();
      }
    },
    [applyIfNewer, onUnauthorized],
  );

  /** Drops an optimistic change the server refused by reloading its truth. If
   *  that fails too, the next SSE push corrects the screen. */
  const resync = useCallback(async () => {
    try {
      applyState(await client.fetchState());
    } catch {
      // The error banner is already showing; wait for the stream to recover.
    }
  }, [applyState]);

  return {
    matches,
    connection,
    error,
    /** Drops the error banner, e.g. after signing back in makes it stale. */
    clearError: useCallback(() => setError(null), []),
    /** Applied to the screen at once so rapid score taps build on each other
     *  instead of each one starting from the last confirmed score. */
    patchMatch: useCallback(
      (id: string, patch: Partial<Match>) => {
        setMatches((current) => applyMatchPatch(current, id, patch));
        return run(() => client.patchMatch(id, patch), resync);
      },
      [run, resync],
    ),
    replaceMatches: useCallback((next: Match[]) => run(() => client.replaceMatches(next)), [run]),
    reset: useCallback(() => run(() => client.resetTournament()), [run]),
  };
}
