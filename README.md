# woodpecker-mcp

[![CI](https://github.com/RikiGomes/woodpecker-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/RikiGomes/woodpecker-mcp/actions/workflows/ci.yml)

MCP (Model Context Protocol) server for [Woodpecker CI](https://woodpecker-ci.org). Gives AI agents and MCP clients **read-only** visibility into pipeline status and logs across **multiple self-hosted Woodpecker instances**, so a code reviewer (human or agent) can check whether CI is green and pull the failing step's output without leaving the conversation.

Built against the Woodpecker v3 REST API (verified on v3.16.0; endpoints added since were checked against the v3.19.0 server source). No write operations: the server never restarts, approves, or cancels pipelines.

## Tools

| Tool | Purpose |
|------|---------|
| `list_instances` | List configured instances; `check: true` verifies connectivity + token per instance |
| `list_repos` | Repositories the token can access on an instance; `name` filters by owner/name substring |
| `recent_activity` | Newest pipelines across all your repos (Woodpecker's feed), filterable by status |
| `list_pipelines` | Recent pipelines for a repo, filterable by branch / event / status |
| `get_pipeline` | One pipeline with workflows, steps, exit codes, and `failed_step_ids` |
| `diagnose_pipeline` | One-call triage: failed steps with their exit codes, errors and log tails |
| `get_step_logs` | Log output of a step (tailed, default last 100 lines), or `match` to search the whole log for plain text |
| `get_pipeline_config` | The workflow YAML files Woodpecker fetched for a pipeline |
| `list_branches` | Branch names from the forge |
| `list_pull_requests` | Open pull requests from the forge |
| `list_crons` | Cron jobs of a repo (variable names only) *(push access)* |
| `list_secrets` | Secret names, events and images; never values *(push access)* |
| `list_agents` | Build agents and when they last checked in *(admin)* |
| `get_queue_info` | Pending / running tasks and worker counts, to explain stuck pipelines *(admin)* |

Tools marked *(push access)* or *(admin)* return Woodpecker's 403 as a tool error when the token lacks that permission.

Repos are addressed as `owner/name` or by numeric Woodpecker repo id. `get_pipeline` accepts `number: "latest"` (optionally with `branch`).

## Configuration

Instances are configured via environment variables, one URL/token pair per instance:

```bash
# Single instance (named "default"). WOODPECKER_SERVER (the official CLI var) also works.
WOODPECKER_URL=https://ci.example.com
WOODPECKER_TOKEN=<personal access token>

# Or one pair per instance; the name becomes the `instance` argument on every tool:
WOODPECKER_PROD_URL=https://ci.example.com
WOODPECKER_PROD_TOKEN=...
WOODPECKER_STAGING_URL=https://ci.staging.example
WOODPECKER_STAGING_TOKEN=...
```

Tokens come from `<server>/user/cli-and-api` on each Woodpecker instance.

The server also loads a `.env.woodpecker` file from its working directory if present (MCP clients launch stdio servers with the project as working directory). Only `WOODPECKER_*` variables are read from it, and real environment variables take precedence over file values. Keep each URL/token pair in one place: an instance whose URL comes from the file but whose token comes from the environment is refused, so a file in an untrusted checkout cannot send your token elsewhere.

A plain `http://` URL for a non-local instance works but logs a warning, since the token then travels unencrypted.

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

**The Inspector does not pass your shell environment to the server it launches.** Prefixing the command (`WOODPECKER_URL=… npx @modelcontextprotocol/inspector …`) or `export`ing beforehand sets the variable on the Inspector, not on this server, which then starts with no instances configured. Use one of:

- the `-e KEY=VALUE` flags shown above; note they go **after** `node dist/index.js`, not before;
- the **Environment Variables** fields in the Inspector's connection pane (then Connect / Restart);
- a `.env.woodpecker` file in the directory you launch from (the name is exact: a plain `.env` is not read).

Scripted checks work too, via the Inspector's CLI mode:

```bash
npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list
npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/call --tool-name list_instances
```

## Design notes

- **Read-only by contract.** Intended for reviewer agents; there is deliberately no restart/approve/cancel surface.
- **Log tailing.** Woodpecker returns a step's entire stored log in one response; `get_step_logs` tails (default 100 lines, max 2000) to protect the caller's context window, clips lines over 2000 characters and caps the tail at 100,000 characters. Exit-code entries are labelled `[exit code]`.
- **Untrusted content.** Logs, commit messages, PR titles and pipeline YAML are written by whoever pushed or opened the pull request, which on a public repository can be anyone. An agent reading them should treat them as data, not instructions; the tool descriptions say so too. `get_pipeline_config` returns the YAML verbatim, including anything written inline in it.
- **Tool annotations.** Every tool is advertised with `readOnlyHint: true`, so clients that support it can allow them without a confirmation prompt.
- **Slug resolution.** `owner/name` is resolved via `/api/repos/lookup/…` once and cached per process.
- **Sub-path hosting.** Instance base URLs may include a sub-path (`WOODPECKER_ROOT_PATH` installs).

## License

MIT: see [LICENSE](LICENSE).
