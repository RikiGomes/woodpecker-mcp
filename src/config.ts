import { existsSync } from "node:fs";

export interface WoodpeckerInstance {
  /** Short identifier used as the `instance` argument on every tool. */
  name: string;
  /** Base URL of the Woodpecker server, without trailing slash. */
  url: string;
  /** Personal access token (from <server>/user → API token). */
  token: string;
}

const NAMED_VAR = /^WOODPECKER_([A-Z0-9_]+)_(URL|TOKEN)$/;

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
export function loadInstances(env: Record<string, string | undefined>): WoodpeckerInstance[] {
  const partial = new Map<string, { url?: string; token?: string }>();

  const upsert = (name: string, field: "url" | "token", value: string) => {
    const entry = partial.get(name) ?? {};
    entry[field] = value;
    partial.set(name, entry);
  };

  // WOODPECKER_URL deterministically beats WOODPECKER_SERVER (the official
  // CLI variable) instead of depending on env iteration order.
  const defaultUrl = env.WOODPECKER_URL || env.WOODPECKER_SERVER;
  if (defaultUrl) upsert("default", "url", defaultUrl);
  if (env.WOODPECKER_TOKEN) upsert("default", "token", env.WOODPECKER_TOKEN);

  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    const match = NAMED_VAR.exec(key);
    if (match) {
      const [, rawName, field] = match;
      upsert(rawName!.toLowerCase(), field === "URL" ? "url" : "token", value);
    }
  }

  const instances: WoodpeckerInstance[] = [];
  for (const [name, entry] of partial) {
    if (entry.url && entry.token) {
      const url = entry.url.replace(/\/+$/, "");
      const envName = name === "default" ? "WOODPECKER" : `WOODPECKER_${name.toUpperCase()}`;
      try {
        new URL(url);
      } catch {
        throw new Error(
          `Invalid URL for Woodpecker instance "${name}": "${entry.url}" (from ${envName}_URL). ` +
            "Expected a full base URL like https://ci.example.com.",
        );
      }
      instances.push({ name, url, token: entry.token });
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
        `woodpecker-mcp: ignoring ${present} — no matching ${missing}. ` +
          "(Harmless if the variable belongs to a Woodpecker server/agent deployment; " +
          "set both halves of the pair to configure it as an MCP instance.)",
      );
    }
  }

  instances.sort((a, b) => a.name.localeCompare(b.name));
  return instances;
}

/**
 * Loads a dotenv-style file into `process.env` if it exists, without ever
 * crashing the server: `process.loadEnvFile` only exists from Node 20.12, and
 * an unreadable file (e.g. a directory of the same name) throws. Both cases
 * degrade to a stderr warning. Existing environment variables keep precedence
 * over file values (Node --env-file semantics).
 */
export function loadEnvFileIfPresent(
  path: string,
  loader?: (path?: string) => void,
): void {
  if (!existsSync(path)) return;
  const load = loader ?? (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (typeof load !== "function") {
    console.error(
      `woodpecker-mcp: skipping ${path} — process.loadEnvFile needs Node >= 20.12 ` +
        `(running ${process.version}).`,
    );
    return;
  }
  try {
    load(path);
  } catch (error) {
    console.error(
      `woodpecker-mcp: failed to load ${path}: ${error instanceof Error ? error.message : String(error)} ` +
        "— continuing with the process environment only.",
    );
  }
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
