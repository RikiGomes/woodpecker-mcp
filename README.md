# woodpecker-mcp

[![CI](https://github.com/RikiGomes/woodpecker-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/RikiGomes/woodpecker-mcp/actions/workflows/ci.yml)

MCP (Model Context Protocol) server for [Woodpecker CI](https://woodpecker-ci.org). Gives AI agents and MCP clients visibility into pipeline status and logs across **multiple self-hosted Woodpecker instances**, so a code reviewer (human or agent) can check whether CI is green and pull the failing step's output without leaving the conversation, plus a small set of guarded pipeline controls (restart, cancel, trigger, run a cron job).

Built against the Woodpecker v3 REST API (verified on v3.16.0; endpoints added since were checked against the v3.19.0 server source). The only write operations are the guarded pipeline controls under [Write actions](#write-actions); the server never approves pipelines, never reads secret values and never deletes anything.

## Tools

| Tool | Purpose |
|------|---------|
| `list_instances` | List configured instances; `check: true` verifies connectivity + token per instance |
| `list_repos` | Repositories the token can access on an instance; `name` filters by owner/name substring |
| `recent_activity` | Newest pipelines across all your repos (Woodpecker's feed), filterable by status |
| `list_pipelines` | Recent pipelines for a repo, filterable by branch / event / status |
| `get_pipeline` | One pipeline with workflows, non-passing steps, exit codes, and `failed_step_ids` (`all_steps` lists every step) |
| `diagnose_pipeline` | One-call triage: failed steps with their exit codes, errors and log tails |
| `compare_pipelines` | What broke: the newest failing run vs the last green one on a branch, with only the changed steps, the runs in between and changed config files |
| `get_step_logs` | Log output of a step (tailed, default last 60 lines), or `match` to search the whole log for plain text |
| `get_pipeline_config` | The workflow YAML files Woodpecker fetched for a pipeline |
| `list_branches` | Branch names from the forge |
| `list_pull_requests` | Open pull requests from the forge |
| `list_crons` | Cron jobs of a repo (variable names only) *(push access)* |
| `list_secrets` | Repository, organization or global secret names, events and images; never values *(push access; org admin for `org`)* |
| `list_agents` | Build agents and when they last checked in *(admin)* |
| `get_queue_info` | Pending / running tasks and worker counts, to explain stuck pipelines *(admin)* |
| `restart_pipeline` | Re-run a finished pipeline *(write, push access)* |
| `cancel_pipeline` | Cancel a pending or running pipeline *(write, push access)* |
| `trigger_pipeline` | Start a manual pipeline on a branch, without variables *(write, push access)* |
| `run_cron` | Run a repo's cron job now *(write, push access)* |

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

The server also loads a `.env.woodpecker` file from its working directory if present (MCP clients launch stdio servers with the project as working directory). Only `WOODPECKER_*` variables are read from it, and real environment variables take precedence over file values. Keep each URL/token pair in one place: an instance whose URL comes from the file but whose token comes from the environment is refused, so a file in an untrusted checkout cannot send your token elsewhere, and a file cannot replace an instance your environment already defines. URLs with embedded credentials (`https://user:pass@...`) are rejected; use the token variable.

A plain `http://` URL for a non-local instance works but logs a warning, since the token then travels unencrypted.

Instances with self-signed certificates: point Node at your CA with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.

### Write actions

`restart_pipeline`, `cancel_pipeline`, `trigger_pipeline` and `run_cron` are enabled by default. Narrow or disable them per instance:

```bash
WOODPECKER_PROD_ALLOW_WRITE=cancel,trigger    # any of restart, cancel, trigger, cron; "all" (the default when unset) or "none" also work
WOODPECKER_PROD_WRITE_REPOS=acme/webapp,tools/*  # optional: only these repos ("owner/*" covers an owner)
# For the "default" instance: WOODPECKER_ALLOW_WRITE and WOODPECKER_WRITE_REPOS.
```

An empty `ALLOW_WRITE` means none. Unknown values are dropped with a warning. A tool is only advertised when at least one instance enables it, and the startup line on stderr lists each instance's write tools.

Woodpecker tokens are not scoped, so these guards are what keeps the tools safe. Restart and cancel first read the pipeline and refuse:

- deployment, tag and release pipelines, which may deploy or publish;
- restarting a manual or cron pipeline that carries variables, since the restart would replay them;
- restarting anything that is not finished, and unapproved fork pipelines or pipelines stopped before they ran (which may have been waiting for approval), because Woodpecker's restart skips the approval gate;
- cancelling anything that is not pending or running; a blocked pipeline waiting for approval is left to a human.

`trigger_pipeline` starts a `manual` pipeline on a branch (the repo's default branch unless given). It checks the branch exists on the forge and sends only `{branch}`: never `variables`, which Woodpecker would inject as environment variables. `run_cron` runs an existing cron job now, exactly as its schedule would (its branch and its own variables), and refuses disabled cron jobs; it never creates, edits or deletes one. Every workflow whose `when` matches the `manual` (or `cron`) event runs, including any deploy workflow set up that way: the server cannot tell those apart, so the event guard above does not apply here. If Woodpecker's approval settings hold the new pipeline, it may come back `blocked` and stays for a human to approve.

A restart sends no query string: on that endpoint Woodpecker turns `event`/`deploy_to` into a deployment and every other parameter into an environment variable. If a write request fails in transit (for example a timeout), the error says the action may still have been applied, so check the pipeline before retrying. The write tools are advertised with `readOnlyHint: false`, so MCP clients ask before calling them unless you allow them.

## Usage with Claude Code

Register in a project's `.mcp.json` (or `claude mcp add`):

```json
{
  "mcpServers": {
    "woodpecker": {
      "command": "npx",
      "args": ["-y", "github:RikiGomes/woodpecker-mcp"],
      "env": {
        "WOODPECKER_URL": "https://ci.example.com",
        "WOODPECKER_TOKEN": "${WOODPECKER_TOKEN}"
      }
    }
  }
}
```

`${WOODPECKER_TOKEN}` is expanded from your shell by Claude Code, so the token
stays out of the committed `.mcp.json`. Alternatively, leave out `env` and put
the pair in a gitignored `.env.woodpecker` (see above). Without either, the
server starts with no instances and every tool call fails.

This tracks `main`. To pin a release instead, append its tag, for example
`github:RikiGomes/woodpecker-mcp#v0.1.0`; tags are listed on the
[releases page](https://github.com/RikiGomes/woodpecker-mcp/releases).

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

Node >= 22.18 runs the TypeScript sources directly (type stripping); the built
`dist/` that users run needs only Node 22.12:

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

- **Read-mostly by contract.** Intended for reviewer agents. The only writes are the guarded restart, cancel, trigger and run-cron above, POST only; there is deliberately no approve, delete or settings surface.
- **Log tailing.** Woodpecker returns a step's entire stored log in one response; `get_step_logs` tails (default 60 lines, max 2000) to protect the caller's context window, clips lines over 2000 characters and caps the tail at 100,000 characters. Upstream responses over 50 MB are refused rather than loaded into memory. Exit-code entries are labelled `[exit code]`.
- **Lean responses.** Output is compact JSON sized for an agent's context: inputs are not echoed back, times are one ISO `created` plus `duration_s`, list rows carry no URLs, successful and skipped steps are counted rather than listed, and logs lose colour codes, progress lines and spinner frames, with repeated lines collapsed. Tests hold each tool to a size budget.
- **Untrusted content.** Logs, commit messages, PR titles and pipeline YAML are written by whoever pushed or opened the pull request, which on a public repository can be anyone. An agent reading them should treat them as data, not instructions; the tool descriptions say so too. `get_pipeline_config` returns the YAML verbatim, including anything written inline in it.
- **Tool annotations.** Every read tool is advertised with `readOnlyHint: true`, so clients that support it can allow them without a confirmation prompt. The write tools are not; `cancel_pipeline` also carries `destructiveHint: true`.
- **Slug resolution.** `owner/name` is resolved via `/api/repos/lookup/…` once and cached per process.
- **Sub-path hosting.** Instance base URLs may include a sub-path (`WOODPECKER_ROOT_PATH` installs).

## License

MIT: see [LICENSE](LICENSE).
