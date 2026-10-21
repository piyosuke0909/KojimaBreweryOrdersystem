# Node.jsセキュリティ更新

確認日：2026-10-22（日本時間）

## 対象と更新先

開発環境で使っていたNode.jsは24.19.0、CPUアーキテクチャはlinux-x64でした。公式の2026年10月セキュリティリリースを確認し、同じ24系LTSの **24.22.1（Krypton）** を更新先としています。

プロジェクトの指定は次のとおりです。

| ファイル | 指定 |
| --- | --- |
| `.nvmrc` / `.node-version` | `24.22.1` |
| `package.json` / lockfileルートの`engines.node` | `>=24.22.1 <25` |

依存パッケージのバージョン・lockfileの解決先は、このNode.js更新に合わせて一括変更していません。

本番はCloudflare Workersの実行基盤で動作し、Node.jsサーバーではありません。この更新で置き換えるのは、開発・ビルド・テスト・Wrangler等のデプロイ用ツールを動かすNode.jsです。Cloudflare側の実行基盤とNode.jsのバージョン更新は別に扱います。

## 公式根拠

- [2026年10月のセキュリティ告知](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
- [Node.js 24.22.1 LTSのリリース情報](https://nodejs.org/en/blog/release/v24.22.1)
- [配布バージョン一覧](https://nodejs.org/dist/index.json)
- [バイナリの公式検証手順](https://github.com/nodejs/node#verifying-binaries)

24.22.1は公式にセキュリティリリースと明記され、24.xが対象となるDNS・TLS検証・Brotliの範囲外書込み等を修正しています。例としてCVE-2026-105482、CVE-2026-105483、CVE-2026-106069、CVE-2026-111497が挙げられます。アプリで各脆弱性が悪用されたことを確認したという意味ではありません。

配布indexの日付は2026-10-20、リリース告知は2026-10-21ですが、どちらも24.22.1を指しています。公式配布情報の同梱npmは11.19.1、OpenSSLは3.5.9です。

## 更新方法

nvmを使用する環境では、リポジトリ直下で次を実行します。

```bash
nvm install
nvm use
node --version
npm --version
npm ci --cache /workspace/.npm-cache
```

nvm以外の管理ツールを使用する場合も、`.node-version`と同じ24.22.1を選択してください。システム管理下のNode.jsを直接上書きする必要はありません。

公式バイナリを使う場合は、HTTPSで公式配布物と`SHASUMS256.txt.asc`を取得し、Node.jsの公式release-keysの鍵束で署名を検証したうえで、アーカイブのSHA256を照合してください。署名・TLS・チェックサム検証を無効にして導入しないでください。

24.22.1のlinux-x64.tar.xzの公式SHA256は次の値です。

```text
6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6
```

## このクラウド環境の確認記録

公式配布物を専用の `.local/tools/node-v24.22.1-linux-x64/` に配置しました。この環境が提供する管理用Nodeは直接上書きせず、プロジェクトのシェルと開発サーバーには以下の手順で新版を選択します。

```bash
cd /workspace/KojimaBreweryOrdersystem
node --use-env-proxy scripts/setup-node.mjs
source scripts/use-node.sh
node --version
npm --version
```

`setup-node.mjs` はLinux x64のクラウド向けです。Node.js公式 `release-keys` の固定コミット `481637f813e912c4aa3622d7964ab426c97b8e8d` の鍵束で、署名付きチェックサムをGPG検証します。署名中のSHA256・レビュー済みのSHA256・取得アーカイブのSHA256がすべて一致してから展開します。

再実行時にも、署名検証済みアーカイブを一時ディレクトリへ展開し、既存のNode・npmを含む全ファイルの内容・パーミッション・シンボリックリンクを照合してから再利用します。改変したアーカイブの展開拒否と、既存インストールに追加した検証用ファイルの検出を確認し、検証用の変更は復旧しました。

| 確認項目 | 結果 |
| --- | --- |
| 実行Node / npm / OpenSSL | 24.22.1 / 11.19.1 / 3.5.9 |
| 公式署名とアーカイブSHA256 | 成功。公式リリース鍵 `5BE8A3F6C8A5C01D106C0AD820B1A390B168D356` の署名を確認 |
| 再実行 | インストール全体の一致を確認して成功 |
| `npm ci` / `npm run setup` | 成功。依存解決先と既存のローカル秘密設定を保持 |
| 型チェック / Viteビルド | 成功 |
| 単体 / 統合 / ブラウザー | 154 / 26 / 39件、合計219件成功 |
| 開発サーバー | 新版Nodeで再起動。8787/5173のAPI・DB疎通を確認 |
| HTTPS | 新版NodeのTLS検証を保ったまま公式配布情報と本番ヘルスチェックに成功 |

起動手順とインストール手順は環境設定のドラフトにも保存します。ドラフト保存と環境のPublish、新しいタスクでの復元確認は別です。今回、新しいタスクへの復元試験は行っていません。

本番のWorkersコード・D1データ・LINE設定に変更はありません。更新後のビルドは既存の本番用アセットと同じハッシュを生成したため、アプリの再配置は不要です。
