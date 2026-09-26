import { expect, test } from "vitest";
import { initialMatches } from "./data";
import { applyMatchPatch, isOnPitch } from "./logic";

test("applyMatchPatch は指定した試合だけに変更を重ね、元の配列は変えない", () => {
  const [first, second] = initialMatches;
  const next = applyMatchPatch(initialMatches, first.id, { homeScore: 2, status: "LIVE" });

  expect(next.find((m) => m.id === first.id)).toEqual({ ...first, homeScore: 2, status: "LIVE" });
  expect(next.find((m) => m.id === second.id)).toBe(second);
  expect(initialMatches[0]).toBe(first);
  expect(first.homeScore).toBe(0);
});

test("applyMatchPatch は存在しない試合IDなら何も変えない", () => {
  expect(applyMatchPatch(initialMatches, "NOPE", { homeScore: 1 })).toEqual(initialMatches);
});

test("isOnPitch は試合中と一時停止中の試合だけを Live に残す", () => {
  const [match] = initialMatches;
  expect(isOnPitch({ ...match, status: "LIVE" })).toBe(true);
  expect(isOnPitch({ ...match, status: "PAUSED" })).toBe(true);
  expect(isOnPitch({ ...match, status: "SCHEDULED" })).toBe(false);
  expect(isOnPitch({ ...match, status: "FINISHED" })).toBe(false);
});
