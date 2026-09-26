import { expect, test } from "vitest";
import {
  accountFor,
  newSession,
  passwordFor,
  passwordMatches,
  readIdentity,
  readSessionToken,
  sessionCookie,
  signSession,
  verifySession,
  withIdentity,
  type Session,
} from "./auth";

const SECRET = "unit-test-secret";
const NOW = Date.UTC(2026, 8, 26, 0, 0, 0);

const toBase64url = (text: string) =>
  btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

test("アカウントは superadmin と subadmin1〜6 で、SubAdmin は2人ずつ Court 1〜3 を担当する", () => {
  expect(accountFor("superadmin")).toEqual({ role: "superadmin", court: null });
  expect([1, 2, 3, 4, 5, 6].map((n) => accountFor(`subadmin${n}`)?.court)).toEqual([
    1, 1, 2, 2, 3, 3,
  ]);
  expect(accountFor("subadmin7")).toBeUndefined();
});

test("Object の組み込みプロパティ名はアカウントとして扱わない", () => {
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    expect(accountFor(name)).toBeUndefined();
  }
  expect(accountFor(undefined)).toBeUndefined();
  expect(accountFor(42)).toBeUndefined();
});

test("パスワードは役割ごとの Secret から読み、未設定や空文字なら undefined", () => {
  const env = { SUPERADMIN_PASSWORD: "s", SUBADMIN_PASSWORD: "b" };
  expect(passwordFor("superadmin", env)).toBe("s");
  expect(passwordFor("subadmin4", env)).toBe("b");
  expect(passwordFor("subadmin4", { SUBADMIN_PASSWORD: "" })).toBeUndefined();
  expect(passwordFor("superadmin", {})).toBeUndefined();
  expect(passwordFor("nobody", env)).toBeUndefined();
});

test("passwordMatches は一致だけを true にし、長さが違っても例外を投げない", async () => {
  expect(await passwordMatches("subadmin1234", "subadmin1234")).toBe(true);
  expect(await passwordMatches("subadmin1235", "subadmin1234")).toBe(false);
  expect(await passwordMatches("x", "subadmin1234")).toBe(false);
  expect(await passwordMatches("", "subadmin1234")).toBe(false);
});

test("newSession は12時間後に切れ、ログインのたびに別の deviceId を持つ", () => {
  const a = newSession("subadmin3", NOW);
  const b = newSession("subadmin3", NOW);
  expect(a).toMatchObject({ username: "subadmin3", role: "subadmin", court: 2 });
  expect(a.exp).toBe(NOW / 1000 + 12 * 60 * 60);
  expect(a.deviceId).not.toBe(b.deviceId);
});

test("署名したセッションは同じ鍵で検証でき、中身が戻る", async () => {
  const session = newSession("subadmin5", NOW);
  const token = await signSession(session, SECRET);
  expect(await verifySession(token, SECRET, NOW)).toEqual(session);
});

test("鍵が違う・鍵が無い・期限切れのセッションは無効", async () => {
  const token = await signSession(newSession("superadmin", NOW), SECRET);
  expect(await verifySession(token, "other-secret", NOW)).toBeNull();
  expect(await verifySession(token, undefined, NOW)).toBeNull();
  expect(await verifySession(token, "", NOW)).toBeNull();
  expect(await verifySession(token, SECRET, NOW + 12 * 60 * 60 * 1000)).toBeNull();
  expect(await verifySession(token, SECRET, NOW + 12 * 60 * 60 * 1000 - 1)).not.toBeNull();
});

test("中身を書き換えたセッションは無効（SubAdmin を Super-admin に変える攻撃）", async () => {
  const session = newSession("subadmin1", NOW);
  const [, signature] = (await signSession(session, SECRET)).split(".");
  const forged: Session = { ...session, username: "superadmin", role: "superadmin", court: null };
  const token = `${toBase64url(JSON.stringify(forged))}.${signature}`;
  expect(await verifySession(token, SECRET, NOW)).toBeNull();
});

test("正しく署名されていてもアカウント表と役割・コートが食い違えば無効", async () => {
  const wrongCourt = { ...newSession("subadmin1", NOW), court: 3 };
  expect(await verifySession(await signSession(wrongCourt, SECRET), SECRET, NOW)).toBeNull();
  const unknown = { ...newSession("subadmin1", NOW), username: "constructor" };
  expect(await verifySession(await signSession(unknown, SECRET), SECRET, NOW)).toBeNull();
});

test("形の壊れたトークンは例外を投げず無効", async () => {
  for (const token of ["", "abc", "a.b.c", "!!!.???", `${toBase64url("not json")}.AAAA`]) {
    expect(await verifySession(token, SECRET, NOW)).toBeNull();
  }
});

test("session Cookie は HttpOnly・Secure・SameSite=Strict・12時間", () => {
  expect(sessionCookie("TOKEN")).toBe(
    "session=TOKEN; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200",
  );
});

test("readSessionToken は他の Cookie に混ざった session を取り出す", () => {
  expect(readSessionToken("theme=dark; session=abc.def; lang=ja")).toBe("abc.def");
  expect(readSessionToken("theme=dark")).toBeNull();
  expect(readSessionToken(null)).toBeNull();
});

test("withIdentity は外から来た x-auth-* を必ず消し、検証済みの利用者だけを載せる", async () => {
  const spoofed = new Request("http://localhost/api/reset", {
    headers: { "x-auth-username": "superadmin", "x-auth-device": "evil" },
  });
  expect(readIdentity(withIdentity(spoofed, null).headers)).toBeNull();

  const session = newSession("subadmin2", NOW);
  const identity = readIdentity(withIdentity(spoofed, session).headers);
  expect(identity).toEqual({
    username: "subadmin2",
    role: "subadmin",
    court: 1,
    deviceId: session.deviceId,
  });
});
