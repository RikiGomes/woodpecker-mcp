# woodpecker-mcp

[![CI](https://github.com/RikiGomes/woodpecker-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/RikiGomes/woodpecker-mcp/actions/workflows/ci.yml)

MCP (Model Context Protocol) server for [Woodpecker CI](https://woodpecker-ci.org). Gives AI agents and MCP clients **read-only** visibility into pipeline status and logs across **multiple self-hosted Woodpecker instances** — so a code reviewer (human or agent) can check whether CI is green and pull the failing step's output without leaving the conversation.

Built against the Woodpecker v3 REST API (verified on v3.16.0). No write operations: the server never restarts, approves, or cancels pipelines.

## Tools

| Tool | Purpose |
|------|---------|
| `list_instances` | List configured instances; `check: true` verifies connectivity + token per instance |
| `list_repos` | Repositories the token can access on an instance |
| `list_pipelines` | Recent pipelines for a repo, filterable by branch / event / status |
| `get_pipeline` | One pipeline with workflows, steps, exit codes, and `failed_step_ids` |
| `get_step_logs` | Log output of a step (tailed, default last 100 lines) |

Repos are addressed as `owner/name` or by numeric Woodpecker repo id. `get_pipeline` accepts `number: "latest"` (optionally with `branch`).

## Configuration

Instances are configured via environment variables — one URL/token pair per instance:

```bash
# Single instance (named "default"). WOODPECKER_SERVER (the official CLI var) also works.
WOODPECKER_URL=https://ci.example.com
WOODPECKER_TOKEN=<personal access token>

# Or one pair per instance — the name becomes the `instance` argument on every tool:
WOODPECKER_PROD_URL=https://ci.example.com
WOODPECKER_PROD_TOKEN=...
WOODPECKER_STAGING_URL=https://ci.staging.example
WOODPECKER_STAGING_TOKEN=...
```

Tokens come from `<server>/user/cli-and-api` on each Woodpecker instance.

The server also loads a `.env.woodpecker` file from its working directory if present (MCP clients launch stdio servers with the project as working directory). Real environment variables take precedence over file values.

Instances with self-signed certificates: point Node at your CA with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.

## Usage with Claude Code

Register in a project's `.mcp.json` (or `claude mcp add`):

```json
{
  "mcpServers": {
    "woodpecker": {
      "command": "npx",
      "args": ["-y", "github:RikiGomes/woodpecker-mcp"]
    }
  }
}
```

Alternatively, clone it once and point at the local build:

```json
{
  "mcpServers": {
    "woodpecker": {
      "command": "node",
      "args": ["/path/to/woodpecker-mcp/dist/index.js"]
    }
  }
}
```

(after `npm install && npm run build` in the clone).

## Development

Node >= 22.18 runs the TypeScript sources directly (type stripping):

```bash
npm install
npm run dev     # run the server from src/
npm run check   # typecheck
npm test        # vitest
npm run build   # emit dist/
```

Everything is plain ESM; relative imports use explicit `.ts` extensions and the build rewrites them to `.js`.

## Testing with the MCP Inspector

The [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) is the quickest way to poke at the tools by hand:

```bash
npm run build
npx @modelcontextprotocol/inspector node dist/index.js -e WOODPECKER_URL=https://ci.example.com -e WOODPECKER_TOKEN=<token>
```

**The Inspector does not pass your shell environment to the server it launches.** Prefixing the command (`WOODPECKER_URL=… npx @modelcontextprotocol/inspector …`) or `export`ing beforehand sets the variable on the Inspector, not on this server — which then starts with no instances configured. Use one of:

- the `-e KEY=VALUE` flags shown above — note they go **after** `node dist/index.js`, not before;
- the **Environment Variables** fields in the Inspector's connection pane (then Connect / Restart);
- a `.env.woodpecker` file in the directory you launch from (the name is exact — a plain `.env` is not read).

Scripted checks work too, via the Inspector's CLI mode:

```bash
npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list
npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/call --tool-name list_instances
```

## Design notes

- **Read-only by contract.** Intended for reviewer agents; there is deliberately no restart/approve/cancel surface.
- **Log tailing.** Woodpecker returns a step's entire stored log in one response; `get_step_logs` tails (default 100 lines, max 2000) to protect the caller's context window. Exit-code entries are labelled `[exit code]`.
- **Slug resolution.** `owner/name` is resolved via `/api/repos/lookup/…` once and cached per process.
- **Sub-path hosting.** Instance base URLs may include a sub-path (`WOODPECKER_ROOT_PATH` installs).

## License

MIT — see [LICENSE](LICENSE).
