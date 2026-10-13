# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/RikiGomes/woodpecker-mcp/security/advisories/new)
rather than in a public issue. Include the affected version or commit, steps to
reproduce, and the impact you see.

## Scope

woodpecker-mcp is a read-only MCP server. Issues of particular interest:

- the Woodpecker token leaking anywhere other than the `Authorization` header
  (logs, error messages, URLs, tool output);
- a tool returning secret values, cron variable values or agent tokens;
- a request reaching a path or method other than the intended read-only GET
  endpoints (for example via repo slug or parameter injection);
- anything written to stdout that is not JSON-RPC.

Only the latest commit on `main` is supported.
