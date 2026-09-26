import { expect, test } from "vitest";
import { ApiError } from "../../utils/http";
import { loginErrorMessage } from "./messages";

test("401 はユーザー名かパスワードの誤り", () => {
  expect(loginErrorMessage(new ApiError("x", 401, "INVALID_CREDENTIALS"))).toBe(
    "Incorrect username or password.",
  );
});

test("429 は待つ秒数を示す", () => {
  expect(loginErrorMessage(new ApiError("x", 429, "TOO_MANY_ATTEMPTS", 42))).toBe(
    "Too many failed attempts. Try again in 42 seconds.",
  );
  expect(loginErrorMessage(new ApiError("x", 429, "TOO_MANY_ATTEMPTS"))).toBe(
    "Too many failed attempts. Try again in 60 seconds.",
  );
});

test("Secret 未設定は運営者に知らせる文言", () => {
  expect(loginErrorMessage(new ApiError("x", 500, "AUTH_NOT_CONFIGURED"))).toBe(
    "Sign-in is not set up on the server yet. Ask the organiser to set the passwords.",
  );
});

test("通信できないときは接続を確かめるよう促す", () => {
  expect(loginErrorMessage(new TypeError("Failed to fetch"))).toBe(
    "Could not reach the server. Check the connection and try again.",
  );
});

test("その他の API エラーはサーバーの文言をそのまま出す", () => {
  expect(loginErrorMessage(new ApiError("username and password are required", 400))).toBe(
    "username and password are required",
  );
});
