import { existsSync, readFileSync } from "node:fs";
import * as util from "node:util";

export interface WoodpeckerInstance {
  /** Short identifier used as the `instance` argument on every tool. */
  name: string;
  /** Base URL of the Woodpecker server, without trailing slash. */
  url: string;
  /** Personal access token (from <server>/user → API token). */
  token: string;
  /** Write tools enabled on this instance; undefined means all of them. */
  writes?: readonly WriteAction[];
  /** `owner/name` or `owner/*` patterns the write tools may touch; undefined means any repo. */
  writeRepos?: readonly string[];
}

export const WRITE_ACTIONS = ["restart", "cancel", "trigger", "cron"] as const;
export type WriteAction = (typeof WRITE_ACTIONS)[number];

const isWriteAction = (value: string): value is WriteAction => (WRITE_ACTIONS as readonly string[]).includes(value);

/**
 * Parses `<PREFIX>_ALLOW_WRITE`: unset means every write tool, `none` or an
 * empty value means none, otherwise a comma list (`all` allowed). Unknown
 * words are dropped with a warning, which only ever narrows the set.
 */
function parseAllowWrite(key: string, raw: string | undefined): WriteAction[] {
  if (raw === undefined) return [...WRITE_ACTIONS];
  const words = raw.split(",").map((word) => word.trim().toLowerCase()).filter(Boolean);
  if (words.includes("all")) return [...WRITE_ACTIONS];
  const unknown = words.filter((word) => word !== "none" && !isWriteAction(word));
  if (unknown.length) {
    console.error(
      `woodpecker-mcp: ${key} has unknown value(s) ${unknown.join(", ")}; ` +
        `expected all, none or a list of ${WRITE_ACTIONS.join(", ")}.`,
    );
  }
  return WRITE_ACTIONS.filter((action) => words.includes(action));
}

function parseWriteRepos(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw.split(",").map((pattern) => pattern.trim().toLowerCase().replace(/^\/+|\/+$/g, "")).filter(Boolean);
}

/** Whether `fullName` matches one of the `owner/name`, `owner/*` or `*` patterns, case-insensitively. */
export function repoAllowed(patterns: readonly string[] | undefined, fullName: string): boolean {
  if (patterns === undefined) return true;
  const name = fullName.toLowerCase();
  return patterns.some((pattern) =>
    pattern === "*" || (pattern.endsWith("/*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern),
  );
}

const NAMED_VAR = /^WOODPECKER_([A-Z0-9_]+)_(URL|TOKEN)$/;
const isLoopback = (host: string) => host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);

/**
 * Builds the instance registry from environment variables.
 *
 * Two shapes are accepted:
 * - `WOODPECKER_URL` + `WOODPECKER_TOKEN` (or `WOODPECKER_SERVER`, the
 *   variable the official Woodpecker CLI uses) → instance named "default".
 * - `WOODPECKER_<NAME>_URL` + `WOODPECKER_<NAME>_TOKEN` → instance named
 *   `<name>` (lowercased), one pair per self-hosted instance.
 *
 * An incomplete default pair is unambiguous and throws, so the server fails
 * loudly at startup instead of at first use. An incomplete *named* pair is
 * only skipped with a stderr warning: `WOODPECKER_<NAME>_URL` collides with
 * real Woodpecker server/agent deployment variables (WOODPECKER_GITHUB_URL,
 * WOODPECKER_EXPERT_FORGE_OAUTH_URL, …) that legitimately appear without a
 * matching token in a shared environment.
 */
export function loadInstances(
  env: Record<string, string | undefined>,
  fileKeys: ReadonlySet<string> = new Set(),
): WoodpeckerInstance[] {
  const partial = new Map<string, { url?: string; token?: string; urlKey?: string; tokenKey?: string }>();

  const upsert = (name: string, field: "url" | "token", value: string, key: string) => {
    const entry = partial.get(name) ?? {};
    const existing = entry[field === "url" ? "urlKey" : "tokenKey"];
    // e.g. WOODPECKER_DEFAULT_URL from the file vs WOODPECKER_URL from the
    // environment: the environment wins, so a file cannot replace an instance.
    if (existing && fileKeys.has(key) && !fileKeys.has(existing)) {
      console.error(`woodpecker-mcp: ignoring ${key} from .env.woodpecker: ${existing} already sets it.`);
      return;
    }
    entry[field] = value;
    entry[field === "url" ? "urlKey" : "tokenKey"] = key;
    partial.set(name, entry);
  };

  // WOODPECKER_URL deterministically beats WOODPECKER_SERVER (the official
  // CLI variable) instead of depending on env iteration order, unless only
  // WOODPECKER_SERVER comes from the real environment.
  const urlKeys = (["WOODPECKER_URL", "WOODPECKER_SERVER"] as const).filter((key) => env[key]);
  const defaultUrlKey = urlKeys.find((key) => !fileKeys.has(key)) ?? urlKeys[0] ?? "WOODPECKER_URL";
  const defaultUrl = env[defaultUrlKey];
  if (defaultUrl) upsert("default", "url", defaultUrl, defaultUrlKey);
  if (env.WOODPECKER_TOKEN) upsert("default", "token", env.WOODPECKER_TOKEN, "WOODPECKER_TOKEN");

  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    const match = NAMED_VAR.exec(key);
    if (match) {
      const [, rawName, field] = match;
      upsert(rawName!.toLowerCase(), field === "URL" ? "url" : "token", value, key);
    }
  }

  const instances: WoodpeckerInstance[] = [];
  for (const [name, entry] of partial) {
    if (entry.url && entry.token) {
      const url = entry.url.replace(/\/+$/, "");
      const envName = name === "default" ? "WOODPECKER" : `WOODPECKER_${name.toUpperCase()}`;
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(
          `Invalid URL for Woodpecker instance "${name}" (from ${entry.urlKey}). ` +
            "Expected a full base URL like https://ci.example.com.",
        );
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error(
          `Invalid URL for Woodpecker instance "${name}" (from ${entry.urlKey}): ` +
            "expected an http(s) base URL like https://ci.example.com.",
        );
      }
      if (parsed.username || parsed.password) {
        throw new Error(
          `Woodpecker instance "${name}" (${envName}_URL) has credentials in its URL; ` +
            "remove them and use the token variable instead.",
        );
      }
      // A .env.woodpecker in an untrusted checkout must not redirect a token
      // that came from the real environment to a URL of its choosing.
      if (fileKeys.has(entry.urlKey!) && !fileKeys.has(entry.tokenKey!)) {
        const message =
          `${entry.urlKey} comes from .env.woodpecker but ${entry.tokenKey} ` +
          "from the process environment; set both in the same place.";
        if (name === "default") throw new Error(`Refusing Woodpecker instance "default": ${message}`);
        console.error(`woodpecker-mcp: ignoring instance "${name}": ${message}`);
        continue;
      }
      if (parsed.protocol === "http:" && !isLoopback(parsed.hostname)) {
        console.error(
          `woodpecker-mcp: instance "${name}" uses plain http (${parsed.origin}); its token is sent unencrypted.`,
        );
      }
      const writes = parseAllowWrite(`${envName}_ALLOW_WRITE`, env[`${envName}_ALLOW_WRITE`]);
      const writeRepos = parseWriteRepos(env[`${envName}_WRITE_REPOS`]);
      instances.push({ name, url, token: entry.token, writes, ...(writeRepos ? { writeRepos } : {}) });
    } else if (name === "default") {
      throw new Error(
        `Incomplete Woodpecker instance configuration: "default" is missing ` +
          `${entry.url ? "WOODPECKER_TOKEN" : "WOODPECKER_URL"}. ` +
          "The default instance needs both WOODPECKER_URL and WOODPECKER_TOKEN.",
      );
    } else {
      const envName = `WOODPECKER_${name.toUpperCase()}`;
      const present = entry.url ? `${envName}_URL` : `${envName}_TOKEN`;
      const missing = entry.url ? `${envName}_TOKEN` : `${envName}_URL`;
      console.error(
        `woodpecker-mcp: ignoring ${present}: no matching ${missing}. ` +
          "(Harmless if the variable belongs to a Woodpecker server/agent deployment; " +
          "set both halves of the pair to configure it as an MCP instance.)",
      );
    }
  }

  instances.sort((a, b) => a.name.localeCompare(b.name));
  return instances;
}

/**
 * Loads the `WOODPECKER_*` variables of a dotenv-style file into `process.env`
 * if it exists, without ever crashing the server. Other keys are ignored: a
 * file in an untrusted checkout must not set e.g. NODE_TLS_REJECT_UNAUTHORIZED
 * or a proxy. Existing environment variables keep precedence over file values.
 * An unreadable or malformed file degrades to a stderr warning. Returns the variable names the file set,
 * so loadInstances can tell where each half of a pair came from.
 */
export function loadEnvFileIfPresent(
  path: string,
  parse: (content: string) => Record<string, string | undefined> = util.parseEnv,
): Set<string> {
  const added = new Set<string>();
  if (!existsSync(path)) return added;
  let parsed: Record<string, string | undefined>;
  try {
    parsed = parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(
      `woodpecker-mcp: failed to load ${path}: ${error instanceof Error ? error.message : String(error)}; ` +
        "continuing with the process environment only.",
    );
    return added;
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!key.startsWith("WOODPECKER_") || value === undefined || process.env[key] !== undefined) continue;
    process.env[key] = value;
    added.add(key);
  }
  return added;
}

/** Case-insensitive instance lookup with a helpful error for typos. */
export function findInstance(instances: WoodpeckerInstance[], name: string): WoodpeckerInstance {
  if (instances.length === 0) {
    throw new Error(
      "No Woodpecker instances are configured. Set WOODPECKER_URL + WOODPECKER_TOKEN " +
        "(single instance) or WOODPECKER_<NAME>_URL + WOODPECKER_<NAME>_TOKEN pairs, " +
        "then restart the MCP server.",
    );
  }
  const wanted = name.toLowerCase();
  const found = instances.find((i) => i.name === wanted);
  if (!found) {
    throw new Error(
      `Unknown Woodpecker instance "${name}". Configured instances: ${instances.map((i) => i.name).join(", ")}.`,
    );
  }
  return found;
}
