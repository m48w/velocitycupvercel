# Cloudflare 移行と Super-admin / SubAdmin 運営機能

作成日: 2026-09-25
対象: VELOCITY CUP 2026 大会運営Webアプリ

## 1. 目的

大会を本番環境（Cloudflare）で運営できるようにし、運営者の役割を2つに分ける。

1. **Super-admin** — チーム登録、グループ分け、試合作成、公開（確定）、結果の訂正を行う。
2. **SubAdmin** — 担当コートの試合を進行し、得点・状態・PK戦を記録する。1コート2人・計6人。

あわせて、ノックアウトをボタン操作なしで自動進行させる。

## 2. 現状と課題

| 項目 | 現状 | 課題 |
|---|---|---|
| サーバー | Vite 開発サーバーのミドルウェア（`server/`）と `TempServerData/matches.json` | `npm run build` の成果物にはサーバーが無く、デプロイすると保存・同期・認証がすべて動かない |
| 認証 | パスワード `VELOCITY-DEMO-ONLY` をクライアントのコードに埋め込み、localStorage の `"true"` で管理者扱い | パスワードは画面とバンドルに露出。localStorage を書き換えるだけで管理者になれる。API は無認証 |
| チーム | `Team1`〜`Team40` をコードで生成 | 登録・編集・ロゴの仕組みが無い |
| 日程 | 40チーム・8グループ×5チーム固定で自動生成し、起動直後から公開 | 準備→確認→公開の流れが無い。32〜36チームに対応していない |
| 試合操作 | `/admin/setup` で誰でも全試合を操作できる | コート担当の概念が無く、同じ試合を複数端末から同時に操作できる |
| ノックアウト | 「Seed knockout teams」ボタンで R16 だけ埋める | 勝者の次ラウンド進出が無い。同順位の扱いが登録順任せ |

## 3. 決定事項

| 論点 | 決定 |
|---|---|
| ホスティング | Cloudflare **Workers + 静的アセット**（SPA）。API は同じ Worker が `/api/*` で処理する |
| 状態の保存と同期 | **Durable Object（SQLite ストレージ）1個**に大会の全状態を持つ。全端末へ **WebSocket（Hibernation API）** で即時配信する。D1 は使わない |
| ロゴ画像の保存 | **Durable Object の SQLite に BLOB で保存**する（R2 は使わない。§6.4 参照） |
| 規模 | 8グループ固定。チーム数は32〜40（各グループ4〜5チーム、不揃い可）。各グループ上位2チームで Round of 16 |
| グループ分け | Super-admin が全チームを手動で割り当てる |
| 公開 | 下書き日程を作成・確認し、「確定」で公開する。確定前の User 画面は「大会準備中」。試合開始前なら確定を取り消せる |
| SubAdmin | `subadmin1`・`2` → Court 1、`3`・`4` → Court 2、`5`・`6` → Court 3 の固定。先に試合を開いた端末が「確保」し、もう1人は確認のうえ引き継げる |
| ノックアウト | 自動進行（ボタン廃止）。引き分けは SubAdmin が PK 戦のスコアを入力する |
| 同順位 | 勝点 → 得失点差 → 総得点 → 当該チーム間の対戦成績。それでも並べば Super-admin が手動で決め、決まるまで該当する R16 の枠は埋めない |
| 管理ボタン | 開発ビルドでのみ表示。本番では非表示とし、`/superadmin` と `/subadmin` を直接開いてログインする |
| 既存 `/admin/setup` | 廃止し、`/superadmin` と `/subadmin` に置き換える |

## 4. 段階分け

全体を5段階に分け、段階ごとに実装計画・実装・PR を作る。

| 段階 | 内容 | 完了条件 |
|---|---|---|
| 0 | Cloudflare 基盤への移行 | 現行機能のまま Worker + Durable Object + WebSocket で動き、`wrangler deploy` できる |
| 1 | 認証 | Super-admin・SubAdmin がサーバー側で認証され、権限のない操作は API で拒否される |
| 2 | Super-admin 大会準備 | チーム登録からグループ分け・試合作成・確定までを画面で行える |
| 3 | SubAdmin コート運営 | 担当コートの試合を確保・引き継ぎ・記録できる |
| 4 | ノックアウト自動進行 | 同順位判定、R16 の自動確定、勝者の自動進出が動く |

## 5. 全体構成

```
ブラウザ (React SPA)
   │  HTTP  /api/*        ← 変更系（認証 Cookie 付き）
   │  WebSocket /api/ws   ← 状態の受信専用
   ▼
Worker (worker/index.ts)
   ├─ 静的アセット配信（SPA フォールバック）
   ├─ Cookie の検証 → role / username / court / deviceId を決定
   └─ Durable Object "TournamentRoom"（名前 "main" の1インスタンス）へ転送
          ├─ SQLite: meta / teams / logos / matches / draft_matches / locks / login_attempts
          ├─ 業務ロジック（日程生成・順位・自動進行・ロック）
          └─ WebSocket 接続を保持し、変更のたびに役割別の状態を配信
```

- **書き込みは HTTP、受信は WebSocket** に分ける。認証と入力検証を HTTP の1か所に集め、WebSocket は配信だけにする。
- Durable Object は1インスタンスなので、すべての変更が直列に処理される。ロックの競合や lost update はこの直列性で防ぐ。
- 日程生成・順位計算・タイマー計算などの純粋関数は `src/features/tournament/` に置き、画面と Durable Object の両方から使う。

### 5.1 ディレクトリ

```
worker/
├── index.ts            # fetch ハンドラ: ルーティング・Cookie 検証・DO への転送
├── room.ts             # TournamentRoom (Durable Object)
├── auth.ts             # アカウント定義・パスワード照合・セッション署名
├── schema.ts           # SQLite のテーブル定義とマイグレーション
└── *.test.ts           # workerd 上で動くテスト
src/                    # 既存の React アプリ（features/ pages/ ...）
wrangler.jsonc
.dev.vars.example       # 開発用の秘密値の見本（.dev.vars は git 管理外）
```

`server/`、`TempServerData/`、`server/tempDataPlugin.ts` は段階0で削除する。

## 6. データモデル

Durable Object の SQLite に以下を持つ。

### 6.1 meta（1行）

| 列 | 内容 |
|---|---|
| `phase` | `setup`（準備中）または `published`（公開中） |
| `version` | 変更のたびに +1。クライアントは古い版を捨てる（既存の `shouldApply` を流用） |
| `updated_at` | ISO 8601 |

### 6.2 teams

| 列 | 内容 |
|---|---|
| `id` | `T` + 連番（例 `T12`） |
| `name` | 1〜40文字。大会内で重複不可（前後の空白は除去し、大文字小文字は区別しない） |
| `group_id` | `A`〜`H` または NULL（未割当） |
| `color` | ロゴが無いときのバッジ色。登録時に8色から自動で選ぶ |
| `logo_version` | ロゴ更新のたびに +1。NULL はロゴ無し。画像 URL のキャッシュ破棄に使う |
| `source` | `manual` / `csv`。将来のチーム申請フォームでは `application` を追加する |
| `created_at` | ISO 8601 |

チーム ID は試合データ（`homeTeamId` など）から参照される。既存の `Team` 型は `logoUrl?` を加えて拡張する。

### 6.3 matches / draft_matches

既存の `Match` 型を1行1試合で保存する（列は `position`・`id`・`data`。`data` は `Match` の JSON）。段階2〜4で `Match` に項目を足してもテーブル定義を変えずに済むよう、項目ごとの列には分けない。`draft_matches` は「試合作成」で作った下書きで、「確定」で `matches` へ丸ごとコピーする。

`Match` に追加する項目:

| 項目 | 内容 |
|---|---|
| `number` | 表示用の通し番号 No.（開始時刻→コート順に 1 から） |
| `winnerTeamId?` | ノックアウトの勝者。段階4で設定する |

### 6.4 logos

| 列 | 内容 |
|---|---|
| `team_id` | 主キー |
| `content_type` | `image/png` / `image/jpeg` / `image/webp` |
| `bytes` | BLOB。上限 256 KB |

**R2 ではなく Durable Object に保存する理由:** ロゴは最大40枚で、ブラウザ側で 256×256 px に縮小すれば1枚数十KBに収まる。R2 は別サービスの有効化（アカウントの支払い情報登録を求められる場合がある）と別バインディングが必要になるが、この規模では得るものがない。配信は `GET /api/logos/:teamId?v={logo_version}` で、`Cache-Control: public, max-age=31536000, immutable` を付ける。版が変わると URL が変わるので古い画像は残らない。

### 6.5 locks

| 列 | 内容 |
|---|---|
| `match_id` | 主キー |
| `username` | 確保している SubAdmin |
| `device_id` | 確保している端末（ログインごとに発行） |
| `acquired_at` | ISO 8601 |

### 6.6 login_attempts

ユーザー名ごとの連続失敗回数と最終失敗時刻。§7.3 の試行制限に使う。

## 7. 認証（段階1）

### 7.1 アカウント

アカウントは固定で、コードに定義する。パスワードは Cloudflare の Secrets から読む。

| username | 役割 | コート | パスワードの Secret |
|---|---|---|---|
| `superadmin` | Super-admin | 全コート | `SUPERADMIN_PASSWORD` |
| `subadmin1`・`subadmin2` | SubAdmin | Court 1 | `SUBADMIN_PASSWORD` |
| `subadmin3`・`subadmin4` | SubAdmin | Court 2 | 同上 |
| `subadmin5`・`subadmin6` | SubAdmin | Court 3 | 同上 |

- 開発環境の値は `.dev.vars` に置く（`SUPERADMIN_PASSWORD=superadmin1234`、`SUBADMIN_PASSWORD=subadmin1234`）。`.dev.vars` は git 管理外とし、見本の `.dev.vars.example` をコミットする。
- 本番では `wrangler secret put` で別の値を設定する。コードにもバンドルにもパスワードは入らない。
- 照合は `crypto.subtle.timingSafeEqual` で行い、文字列比較の時間差から推測されないようにする。

### 7.2 セッション

- ログイン成功で `session` Cookie を発行する。中身は `{ username, role, court, deviceId, exp }` を `SESSION_SECRET`（Secret）で HMAC-SHA256 署名したもの。
- 属性: `HttpOnly; Secure; SameSite=Strict; Path=/`。有効期限は12時間（大会1日分）。
- `deviceId` はログインごとに新しく発行する。ロックはこの端末単位で持つ（同じ `subadmin1` が2台でログインしても別端末として扱う）。
- ログアウトは Cookie の削除。
- サーバー側にセッションを保存しない。Worker が署名と期限を検証し、結果をヘッダーで Durable Object に渡す（外部から来た同名ヘッダーは Worker が必ず上書きする）。

### 7.3 防御

- **試行制限:** 同じユーザー名で5回続けて失敗したら60秒ログインを拒否する（`429`）。
- **CSRF:** `SameSite=Strict` に加え、変更系 API は `content-type: application/json`（ロゴは `image/*`）を必須とする。
- **権限:** API ごとに必要な役割を決め、満たさなければ `401`（未ログイン）/ `403`（権限なし）を返す。

### 7.4 画面

| パス | 内容 |
|---|---|
| `/superadmin` | 未ログインならパスワード入力、ログイン済みなら大会準備・運営画面 |
| `/subadmin` | 未ログインならユーザー名とパスワード入力、ログイン済みなら担当コート画面 |

- ヘッダーの管理ボタンは `import.meta.env.DEV` のときだけ表示する。
- ログイン状態は `GET /api/session` で取得し、localStorage には保存しない。

### 7.5 段階1の実装で決めたこと

段階1の実装（`docs/superpowers/plans/2026-09-25-stage1-auth.md`）で、この設計書に明記がなかった点を次のように決めた。

| 論点 | 決定 | 理由 |
|---|---|---|
| 既存の変更系 API の権限 | `POST /api/reset`・`PUT /api/matches` は Super-admin のみ。`PATCH /api/matches/:id` は Super-admin は全試合、SubAdmin は担当コートの試合のみ（他コートは `403 WRONG_COURT`） | 段階3の専用 API（確保・得点の増減・状態遷移）ができるまで、コート運営を止めないため。段階3で SubAdmin の `PATCH` は廃止する |
| `/subadmin` の画面 | 既存の試合操作画面を担当コートの試合だけに絞って表示する（Seed・Reset の区画は出さない） | 確保・引き継ぎ付きの画面は段階3で作る |
| 旧 `/admin/setup` | `/superadmin` へ転送する | 古いブックマークで開いても迷わないように |
| `GET /api/state`・`GET /api/ws` | 誰でも可。配信内容は役割で変えない | 役割別の追加データ（ロック・下書き）は段階2・3で生まれる |
| `POST /api/logout` | 未ログインでも `200` で Cookie を消す | 期限切れの端末で「ログアウト」を押してもエラーにしない |
| ログアウトの失敗 | 通信に失敗したらログイン状態のまま「Could not sign out」と表示する | Cookie が有効なまま「ログアウトした」ように見せると、端末を渡された人が権限を持ってしまう |
| ユーザー名の表記ゆれ | 前後の空白を除き小文字にしてから照合する | スマートフォンのキーボードは先頭を大文字にする |
| 存在しないユーザー名 | `401 INVALID_CREDENTIALS`（存在するユーザー名の失敗と同じ応答）。試行回数は数えない | 無作為なユーザー名で `login_attempts` が増え続けないようにする |
| 試行制限の数え方 | 5回失敗すると、6回目以降は60秒間 `429 TOO_MANY_ATTEMPTS`（本文に `retryAfterSeconds`、`Retry-After` ヘッダー）。拒否中は正しいパスワードも受け付けない。拒否が明けたら数え直す。成功すると回数を消す | 並行して送られた推測も、照合と記録の間に `await` を挟まないことで1回ずつ数える |
| Secret 未設定 | ログインは `500 AUTH_NOT_CONFIGURED`。`SESSION_SECRET` が無ければどの Cookie も無効 | 設定漏れのまま本番に出しても、空のパスワードや空の鍵で通らないようにする |
| 利用者ヘッダー | Worker が渡すのは `x-auth-username` と `x-auth-device` だけ。役割とコートは Durable Object がアカウント表から決める | ヘッダーの値を信じる範囲を最小にする |
| セッション切れ | 変更が `401` になったら、画面がログイン状態を取り直してログインフォームに戻る | 12時間の期限が大会中に切れても、黙って失敗し続けないように |

## 8. Super-admin 大会準備（段階2）

`/superadmin` は上から順に次の区画を持つ。

### 8.1 チーム一覧

- 全チームを表で表示する（ロゴ・チーム名・グループ・操作）。
- **追加:** チーム名とロゴ画像（任意）を入力。画像はブラウザで 256×256 px に縮小・トリミングしてから送る。
- **編集・削除:** 行ごとに行う。
- **CSV 取り込み:** 1行1チーム、列は `name,logo_url`（`logo_url` は任意）。先頭行が `name` ならヘッダーとして読み飛ばす。取り込み前にプレビューを出し、重複名や不正な行を示してから確定する。`logo_url` は Worker が取得する（`https` のみ、画像形式のみ、256 KB 以下）。取得できなかった行はロゴ無しで登録し、結果に一覧で示す。
- **グループ割当:** 各行のプルダウンで `A`〜`H` / 未割当を選ぶ。

### 8.2 グループ確認

8グループをカードで並べ、各カードにロゴとチーム名だけを表示する。各グループのチーム数を示し、4〜5チームでないグループは警告色にする。

### 8.3 試合作成

「試合作成」ボタンを押すと、現在のグループ分けから下書き日程（`draft_matches`）を作る。

作成できる条件（満たさない場合はボタンの横に理由を表示する）:

- 登録チーム数が32〜40。
- 全チームがいずれかのグループに割り当て済み。
- 全8グループが4〜5チーム。
- 公開中（`published`）でない。

日程の規則は現行（`docs/仕様書.md` 4.2〜4.4）を一般化する。

- グループ内総当たり（5チームで10試合、4チームで6試合）。
- 09:00 から15分刻み。Court 3 は 12:15 から使う。同一スロットに同じチームは1回まで、連続スロットに出ない（休憩15分以上）。
- ノックアウトはグループ戦終了の18分後から。R16 18分、QF・SF 15分、決勝 23分、ラウンド間18分。

作成後、全試合を表で表示する。

| No | Match | Court | 試合チーム | 試合時間 |
|---|---|---|---|---|
| 1 | Group A | 1 | Team4 vs Team5 | 09:00〜09:15 |
| … | | | | |
| 95 | Final | 1 | Winner SF1 vs Winner SF2 | 19:36〜19:59 |

表の上に Schedule check（試合数、コート重複の有無、終了時刻）を表示する。グループ分けを変えたら、もう一度「試合作成」を押して作り直す（下書きは上書きされる）。

### 8.4 確定と取り消し

- **確定:** 下書きを `matches` にコピーし、`phase` を `published` にする。以後 User 画面に日程・順位・トーナメント表が表示される。
- **確定の取り消し:** 公開中かつ全試合が `SCHEDULED` のときだけ押せる。`phase` を `setup` に戻す（下書きは残る）。
- **公開中に変更できるもの:** チーム名とロゴ（日程に影響しないため）。グループ割当・チームの追加削除・試合作成は、確定を取り消すまでできない。

### 8.5 User 画面（公開前）

`phase` が `setup` の間、User 画面（Overview・Matches・Live・Standings・Bracket）は「大会準備中」の案内だけを表示する。WebSocket で公開と同時に切り替わる。

### 8.6 運営中の Super-admin の操作

公開後、同じ `/superadmin` に次を表示する。

- 全コートの試合の状態と、どの SubAdmin がどの試合を確保しているか。
- **ロックの強制解除**（SubAdmin の端末が使えなくなったとき）。
- **結果の訂正:** `FINISHED` の試合の得点・PK を直す。訂正で勝者が変わる場合、次の試合がまだ `SCHEDULED` なら進出チームも入れ替え、始まっていれば訂正を拒否する（`409`）。
- **同順位の決定:** §10.1 で順位が決まらないグループがあれば、該当チームの順番を指定する。

## 9. SubAdmin コート運営（段階3）

### 9.1 画面

- 上部に「Court 2 · subadmin3」のように担当を表示する。
- 担当コートの試合を開始時刻順に並べ、次に行う試合を強調する。各行に状態とスコア、確保者を表示する。
- 試合を開くと確保（§9.2）し、操作画面を表示する。操作画面は現行 Admin 画面の状態表示（`MatchStateBanner`）と、状態に応じたボタンを引き継ぐ。
  - `SCHEDULED`: ▶ Start match
  - `LIVE`: Ⅱ Pause / ■ Finish match
  - `PAUSED`: ▶ Resume / ■ Finish match
- 得点の +/− は即時保存する。

### 9.2 確保と引き継ぎ

| 操作 | 条件 | 結果 |
|---|---|---|
| 確保 | 担当コートの試合で、誰も確保していない | 自分の端末が確保者になる |
| 引き継ぎ | 他の端末が確保している | 確認ダイアログのあと、自分の端末に移る。元の端末の画面は WebSocket で「subadmin3 が引き継ぎました」と表示して閲覧専用になる |
| 解放 | 自分が確保している | 「閉じる」で解放する。試合終了時は自動で解放する |
| 強制解除 | Super-admin | 確保者を消す |

- 1端末が同時に確保できるのは1試合まで。別の試合を開くと、前の試合は自動で解放する。
- 確保には期限を設けない（端末が落ちた場合は引き継ぎか強制解除で対応する）。

### 9.3 サーバー側の検証

変更系 API はすべて Durable Object で検証する。

- 担当コート以外の試合は操作できない（`403`）。
- 自分の端末が確保していない試合は操作できない（`409 LOCKED_BY_OTHER` / `409 NOT_LOCKED`）。
- 状態遷移は `SCHEDULED→LIVE`、`LIVE→PAUSED`、`PAUSED→LIVE`、`LIVE|PAUSED→FINISHED` のみ（それ以外は `409 INVALID_TRANSITION`）。
- **得点は増減で送る**（`{ side: "home", delta: 1 }`）。現行の「絶対値を送る」方式では、通信が遅いときの連打で1点失われることがあるため（2026-09-25 の修正報告で指摘した既知の問題）。得点は0未満にならない。
- **タイマーはサーバーの時計で記録する**（`timerServerStartedAt` / `timerElapsedSecondsAtPause` を Durable Object が設定する）。端末ごとの時計のずれがタイマーに影響しない。計算は現行の `statusPatch` / `elapsedSeconds` をサーバー側で使う。

### 9.4 PK 戦

ノックアウトの試合を同点のまま「Finish match」しようとすると、PK 戦のスコア入力欄を出す。PK は同点不可。確定すると `isPenaltyShootout: true` と `penaltyHomeScore` / `penaltyAwayScore` を保存して終了する。グループ戦は引き分けのまま終了できる。

## 10. ノックアウト自動進行（段階4）

試合が終了（または訂正）されるたびに、Durable Object が同じ処理の中で次を行う。

### 10.1 グループ順位

グループの全試合が終わったら順位を確定する。並びの基準は順に:

1. 勝点（勝ち3・引き分け1）
2. 得失点差
3. 総得点
4. 当該チーム間の対戦成績（勝点 → 得失点差 → 総得点）
5. Super-admin の手動指定（§8.6）

5 が必要なグループは「順位未確定」とし、Super-admin 画面に表示する。

### 10.2 R16 の確定

R16 の各試合は、シード表（`R16_SEEDS`、例 `A1` 対 `H2`）の両グループの順位が確定した時点で対戦チームを埋める。片方でも未確定なら `TBD` のまま。

### 10.3 勝者の進出

ノックアウトの試合が終わったら勝者（得点が多い側、同点なら PK の勝者）を `winnerTeamId` に記録し、`sourceMatchIds` で参照している次の試合の該当側に入れる（既存の構造: `QF-1` ← `R16-1`・`R16-2`）。

### 10.4 廃止するもの

「Seed knockout teams」ボタンと `seedKnockoutTeams` の呼び出しは廃止する。

## 11. API

| メソッド | パス | 役割 | 用途 |
|---|---|---|---|
| POST | `/api/login` | 誰でも | ログイン |
| POST | `/api/logout` | 誰でも | ログアウト（未ログインでも `200`。§7.5） |
| GET | `/api/session` | 誰でも | ログイン状態 |
| GET | `/api/ws` | 誰でも | WebSocket（役割に応じた状態を配信） |
| GET | `/api/logos/:teamId` | 誰でも | ロゴ画像 |
| POST / PATCH / DELETE | `/api/teams`、`/api/teams/:id` | Super-admin | チームの追加・編集・削除（グループ割当を含む） |
| PUT | `/api/teams/:id/logo` | Super-admin | ロゴの登録・差し替え |
| POST | `/api/teams/import` | Super-admin | CSV 取り込み |
| POST | `/api/schedule/draft` | Super-admin | 試合作成 |
| POST | `/api/schedule/publish` | Super-admin | 確定 |
| POST | `/api/schedule/unpublish` | Super-admin | 確定の取り消し |
| POST / DELETE | `/api/matches/:id/lock` | SubAdmin（担当コート）/ Super-admin は DELETE のみ | 確保・引き継ぎ（`{ takeover: true }`）・解放・強制解除 |
| POST | `/api/matches/:id/score` | SubAdmin（確保中） | 得点の増減 |
| POST | `/api/matches/:id/status` | SubAdmin（確保中） | 開始・一時停止・再開・終了（PK を含む） |
| PATCH | `/api/matches/:id/result` | Super-admin | 終了済み試合の訂正 |
| PUT | `/api/groups/:id/order` | Super-admin | 同順位の手動指定 |
| POST | `/api/reset` | Super-admin | 全試合を未開始に戻す（公開中のまま） |

エラーは現行どおり `{ "error": "...", "code": "..." }` で返す。

### 11.1 WebSocket で配信する状態

| 受信者 | 内容 |
|---|---|
| 全員 | `phase`、`version`。公開中は公開用のチーム（ID・名前・色・ロゴ URL・グループ）と `matches` |
| SubAdmin | 上記に加え、全試合の確保状況 |
| Super-admin | 上記に加え、全チーム（未割当を含む）、`draft_matches`、順位未確定のグループ |

接続時に最新状態を1回送り、以後は変更のたびに送る。クライアントは切断されたら 1 秒から最大 10 秒まで間隔を延ばしながら再接続し、接続中は画面上部の既存の接続バナーで状態を示す。

## 12. 段階0: Cloudflare への移行

- `@cloudflare/vite-plugin` を導入し、`npm run dev` で Worker と Durable Object がローカルの workerd 上で動くようにする。ローカルのデータは `.wrangler/state/` に保存される（git 管理外）。
- 現行 API（状態の取得・試合の PATCH・一括置換・リセット）を Durable Object に移し、SSE を WebSocket に置き換える。クライアントの `useTournamentState` は WebSocket 受信に切り替える。
- この段階では認証を加えない（現行と同じく誰でも操作できる）。段階1で認証を入れる。
- `npm run deploy`（`vite build && wrangler deploy`）を追加する。初回デプロイ前に、利用者が `wrangler login` と Secrets の設定を行う。

## 13. テスト

| 対象 | 方法 |
|---|---|
| 日程生成・順位・同順位判定・勝者進出・タイマー | vitest の単体テスト（純粋関数） |
| Durable Object（ロック、状態遷移、権限、公開フロー、自動進行） | `@cloudflare/vitest-pool-workers` で workerd 上で実行 |
| Worker（Cookie 署名・検証、試行制限、ルーティング） | 同上 |
| 画面 | 段階ごとに開発サーバーで主要な操作を確認する |

日程生成は、32〜40チームの各チーム数と、4〜5チームの不揃いなグループ構成で、コート重複0件・同一チームの休憩15分以上・Court 3 が 12:15 より前に無いことを検証する。

## 14. 範囲外

- チーム申請フォーム（将来。`teams.source` に `application` を追加して取り込める構造にしておく）
- パスワード変更画面（Secrets の更新で行う）
- 複数大会の管理
- 大会日・開始時刻・コート数の画面からの変更（コードの定数のまま）
- 操作履歴（監査ログ）

## 15. リスクと確認事項

| 項目 | 内容 | 対応 |
|---|---|---|
| テスト基盤の版 | `@cloudflare/vitest-pool-workers` が対応する vitest の版が、現行の vitest 3.2 と合うか | 段階0の計画で確認し、必要なら vitest の版を合わせる |
| 無料枠 | Workers / Durable Objects の無料枠は1日10万リクエスト。WebSocket の接続確立は1リクエスト、サーバーからの送信は無料 | 観客数百人規模なら収まる見込み。ロゴは長期キャッシュで再取得を減らす |
| Cloudflare アカウント | デプロイには利用者のアカウントでの `wrangler login` が必要 | 段階0の完了時に手順を案内する |
| CSV のロゴ取得 | 外部 URL の取得に失敗しうる | 失敗してもチームは登録し、結果に一覧で示す |
| ログインの妨害 | ユーザー名は固定で推測できるため、誰でも60秒ごとに5回間違えれば、そのアカウントに新しくログインできない状態を続けられる（ログイン済みの端末は12時間使える） | 未決定。接続元 IP ごとに数えるよう §7.3 を変えるか、当日の朝にログインする運用で受け入れるかを利用者が決める |
| セッションの期限 | 12時間なので、前夜や早朝にログインすると決勝の前後で切れうる | 当日の朝にログインするよう README・仕様書に記載済み。切れても次の操作でログインフォームに戻る |
| オフラインでの初回表示 | ログイン済みでも、通信できない状態でページを開くとログインフォームが出る（`GET /api/session` の失敗を未ログイン扱いにしている） | 段階3より前に直す。段階3ではログインし直すと `deviceId` が変わり、試合の確保を失うため |
| 別の役割でのログイン | Super-admin が `/subadmin` を開く（またはその逆）と、今のログイン状態を示さずにログインフォームを出し、ログインすると Cookie が置き換わる | 段階2・3の画面作りで「◯◯でログイン中」の表示を加える |
| コートの確認と書き込みの間 | `PATCH` はコートを確認したあとに本文を読むため、その間に Super-admin の全置換が割り込む余地がある | 段階3で SubAdmin 用の API に置き換えるときに、確認と書き込みを同じ処理の中で行う |
| 一部のエラーに `code` が無い | 段階0から残る `400`（配列でない・JSON が壊れている）、`404`（ルートなし）、`426` に `code` が無い | 段階2で API を足すときに揃える |
