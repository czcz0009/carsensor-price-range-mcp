# See https://docs.apify.com/sdk/js/docs/guides/docker-images for details.
FROM apify/actor-node:20

# Copy just package.json and package-lock.json to speed up the build using Docker layer cache.
COPY --chown=myuser:myuser package*.json ./

# Install NPM packages, skip optional and development dependencies to keep the image small.
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && rm -r ~/.npm

# Copy the remaining source files (including mcpServer.js, which src/main.js spawns
# as a child stdio process — see src/main.js for why).
COPY --chown=myuser:myuser . ./

# Run the Actor. src/main.js starts the MCP HTTP proxy in Standby mode.
CMD ["node", "src/main.js"]
