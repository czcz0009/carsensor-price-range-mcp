/**
 * mcpServer.js に対する疎通確認用の簡易MCPクライアント。
 * stdio経由でサーバーを起動し、tools/listとresolvePriceRangeの呼び出しを確認する。
 * Claude Desktopが使うのと全く同じstdio transport/MCPプロトコルを使うため、
 * ここで通れば「Claude Desktopから見えるやり取り」を実プロセス間通信で検証したことになる
 * (ただしClaude DesktopというGUIアプリ自体の操作は別途、人手での確認が必要)。
 *
 * 同じ車種・年式を2回連続で呼び、2回目でキャッシュヒット(tier1/tier2ともにhit)に
 * なることと、応答時間が短縮されることも確認する。
 *
 * 使い方: node scripts/testClient.js
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(__dirname, '..', 'mcpServer.js')],
    });

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(transport);

    console.log('=== tools/list ===');
    const tools = await client.listTools();
    console.log(JSON.stringify(tools, null, 2));

    console.log('\n=== resolvePriceRange({ carModel: "プリウス", year: 2018 }) [1回目、キャッシュミス想定] ===');
    const t0 = Date.now();
    const first = await client.callTool({
        name: 'resolvePriceRange',
        arguments: { carModel: 'プリウス', year: 2018 },
    });
    console.log(`所要時間: ${Date.now() - t0}ms`);
    console.log(JSON.stringify(first, null, 2));

    console.log('\n=== resolvePriceRange({ carModel: "プリウス", year: 2018 }) [2回目、キャッシュヒット想定] ===');
    const t1 = Date.now();
    const second = await client.callTool({
        name: 'resolvePriceRange',
        arguments: { carModel: 'プリウス', year: 2018 },
    });
    console.log(`所要時間: ${Date.now() - t1}ms`);
    console.log(JSON.stringify(second, null, 2));

    console.log('\n=== resolvePriceRange({ carModel: "架空の存在しない車種XYZ123", year: 2018 }) [異常系] ===');
    const abnormal = await client.callTool({
        name: 'resolvePriceRange',
        arguments: { carModel: '架空の存在しない車種XYZ123', year: 2018 },
    });
    console.log(JSON.stringify(abnormal, null, 2));

    await client.close();
}

main().catch((err) => {
    console.error('テストクライアントでエラー:', err);
    process.exit(1);
});
