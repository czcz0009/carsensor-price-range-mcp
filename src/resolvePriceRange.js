// resolvePriceRange ツールのオーケストレーション層。
// キャッシュ層1(車種名→コード)・キャッシュ層2(コード→souba価格×年式セル)・
// アクセスログの3つをここでまとめて配線する。mcpServer.jsからはこの1関数だけを呼ぶ。

import path from 'path';
import { fileURLToPath } from 'url';
import { FileCache } from './cache.js';
import { AccessLogger } from './logger.js';
import { resolveMakerModelCode, fetchPriceYearCells, DEFAULT_DELAY_MS } from './priceRangeClient.js';
import { computePriceRange } from './priceRange.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const TIER2_TTL_MS = 12 * 60 * 60 * 1000; // 12時間(要件の6〜24時間レンジの中央値)

const tier1Cache = new FileCache(path.join(DATA_DIR, 'cache', 'model-code-cache.json')); // 車種名→コード(長期)
const tier2Cache = new FileCache(path.join(DATA_DIR, 'cache', 'souba-cells-cache.json')); // コード→cells(TTL付き)
const accessLogger = new AccessLogger(path.join(DATA_DIR, 'logs', 'access.jsonl'));

function normalizeCarModel(carModel) {
    return carModel.trim();
}

/**
 * @param {{ carModel: string, year: number }} input
 * @returns {Promise<object>} ツールの結果(成功時は priceRangeYen/sampleSize/confidence を含む。
 *   失敗/データなしの場合は ok:false + reason を含む)
 */
export async function resolvePriceRange({ carModel, year }) {
    const t0 = Date.now();
    const normalizedModel = normalizeCarModel(carModel);
    const logBase = { carModel: normalizedModel, year };
    let httpRequestCount = 0;

    try {
        // --- キャッシュ層1: 車種名 → maker/modelコード -------------------------------
        let codes = tier1Cache.get(normalizedModel);
        let tier1Status = 'hit';
        if (!codes) {
            tier1Status = 'miss';
            const resolved = await resolveMakerModelCode(normalizedModel, { delayMs: DEFAULT_DELAY_MS });
            httpRequestCount += resolved.httpRequestCount;

            if (!resolved.makerCode || !resolved.modelCode) {
                accessLogger.log({
                    ...logBase,
                    tier1: tier1Status,
                    tier2: 'n/a',
                    httpRequestCount,
                    responseTimeMs: Date.now() - t0,
                    outcome: 'no_code_resolved',
                });
                return {
                    ok: false,
                    reason: 'no_code_resolved',
                    message: `「${normalizedModel}」から車種を特定できませんでした(検索結果が0件、または詳細ページからメーカー/モデルコードを読み取れませんでした)。`,
                };
            }

            codes = { makerCode: resolved.makerCode, modelCode: resolved.modelCode, resolvedAt: new Date().toISOString() };
            tier1Cache.set(normalizedModel, codes);
        }

        // --- キャッシュ層2: makerCode_modelCode → souba価格×年式セル(TTL付き) --------
        const tier2Key = `${codes.makerCode}_S${codes.modelCode}`;
        const cachedCells = tier2Cache.get(tier2Key);
        const isTier2Fresh = cachedCells && (Date.now() - new Date(cachedCells.fetchedAt).getTime()) < TIER2_TTL_MS;

        let cells;
        let tier2Status;
        if (isTier2Fresh) {
            cells = cachedCells.cells;
            tier2Status = 'hit';
        } else {
            tier2Status = cachedCells ? 'expired' : 'miss';
            const fetched = await fetchPriceYearCells(codes.makerCode, codes.modelCode, { delayMs: DEFAULT_DELAY_MS });
            httpRequestCount += fetched.httpRequestCount;
            cells = fetched.cells;
            tier2Cache.set(tier2Key, { cells, soubaUrl: fetched.soubaUrl, fetchedAt: new Date().toISOString() });
        }

        // --- 価格レンジ算出(純粋関数、HTTPアクセスなし) -------------------------------
        const result = computePriceRange(cells, year);
        const responseTimeMs = Date.now() - t0;

        if (!result) {
            accessLogger.log({
                ...logBase,
                tier1: tier1Status,
                tier2: tier2Status,
                httpRequestCount,
                responseTimeMs,
                outcome: 'no_matching_data',
            });
            return {
                ok: false,
                reason: 'no_matching_data',
                message: `「${normalizedModel}」(${year}年式)に該当する相場データが見つかりませんでした(carsensorの相場ページにその年式のデータがありません)。`,
            };
        }

        accessLogger.log({
            ...logBase,
            tier1: tier1Status,
            tier2: tier2Status,
            httpRequestCount,
            responseTimeMs,
            outcome: 'ok',
        });

        return {
            ok: true,
            carModel: normalizedModel,
            year,
            makerCode: codes.makerCode,
            modelCode: codes.modelCode,
            priceRangeYen: result.priceRangeYen,
            sampleSize: result.sampleSize,
            confidence: result.confidence,
            ...(result.note ? { note: result.note } : {}),
            cacheStatus: { tier1: tier1Status, tier2: tier2Status },
            disclaimer: 'carsensor.net上の公開情報(相場ページの価格×年式集計)を基にした参考値です。'
                + '個体差・装備差・実際の商談結果は反映されません。',
        };
    } catch (err) {
        accessLogger.log({
            ...logBase,
            tier1: 'error',
            tier2: 'n/a',
            httpRequestCount,
            responseTimeMs: Date.now() - t0,
            outcome: 'error',
            errorMessage: err.message,
        });
        return { ok: false, reason: 'error', message: `エラーが発生しました: ${err.message}` };
    }
}
