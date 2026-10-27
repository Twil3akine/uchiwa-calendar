# 公開時の防御と運用

このアプリは共有URLの所持を閲覧・参加の条件としています。公開するのはトップURLだけにし、グループの共有URLと個人リンクは公開しないでください。共有URLの再発行・参加承認は未実装です。

## 通信と登録の上限

CloudflareのRate Limitingバインディングを必須とし、未設定の場合は503で停止します。生成する本番設定とローカル設定の両方に含めています。

| 操作 | 同じ接続元IP・Cloudflare拠点あたりの目安 |
| --- | --- |
| カレンダー作成 | 5回/分 |
| 参加・ログイン・再発行・予定の登録/変更/削除の合計 | 60回/分 |
| カレンダー読み出し | 120回/分 |

超過時は429とRetry-Afterを返します。同じ学校・家庭・携帯回線などでIPを共有している場合は合算されます。Cloudflare側のカウンターは拠点ごとの近似値であり、世界全体での厳密な回数制限ではありません。複数IPからの攻撃やリクエストそのものの課金・無料枠消費を完全には防げません。公開後はCloudflareの使用量・エラーと費用を確認してください。

DBへの登録には次の厳密な件数上限があります。同じINSERT文で件数を照合し、並行リクエストによる上限超過を防ぎます。

| 対象 | 上限 |
| --- | --- |
| アプリ全体のカレンダー | 5,000件 |
| カレンダー内の参加者 | 50人 |
| カレンダー内の予定 | 1,000件 |
| 1人が1カレンダーへ登録する予定 | 200件 |

既存データは削除しません。すでに上限を超えている場合は、追加を停止します。編集・削除・既存リクエストの再送は継続できます。帯は3段までを表示し、省略した予定は「ほかN件」から当日の一覧で確認できます。JSONはヘッダーだけに頼らず、読み取り途中で容量超過を検出して中断します。

## 個人リンクの再発行

参加者本人が「設定」→「個人リンクを再発行」で確認すると、以前の個人リンクとすべての旧Cookieが無効になります。新しいキーはこの端末へ保存し、他の端末では新しい個人リンクから開き直します。参加者ID・名前・色・予定は引き継ぎます。

応答が途切れても新しいキーを失わないよう、送信前に候補キーを端末内へ一時保存し、再読み込み時に復元を試みます。復元キーは引き続きlocalStorageに保持します。同一originのXSSや端末侵害によるキー漏えいは防げないため、再発行機能だけでこのリスクが解消したとは考えないでください。

### Content Security Policy

Worker は `frame-ancestors 'none'`、`object-src 'none'`、`base-uri 'self'`、`connect-src 'self'`、`form-action 'self'`、`worker-src 'self'`、`manifest-src 'self'`、`media-src 'self'`、`img-src 'self'`、`font-src 'self'` と `style-src 'self' 'unsafe-inline'` を設定します。`default-src` は設定しません。ビルド成果物には data URI の画像・フォントがなく、画面は同一originのOG画像とシステムフォントを使うため、`img-src` と `font-src` に `data:` は含めていません。

`style-src` の `'unsafe-inline'` は、参加者色などを React が動的な style 属性として設定するため残しています。style 要素向け指令への分離は行っていません。

厳密な `script-src` はまだ設定していないため、script実行元はこのCSPで制限されません。2026-10-27にビルド済みWorkerを Miniflare `dispatchFetch` で測定した結果は次のとおりです。トップページ（繰り返し取得と異なる `?c=` を含む）のインラインscriptは4件で、同一ビルド内ではハッシュ集合が安定していました。一方、404ページは7件で集合が異なります。また、vinext が埋め込む互換性IDがビルドごとに変わるため、ハッシュ集合はビルド間でも変わります。固定のハッシュ一覧で全応答を覆うには、deploymentId の固定と、ビルドごとの一覧生成・検証（security-build-smoke での再計算照合）の仕組みが別途必要と判断し、今回は見送りました。security-build-smoke は現在の指令構成と、応答ごとのハッシュ集合の測定結果の出力を検証します。`script-src` と短期セッション分離は未実装です。

## 依存関係と公開

修正済みバージョンへ更新し、推移依存もlockfileと限定的なoverrideで固定しています。minimumReleaseAgeの例外は今回確認した正確なバージョンだけです。将来の安全性を保証する設定ではありません。

- GitHub Actionsは毎回pnpm auditを実行し、Low以上の既知警告があれば停止します。
- Cloudflare Buildsのビルドコマンドをpnpm run buildにすると、公開前に単体テスト、一時D1でのAPIテスト、依存監査、ビルド後のWorker検証を行います。監査サービスに接続できない場合も公開を停止します。
- デプロイコマンドは従来どおり、node scripts/cloudflare-update.mjs --prepare-only && pnpm exec wrangler deploy --config dist/server/cloudflare.jsonです。
- 本番D1の作成・再取り込み・SQLの適用はこの変更にはありません。既存のcloudflare.production.jsonをそのまま使います。
- Cloudflare側のWAF、トークン権限、GitHubブランチ保護、D1復旧設定は別途管理が必要です。本番へ反映されていることを確認してから告知してください。

参考: [Cloudflare Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)、[OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
