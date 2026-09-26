import type { Match, Team } from "../../types";

export const COURT_COUNT = 3;
export const GROUP_MATCH_MINUTES = 15;
/** ラウンド間の休憩。グループ戦終了から R16 開始までも同じ。 */
export const ROUND_BREAK_MINUTES = 18;
export const TOURNAMENT_START = "2026-09-26T09:00:00+09:00";
/** Court 3 はこの時刻から使える。それより前は Court 1・2 のみ。 */
export const COURT_3_OPENS_AT = "2026-09-26T12:15:00+09:00";
export const TBD = "TBD";
export const GROUP_IDS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;

/** Round of 16 のシード表。`A1` は Group A の1位を指す。 */
export const R16_SEEDS = [
  ["A1", "H2"],
  ["H1", "A2"],
  ["B1", "G2"],
  ["G1", "B2"],
  ["C1", "F2"],
  ["F1", "C2"],
  ["D1", "E2"],
  ["E1", "D2"],
] as const;

/** 試合時間はハーフタイム込み。QF・SF は7分ハーフ+1分、決勝は10分ハーフ+3分。 */
const KNOCKOUT_ROUNDS = [
  { stage: "R16", count: 8, minutes: 18, sourcePrefix: null },
  { stage: "QF", count: 4, minutes: 7 * 2 + 1, sourcePrefix: "R16" },
  { stage: "SF", count: 2, minutes: 7 * 2 + 1, sourcePrefix: "QF" },
  { stage: "FINAL", count: 1, minutes: 10 * 2 + 3, sourcePrefix: "SF" },
] as const;

interface Pairing {
  id: string;
  groupId: string;
  homeTeamId: string;
  awayTeamId: string;
}

export function matchEndMs(match: Match): number {
  return Date.parse(match.scheduledStart) + match.durationMinutes * 60_000;
}

/** 同じコートで時間帯が重なる試合の組を返す。重複がなければ空配列。 */
export function findCourtConflicts(matches: Match[]): [Match, Match][] {
  const conflicts: [Match, Match][] = [];
  const ordered = [...matches].sort(
    (a, b) => Date.parse(a.scheduledStart) - Date.parse(b.scheduledStart),
  );
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const [a, b] = [ordered[i], ordered[j]];
      if (Date.parse(b.scheduledStart) >= matchEndMs(a)) break;
      if (a.court === b.court) conflicts.push([a, b]);
    }
  }
  return conflicts;
}

function buildGroupPairings(teams: Team[]): Pairing[] {
  const pairings: Pairing[] = [];
  for (const groupId of GROUP_IDS) {
    const ids = teams.filter((team) => team.groupId === groupId).map((team) => team.id);
    let number = 1;
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        pairings.push({
          id: `G-${groupId}-${number}`,
          groupId,
          homeTeamId: ids[i],
          awayTeamId: ids[j],
        });
        number += 1;
      }
    }
  }
  return pairings;
}

/**
 * 15分スロットへ貪欲に詰める。
 * 制約: 1スロットの試合数は `courtsAt(スロット番号)` まで、同一スロットに同じ
 * チームは1回まで、直前スロットに出たチームは選ばない（休憩15分以上）。
 */
function packIntoSlots(pairings: Pairing[], courtsAt: (slotIndex: number) => number): Pairing[][] {
  const remaining = new Map<string, number>();
  for (const pairing of pairings) {
    remaining.set(pairing.homeTeamId, (remaining.get(pairing.homeTeamId) ?? 0) + 1);
    remaining.set(pairing.awayTeamId, (remaining.get(pairing.awayTeamId) ?? 0) + 1);
  }

  const load = (pairing: Pairing) =>
    (remaining.get(pairing.homeTeamId) ?? 0) + (remaining.get(pairing.awayTeamId) ?? 0);

  const unscheduled = new Set(pairings);
  const slots: Pairing[][] = [];
  let previousSlotTeams = new Set<string>();
  const maxSlots = pairings.length + 1;

  while (unscheduled.size > 0) {
    if (slots.length >= maxSlots) {
      throw new Error(`schedule packing failed: ${unscheduled.size} matches could not be placed`);
    }

    const busy = new Set<string>();
    const slot: Pairing[] = [];
    const candidates = [...unscheduled]
      .filter(
        (pairing) =>
          !previousSlotTeams.has(pairing.homeTeamId) && !previousSlotTeams.has(pairing.awayTeamId),
      )
      .sort((a, b) => load(b) - load(a) || a.id.localeCompare(b.id));

    for (const pairing of candidates) {
      if (slot.length >= courtsAt(slots.length)) break;
      if (busy.has(pairing.homeTeamId) || busy.has(pairing.awayTeamId)) continue;
      slot.push(pairing);
      busy.add(pairing.homeTeamId);
      busy.add(pairing.awayTeamId);
    }

    for (const pairing of slot) {
      unscheduled.delete(pairing);
      remaining.set(pairing.homeTeamId, (remaining.get(pairing.homeTeamId) ?? 0) - 1);
      remaining.set(pairing.awayTeamId, (remaining.get(pairing.awayTeamId) ?? 0) - 1);
    }

    slots.push(slot);
    previousSlotTeams = busy;
  }

  return slots;
}

/**
 * 全95試合を未開始状態で生成する。
 * グループ戦は 09:00 から15分刻み（Court 3 は 12:15 から）、ノックアウトは
 * グループ戦終了の18分後から始め、ラウンド間にも18分の休憩を挟む。
 */
export function buildTournamentSchedule(teams: Team[]): Match[] {
  const startMs = Date.parse(TOURNAMENT_START);
  const court3OpensMs = Date.parse(COURT_3_OPENS_AT);
  const slotStartMs = (slotIndex: number) => startMs + slotIndex * GROUP_MATCH_MINUTES * 60_000;
  const slots = packIntoSlots(buildGroupPairings(teams), (slotIndex) =>
    slotStartMs(slotIndex) < court3OpensMs ? COURT_COUNT - 1 : COURT_COUNT,
  );

  const groupMatches: Match[] = slots.flatMap((slot, slotIndex) =>
    slot.map((pairing, courtIndex) => ({
      id: pairing.id,
      stage: "GROUP" as const,
      groupId: pairing.groupId,
      court: courtIndex + 1,
      scheduledStart: new Date(slotStartMs(slotIndex)).toISOString(),
      durationMinutes: GROUP_MATCH_MINUTES,
      status: "SCHEDULED" as const,
      homeTeamId: pairing.homeTeamId,
      awayTeamId: pairing.awayTeamId,
      homeScore: 0,
      awayScore: 0,
    })),
  );

  const knockoutMatches: Match[] = [];
  let roundStartMs = slotStartMs(slots.length) + ROUND_BREAK_MINUTES * 60_000;

  for (const round of KNOCKOUT_ROUNDS) {
    for (let index = 0; index < round.count; index += 1) {
      const row = Math.floor(index / COURT_COUNT);
      knockoutMatches.push({
        id: `${round.stage}-${index + 1}`,
        stage: round.stage,
        court: (index % COURT_COUNT) + 1,
        scheduledStart: new Date(roundStartMs + row * round.minutes * 60_000).toISOString(),
        durationMinutes: round.minutes,
        status: "SCHEDULED",
        homeTeamId: TBD,
        awayTeamId: TBD,
        homeScore: 0,
        awayScore: 0,
        ...(round.sourcePrefix
          ? {
              sourceMatchIds: [
                `${round.sourcePrefix}-${index * 2 + 1}`,
                `${round.sourcePrefix}-${index * 2 + 2}`,
              ],
            }
          : {}),
      });
    }
    const rows = Math.ceil(round.count / COURT_COUNT);
    roundStartMs += (rows * round.minutes + ROUND_BREAK_MINUTES) * 60_000;
  }

  return [...groupMatches, ...knockoutMatches];
}
