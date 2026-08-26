// 適正価格レンジの算出ロジック(純粋関数、HTTPアクセス・キャッシュ・ログに一切依存しない)。
//
// carcensor Actor の src/valuation.js (computeMarketBaseline) をベースに、単一の点推定
// (estimatedMarketPriceYen)だけでなくレンジ(min/max/median)を返すよう拡張したもの。
// データソースはActorと同じ、carsensor公式soubaページの「価格×年式」クロス集計(セル単位の
// 価格帯・年式帯・掲載台数)。個々の掲載車両の価格そのものではなく、carsensor自身が
// グレード単位で集計した帯域データである点はActor版と同じ制約(README参照)。

export const LOW_CONFIDENCE_THRESHOLD = 5; // Actor版 valuation.js と同じ閾値

/** 価格帯セルの代表値を推定する。上下端が開いている場合の±15%ヒューリスティックも
 * Actor版と同じ(統計的な裏付けのない経験則である点も同じ)。 */
export function bucketMidpoint({ pMin, pMax }) {
    if (pMin != null && pMax != null) return (pMin + pMax) / 2;
    if (pMin != null) return pMin * 1.15; // 上限オープン("〜以上")
    if (pMax != null) return pMax * 0.85; // 下限オープン("〜万円")
    return null;
}

/**
 * @param {Array<{pMin:number|null,pMax:number|null,yMin:number|null,yMax:number|null,count:number}>} cells
 * @param {number} carYear
 * @returns {{
 *   priceRangeYen: { min: number, max: number, median: number },
 *   sampleSize: number,
 *   confidence: 'normal' | 'low',
 *   note?: string,
 * } | null} 該当年式にマッチするセルが1件もない場合はnull
 */
export function computePriceRange(cells, carYear) {
    if (!cells || !cells.length || carYear == null) return null;

    const matched = cells.filter(
        (c) => (c.yMin == null || carYear >= c.yMin) && (c.yMax == null || carYear <= c.yMax),
    );
    const sampleSize = matched.reduce((sum, c) => sum + c.count, 0);
    if (!sampleSize) return null;

    // 実機検証で判明した罠: carsensorのsoubaマトリクスの年式軸は末端が開いている
    // (例: yMin=null, yMax=2012 は「2012年以前」の集計セル)。この開いた側は
    // 「carsensorがその車種の情報をいつから持っているか」を表さないため、
    // 例えば実在しない年式(1950年のプリウス等)を投げても、この開いたセルにだけ
    // マッチして"ok"を返してしまう(carYearがそのセルの範囲内という条件だけでは、
    // carYearがその車種の実在した年式かどうかは判定できない)。
    // そのため、carYearを実際に閉区間(yMin・yMaxとも具体値)で挟むセルが1件もない
    // 場合は、開いたセルへの間接マッチのみに基づく推定として confidence を'low'に
    // 落とし、その旨をnoteに明記する(carYearの妥当性そのものを検証する手段が
    // このデータには無いため、確度を下げて開示するに留める)。
    const hasClosedMatch = matched.some((c) => c.yMin != null && c.yMax != null);

    // median: 各セルの代表値(bucketMidpoint)をそのセルの掲載台数で加重平均したもの。
    // 個々の掲載車両価格の中央値そのものではなく、帯域データからの加重平均による
    // 近似値である点に注意(carsensorが個別掲載価格を公開していないため、これが
    // 現実的に算出できる最良の近似)。
    const weightedSum = matched.reduce((sum, c) => {
        const mid = bucketMidpoint(c);
        return mid == null ? sum : sum + mid * c.count;
    }, 0);
    const median = Math.round(weightedSum / sampleSize);

    // min/max: マッチしたセルのうち、実際に価格帯の下限/上限を持つセルの値をそのまま使う。
    // 最安値側セルが下限オープン("〜XX万円")の場合、真の下限は不明なため
    // bucketMidpointと同じ±15%ヒューリスティックで補正した値を使う。
    const lowerBounds = matched.map((c) => (c.pMin != null ? c.pMin : (c.pMax != null ? c.pMax * 0.85 : null)))
        .filter((v) => v != null);
    const upperBounds = matched.map((c) => (c.pMax != null ? c.pMax : (c.pMin != null ? c.pMin * 1.15 : null)))
        .filter((v) => v != null);

    if (!lowerBounds.length || !upperBounds.length) return null;

    const min = Math.round(Math.min(...lowerBounds));
    const max = Math.round(Math.max(...upperBounds));

    let confidence = sampleSize < LOW_CONFIDENCE_THRESHOLD ? 'low' : 'normal';
    let note;
    if (!hasClosedMatch) {
        confidence = 'low';
        note = `${carYear}年式を具体的な年式範囲で挟むデータがcarsensorに無く、`
            + '開いた年式区間(「◯◯年以前」等)への該当のみで算出しています。'
            + 'この年式が実在するかどうか自体はこのデータからは検証できません。';
    }

    return { priceRangeYen: { min, max, median }, sampleSize, confidence, ...(note ? { note } : {}) };
}
