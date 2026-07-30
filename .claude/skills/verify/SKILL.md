---
name: verify
description: Verify woodpecker-mcp changes end-to-end by driving the built stdio MCP server with raw JSON-RPC.
---

# Verifying woodpecker-mcp

The surface is a stdio MCP server. Build, then pipe newline-delimited JSON-RPC
into the real bin entry and read stdout (protocol) / stderr (status + warnings).

```bash
npm run build   # tsc → dist/

# Handshake first, then calls; one JSON object per line:
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_instances"}}' \
  | env WOODPECKER_URL=https://ci.example.com WOODPECKER_TOKEN=tok node dist/index.js
```

Flows worth driving:
- Config edge cases: set env pairs (`WOODPECKER_<NAME>_URL/_TOKEN`) and watch
  stderr — incomplete named pairs warn, incomplete/malformed default pair exits 1.
- Tool behavior against a fake Woodpecker: a throwaway
  `node http.createServer` on 127.0.0.1 works fine as `WOODPECKER_URL`
  (e.g. return HTML with status 200 to exercise the non-JSON body path).
- `tools/list` output shows the advertised JSON schemas — check them after
  touching `inputSchema` definitions.

Gotchas:
- The server keeps running after the piped stdin closes; give it `sleep 1`
  after the last message and kill it, or `tail -1` the captured stdout.
- stdout is protocol-only; all human-readable status goes to stderr.
- `.env.woodpecker` is loaded from the *working directory* — run from a
  temp dir to test that path.
