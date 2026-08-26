# carcensor-price-range-mcp

carcensor Actor(`carsensor-resale-value-scout`)から「車種・年式から適正価格レンジを返す」機能だけを
切り出した、単一ツールのMCPサーバー(Week 2 MVP)。Week 1の分析フェーズ・小規模負荷テストを経て実装。

## ツール: `resolvePriceRange`

- **入力**: `carModel`(車種名、フリーワード検索と同じ書式)、`year`(西暦4桁の年式)
  - 走行距離は未対応(v2で追加予定)
- **出力**(成功時): `priceRangeYen: { min, max, median }`、`sampleSize`、`confidence`(`normal`/`low`)、
  `cacheStatus`(層1/層2それぞれのhit/miss)
- **出力**(失敗時): `ok: false` + `reason`(`no_code_resolved` / `no_matching_data` / `error`) + `message`

## データソースと計算式

carsensor.net自身が公開する相場(souba)ページ(`/usedcar/souba/{makerCode}_S{modelCode}/`)の
「価格×年式」クロス集計セル(価格帯・年式帯・掲載台数)を使用。Actor版(`valuation.js`)と同じ
加重平均ロジックを`median`に、マッチしたセルの実際の価格帯上下限を`min`/`max`に用いる
(詳細は`src/priceRange.js`のコメント参照)。個々の掲載車両価格そのものではなく、carsensorが
グレード単位で集計した帯域データである点はActor版と同じ制約。

## キャッシュ設計(2層)

| 層 | キー | 値 | 永続化先 | 有効期限 |
|---|---|---|---|---|
| 層1 | 車種名(trim済み) | `{ makerCode, modelCode }` | `data/cache/model-code-cache.json` | 無期限(コード体系はほぼ不変) |
| 層2 | `{makerCode}_S{modelCode}` | souba「価格×年式」セル一覧 | `data/cache/souba-cells-cache.json` | 12時間 |

両方ともファイル永続化(`src/cache.js`)のため、Claude Desktopがプロセスを再起動しても層1は
効き続ける。層1・層2ともキャッシュヒット時はcarsensorへのHTTPリクエストがゼロになる。

## アクセス間隔

`src/priceRangeClient.js`の`politeGetHtml`が、Actor版と同じ**1000ms以上のフロア**を強制する
(既定は1500ms)。キャッシュがヒットしていれば、そもそもHTTPリクエスト自体が発生しない。

## アクセスログ

`data/logs/access.jsonl`に1呼び出し1行(JSON Lines)で追記。車種・年式・層1/層2のhit/miss・
実際に発生したHTTPリクエスト数・応答時間・結果種別を記録。将来の監視・異常検知
(例: キャッシュミス率の急上昇、特定車種のエラー率上昇=carsensor側マークアップ変化の疑い)を
想定した設計。

## セットアップ

```
npm install
npm run mcp:test-client   # stdio経由でサーバーを起動し、tools/list + resolvePriceRangeを実行
```

## Claude Desktopへの登録

`claude_desktop_config.example.json`の内容を、実際のClaude Desktop設定ファイル
(`%APPDATA%\Claude\claude_desktop_config.json`)の`mcpServers`にマージし、Claude Desktopを
再起動する。

## 既知の制約(Week 1分析からの持ち越し)

- 車種名→コードの解決は、carsensorのfreeword検索結果から1件の詳細ページを取得してbreadcrumbを
  読む間接ルートのみ(直接引ける車種カタログAPIは未調査)。**未知の車種の初回問い合わせは
  検索1回+詳細1回+souba1回、最低3リクエストが必要**。
- `src/priceRangeClient.js`は`carcensor/src/carsensorClient.js`のロジックを意図的に複製している
  (2つの独立デプロイ物をパス結合しないため)。carsensor側のマークアップ変化で修正が必要になった
  場合は両方の追従が必要。
- 課金設計・複数ディレクトリへの掲載は未実装(Week 3・Week 5)。
