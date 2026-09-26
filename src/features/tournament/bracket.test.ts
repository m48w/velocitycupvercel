import { expect, test } from "vitest";
import { bracketRounds } from "./bracket";
import { initialMatches, teams } from "./data";
import { applyMatchPatch } from "./logic";

test("bracketRounds は R16・QF・SF・決勝を 8・4・2・1 試合の順で返す", () => {
  const rounds = bracketRounds(initialMatches);
  expect(rounds.map((round) => round.title)).toEqual([
    "Round of 16",
    "Quarter-finals",
    "Semi-finals",
    "Final",
  ]);
  expect(rounds.map((round) => round.games.map((game) => game.id))).toEqual([
    ["R16-1", "R16-2", "R16-3", "R16-4", "R16-5", "R16-6", "R16-7", "R16-8"],
    ["QF-1", "QF-2", "QF-3", "QF-4"],
    ["SF-1", "SF-2"],
    ["FINAL-1"],
  ]);
});

test("各試合は、前のラウンドで隣り合う2試合の勝者どうしの対戦になる（線がつながる順）", () => {
  const rounds = bracketRounds(initialMatches);
  for (let r = 1; r < rounds.length; r += 1) {
    rounds[r].games.forEach((game, index) => {
      const feeders = rounds[r - 1].games.slice(index * 2, index * 2 + 2).map((g) => g.id);
      expect(game.sourceMatchIds).toEqual(feeders);
    });
  }
});

test("対戦相手が未定の間は、R16 はシード、以降は勝者の枠を表示する", () => {
  const [r16, qf, sf, final] = bracketRounds(initialMatches);
  expect([r16.games[0].home, r16.games[0].away]).toEqual(["A1", "H2"]);
  expect([r16.games[7].home, r16.games[7].away]).toEqual(["E1", "D2"]);
  expect([qf.games[0].home, qf.games[0].away]).toEqual(["Winner M1", "Winner M2"]);
  expect([sf.games[1].home, sf.games[1].away]).toEqual(["Winner QF3", "Winner QF4"]);
  expect([final.games[0].home, final.games[0].away]).toEqual(["Winner SF1", "Winner SF2"]);
});

test("未開始の試合はスコアを出さず、始まった試合はチーム名とスコアを出す", () => {
  const [home, away] = teams;
  const started = applyMatchPatch(initialMatches, "R16-1", {
    homeTeamId: home.id,
    awayTeamId: away.id,
    status: "LIVE",
    homeScore: 2,
    awayScore: 1,
  });
  const [r16] = bracketRounds(started);
  expect(r16.games[0]).toMatchObject({
    home: home.name,
    away: away.name,
    homeScore: 2,
    awayScore: 1,
  });
  expect(r16.games[1].homeScore).toBeNull();
  expect(r16.games[1].awayScore).toBeNull();
});

test("試合ごとに開始時刻とコートを持つ", () => {
  const [r16] = bracketRounds(initialMatches);
  const source = initialMatches.find((match) => match.id === "R16-1")!;
  expect(r16.games[0]).toMatchObject({
    scheduledStart: source.scheduledStart,
    court: source.court,
  });
});
