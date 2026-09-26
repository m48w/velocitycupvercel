import { expect, test } from "vitest";
import { initialMatches, teams } from "./data";
import { seedKnockoutTeams } from "./logic";
import { TBD } from "./schedule";

test("初期データは全95試合が未開始", () => {
  expect(initialMatches).toHaveLength(95);
  expect(initialMatches.every((match) => match.status === "SCHEDULED")).toBe(true);
  expect(initialMatches.every((match) => match.homeScore === 0 && match.awayScore === 0)).toBe(
    true,
  );
});

test("seedKnockoutTeams は R16 の対戦相手を埋め、時刻とコートは変えない", () => {
  const snapshot = structuredClone(initialMatches);
  const seeded = seedKnockoutTeams(teams, initialMatches);
  const before = snapshot.filter((match) => match.stage === "R16");
  const after = seeded.filter((match) => match.stage === "R16");

  expect(after).toHaveLength(8);
  for (const match of after) {
    expect(match.homeTeamId).not.toBe(TBD);
    expect(match.awayTeamId).not.toBe(TBD);
  }
  for (const [index, match] of after.entries()) {
    expect(match.scheduledStart).toBe(before[index].scheduledStart);
    expect(match.court).toBe(before[index].court);
  }
});

test("seedKnockoutTeams はグループ戦と QF 以降を変更しない", () => {
  const snapshot = structuredClone(initialMatches);
  const seeded = seedKnockoutTeams(teams, initialMatches);
  expect(seeded.filter((match) => match.stage === "GROUP")).toEqual(
    snapshot.filter((match) => match.stage === "GROUP"),
  );
  expect(seeded.filter((match) => ["QF", "SF", "FINAL"].includes(match.stage))).toEqual(
    snapshot.filter((match) => ["QF", "SF", "FINAL"].includes(match.stage)),
  );
});
