import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ENABLED, BASE_URL, log, requireConfig, grafanaGet, grafanaPost } from "./grafanaClient.js";

const DEFAULT_LIMIT = Number.parseInt(process.env.GRAFANA_DEFAULT_LIMIT || "20", 10);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(value) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

// Normalize one search hit down to the fields a skill actually needs to pick a
// dashboard (by title/tags) and then fetch it (by uid).
function summarizeDashboard(d = {}) {
  return {
    uid: d.uid ?? null,
    title: d.title || null,
    type: d.type || null,
    folder_title: d.folderTitle || null,
    tags: d.tags || [],
    url: d.url || null,
  };
}

async function searchDashboards({ query, tags, limit } = {}) {
  // /search returns dashboards + folders. type=dash-db restricts to dashboards.
  const hits = await grafanaGet("/search", {
    query,
    tag: tags,
    type: "dash-db",
    limit,
  });
  const items = Array.isArray(hits) ? hits : [];
  const dashboards = items.map(summarizeDashboard);
  const sliced = typeof limit === "number" ? dashboards.slice(0, limit) : dashboards;
  return { count: sliced.length, dashboards: sliced };
}

async function getDashboard(uid) {
  // Returns { dashboard: {...}, meta: {...} }. We hand back the raw payload; the
  // skill decides what to read out of the (potentially large) panel JSON.
  return grafanaGet(`/dashboards/uid/${encodeURIComponent(uid)}`);
}

async function listDatasources() {
  const items = await grafanaGet("/datasources");
  const list = Array.isArray(items) ? items : [];
  return {
    count: list.length,
    datasources: list.map((ds) => ({
      uid: ds.uid ?? null,
      name: ds.name || null,
      type: ds.type || null,
      is_default: ds.isDefault ?? false,
    })),
  };
}

// The raw /ds/query response is huge (one full timestamp+value array per series,
// and `up` alone can be thousands of series). For MCP use we collapse each series
// to its labels + a numeric digest (count, first/last/min/max/avg). The caller can
// always re-query a narrower expression if it needs the full time arrays.
// TODO(enrique): tune what we keep here once the real use case is pinned down.
function summarizeQueryResult(payload = {}, { maxSeries = 50 } = {}) {
  const out = { results: {} };
  for (const [refId, res] of Object.entries(payload.results || {})) {
    const frames = Array.isArray(res?.frames) ? res.frames : [];
    const series = [];
    for (const frame of frames) {
      const fields = frame?.schema?.fields || [];
      const valueFieldIdx = fields.findIndex((f) => f?.type === "number");
      const labels = valueFieldIdx >= 0 ? fields[valueFieldIdx]?.labels || {} : {};
      const values = (frame?.data?.values?.[valueFieldIdx] || []).filter((v) => typeof v === "number");
      const count = values.length;
      const digest = count
        ? {
            count,
            first: values[0],
            last: values[count - 1],
            min: Math.min(...values),
            max: Math.max(...values),
            avg: values.reduce((a, b) => a + b, 0) / count,
          }
        : { count: 0 };
      series.push({ labels, ...digest });
    }
    out.results[refId] = {
      status: res?.status ?? null,
      series_count: series.length,
      series: series.slice(0, maxSeries),
      truncated: series.length > maxSeries ? series.length - maxSeries : 0,
    };
  }
  return out;
}

async function withToolLogging(tool, fields, fn) {
  const start = Date.now();
  log("info", "Tool call started", { tool, ...fields });
  try {
    const result = await fn();
    log("info", "Tool call succeeded", { tool, duration_ms: Date.now() - start });
    return result;
  } catch (err) {
    log("error", "Tool call failed", {
      tool,
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// MCP server + tool registration
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "grafana-mcp-adapter",
  version: "0.1.0",
});

server.tool("grafana_health", "Read-only Grafana health/config check.", {}, async () =>
  withToolLogging("grafana_health", {}, async () => {
    requireConfig();
    // A cheap authenticated call confirms the token works.
    const probe = await searchDashboards({ limit: 1 });
    return textResult({
      status: "ok",
      enabled: ENABLED,
      base_url: BASE_URL,
      reachable: true,
      sample_dashboard_count: probe.count,
    });
  }),
);

server.tool(
  "grafana_search_dashboards",
  "Read-only search of Grafana dashboards (by title substring and/or tags). " +
    "Returns uid, title, folder, tags and url for each. Use the uid with " +
    "grafana_get_dashboard to fetch the full dashboard JSON.",
  {
    query: z.string().optional().describe("Title substring to match."),
    tags: z.array(z.string()).optional().describe("Filter by dashboard tags."),
    limit: z.number().int().min(1).max(100).default(DEFAULT_LIMIT),
  },
  async ({ query, tags, limit = DEFAULT_LIMIT }) =>
    withToolLogging("grafana_search_dashboards", { query, limit }, async () =>
      textResult(await searchDashboards({ query, tags, limit })),
    ),
);

server.tool(
  "grafana_get_dashboard",
  "Read-only fetch of a Grafana dashboard's full JSON by uid (panels, variables, " +
    "queries, meta). Get the uid from grafana_search_dashboards.",
  { uid: z.string() },
  async ({ uid }) =>
    withToolLogging("grafana_get_dashboard", { uid }, async () => textResult(await getDashboard(uid))),
);

server.tool(
  "grafana_list_datasources",
  "Read-only list of configured Grafana datasources. Returns uid, name, type and " +
    "is_default. Use a datasource uid with grafana_query.",
  {},
  async () => withToolLogging("grafana_list_datasources", {}, async () => textResult(await listDatasources())),
);

server.tool(
  "grafana_query",
  "Read-only metric/log query via Grafana's /api/ds/query. Provide the datasource " +
    "uid (from grafana_list_datasources), a raw expression (PromQL for Prometheus, " +
    "LogQL for Loki, etc.), and an optional time range. By default returns a compact " +
    "per-series digest (labels + count/first/last/min/max/avg); pass raw=true for the " +
    "full (potentially very large) frames.",
  {
    datasource_uid: z.string().describe("Datasource uid from grafana_list_datasources."),
    expr: z.string().describe("Query expression (PromQL/LogQL/etc.)."),
    from: z.string().default("now-1h").describe("Range start, e.g. 'now-1h' or epoch ms."),
    to: z.string().default("now").describe("Range end, e.g. 'now' or epoch ms."),
    max_data_points: z.number().int().min(1).max(5000).default(1000).optional(),
    raw: z.boolean().default(false).optional().describe("Return the full raw frames instead of the per-series digest. Can be very large."),
  },
  async ({ datasource_uid, expr, from = "now-1h", to = "now", max_data_points = 1000, raw = false }) =>
    withToolLogging("grafana_query", { datasource_uid }, async () => {
      const payload = await grafanaPost("/ds/query", {
        from,
        to,
        queries: [
          {
            refId: "A",
            datasource: { uid: datasource_uid },
            expr,
            maxDataPoints: max_data_points,
          },
        ],
      });
      return textResult(raw ? payload : summarizeQueryResult(payload));
    }),
);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
  log("info", "Starting MCP adapter", { enabled: ENABLED, base_url: BASE_URL || null });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("info", "MCP adapter connected", { transport: "stdio" });
}

main().catch((err) => {
  log("error", "MCP adapter failed to start", { error: err.message, stack: err.stack });
  process.exit(1);
});
