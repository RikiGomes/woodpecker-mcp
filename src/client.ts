import type { WoodpeckerInstance } from "./config.ts";

// Minimal typings for the Woodpecker v3 REST API (verified against the
// v3.19.0 server source). Only the fields this server reads are declared.

export interface Repo {
  id: number;
  full_name?: string;
  default_branch?: string;
  forge_url?: string;
  active?: boolean;
  org_id?: number;
}

export interface PipelineError {
  type?: string;
  message?: string;
  is_warning?: boolean;
}

export interface Step {
  /** Global step id; this is the id the logs endpoint expects. */
  id: number;
  name?: string;
  state?: string;
  exit_code?: number;
  error?: string;
  type?: string;
  started?: number;
  finished?: number;
}

export interface Workflow {
  id: number;
  name?: string;
  state?: string;
  error?: string;
  started?: number;
  finished?: number;
  children?: Step[];
}

export interface Pipeline {
  id: number;
  /** Per-repo pipeline number, used in URLs, distinct from the global id. */
  number: number;
  status?: string;
  event?: string;
  branch?: string;
  message?: string;
  title?: string;
  ref?: string;
  commit?: string;
  author?: string;
  created?: number;
  started?: number;
  finished?: number;
  errors?: PipelineError[];
  forge_url?: string;
  from_fork?: boolean;
  /** Login of whoever approved or declined a blocked pipeline. */
  reviewed_by?: string;
  /** Manual or cron variables; a restart copies them into the new pipeline. */
  variables?: Record<string, string> | null;
  /** Only populated by the single-pipeline endpoint, not the list endpoint. */
  workflows?: Workflow[];
}

export interface LogEntry {
  id?: number;
  step_id?: number;
  time?: number;
  line?: number;
  /** Base64-encoded log line bytes (Go []byte JSON marshalling). */
  data?: string | null;
  /** 0=stdout, 1=stderr, 2=exit_code, 3=metadata, 4=progress */
  type?: number;
}

export interface User {
  login?: string;
  admin?: boolean;
}

export interface FeedEntry {
  repo_id: number;
  full_name?: string;
  number?: number;
  event?: string;
  status?: string;
  branch?: string;
  ref?: string;
  title?: string;
  message?: string;
  commit?: string;
  author?: string;
  created?: number;
  started?: number;
  finished?: number;
}

export interface PullRequest {
  index?: number | string;
  title?: string;
}

export interface PipelineConfig {
  name?: string;
  hash?: string;
  /** Base64-encoded file bytes (Go []byte JSON marshalling). */
  data?: string | null;
}

export interface Cron {
  id: number;
  name?: string;
  schedule?: string;
  timezone?: string;
  branch?: string;
  enabled?: boolean;
  next_exec?: number;
  variables?: Record<string, string> | null;
}

export interface Secret {
  name?: string;
  events?: string[] | null;
  images?: string[] | null;
  note?: string;
}

export interface Agent {
  id: number;
  name?: string;
  platform?: string;
  backend?: string;
  capacity?: number;
  version?: string;
  no_schedule?: boolean;
  last_contact?: number;
  last_work?: number;
  org_id?: number;
}

export interface QueueTask {
  id?: string;
  name?: string;
  repo_id?: number;
  pipeline_number?: number;
  agent_name?: string;
  labels?: Record<string, string> | null;
}

export interface QueueInfo {
  pending?: QueueTask[] | null;
  waiting_on_deps?: QueueTask[] | null;
  running?: QueueTask[] | null;
  stats?: {
    worker_count?: number;
    pending_count?: number;
    waiting_on_deps_count?: number;
    running_count?: number;
  };
  paused?: boolean;
}

export interface PageOptions {
  page?: number;
  perPage?: number;
}

export interface PipelineFilters {
  branch?: string;
  event?: string;
  status?: string;
  page?: number;
  perPage?: number;
}

export class WoodpeckerApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "WoodpeckerApiError";
    this.status = status;
  }
}

const REQUEST_TIMEOUT_MS = 30_000;
// Woodpecker returns a step's whole log in one body; a hostile or misconfigured
// server must not be able to exhaust memory.
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

/**
 * Reads a body as UTF-8. Past `maxBytes` it stops reading and returns
 * undefined, or with `truncate` the first `maxBytes`.
 */
async function readCapped(response: Response, maxBytes: number, truncate = false): Promise<string | undefined> {
  if (!response.body) return "";
  const declared = Number(response.headers.get("content-length"));
  if (!truncate && declared > maxBytes) {
    await response.body.cancel().catch(() => {});
    return undefined;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return truncate ? Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8") : undefined;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class WoodpeckerClient {
  readonly instance: WoodpeckerInstance;
  private readonly fetchImpl: typeof fetch;
  private readonly repoIdCache = new Map<string, number>();

  constructor(instance: WoodpeckerInstance, fetchImpl: typeof fetch = fetch) {
    this.instance = instance;
    this.fetchImpl = fetchImpl;
  }

  /**
   * Accepts either a numeric Woodpecker repo id or an `owner/name` slug.
   * Slugs are resolved via the lookup endpoint once and cached for the
   * lifetime of the server process.
   */
  async resolveRepoId(repo: string): Promise<number> {
    const trimmed = repo.trim().replace(/^\/+|\/+$/g, "");
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    if (!trimmed.includes("/")) {
      throw new WoodpeckerApiError(
        `Invalid repo "${repo}": pass a numeric Woodpecker repo id or an "owner/name" slug.`,
      );
    }
    // Reject empty, "." and ".." path segments: encodeURIComponent leaves "."
    // untouched and new URL() collapses "../", so an unchecked slug could walk
    // the authenticated GET off the /api/repos/lookup/ prefix to any path on
    // the instance. Legitimate nested names (GitLab subgroups) still pass.
    const segments = trimmed.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new WoodpeckerApiError(
        `Invalid repo "${repo}": "owner/name" slug segments may not be empty, "." or "..".`,
      );
    }
    const cached = this.repoIdCache.get(trimmed);
    if (cached !== undefined) return cached;
    const path = trimmed.split("/").map(encodeURIComponent).join("/");
    const found = await this.get<Repo>(`/api/repos/lookup/${path}`);
    this.repoIdCache.set(trimmed, found.id);
    return found.id;
  }

  currentUser(): Promise<User> {
    return this.get<User>("/api/user");
  }

  listRepos(all = false): Promise<Repo[]> {
    return this.get<Repo[]>("/api/user/repos", all ? { all: "true" } : undefined);
  }

  feed(): Promise<FeedEntry[] | null> {
    return this.get<FeedEntry[] | null>("/api/user/feed");
  }

  getRepo(repoId: number): Promise<Repo> {
    return this.get<Repo>(`/api/repos/${repoId}`);
  }

  listPipelines(repoId: number, filters: PipelineFilters = {}): Promise<Pipeline[]> {
    return this.get<Pipeline[]>(`/api/repos/${repoId}/pipelines`, {
      branch: filters.branch,
      event: filters.event,
      status: filters.status,
      page: filters.page,
      perPage: filters.perPage,
    });
  }

  /** `number` may be a per-repo pipeline number or "latest" (default branch, or `branch` when given). */
  getPipeline(repoId: number, number: number | "latest", branch?: string): Promise<Pipeline> {
    return this.get<Pipeline>(
      `/api/repos/${repoId}/pipelines/${number}`,
      number === "latest" ? { branch } : undefined,
    );
  }

  listBranches(repoId: number, paging: PageOptions = {}): Promise<string[] | null> {
    return this.get<string[] | null>(`/api/repos/${repoId}/branches`, { ...paging });
  }

  listPullRequests(repoId: number, paging: PageOptions = {}): Promise<PullRequest[] | null> {
    return this.get<PullRequest[] | null>(`/api/repos/${repoId}/pull_requests`, { ...paging });
  }

  getPipelineConfig(repoId: number, pipelineNumber: number): Promise<PipelineConfig[] | null> {
    return this.get<PipelineConfig[] | null>(`/api/repos/${repoId}/pipelines/${pipelineNumber}/config`);
  }

  listCrons(repoId: number): Promise<Cron[] | null> {
    return this.get<Cron[] | null>(`/api/repos/${repoId}/cron`);
  }

  listSecrets(repoId: number): Promise<Secret[] | null> {
    return this.get<Secret[] | null>(`/api/repos/${repoId}/secrets`);
  }

  listOrgSecrets(orgId: number): Promise<Secret[] | null> {
    return this.get<Secret[] | null>(`/api/orgs/${orgId}/secrets`);
  }

  listGlobalSecrets(): Promise<Secret[] | null> {
    return this.get<Secret[] | null>("/api/secrets");
  }

  listAgents(): Promise<Agent[] | null> {
    return this.get<Agent[] | null>("/api/agents");
  }

  queueInfo(): Promise<QueueInfo> {
    return this.get<QueueInfo>("/api/queue/info");
  }

  getStepLogs(repoId: number, pipelineNumber: number, stepId: number): Promise<LogEntry[]> {
    return this.get<LogEntry[]>(`/api/repos/${repoId}/logs/${pipelineNumber}/${stepId}`);
  }

  /**
   * Restarts a finished pipeline as a new one. Deliberately sends no query
   * string: Woodpecker turns `event`/`deploy_to` into a deployment and every
   * other parameter into an environment variable of the new pipeline.
   */
  restartPipeline(repoId: number, pipelineNumber: number): Promise<Pipeline> {
    return this.request<Pipeline>("POST", `/api/repos/${repoId}/pipelines/${pipelineNumber}`);
  }

  /** Woodpecker answers 204 with no body. */
  async cancelPipeline(repoId: number, pipelineNumber: number): Promise<void> {
    await this.request<unknown>("POST", `/api/repos/${repoId}/pipelines/${pipelineNumber}/cancel`);
  }

  /** Woodpecker UI link for a pipeline, handy for humans reading agent output. */
  pipelineUrl(repoId: number, pipelineNumber: number | "latest"): string {
    return `${this.instance.url}/repos/${repoId}/pipeline/${pipelineNumber}`;
  }

  private get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    return this.request<T>("GET", path, query);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    // Concatenate instead of `new URL(path, base)` so instances hosted under a
    // sub-path (WOODPECKER_ROOT_PATH) keep their prefix.
    const url = new URL(this.instance.url + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${this.instance.token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      const reason = cause instanceof Error ? (cause.cause ?? cause) : cause;
      throw new WoodpeckerApiError(
        `Request to instance "${this.instance.name}" (${url.origin}) failed: ${reason instanceof Error ? reason.message : String(reason)}` +
          (method === "GET" ? "" : `. The ${method} may still have been applied; check the pipeline before retrying.`),
      );
    }

    if (!response.ok) {
      const raw = (await readCapped(response, 4096, true).catch(() => "")) ?? "";
      // Defence in depth: never relay the bearer token to the MCP client, even
      // if a misconfigured proxy/server echoes the Authorization header back.
      // Redact before truncating so a token cut at the boundary cannot leak.
      const body = (this.instance.token ? raw.split(this.instance.token).join("[redacted]") : raw).slice(0, 300);
      throw new WoodpeckerApiError(
        `${this.instance.name}: ${method} ${url.pathname} returned HTTP ${response.status}${body ? `: ${body}` : ""}`,
        response.status,
      );
    }
    let text: string | undefined;
    try {
      text = await readCapped(response, MAX_RESPONSE_BYTES);
    } catch (cause) {
      throw new WoodpeckerApiError(
        `${this.instance.name}: ${method} ${url.pathname} failed while reading the response: ${cause instanceof Error ? cause.message : String(cause)}`,
        response.status,
      );
    }
    if (text === undefined) {
      throw new WoodpeckerApiError(
        `${this.instance.name}: ${method} ${url.pathname} returned more than ${MAX_RESPONSE_BYTES / 1024 / 1024} MB; refusing to load it.`,
        response.status,
      );
    }
    if (method !== "GET" && text.trim() === "") return undefined as T;
    try {
      return JSON.parse(text.replace(/^\uFEFF/, "")) as T;
    } catch {
      // e.g. a reverse proxy answering 200 with an HTML error/login page.
      throw new WoodpeckerApiError(
        `${this.instance.name}: ${method} ${url.pathname} returned a non-JSON response body ` +
          `(is ${url.origin} really a Woodpecker server?)`,
        response.status,
      );
    }
  }
}
