import { expect, test } from "vitest";
import { initialMatches } from "../data";
import { parseServerMessage, reconnectDelay, socketUrl } from "./socket";

test("socketUrl は http のページでは ws:// を使う", () => {
  expect(socketUrl({ protocol: "http:", host: "localhost:5173" })).toBe(
    "ws://localhost:5173/api/ws",
  );
});

test("socketUrl は https のページでは wss:// を使う", () => {
  expect(socketUrl({ protocol: "https:", host: "cup.example.com" })).toBe(
    "wss://cup.example.com/api/ws",
  );
});

test("reconnectDelay は 1秒から倍々に延ばし、10秒で頭打ちにする", () => {
  expect([0, 1, 2, 3, 4, 10].map(reconnectDelay)).toEqual([
    1_000, 2_000, 4_000, 8_000, 10_000, 10_000,
  ]);
});

test("parseServerMessage は state メッセージから TournamentState を取り出す", () => {
  const state = { version: 3, updatedAt: "2026-09-26T00:00:00.000Z", matches: initialMatches };
  expect(parseServerMessage(JSON.stringify({ type: "state", state }))).toEqual(state);
});

test("parseServerMessage は pong や壊れたメッセージを無視する", () => {
  expect(parseServerMessage("pong")).toBeNull();
  expect(parseServerMessage("{not json")).toBeNull();
  expect(parseServerMessage(JSON.stringify({ type: "other" }))).toBeNull();
  expect(parseServerMessage(JSON.stringify({ type: "state", state: { version: "x" } }))).toBeNull();
  expect(parseServerMessage(new ArrayBuffer(4))).toBeNull();
});
