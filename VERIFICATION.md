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

HTTPの開発プレビューでは`crypto.randomUUID`が使えないため、`crypto.getRandomValues`によるUUIDv4生成を補っています。日付入力は`input`イベントでも状態を更新し、日付を変更して保存した際に反映されることを確認しました。

## 範囲

実機のiPhone・Androidでは検証していません。端末間の権限復元は、独立したCookie情報を使うAPI検証で確認しています。常時リアルタイム同期は行わず、画面への復帰・手動更新・保存後に最新情報を取得します。

## Cloudflare移行の準備

実際のSites版のテーブルを読み取り、欠落・省略のない行データから移行SQLを生成しました。移行データの変換について6項目のテストが成功し、D1エミュレーターでID・色・本人確認用ハッシュ・日付・版番号・連番が保持されることを確認しています。

Cloudflare用設定の生成とオフラインの事前確認も検証しています。ユーザーのCloudflareアカウントへの認証・D1作成・データ取り込み・本番配置は、この環境からは実行していません。旧サイトは引き続き稼働し、移行用データは準備時点の複製です。
