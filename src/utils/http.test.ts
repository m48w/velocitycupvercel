import { afterEach, expect, test, vi } from "vitest";
import { ApiError, requestJson } from "./http";

const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

afterEach(() => {
  vi.unstubAllGlobals();
});

test("GET 以外は本文が無くても content-type: application/json を付ける", async () => {
  const fetchMock = respond(200, { ok: true });
  vi.stubGlobal("fetch", fetchMock);
  await requestJson("/api/logout", { method: "POST" });
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(init.headers).toMatchObject({ "content-type": "application/json" });
});

test("GET には content-type を付けない", async () => {
  const fetchMock = respond(200, { session: null });
  vi.stubGlobal("fetch", fetchMock);
  await requestJson("/api/session");
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined];
  expect(init?.headers).toBeUndefined();
});

test("失敗した応答は status・code・retryAfterSeconds を持つ ApiError になる", async () => {
  vi.stubGlobal(
    "fetch",
    respond(429, {
      error: "too many failed attempts",
      code: "TOO_MANY_ATTEMPTS",
      retryAfterSeconds: 42,
    }),
  );
  const error = await requestJson("/api/login", { method: "POST" }).catch((cause) => cause);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({
    message: "too many failed attempts",
    status: 429,
    code: "TOO_MANY_ATTEMPTS",
    retryAfterSeconds: 42,
  });
});

test("セッション切れの 401 は status 401 の ApiError になる", async () => {
  vi.stubGlobal(
    "fetch",
    respond(401, { error: "sign in to change the tournament", code: "UNAUTHENTICATED" }),
  );
  const error = await requestJson("/api/reset", { method: "POST" }).catch((cause) => cause);
  expect(error).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
});

test("本文が JSON でない失敗でも ApiError になる", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("Bad Gateway", { status: 502 })),
  );
  const error = await requestJson("/api/state").catch((cause) => cause);
  expect(error).toMatchObject({ status: 502, message: "request failed: 502" });
});
