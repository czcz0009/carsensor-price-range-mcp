# carsensor Price Range MCP Server for AI Agents

If you're building an AI agent, chatbot, or app that needs to answer "is this used car's asking price
fair?" — not a guess, but a number grounded in real market data — this MCP server gives you exactly that
in a single tool call. `resolvePriceRange(carModel, year)` returns a market-price range (min / max / median)
computed live from carsensor.net's own official price-by-model-year market statistics — the same data
carsensor itself publishes on its 相場(market price) pages, turned into a structured, ready-to-use number
instead of a page you'd have to read and interpret yourself.

**What you get:**

- One tool, `resolvePriceRange`, taking just a car model name and a year — no API keys to manage for the
  underlying data source, no HTML to parse yourself
- `priceRangeYen: { min, max, median }` plus `sampleSize` (how many real carsensor listings the estimate is
  based on) and `confidence` (`normal` / `low` — honestly downgraded, not hidden, when the year can't be
  fully verified against carsensor's own data; see "Known limitations")
- Always-on hosting via Apify Standby mode — no server to run yourself. Connect any MCP client (Claude
  Desktop, Claude Code, your own agent) directly to a stable HTTPS endpoint, or call it as a plain
  Streamable HTTP MCP server from your own app's code

```json
{
  "ok": true,
  "carModel": "プリウス",
  "year": 2018,
  "priceRangeYen": { "min": 750000, "max": 4772500, "median": 1573112 },
  "sampleSize": 412,
  "confidence": "normal",
  "disclaimer": "carsensor.net上の公開情報(相場ページの価格×年式集計)を基にした参考値です。個体差・装備差・実際の商談結果は反映されません。"
}
```

Pay-per-event pricing — see "Pricing" below. Full input/output details, setup, and technical design are
further down this page.

## ⚠️ Disclaimer (please read)

- This Actor automatically retrieves information that is publicly available on carsensor.net.
  **You are responsible for how you retrieve and use this data.**
- **The site owner's Terms of Use, robots.txt, or access blocking could change without notice, which
  could stop this Actor from working or change its output unexpectedly.**
- **`priceRangeYen` is a statistical estimate derived from carsensor's own published price×model-year
  aggregate data, not a guarantee of any individual vehicle's true value.** It does not account for
  condition, trim/grade differences, or mileage (see "Known limitations"). **Always verify a specific
  vehicle's price on carsensor.net itself before making any purchase or sale decision based on this data.**

## Who is this for?

- **AI agents and chatbots** that need to ground a "what is this actually worth?" answer in real market data
  instead of the model's own (often outdated or hallucinated) knowledge of used-car pricing
- **App/tool developers** building car-shopping, valuation, or trade-in estimation features who want a
  ready-made price-range lookup instead of scraping and maintaining their own carsensor.net integration
- Anyone who wants this as a plain MCP tool call rather than a batch scrape — this Actor is the single-tool,
  call-on-demand counterpart to our batch-oriented `carsensor-resale-value-scout` Actor (which scores whole
  lists of listings against the same underlying market data)

## What can't it do (please read before integrating)

- **Mileage is not a supported input yet.** Only car model and year are used — the price range reflects
  carsensor's own model-year aggregate, not a mileage-adjusted estimate. A future version may add this.
- **Model-name resolution can occasionally fail or be slow on first use for an unfamiliar model** — see
  "Known limitations" for why, and how caching mitigates this after the first call.
- **This is a statistical estimate, not an appraisal.** See the Disclaimer above.

## Input / Output

**Input** (MCP tool call arguments):

| Parameter | Type | Required | Description |
|---|---|---|---|
| `carModel` | string | Yes | Car model name, same free-text format as carsensor's own search (e.g. `"プリウス"`, `"N-BOX"`) |
| `year` | integer | Yes | Model year, 4-digit (e.g. `2018`) |

**Output** (success):

| Field | Type | Description |
|---|---|---|
| `priceRangeYen.min` / `.max` / `.median` | integer (JPY) | Estimated market-price range for this model/year |
| `sampleSize` | integer | Number of carsensor listings the estimate is aggregated from |
| `confidence` | `"normal"` \| `"low"` | `"low"` when the year only matches an open-ended bucket in carsensor's data (see "Known limitations") — a `note` field explains why when this happens |
| `cacheStatus` | object | `tier1`/`tier2` — whether this call hit cached data or made a fresh request to carsensor.net (informational only, does not affect price — see "Pricing") |

**Output** (model not found / no data for that year): `{ "ok": false, "reason": "no_code_resolved" | "no_matching_data", "message": "..." }` — **not charged** (see "Pricing").

## Usage example

**Claude Desktop / any MCP client config:**

```json
{
  "mcpServers": {
    "carsensor-price-range": {
      "url": "https://woolen-snake--carsensor-price-range-mcp.apify.actor/mcp",
      "headers": { "Authorization": "Bearer YOUR_APIFY_TOKEN" }
    }
  }
}
```

**Calling it directly from your own app (Node.js, `@modelcontextprotocol/sdk`):**

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(
  new URL('https://woolen-snake--carsensor-price-range-mcp.apify.actor/mcp'),
  { requestInit: { headers: { Authorization: `Bearer ${process.env.APIFY_TOKEN}` } } },
);
const client = new Client({ name: 'my-app', version: '1.0.0' });
await client.connect(transport);

const result = await client.callTool({
  name: 'resolvePriceRange',
  arguments: { carModel: 'プリウス', year: 2018 },
});
console.log(JSON.parse(result.content[0].text));
```

## Pricing

| Event | Price | Trigger |
|---|---|---|
| Price range resolved (`resolve-price-range-success`) | **$0.03** | Charged only when `resolvePriceRange` successfully returns a price range. Not charged when the car model can't be resolved or no matching year data exists |

Flat pricing regardless of whether the call hit cached data or triggered a fresh request to carsensor.net —
see "How the price was set" below for the full reasoning, including why cache-tiered pricing was
deliberately rejected.

### How the price was set

$0.03 sits between this Actor family's base classification tier ($0.015, e.g. `listing-extracted` on our
`carsensor-resale-value-scout` Actor) and its heavier derived-signal tier ($0.045–$0.065, e.g.
`value-score-computed`) — reflecting that a price range is a computed market signal, not a raw data fetch,
while this tool's underlying infra cost (well under $0.001/call, most calls served from cache) leaves a
large margin either way.

**Why cache hits and misses are priced the same**: the value delivered — `priceRangeYen`, `sampleSize`,
`confidence` — is identical either way; caching is purely an internal performance/cost optimization, not a
difference in what you get. Pricing it differently would also create a perverse incentive to shorten the
cache TTL (more misses = more revenue), which runs directly against this tool's own design goal of
minimizing load on carsensor.net.

## Data source and calculation

Uses carsensor.net's own publicly-published 相場(market price) page for the resolved model
(`/usedcar/souba/{makerCode}_S{modelCode}/`), specifically its "price × model-year" cross-tabulation
(price bucket, year bucket, listing count per cell) — official aggregate data carsensor itself computes
from its own live inventory, not a third-party estimate.

- `median` is a count-weighted average of each matching year-bucket's price-bucket midpoint
- `min` / `max` come from the actual price-bucket bounds of the matching cells (open-ended buckets, e.g.
  "¥4,150,000 or more", are approximated with a ±15% heuristic — an empirical adjustment, not a
  statistically derived one)
- This is grade-level aggregate data (e.g. all Toyota Prius trims combined), not individual-listing pricing
  — it doesn't account for trim/grade differences, equipment, or condition

## Caching (2-tier)

| Tier | Key | Value | Storage | Expiry |
|---|---|---|---|---|
| 1 | Car model name | `{ makerCode, modelCode }` | File-persisted | Unbounded (carsensor's model coding is effectively static) |
| 2 | `{makerCode}_S{modelCode}` | carsensor's price×model-year cells | File-persisted | 12 hours |

A cache hit on both tiers means zero HTTP requests to carsensor.net for that call. **On the Apify-hosted
version, this cache is scoped to a single Standby run/container instance** — concurrent sessions can land
on different container instances with independent caches, so the real-world hit rate on the hosted version
may be lower than what a single long-running local process would see. A future version may move this to
Apify's Key-Value Store (shared across runs) if this turns out to matter in practice.

## Access interval and logging

Requests to carsensor.net are paced at a minimum 1000ms interval (1500ms by default) as a load-reduction
measure — the same floor used by our `carsensor-resale-value-scout` Actor. Every call is logged (model,
year, per-tier cache hit/miss, HTTP requests actually made, response time, outcome) for future monitoring —
not exposed to callers, used only for operating this Actor responsibly.

## FAQ

**Why is `confidence` sometimes `"low"`?**
carsensor's year axis has an open-ended bottom bucket in its own data (e.g. "2012 or earlier"). Any year at
or before that bound will match it, whether or not the model actually existed yet in that year — there's no
way to fully verify plausibility from this data alone, so `confidence` is honestly downgraded rather than
reported as certain. See the `note` field on such responses for the specific reason.

**Why does my first call for a given model take a few seconds, but repeat calls are much faster?**
The first call for an unfamiliar model needs up to 3 real requests to carsensor.net (search → detail page →
market-price page) to resolve which model this is. Once resolved, the model→code mapping is cached
effectively permanently, and the price data itself is cached for 12 hours — so repeat calls for the same
model are near-instant.

**Does this cover mileage?**
Not yet — see "What can't it do."

**How is this different from `carsensor-resale-value-scout`?**
That Actor is a batch scraper: give it a search term, get back a list of live listings each scored against
this same market data. This Actor is the single-call, on-demand counterpart, built for AI agents and apps
that want one number for one model/year — not a list to scrape and process.

## Known limitations

- **Model-name resolution has no direct lookup — it goes through carsensor's own freeword search and reads
  a matching listing's page to identify the model.** For a genuinely unrecognized model (typo, non-existent
  model), carsensor's search results page still contains a "you might also like" widget with unrelated
  cars; this Actor explicitly detects and excludes that widget so it doesn't get mistaken for a real match
  — confirmed via live testing.
- **`confidence` cannot fully verify whether a queried year is plausible for a given model** — see FAQ.
- **This is a grade-level aggregate, not an individual-listing price** — see "Data source and calculation."
- **The file-based cache is per-container on the hosted (Apify Standby) version** — see "Caching."
- **This tool's underlying scraping logic is deliberately duplicated from, not imported from,
  `carsensor-resale-value-scout`'s codebase**, to keep the two independently-deployed Actors decoupled. A
  carsensor.net markup change affecting one may require a matching fix in the other.
- **Not listed on Smithery**: Apify Standby's authentication response isn't OAuth-discovery-conformant, which breaks Smithery's automatic connection scan before it ever reaches this server's own config-based auth — no workaround is planned for now.

## Possible future extensions (not implemented in this version)

- Mileage as a third input, using carsensor's price×mileage matrix (confirmed fetchable, not yet wired up)
- Moving the cache to Apify's Key-Value Store so it's shared across Standby container instances
- Listing on additional MCP directories beyond the Apify Store
