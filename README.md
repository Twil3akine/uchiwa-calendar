# うちわカレンダー

URLで集まる内輪向けの終日予定共有アプリです。予定名と日付だけを登録し、参加者ごとの色で表示します。

## 使い方

1. トップ画面でカレンダーを作成します。
2. 「共有URL」をメンバーに送ります。閲覧にアカウントは不要です。
3. 初めて予定を登録する人は表示名を入力します。色は自動で決まります。
4. 自分の予定だけ編集・削除できます。
5. 別端末で同じ人として使う場合は、自分の設定から「個人用URL」をコピーして開きます。

共有URLは閲覧・新規参加用、個人用URLは本人の操作権限を引き継ぐためのものです。個人用URLは本人だけで保管してください。名前が同じでも、個人用URLを使わず新規参加した場合は別の参加者になります。

空き・不可の区分や時刻指定はありません。複数日の開始日・終了日は両端を含みます。

## 構成

React / TypeScript / Vinext、Cloudflare Workers、Cloudflare D1 / Drizzleを使います。Sitesがソース管理・ホスティング・D1の接続を担当します。

`app/`が画面とAPI、`lib/calendar-types.ts`が共有の型、`lib/server/`がサーバー処理、`db/schema.ts`がデータ定義、`drizzle/`がマイグレーションです。

## ローカル開発

Node.js 22.13以上とpnpmを利用します。

```sh
pnpm install --frozen-lockfile
pnpm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_lean_omega_red.sql
pnpm run dev
```

マイグレーションSQLは未適用のものを番号順に一度だけ実行します。開発とビルド後のローカル起動は同じ`.wrangler/state`を利用します。本番とは別のデータです。

```sh
node node_modules/typescript/bin/tsc --noEmit
node tests/calendar-api.mjs http://localhost:5173
# HTTP接続を使わず、隔離したD1エミュレーターで検証する場合
node tests/run-isolated.mjs
```

API検証ではテスト用カレンダーと参加者を作成します。明示した検証環境だけで実行してください。

## 配置・環境設定

Sites上では`.openai/hosting.json`の`d1: "DB"`がD1を宣言します。保存・公開手順でD1を接続し、`drizzle/`のマイグレーションを適用します。アプリ独自の外部APIキーやメール設定は不要です。

自分のCloudflareアカウントへWranglerで配置する場合は、D1を作成し、本番用Worker設定の`DB`バインディングに実際のデータベースIDを設定します。ローカル用のプレースホルダーIDは本番に使わないでください。未適用SQLを本番D1に順番に適用してから、ビルド済みのWorkerを`wrangler deploy --config <本番用設定ファイル>`で配置します。ビルドで再生成される設定を直接編集する場合は、次回ビルドで上書きされる点に注意してください。

データを残す更新では既存のD1を継続利用します。適用済みのSQLは書き換えず、変更分を追加してください。本番データを自動削除する初期化処理は設けていません。

## 権限と保存

- カレンダーの識別子は推測困難な値です。公開一覧は設けません。
- 個人用URLの秘密情報は端末内で保持し、サーバーには照合用ハッシュを保存します。
- HttpOnly Cookieで参加情報を保持し、変更操作では所有者・カレンダー・Originを検証します。
- 個人用URLと端末内情報の両方を失った場合、名前だけで本人確認・復旧はできません。
- 複数端末からの更新は版番号で競合を検出します。

## 出典

- [gwitg](https://github.com/Twil3akine/gwitg/blob/master/SKILL.md)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/)
