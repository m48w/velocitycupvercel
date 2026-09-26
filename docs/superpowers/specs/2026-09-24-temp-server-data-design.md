# TempServerData 移行とスケジュール再設計

作成日: 2026-09-24
対象: VELOCITY CUP 2026 大会運営Webアプリ

## 1. 目的

本設計は3つの課題をまとめて解決する。

1. **保存先の移行** — 試合データを localStorage からプロジェクト内 `TempServerData/` のファイルへ移し、複数ブラウザー・複数端末で同じデータを共有する。
2. **初期状態の統一** — 初期化・リセット時は全95試合を未開始（`SCHEDULED`・スコア0）にする。
3. **スケジュールの再設計** — 現行スケジュールの破綻（翌日 00:15 終了、コート二重予約15件）を解消し、09:00〜19:03 に収める。

## 2. 現状の課題

### 2.1 localStorage 依存

`src/App.tsx` の6箇所が `localStorage` を直接参照している。

| 箇所 | 内容 |
|---|---|
| `useState` 初期化 | `cupflow-matches` を読み、グループ戦の court を再計算 |
| `syncMatchesFromStorage` | 再読み込み |
| `useEffect` | matches 変更時に書き込み |
| `useEffect` | 管理者フラグ `cupflow-admin-authed` を書き込み |
| `updateMatch` | 更新時に直接書き込み |
| `generateSchedule` | 生成時に直接書き込み |

同期は `storage` イベント（同一ブラウザーの別タブのみ）と30秒間隔のポーリングに頼っており、別端末には一切伝わらない。

### 2.2 スケジュールの破綻

`src/data.ts` はグループを120分間隔で直列に並べる。各グループは60分で終わるため、**グループごとに60分コートが完全に空く**。

| | 開始 | 最終キックオフ |
|---|---|---|
| Group A | 09/26 09:00 | 10:00 |
| Group B | 11:00 | 12:00 |
| ... | | |
| Group H | 23:00 | 09/27 00:00 |

一方 `src/logic.ts` の `generateKnockoutMatches` はノックアウトを 09/26 13:00 固定で開始する。結果:

- **コート二重予約が15件**（例: `G-C-1`(Court1 13:00) と `R16-1`(Court1 13:00) が完全に同時刻同コート）
- **決勝が 17:12 に終わった後、グループ戦が約7時間残る**（優勝者決定後に予選が続く）
- 大会終了は **09/27 00:15**、総所要 15.3時間
- コート負荷の偏り: Court1=39試合 / Court2=29 / Court3=27（`slot % 3` による割当が10試合ごとに Court1 へ寄る）

管理画面の「generated across 3 courts from 09:00 to 20:00」「0 conflicts detected in the current plan」は固定文字列で、実データを検証していない。

### 2.3 その他

- `src/data.ts` は Group A の1試合を `LIVE`、各グループ2試合を `FINISHED` として初期生成する。
- 初期生成はグループ戦80試合のみ。ノックアウト15試合は管理画面のボタンを押すまで存在しないが、サイドバーは「95 matches」と表示している。
- `formatTime` が `Intl.DateTimeFormat` にタイムゾーンを渡していないため、表示時刻が閲覧端末のタイムゾーンに依存する。複数端末で共有すると端末ごとに違う時刻が出る。
- `vite.config.js` と `vite.config.d.ts` が `tsc -b` の生成物としてコミットされている（`tsconfig.node.json` が `composite: true` で `outDir` 未指定のため）。

## 3. 決定事項

| 論点 | 決定 | 理由 |
|---|---|---|
| 同期範囲 | 複数ブラウザー・端末で共有 | 大会運営では複数のコート担当が別端末から操作する |
| 稼働形態 | `npm run dev` のみ | 追加依存ゼロ、起動手順を変えない。ビルド後配信は対象外 |
| フォルダー名 | `TempServerData` | 提示の `TempSeverData` は綴り誤りのため修正 |
| 更新配信 | SSE | 即時性が要る。Node標準のみで書け、再接続はブラウザーが自動で行う |
| 最低休憩 | 1試合分（15分） | 同一チームが連続スロットに入らない |
| 途中休憩 | なし | 連続開催 |
| 管理者フラグ | localStorage に残す | 端末ごとの状態。サーバーに置くと1人のログインで全端末が管理者になる |

## 4. アーキテクチャ

```
[管理画面] ──PATCH /api/matches/:id──▶ [Vite middleware] ──▶ TempServerData/matches.json
                                              │
                                              └──broadcast──▶ SSE ──▶ [全端末の画面が即更新]
```

ブラウザーの JavaScript はローカルファイルへ書き込めないため、Vite 開発サーバーに API ミドルウェアを1枚差し込む。ランタイム依存の追加はない。

### 4.1 ファイル構成

```
TempServerData/
  .gitkeep                    フォルダーを git に残す
  matches.json                試合データの正本（生成物・gitignore）

server/
  store.ts                    読み書き・直列化・初期化・破損復旧
  store.test.ts
  api.ts                      ルーティングと SSE 配信
  tempDataPlugin.ts           Vite plugin（configureServer）

src/
  schedule.ts                 スケジュール生成（純粋関数）
  schedule.test.ts
  api/client.ts               fetch ラッパ
  api/useTournamentState.ts   SSE 購読フック
  App.tsx                     localStorage 呼び出しをフックに差し替え
```

### 4.2 保存ファイル形式

`TempServerData/matches.json`:

```json
{
  "version": 12,
  "updatedAt": "2026-09-26T04:31:07.412Z",
  "matches": []
}
```

`version` は書き込みごとに増える整数。クライアントは古い SSE メッセージを無視するために使う。

## 5. API 仕様

| メソッド | パス | 用途 |
|---|---|---|
| `GET` | `/api/state` | 全試合＋version。初期表示とフォールバック |
| `GET` | `/api/stream` | SSE。接続時に全state、以後は書き込みのたびに push |
| `PATCH` | `/api/matches/:id` | 1試合の部分更新 |
| `PUT` | `/api/matches` | 全置換（ノックアウト生成） |
| `POST` | `/api/reset` | 初期スケジュールへ戻す |

### 5.1 PATCH /api/matches/:id

リクエストボディは `Match` の部分更新。受け付けるフィールドは次のみに限定し、それ以外は 400 を返す。

```
status, homeScore, awayScore,
timerServerStartedAt, timerElapsedSecondsAtPause,
penaltyHomeScore, penaltyAwayScore, isPenaltyShootout
```

`id`・`stage`・`court`・`scheduledStart`・`homeTeamId`・`awayTeamId` は PATCH では変更できない。スケジュールの改変は `PUT /api/matches` 経由に限る。

レスポンス: 更新後の全state（`{ version, updatedAt, matches }`）。

エラー: 存在しない試合ID → 404。許可外フィールド／型不正 → 400。

### 5.2 GET /api/stream

`text/event-stream` を返す。

- 接続確立時に `event: state` で全stateを1回送る（初期表示もこの経路で足りる）
- 以後、書き込みが成功するたびに全接続へ `event: state` を送る
- 15秒ごとにコメント行（`:keepalive`）を送り、プロキシによる切断を防ぐ
- クライアント切断時はリスナーを解除する

全state送信にしているのは、95試合・数十KBと小さく、差分同期の複雑さに見合わないため。

### 5.3 書き込み競合の扱い

管理画面は試合全体ではなく**その試合への差分だけ**を送る。サーバーはファイル内の該当試合だけを書き換えるため、Court 1 と Court 2 の担当者が別々の試合を同時に操作しても互いを踏み潰さない。同じ試合を同時に操作した場合のみ後勝ちとなるが、運用上許容する。

楽観ロック（`If-Match` + 409）は採用しない。差分適用により競合面が試合単位まで狭まっており、追加の複雑さに見合わない。

書き込みは以下で保護する。

- **直列化** — Promise チェーンで読み取り→変更→書き込みを1件ずつ処理する。並行リクエストによる lost update を防ぐ。
- **アトミック書き込み** — 一時ファイルへ書いてから `rename` する。書き込み中断でファイルが壊れない。

## 6. スケジュール設計

### 6.1 アルゴリズム

`src/schedule.ts` に純粋関数 `buildTournamentSchedule()` として実装する。乱数を使わず決定的にし、テストを安定させる。

**グループ戦** — 15分スロット単位の貪欲法。

1. スロットごとに最大3試合（3コート）を選ぶ
2. 制約: 同一スロットに同じチームが2回出ない／直前スロットに出たチームは選ばない（休憩15分以上）
3. 選択順は「残り試合数が多いチームを含む試合」を優先する（most-constrained-first）

試作で **27スロット・コート稼働率98.8%** を達成済み。80試合÷3コート＝26.67 なので27スロットが理論下限であり、これ以上詰められない。

**ノックアウト** — 18分スロット。グループ戦終了後に開始する（R16の組み合わせは最終順位が確定しないと決まらないため、時間的に後ろへ置くことが論理的に必須）。ラウンド間に1スロット（18分）の休憩を置く。

### 6.2 結果

```
グループ戦   09:00 〜 15:45   (27スロット × 15分、80試合)
  ↓ 順位確定・ブラケット発表
Round of 16  16:03, 16:21, 16:39
Quarter      17:15, 17:33
Semi         18:09
Final        18:45 〜 19:03
```

- 終了 **19:03**（現行の翌日 00:15 から5時間以上短縮）
- コート重複 **0件**
- 休憩違反 **0件**
- コート分散 C1=34 / C2=32 / C3=29

グループ戦の405分は下限のため、さらに短縮するにはコートを増やすか1試合を15分より短くするしかない。

### 6.3 型の変更

`Match` に `durationMinutes: number` を追加する（グループ戦15、ノックアウト18）。

現行の型は `scheduledStart` しか持たず、試合の終了時刻が計算できない。そのためコート重複を機械的に検証できず、管理画面の「0 conflicts detected」も固定文字列のままになっている。この項目を入れることで重複検証をテストと実行時の双方で行えるようになる。

### 6.4 初期データ

`resetState()` および初回起動時の生成は次を満たす。

- 全**95試合**を生成する（現行はグループ戦80試合のみ。サイドバーの「95 matches」表示と一致させる）
- 全試合 `status: "SCHEDULED"`、`homeScore: 0`、`awayScore: 0`、タイマー項目なし
- ノックアウト15試合は時刻・コートを確定させ、対戦チームのみ `TBD`
- 管理画面の生成ボタンは TBD を実チームに差し替えるだけで、時刻とコートは動かさない

## 7. クライアント設計

### 7.1 useTournamentState フック

```ts
const { matches, connection, patchMatch, replaceMatches, reset } = useTournamentState();
// connection: "connecting" | "live" | "offline"
```

`App.tsx` の localStorage 関連コード（`useState` 初期化、`syncMatchesFromStorage`、2つの `useEffect`、`updateMatch`、`generateSchedule` 内の直接書き込み）をこのフックへ置き換える。30秒ポーリングと `storage` イベント購読は SSE に置き換わるため削除する。

### 7.2 エラー処理

| 状況 | 挙動 |
|---|---|
| サーバーに繋がらない | 画面上部に切断バナー。管理操作ボタンを無効化。**最後に取得したデータは表示したままにする**（試合中に画面が空になる方が困る） |
| SSE 切断 | `EventSource` が自動再接続。再接続時に全stateを受け取り同期 |
| PATCH 失敗 | 操作を取り消して直前の状態へ戻し、エラーを表示 |
| `matches.json` が壊れている | 起動時に検知したら `matches.corrupt-<日時>.json` へ退避し、初期データで作り直す。黙って握り潰さない |

### 7.3 旧データの掃除

新バージョン初回読み込み時に `localStorage.removeItem("cupflow-matches")` を実行する。読み取りコードは無くなるので実害はないが、残しておくと調査時に混乱を招くため削除する。`cupflow-admin-authed` は引き続き使うため残す。

## 8. 付随して直すもの

作業対象に直接影響する範囲のみ。これ以外のリファクタは行わない。

1. **`formatTime` のタイムゾーン固定** — `Intl.DateTimeFormat` に `timeZone: "Asia/Tokyo"` を渡す。現状は閲覧端末のタイムゾーンで表示されるため、複数端末共有にすると端末ごとに違う時刻が出る。本設計が特定時刻を前提にする以上、放置できない。
2. **ビルド生成物の除外** — `tsconfig.node.json` に `outDir: "./node_modules/.tmp/node-build"` を設定し、`vite.config.js` と `vite.config.d.ts` をリポジトリから削除して `.gitignore` に追加する。`server/` を TypeScript で追加すると同じ生成物が増え続けるため。
3. **管理画面の conflicts 表示** — 固定文字列をやめ、`durationMinutes` を用いた実際の重複検証結果を表示する。

## 9. テスト

現状テストが1件もないため `vitest` を devDependency に1つ追加し、`package.json` に `"test": "vitest run"` を追加する。Vite プロジェクトなので設定を共有でき、TypeScript もそのまま通る。ランタイム依存は増えない。

### server/store.test.ts

- ファイルが無い場合、初期スケジュールを生成して保存する
- `patchMatch` が該当試合のみを書き換え、他の試合を変更しない
- 並行した `patchMatch` が直列化され、どちらの更新も失われない
- 許可外フィールドの PATCH を拒否する
- 壊れた JSON を退避し、初期データで復旧する
- `resetState` が全試合を `SCHEDULED`・スコア0に戻す

### src/schedule.test.ts

- 95試合を生成する（グループ80 + ノックアウト15）
- 全試合が `SCHEDULED`・スコア0で、タイマー項目を持たない
- **コート重複が0件**（`durationMinutes` による時間帯の重なり判定）
- **同一チームの試合間隔が15分以上**
- 同一スロットに同じチームが2回現れない
- 最終試合の終了が 19:03 である
- 同じ入力で常に同じ出力になる（決定的）

このうち価値が高いのは重複0件と休憩15分以上の2件で、これらは現在どこでも検証されていない。

## 10. 対象外

以下は本設計に含めない。

- WebSocket による双方向通信（書き込みは管理者のみで一方向、SSEで足りる）
- ビルド後・本番環境での配信
- サーバーサイドの管理者認証（デモ用キーのまま）
- 操作履歴・監査ログ
- チーム名・ロゴ・コート数の管理画面からの編集
- 3位決定戦
- 楽観ロックによる競合検出

## 11. 確認方法

```bash
npm install
npm run dev -- --host 0.0.0.0 --port 4173
```

1. `TempServerData/matches.json` が生成され、95試合すべてが `SCHEDULED` であること
2. `http://localhost:4173/matches` で95試合が表示されること
3. 管理画面でスコアを操作し、`matches.json` が更新されること
4. **別のブラウザー（別端末可）で同じURLを開き、管理画面の操作が即座に反映されること**
5. サーバーを停止すると切断バナーが出て、管理操作が無効になること
6. `npm run build` と `npm test` が成功すること

項目4が本設計の成否を分ける確認点である。
