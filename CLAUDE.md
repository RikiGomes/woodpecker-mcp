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

<!-- house-rules:start (synced from claude-dotfiles; edit there) -->
## House rules

These hold in every repo and every session, including Claude Code on the web.

- New work follows brainstorming, then a spec, then a plan, then execution (subagent-driven or inline), so design is agreed before code.
- Work on a feature branch. Never commit to or push `main` without the user's go-ahead, because several repos deploy from `main`.
- Confirm every push and every PR with the user first; the user decides when things merge.
- Commit messages are conventional commits (`feat:`, `fix:`, `chore:`, ...), unless this repo defines its own format, so history stays scannable.
- Verify task IDs, PR numbers, commit hashes and external facts with a tool before citing them, or leave them out, since one wrong reference undermines the rest.
- Reviewers run the tests themselves, because a review that didn't run the suite can't vouch for it.
- Report follow-up findings in the PR body instead of filing a ticket for each; the user decides what becomes a ticket. File one only when the work is genuinely separate, and say so to the user.
- Fix every warning in the files you touch, including pre-existing ones, so tech debt shrinks with each PR.
- Keep code comments rare and short, and put the reasoning in the PR body, so the diff stays clean.
- Prefer a written rule over enforcement tooling: no new guard scripts, hooks or lint wrappers unless asked, because each one is another failure mode.
- Look up library APIs with context7, the library's source or compiler errors. Never decompile binaries; the source is usually public.
- No em dashes in anything you write (code, comments, UI strings, docs, commits). Use a hyphen, colon, semicolon or full stop, because em dashes read as generated prose.
- Secrets never go in plaintext or in git. Token-bearing MCP servers start through `.claude/bin/with-secrets`, which reads Bitwarden Secrets Manager.
- Hosting is self-hosted Coolify or Cloudflare, never Vercel, so pick frameworks that run in a plain Docker image.
<!-- house-rules:end -->
