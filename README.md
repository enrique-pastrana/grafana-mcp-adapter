# grafana-mcp-adapter

Read-only MCP server that exposes Grafana dashboards, datasources and metric/log
queries as tools, for use by skills in the TICKETS workspace.

This is a **private, standalone** adapter: its own git repo, its own `.env`. It is
**not** part of `ia-tooling` and does not depend on its stack — it only makes HTTPS
calls out to the Grafana HTTP API (`${GRAFANA_BASE_URL}/api`). It was scaffolded by
cloning the structure of `fathom-mcp-adapter`.

## Architecture

The adapter *is* the MCP server. Internally it calls the **Grafana HTTP API**
directly (just as the Fathom adapter calls Fathom's REST API). MCP servers are
not chained to one another.

- Auth: a Grafana **service account token** sent as a Bearer token in the
  `Authorization` header. Scope it to a read-only role (Viewer). Create the
  service account + token in Grafana → Administration → Service accounts.
- The adapter returns **raw** payloads (dashboard JSON, query frames). Any
  summarizing is done by the calling skill, never by a tool here.
- Read-only by design. Note that `grafana_query` is a `POST` (Grafana's
  `/api/ds/query` is POST-shaped) but only **reads** metrics/logs.

## Tools

| Tool | Purpose |
| --- | --- |
| `grafana_health` | Config/connectivity check (makes one authenticated call). |
| `grafana_search_dashboards` | Search dashboards by title substring and/or tags. |
| `grafana_get_dashboard` | Full dashboard JSON by `uid`. |
| `grafana_list_datasources` | List configured datasources (uid, name, type). |
| `grafana_query` | Run a PromQL/LogQL/etc. query against a datasource uid over a time range. |

## Setup

```bash
npm install
cp .env.example .env   # then fill in GRAFANA_BASE_URL and GRAFANA_TOKEN
npm test
npm start              # speaks MCP over stdio
```

`GRAFANA_TOKEN` must come from `.env` (which is git-ignored) — never hardcode it.

## Wiring into the TICKETS MCP session

Build the image and add a `grafana` entry to the TICKETS `.mcp.json`, alongside
`fathom` / `zendesk` / `vectordb` / `github`. It only needs HTTPS egress.

```bash
docker build -t grafana-mcp-adapter .
```

```jsonc
// .mcp.json (TICKETS)
{
  "mcpServers": {
    "grafana": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "--env-file", "/ABSOLUTE/PATH/TO/.env", "grafana-mcp-adapter"]
    }
  }
}
```
