# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/RikiGomes/woodpecker-mcp/security/advisories/new)
rather than in a public issue. Include the affected version or commit, steps to
reproduce, and the impact you see.

## Scope

woodpecker-mcp is a read-mostly MCP server whose only writes are a guarded
pipeline restart and cancel. Issues of particular interest:

- the Woodpecker token leaking anywhere other than the `Authorization` header
  (logs, error messages, URLs, tool output);
- a tool returning secret values, cron variable values or agent tokens;
- a request reaching a path or method other than the intended GET endpoints
  and the restart/cancel POSTs (for example via repo slug or parameter
  injection);
- a write tool getting past its guards: acting on a deployment, tag or
  release pipeline, a repo outside `WRITE_REPOS`, or a pipeline that skipped
  approval;
- anything written to stdout that is not JSON-RPC.

Only the latest commit on `main` is supported.
