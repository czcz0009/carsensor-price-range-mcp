# Generic stdio MCP server image — for MCP directories that build/run a container directly
# and speak MCP over stdio (e.g. Glama's "Dockerfile admin page" / Deploy flow).
#
# This is intentionally separate from .actor/Dockerfile, which builds the Apify Standby-mode
# HTTP proxy variant (src/main.js) for the Apify platform specifically. This root Dockerfile
# runs mcpServer.js directly over stdio — the same file Claude Desktop / Claude Code launch
# locally — with no Apify-platform assumptions. Actor.init()/Actor.charge() inside
# mcpServer.js degrade gracefully (log + continue) when no Apify environment is present, so
# billing simply stays inactive when run this way; that's expected, not a bug.
FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --omit=optional

COPY . .

CMD ["node", "mcpServer.js"]
