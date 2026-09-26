import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { createSqlStore, StoreError, type Store } from "./store";

function withStore<T>(fn: (store: Store) => T): Promise<T> {
  const stub = env.TOURNAMENT.get(env.TOURNAMENT.idFromName(crypto.randomUUID()));
  return runInDurableObject(stub, (_instance, state) => fn(createSqlStore(state.storage)));
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof StoreError) return error.code;
    throw error;
  }
  return undefined;
}

test("空の Durable Object では初期スケジュール95試合を version 1 で作る", async () => {
  const state = await withStore((store) => store.read());
  expect(state.version).toBe(1);
  expect(state.matches).toHaveLength(95);
  expect(state.matches.every((m) => m.status === "SCHEDULED")).toBe(true);
});

test("2回目の read は作り直さず同じ version を返す", async () => {
  const [first, second] = await withStore((store) => [store.read(), store.read()]);
  expect(second.version).toBe(first.version);
  expect(second.matches).toEqual(first.matches);
});

test("patchMatch は対象の試合だけを書き換え、version を1つ増やす", async () => {
  const { before, after } = await withStore((store) => {
    const before = store.read();
    const after = store.patchMatch(before.matches[0].id, { homeScore: 3, status: "LIVE" });
    return { before, after };
  });
  expect(after.version).toBe(before.version + 1);
  expect(after.matches[0]).toEqual({ ...before.matches[0], homeScore: 3, status: "LIVE" });
  expect(after.matches.slice(1)).toEqual(before.matches.slice(1));
});

test("試合の並び順は保存後も変わらない", async () => {
  const ids = await withStore((store) => {
    const before = store.read().matches.map((m) => m.id);
    store.patchMatch(before[10], { awayScore: 1 });
    return { before, after: store.read().matches.map((m) => m.id) };
  });
  expect(ids.after).toEqual(ids.before);
});

test("許可外フィールドの更新を拒否し、何も書き込まない", async () => {
  const result = await withStore((store) => {
    const before = store.read();
    const code = codeOf(() => store.patchMatch(before.matches[0].id, { court: 2 }));
    return { code, before, after: store.read() };
  });
  expect(result.code).toBe("FIELD_NOT_PATCHABLE");
  expect(result.after).toEqual(result.before);
});

test("型が不正な値の更新を拒否し、何も書き込まない", async () => {
  const result = await withStore((store) => {
    const before = store.read();
    const code = codeOf(() =>
      store.patchMatch(before.matches[0].id, { homeScore: "banana" as unknown as number }),
    );
    return { code, before, after: store.read() };
  });
  expect(result.code).toBe("INVALID_FIELD_VALUE");
  expect(result.after).toEqual(result.before);
});

test("存在しない試合IDを拒否する", async () => {
  const code = await withStore((store) => codeOf(() => store.patchMatch("NOPE", { homeScore: 1 })));
  expect(code).toBe("UNKNOWN_MATCH");
});

test("replaceMatches は全試合を置き換え、version を増やす", async () => {
  const result = await withStore((store) => {
    const before = store.read();
    const replaced = before.matches.map((m) => ({ ...m, homeScore: 9 }));
    return { before, after: store.replaceMatches(replaced) };
  });
  expect(result.after.version).toBe(result.before.version + 1);
  expect(result.after.matches.every((m) => m.homeScore === 9)).toBe(true);
});

test("replaceMatches は試合IDが重複していたら拒否し、何も書き込まない", async () => {
  const result = await withStore((store) => {
    const before = store.read();
    const code = codeOf(() => store.replaceMatches([before.matches[0], before.matches[0]]));
    return { code, before, after: store.read() };
  });
  expect(result.code).toBe("INVALID_MATCHES");
  expect(result.after).toEqual(result.before);
});

test("reset は全試合を未開始に戻し、version を増やす", async () => {
  const result = await withStore((store) => {
    const before = store.read();
    store.patchMatch(before.matches[0].id, { status: "FINISHED", homeScore: 2 });
    return { before, after: store.reset() };
  });
  expect(result.after.version).toBe(result.before.version + 2);
  expect(result.after.matches.every((m) => m.status === "SCHEDULED" && m.homeScore === 0)).toBe(
    true,
  );
});
