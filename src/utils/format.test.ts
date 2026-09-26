import { expect, test } from "vitest";
import { formatClock, formatTime } from "./format";

test("表示時刻は閲覧端末のタイムゾーンに依存しない", () => {
  expect(formatTime("2026-09-26T09:00:00+09:00")).toBe("09:00");
  expect(formatTime("2026-09-26T10:03:00.000Z")).toBe("19:03");
});

test("formatClock は経過秒を mm:ss で表す", () => {
  expect(formatClock(0)).toBe("00:00");
  expect(formatClock(75)).toBe("01:15");
  expect(formatClock(23 * 60)).toBe("23:00");
});
