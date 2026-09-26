import { GROUP_IDS, R16_SEEDS, TBD } from "./schedule";
import type { Match, Team } from "../../types";

export interface Standing {
  team: Team;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
}

export function calculateStandings(groupId: string, teams: Team[], matches: Match[]): Standing[] {
  const rows = teams
    .filter((team) => team.groupId === groupId)
    .map((team) => ({
      team,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      points: 0,
    }));
  const byId = new Map(rows.map((row) => [row.team.id, row]));
  matches
    .filter((match) => match.groupId === groupId && match.status === "FINISHED")
    .forEach((match) => {
      const home = byId.get(match.homeTeamId);
      const away = byId.get(match.awayTeamId);
      if (!home || !away) return;
      home.played += 1;
      away.played += 1;
      home.goalsFor += match.homeScore;
      home.goalsAgainst += match.awayScore;
      away.goalsFor += match.awayScore;
      away.goalsAgainst += match.homeScore;
      if (match.homeScore > match.awayScore) {
        home.won += 1;
        home.points += 3;
        away.lost += 1;
      } else if (match.homeScore < match.awayScore) {
        away.won += 1;
        away.points += 3;
        home.lost += 1;
      } else {
        home.drawn += 1;
        away.drawn += 1;
        home.points += 1;
        away.points += 1;
      }
    });
  return rows.sort(
    (a, b) =>
      b.points - a.points ||
      b.goalsFor - b.goalsAgainst - (a.goalsFor - a.goalsAgainst) ||
      b.goalsFor - a.goalsFor,
  );
}

export const stageLabel: Record<Match["stage"], string> = {
  GROUP: "Group stage",
  R16: "Best 16",
  QF: "Best 8",
  SF: "Best 4",
  FINAL: "Final",
};

/**
 * グループ順位から Round of 16 の対戦相手を埋める。
 * 既存の試合の時刻・コート・ID は変更しない。QF 以降は TBD のまま。
 */
export function seedKnockoutTeams(teams: Team[], matches: Match[]): Match[] {
  const ranked = new Map<string, string[]>(
    GROUP_IDS.map((groupId): [string, string[]] => [
      groupId,
      calculateStandings(groupId, teams, matches).map((row) => row.team.id),
    ]),
  );
  const resolve = (seed: string) => ranked.get(seed[0])?.[Number(seed[1]) - 1] ?? TBD;

  return matches.map((match) => {
    if (match.stage !== "R16") return match;
    const seed = R16_SEEDS[Number(match.id.split("-")[1]) - 1];
    if (!seed) return match;
    return { ...match, homeTeamId: resolve(seed[0]), awayTeamId: resolve(seed[1]) };
  });
}

/** サーバーの返事を待たずに画面へ反映するため、1試合分の変更を重ねた新しい配列を返す。 */
export function applyMatchPatch(matches: Match[], id: string, patch: Partial<Match>): Match[] {
  return matches.map((match) => (match.id === id ? { ...match, ...patch } : match));
}

/** Live 画面に残す試合。一時停止中も残し、終了したら外す。 */
export const isOnPitch = (match: Match) => match.status === "LIVE" || match.status === "PAUSED";
