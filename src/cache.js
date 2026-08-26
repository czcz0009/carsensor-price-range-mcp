// ファイル永続化された、単純なキー→値キャッシュ。
//
// MCPサーバーはClaude Desktopのセッションごとにプロセスが再起動されうるため、
// メモリ内だけのキャッシュでは「長期キャッシュ」(層1: 車種名→コード)の意味がない。
// そのためディスク上のJSONファイルに永続化し、プロセス再起動をまたいで効かせる。
// 想定アクセス量(MVP段階)なら都度全量書き出しでも問題にならない規模なので、
// 差分更新のような最適化はせず単純な実装にとどめる。

import fs from 'fs';
import path from 'path';

export class FileCache {
    /**
     * @param {string} filePath 永続化先のJSONファイルパス
     */
    constructor(filePath) {
        this.filePath = filePath;
        this.data = this._load();
    }

    _load() {
        try {
            const raw = fs.readFileSync(this.filePath, 'utf8');
            return JSON.parse(raw);
        } catch {
            return {}; // ファイルが無い/壊れている場合は空から始める
        }
    }

    _persist() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    }

    get(key) {
        return this.data[key];
    }

    set(key, value) {
        this.data[key] = value;
        this._persist();
    }
}
