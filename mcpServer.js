/**
 * carcensor-price-range-mcp — MCP サーバー(Week 2 MVP)
 *
 * carcensor Actor(carsensor-resale-value-scout)の「価格レンジ推定」ロジックだけを
 * 切り出した、単一ツールのMCPサーバー。分析フェーズ(Week 1)で特定した設計に基づく:
 *   - 車種名 → maker/modelコード解決を長期キャッシュ(層1、data/cache/model-code-cache.json)
 *   - コード → souba価格×年式セルを12時間TTLでキャッシュ(層2、data/cache/souba-cells-cache.json)
 *   - carsensorへのHTTPリクエストは1000ms以上の間隔フロアを維持(src/priceRangeClient.js)
 *   - 全呼び出しをdata/logs/access.jsonlに記録(車種・キャッシュヒット/ミス・応答時間)
 *
 * スコープ外(意図的に未実装、次のWeek):
 *   - 走行距離入力(v2)
 *   - MCPサーバーとしての課金設計(Week 3)
 *   - 複数ディレクトリへの掲載(Week 5)
 *
 * 起動方法: node mcpServer.js (MCPクライアントからstdio経由で起動される想定)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { resolvePriceRange } from './src/resolvePriceRange.js';

const server = new McpServer({
    name: 'carcensor-price-range-mcp',
    version: '0.1.0',
});

server.registerTool(
    'resolvePriceRange',
    {
        title: '中古車の適正価格レンジ推定',
        description:
            '車種名と年式から、carsensor.net自身が公開する相場(souba)ページの「価格×年式」集計データを基に、' +
            '適正価格レンジ(最小・最大・中央値)を返す。carsensorの検索結果から車種を特定できない場合、または' +
            '該当年式の相場データが無い場合はok:falseで理由を返す。走行距離は未対応(v2で追加予定)。',
        inputSchema: {
            carModel: z.string().describe('車種名(carsensorのフリーワード検索と同じ書式。例: "プリウス", "N-BOX")'),
            year: z.number().int().describe('年式(西暦4桁、例: 2015)'),
        },
    },
    async ({ carModel, year }) => {
        const result = await resolvePriceRange({ carModel, year });
        return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            isError: result.ok === false && result.reason === 'error',
        };
    },
);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('carcensor-price-range-mcp MCP server running on stdio');
}

main().catch((err) => {
    console.error('MCPサーバーの起動に失敗しました:', err);
    process.exit(1);
});
