# PDF用日本語フォント

`NotoSansJP-Regular.ttf` は、package-lock.jsonで固定した `@fontsource/noto-sans-jp` の `files/noto-sans-jp-japanese-400-normal.woff` をSFNT形式へ展開したものです。文字のデザインや内容は変更していません。SIL Open Font Licenseを `OFL-NotoSansJP.txt` に同梱しています。

PDFではWOFFやサブセット化したこのフォントの描画が欠落するため、展開済みTrueTypeを全体埋め込みしています。通常の画面表示はパッケージのWebフォントを使用します。PDF用フォントはPDF出力時にのみ取得します。

生成コマンド（開発時のみfontToolsが必要。通常のインストール・起動にPythonは不要）：

```python
from fontTools.ttLib import TTFont
font = TTFont('node_modules/@fontsource/noto-sans-jp/files/noto-sans-jp-japanese-400-normal.woff')
font.flavor = None
font.save('public/fonts/NotoSansJP-Regular.ttf')
```

PDFの確認はテキスト抽出とページの画像化の両方で行います。`%PDF` ヘッダーと抽出可能な文字だけでは、実際に文字が描画されることを確認できません。
