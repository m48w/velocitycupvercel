import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { createLoginAttempts } from "./attempts";
import { handleLogin } from "./login";

const BASE = "http://localhost";

const call = async (path: string, init?: RequestInit) => {
  const response = await exports.default.fetch(`${BASE}${path}`, init);
  const body = await response.arrayBuffer();
  return new Response(body, { status: response.status, headers: response.headers });
};
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const login = (username: string, password: string) => post("/api/login", { username, password });
const cookieOf = (response: Response) => response.headers.get("set-cookie")!.split(";")[0];

test("正しいパスワードで 200 とセッション、session Cookie を返す", async () => {
  const response = await login("superadmin", "superadmin1234");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    session: { username: "superadmin", role: "superadmin", court: null },
  });
  expect(response.headers.get("set-cookie")).toMatch(
    /^session=[\w-]+\.[\w-]+; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=43200$/,
  );
});

test("SubAdmin は担当コートを返す", async () => {
  const response = await login("subadmin3", "subadmin1234");
  expect(await response.json()).toMatchObject({ session: { username: "subadmin3", court: 2 } });
});

test("ユーザー名の大文字と前後の空白は無視する", async () => {
  const response = await login("  SubAdmin4 ", "subadmin1234");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ session: { username: "subadmin4", court: 2 } });
});

test("間違ったパスワードは 401 で、Cookie を返さない", async () => {
  const response = await login("subadmin1", "wrong");
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ code: "INVALID_CREDENTIALS" });
  expect(response.headers.get("set-cookie")).toBeNull();
});

test("SubAdmin のパスワードでは superadmin に入れない", async () => {
  expect((await login("superadmin", "subadmin1234")).status).toBe(401);
});

test("存在しないユーザー名や組み込みプロパティ名は 401", async () => {
  for (const username of ["nobody", "constructor", "__proto__"]) {
    const response = await login(username, "subadmin1234");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "INVALID_CREDENTIALS" });
  }
});

test("ユーザー名やパスワードが文字列でなければ 400", async () => {
  for (const body of [{}, { username: "superadmin" }, { username: 1, password: "x" }, null]) {
    const response = await post("/api/login", body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_LOGIN" });
  }
});

test("5回続けて間違えると、正しいパスワードでも 429 と Retry-After を返す", async () => {
  for (let i = 0; i < 5; i += 1) expect((await login("subadmin5", "wrong")).status).toBe(401);
  const response = await login("subadmin5", "subadmin1234");
  expect(response.status).toBe(429);
  const body = (await response.json()) as { code: string; retryAfterSeconds: number };
  expect(body.code).toBe("TOO_MANY_ATTEMPTS");
  expect(body.retryAfterSeconds).toBeGreaterThan(55);
  expect(body.retryAfterSeconds).toBeLessThanOrEqual(60);
  expect(response.headers.get("retry-after")).toBe(String(body.retryAfterSeconds));
});

test("並行して10回間違えても、失敗として受け付けるのは5回までで残りは 429", async () => {
  const responses = await Promise.all(
    Array.from({ length: 10 }, () => login("subadmin6", "wrong")),
  );
  const statuses = responses.map((response) => response.status).sort();
  expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429, 429, 429, 429]);
});

test("Secret が未設定なら 500 AUTH_NOT_CONFIGURED で、空のパスワードでは通らない", async () => {
  const stub = env.TOURNAMENT.get(env.TOURNAMENT.idFromName(crypto.randomUUID()));
  // Response bodies are I/O objects tied to the Durable Object's context, so they must be
  // read here, before the callback returns, instead of on the Response objects afterwards.
  const results = await runInDurableObject(stub, async (_instance, state) => {
    const attempts = createLoginAttempts(state.storage.sql);
    const request = (password: string) =>
      new Request(`${BASE}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "superadmin", password }),
      });
    const responses = [
      await handleLogin(request(""), attempts, {}, Date.now()),
      await handleLogin(request("x"), attempts, { SUPERADMIN_PASSWORD: "x" }, Date.now()),
    ];
    return Promise.all(
      responses.map(async (response) => ({ status: response.status, body: await response.json() })),
    );
  });
  for (const result of results) {
    expect(result.status).toBe(500);
    expect(result.body).toMatchObject({ code: "AUTH_NOT_CONFIGURED" });
  }
});

test("GET /api/session は Cookie が無ければ null、あればログイン中の利用者を返す", async () => {
  expect(await (await call("/api/session")).json()).toEqual({ session: null });

  const cookie = cookieOf(await login("subadmin2", "subadmin1234"));
  const response = await call("/api/session", { headers: { cookie } });
  expect(await response.json()).toEqual({
    session: { username: "subadmin2", role: "subadmin", court: 1 },
  });
});

test("改ざんした Cookie は未ログイン扱い", async () => {
  const cookie = cookieOf(await login("subadmin2", "subadmin1234"));
  const tampered = `${cookie.slice(0, -2)}xx`;
  const response = await call("/api/session", { headers: { cookie: tampered } });
  expect(await response.json()).toEqual({ session: null });
});

test("POST /api/logout は Cookie を消す（未ログインでも 200）", async () => {
  const response = await post("/api/logout", {});
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toBe(
    "session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
  );
});

test("変更系のリクエストが JSON でなければ 415", async () => {
  const form = await call("/api/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "username=superadmin&password=superadmin1234",
  });
  expect(form.status).toBe(415);
  expect(await form.json()).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
  expect((await call("/api/reset", { method: "POST" })).status).toBe(415);
});

test("content-type の大文字や charset 付きは JSON として受け付ける", async () => {
  const response = await call("/api/login", {
    method: "POST",
    headers: { "content-type": "Application/JSON; charset=utf-8" },
    body: JSON.stringify({ username: "subadmin1", password: "subadmin1234" }),
  });
  expect(response.status).toBe(200);
});
