import type { Match, TournamentState } from "../../../types";
import { requestJson } from "../../../utils/http";

const request = (path: string, init?: RequestInit) => requestJson<TournamentState>(path, init);

export const fetchState = () => request("/api/state");

export const patchMatch = (id: string, patch: Partial<Match>) =>
  request(`/api/matches/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });

export const replaceMatches = (matches: Match[]) =>
  request("/api/matches", { method: "PUT", body: JSON.stringify({ matches }) });

export const resetTournament = () => request("/api/reset", { method: "POST", body: "{}" });
