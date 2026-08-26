/**
 * MCPプロトコル用のHTTPサーバー(Streamable HTTP、/mcp)。
 * pkg-health-actorのMCP Actor(my-mcp-server/src/server.ts)と同じロジックをJSに移植した
 * もの(TypeScriptの型注釈のみ除去、挙動は同一)。セッションごとのtransportを管理し、
 * リクエストのルーティングを行う。課金はこの層ではなく、プロキシ先のmcpServer.js内
 * (ツール呼び出しの成功時)で行う。
 */
import { randomUUID } from 'node:crypto';

import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { log } from 'apify';
import express from 'express';

import { getMcpServer as getMCPServerWithCommand } from './mcp.js';

let getMcpServer = null;

// セッションIDごとのtransportを保持
const transports = {};

async function mcpPostHandler(req, res) {
    if (!getMcpServer) {
        res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Server not initialized' },
            id: null,
        });
        return;
    }
    const sessionId = req.headers['mcp-session-id'];
    log.info('Received MCP request', { sessionId: sessionId || null, body: req.body });
    try {
        let transport;
        if (sessionId && transports[sessionId]) {
            transport = transports[sessionId];
        } else if (!sessionId && isInitializeRequest(req.body)) {
            const eventStore = new InMemoryEventStore();
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                eventStore,
                onsessioninitialized: (initializedSessionId) => {
                    log.info('Session initialized', { sessionId: initializedSessionId });
                    transports[initializedSessionId] = transport;
                },
            });

            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid && transports[sid]) {
                    log.info('Transport closed', { sessionId: sid });
                    delete transports[sid];
                }
            };

            const server = await getMcpServer();
            await server.connect(transport);

            await transport.handleRequest(req, res, req.body);
            return;
        } else {
            res.status(400).json({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
                id: null,
            });
            return;
        }

        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        log.error('Error handling MCP request:', { error, sessionId: sessionId || null });
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Internal server error' },
                id: null,
            });
        }
    }
}

async function mcpGetHandler(req, res) {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }
    const lastEventId = req.headers['last-event-id'];
    if (lastEventId) {
        log.info('Client reconnecting', { lastEventId: lastEventId || null });
    } else {
        log.info('Establishing new SSE stream', { sessionId: sessionId || null });
    }
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
}

async function mcpDeleteHandler(req, res) {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }
    log.info('Received session termination request', { sessionId: sessionId || null });
    try {
        const transport = transports[sessionId];
        await transport.handleRequest(req, res);
    } catch (error) {
        log.error('Error handling session termination:', { error });
        if (!res.headersSent) {
            res.status(500).send('Error processing session termination');
        }
    }
}

/**
 * @param {{ serverPort: number, command: string[] }} options
 */
export async function startServer(options) {
    log.info('Starting MCP HTTP Server', { serverPort: options.serverPort, command: options.command });
    const { serverPort, command } = options;
    getMcpServer = async () => getMCPServerWithCommand(command);

    const app = express();

    app.get('/favicon.ico', (_req, res) => {
        res.writeHead(301, { Location: 'https://apify.com/favicon.ico' });
        res.end();
    });

    // Apify Standbyのレディネスプローブ
    app.get('/', (req, res) => {
        if (req.headers['x-apify-container-server-readiness-probe']) {
            log.info('Readiness probe');
            res.end('ok\n');
            return;
        }
        res.status(404).end();
    });

    // MCPクライアントがApify OAuthで認証できるよう、認可サーバーメタデータを転送する
    app.get('/.well-known/oauth-authorization-server', async (_req, res) => {
        const response = await fetch('https://api.apify.com/.well-known/oauth-authorization-server');
        const data = await response.json();
        res.status(200).json(data);
    });

    app.use(express.json({ limit: '10mb' }));

    app.post('/mcp', mcpPostHandler);
    app.get('/mcp', mcpGetHandler);
    app.delete('/mcp', mcpDeleteHandler);

    app.listen(serverPort, () => {
        log.info(`MCP HTTP Server listening on port ${serverPort}`);
    });

    process.on('SIGINT', async () => {
        log.info('Shutting down server...');
        for (const sessionId of Object.keys(transports)) {
            try {
                log.info(`Closing transport for session ${sessionId}`);
                await transports[sessionId].close();
                delete transports[sessionId];
            } catch (error) {
                log.error(`Error closing transport for session ${sessionId}:`, { error });
            }
        }
        log.info('Server shutdown complete');
        process.exit(0);
    });
}
