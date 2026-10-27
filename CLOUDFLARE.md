# 自分のCloudflareアカウントへの移行

## 現在の状態

現在のSites版は引き続き動作しています。この移行用一式を作っただけでは、既存のデータベースや共有URLは変更しません。

Cloudflareへの本番配置には、ご自身のアカウントへの認証が必要です。この作業環境にはその接続がないため、最初の認証と配置用コマンドは、ご自身の端末で実行してください。認証情報をチャットに貼る必要はありません。

## 実行

Node.js 22.13以上とnpmが入った端末で、このフォルダーを開いて実行します。

```sh
bash deploy-cloudflare.sh
```

依存関係を導入してから移行スクリプトを実行します。Wranglerの認証が必要な場合は、表示された案内に沿って、ご自身のブラウザーで認証します。Cloudflareアカウントが複数ある場合は、対象のアカウントIDの指定が必要です。

新しいD1を作成し、同梱の予定・参加者データを取り込み、そのD1を接続したWorkerを公開するための構成です。既存のCloudflareデータベースへの上書きは行いません。

## GitHubでの管理と通常の更新

初回移行が完了した端末で、一度だけ以下を実行してください。

```sh
node scripts/cloudflare-update.mjs --init
```

現在のWorkerとD1を指定する`cloudflare.production.json`を生成します。このファイルはGitHubに含めます。接続先の識別子と適用済みSQLの照合情報を保存し、APIトークンや予定・参加者データは含めません。

`migration/`と`.cloudflare-migration/`、`.env*`、`.dev.vars*`、`dist/`、`node_modules/`はGitに含めません。データベースの構造を定義する`drizzle/`は含めます。すでに追跡したデータは、`.gitignore`の追加だけでは除外されません。まだコミットしていない場合は、該当ファイルをステージから外してください。すでに公開した秘密情報がある場合は、削除だけで解決したことにはしません。

画面や処理を変更した後は、以下で既存の公開先を更新します。

```sh
node scripts/cloudflare-update.mjs
```

同じWorker名と同じD1を指定して、ビルド・公開します。予定データの取り込み直し、新しいD1の作成、既存のD1の削除は行いません。`deploy-cloudflare.sh`は初回移行用なので、通常更新には使いません。

別端末でGitHubから取得した場合も、依存関係を導入し、Wranglerにログインすれば同じ本番設定を使えます。自動公開の設定は、以下の「GitHub Actionsによる自動更新」を参照してください。

`drizzle/`のSQLが適用済みの状態と変わった場合は、安全のため公開を停止します。データベースの形式変更は、既存データを保持する移行手順を確認してから進めてください。公開を通すために照合情報だけを書き換えないでください。

## 共有キー列の本番反映

共有URL再発行のコードを公開する前に、承認された本番変更として次の順に実施します。今回の変更では本番D1への適用・公開は行いません。SQL適用中は新旧コードの併存があり得ます。旧コードで新規作成されたカレンダーは`view_key_hash`がNULLの従来モードとなり、参加メンバーが新コードの設定から初回再発行するとキー保護へ切り替わります。

1. 対象の本番D1とバックアップを確認し、追加SQLだけを適用します。

   ```sh
   npx wrangler d1 execute <production-database-name> --remote --file=drizzle/0001_blue_wild_child.sql
   ```

2. `PRAGMA table_info(calendars);`で`view_key_hash`がNULL許容で追加されたこと、既存行の`view_key_hash`がNULLであること、カレンダー・参加者・予定の件数が適用前と一致することを確認します。失敗や件数差があれば公開へ進みません。
3. 適用したSQLのSHA-256を確認し、`cloudflare.production.json`の`migrations`へ`drizzle/0001_blue_wild_child.sql`の指紋を追加します。SQLとDBの状態を照合してから設定を更新します。指紋だけを先に更新してはいけません。
4. 指紋照合を含む通常のビルド・公開を行います。

コードをマージしただけでは本番に反映されません。SQLは既存データを再取り込みせず、差し戻し時も列を削除しません。移行期間中に旧コードへ戻って作られたカレンダーはNULLのままなので、復旧後に初回再発行で保護を有効化できます。

## GitHub Actionsによる自動更新

`.github/workflows/cloudflare.yml`で、PRとmasterへのpush時に単体テスト、一時D1を使ったAPIテスト、ビルド、本番設定の照合を実行します。成功したmasterだけをCloudflareへ公開します。Actionsタブからの手動実行にも対応しています。

初回のみ次の設定が必要です。

1. URL短縮を完了し、`cloudflare.production.json`の`workerName`が`uchiwa-calendar`になった状態をmasterへpushします。途中で停止している場合は、`node scripts/cloudflare-rename.mjs --commit`を再実行して完了します。
2. [CloudflareのAPI Tokens](https://dash.cloudflare.com/profile/api-tokens)で、公式手順の「Edit Cloudflare Workers」を使い、対象アカウントに限定したAPIトークンを作成します。
3. [GitHubのActions secrets](https://github.com/Twil3akine/uchiwa-calendar/settings/secrets/actions)に、名前`CLOUDFLARE_API_TOKEN`でトークンを登録します。トークンをソースやチャットに貼る必要はありません。
4. [Actions](https://github.com/Twil3akine/uchiwa-calendar/actions)で「CI and Cloudflare deploy」を選び、masterに対して「Run workflow」を実行します。以後はmasterへのpushで自動更新します。

初期設定が済んでいない場合は、検証だけを実行し、公開を待機した理由をActionsのSummaryに表示します。PRでは本番公開を実行しません。APIトークンは検証・ビルド工程へ渡しません。

本番公開では既存のWorkerとD1を指定する生成済み設定だけを使います。データの再取り込みやSQLの自動適用は行わず、SQLの照合に失敗した場合は停止します。同じブランチの実行を直列化し、公開途中の処理を新しいpushでキャンセルしません。

参考: [Cloudflare公式のGitHub Actions設定](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)

## 公開URLを短くする

初回移行で付けたランダムなWorker名を、`uchiwa-calendar`へ変更する場合は、GitHubの最新コードを取得してから実行します。

```sh
git pull --ff-only origin master
node scripts/cloudflare-rename.mjs --commit
```

変更後の公開先は`https://uchiwa-calendar.twil3akine.workers.dev`です。このコマンドを実行して確認が完了するまでは、元の公開先を利用します。

同じ名前の既存Workerがある場合や、確認できないエラーが出た場合は停止します。新しいWorkerには既存のD1を接続し、新しいURLの応答を確認してから、元のWorkerを新URLへの転送用に更新します。D1の再作成、予定の再取り込み、元のWorkerの削除は行いません。

旧URLをブラウザーで開くと、そのカレンダーについて端末内に保存されている本人情報を個人リンクの形式で新URLへ引き継ぎます。本人情報はURLの`#`以降だけで渡し、転送サーバーへは送りません。端末内の情報が削除されている場合は、保存していた個人リンクから新URLを開いてください。

`--commit`を付けた場合は、成功後の`cloudflare.production.json`だけをコミットして`origin/master`へpushします。実行前に追跡対象のファイルとステージが変更されていないことを確認します。Gitへの反映が失敗しても、公開やデータベースを作り直さないでください。表示された手順で設定ファイルのコミット・pushだけを完了できます。

完了後の通常更新は、引き続き`node scripts/cloudflare-update.mjs`で行います。

## 切り替え前の確認

同梱の`migration/source.sql`は準備時点のデータの複製です。元のSites版を使い続けている場合、書き出し後の登録・編集は自動では同期されません。**最終切り替え時は登録・編集を一時停止し、最新データを再取得してから移行する必要があります。** 検証段階の新URLを本番としてメンバーへ配らないでください。

旧URLと新URLは異なります。予定・参加者のIDと色、本人確認用ハッシュは維持しますが、ブラウザーのCookieや端末内の保存情報は新しいドメインに自動では移りません。個人リンクは、秘密部分を保ったまま新しい公開先のURLへ切り替える必要があります。個人リンクは本人だけで扱ってください。

新しい公開先で予定の件数・日付・色と、本人だけが編集できることを確認してから、共有URLを切り替えます。現在のSites版は、移行確認が終わるまで削除しません。

## 出典

- [現在のカレンダー](https://uchiwa-calendar.stonymink4097.chatgpt.site/)
- [D1のインポート・エクスポート](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/)

