# 検証記録

## API

`node tests/run-isolated.mjs`で、実際のAPIルートとD1エミュレーターを接続した13項目の検証が成功しました。検証用D1には本番のマイグレーションを適用し、終了時に破棄します。

- カレンダー間の独立、匿名での閲覧と書き込み拒否
- 同名の別参加者、カレンダー内での色の区別、参加の再送
- 個人用の秘密情報による本人・色・編集権限の復元
- 同じカレンダーの他人の予定の編集・削除拒否
- 複数日の予定、二重登録防止、重複IDの衝突
- 不正日付、逆転した期間、不要な区分、不正Originの拒否
- 他カレンダーの秘密情報・予定IDによるアクセス拒否
- 版番号による古い編集・削除の拒否
- 同時更新の一方だけが成功すること
- 同時に同じ予定を登録しても1件だけ保存されること
- HTMLに見える予定名を文字列として扱うこと
- 検証用予定の削除

MCPの隔離API検証は、初期化・通知・tools/list・tools/call、バージョンヘッダー、GET拒否、JSON-RPCエラー、Bearer/Origin認証、期間フィルターと版番号、登録の冪等性、版競合を対象に追加しています。

## MCPビルド後の接続確認

VinextがMCPルートをWorkerへ含めたことは、隔離検証だけでは判定できません。`pnpm run build`後にローカルWorkerを起動し、実在する検証用カレンダーと参加者の秘密情報で初期化リクエストを送ります。HTTP 200とJSON-RPCの`initialize`応答が返ることを確認します。Workerは`pnpm start`で起動できます。

```sh
curl -i http://127.0.0.1:8787/api/calendars/<calendarId>/mcp \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <participant-secret>' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"verification","version":"1"}}}'
```

実際の秘密情報をシェル履歴や共有ログに残さないでください。期待する応答には`protocolVersion`、`serverInfo`、`capabilities.tools`が含まれます。

型検査は`node node_modules/typescript/bin/tsc --noEmit`、本番ビルドはSitesのビルド手順で実行します。

## ブラウザー

管理されたChromeプレビューで、カレンダー作成、名前による参加、予定登録、予定名の編集、終了日の変更を操作しました。複数日にわたる表示も確認しました。

この記録時点では、新しいCSPを適用したビルド済みWorkerのブラウザー確認は未実施です。検証担当者はHTTPSの本番相当プレビュー（またはHTTPSで配信するビルド済みWorker）を使い、ブラウザー名・完全なバージョン・OS・検証日を下の記録欄へ追記してください。HTTPの通常の開発サーバーでは代用しません。

### CSP確認手順

1. 開発者ツールのConsoleとNetworkを開き、トップページを読み込みます。最終応答の `Content-Security-Policy` が `frame-ancestors 'none'`、`object-src 'none'`、`base-uri 'self'`、`connect-src 'self'`、`form-action 'self'`、`worker-src 'self'`、`manifest-src 'self'`、`media-src 'self'`、`img-src 'self'`、`font-src 'self'`、`style-src 'self' 'unsafe-inline'` を含み、`default-src` を含まないことを確認します。JS/CSS・OG画像など同一originのリソースが正常に取得されることも確認します。
2. ConsoleにCSP違反がない状態でハイドレーション完了を確認し、カレンダー作成、参加、予定登録・編集・削除、月移動、複数日と重複予定の表示、共有URLの直接アクセスと再読み込み、個人リンクでの権限復元を行います。各操作後にConsoleとNetworkのCSP違反・失敗リクエストを確認します。
3. Consoleから同一origin外への `fetch` を試し、`connect-src 'self'` によって拒否されることを確認します。フォーム送信、Worker/Manifest/Media/Image/Fontの許可元もNetwork上で確認します。意図しない外部リソースをアプリに追加していないことを確認します。
4. `script-src` は現在未設定なので、この版では未許可scriptの拒否を確認できません。script-src ハッシュ方式を導入したビルドでは、許可済みのインラインscriptが動作することと、未許可のインラインscriptおよび同一origin外scriptが拒否されることを追加確認してください。現状、script-src制御をブラウザーで検証済みと記録しないでください。

| ブラウザー | バージョン | OS | 検証日 | 結果 |
| --- | --- | --- | --- | --- |
| 未実施 | — | — | — | ビルド済みWorkerのCSP確認待ち |
| 2026-10-27 | （自動確認を試行） | — | — | ビルド済みWorkerをローカルで起動し、応答ヘッダーと指令構成、security-build-smoke（D1・Cookie・再発行を含む）は確認済み。ブラウザー実機からの確認は、確認用ブラウザーからローカルサーバーへ到達できず未実施のまま。本番相当プレビューでの実施が残る |

HTTPの開発プレビューでは`crypto.randomUUID`が使えないため、`crypto.getRandomValues`によるUUIDv4生成を補っています。日付入力は`input`イベントでも状態を更新し、日付を変更して保存した際に反映されることを確認しました。

## 範囲

実機のiPhone・Androidでは検証していません。端末間の権限復元は、独立したCookie情報を使うAPI検証で確認しています。常時リアルタイム同期は行わず、画面への復帰・手動更新・保存後に最新情報を取得します。

## Cloudflare移行の準備

実際のSites版のテーブルを読み取り、欠落・省略のない行データから移行SQLを生成しました。移行データの変換について6項目のテストが成功し、D1エミュレーターでID・色・本人確認用ハッシュ・日付・版番号・連番が保持されることを確認しています。

Cloudflare用設定の生成とオフラインの事前確認も検証しています。ユーザーのCloudflareアカウントへの認証・D1作成・データ取り込み・本番配置は、この環境からは実行していません。旧サイトは引き続き稼働し、移行用データは準備時点の複製です。
