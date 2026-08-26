/**
 * MCPサーバーインスタンスの生成と、stdioプロキシクライアントの配線。
 * pkg-health-actorのMCP Actor(my-mcp-server/src/mcp.ts)と同じロジックをJSに移植したもの
 * (TypeScriptの型注釈のみ除去、挙動は同一)。
 *
 * このActor自体は「MCPプロトコルをHTTPで受けてstdioの子プロセスへ転送するだけ」の
 * プロキシで、resolvePriceRangeの実ロジックには一切関与しない。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
    ClientNotificationSchema,
    ClientRequestSchema,
    ResultSchema,
    ServerNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { log } from 'apify';

/**
 * @param {string[]} command stdio MCPプロキシプロセスを起動するコマンド
 * @param {{ timeout?: number }} [options]
 * @returns {Promise<McpServer>}
 */
export async function getMcpServer(command, options) {
    const server = new McpServer({
        name: 'mcp-server',
        version: '1.0.0',
    });

    server.server.registerCapabilities({
        tools: {},
        prompts: {},
        resources: {},
        completions: {},
        logging: {},
        tasks: {},
    });

    const proxyClient = await getMcpProxyClient(command);

    for (const schema of ClientRequestSchema.options) {
        const method = schema.shape.method.value;
        server.server.setRequestHandler(schema, async (req) => {
            if (req.method === 'initialize') {
                // 'initialize'はプロキシ先に転送せずここで直接応答する(mcp-remote等が
                // 正しく動くために必要)。
                return {
                    capabilities: proxyClient.getServerCapabilities(),
                    protocolVersion: req.params.protocolVersion,
                    serverInfo: {
                        name: 'Apify MCP proxy server',
                        title: 'Apify MCP proxy server',
                        version: '1.0.0',
                    },
                };
            }
            log.info('Received MCP request', { method, request: req });
            return proxyClient.request(req, ResultSchema, {
                timeout: options?.timeout || DEFAULT_REQUEST_TIMEOUT_MSEC,
            });
        });
    }

    for (const schema of ClientNotificationSchema.options) {
        const method = schema.shape.method.value;
        server.server.setNotificationHandler(schema, async (notification) => {
            if (notification.method === 'notifications/initialized') {
                return; // 'initialized'も転送しない(mcp-remote等のため)
            }
            log.info('Received MCP notification', { method, notification });
            await proxyClient.notification(notification);
        });
    }

    for (const schema of ServerNotificationSchema.options) {
        const method = schema.shape.method.value;
        proxyClient.setNotificationHandler(schema, async (notification) => {
            log.info('Sending MCP notification', { method, notification });
            await server.server.notification(notification);
        });
    }

    server.server.onclose = () => {
        log.info('MCP Server is closing, shutting down the proxy client');
        proxyClient.close().catch((error) => {
            log.error('Error closing MCP Proxy Client', { error });
        });
    };

    return server;
}

/**
 * stdio MCPプロキシクライアントを起動・接続する。
 * @param {string[]} command
 * @returns {Promise<Client>}
 */
export async function getMcpProxyClient(command) {
    log.info('Starting MCP Proxy Client', { command });

    // StdioClientTransportは既定では最小限の環境変数しか子プロセスに引き継がないため、
    // 親プロセスの環境変数(APIFY_TOKEN, ACTOR_RUN_ID, APIFY_IS_AT_HOME等)を明示的に
    // 渡す。mcpServer.js(子プロセス)がActor.charge()を正しく呼べるために必須。
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) env[key] = value;
    }

    const transport = new StdioClientTransport({
        command: command[0],
        args: command.slice(1),
        env,
    });

    const client = new Client({ name: 'mcp-proxy-client', version: '1.0.0' });
    await client.connect(transport);
    log.info('MCP Proxy Client started successfully');
    return client;
}
