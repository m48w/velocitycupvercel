import { describe, expect, test } from "vitest";
import { teams } from "./data";
import {
  buildTournamentSchedule,
  findCourtConflicts,
  GROUP_MATCH_MINUTES,
  matchEndMs,
  TBD,
} from "./schedule";
import type { Match } from "../../types";

const schedule = buildTournamentSchedule(teams);

describe("buildTournamentSchedule", () => {
  test("生成する試合数はグループ80・ノックアウト15の計95", () => {
    expect(schedule).toHaveLength(95);
    expect(schedule.filter((m) => m.stage === "GROUP")).toHaveLength(80);
    expect(schedule.filter((m) => m.stage !== "GROUP")).toHaveLength(15);
  });

  test("全試合が未開始・スコア0・タイマーなし", () => {
    for (const match of schedule) {
      expect(match.status).toBe("SCHEDULED");
      expect(match.homeScore).toBe(0);
      expect(match.awayScore).toBe(0);
      expect(match.timerServerStartedAt).toBeUndefined();
      expect(match.timerElapsedSecondsAtPause).toBeUndefined();
    }
  });

  test("ノックアウトの対戦相手は TBD", () => {
    for (const match of schedule.filter((m) => m.stage !== "GROUP")) {
      expect(match.homeTeamId).toBe(TBD);
      expect(match.awayTeamId).toBe(TBD);
    }
  });

  test("コート重複が0件", () => {
    expect(findCourtConflicts(schedule)).toEqual([]);
  });

  test("同一チームの試合間隔が15分以上", () => {
    const byTeam = new Map<string, Match[]>();
    for (const match of schedule.filter((m) => m.stage === "GROUP")) {
      for (const teamId of [match.homeTeamId, match.awayTeamId]) {
        byTeam.set(teamId, [...(byTeam.get(teamId) ?? []), match]);
      }
    }

    expect(byTeam.size).toBe(40);
    for (const [teamId, played] of byTeam) {
      expect(played, `${teamId} の試合数`).toHaveLength(4);
      const ordered = [...played].sort(
        (a, b) => Date.parse(a.scheduledStart) - Date.parse(b.scheduledStart),
      );
      for (let i = 1; i < ordered.length; i += 1) {
        const restMinutes =
          (Date.parse(ordered[i].scheduledStart) - matchEndMs(ordered[i - 1])) / 60_000;
        expect(restMinutes, `${teamId} の休憩`).toBeGreaterThanOrEqual(GROUP_MATCH_MINUTES);
      }
    }
  });

  test("同一スロットに同じチームは2回現れない", () => {
    const bySlot = new Map<string, string[]>();
    for (const match of schedule.filter((m) => m.stage === "GROUP")) {
      bySlot.set(match.scheduledStart, [
        ...(bySlot.get(match.scheduledStart) ?? []),
        match.homeTeamId,
        match.awayTeamId,
      ]);
    }
    for (const [slot, teamIds] of bySlot) {
      expect(new Set(teamIds).size, `スロット ${slot}`).toBe(teamIds.length);
    }
  });

  test("Court 3 は 12:15 JST より前に試合を入れない", () => {
    const court3Opens = Date.parse("2026-09-26T12:15:00+09:00");
    const early = schedule.filter(
      (m) => m.court === 3 && Date.parse(m.scheduledStart) < court3Opens,
    );
    expect(early.map((m) => m.id)).toEqual([]);
    expect(
      schedule.some((m) => m.court === 3 && Date.parse(m.scheduledStart) === court3Opens),
    ).toBe(true);
  });

  test("グループ戦は31スロットに収まる", () => {
    const slots = new Set(schedule.filter((m) => m.stage === "GROUP").map((m) => m.scheduledStart));
    expect(slots.size).toBe(31);
  });

  test("試合時間は R16 18分・準々決勝と準決勝 15分（7分ハーフ+1分）・決勝 23分（10分ハーフ+3分）", () => {
    const minutes = (stage: Match["stage"]) =>
      new Set(schedule.filter((m) => m.stage === stage).map((m) => m.durationMinutes));
    expect(minutes("GROUP")).toEqual(new Set([GROUP_MATCH_MINUTES]));
    expect(minutes("R16")).toEqual(new Set([18]));
    expect(minutes("QF")).toEqual(new Set([15]));
    expect(minutes("SF")).toEqual(new Set([15]));
    expect(minutes("FINAL")).toEqual(new Set([23]));
  });

  test("各ラウンドは前のラウンド終了の18分後に始まる", () => {
    const stages: Match["stage"][] = ["GROUP", "R16", "QF", "SF", "FINAL"];
    for (let i = 1; i < stages.length; i += 1) {
      const previousEnd = Math.max(
        ...schedule.filter((m) => m.stage === stages[i - 1]).map(matchEndMs),
      );
      const start = Math.min(
        ...schedule.filter((m) => m.stage === stages[i]).map((m) => Date.parse(m.scheduledStart)),
      );
      expect((start - previousEnd) / 60_000, `${stages[i - 1]} → ${stages[i]}`).toBe(18);
    }
  });

  test("最終試合の終了は 2026-09-26 19:59 JST", () => {
    const finish = Math.max(...schedule.map(matchEndMs));
    expect(new Date(finish).toISOString()).toBe("2026-09-26T10:59:00.000Z");
  });

  test("同じ入力から常に同じ出力を返す", () => {
    expect(buildTournamentSchedule(teams)).toEqual(schedule);
  });
});
