# 段階0: Cloudflare 基盤への移行 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vite 開発サーバーの API（`server/`）と `TempServerData/matches.json` を、Cloudflare Worker + SQLite Durable Object + WebSocket 配信に置き換える。画面から見える挙動は現行のまま（認証はまだ入れない）。

**Architecture:** Worker は `/api/*` を名前 `main` の Durable Object `TournamentRoom` へ転送し、それ以外は静的アセット（SPA）を返す。Durable Object は SQLite に試合と version を持ち、HTTP の変更を直列に処理して、成功のたびに接続中の全 WebSocket へ新しい state を送る。クライアントは SSE の代わりに WebSocket で受信し、切断時は間隔を延ばしながら再接続する。

**Tech Stack:** React 18 / TypeScript 5.9 / Vite 7.3 / @vitejs/plugin-react 5.2 / @cloudflare/vite-plugin / wrangler 4 / Durable Objects（SQLite, WebSocket Hibernation）/ vitest 4.1 / @cloudflare/vitest-plugin

**Spec:** `docs/superpowers/specs/2026-09-25-cloudflare-admin-design.md`（§5, §6.1, §6.3, §11.1, §12, §13）

## Global Constraints

- 段階0では認証を加えない。API は現行どおり誰でも呼べる。
- API の形は現行を保つ: `GET /api/state`、`PATCH /api/matches/:id`、`PUT /api/matches`、`POST /api/reset`。`GET /api/stream`（SSE）は `GET /api/ws`（WebSocket）に置き換える。
- エラー応答は `{ "error": "...", "code": "..." }`。`UNKNOWN_MATCH` は `404`、その他の入力エラーは `400`。
- WebSocket でサーバーが送るメッセージは `{"type":"state","state":TournamentState}` の1種類のみ。クライアントが送る `ping` にはサーバーが `pong` を返す。
- Durable Object はメモリ上に試合データをキャッシュしない。常に SQLite から読む（休止・退避から戻っても正しい state を返すため）。
- 版: vite `^7.3`、@vitejs/plugin-react `^5.2`、vitest `^4.1.11`（@cloudflare/vitest-plugin が vitest `^4.1.0` を要求するため）。
- Worker 名 `velocity-cup`、Durable Object バインディング `TOURNAMENT`、クラス名 `TournamentRoom`、インスタンス名 `"main"`、アセットバインディング `ASSETS`。
- 表示時刻のタイムゾーンは `Asia/Tokyo` 固定（既存 `utils/format.ts`）。
- テスト名は既存に合わせて日本語で書く。
- `npm run lint`、`npm run format:check`、`npm run typecheck`、`npm test`、`npm run build` がすべて通ること。

## Review Focus

- **Durable Object の休止・退避から戻ったとき** — 直前の更新が残っていること。Task 3 に「退避後も更新済みのスコアを返す」テストを置く。
- **複数端末からの同時 PATCH** — どれも失われないこと。Task 3 に並行 PATCH のテストを置く。
- **配信中に閉じていた WebSocket** — 変更自体は成功し、他の接続にも届くこと。Task 3 にテストを置く。
- **サーバーから JSON でない・形の違うメッセージが届いたとき（`pong` など）** — クライアントが落ちずに無視すること。Task 4 の `parseServerMessage` テスト。
- **https で配信されたページ** — `wss://` で接続すること（`ws://` は混在コンテンツで拒否される）。Task 4 の `socketUrl` テスト。

---

## File Structure

| ファイル | 責務 |
|---|---|
| `wrangler.jsonc` | Worker・アセット・Durable Object・マイグレーションの設定 |
| `worker-configuration.d.ts` | `wrangler types` が生成する `Env` とランタイムの型（コミットする） |
| `tsconfig.worker.json` | Worker 側の型チェック設定 |
| `vitest.config.ts` | テストを2つのプロジェクトに分ける（`app` は Node、`worker` は workerd） |
| `worker/index.ts` | Worker の入口。`/api/*` を Durable Object へ、それ以外をアセットへ |
| `worker/room.ts` | `TournamentRoom`。HTTP を `handleApi` に渡し、WebSocket の受付と配信を行う |
| `worker/api.ts` | `handleApi(request, store, broadcast)`。ルーティング・入力の読み取り・エラー応答 |
| `worker/store.ts` | SQLite の読み書きと入力検証（旧 `server/store.ts` の置き換え） |
| `worker/http.ts` | `jsonResponse` |
| `worker/*.test.ts` | workerd 上のテスト |
| `src/types/index.ts` | `ServerMessage` 型を追加 |
| `src/features/tournament/api/socket.ts` | `socketUrl` / `reconnectDelay` / `parseServerMessage`（純粋関数） |
| `src/features/tournament/hooks/useTournamentState.ts` | SSE を WebSocket に置き換える |
| `src/features/tournament/api/version.ts` | 受信元の名前 `"sse"` を `"push"` に変える |
| 削除 | `server/`、`TempServerData/`、`server/tempDataPlugin.ts` |

---

### Task 1: ツールの更新と Worker の骨組み

**Files:**
- Modify: `package.json`、`package-lock.json`、`vite.config.ts`（変更なしで動くことを確認するだけ）、`tsconfig.json`、`tsconfig.node.json`、`eslint.config.js`、`.prettierignore`、`.gitignore`
- Create: `wrangler.jsonc`、`worker-configuration.d.ts`（生成）、`tsconfig.worker.json`、`vitest.config.ts`、`worker/index.ts`、`worker/room.ts`、`worker/http.ts`
- Test: `worker/index.test.ts`

**Interfaces:**
- Produces: `jsonResponse(status: number, body: unknown): Response`（`worker/http.ts`）、`TournamentRoom`（`worker/room.ts`、この時点では全リクエストに 404 を返す）、グローバル型 `Env`（`TOURNAMENT: DurableObjectNamespace<TournamentRoom>`、`ASSETS: Fetcher`）

- [ ] **Step 1: 依存を更新・追加する**

```bash
npm i -D vite@^7.3 @vitejs/plugin-react@^5.2 vitest@^4.1.11 @cloudflare/vite-plugin wrangler @cloudflare/vitest-plugin
```

`npm ls vite vitest @cloudflare/vite-plugin wrangler @cloudflare/vitest-plugin --depth=0` で、peer 依存の警告が出ていないことを確認する。

- [ ] **Step 2: 既存テストとビルドが新しい版で通ることを確認する**

Run: `npx vitest run && npm run build`
Expected: 既存の 59 件がすべて PASS、ビルド成功。vitest 4 で壊れたテストがあれば、この時点で原因を直す（テストの意味は変えない）。

- [ ] **Step 3: `wrangler.jsonc` を作る**

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "velocity-cup",
  "main": "./worker/index.ts",
  "compatibility_date": "2026-09-01",
  "assets": {
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"],
  },
  "durable_objects": {
    "bindings": [{ "name": "TOURNAMENT", "class_name": "TournamentRoom" }],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["TournamentRoom"] }],
}
```

`compatibility_date` がローカルの workerd より新しいと警告が出る。その場合は警告が示す日付に下げる。

- [ ] **Step 4: Worker の骨組みを書く**

`worker/http.ts`:

```ts
export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
```

`worker/room.ts`（Task 3 で中身を入れる）:

```ts
import { DurableObject } from "cloudflare:workers";
import { jsonResponse } from "./http";

export class TournamentRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    return jsonResponse(404, { error: `no route for ${request.method} ${url.pathname}` });
  }
}
```

`worker/index.ts`:

```ts
import { TournamentRoom } from "./room";

export { TournamentRoom };

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return env.TOURNAMENT.get(env.TOURNAMENT.idFromName("main")).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 5: 型を生成し、tsconfig を分ける**

```bash
npx wrangler types
```

`worker-configuration.d.ts` が生成され、`Env` に `TOURNAMENT` と `ASSETS` が入っていることを確認する。`package.json` の scripts に `"cf-typegen": "wrangler types"` を追加する。

`tsconfig.worker.json`:

```json
{
  "compilerOptions": {
    "composite": true,
    "outDir": "./node_modules/.tmp/worker-build",
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.worker.tsbuildinfo",
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": ["./worker-configuration.d.ts", "@cloudflare/vitest-plugin/types"]
  },
  "include": [
    "worker",
    "src/types/index.ts",
    "src/features/tournament/data.ts",
    "src/features/tournament/schedule.ts"
  ]
}
```

`tsconfig.json` の `references` に `{ "path": "./tsconfig.worker.json" }` を追加する。`tsconfig.node.json` の `include` に `"vitest.config.ts"` を追加する（`server/` と `src/` の行は Task 4 で消す）。

- [ ] **Step 6: vitest をプロジェクトに分ける**

`vitest.config.ts`（vitest は `vite.config.ts` より `vitest.config.ts` を優先するので、Task 4 で `vite.config.ts` に Cloudflare プラグインを入れてもテストに影響しない）:

```ts
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "app",
          include: ["src/**/*.test.ts", "server/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
        test: { name: "worker", include: ["worker/**/*.test.ts"] },
      },
    ],
  },
});
```

- [ ] **Step 7: 失敗するテストを書く**

`worker/index.test.ts`:

```ts
import { exports } from "cloudflare:workers";
import { expect, test } from "vitest";

test("/api/* は Durable Object に届き、未定義のルートには JSON の 404 を返す", async () => {
  const response = await exports.default.fetch("http://localhost/api/nope");
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({ error: "no route for GET /api/nope" });
});
```

- [ ] **Step 8: テストを実行する**

Run: `npx vitest run --project worker`
Expected: PASS（Step 4 で骨組みを先に書いているため）。**先に `worker/room.ts` の 404 の本文を `{ error: "x" }` に変えて FAIL することを確かめ、戻して PASS を確認する**（テストが本当に Durable Object の応答を見ていることの確認）。

`cloudflareTest` をプロジェクトの `plugins` に書く形で動かない場合（プラグインが読み込まれない・`cloudflare:workers` が解決できない）は、`vitest.worker.config.ts` に `defineConfig({ plugins: [cloudflareTest(...)], test: { include: ["worker/**/*.test.ts"] } })` を分け、`package.json` の `test` を `vitest run && vitest run --config vitest.worker.config.ts` にする。アセットのディレクトリが無いというエラーが出る場合は、`cloudflareTest` のオプションでアセットを無効にするか、`npm run build` 後に実行する形にし、どちらにしたかを計画のこの行に追記する。

- [ ] **Step 9: 付随設定を更新する**

- `.gitignore` に `.wrangler/` と `.dev.vars` を追加する。
- `eslint.config.js` の `ignores` に `".wrangler"` と `"worker-configuration.d.ts"` を追加し、`files: ["server/**/*.ts", "vite.config.ts"]` の行に `"vitest.config.ts"` を加える。
- `.prettierignore` に `.wrangler` と `worker-configuration.d.ts` を追加する。

- [ ] **Step 10: 全チェックを通してコミットする**

Run: `npm run lint && npm run format:check && npm run typecheck && npx vitest run && npm run build`
Expected: すべて成功。テストは `app` 59 件 + `worker` 1 件。

```bash
git add -A
git commit -m "chore: add the Cloudflare Worker scaffold and upgrade Vite and Vitest"
```

---

### Task 2: SQLite ストア

**Files:**
- Create: `worker/store.ts`
- Test: `worker/store.test.ts`

**Interfaces:**
- Consumes: `buildTournamentSchedule`、`teams`（`src/features/tournament/`）、`Match`・`TournamentState`（`src/types`）
- Produces:

```ts
export type StoreErrorCode =
  | "UNKNOWN_MATCH"
  | "FIELD_NOT_PATCHABLE"
  | "INVALID_FIELD_VALUE"
  | "INVALID_MATCHES";
export class StoreError extends Error { readonly code: StoreErrorCode }
export interface Store {
  read(): TournamentState;
  patchMatch(id: string, patch: Partial<Match>): TournamentState;
  replaceMatches(matches: Match[]): TournamentState;
  reset(): TournamentState;
}
export function createSqlStore(storage: DurableObjectStorage): Store;
```

すべて同期関数（Durable Object の SQLite API は同期）。

- [ ] **Step 1: 失敗するテストを書く**

`worker/store.test.ts`。テストごとに別の Durable Object を使い、互いのデータが混ざらないようにする。

```ts
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
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx vitest run --project worker worker/store.test.ts`
Expected: FAIL（`./store` が見つからない）

- [ ] **Step 3: ストアを実装する**

`worker/store.ts`:

```ts
import { teams } from "../src/features/tournament/data";
import { buildTournamentSchedule } from "../src/features/tournament/schedule";
import type { Match, MatchStatus, TournamentState } from "../src/types";

const MATCH_STATUSES: readonly MatchStatus[] = ["SCHEDULED", "LIVE", "PAUSED", "FINISHED"];

const isMatchStatus = (value: unknown) =>
  typeof value === "string" && (MATCH_STATUSES as readonly string[]).includes(value);
const isNonNegativeInteger = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;
const isOptionalNonNegativeNumber = (value: unknown) =>
  value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
const isOptionalDateString = (value: unknown) =>
  value === undefined || (typeof value === "string" && !Number.isNaN(Date.parse(value)));
const isBoolean = (value: unknown) => typeof value === "boolean";

/** PATCH で変更を許可するフィールドと、その値の型を検証する述語。スケジュール項目は含めない。 */
export const PATCH_FIELD_VALIDATORS: Record<string, (value: unknown) => boolean> = {
  status: isMatchStatus,
  homeScore: isNonNegativeInteger,
  awayScore: isNonNegativeInteger,
  timerServerStartedAt: isOptionalDateString,
  timerElapsedSecondsAtPause: isOptionalNonNegativeNumber,
  penaltyHomeScore: isNonNegativeInteger,
  penaltyAwayScore: isNonNegativeInteger,
  isPenaltyShootout: isBoolean,
};

export type StoreErrorCode =
  | "UNKNOWN_MATCH"
  | "FIELD_NOT_PATCHABLE"
  | "INVALID_FIELD_VALUE"
  | "INVALID_MATCHES";

export class StoreError extends Error {
  constructor(
    message: string,
    readonly code: StoreErrorCode,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export interface Store {
  read(): TournamentState;
  patchMatch(id: string, patch: Partial<Match>): TournamentState;
  replaceMatches(matches: Match[]): TournamentState;
  reset(): TournamentState;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     version INTEGER NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS matches (
     position INTEGER PRIMARY KEY,
     id TEXT NOT NULL UNIQUE,
     data TEXT NOT NULL
   )`,
];

/**
 * Durable Object の SQLite に大会の state を持つ。メモリにはキャッシュしないので、
 * 休止や退避から戻っても常に保存済みの内容を返す。
 */
export function createSqlStore(storage: DurableObjectStorage): Store {
  const sql = storage.sql;
  for (const statement of SCHEMA) sql.exec(statement);

  const readMeta = () =>
    sql
      .exec<{ version: number; updated_at: string }>(
        "SELECT version, updated_at FROM meta WHERE id = 1",
      )
      .toArray()[0];

  const readMatches = () =>
    sql
      .exec<{ data: string }>("SELECT data FROM matches ORDER BY position")
      .toArray()
      .map((row) => JSON.parse(row.data) as Match);

  /** version を1つ進める。呼び出し側のトランザクションの中で使う。 */
  const bumpVersion = () => {
    const version = (readMeta()?.version ?? 0) + 1;
    sql.exec(
      `INSERT INTO meta (id, version, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`,
      version,
      new Date().toISOString(),
    );
  };

  const writeAll = (matches: Match[]) => {
    const ids = new Set(matches.map((match) => match.id));
    if (ids.size !== matches.length) {
      throw new StoreError("match ids must be unique", "INVALID_MATCHES");
    }
    storage.transactionSync(() => {
      sql.exec("DELETE FROM matches");
      matches.forEach((match, position) =>
        sql.exec(
          "INSERT INTO matches (position, id, data) VALUES (?, ?, ?)",
          position,
          match.id,
          JSON.stringify(match),
        ),
      );
      bumpVersion();
    });
    return snapshot();
  };

  const snapshot = (): TournamentState => {
    const meta = readMeta();
    return { version: meta.version, updatedAt: meta.updated_at, matches: readMatches() };
  };

  return {
    read() {
      return readMeta() ? snapshot() : writeAll(buildTournamentSchedule(teams));
    },

    patchMatch(id, patch) {
      const unknownField = Object.keys(patch).find((field) => !(field in PATCH_FIELD_VALIDATORS));
      if (unknownField) {
        throw new StoreError(`field is not patchable: ${unknownField}`, "FIELD_NOT_PATCHABLE");
      }
      const invalidField = Object.entries(patch).find(
        ([field, value]) => !PATCH_FIELD_VALIDATORS[field](value),
      );
      if (invalidField) {
        throw new StoreError(`invalid value for field: ${invalidField[0]}`, "INVALID_FIELD_VALUE");
      }

      this.read();
      const row = sql
        .exec<{ data: string }>("SELECT data FROM matches WHERE id = ?", id)
        .toArray()[0];
      if (!row) throw new StoreError(`unknown match: ${id}`, "UNKNOWN_MATCH");

      const next = { ...(JSON.parse(row.data) as Match), ...patch };
      storage.transactionSync(() => {
        sql.exec("UPDATE matches SET data = ? WHERE id = ?", JSON.stringify(next), id);
        bumpVersion();
      });
      return snapshot();
    },

    replaceMatches(matches) {
      return writeAll(matches);
    },

    reset() {
      return writeAll(buildTournamentSchedule(teams));
    },
  };
}
```

- [ ] **Step 4: テストを実行する**

Run: `npx vitest run --project worker worker/store.test.ts`
Expected: 10 件 PASS

- [ ] **Step 5: 全チェックを通してコミットする**

Run: `npm run lint && npm run format:check && npm run typecheck && npx vitest run`

```bash
git add worker/store.ts worker/store.test.ts
git commit -m "feat: store tournament state in the Durable Object's SQLite"
```

---

### Task 3: Durable Object の HTTP API と WebSocket 配信

**Files:**
- Create: `worker/api.ts`
- Modify: `worker/room.ts`、`src/types/index.ts`
- Test: `worker/api.test.ts`

**Interfaces:**
- Consumes: `createSqlStore`、`Store`、`StoreError`（Task 2）、`jsonResponse`（Task 1）
- Produces:
  - `src/types/index.ts`: `export interface ServerMessage { type: "state"; state: TournamentState }`
  - `worker/api.ts`: `handleApi(request: Request, store: Store, broadcast: (state: TournamentState) => void): Promise<Response>`
  - `GET /api/ws`（`Upgrade: websocket` 必須、無ければ `426`）。接続直後に現在の state を1通送り、以後は変更のたびに送る。`ping` には `pong` を返す。

- [ ] **Step 1: 失敗するテストを書く**

`worker/api.test.ts`。Worker の入口（`exports.default.fetch`）から呼び、転送も含めて確かめる。全テストが同じ `"main"` を使うので、`beforeEach` でリセットする。

```ts
import { env, exports } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import type { ServerMessage, TournamentState } from "../src/types";

const BASE = "http://localhost";

const call = (path: string, init?: RequestInit) => exports.default.fetch(`${BASE}${path}`, init);
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const readState = async () => (await (await call("/api/state")).json()) as TournamentState;

async function connect() {
  const response = await call("/api/ws", { headers: { Upgrade: "websocket" } });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const queue: string[] = [];
  const waiters: ((data: string) => void)[] = [];
  socket.addEventListener("message", (event) => {
    const data = event.data as string;
    const waiter = waiters.shift();
    if (waiter) waiter(data);
    else queue.push(data);
  });
  socket.accept();
  const nextRaw = () =>
    queue.length > 0
      ? Promise.resolve(queue.shift()!)
      : new Promise<string>((resolve) => waiters.push(resolve));
  const next = async () => JSON.parse(await nextRaw()) as ServerMessage;
  return { socket, next, nextRaw };
}

beforeEach(async () => {
  await call("/api/reset", { method: "POST" });
});

test("GET /api/state が全95試合を返す", async () => {
  const state = await readState();
  expect(state.matches).toHaveLength(95);
});

test("PATCH /api/matches/:id がスコアを更新する", async () => {
  const [first] = (await readState()).matches;
  const response = await call(`/api/matches/${first.id}`, json("PATCH", { homeScore: 4 }));
  expect(response.status).toBe(200);
  const state = (await response.json()) as TournamentState;
  expect(state.matches.find((m) => m.id === first.id)?.homeScore).toBe(4);
});

test("存在しない試合IDに 404 を返す", async () => {
  const response = await call("/api/matches/NOPE", json("PATCH", { homeScore: 1 }));
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ code: "UNKNOWN_MATCH" });
});

test("許可外フィールドに 400 を返す", async () => {
  const [first] = (await readState()).matches;
  const response = await call(`/api/matches/${first.id}`, json("PATCH", { court: 2 }));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "FIELD_NOT_PATCHABLE" });
});

test("型が不正な値に 400 を返す", async () => {
  const [first] = (await readState()).matches;
  const response = await call(`/api/matches/${first.id}`, json("PATCH", { homeScore: "x" }));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "INVALID_FIELD_VALUE" });
});

test("不正なJSONボディに 400 を返す", async () => {
  const [first] = (await readState()).matches;
  const response = await call(`/api/matches/${first.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  expect(response.status).toBe(400);
});

test("POST /api/reset が全試合を未開始に戻す", async () => {
  const [first] = (await readState()).matches;
  await call(`/api/matches/${first.id}`, json("PATCH", { status: "FINISHED", homeScore: 2 }));
  const response = await call("/api/reset", { method: "POST" });
  const state = (await response.json()) as TournamentState;
  expect(state.matches.every((m) => m.status === "SCHEDULED" && m.homeScore === 0)).toBe(true);
});

test("PUT /api/matches が全試合を置き換える", async () => {
  const replaced = (await readState()).matches.map((m) => ({ ...m, awayScore: 5 }));
  const response = await call("/api/matches", json("PUT", { matches: replaced }));
  expect(response.status).toBe(200);
  expect((await readState()).matches.every((m) => m.awayScore === 5)).toBe(true);
});

test("PUT /api/matches の matches が配列でない場合 400 を返す", async () => {
  const response = await call("/api/matches", json("PUT", { matches: "nope" }));
  expect(response.status).toBe(400);
});

test("PUT /api/matches の試合IDが重複していたら 400 を返す", async () => {
  const [first] = (await readState()).matches;
  const response = await call("/api/matches", json("PUT", { matches: [first, first] }));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "INVALID_MATCHES" });
});

test("GET /api/ws は Upgrade ヘッダーが無ければ 426 を返す", async () => {
  expect((await call("/api/ws")).status).toBe(426);
});

test("WebSocket は接続時に全stateを送り、更新のたびに push する", async () => {
  const client = await connect();
  const initial = await client.next();
  expect(initial.type).toBe("state");
  expect(initial.state.matches).toHaveLength(95);

  const first = initial.state.matches[0];
  await call(`/api/matches/${first.id}`, json("PATCH", { homeScore: 2 }));
  const pushed = await client.next();
  expect(pushed.state.version).toBe(initial.state.version + 1);
  expect(pushed.state.matches[0].homeScore).toBe(2);
  client.socket.close();
});

test("WebSocket で ping を送ると pong が返る", async () => {
  const client = await connect();
  await client.next();
  client.socket.send("ping");
  expect(await client.nextRaw()).toBe("pong");
  client.socket.close();
});

test("閉じた接続があっても更新は成功し、他の接続には届く", async () => {
  const closed = await connect();
  await closed.next();
  closed.socket.close();
  const open = await connect();
  const initial = await open.next();

  const first = initial.state.matches[0];
  const response = await call(`/api/matches/${first.id}`, json("PATCH", { awayScore: 3 }));
  expect(response.status).toBe(200);
  expect((await open.next()).state.matches[0].awayScore).toBe(3);
  open.socket.close();
});

test("並行した PATCH がどちらも失われない", async () => {
  const [a, b] = (await readState()).matches;
  await Promise.all([
    call(`/api/matches/${a.id}`, json("PATCH", { homeScore: 1 })),
    call(`/api/matches/${b.id}`, json("PATCH", { awayScore: 1 })),
  ]);
  const state = await readState();
  expect(state.matches.find((m) => m.id === a.id)?.homeScore).toBe(1);
  expect(state.matches.find((m) => m.id === b.id)?.awayScore).toBe(1);
});

test("Durable Object が退避されても更新済みのスコアを返す", async () => {
  const [first] = (await readState()).matches;
  await call(`/api/matches/${first.id}`, json("PATCH", { homeScore: 6 }));
  await evictDurableObject(env.TOURNAMENT.get(env.TOURNAMENT.idFromName("main")));
  expect((await readState()).matches[0].homeScore).toBe(6);
});

test("未定義のルートには 404 を返す", async () => {
  expect((await call("/api/nope")).status).toBe(404);
});
```

`worker/index.test.ts` の 404 テストはこのファイルの最後のテストと重複するので削除する。

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx vitest run --project worker worker/api.test.ts`
Expected: FAIL（`/api/state` などが 404）

- [ ] **Step 3: `ServerMessage` 型を追加する**

`src/types/index.ts` の末尾に追加:

```ts
/** WebSocket でサーバーが送るメッセージ。 */
export interface ServerMessage {
  type: "state";
  state: TournamentState;
}
```

- [ ] **Step 4: `handleApi` を実装する**

`worker/api.ts`:

```ts
import type { Match, TournamentState } from "../src/types";
import { jsonResponse } from "./http";
import { StoreError, type Store } from "./store";

/** JSON リクエストボディが壊れている場合に投げる。400 にマップされる。 */
class BadRequestError extends Error {}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequestError("request body must be valid JSON");
  }
}

/** `/api/*`（WebSocket 以外）を処理する。変更が成功したら broadcast を呼ぶ。 */
export async function handleApi(
  request: Request,
  store: Store,
  broadcast: (state: TournamentState) => void,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const mutated = (state: TournamentState) => {
    broadcast(state);
    return jsonResponse(200, state);
  };

  try {
    if (path === "/api/state" && request.method === "GET") {
      return jsonResponse(200, store.read());
    }

    if (path === "/api/reset" && request.method === "POST") {
      return mutated(store.reset());
    }

    if (path === "/api/matches" && request.method === "PUT") {
      const body = (await readJsonBody(request)) as { matches?: Match[] };
      if (!Array.isArray(body.matches)) {
        return jsonResponse(400, { error: "matches must be an array" });
      }
      return mutated(store.replaceMatches(body.matches));
    }

    const patchTarget = path.match(/^\/api\/matches\/(.+)$/);
    if (patchTarget && request.method === "PATCH") {
      const patch = (await readJsonBody(request)) as Partial<Match>;
      return mutated(store.patchMatch(decodeURIComponent(patchTarget[1]), patch));
    }

    return jsonResponse(404, { error: `no route for ${request.method} ${path}` });
  } catch (error) {
    if (error instanceof StoreError) {
      return jsonResponse(error.code === "UNKNOWN_MATCH" ? 404 : 400, {
        error: error.message,
        code: error.code,
      });
    }
    if (error instanceof BadRequestError) {
      return jsonResponse(400, { error: error.message });
    }
    console.error("[api] failed while handling a request", error);
    return jsonResponse(500, { error: error instanceof Error ? error.message : String(error) });
  }
}
```

- [ ] **Step 5: `TournamentRoom` に配信を入れる**

`worker/room.ts` を置き換える:

```ts
import { DurableObject } from "cloudflare:workers";
import type { ServerMessage, TournamentState } from "../src/types";
import { handleApi } from "./api";
import { jsonResponse } from "./http";
import { createSqlStore, type Store } from "./store";

const serialize = (state: TournamentState) =>
  JSON.stringify({ type: "state", state } satisfies ServerMessage);

export class TournamentRoom extends DurableObject<Env> {
  private readonly store: Store;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = createSqlStore(ctx.storage);
    // Answered by the runtime without waking the object, so client heartbeats stay free.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/api/ws") return this.accept(request);
    return handleApi(request, this.store, (state) => this.broadcast(state));
  }

  private accept(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse(426, { error: "expected a websocket upgrade" });
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.send(serialize(this.store.read()));
    return new Response(null, { status: 101, webSocket: client });
  }

  private broadcast(state: TournamentState): void {
    const message = serialize(state);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        // A socket that is closing must not stop the others from being told.
      }
    }
  }

  async webSocketMessage(): Promise<void> {
    // Clients only send "ping", which the auto-response answers.
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    try {
      socket.close(code, reason);
    } catch {
      // Codes such as 1005/1006 cannot be echoed back; the socket is gone anyway.
    }
  }
}
```

- [ ] **Step 6: テストを実行する**

Run: `npx vitest run --project worker`
Expected: `store` 10 件 + `api` 17 件 PASS

- [ ] **Step 7: 全チェックを通してコミットする**

Run: `npm run lint && npm run format:check && npm run typecheck && npx vitest run`

```bash
git add -A
git commit -m "feat: serve the tournament API and WebSocket pushes from the Durable Object"
```

---

### Task 4: クライアントの WebSocket 化と開発サーバーの切り替え

**Files:**
- Create: `src/features/tournament/api/socket.ts`
- Test: `src/features/tournament/api/socket.test.ts`
- Modify: `src/features/tournament/api/version.ts`、`src/features/tournament/api/version.test.ts`、`src/features/tournament/hooks/useTournamentState.ts`、`vite.config.ts`、`vitest.config.ts`、`tsconfig.node.json`、`eslint.config.js`、`.gitignore`
- Delete: `server/`（`api.ts`・`api.test.ts`・`store.ts`・`store.test.ts`・`tempDataPlugin.ts`）、`TempServerData/`

**Interfaces:**
- Consumes: `ServerMessage`（Task 3）、`GET /api/ws`（Task 3）
- Produces（`socket.ts`）:

```ts
export function socketUrl(location: { protocol: string; host: string }): string;
export function reconnectDelay(attempt: number): number;
export function parseServerMessage(data: unknown): TournamentState | null;
```

- `shouldApply(incomingVersion, currentVersion, source: "push" | "response")`

- [ ] **Step 1: 失敗するテストを書く**

`src/features/tournament/api/socket.test.ts`:

```ts
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
```

`version.test.ts` の受信元の名前を変える:

```bash
sed -i 's/"sse"/"push"/g; s/SSE の state イベント/WebSocket の push/; s/SSE でもレスポンスでも/push でもレスポンスでも/' src/features/tournament/api/version.test.ts
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx vitest run --project app src/features/tournament/api`
Expected: `socket.test.ts` は FAIL（`./socket` が無い）、`version.test.ts` は型エラーまたは FAIL（`"push"` が未定義）。`npm run typecheck` でも `version.test.ts` がエラーになること。

- [ ] **Step 3: `socket.ts` と `version.ts` を実装する**

`src/features/tournament/api/socket.ts`:

```ts
import type { TournamentState } from "../../../types";

const MAX_RECONNECT_DELAY_MS = 10_000;

/** ページと同じホストの WebSocket URL。https のページでは wss:// でないとブラウザーが拒否する。 */
export function socketUrl(location: { protocol: string; host: string }): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/ws`;
}

/** 再接続までの待ち時間。1秒から倍々に延ばし、10秒で頭打ち。 */
export function reconnectDelay(attempt: number): number {
  return Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** attempt);
}

/** サーバーからのメッセージを読む。state 以外（pong や壊れたデータ）は null。 */
export function parseServerMessage(data: unknown): TournamentState | null {
  if (typeof data !== "string") return null;
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof message !== "object" || message === null) return null;
  const { type, state } = message as { type?: unknown; state?: Partial<TournamentState> };
  if (type !== "state" || typeof state !== "object" || state === null) return null;
  if (typeof state.version !== "number" || !Array.isArray(state.matches)) return null;
  return state as TournamentState;
}
```

`src/features/tournament/api/version.ts` の `"sse"` を `"push"` に変え、コメントの「SSE の `state` イベント」を「WebSocket の push」に直す。

- [ ] **Step 4: テストを実行する**

Run: `npx vitest run --project app src/features/tournament/api`
Expected: `socket` 5 件 + `version` 5 件 PASS

- [ ] **Step 5: `useTournamentState` を WebSocket に切り替える**

`src/features/tournament/hooks/useTournamentState.ts` の import に追加:

```ts
import { parseServerMessage, reconnectDelay, socketUrl } from "../api/socket";
```

ファイル先頭の定数として追加:

```ts
/** これだけ何も届かなければ、つながっているように見えても切れているとみなして張り直す。 */
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 25_000;
```

`EventSource` を使っている `useEffect` を次に置き換える:

```ts
  useEffect(() => {
    dropLegacyStorage();

    let disposed = false;
    let socket: WebSocket | null = null;
    let attempt = 0;
    let lastSeen = Date.now();
    let reconnectTimer: number | undefined;

    const connect = () => {
      const current = new WebSocket(socketUrl(window.location));
      socket = current;
      current.onopen = () => {
        attempt = 0;
        lastSeen = Date.now();
      };
      current.onmessage = (event) => {
        lastSeen = Date.now();
        const state = parseServerMessage(event.data);
        if (!state) return;
        setConnection("live");
        setError(null);
        if (shouldApply(state.version, versionRef.current, "push")) applyState(state);
      };
      current.onclose = () => {
        if (socket === current) socket = null;
        if (disposed) return;
        setConnection("offline");
        reconnectTimer = window.setTimeout(connect, reconnectDelay(attempt));
        attempt += 1;
      };
    };

    connect();

    // Browsers can take minutes to notice a dead connection, so ping and give up
    // on a socket that has gone quiet; onclose then schedules the reconnect.
    const heartbeat = window.setInterval(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastSeen > HEARTBEAT_TIMEOUT_MS) {
        socket.close();
        return;
      }
      socket.send("ping");
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimer);
      window.clearInterval(heartbeat);
      socket?.close();
    };
  }, [applyState]);
```

`applyState` のコメントの「SSE」を「WebSocket」に直す。

- [ ] **Step 6: 開発サーバーを Cloudflare プラグインに切り替え、旧サーバーを削除する**

`vite.config.ts`:

```ts
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), cloudflare()],
});
```

```bash
git rm -r server TempServerData
```

- `vitest.config.ts` の `app` プロジェクトの `include` から `"server/**/*.test.ts"` を消す。
- `tsconfig.node.json` の `include` を `["vite.config.ts", "vitest.config.ts"]` にする。
- `eslint.config.js` の `files: ["server/**/*.ts", "vite.config.ts", "vitest.config.ts"]` から `"server/**/*.ts"` を消す。
- `.gitignore` から `TempServerData/*.json` の行を消す。
- `grep -rn "TempServerData\|tempDataPlugin\|EventSource\|/api/stream" src worker vite.config.ts` が何も返さないことを確認する。

- [ ] **Step 7: 全チェックを通す**

Run: `npm run lint && npm run format:check && npm run typecheck && npx vitest run && npm run build`
Expected: すべて成功。`npm run build` の出力に Worker（`dist/velocity_cup/` など）と画面（`dist/client/`）の両方が出ること。

- [ ] **Step 8: 開発サーバーで実際に動かす**

`npm run dev` を起動し、別のターミナルで次を実行する（Node 24 は `WebSocket` と `fetch` を標準で持つ）。ポートは起動時に表示されたものに合わせる。

```bash
node -e '
const base = "localhost:5173";
const ws = new WebSocket(`ws://${base}/api/ws`);
const got = [];
ws.onmessage = async (e) => {
  const m = JSON.parse(e.data); got.push(m.state.version);
  if (got.length === 1) {
    const id = m.state.matches[0].id;
    const r = await fetch(`http://${base}/api/matches/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ homeScore: 1 }) });
    console.log("PATCH", r.status);
  } else {
    console.log("pushed version", got[0], "->", got[1], "homeScore", m.state.matches[0].homeScore);
    await fetch(`http://${base}/api/reset`, { method: "POST" }); ws.close();
  }
};'
```

Expected: `PATCH 200` と `pushed version N -> N+1 homeScore 1`。続けてブラウザーで `/`・`/live`・`/admin/setup` を開き、画面が表示されること、接続バナーが消えること（接続済み）を確認する。開発サーバーを止めるとバナーが「Disconnected」になり、再起動すると自動でつながり直すことも確認する。

- [ ] **Step 9: コミットする**

```bash
git add -A
git commit -m "feat: receive tournament state over WebSocket and run the API on the Worker"
```

---

### Task 5: デプロイ手順とドキュメント

**Files:**
- Modify: `package.json`、`README.md`、`docs/仕様書.md`（10〜13章）

**Interfaces:**
- Produces: `npm run deploy`

- [ ] **Step 1: デプロイ用スクリプトを追加する**

`package.json` の scripts に追加:

```json
"deploy": "npm run build && wrangler deploy"
```

- [ ] **Step 2: デプロイ設定が正しいことを確かめる（アカウント不要）**

Run: `npm run build && npx wrangler deploy --dry-run`
Expected: 成功し、`TOURNAMENT (TournamentRoom)` の Durable Object バインディングとアセットが表示される。

- [ ] **Step 3: README を更新する**

`README.md` の「Run locally」から最後までを次に置き換える:

````markdown
## Run locally

```bash
npm install
npm run dev
```

`npm run dev` starts Vite together with the Cloudflare Worker and its Durable Object in the local
workerd runtime. Tournament data is kept in `.wrangler/state/` (not committed).

## Checks

```bash
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
```

## Deploy to Cloudflare

```bash
npx wrangler login   # once per machine
npm run deploy
```

The app runs as one Worker (`velocity-cup`) that serves the built SPA and handles `/api/*`. All
tournament state lives in a single SQLite-backed Durable Object (`TournamentRoom`) and is pushed to
every open page over WebSocket.
````

- [ ] **Step 4: 仕様書の10〜13章を更新する**

`docs/仕様書.md` の「## 10. データ同期仕様」から「## 12. 起動方法」の直前までを次に置き換える:

````markdown
## 10. データ同期仕様

試合データは Cloudflare の Durable Object `TournamentRoom`（名前 `main` の1インスタンス）の SQLite を唯一の正本とする。ブラウザーは Worker の `/api/*` 経由で操作し、変更の結果は WebSocket で全端末へ配信される。

### 10.1 API

| メソッド | パス | 用途 |
|---|---|---|
| `GET` | `/api/state` | 全試合とversionを返す |
| `GET` | `/api/ws` | WebSocket。接続時に全state、以後は更新のたびに配信 |
| `PATCH` | `/api/matches/:id` | 1試合の部分更新 |
| `PUT` | `/api/matches` | 全置換 |
| `POST` | `/api/reset` | 全試合を未開始へ戻す |

### 10.2 更新の流れ

スコアや状態の編集など、試合単位の操作は `PATCH /api/matches/:id` として送られる。Seed knockout teamsは `PUT /api/matches`、Reset all matchesは `POST /api/reset` を使う。Durable Object は該当の試合だけを書き換え、`version` を1つ増やして保存し、接続中の全 WebSocket へ `{"type":"state","state":...}` を送る。クライアントは10秒ごとに `ping` を送り、サーバーは `pong` を返す。

`PATCH` で変更できるのは `status`、`homeScore`、`awayScore`、タイマー項目、PK戦項目のみである。試合ID、Round、Court、開始予定時刻、対戦チームは変更できない。

存在しない試合IDを指定した場合は `404` で `{"error": "unknown match: ...", "code": "UNKNOWN_MATCH"}` を返す。変更できないフィールドを含めた場合は `400` で `{"error": "field is not patchable: court", "code": "FIELD_NOT_PATCHABLE"}`、値の型が不正な場合は `400` で `INVALID_FIELD_VALUE`、`PUT` で試合IDが重複している場合は `400` で `INVALID_MATCHES` を返す。リクエストボディがJSONとして解釈できない場合も `400` を返す。

### 10.3 保全

- Durable Object はリクエストを1つずつ処理するため、並行更新による取りこぼしは起きない。
- 全置換とリセットは1つのトランザクションで書き込み、途中で失敗しても半端な状態を残さない。
- 試合データはメモリに持たず、常に SQLite から読む。Durable Object が休止・退避されても内容は失われない。

### 10.4 接続断

サーバーへ接続できない場合、画面上部に切断バナーを表示し、管理操作を無効化する。最後に取得したデータは表示したままにする。クライアントは1秒から最大10秒まで間隔を延ばしながら自動で再接続し、再接続時に全stateを受け取って同期する。25秒間何も届かない接続は切れたものとみなして張り直す。

## 11. 非機能・制約

- 本番は Cloudflare Workers（無料プランを想定）で動かす。Workers と Durable Objects の無料枠は1日10万リクエストで、WebSocket の接続確立が1リクエスト、サーバーからの送信は無料。
- 複数端末・複数ユーザーでの同時編集をサポートする。同一フィールドを同時に変更した場合は後着信が優先される（明示的なロックや競合解決は段階3で入れる）。
- デモ用アクセスキーはフロントエンドコードに含まれるため、本番運用には不適切（段階1でサーバー側認証に置き換える）。
````

「## 12. 起動方法」から最後までを次に置き換える:

````markdown
## 12. 起動方法

プロジェクトルートで実行する。

```bash
npm install
npm run dev
```

ブラウザーで起動時に表示されるURL（通常 `http://localhost:5173/`）を開く。ローカルのデータは `.wrangler/state/` に保存される。

本番へのデプロイ:

```bash
npx wrangler login
npm run deploy
```

## 13. ビルド・検証

```bash
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
```

`npm test` は2つのプロジェクトを実行する。`app` は Node 上の単体テスト（schedule・timer・logic・data・format・version・socket）、`worker` は workerd 上の Durable Object と API のテスト（store・api）。全件が成功することを確認する。
````

- [ ] **Step 5: 全チェックを通してコミットする**

Run: `npm run lint && npm run format:check && npm run typecheck && npx vitest run && npm run build`

```bash
git add package.json README.md docs/仕様書.md
git commit -m "docs: explain running and deploying on Cloudflare"
```

---

## 完了時の確認

- `npm test` の全件、`npm run build`、`npx wrangler deploy --dry-run` が成功する。
- `npm run dev` で、2つのブラウザーを開き、片方で得点を変えるともう片方にすぐ反映される。
- 実際の本番デプロイ（`wrangler login` と `npm run deploy`）は利用者のアカウントで行う。
