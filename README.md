# carcensor-price-range-mcp

carcensor Actor(`carsensor-resale-value-scout`)から「車種・年式から適正価格レンジを返す」機能だけを
切り出した、単一ツールのMCPサーバー。Week 1の分析フェーズ・小規模負荷テストを経てWeek 2にローカル
stdio MCPサーバーとして実装し、Week 3でApify Actor(Standbyモード)化+Pay-Per-Event課金を追加した。

**2つの起動経路がある**(ツール本体・キャッシュ・ログのロジックは完全に同一、`mcpServer.js`1本):

- **ローカル/Claude Desktop**: `node mcpServer.js` で直接stdio起動(Week 2のまま、変更なし)
- **Apify Actor(Week 3〜)**: `node src/main.js` がApify Standbyモード上でHTTP(Streamable HTTP、
  `/mcp`)を受け、`mcpServer.js`を子プロセスとして起動してプロキシする。課金は`mcpServer.js`側
  (`resolvePriceRange`が成功した直後)で行うため、どちらの起動経路でも同じ場所に1箇所だけ書けばよい。

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

## Apify Actor(Standbyモード)としてのホスティング

Apify公式のMCP Actorパターン(`ts-mcp-proxy`テンプレート、`package-health-checker` Actorで実績あり)を
このプロジェクトのプレーンJS/ESMスタイルに移植したもの(TypeScriptビルドなし)。

```
MCPクライアント(Claude Desktop等)
  → HTTPS(Streamable HTTP, /mcp) → Apify Standbyモード上の src/main.js + src/server.js
    → stdio(子プロセス) → mcpServer.js(既存のresolvePriceRangeロジック本体)
```

- `.actor/actor.json`: `usesStandbyMode: true` + `webServerMcpPath: "/mcp"`。静的input schemaは空
  (このActorはstandby起動後、MCPクライアントからの呼び出し時にのみ実処理を行う)
- `src/main.js`: Actor.init() → standbyモードでなければ「このActorはMCPサーバーです」という説明を
  ログ+1件のみのデータセット出力をして正常終了(Apifyの自動ヘルスチェック等、非standby実行での
  「成功したのに空出力でERRORログ」問題を避けるため。`package-health-checker`で見つかった既知の
  問題と同じ対策)。standbyモードなら`src/server.js`を起動
- `src/server.js`・`src/mcp.js`: MCPプロトコルのHTTP⇄stdio変換のみを担当し、`resolvePriceRange`の
  ロジックには一切関与しない
- デプロイ後の接続先URL: `https://{username}--carcensor-price-range-mcp.apify.actor/mcp`
  (Apify APIトークンでの認証が必要)

## Pricing(暫定)

| Event | Price(暫定) | Trigger |
|---|---|---|
| Price range resolved (`resolve-price-range-success`) | **$0.03(暫定、数十円相当)** | `resolvePriceRange`が価格レンジを正常に返せた場合のみ課金。車種が特定できない/該当年式データがない場合は課金しない(carsensorのvalueScore・campfireのfundingRisk等、既存Actor群と同じ「算出できた時だけ課金」方針) |

**金額は最終確定ではない**(Mahiro自身が最終決定)。$0.03という数字は、既存Actor群の基本ティア
($0.015、listing-extracted/project-classified等)と、より重い派生指標ティア($0.045〜$0.065、
sales-timing-signal-detected/value-score-computed等)の中間あたりを仮置きしたもの。実測インフラ
コスト(carcensor Actorの実測は約$0.0002/件)に対しては十分なマージンがある水準。

### キャッシュヒット/ミスで課金額を分けるべきか(検討結果)

**結論: 分けない(フラット課金)を推奨。** 検討した両論:

**分ける場合(キャッシュヒットを安くする)のメリット**:
- 運営側の実コストに近い(ヒットは追加HTTPリクエストゼロ、ミスは1〜3リクエスト)
- 同じ車種を繰り返し問い合わせる利用パターンに対して単価が下がる

**分ける場合のデメリット**:
- **既存Actor群の価格哲学と矛盾する**。campfireのfunding-risk-flaggedボーナスを設計した際、
  「souba取得はキャッシュで限界コストがほぼゼロになるが、それを理由に安くはしない」と明示的に
  結論づけている(README「How the price was set」参照)。ユーザーが受け取る価値
  (`priceRangeYen`の中身)はキャッシュヒットでもミスでも完全に同一であり、価格を分ける根拠は
  「運営コスト」であって「提供価値」ではない
- **運営側のインセンティブが歪む**: ヒットを安くミスを高くすると、キャッシュTTLを短くするほど
  運営の売上が増える構造になり、Week 1〜2で明示的に掲げた「carsensorへの負荷を下げる」という
  設計目標と正面から矛盾する
- ユーザー視点では、同じ呼び出し(同じcarModel/year)が「たまたま」ヒットかミスかで課金額が
  変わるのは予測しづらく、APIの価格として分かりにくい
- 実装・検証の複雑さが増す(`cacheStatus`はtier1/tier2それぞれhit/miss/expiredの組み合わせがあり、
  課金ロジックとしてどこで線引きするかの決定・テストが増える)

上記から、`resolve-price-range-success`は**キャッシュ状態に関わらず単一価格**とした。ただし
`cacheStatus`は引き続きレスポンスに含めているため、将来ヒット/ミスで分ける方針に変えたくなった
場合の実装コストは低い(`mcpServer.js`の課金呼び出し1箇所を分岐させるだけ)。

## セットアップ

```
npm install
npm run mcp:test-client   # stdio経由でサーバーを起動し、tools/list + resolvePriceRangeを実行
```

## Claude Desktopへの登録

`claude_desktop_config.example.json`の内容を、実際のClaude Desktop設定ファイル
(`%APPDATA%\Claude\claude_desktop_config.json`)の`mcpServers`にマージし、Claude Desktopを
再起動する。

## 既知の制約

- 車種名→コードの解決は、carsensorのfreeword検索結果から1件の詳細ページを取得してbreadcrumbを
  読む間接ルートのみ(直接引ける車種カタログAPIは未調査)。**未知の車種の初回問い合わせは
  検索1回+詳細1回+souba1回、最低3リクエストが必要**。
- `src/priceRangeClient.js`は`carcensor/src/carsensorClient.js`のロジックを意図的に複製している
  (2つの独立デプロイ物をパス結合しないため)。carsensor側のマークアップ変化で修正が必要になった
  場合は両方の追従が必要。
- **`.zeroHitRecommend`バグはこのプロジェクトではWeek 2で修正済み、Week 3のActor化時にも
  再確認済み**(検索0件時に無関係な車両を誤って「見つかった」と扱わないよう
  `resolveMakerModelCode`で明示的に除外している)。**ただし本番稼働中の`carcensor`Actor
  (`carsensor-resale-value-scout`)の`searchByFreeword`には同じバグが未修正のまま残っている**
  (発生条件: freeword検索が完全に0件になった場合のみ)。このプロジェクトとは別の対応判断が必要。
- 複数MCPディレクトリへの掲載は未実装(Week 5)。
- Apify Store公開は未実施(Week 4)。現時点では非公開Actorとしてのみデプロイ。
