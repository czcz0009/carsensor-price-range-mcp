// carsensor.netへのHTTPアクセス層。
//
// 既存Actor(carcensor/src/carsensorClient.js)のロジックのうち、価格レンジ推定に
// 必要な最小限(車種名→maker/modelコード解決、souba相場ページの「価格×年式」
// マトリクス取得)だけを移植したもの。Week 1分析で判明した通り、このコードベースには
// 「車種名(自由文字列)→コード」を直接引く手段が無いため、既存Actorと同じ間接ルート
// (freeword検索→詳細ページのbreadcrumb JSON-LDからコードを読む)を踏襲している。
//
// 意図的にActor側(../../carcensor)を直接importせず、必要ロジックをここに複製している。
// 理由: 別々にデプロイされるもの同士(Actorはapify push、これはローカルnode起動)を
// パスで結合すると、どちらかのディレクトリ移動・変更で暗黙に壊れるため。carsensor.netの
// マークアップ変化で修正が必要になった場合は、carcensor/src/carsensorClient.js側と
// 両方の追従が必要になる点に注意(READMEにも明記)。

import { gotScraping } from 'got-scraping';
import * as cheerio from 'cheerio';

const BASE = 'https://www.carsensor.net';
export const MIN_DELAY_MS = 1000; // 既存Actorと同じ、アクセス負荷対策のフロア(下回らせない)
export const DEFAULT_DELAY_MS = 1500;

let lastFetchAt = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** リクエスト間隔を強制するgetラッパー。carsensorへの全リクエスト(検索・詳細・souba)が
 * これを経由することで、プロセス内のどこから呼んでもフロアを一律に守らせる。 */
async function politeGetHtml(url, delayMs = DEFAULT_DELAY_MS) {
    const effectiveDelay = Math.max(MIN_DELAY_MS, delayMs);
    const wait = lastFetchAt + effectiveDelay - Date.now();
    if (wait > 0) await sleep(wait);
    lastFetchAt = Date.now();

    const res = await gotScraping({
        url,
        timeout: { request: 15000 },
        retry: { limit: 2 },
    });
    if (res.statusCode >= 400) {
        throw new Error(`HTTP ${res.statusCode} for ${url}`);
    }
    return res.body;
}

function extractJsonLdBlocks($) {
    const blocks = [];
    $('script[type="application/ld+json"]').each((_, el) => {
        const raw = $(el).contents().text();
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) blocks.push(...parsed);
            else blocks.push(parsed);
        } catch {
            // 想定外の形式は無視
        }
    });
    return blocks;
}

/** carcensorClient.js の parseMakerModel と同一ロジック(breadcrumbのモデル階層@idから
 * maker/modelコードを取り出す)。詳細はcarcensor/src/carsensorClient.jsのコメント参照。 */
function parseMakerModelCode(jsonLdBlocks) {
    const breadcrumbLists = jsonLdBlocks.filter((b) => b['@type'] === 'BreadcrumbList');
    let makerCode = null;
    let modelCode = null;

    for (const list of breadcrumbLists) {
        const items = list.itemListElement || [];
        for (const entry of items) {
            const id = entry.item?.['@id'];
            if (!id) continue;
            const modelMatch = id.match(/\/usedcar\/b([A-Za-z0-9]+)\/s(\d+)\/index\.html$/);
            if (modelMatch) {
                makerCode = modelMatch[1];
                modelCode = modelMatch[2];
            }
        }
    }
    if (!makerCode || !modelCode) return null;
    return { makerCode, modelCode };
}

/**
 * 車種名(自由文字列)からmaker/modelコードを解決する。
 * 手順: freeword検索の1ページ目から最初の詳細ページURLを1件取得 → その詳細ページの
 * breadcrumb JSON-LDからコードを読む(間接ルート。Week 1分析参照)。
 *
 * @param {string} carModel
 * @param {{ delayMs?: number }} [opts]
 * @returns {Promise<{ makerCode: string|null, modelCode: string|null, httpRequestCount: number }>}
 */
export async function resolveMakerModelCode(carModel, { delayMs = DEFAULT_DELAY_MS } = {}) {
    let httpRequestCount = 0;

    const searchUrl = `${BASE}/usedcar/freeword/${encodeURIComponent(carModel)}/index.html`;
    const searchHtml = await politeGetHtml(searchUrl, delayMs);
    httpRequestCount += 1;

    const $search = cheerio.load(searchHtml);

    // 実機検証で判明した重要な罠: 検索結果0件のページにも/usedcar/detail/への
    // リンクが複数存在する(「0件でしたが、こちらもおすすめです」的な関連商品枠。
    // .zeroHitRecommend配下)。単純に最初のdetailリンクを拾うと、無関係な車種を
    // 誤って「見つかった」と扱ってしまう(実データで確認済み: 架空の車種名で検索した
    // 際、.zeroHitRecommend内の全く無関係な車両が拾われた)。carsensor自身がこの
    // クラス名で0件状態を明示しているため、まずこれを見て0件を確定させる。
    const isZeroHit = $search('.zeroHitRecommend').length > 0;
    if (isZeroHit) return { makerCode: null, modelCode: null, httpRequestCount };

    let detailUrl = null;
    $search('a[href*="/usedcar/detail/"]').each((_, a) => {
        if (detailUrl) return;
        const href = $search(a).attr('href');
        if (!href) return;
        detailUrl = (href.startsWith('http') ? href : new URL(href, BASE).toString()).split('?')[0];
    });
    if (!detailUrl) return { makerCode: null, modelCode: null, httpRequestCount };

    const detailHtml = await politeGetHtml(detailUrl, delayMs);
    httpRequestCount += 1;

    const $detail = cheerio.load(detailHtml);
    const codes = parseMakerModelCode(extractJsonLdBlocks($detail));
    if (!codes) return { makerCode: null, modelCode: null, httpRequestCount };

    return { ...codes, httpRequestCount };
}

/**
 * souba相場ページから「価格×年式」マトリクスのセルを取得する。
 * carcensorClient.js の fetchPriceYearMatrix と同一ロジック(fed=パラメータでの判別、
 * 行合計/列合計セルの除外)。v1スコープでは価格×走行距離マトリクスは取得しない
 * (Week 1の負荷テストで取得自体は可能と確認済みだが、v2で入力に走行距離を追加する際に
 * 合わせて実装する)。
 *
 * @param {string} makerCode
 * @param {string} modelCode
 * @param {{ delayMs?: number }} [opts]
 * @returns {Promise<{ soubaUrl: string, cells: Array<{pMin:number|null,pMax:number|null,yMin:number|null,yMax:number|null,count:number}>, httpRequestCount: number }>}
 */
export async function fetchPriceYearCells(makerCode, modelCode, { delayMs = DEFAULT_DELAY_MS } = {}) {
    const soubaUrl = `${BASE}/usedcar/souba/${makerCode}_S${modelCode}/`;
    const html = await politeGetHtml(soubaUrl, delayMs);
    const $ = cheerio.load(html);

    const cells = [];
    $('a[href*="fed=othmarketprocemapping_pricemodelyear"]').each((_, a) => {
        const href = $(a).attr('href');
        if (!href) return;
        let parsed;
        try {
            parsed = new URL(href, BASE);
        } catch {
            return;
        }
        const q = parsed.searchParams;
        const countText = $(a).text().replace(/[^\d]/g, '');
        const count = countText ? parseInt(countText, 10) : 0;
        if (!count) return;

        const pMin = q.get('PMIN') ? parseInt(q.get('PMIN'), 10) : null;
        const pMax = q.get('PMAX') ? parseInt(q.get('PMAX'), 10) : null;
        const yMin = q.get('YMIN') ? parseInt(q.get('YMIN'), 10) : null;
        const yMax = q.get('YMAX') ? parseInt(q.get('YMAX'), 10) : null;

        // 行合計/列合計セル(片方の軸が両方null)は除外(carcensorClient.jsと同じ理由)
        if ((pMin == null && pMax == null) || (yMin == null && yMax == null)) return;

        cells.push({ pMin, pMax, yMin, yMax, count });
    });

    return { soubaUrl, cells, httpRequestCount: 1 };
}
