# LINEの登録とID取得

## 現在の本番設定（切替前）

- LINE LoginチャネルID: `2012094093`
- Messaging APIチャネルID: `2011903727`
- LIFF ID: `2012094093-ApA0tjfW`
- LIFF URL: `https://liff.line.me/2012094093-ApA0tjfW`
- LIFFエンドポイントURL: `https://kojima-brewery-v2-a6577637.crossover-616.workers.dev/`
- Messaging API Webhook URL: `https://kojima-brewery-v2-a6577637.crossover-616.workers.dev/api/line/webhook`
- 管理画面: `https://kojima-brewery-v2-a6577637.crossover-616.workers.dev/admin`

LIFFエンドポイントは末尾 `/` を含むトップURLです。`/invite`・`/order`・`/orders` を同じLIFFアプリで使用するため、特定画面のパスをエンドポイントに指定しません。

## 2026-10-21に確認したプロバイダーの不一致

上記は現在の本番設定です。LINE Developersの画面で、ログインと通知のチャネルが次の別プロバイダーに属することを確認しました。

|用途|チャネルID|プロバイダーID|プロバイダー名|
|---|---|---|---|
|現在のLINE Login|`2012094093`|`2005652023`|小島醸造 注文受付システム|
|継続して使うMessaging API|`2011903727`|`2005607301`|小島醸造|

同じLINEアカウントでもプロバイダーが異なると利用者IDが変わるため、企業登録が完了していても現在の登録IDへ通知できません。プロバイダー名やチャネル名ではなく、上表の固有IDで区別します。LoginとMessaging APIのチャネルIDが異なること自体は正常です。

通知側の[小島醸造プロバイダー](https://developers.line.biz/console/provider/2005607301)には、瓶の画像の既存LINEログインチャネルもあります。まずそのチャネルIDとLIFFの設定を確認し、利用できる場合は `LINE_CHANNEL_ID` と `LIFF_ID` を切り替えます。既存LIFFが旧GAS用なら、そのLIFFを変更せず同じLINEログインチャネル内へ今回のWorkers用LIFFを追加します。Messaging API、公式アカウント、友だち、Webhook、シークレットは維持します。`2011903727` はMessaging API用なので、LINE Login用のIDとして設定しません。

切替時はリッチメニューの4リンクと招待QRも新LIFFにそろえます。既に発行したQRのURLは設定変更では変わりません。新LIFFから有効な招待で登録し直し、既存の担当者・注文・請求は保持します。一般のLINEアカウントで利用する前に、切替先のLINEログインチャネルが公開状態かも確認します。現在は切替先のチャネルID・LIFF IDの確認待ちで、本番設定の切替はまだ行っていません。

## 登録手順

1. LINE Official Account Manager (`https://manager.line.biz/`) で公式アカウントを開き、設定 → Messaging API → 利用する、からMessaging APIを有効にします。選んだプロバイダーを確認してください。
2. LINE Developers (`https://developers.line.biz/console/`) でMessaging APIと同じプロバイダー固有IDの項目を開きます。既存のLINE Loginチャネルがあれば優先し、なければアプリタイプ「ウェブアプリ」で作成します。
3. LINE Loginの基本設定で、小島醸造のLINE公式アカウントをリンクします。プロバイダーが異なる場合は、利用者IDも異なるため同一のプロバイダーに揃える必要があります。
4. LINE LoginのLIFFタブ → 追加。名前は「小島醸造 法人受注」、サイズはFull、エンドポイントは上記トップURL、Scopeは `openid` と `profile`。友だち追加オプションはオン、選べる場合は `aggressive` にします。
5. 保存して表示されるLIFF IDを取得します。LINE Loginの「チャネル基本設定 → チャネルID」も取得します。顧客公開前にLINE Loginチャネルを公開状態にします。

## 設定値の対応

|取得するもの|場所|システムの設定名|
|---|---|---|
|LINE LoginチャネルID|LINE Login → チャネル基本設定|`LINE_CHANNEL_ID`（非秘密）|
|Messaging APIチャネルID|Messaging API → チャネル基本設定|`LINE_MESSAGING_CHANNEL_ID`（非秘密）|
|LIFF ID|LINE Login → LIFF → 登録したアプリ|`LIFF_ID`（非秘密）|
|チャネルシークレット|Messaging API → チャネル基本設定|`LINE_CHANNEL_SECRET`（WorkersのSecret、Webhookとトークン自動取得に使用）|
|チャネルアクセストークン|Messaging API → Messaging API設定 → 発行|`LINE_CHANNEL_ACCESS_TOKEN`（自動取得を構成しない場合のみ使用する任意Secret）|

`LINE_CHANNEL_ID` はLINE LoginのID、`LINE_MESSAGING_CHANNEL_ID` はMessaging APIのIDです。非秘密のIDはチャットへ共有できます。シークレットはチャットへ貼らず、対象Workerの設定 → Variables and SecretsへSecretとして登録してください。

### トークンの自動取得

登録済みの `LINE_CHANNEL_SECRET` と非秘密の `LINE_MESSAGING_CHANNEL_ID` を使い、LINE公式API `POST https://api.line.me/oauth2/v3/token` の `client_credentials` 方式で、15分有効のトークンをサーバー内部で取得します。長期トークンを手動で貼り付ける必要はありません。Webhookの署名検証とLINE Loginの本人確認は、それぞれ元のシークレットとLoginチャネルIDを使用します。

短時間トークンは期限前に更新し、同時取得をまとめてプロセス内に保持します。取得した値はクライアント、APIレスポンス、DB、ログへ出しません。Messaging APIチャネルIDを設定した場合は、この方式を使用し、同じチャネルのシークレットが必須です。自動認証に失敗した際に別の長期トークンへ切り替えることはしません。Messaging APIチャネルIDをまだ設定していない既存環境では、従来の `LINE_CHANNEL_ACCESS_TOKEN` を使えます。

公式仕様: [LINE OpenAPI](https://github.com/line/line-openapi/blob/main/channel-access-token.yml)、[LINE公式Node SDK](https://github.com/line/line-bot-sdk-nodejs/blob/master/lib/channel-access-token/api/channelAccessTokenClient.ts)。

2026-10-19時点でLINE LoginチャネルIDとLIFF IDを受領し、本番構成とCodex環境設定下書きへ保存しました。両IDは本番Workerへデプロイ済みです。同日にCloudflare Workerの設定APIで、`LINE_CHANNEL_SECRET` と `LINE_CHANNEL_ACCESS_TOKEN` の両方が `secret_text` として登録されていることを確認しました。秘密値は取得・表示していません。登録の確認と、認証情報の正しさ・実際の接続確認は別です。

Messaging API設定（`https://developers.line.biz/console/channel/2011903727/messaging-api`）のWebhook設定へ上記Webhook URLを登録して保存し、「検証」を押します。成功を確認して「Webhookの利用」をオンにしてください。検証に失敗した場合は、表示されたエラー内容で原因を確認します。Webhook検証はチャネルシークレットの署名確認であり、アクセストークンによる通知の送信確認は別途必要です。

2026-10-19にユーザーからLINE ConsoleのWebhook検証が成功したと報告を受けました。LINEからWebhookへの接続と署名確認は成功した段階です。`Use webhook`、`Webhook redelivery`、`Error statistics aggregation` はオンを案内していますが、スイッチの最終状態は未確認です。実際のLINEログイン・招待登録・注文通知の送信は引き続き確認が必要です。

リッチメニューの4導線は「注文」「注文履歴」「お問い合わせ」「商品紹介」です。LIFF ID確定後に、それぞれのLIFF URLを設定します。最後に実際のLINEアカウントで、招待QR→氏名登録→注文→通知まで確認します。

## 招待QRからの企業登録

LINEログイン後、IDトークンを取得できない場合も、LIFFアクセストークンのLoginチャネル・期限・profile権限をサーバーで検証して本人確認します。本人確認と企業登録を分け、企業は招待QRから決定します。古いアカウントの企業表示による誤遷移も防止します。

登録途中でエラーになった場合は、有効な同じ招待QRを開き直してLINE認証・担当者登録をやり直してください。同じ企業に登録済みなら重複登録せず注文画面へ進みます。期限切れ・無効化・登録人数上限の場合は、管理者に招待の更新を依頼してください。修正内容と検証範囲は [LINE認証・企業紐づけ](LINE認証・企業紐づけ.md) を参照してください。

## トーク画面のリッチメニュー

本システムの管理画面 → 設定 → 「LINEリッチメニュー」で、画像・リンク・公式アカウント・現在の配信状態を確認できます。直接開くURLは次のとおりです。

`https://kojima-brewery-v2-a6577637.crossover-616.workers.dev/admin/settings?tab=line-rich-menu`

オーナー管理者の「LINEに反映する」で、次の4分割メニューを友だち全員の標準メニューに設定します。Workersに登録済みのアクセストークンをサーバー内部で使用するため、トークンを再入力する必要はありません。接続先が小島醸造の `@060ucble` と一致することを確認してから反映します。

|位置|ボタン|リンク先|
|---|---|---|
|左上|注文|`https://liff.line.me/2012094093-ApA0tjfW/order`|
|右上|注文履歴|`https://liff.line.me/2012094093-ApA0tjfW/orders`|
|左下|お問い合わせ|`https://liff.line.me/2012094093-ApA0tjfW/contact`|
|右下|商品紹介|`https://liff.line.me/2012094093-ApA0tjfW/products`|

画像は `public/richmenu/kojima-richmenu.jpg`（2500×1686px、1MB未満）です。生成した紺と金のオリジナル図案をLINE用JPEGへ書き出しています。画像アップロード後はLINEから取得した画像とSHA-256を照合し、標準メニューのIDと4つのリンクを再確認します。既存のメニューは削除せず、同じ画像・リンクで再反映した場合は現在のメニューを再利用します。顧客別にメニューを割り当てている場合、その個別設定は変更しません。

反映後はLINEアプリで小島醸造のトークを開き直し、下部の「メニュー」を押してください。表示の切替えに時間がかかる場合があります。管理画面の配信状態と、利用者端末で実際に表示・遷移できることは別に確認します。注文・注文履歴の利用には取引先ごとの招待QRから初回登録が必要です。

保守担当者は、既存の非公開の初期管理者情報を使って次のコマンドでも状態確認・反映できます。パスワードやセッションCookie、LINEアクセストークンは出力しません。

```bash
cd /workspace/KojimaBreweryOrdersystem
node --use-env-proxy scripts/install-line-richmenu.mjs
# ユーザーから反映を依頼された場合のみ実行
node --use-env-proxy scripts/install-line-richmenu.mjs --apply
```

反映結果はGit対象外の `.local/line-richmenu-installation.json` に記録します。このコマンドは、本番の取引先・商品・価格・注文を作成・変更しません。

2026-10-20 10:17（日本時間）に、小島醸造の公式アカウント `@060ucble` へ反映済みです。標準メニューIDは `richmenu-dc05c169fd0efc28f9f5c18c0c80020f`。LINEに保存された画像の一致、4つのリンクと初期表示オンを確認しました。トークンは登録済みシークレットから自動取得するため、長期トークンの手動貼り直しは不要です。

既存のメニューが別チャネル所有で取得できない場合も、未設定とは区別して表示し、新しい標準メニューへ切り替えられます。既存のメニューや個別割当は削除しません。元のメニューIDを取得できない状態で切替後に問題が起きた場合は、表示中の新しいメニューを保持し、状態の再確認を案内します。
