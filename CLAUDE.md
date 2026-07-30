# woodpecker-mcp

Read-only MCP stdio server exposing Woodpecker CI pipeline status and logs.
See [README.md](README.md) for usage; this file records the invariants that are
easy to break and not obvious from any single file.

## Invariants

- **Read-only by contract.** Only GET requests, and no restart/approve/cancel
  surface. Adding a write tool changes what this server is — don't, unless the
  request is explicitly to do so.
- **stdout belongs to the JSON-RPC protocol.** Never `console.log` /
  `process.stdout.write` anywhere reachable from the server: it corrupts the
  message stream. All human-readable output goes to stderr via `console.error`.
- **The token never leaves the Authorization header.** It must not appear in
  logs, error messages, or URLs. `client.ts` redacts it from relayed upstream
  error bodies; keep that when touching error paths.
- **Repo slugs are validated before use in a URL path.** `resolveRepoId`
  rejects empty, `.` and `..` segments — `encodeURIComponent` does not encode
  `.`, and `new URL()` collapses `../`, so loosening this reintroduces path
  traversal off the `/api/repos/lookup/` prefix.
- **Config failure modes are deliberate.** An incomplete *named* pair
  (`WOODPECKER_<NAME>_URL` without `_TOKEN`) warns and is skipped, because that
  pattern collides with real Woodpecker server/agent deployment variables. Only
  the unambiguous default pair fails loudly.

## Conventions

- ESM throughout. Relative imports use explicit `.ts` extensions (Node type
  stripping runs `src/` directly); the build rewrites them to `.js`.
- Erasable syntax only — no enums, no parameter properties.
- Tool input schemas are zod raw shapes. `list_instances` wraps its shape in
  `toleratesMissingArgs` so clients that omit `arguments` entirely still work;
  the advertised JSON schema is unchanged.
- Dependencies are pinned to exact versions. Bump them deliberately, and keep
  `npm audit --omit=dev --audit-level=high` clean — CI enforces it.
- **`@types/node` tracks the minimum supported runtime, not the newest Node.**
  `engines` says `>=20.12`, so the types stay on 20.x: typing against a newer
  major lets code compile that would crash on the version this package
  promises to support. (`process.loadEnvFile`, which needs 20.12, was exactly
  this bug once.) Dependabot is configured to ignore its majors — raise the
  floor in `engines` first if you want newer types.

## Working on this

```bash
npm run check   # typecheck
npm test        # vitest
npm run build   # emit dist/
```

Tests inject a fake `fetch` through `ToolContext.fetchImpl` — no network. Test
fixtures are deliberately generic (`acme/webapp`, `ci.example.com`); keep them
that way. To exercise the real server end to end, see
[.claude/skills/verify/SKILL.md](.claude/skills/verify/SKILL.md).
