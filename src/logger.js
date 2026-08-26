// アクセスログ(JSON Lines形式で追記)。
//
// 「後で監視・異常検知に使えるように」という要件のため、車種・キャッシュヒット/ミス・
// レスポンスタイム・結果種別を1呼び出し1行で記録する。将来的にこのログを集計すれば、
// 例えば「キャッシュミス率が急上昇した(=同じ車種の問い合わせが急に多様化した、または
// キャッシュが効いていない)」「特定車種のエラー率が高い(=carsensor側のマークアップ変化の
// 疑い)」といった異常検知に使える想定。

import fs from 'fs';
import path from 'path';

export class AccessLogger {
    /** @param {string} filePath ログファイルパス(.jsonl) */
    constructor(filePath) {
        this.filePath = filePath;
    }

    /**
     * @param {object} entry
     * @param {string} entry.carModel
     * @param {number|null} entry.year
     * @param {'hit'|'miss'} entry.tier1 車種名→コード解決キャッシュ
     * @param {'hit'|'miss'|'n/a'} entry.tier2 souba相場データキャッシュ(tier1がミスして
     *   コード解決自体に失敗した場合は 'n/a')
     * @param {number} entry.httpRequestCount このツール呼び出しで実際に発生したcarsensorへの
     *   HTTPリクエスト数(0ならキャッシュのみで完結)
     * @param {number} entry.responseTimeMs
     * @param {'ok'|'no_code_resolved'|'no_matching_data'|'error'} entry.outcome
     * @param {string} [entry.errorMessage]
     */
    log(entry) {
        const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.appendFileSync(this.filePath, line + '\n', 'utf8');
    }
}
