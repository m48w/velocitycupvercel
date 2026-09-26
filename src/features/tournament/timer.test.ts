import { describe, expect, test } from "vitest";
import type { Match } from "../../types";
import { elapsedSeconds, statusPatch } from "./timer";

const T0 = Date.parse("2026-09-26T09:00:00+09:00");
const at = (seconds: number) => T0 + seconds * 1_000;
const iso = (seconds: number) => new Date(at(seconds)).toISOString();

const base: Match = {
  id: "G-A-1",
  stage: "GROUP",
  groupId: "A",
  court: 1,
  scheduledStart: iso(0),
  durationMinutes: 15,
  status: "SCHEDULED",
  homeTeamId: "A1",
  awayTeamId: "A2",
  homeScore: 0,
  awayScore: 0,
};

describe("elapsedSeconds", () => {
  test("未開始の試合は0秒", () => {
    expect(elapsedSeconds(base, at(100))).toBe(0);
  });

  test("試合中は開始からの経過秒に、一時停止前までの秒数を足す", () => {
    const live = {
      ...base,
      status: "LIVE" as const,
      timerServerStartedAt: iso(60),
      timerElapsedSecondsAtPause: 90,
    };
    expect(elapsedSeconds(live, at(100))).toBe(130);
  });

  test("一時停止中は止めた時点の秒数のまま進まない", () => {
    const paused = {
      ...base,
      status: "PAUSED" as const,
      timerServerStartedAt: iso(60),
      timerElapsedSecondsAtPause: 130,
    };
    expect(elapsedSeconds(paused, at(100))).toBe(130);
    expect(elapsedSeconds(paused, at(9_999))).toBe(130);
  });

  test("手元の時計が開始時刻より遅れていても逆算しない", () => {
    const live = {
      ...base,
      status: "LIVE" as const,
      timerServerStartedAt: iso(60),
      timerElapsedSecondsAtPause: 30,
    };
    expect(elapsedSeconds(live, at(10))).toBe(30);
  });

  test("一時停止前の秒数が無い古いデータの試合中は開始からの秒数だけ数える", () => {
    const live = { ...base, status: "LIVE" as const, timerServerStartedAt: iso(0) };
    expect(elapsedSeconds(live, at(45))).toBe(45);
  });
});

describe("statusPatch", () => {
  test("開始するとタイマーを0から動かす", () => {
    expect(statusPatch(base, "LIVE", at(10))).toEqual({
      status: "LIVE",
      timerServerStartedAt: iso(10),
      timerElapsedSecondsAtPause: 0,
    });
  });

  test("一時停止するとそれまでの経過秒を保存する", () => {
    const live = {
      ...base,
      status: "LIVE" as const,
      timerServerStartedAt: iso(0),
      timerElapsedSecondsAtPause: 0,
    };
    expect(statusPatch(live, "PAUSED", at(300))).toEqual({
      status: "PAUSED",
      timerElapsedSecondsAtPause: 300,
    });
  });

  test("再開すると止めた秒数の続きから数える", () => {
    const paused = {
      ...base,
      status: "PAUSED" as const,
      timerServerStartedAt: iso(0),
      timerElapsedSecondsAtPause: 300,
    };
    const resumed = { ...paused, ...statusPatch(paused, "LIVE", at(500)) };
    expect(resumed.timerElapsedSecondsAtPause).toBe(300);
    expect(elapsedSeconds(resumed, at(520))).toBe(320);
  });

  test("試合中に終了すると最終の経過秒を保存する", () => {
    const live = {
      ...base,
      status: "LIVE" as const,
      timerServerStartedAt: iso(0),
      timerElapsedSecondsAtPause: 0,
    };
    expect(statusPatch(live, "FINISHED", at(900))).toEqual({
      status: "FINISHED",
      timerElapsedSecondsAtPause: 900,
    });
  });

  test("一時停止中に終了すると止めた秒数のまま終わる", () => {
    const paused = {
      ...base,
      status: "PAUSED" as const,
      timerServerStartedAt: iso(0),
      timerElapsedSecondsAtPause: 300,
    };
    expect(statusPatch(paused, "FINISHED", at(900))).toEqual({
      status: "FINISHED",
      timerElapsedSecondsAtPause: 300,
    });
  });
});
