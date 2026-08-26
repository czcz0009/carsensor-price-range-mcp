/**
 * carcensor-price-range-mcp — MCP サーバー本体
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
 *   - 複数ディレクトリへの掲載(Week 5)
 *
 * 起動方法:
 *   - ローカル/Claude Desktop: node mcpServer.js (stdioで直接起動)
 *   - Apify Actor(Week 3〜): src/main.js が子プロセスとしてこのファイルをstdio起動し、
 *     Streamable HTTP(/mcp)にプロキシする。課金(Actor.charge)はこのファイル内、
 *     resolvePriceRangeが成功した直後に行う(pkg-health-actorのMCP Actorと同じ配線 —
 *     Apify platform外や pay-per-event 未設定時は Actor.charge() が警告ログのみの
 *     no-opになるため、Claude Desktop等からの直接起動でも安全)。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Actor } from 'apify';

import { resolvePriceRange } from './src/resolvePriceRange.js';

const server = new McpServer({
    name: 'carsensor-price-range-mcp',
    version: '0.1.0',
});

server.registerTool(
    'resolvePriceRange',
    {
        title: '中古車の市場価格レンジ推定',
        description:
            '車種名と年式から、carsensor.net自身が公開する相場(souba)ページの「価格×年式」集計データを基に、' +
            '市場価格レンジ(最小・最大・中央値)を返す。carsensorの検索結果から車種を特定できない場合、または' +
            '該当年式の相場データが無い場合はok:falseで理由を返す。走行距離は未対応(v2で追加予定)。',
        inputSchema: {
            carModel: z.string().describe('車種名(carsensorのフリーワード検索と同じ書式。例: "プリウス", "N-BOX")'),
            year: z.number().int().describe('年式(西暦4桁、例: 2015)'),
        },
    },
    async ({ carModel, year }) => {
        const result = await resolvePriceRange({ carModel, year });
        // 課金は成功時(ok:true)のみ。carsensorのvalueScore/campfireのfundingRisk等、
        // 既存Actor群と同じ「算出できなかった場合は課金しない」方針を踏襲する
        // (.actor/pay_per_event.json の resolve-price-range-success 参照)。
        if (result.ok) {
            await Actor.charge({ eventName: 'resolve-price-range-success' });
        }
        return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            isError: result.ok === false && result.reason === 'error',
        };
    },
);

async function main() {
    try {
        // gracefulShutdown: false — このプロセスはApify Actor化後、親(src/main.js)から
        // 起動される子プロセスになる。プロセスライフサイクル(SIGTERM等)は親の責務とし、
        // ここではpay-per-eventの価格情報を読み込むためだけにinit()する
        // (pkg-health-actorのMCP Actorと同じパターン)。ローカル/Claude Desktopから
        // 直接起動された場合(Apify環境変数なし)もinit()自体は安全に失敗するだけなので、
        // try/catchで握って続行する。
        await Actor.init({ gracefulShutdown: false });
    } catch (err) {
        console.error('Actor.init() に失敗しました(課金は無効化されます):', err.message);
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('carcensor-price-range-mcp MCP server running on stdio');
}

main().catch((err) => {
    console.error('MCPサーバーの起動に失敗しました:', err);
    process.exit(1);
});
