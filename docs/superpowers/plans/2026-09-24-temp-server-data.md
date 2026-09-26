# TempServerData 移行とスケジュール再設計 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 試合データを localStorage から `TempServerData/matches.json` へ移し、SSE で複数端末へ即時配信しつつ、全95試合を未開始状態で 09:00〜19:03 に収まるスケジュールへ組み直す。

**Architecture:** Vite 開発サーバーに API ミドルウェアを1枚差し込み、`TempServerData/matches.json` を唯一の正本とする。書き込みは試合単位の差分 PATCH を直列化・アトミックに適用し、成功のたびに SSE で全接続へ全stateを push する。スケジュール生成は純粋関数としてクライアント側に置き、サーバーが初期化時に呼ぶ。

**Tech Stack:** React 18 / TypeScript 5.6 / Vite 5.4 / React Router 6 / Node 標準モジュールのみ（http・fs・path）/ vitest

**Spec:** `docs/superpowers/specs/2026-09-24-temp-server-data-design.md`

## Global Constraints

- **ランタイム依存を追加しない。** 新規依存は devDependency の `vitest` と `@types/node` のみ。
- **稼働形態は `npm run dev` のみ。** ビルド後・本番配信は対象外。
- フォルダー名は `TempServerData`（`TempSeverData` ではない）。
- 大会開始は `2026-09-26T09:00:00+09:00` 固定。コート数3、グループ戦15分、ノックアウト18分。
- 同一チームの試合間隔は15分以上。途中休憩なし。
- 管理者フラグ `cupflow-admin-authed` は localStorage に残す。試合データのキー `cupflow-matches` は廃止する。
- 表示時刻のタイムゾーンは `Asia/Tokyo` 固定。
- `TempServerData/*.json` は git 管理外。フォルダーは `.gitkeep` で残す。
- ノックアウトの QF 以降は本計画の範囲では `TBD` のまま（勝者の自動繰り上げは対象外）。

---

## File Structure

| ファイル | 責務 |
|---|---|
| `src/types.ts` | `Match`・`Team`・`TournamentState` の型定義。`durationMinutes` を追加 |
| `src/schedule.ts` | スケジュール生成と時間計算（純粋関数のみ、副作用なし） |
| `src/schedule.test.ts` | スケジュールの制約検証 |
| `src/data.ts` | チーム定義と初期スケジュールの入口、表示フォーマット |
| `src/data.test.ts` | タイムゾーン固定の検証 |
| `src/logic.ts` | 順位計算とノックアウトのシード反映 |
| `server/store.ts` | ファイル読み書き・直列化・破損復旧・購読 |
| `server/store.test.ts` | ストアの振る舞い検証 |
| `server/api.ts` | HTTP ルーティングと SSE 配信 |
| `server/api.test.ts` | 実サーバーを立てた統合テスト |
| `server/tempDataPlugin.ts` | Vite plugin。store と api を dev サーバーへ接続 |
| `src/api/client.ts` | fetch ラッパ |
| `src/api/useTournamentState.ts` | SSE 購読と楽観更新のフック |
| `src/App.tsx` | 画面。localStorage 呼び出しをフックへ差し替え |

`server/` は Node 側、`src/` はブラウザー側。`src/schedule.ts`・`src/data.ts`・`src/types.ts` は副作用も DOM 依存も持たないため両方から参照できる。

---

### Task 1: テスト基盤とビルド生成物の整理

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.node.json`
- Modify: `.gitignore`
- Delete: `vite.config.js`, `vite.config.d.ts`

**Interfaces:**
- Consumes: なし
- Produces: `npm test` が vitest を実行する。`server/**/*.ts` が型チェック対象になる。`tsc -b` の出力がリポジトリを汚さない。

`tsconfig.node.json` は `composite: true` かつ `outDir` 未指定のため、`tsc -b` が `vite.config.js` と `vite.config.d.ts` をリポジトリ直下に生成し、それがコミットされている。`server/` を追加すると同じ生成物が増え続けるので先に直す。

- [ ] **Step 1: 依存を追加する**

```bash
npm install --save-dev vitest @types/node
```

- [ ] **Step 2: `package.json` に test スクリプトを追加する**

`"scripts"` を次のようにする。

```json
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
```

- [ ] **Step 3: `tsconfig.node.json` を差し替える**

ファイル全体を次の内容にする。`outDir` で生成物を `node_modules/.tmp/` へ逃がし、`server` と、そこから参照される `src` の副作用なしモジュールを include に加える。

```json
{
  "compilerOptions": {
    "composite": true,
    "outDir": "./node_modules/.tmp/node-build",
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.node.tsbuildinfo",
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "target": "ES2022",
    "lib": ["ES2022"],
    "strict": true,
    "allowSyntheticDefaultImports": true
  },
  "include": ["vite.config.ts", "server/**/*.ts", "src/types.ts", "src/data.ts", "src/schedule.ts", "src/logic.ts"]
}
```

- [ ] **Step 4: 生成物を削除して無視リストに入れる**

```bash
git rm --cached vite.config.js vite.config.d.ts
rm -f vite.config.js vite.config.d.ts
```

`.gitignore` の末尾に追記する。

```
vite.config.js
vite.config.d.ts
TempServerData/*.json
```

- [ ] **Step 5: `TempServerData/` を作る**

```bash
mkdir -p TempServerData
touch TempServerData/.gitkeep
```

- [ ] **Step 6: 動作確認用のテストを1本書く**

`src/smoke.test.ts` を作成する。基盤が動くことだけを確かめる一時的なテストで、Task 2 で削除する。

```ts
import { expect, test } from "vitest";

test("vitest runs", () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 7: テストが通ることを確認する**

Run: `npm test`
Expected: PASS（1 passed）

- [ ] **Step 8: ビルドがリポジトリを汚さないことを確認する**

Run: `npm run build && git status --short`
Expected: ビルド成功。`git status` に `vite.config.js` / `vite.config.d.ts` が現れない。

- [ ] **Step 9: コミットする**

```bash
git add package.json package-lock.json tsconfig.node.json .gitignore TempServerData/.gitkeep src/smoke.test.ts
git commit -m "chore: add vitest and keep tsc output out of the repo"
```

---

### Task 2: スケジュール生成

**Files:**
- Modify: `src/types.ts`
- Create: `src/schedule.ts`
- Create: `src/schedule.test.ts`
- Delete: `src/smoke.test.ts`

**Interfaces:**
- Consumes: `Match`・`Team`（`src/types.ts`）
- Produces:
  - `COURT_COUNT: 3`, `GROUP_MATCH_MINUTES: 15`, `KNOCKOUT_MATCH_MINUTES: 18`
  - `TOURNAMENT_START: string`, `TBD: "TBD"`, `GROUP_IDS: readonly string[]`
  - `R16_SEEDS: readonly (readonly [string, string])[]`
  - `buildTournamentSchedule(teams: Team[]): Match[]`
  - `matchEndMs(match: Match): number`
  - `findCourtConflicts(matches: Match[]): [Match, Match][]`

グループ戦は15分スロット単位の貪欲法で詰める。スロットごとに最大3試合を選び、同一スロットに同じチームを2回入れない・直前スロットに出たチームは選ばないという制約を置く。選択順は「残り試合数の多いチームを含む試合」を優先し、同点時は試合IDの昇順で決める（この同点処理が決定性を保証する）。

- [ ] **Step 1: `Match` に `durationMinutes` を追加する**

`src/types.ts` の `Match` インターフェースの `scheduledStart` の直後に1行足す。

```ts
  scheduledStart: string;
  durationMinutes: number;
  status: MatchStatus;
```

- [ ] **Step 2: 失敗するテストを書く**

`src/schedule.test.ts` を作成する。

```ts
import { describe, expect, test } from "vitest";
import { teams } from "./data";
import {
  buildTournamentSchedule,
  findCourtConflicts,
  GROUP_MATCH_MINUTES,
  matchEndMs,
  TBD,
} from "./schedule";
import type { Match } from "./types";

const schedule = buildTournamentSchedule(teams);

describe("buildTournamentSchedule", () => {
  test("生成する試合数はグループ80・ノックアウト15の計95", () => {
    expect(schedule).toHaveLength(95);
    expect(schedule.filter((m) => m.stage === "GROUP")).toHaveLength(80);
    expect(schedule.filter((m) => m.stage !== "GROUP")).toHaveLength(15);
  });

  test("全試合が未開始・スコア0・タイマーなし", () => {
    for (const match of schedule) {
      expect(match.status).toBe("SCHEDULED");
      expect(match.homeScore).toBe(0);
      expect(match.awayScore).toBe(0);
      expect(match.timerServerStartedAt).toBeUndefined();
      expect(match.timerElapsedSecondsAtPause).toBeUndefined();
    }
  });

  test("ノックアウトの対戦相手は TBD", () => {
    for (const match of schedule.filter((m) => m.stage !== "GROUP")) {
      expect(match.homeTeamId).toBe(TBD);
      expect(match.awayTeamId).toBe(TBD);
    }
  });

  test("コート重複が0件", () => {
    expect(findCourtConflicts(schedule)).toEqual([]);
  });

  test("同一チームの試合間隔が15分以上", () => {
    const byTeam = new Map<string, Match[]>();
    for (const match of schedule.filter((m) => m.stage === "GROUP")) {
      for (const teamId of [match.homeTeamId, match.awayTeamId]) {
        byTeam.set(teamId, [...(byTeam.get(teamId) ?? []), match]);
      }
    }

    expect(byTeam.size).toBe(40);
    for (const [teamId, played] of byTeam) {
      expect(played, `${teamId} の試合数`).toHaveLength(4);
      const ordered = [...played].sort(
        (a, b) => Date.parse(a.scheduledStart) - Date.parse(b.scheduledStart),
      );
      for (let i = 1; i < ordered.length; i += 1) {
        const restMinutes = (Date.parse(ordered[i].scheduledStart) - matchEndMs(ordered[i - 1])) / 60_000;
        expect(restMinutes, `${teamId} の休憩`).toBeGreaterThanOrEqual(GROUP_MATCH_MINUTES);
      }
    }
  });

  test("同一スロットに同じチームは2回現れない", () => {
    const bySlot = new Map<string, string[]>();
    for (const match of schedule.filter((m) => m.stage === "GROUP")) {
      bySlot.set(match.scheduledStart, [
        ...(bySlot.get(match.scheduledStart) ?? []),
        match.homeTeamId,
        match.awayTeamId,
      ]);
    }
    for (const [slot, teamIds] of bySlot) {
      expect(new Set(teamIds).size, `スロット ${slot}`).toBe(teamIds.length);
    }
  });

  test("グループ戦は27スロットに収まる", () => {
    const slots = new Set(schedule.filter((m) => m.stage === "GROUP").map((m) => m.scheduledStart));
    expect(slots.size).toBe(27);
  });

  test("最終試合の終了は 2026-09-26 19:03 JST", () => {
    const finish = Math.max(...schedule.map(matchEndMs));
    expect(new Date(finish).toISOString()).toBe("2026-09-26T10:03:00.000Z");
  });

  test("同じ入力から常に同じ出力を返す", () => {
    expect(buildTournamentSchedule(teams)).toEqual(schedule);
  });
});
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `npm test`
Expected: FAIL（`src/schedule` が解決できない）

- [ ] **Step 4: `src/schedule.ts` を実装する**

```ts
import type { Match, Team } from "./types";

export const COURT_COUNT = 3;
export const GROUP_MATCH_MINUTES = 15;
export const KNOCKOUT_MATCH_MINUTES = 18;
export const TOURNAMENT_START = "2026-09-26T09:00:00+09:00";
export const TBD = "TBD";
export const GROUP_IDS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;

/** Round of 16 のシード表。`A1` は Group A の1位を指す。 */
export const R16_SEEDS = [
  ["A1", "H2"], ["H1", "A2"], ["B1", "G2"], ["G1", "B2"],
  ["C1", "F2"], ["F1", "C2"], ["D1", "E2"], ["E1", "D2"],
] as const;

const KNOCKOUT_ROUNDS = [
  { stage: "R16", count: 8, sourcePrefix: null },
  { stage: "QF", count: 4, sourcePrefix: "R16" },
  { stage: "SF", count: 2, sourcePrefix: "QF" },
  { stage: "FINAL", count: 1, sourcePrefix: "SF" },
] as const;

interface Pairing {
  id: string;
  groupId: string;
  homeTeamId: string;
  awayTeamId: string;
}

export function matchEndMs(match: Match): number {
  return Date.parse(match.scheduledStart) + match.durationMinutes * 60_000;
}

/** 同じコートで時間帯が重なる試合の組を返す。重複がなければ空配列。 */
export function findCourtConflicts(matches: Match[]): [Match, Match][] {
  const conflicts: [Match, Match][] = [];
  const ordered = [...matches].sort(
    (a, b) => Date.parse(a.scheduledStart) - Date.parse(b.scheduledStart),
  );
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const [a, b] = [ordered[i], ordered[j]];
      if (Date.parse(b.scheduledStart) >= matchEndMs(a)) break;
      if (a.court === b.court) conflicts.push([a, b]);
    }
  }
  return conflicts;
}

function buildGroupPairings(teams: Team[]): Pairing[] {
  const pairings: Pairing[] = [];
  for (const groupId of GROUP_IDS) {
    const ids = teams.filter((team) => team.groupId === groupId).map((team) => team.id);
    let number = 1;
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        pairings.push({ id: `G-${groupId}-${number}`, groupId, homeTeamId: ids[i], awayTeamId: ids[j] });
        number += 1;
      }
    }
  }
  return pairings;
}

/**
 * 15分スロットへ貪欲に詰める。
 * 制約: 1スロット最大3試合、同一スロットに同じチームは1回まで、直前スロットに
 * 出たチームは選ばない（休憩15分以上）。
 */
function packIntoSlots(pairings: Pairing[]): Pairing[][] {
  const remaining = new Map<string, number>();
  for (const pairing of pairings) {
    remaining.set(pairing.homeTeamId, (remaining.get(pairing.homeTeamId) ?? 0) + 1);
    remaining.set(pairing.awayTeamId, (remaining.get(pairing.awayTeamId) ?? 0) + 1);
  }

  const load = (pairing: Pairing) =>
    (remaining.get(pairing.homeTeamId) ?? 0) + (remaining.get(pairing.awayTeamId) ?? 0);

  const unscheduled = new Set(pairings);
  const slots: Pairing[][] = [];
  let previousSlotTeams = new Set<string>();
  const maxSlots = pairings.length + 1;

  while (unscheduled.size > 0) {
    if (slots.length >= maxSlots) {
      throw new Error(`schedule packing failed: ${unscheduled.size} matches could not be placed`);
    }

    const busy = new Set<string>();
    const slot: Pairing[] = [];
    const candidates = [...unscheduled]
      .filter(
        (pairing) =>
          !previousSlotTeams.has(pairing.homeTeamId) && !previousSlotTeams.has(pairing.awayTeamId),
      )
      .sort((a, b) => load(b) - load(a) || a.id.localeCompare(b.id));

    for (const pairing of candidates) {
      if (slot.length >= COURT_COUNT) break;
      if (busy.has(pairing.homeTeamId) || busy.has(pairing.awayTeamId)) continue;
      slot.push(pairing);
      busy.add(pairing.homeTeamId);
      busy.add(pairing.awayTeamId);
    }

    for (const pairing of slot) {
      unscheduled.delete(pairing);
      remaining.set(pairing.homeTeamId, (remaining.get(pairing.homeTeamId) ?? 0) - 1);
      remaining.set(pairing.awayTeamId, (remaining.get(pairing.awayTeamId) ?? 0) - 1);
    }

    slots.push(slot);
    previousSlotTeams = busy;
  }

  return slots;
}

/**
 * 全95試合を未開始状態で生成する。
 * グループ戦は 09:00 から15分刻み、ノックアウトはグループ戦終了の1スロット後から
 * 18分刻みで、ラウンド間に1スロットの休憩を挟む。
 */
export function buildTournamentSchedule(teams: Team[]): Match[] {
  const startMs = Date.parse(TOURNAMENT_START);
  const slots = packIntoSlots(buildGroupPairings(teams));

  const groupMatches: Match[] = slots.flatMap((slot, slotIndex) =>
    slot.map((pairing, courtIndex) => ({
      id: pairing.id,
      stage: "GROUP" as const,
      groupId: pairing.groupId,
      court: courtIndex + 1,
      scheduledStart: new Date(startMs + slotIndex * GROUP_MATCH_MINUTES * 60_000).toISOString(),
      durationMinutes: GROUP_MATCH_MINUTES,
      status: "SCHEDULED" as const,
      homeTeamId: pairing.homeTeamId,
      awayTeamId: pairing.awayTeamId,
      homeScore: 0,
      awayScore: 0,
    })),
  );

  const knockoutMatches: Match[] = [];
  let roundStartMs = startMs + slots.length * GROUP_MATCH_MINUTES * 60_000 + KNOCKOUT_MATCH_MINUTES * 60_000;

  for (const round of KNOCKOUT_ROUNDS) {
    for (let index = 0; index < round.count; index += 1) {
      const row = Math.floor(index / COURT_COUNT);
      knockoutMatches.push({
        id: `${round.stage}-${index + 1}`,
        stage: round.stage,
        court: (index % COURT_COUNT) + 1,
        scheduledStart: new Date(roundStartMs + row * KNOCKOUT_MATCH_MINUTES * 60_000).toISOString(),
        durationMinutes: KNOCKOUT_MATCH_MINUTES,
        status: "SCHEDULED",
        homeTeamId: TBD,
        awayTeamId: TBD,
        homeScore: 0,
        awayScore: 0,
        ...(round.sourcePrefix
          ? {
              sourceMatchIds: [
                `${round.sourcePrefix}-${index * 2 + 1}`,
                `${round.sourcePrefix}-${index * 2 + 2}`,
              ],
            }
          : {}),
      });
    }
    roundStartMs += (Math.ceil(round.count / COURT_COUNT) + 1) * KNOCKOUT_MATCH_MINUTES * 60_000;
  }

  return [...groupMatches, ...knockoutMatches];
}
```

- [ ] **Step 5: 一時テストを削除する**

```bash
rm src/smoke.test.ts
```

- [ ] **Step 6: テストが通ることを確認する**

Run: `npm test`
Expected: PASS（9 passed）

- [ ] **Step 7: コミットする**

```bash
git add src/types.ts src/schedule.ts src/schedule.test.ts
git rm --cached src/smoke.test.ts
git commit -m "feat: pack all 95 matches into a conflict-free schedule"
```

---

### Task 3: 初期データとノックアウトのシード反映

**Files:**
- Modify: `src/data.ts`
- Modify: `src/logic.ts:44-102`
- Create: `src/data.test.ts`

**Interfaces:**
- Consumes: `buildTournamentSchedule`・`R16_SEEDS`・`GROUP_IDS`・`TBD`（`src/schedule.ts`）
- Produces:
  - `initialMatches: Match[]`（全95試合・未開始）
  - `TOURNAMENT_TIME_ZONE: "Asia/Tokyo"`
  - `seedKnockoutTeams(teams: Team[], matches: Match[]): Match[]` — `generateKnockoutMatches` を置き換える

`generateKnockoutMatches` は独自の時刻（13:00固定）でノックアウトを新規生成していた。これがグループ戦と衝突する原因なので、既存のノックアウト試合の時刻とコートは動かさず、R16 の対戦チームだけを埋める関数に置き換える。

- [ ] **Step 1: 失敗するテストを書く**

`src/data.test.ts` を作成する。

```ts
import { expect, test } from "vitest";
import { formatTime, initialMatches, teams } from "./data";
import { seedKnockoutTeams } from "./logic";
import { TBD } from "./schedule";

test("初期データは全95試合が未開始", () => {
  expect(initialMatches).toHaveLength(95);
  expect(initialMatches.every((match) => match.status === "SCHEDULED")).toBe(true);
  expect(initialMatches.every((match) => match.homeScore === 0 && match.awayScore === 0)).toBe(true);
});

test("表示時刻は閲覧端末のタイムゾーンに依存しない", () => {
  expect(formatTime("2026-09-26T09:00:00+09:00")).toBe("09:00");
  expect(formatTime("2026-09-26T10:03:00.000Z")).toBe("19:03");
});

test("seedKnockoutTeams は R16 の対戦相手を埋め、時刻とコートは変えない", () => {
  const seeded = seedKnockoutTeams(teams, initialMatches);
  const before = initialMatches.filter((match) => match.stage === "R16");
  const after = seeded.filter((match) => match.stage === "R16");

  expect(after).toHaveLength(8);
  for (const match of after) {
    expect(match.homeTeamId).not.toBe(TBD);
    expect(match.awayTeamId).not.toBe(TBD);
  }
  for (const [index, match] of after.entries()) {
    expect(match.scheduledStart).toBe(before[index].scheduledStart);
    expect(match.court).toBe(before[index].court);
  }
});

test("seedKnockoutTeams はグループ戦と QF 以降を変更しない", () => {
  const seeded = seedKnockoutTeams(teams, initialMatches);
  expect(seeded.filter((match) => match.stage === "GROUP")).toEqual(
    initialMatches.filter((match) => match.stage === "GROUP"),
  );
  expect(seeded.filter((match) => ["QF", "SF", "FINAL"].includes(match.stage))).toEqual(
    initialMatches.filter((match) => ["QF", "SF", "FINAL"].includes(match.stage)),
  );
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test src/data.test.ts`
Expected: FAIL（`seedKnockoutTeams` が存在しない）

- [ ] **Step 3: `src/data.ts` を書き換える**

ファイル全体を次の内容にする。`pairings` と、`LIVE` / `FINISHED` を混ぜていた初期状態の生成は `buildTournamentSchedule` に置き換わるため削除する。

```ts
import { buildTournamentSchedule, GROUP_IDS } from "./schedule";
import type { Match, Team } from "./types";

export const TOURNAMENT_TIME_ZONE = "Asia/Tokyo";

const palette = ["#f97316", "#22c55e", "#38bdf8", "#a78bfa", "#f43f5e"];

export const teams: Team[] = GROUP_IDS.flatMap((groupId, groupIndex) =>
  Array.from({ length: 5 }, (_, index) => ({
    id: `${groupId}${index + 1}`,
    name: `Team${groupIndex * 5 + index + 1}`,
    groupId,
    color: palette[index],
  })),
);

export const initialMatches: Match[] = buildTournamentSchedule(teams);

export const findTeam = (id: string) => teams.find((team) => team.id === id);

export const formatTime = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: TOURNAMENT_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
```

- [ ] **Step 4: `src/logic.ts` の `generateKnockoutMatches` を置き換える**

`src/logic.ts` の import 行を差し替える。

```ts
import { GROUP_IDS, R16_SEEDS, TBD } from "./schedule";
import type { Match, Team } from "./types";
```

`generateKnockoutMatches` 関数（44行目以降の末尾まで）を丸ごと削除し、次を追加する。`stageLabel` はそのまま残す。

```ts
/**
 * グループ順位から Round of 16 の対戦相手を埋める。
 * 既存の試合の時刻・コート・ID は変更しない。QF 以降は TBD のまま。
 */
export function seedKnockoutTeams(teams: Team[], matches: Match[]): Match[] {
  const ranked = new Map<string, string[]>(
    GROUP_IDS.map((groupId): [string, string[]] => [
      groupId,
      calculateStandings(groupId, teams, matches).map((row) => row.team.id),
    ]),
  );
  const resolve = (seed: string) => ranked.get(seed[0])?.[Number(seed[1]) - 1] ?? TBD;

  return matches.map((match) => {
    if (match.stage !== "R16") return match;
    const seed = R16_SEEDS[Number(match.id.split("-")[1]) - 1];
    if (!seed) return match;
    return { ...match, homeTeamId: resolve(seed[0]), awayTeamId: resolve(seed[1]) };
  });
}
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `npm test`
Expected: PASS（13 passed）。`src/App.tsx` はまだ `generateKnockoutMatches` を参照しているため `npm run build` はこの時点では失敗する。Task 7 で解消する。

- [ ] **Step 6: コミットする**

```bash
git add src/data.ts src/logic.ts src/data.test.ts
git commit -m "feat: start every match unplayed and seed R16 in place"
```

---

### Task 4: ファイルストア

**Files:**
- Create: `server/store.ts`
- Create: `server/store.test.ts`
- Modify: `src/types.ts`

**Interfaces:**
- Consumes: `buildTournamentSchedule`（`src/schedule.ts`）、`teams`（`src/data.ts`）
- Produces:
  - `TournamentState`（`src/types.ts`）: `{ version: number; updatedAt: string; matches: Match[] }`
  - `PATCHABLE_FIELDS: readonly string[]`
  - `createStore(dataDir: string): Store`
  - `Store`: `read()` / `patchMatch(id, patch)` / `replaceMatches(matches)` / `reset()` / `subscribe(listener): () => void`

書き込みは Promise チェーンで直列化し、一時ファイルへ書いてから `rename` する。これで並行リクエストによる lost update と、書き込み中断によるファイル破損の両方を防ぐ。

- [ ] **Step 1: `TournamentState` を型定義に追加する**

`src/types.ts` の末尾に追記する。

```ts
export interface TournamentState {
  version: number;
  updatedAt: string;
  matches: Match[];
}
```

- [ ] **Step 2: 失敗するテストを書く**

`server/store.test.ts` を作成する。

```ts
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { createStore } from "./store";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "velocity-store-"));
});

describe("createStore", () => {
  test("ファイルが無ければ初期スケジュールを作って保存する", async () => {
    const store = createStore(dataDir);
    const state = await store.read();

    expect(state.matches).toHaveLength(95);
    expect(state.matches.every((match) => match.status === "SCHEDULED")).toBe(true);
    expect(state.version).toBe(1);

    const saved = JSON.parse(await readFile(join(dataDir, "matches.json"), "utf8"));
    expect(saved.matches).toHaveLength(95);
  });

  test("patchMatch は対象の試合だけを書き換える", async () => {
    const store = createStore(dataDir);
    const before = await store.read();
    const target = before.matches[0];

    const after = await store.patchMatch(target.id, { status: "LIVE", homeScore: 2 });
    const updated = after.matches.find((match) => match.id === target.id);

    expect(updated?.status).toBe("LIVE");
    expect(updated?.homeScore).toBe(2);
    expect(after.version).toBe(before.version + 1);
    expect(after.matches.filter((match) => match.id !== target.id)).toEqual(
      before.matches.filter((match) => match.id !== target.id),
    );
  });

  test("並行した patchMatch がどちらも失われない", async () => {
    const store = createStore(dataDir);
    const state = await store.read();
    const [first, second] = state.matches;

    await Promise.all([
      store.patchMatch(first.id, { homeScore: 3 }),
      store.patchMatch(second.id, { awayScore: 5 }),
    ]);

    const final = await store.read();
    expect(final.matches.find((match) => match.id === first.id)?.homeScore).toBe(3);
    expect(final.matches.find((match) => match.id === second.id)?.awayScore).toBe(5);
  });

  test("許可外フィールドの更新を拒否する", async () => {
    const store = createStore(dataDir);
    const state = await store.read();

    await expect(
      store.patchMatch(state.matches[0].id, { court: 99 } as never),
    ).rejects.toThrow(/court/);
  });

  test("存在しない試合IDを拒否する", async () => {
    const store = createStore(dataDir);
    await store.read();

    await expect(store.patchMatch("NOPE-1", { homeScore: 1 })).rejects.toThrow(/NOPE-1/);
  });

  test("壊れた JSON を退避して初期データで復旧する", async () => {
    await writeFile(join(dataDir, "matches.json"), "{ not json", "utf8");
    const store = createStore(dataDir);
    const state = await store.read();

    expect(state.matches).toHaveLength(95);
    const files = await readdir(dataDir);
    expect(files.some((name) => name.startsWith("matches.corrupt-"))).toBe(true);
  });

  test("reset は全試合を未開始に戻す", async () => {
    const store = createStore(dataDir);
    const state = await store.read();
    await store.patchMatch(state.matches[0].id, { status: "FINISHED", homeScore: 4 });

    const reset = await store.reset();
    expect(reset.matches.every((match) => match.status === "SCHEDULED")).toBe(true);
    expect(reset.matches.every((match) => match.homeScore === 0)).toBe(true);
  });

  test("subscribe が書き込みごとに通知し、解除できる", async () => {
    const store = createStore(dataDir);
    const state = await store.read();
    const seen: number[] = [];
    const unsubscribe = store.subscribe((next) => seen.push(next.version));

    await store.patchMatch(state.matches[0].id, { homeScore: 1 });
    unsubscribe();
    await store.patchMatch(state.matches[0].id, { homeScore: 2 });

    expect(seen).toEqual([2]);
  });
});
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `npm test server/store.test.ts`
Expected: FAIL（`./store` が解決できない）

- [ ] **Step 4: `server/store.ts` を実装する**

```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { teams } from "../src/data";
import { buildTournamentSchedule } from "../src/schedule";
import type { Match, TournamentState } from "../src/types";

const FILE_NAME = "matches.json";

/** PATCH で変更を許可するフィールド。スケジュール項目は含めない。 */
export const PATCHABLE_FIELDS = [
  "status",
  "homeScore",
  "awayScore",
  "timerServerStartedAt",
  "timerElapsedSecondsAtPause",
  "penaltyHomeScore",
  "penaltyAwayScore",
  "isPenaltyShootout",
] as const;

export interface Store {
  read(): Promise<TournamentState>;
  patchMatch(id: string, patch: Partial<Match>): Promise<TournamentState>;
  replaceMatches(matches: Match[]): Promise<TournamentState>;
  reset(): Promise<TournamentState>;
  subscribe(listener: (state: TournamentState) => void): () => void;
}

function freshState(): TournamentState {
  return { version: 1, updatedAt: new Date().toISOString(), matches: buildTournamentSchedule(teams) };
}

export function createStore(dataDir: string): Store {
  const filePath = join(dataDir, FILE_NAME);
  const listeners = new Set<(state: TournamentState) => void>();
  let queue: Promise<unknown> = Promise.resolve();

  async function quarantine(): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await rename(filePath, join(dataDir, `matches.corrupt-${stamp}.json`));
  }

  async function write(state: TournamentState): Promise<TournamentState> {
    await mkdir(dataDir, { recursive: true });
    const temporaryPath = `${filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporaryPath, filePath);
    return state;
  }

  async function load(): Promise<TournamentState> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      return write(freshState());
    }

    try {
      const parsed = JSON.parse(raw) as TournamentState;
      if (!Array.isArray(parsed.matches) || typeof parsed.version !== "number") {
        throw new Error("unexpected shape");
      }
      return parsed;
    } catch {
      await quarantine();
      return write(freshState());
    }
  }

  /** 読み取り→変更→書き込みを1件ずつ処理して lost update を防ぐ。 */
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work, work);
    queue = result.catch(() => undefined);
    return result;
  }

  function publish(state: TournamentState): TournamentState {
    for (const listener of listeners) listener(state);
    return state;
  }

  async function commit(matches: Match[]): Promise<TournamentState> {
    const current = await load();
    const next = { version: current.version + 1, updatedAt: new Date().toISOString(), matches };
    await write(next);
    return publish(next);
  }

  return {
    read: () => enqueue(load),

    patchMatch: (id, patch) =>
      enqueue(async () => {
        const unknownField = Object.keys(patch).find(
          (field) => !PATCHABLE_FIELDS.includes(field as (typeof PATCHABLE_FIELDS)[number]),
        );
        if (unknownField) throw new Error(`field is not patchable: ${unknownField}`);

        const current = await load();
        if (!current.matches.some((match) => match.id === id)) {
          throw new Error(`unknown match: ${id}`);
        }
        return commit(
          current.matches.map((match) => (match.id === id ? { ...match, ...patch } : match)),
        );
      }),

    replaceMatches: (matches) => enqueue(() => commit(matches)),

    reset: () => enqueue(() => commit(buildTournamentSchedule(teams))),

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `npm test server/store.test.ts`
Expected: PASS（8 passed）

- [ ] **Step 6: コミットする**

```bash
git add server/store.ts server/store.test.ts src/types.ts
git commit -m "feat: back tournament state with a serialized json file store"
```

---

### Task 5: HTTP API と SSE

**Files:**
- Create: `server/api.ts`
- Create: `server/api.test.ts`
- Create: `server/tempDataPlugin.ts`
- Modify: `vite.config.ts`

**Interfaces:**
- Consumes: `Store`・`createStore`（`server/store.ts`）
- Produces:
  - `createApiHandler(store: Store): (req: IncomingMessage, res: ServerResponse, next: () => void) => void`
  - `tempDataPlugin(): Plugin`（`server/tempDataPlugin.ts` の default export ではなく名前付き export）

`/api/` 以外のリクエストは `next()` で素通しする。そうしないと Vite の HMR と静的配信を壊す。

- [ ] **Step 1: 失敗するテストを書く**

`server/api.test.ts` を作成する。実際に HTTP サーバーを立てて検証する。

```ts
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createApiHandler } from "./api";
import { createStore } from "./store";

let server: Server;
let origin: string;

beforeEach(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "velocity-api-"));
  const handler = createApiHandler(createStore(dataDir));
  server = createServer((req, res) => handler(req, res, () => res.writeHead(404).end()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("GET /api/state が全95試合を返す", async () => {
  const response = await fetch(`${origin}/api/state`);
  expect(response.status).toBe(200);

  const state = await response.json();
  expect(state.matches).toHaveLength(95);
  expect(state.version).toBe(1);
});

test("PATCH /api/matches/:id がスコアを更新する", async () => {
  const before = await (await fetch(`${origin}/api/state`)).json();
  const target = before.matches[0];

  const response = await fetch(`${origin}/api/matches/${target.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "LIVE", homeScore: 1 }),
  });

  expect(response.status).toBe(200);
  const state = await response.json();
  expect(state.matches.find((match: { id: string }) => match.id === target.id).homeScore).toBe(1);
});

test("存在しない試合IDに 404 を返す", async () => {
  const response = await fetch(`${origin}/api/matches/NOPE-1`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ homeScore: 1 }),
  });
  expect(response.status).toBe(404);
});

test("許可外フィールドに 400 を返す", async () => {
  const before = await (await fetch(`${origin}/api/state`)).json();
  const response = await fetch(`${origin}/api/matches/${before.matches[0].id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ court: 99 }),
  });
  expect(response.status).toBe(400);
});

test("POST /api/reset が全試合を未開始に戻す", async () => {
  const before = await (await fetch(`${origin}/api/state`)).json();
  await fetch(`${origin}/api/matches/${before.matches[0].id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "FINISHED" }),
  });

  const state = await (await fetch(`${origin}/api/reset`, { method: "POST" })).json();
  expect(state.matches.every((match: { status: string }) => match.status === "SCHEDULED")).toBe(true);
});

test("GET /api/stream が接続時に全stateを流し、更新を push する", async () => {
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/stream`, { signal: controller.signal });
  expect(response.headers.get("content-type")).toContain("text/event-stream");

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  const readEvent = async () => {
    let buffer = "";
    while (!buffer.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    return buffer;
  };

  const first = await readEvent();
  expect(first).toContain("event: state");

  const state = await (await fetch(`${origin}/api/state`)).json();
  await fetch(`${origin}/api/matches/${state.matches[0].id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ homeScore: 7 }),
  });

  const pushed = await readEvent();
  expect(pushed).toContain('"homeScore": 7');

  controller.abort();
});

test("/api 以外は next() へ渡す", async () => {
  const response = await fetch(`${origin}/matches`);
  expect(response.status).toBe(404);
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test server/api.test.ts`
Expected: FAIL（`./api` が解決できない）

- [ ] **Step 3: `server/api.ts` を実装する**

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "./store";
import type { Match, TournamentState } from "../src/types";

const KEEPALIVE_MS = 15_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function streamState(res: ServerResponse, state: TournamentState): void {
  res.write(`event: state\ndata: ${JSON.stringify(state, null, 2)}\n\n`);
}

/**
 * `/api/*` を処理し、それ以外は next() へ渡す。
 * next() を呼ばないと Vite の HMR と静的配信が止まる。
 */
export function createApiHandler(store: Store) {
  return function handle(req: IncomingMessage, res: ServerResponse, next: () => void): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (!path.startsWith("/api/")) {
      next();
      return;
    }

    void (async () => {
      try {
        if (path === "/api/state" && req.method === "GET") {
          sendJson(res, 200, await store.read());
          return;
        }

        if (path === "/api/stream" && req.method === "GET") {
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store",
            connection: "keep-alive",
          });
          streamState(res, await store.read());

          const unsubscribe = store.subscribe((state) => streamState(res, state));
          const keepalive = setInterval(() => res.write(":keepalive\n\n"), KEEPALIVE_MS);
          req.on("close", () => {
            clearInterval(keepalive);
            unsubscribe();
          });
          return;
        }

        if (path === "/api/reset" && req.method === "POST") {
          sendJson(res, 200, await store.reset());
          return;
        }

        if (path === "/api/matches" && req.method === "PUT") {
          const body = (await readJsonBody(req)) as { matches?: Match[] };
          if (!Array.isArray(body.matches)) {
            sendJson(res, 400, { error: "matches must be an array" });
            return;
          }
          sendJson(res, 200, await store.replaceMatches(body.matches));
          return;
        }

        const patchTarget = path.match(/^\/api\/matches\/(.+)$/);
        if (patchTarget && req.method === "PATCH") {
          const patch = (await readJsonBody(req)) as Partial<Match>;
          try {
            sendJson(res, 200, await store.patchMatch(decodeURIComponent(patchTarget[1]), patch));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendJson(res, message.startsWith("unknown match") ? 404 : 400, { error: message });
          }
          return;
        }

        sendJson(res, 404, { error: `no route for ${req.method} ${path}` });
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    })();
  };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test server/api.test.ts`
Expected: PASS（7 passed）

- [ ] **Step 5: Vite plugin を書く**

`server/tempDataPlugin.ts` を作成する。

```ts
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { createApiHandler } from "./api";
import { createStore } from "./store";

const DATA_DIR = fileURLToPath(new URL("../TempServerData", import.meta.url));

/** 開発サーバーに TempServerData の読み書き API を差し込む。 */
export function tempDataPlugin(): Plugin {
  return {
    name: "velocity-cup-temp-data",
    configureServer(server) {
      const handler = createApiHandler(createStore(DATA_DIR));
      server.middlewares.use((req, res, next) => handler(req, res, next));
    },
  };
}
```

- [ ] **Step 6: `vite.config.ts` に plugin を登録する**

ファイル全体を次の内容にする。

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tempDataPlugin } from "./server/tempDataPlugin";

export default defineConfig({
  plugins: [react(), tempDataPlugin()],
});
```

- [ ] **Step 7: 開発サーバーで API が動くことを確認する**

別ターミナルで `npm run dev` を起動し、次を実行する。

```bash
curl -s http://localhost:5173/api/state | head -20
```

Expected: `version`・`updatedAt`・`matches` を含む JSON が返り、`TempServerData/matches.json` が生成されている。

```bash
node -e "const s=require('./TempServerData/matches.json');console.log(s.matches.length, s.matches.every(m=>m.status==='SCHEDULED'))"
```

Expected: `95 true`

- [ ] **Step 8: コミットする**

```bash
git add server/api.ts server/api.test.ts server/tempDataPlugin.ts vite.config.ts
git commit -m "feat: serve tournament state over http with sse push"
```

---

### Task 6: クライアント API とフック

**Files:**
- Create: `src/api/client.ts`
- Create: `src/api/useTournamentState.ts`

**Interfaces:**
- Consumes: `Match`・`TournamentState`（`src/types.ts`）、`initialMatches`（`src/data.ts`）
- Produces:
  - `fetchState()` / `patchMatch(id, patch)` / `replaceMatches(matches)` / `resetTournament()` — すべて `Promise<TournamentState>`
  - `ConnectionState = "connecting" | "live" | "offline"`
  - `useTournamentState()`: `{ matches, connection, error, patchMatch, replaceMatches, reset }`

サーバーに繋がらない間も最後に取得したデータを表示し続ける。試合中に画面が空になる方が運用上困るため。

- [ ] **Step 1: `src/api/client.ts` を書く**

```ts
import type { Match, TournamentState } from "../types";

async function request(path: string, init?: RequestInit): Promise<TournamentState> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...init?.headers } : init?.headers,
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(detail.error ?? `request failed: ${response.status}`);
  }

  return (await response.json()) as TournamentState;
}

export const fetchState = () => request("/api/state");

export const patchMatch = (id: string, patch: Partial<Match>) =>
  request(`/api/matches/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });

export const replaceMatches = (matches: Match[]) =>
  request("/api/matches", { method: "PUT", body: JSON.stringify({ matches }) });

export const resetTournament = () => request("/api/reset", { method: "POST" });
```

- [ ] **Step 2: `src/api/useTournamentState.ts` を書く**

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import * as client from "./client";
import { initialMatches } from "../data";
import type { Match, TournamentState } from "../types";

export type ConnectionState = "connecting" | "live" | "offline";

/** 旧バージョンが localStorage に残した試合データを一度だけ捨てる。 */
function dropLegacyStorage(): void {
  try {
    localStorage.removeItem("cupflow-matches");
  } catch {
    // プライベートモードなどで localStorage が使えなくても続行する。
  }
}

export function useTournamentState() {
  const [matches, setMatches] = useState<Match[]>(initialMatches);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const versionRef = useRef(0);

  const accept = useCallback((state: TournamentState) => {
    if (state.version < versionRef.current) return;
    versionRef.current = state.version;
    setMatches(state.matches);
  }, []);

  useEffect(() => {
    dropLegacyStorage();

    const source = new EventSource("/api/stream");
    source.addEventListener("state", (event) => {
      setConnection("live");
      setError(null);
      accept(JSON.parse((event as MessageEvent).data) as TournamentState);
    });
    source.onerror = () => setConnection("offline");

    return () => source.close();
  }, [accept]);

  const run = useCallback(
    async (work: () => Promise<TournamentState>) => {
      try {
        accept(await work());
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      }
    },
    [accept],
  );

  return {
    matches,
    connection,
    error,
    patchMatch: useCallback(
      (id: string, patch: Partial<Match>) => run(() => client.patchMatch(id, patch)),
      [run],
    ),
    replaceMatches: useCallback((next: Match[]) => run(() => client.replaceMatches(next)), [run]),
    reset: useCallback(() => run(() => client.resetTournament()), [run]),
  };
}
```

- [ ] **Step 3: 型チェックが通ることを確認する**

Run: `npx tsc -b`
Expected: `src/App.tsx` の `generateKnockoutMatches` 参照エラーのみが残る（Task 7 で解消）。`src/api/` 由来のエラーが無いこと。

- [ ] **Step 4: コミットする**

```bash
git add src/api/client.ts src/api/useTournamentState.ts
git commit -m "feat: subscribe the client to tournament state over sse"
```

---

### Task 7: App.tsx を差し替える

**Files:**
- Modify: `src/App.tsx:1-130`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `useTournamentState`（`src/api/useTournamentState.ts`）、`seedKnockoutTeams`（`src/logic.ts`）
- Produces: なし（画面のみ）

localStorage の試合データ参照6箇所すべてと、30秒ポーリング・`storage` イベント購読を取り除く。管理者フラグ `cupflow-admin-authed` は端末ごとの状態なので残す。

- [ ] **Step 1: import を差し替える**

`src/App.tsx` の1〜5行目を次にする。

```tsx
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { findTeam, formatTime, teams } from "./data";
import { calculateStandings, seedKnockoutTeams, stageLabel } from "./logic";
import { useTournamentState, type ConnectionState } from "./api/useTournamentState";
import { R16_SEEDS, TBD } from "./schedule";
import type { Match, MatchStatus } from "./types";
```

- [ ] **Step 2: `App` 本体の状態管理を置き換える**

`function App() {` の冒頭から `}, []);` で終わる3つ目の `useEffect` までを、次に置き換える。`handleAdminToggle` 以降はそのまま残す。

```tsx
function App() {
  const { matches, connection, error, patchMatch, replaceMatches, reset } = useTournamentState();
  const [isAdmin, setIsAdmin] = useState<boolean>(() => localStorage.getItem(ADMIN_STORAGE_KEY) === "true");
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    localStorage.setItem(ADMIN_STORAGE_KEY, String(isAdmin));
  }, [isAdmin]);

  const updateMatch = (id: string, patch: Partial<Match>) => {
    void patchMatch(id, patch).catch(() => undefined);
  };

  const generateSchedule = () => {
    void replaceMatches(seedKnockoutTeams(teams, matches)).catch(() => undefined);
  };

  const resetTournament = () => {
    void reset().catch(() => undefined);
  };
```

- [ ] **Step 3: 切断バナーを追加する**

`<header className="topbar">` の直前に1行入れる。

```tsx
      <ConnectionBanner connection={connection} error={error} />
```

`Admin` ルートの要素へ `connection` を渡す。該当の `<Route path="/admin/setup" ... />` を次にする。

```tsx
<Route path="/admin/setup" element={isAdmin ? <Admin matches={matches} updateMatch={updateMatch} generateSchedule={generateSchedule} resetTournament={resetTournament} connection={connection} /> : <AdminGate onUnlock={handleAdminLogin} />} />
```

- [ ] **Step 4: `ConnectionBanner` を追加する**

`function AdminLoginModal` の直前に置く。

```tsx
function ConnectionBanner({ connection, error }: { connection: ConnectionState; error: string | null }) {
  if (connection === "live" && !error) return null;

  const message =
    error ?? (connection === "connecting" ? "Connecting to the match server…" : "Disconnected — showing last known data");

  return <div className={`connection-banner ${connection}`}>{message}</div>;
}
```

- [ ] **Step 5: `Admin` を切断対応にする**

`Admin` のシグネチャと、操作ボタン群・生成ボタンを差し替える。`connection !== "live"` の間は操作を無効化する。

```tsx
function Admin({ matches, updateMatch, generateSchedule, resetTournament, connection }: { matches: Match[]; updateMatch: (id: string, patch: Partial<Match>) => void; generateSchedule: () => void; resetTournament: () => void; connection: ConnectionState }) {
```

`save` から楽観更新の行を外す。サーバーが受理した state だけを画面に反映させ、PATCH が失敗したら直前の表示のままにするため。

```tsx
  const save = (status: MatchStatus) => {
    if (!selected) return;
    updateMatch(selected.id, {
      status,
      homeScore: score[0],
      awayScore: score[1],
      timerServerStartedAt: status === "LIVE" ? new Date().toISOString() : undefined,
    });
  };
```

`<div className="control-actions">` の3つのボタンに `disabled={connection !== "live"}` を足す。

```tsx
<div className="control-actions"><button type="button" className="primary-button" disabled={connection !== "live"} onClick={() => save("LIVE")}>▶ Start / resume</button><button type="button" className="outline-button" disabled={connection !== "live"} onClick={() => save("PAUSED")}>Ⅱ Pause</button><button type="button" className="danger-button" disabled={connection !== "live"} onClick={() => save("FINISHED")}>Finish match</button></div>
```

生成ボタンにも同じ `disabled` を足す。

```tsx
<button type="button" className="primary-button" disabled={connection !== "live"} onClick={generateSchedule}>✦ Seed knockout teams</button>
```

- [ ] **Step 6: Bracket の R16 表示を TBD 対応にする**

`function Bracket` の `rounds` 定義のうち Round of 16 の行を次にする。対戦相手が未確定の間はシード表記（`A1` / `H2`）を出す。

```tsx
const rounds = [{ title: "Round of 16", games: r16.length ? r16.map((match, index) => [match.homeTeamId === TBD ? R16_SEEDS[index][0] : findTeam(match.homeTeamId)?.name ?? TBD, match.awayTeamId === TBD ? R16_SEEDS[index][1] : findTeam(match.awayTeamId)?.name ?? TBD]) : R16_SEEDS.map((seed) => [...seed]) },
```

- [ ] **Step 7: CSS を追記する**

`src/styles.css` の末尾に新しい行として追加する。

```css
.connection-banner{position:sticky;top:0;z-index:6;padding:9px 20px;text-align:center;font:11px "DM Mono";letter-spacing:.6px}.connection-banner.connecting{background:#1d2a3f;color:#9fb4d4}.connection-banner.offline{background:#3a1f22;color:#ffc8cc}.control-actions button:disabled,.setup-panel button:disabled{opacity:.45;cursor:not-allowed;transform:none}
```

- [ ] **Step 8: ビルドとテストが通ることを確認する**

Run: `npm run build && npm test`
Expected: どちらも成功。

- [ ] **Step 9: 複数ブラウザーでの同期を確認する**

`npm run dev -- --host 0.0.0.0 --port 4173` を起動し、2つのブラウザー（または通常タブとシークレットタブ）で `http://localhost:4173/matches` を開く。片方で管理画面にログインしスコアを増やす。

Expected: もう一方の画面が即座に更新される。`TempServerData/matches.json` の `version` が増えている。

- [ ] **Step 10: 切断時の挙動を確認する**

開発サーバーを停止する。

Expected: 両方の画面に「Disconnected — showing last known data」が出て、試合一覧は表示されたまま。管理操作ボタンが押せない。

- [ ] **Step 11: コミットする**

```bash
git add src/App.tsx src/styles.css
git commit -m "feat: drive the ui from the shared server state instead of localStorage"
```

---

### Task 8: 管理画面のコート重複表示

**Files:**
- Modify: `src/App.tsx`（import 行、`Admin` の `setup-panel`）
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `findCourtConflicts`（`src/schedule.ts`）、`resetTournament`（Task 7 で `Admin` に渡している）
- Produces: なし

現在の `ⓘ Schedule check: 0 conflicts detected in the current plan.` は固定文字列で、実データを見ていない。`durationMinutes` が入ったので本当に検証できる。あわせて、全試合を未開始へ戻す操作を画面から行えるようにする（従来はブラウザーの localStorage を手で消す必要があった）。

- [ ] **Step 1: import に `findCourtConflicts` を足す**

`src/App.tsx` の schedule からの import を次にする。

```tsx
import { findCourtConflicts, R16_SEEDS, TBD } from "./schedule";
```

- [ ] **Step 2: `setup-panel` の中身を差し替える**

`<section className="admin-panel setup-panel">` の中身を次にする。

```tsx
<section className="admin-panel setup-panel"><label>SUPERADMIN SETUP</label><h3>Seed knockout teams</h3><p>Group fixtures run from 09:00 on 3 courts. Once the group stage is final, this fills the Round of 16 from the standings without moving any kick-off time.</p><ScheduleCheck matches={matches} /><button type="button" className="primary-button" disabled={connection !== "live"} onClick={generateSchedule}>✦ Seed knockout teams</button><ResetButton onReset={resetTournament} disabled={connection !== "live"} /></section>
```

- [ ] **Step 3: `ScheduleCheck` と `ResetButton` を追加する**

`function Empty` の直前に置く。`ResetButton` は2段階クリックにしている。`window.confirm` はブラウザーのモーダルを開き、画面全体の操作を止めてしまうため使わない。

```tsx
function ScheduleCheck({ matches }: { matches: Match[] }) {
  const conflicts = findCourtConflicts(matches);
  const finish = matches.length
    ? formatTime(new Date(Math.max(...matches.map((match) => Date.parse(match.scheduledStart) + match.durationMinutes * 60_000))).toISOString())
    : "—";

  if (!conflicts.length) {
    return <div className="warning-box ok">ⓘ Schedule check: {matches.length} matches, no court clashes, finishing {finish}.</div>;
  }

  return <div className="warning-box">⚠ Schedule check: {conflicts.length} court clash{conflicts.length > 1 ? "es" : ""} — {conflicts.slice(0, 3).map(([a, b]) => `${a.id}×${b.id}`).join(", ")}{conflicts.length > 3 ? "…" : ""}</div>;
}

function ResetButton({ onReset, disabled }: { onReset: () => void; disabled: boolean }) {
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return <button type="button" className="outline-button reset-button" disabled={disabled} onClick={() => setArmed(true)}>↺ Reset all matches</button>;
  }

  return (
    <div className="reset-confirm">
      <span>Reset all 95 matches to unplayed? Scores and timers will be cleared.</span>
      <button type="button" className="danger-button" disabled={disabled} onClick={() => { onReset(); setArmed(false); }}>Yes, reset</button>
      <button type="button" className="outline-button" onClick={() => setArmed(false)}>Cancel</button>
    </div>
  );
}
```

- [ ] **Step 4: CSS を追記する**

`src/styles.css` の末尾の行に続けて追加する。

```css
.warning-box.ok{background:#1a2a20;border-color:#2f5a3c;color:#93d9ab}.reset-button{margin-top:10px;width:100%}.reset-confirm{margin-top:10px;border:1px solid #5b3336;border-radius:8px;padding:14px;display:flex;flex-direction:column;gap:10px}.reset-confirm span{font-size:12px;color:#e6b9bc;line-height:1.6}
```

- [ ] **Step 5: 表示とリセットを確認する**

`npm run dev` を起動し、管理画面へログインする。

Expected: `ⓘ Schedule check: 95 matches, no court clashes, finishing 19:03.` と緑色で表示される。

どれかの試合でスコアを増やして Finish し、`↺ Reset all matches` → `Yes, reset` を押す。

Expected: 全試合が未開始・スコア0に戻り、開いている別ブラウザーの画面にも即座に反映される。

- [ ] **Step 6: ビルドとテストが通ることを確認する**

Run: `npm run build && npm test`
Expected: どちらも成功。

- [ ] **Step 7: コミットする**

```bash
git add src/App.tsx src/styles.css
git commit -m "feat: check the real schedule and allow resetting every match"
```

---

### Task 9: ドキュメント更新

**Files:**
- Modify: `docs/仕様書.md`
- Modify: `docs/memo.md`

**Interfaces:**
- Consumes: なし
- Produces: なし

仕様書は localStorage 前提・旧スケジュール前提で書かれているため、実装と食い違っている箇所を直す。

- [ ] **Step 1: `docs/仕様書.md` を更新する**

次の箇所を書き換える。

| 章 | 変更内容 |
|---|---|
| 2. 技術構成 | 「データ保存: localStorage」→「データ保存: `TempServerData/matches.json`（Vite 開発サーバーの API 経由）」。テストに vitest を追記 |
| 4.2 グループステージ | 開始時刻・スロット構成を追記（09:00 から15分刻み27スロット、3コート） |
| 4.3 ノックアウト | 開始はグループ戦終了後である旨と各ラウンドの時刻を追記 |
| 4.5 試合項目 | `durationMinutes`（試合時間・分）を追加 |
| 9.3 試合操作 | 生成ボタンは「Seed knockout teams」で、R16 の対戦相手のみを埋めることを明記 |
| 11. 非機能・制約 | 「ブラウザー単位のデータ保存」を削除し、サーバー起動中のみ動作すること、複数端末で共有できることに書き換え |
| 13. ビルド・検証 | `npm test` を追記 |

「10. データ同期仕様」は全面差し替える。次の内容にする。

```markdown
## 10. データ同期仕様

試合データは `TempServerData/matches.json` を唯一の正本とする。ブラウザーはこのファイルを直接読み書きできないため、Vite開発サーバーに組み込んだAPIミドルウェア経由で操作する。

### 10.1 API

| メソッド | パス | 用途 |
|---|---|---|
| `GET` | `/api/state` | 全試合とversionを返す |
| `GET` | `/api/stream` | SSE。接続時に全state、以後は更新のたびに配信 |
| `PATCH` | `/api/matches/:id` | 1試合の部分更新 |
| `PUT` | `/api/matches` | 全置換 |
| `POST` | `/api/reset` | 全試合を未開始へ戻す |

### 10.2 更新の流れ

管理画面の操作は `PATCH /api/matches/:id` として送られる。サーバーは該当の試合だけを書き換え、`version` を1つ増やして保存し、接続中の全クライアントへSSEで新しいstateを配信する。

`PATCH` で変更できるのは `status`、`homeScore`、`awayScore`、タイマー項目、PK戦項目のみである。試合ID、Round、Court、開始予定時刻、対戦チームは変更できない。

### 10.3 保全

- 書き込みはPromiseチェーンで直列化し、並行更新による取りこぼしを防ぐ。
- 一時ファイルへ書いてから `rename` するため、書き込み中断でファイルが壊れない。
- 起動時に `matches.json` が壊れていた場合、`matches.corrupt-<日時>.json` へ退避して初期データで作り直す。

### 10.4 接続断

サーバーへ接続できない場合、画面上部に切断バナーを表示し、管理操作を無効化する。最後に取得したデータは表示したままにする。SSEはブラウザーが自動的に再接続し、再接続時に全stateを受け取って同期する。
```

さらに「4.3 ノックアウト」の後に次の節を挿入する。

```markdown
## 4.4 大会スケジュール

全95試合を3コートで 09:00 から連続開催し、19:03 に終了する。

| ラウンド | 時刻 | 試合数 |
|---|---|---|
| グループステージ | 09:00 〜 15:45（15分×27スロット） | 80 |
| Round of 16 | 16:03 / 16:21 / 16:39 | 8 |
| Quarter-finals | 17:15 / 17:33 | 4 |
| Semi-finals | 18:09 | 2 |
| Final | 18:45 〜 19:03 | 1 |

制約は次の2つである。

- 同一コートで試合の時間帯が重ならない。
- 同一チームの試合間隔を15分以上空ける。

両方とも `src/schedule.test.ts` で検証している。以降の節番号は1つずつ繰り下がる。
```

- [ ] **Step 2: `docs/memo.md` を更新する**

「ここまでに実装した内容」に次を追記する。

```markdown
- 試合データの保存先をlocalStorageから `TempServerData/matches.json` へ移行。
- Vite開発サーバーにAPIミドルウェアを追加し、SSEで複数端末へ即時配信。
- 全95試合を未開始状態で初期生成するように変更。
- スケジュールを再設計し、コート二重予約15件を解消。09:00〜19:03に短縮（従来は翌日00:15終了）。
- vitestを導入し、スケジュール制約とファイルストアをテストで担保。
```

「注意事項」から localStorage 関連の2項目を削除し、次に差し替える。

```markdown
- 試合データは `TempServerData/matches.json` に保存する。開発サーバーが起動している間だけ読み書きできる。
- データを初期状態に戻すには `POST /api/reset` を呼ぶか、`TempServerData/matches.json` を削除して開発サーバーを再起動する。
```

「次の候補」から「試合結果に応じたノックアウトチームの自動反映」は残し、完了済みの項目を削除する。

- [ ] **Step 3: コミットする**

```bash
git add docs/仕様書.md docs/memo.md
git commit -m "docs: describe the file-backed store and the repacked schedule"
```

---

## 完了条件

全タスク終了後、次がすべて成立すること。

- [ ] `npm test` が成功する（schedule 9件 / data 4件 / store 8件 / api 7件）
- [ ] `npm run build` が成功し、`git status` がクリーンである
- [ ] `TempServerData/matches.json` が生成され、95試合すべてが `SCHEDULED` である
- [ ] 2つのブラウザーで管理操作が即座に相互反映される
- [ ] サーバー停止時に切断バナーが出て、管理操作が無効になる
- [ ] 管理画面のスケジュール検証が `no court clashes, finishing 19:03` を表示する
