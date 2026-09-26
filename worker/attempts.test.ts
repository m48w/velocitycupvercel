import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { createLoginAttempts, type LoginAttempts } from "./attempts";

const T0 = 1_000_000;

function withAttempts<T>(fn: (attempts: LoginAttempts) => T): Promise<T> {
  const stub = env.TOURNAMENT.get(env.TOURNAMENT.idFromName(crypto.randomUUID()));
  return runInDurableObject(stub, (_instance, state) => fn(createLoginAttempts(state.storage.sql)));
}

const failTimes = (attempts: LoginAttempts, username: string, times: number, now = T0) => {
  for (let i = 0; i < times; i += 1) attempts.recordFailure(username, now);
};

test("4回までの失敗では拒否しない", async () => {
  const retry = await withAttempts((attempts) => {
    failTimes(attempts, "subadmin1", 4);
    return attempts.retryAfterSeconds("subadmin1", T0);
  });
  expect(retry).toBe(0);
});

test("5回続けて失敗すると最後の失敗から60秒拒否する", async () => {
  const retries = await withAttempts((attempts) => {
    failTimes(attempts, "subadmin1", 5);
    return [0, 1, 59_000, 59_999, 60_000].map((ms) =>
      attempts.retryAfterSeconds("subadmin1", T0 + ms),
    );
  });
  expect(retries).toEqual([60, 60, 1, 1, 0]);
});

test("拒否が明けた後の1回の失敗では、すぐに再び拒否しない", async () => {
  const retry = await withAttempts((attempts) => {
    failTimes(attempts, "subadmin1", 5);
    attempts.recordFailure("subadmin1", T0 + 60_000);
    return attempts.retryAfterSeconds("subadmin1", T0 + 60_000);
  });
  expect(retry).toBe(0);
});

test("clear で失敗回数が消える", async () => {
  const retry = await withAttempts((attempts) => {
    failTimes(attempts, "subadmin1", 4);
    attempts.clear("subadmin1");
    failTimes(attempts, "subadmin1", 4);
    return attempts.retryAfterSeconds("subadmin1", T0);
  });
  expect(retry).toBe(0);
});

test("失敗回数はユーザー名ごとに数える", async () => {
  const retries = await withAttempts((attempts) => {
    failTimes(attempts, "subadmin1", 5);
    return [
      attempts.retryAfterSeconds("subadmin1", T0),
      attempts.retryAfterSeconds("subadmin2", T0),
    ];
  });
  expect(retries).toEqual([60, 0]);
});
