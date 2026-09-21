# google-product-feed

タイヤショップ オールテレーンの Shopify 店（https://shop.all-terrain-tireshop.com）の**単品（タイヤ・ホイール）**を
Google Merchant Center の無料リスティングに載せるための商品フィード `feed.xml` を毎日自動生成するリポジトリです。

## Merchant Center に登録する URL

```
https://raw.githubusercontent.com/All-terrain/google-product-feed/main/feed.xml
```

Merchant Center の「商品 > フィード > 新しいフィードを追加 > スケジュール設定された取得」にこの URL を登録します。
毎日 JST 04:30 に GitHub Actions がフィードを再生成して commit するので、Merchant Center 側の取得時刻はそれ以降（例: 06:00）にしてください。

## 仕組み

- 入力: ストアの公開 JSON（`/collections/タイヤ/products.json`・`/collections/ホイール/products.json`）。認証情報は使いません。
- 取得は直列で 2 リクエスト/秒以内。429/5xx/通信失敗は指数バックオフで最大 5 回再試行し、それでも失敗したら何も書かずに終了します（前回の `feed.xml` を壊しません）。
- 出力: `feed.xml`（RSS 2.0・Google Merchant 名前空間）と `feed-summary.json`（件数・skipped の内訳）。
- 依存パッケージなし（Node 20+ 標準モジュールのみ）。

## 手動実行

```bash
# 単体テスト
npm test            # = node --test

# フィード生成（既定: feed.xml / feed-summary.json）
npm run build       # = node scripts/build-feed.mjs

# オプション
node scripts/build-feed.mjs --out feed.xml --summary feed-summary.json --collections タイヤ,ホイール --max-pages 1
```

GitHub 上では Actions の「build-feed」を `Run workflow` で手動実行できます。

## セットを含めない理由

タイヤ・ホイールセットは約 42 万件あり、Google の掲載上限を超えて単品が押し出されてしまうため、
このフィードには単品（タイヤ・ホイール）だけを入れます。

## ID 形式が Shopify の Google 連携と同じ理由

`g:id` は Shopify 公式の Google & YouTube 連携と同じ `shopify_JP_<product.id>_<variant.id>` 形式です。
Shopify 連携からこのフィードへ（またはその逆へ）切り替えたときに、Merchant Center 上の商品履歴（審査結果・パフォーマンス）を
同じ ID で引き継げるようにするためです。書式は `scripts/build-feed.mjs` 先頭の `ID_TEMPLATE` で変えられます。

## 主なルール

| 属性 | 内容 |
|---|---|
| `g:id` | `shopify_JP_<product.id>_<variant.id>` |
| `g:title` | 商品名（空白正規化・150 文字まで） |
| `g:description` | `body_html` からタグを除いたもの（5000 文字まで・空なら商品名） |
| `g:link` | `/products/<handle>`（バリエーションが 2 つ以上のときだけ `?variant=` 付き） |
| `g:image_link` / `g:additional_image_link` | 1 枚目 / 2〜11 枚目。画像なしは skipped |
| `g:availability` | `in_stock` / `out_of_stock` |
| `g:price` | `<整数> JPY`。0 以下・数値でないものは skipped |
| `g:gtin` | sku 内の 13 桁 JAN（チェックデジット正・45/49 始まり）。sku 末尾 `x1pc` → gtin、`x4pc` → gtin + `g:multipack=4`。それ以外は gtin なし＋`g:identifier_exists=no` |
| `g:custom_label_0/1/2` | 種別（タイヤ/ホイール）／インチ（tags の `NNインチ`）／本数（1本/4本） |
| `g:shipping` | 出さない（Merchant Center のアカウント設定の送料を使う） |

## ファイル構成

- `scripts/build-feed.mjs` — 実行本体（取得・書き出し）
- `scripts/lib/feed.mjs` — 変換ロジック（純関数）
- `test/feed.test.mjs` — 単体テスト（`node --test`）
- `test/fixtures/products.sample.json` — テスト用の商品データ
- `.github/workflows/build-feed.yml` — 毎日 JST 04:30 の自動生成
