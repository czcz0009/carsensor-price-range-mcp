/**
 * carcensor-price-range-mcp — Apify Actor エントリポイント(Week 3)
 *
 * このActorはMCPサーバーホストとして動く。実体(mcpServer.js、resolvePriceRangeツール)は
 * stdio MCPサーバーのまま変更せず、このファイルはApify Standbyモード上でHTTP
 * (Streamable HTTP、/mcp)を受け、mcpServer.jsを子プロセスとして起動してプロキシする。
 *
 * 構成はpkg-health-actor(package-health-checker)のMCP Actorと同じパターン
 * (Apify公式 ts-mcp-proxy テンプレート由来)を、このプロジェクトの既存スタイルである
 * プレーンJS/ESMに移植したもの(TypeScriptビルドは行わない)。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Actor, log } from 'apify';

import { startServer } from './server.js';

const currentDirname = path.dirname(fileURLToPath(import.meta.url));
// 既存のstdio MCPサーバー(ローカル/Claude Desktopから使っているものと同一ファイル)を
// 子プロセスとして起動する。resolvePriceRangeツールのロジック・キャッシュ・ログは
// すべてこの子プロセス側にあり、Actor化にあたって一切変更していない。
const MCP_SERVER_ENTRYPOINT = path.join(currentDirname, '..', 'mcpServer.js');
const MCP_COMMAND = [process.execPath, MCP_SERVER_ENTRYPOINT];

const STANDBY_MODE = process.env.APIFY_META_ORIGIN === 'STANDBY';
const SERVER_PORT = parseInt(process.env.ACTOR_WEB_SERVER_PORT || '3001', 10);

await Actor.init();

// 課金はツール呼び出し単位(resolve-price-range-success)で、プロキシ先のmcpServer.js内
// から行う(pkg-health-actorのMCP Actorと同じ配線)。standbyモードでの「起動」自体には
// ユーザーが直接対応させられる作業単位がない(1コンテナが多数の呼び出しを処理しうる)ため、
// 定額のactor-start課金イベントは設けない。

if (!STANDBY_MODE) {
    // このActorはMCPサーバーであり、standbyモード以外(Apifyの自動デフォルト入力
    // ヘルスチェックや、Console上で"Start"を押した通常実行など)ではやることがない。
    // これは失敗ではなく想定内の挙動 — ただしERRORログでゼロ出力のまま終了すると
    // 「成功したのに壊れて見える」問題が過去のMCP Actorで起きているため(pkg-health-actor
    // で見つかった既知の問題)、INFOログ+説明用データセット1件を出してから終了する。
    const msg = 'This Actor is an MCP server that only runs in standby mode. It has nothing to do '
        + 'in a normal run — see the README for how to connect an MCP client to the standby URL.';
    log.info(msg);
    await Actor.pushData({
        note: msg,
        documentationUrl: 'https://apify.com/woolen_snake/carcensor-price-range-mcp',
    });
    await Actor.exit({ statusMessage: msg });
}

await startServer({
    serverPort: SERVER_PORT,
    command: MCP_COMMAND,
});
