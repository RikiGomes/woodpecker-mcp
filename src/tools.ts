import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findInstance, type WoodpeckerInstance } from "./config.ts";
import { WoodpeckerClient, type Pipeline, type Step, type Workflow } from "./client.ts";
import { renderStepLogs } from "./logs.ts";

export interface ToolContext {
  instances: WoodpeckerInstance[];
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

const FAILED_STATES = new Set(["failure", "error", "killed"]);

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(payload: unknown): ToolResult {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 1);
  return { content: [{ type: "text", text }] };
}

async function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

const isoTime = (unixSeconds?: number): string | undefined =>
  unixSeconds && unixSeconds > 0 ? new Date(unixSeconds * 1000).toISOString() : undefined;

function pipelineSummary(pipeline: Pipeline) {
  return {
    number: pipeline.number,
    status: pipeline.status,
    event: pipeline.event,
    branch: pipeline.branch,
    message: pipeline.message?.split("\n", 1)[0],
    commit: pipeline.commit?.slice(0, 10),
    author: pipeline.author,
    created: isoTime(pipeline.created),
    started: isoTime(pipeline.started),
    finished: isoTime(pipeline.finished),
    errors: pipeline.errors?.length ? pipeline.errors : undefined,
  };
}

function stepSummary(step: Step) {
  return {
    id: step.id,
    name: step.name,
    state: step.state,
    exit_code: step.exit_code,
    type: step.type,
    error: step.error || undefined,
  };
}

function workflowSummary(workflow: Workflow) {
  return {
    name: workflow.name,
    state: workflow.state,
    error: workflow.error || undefined,
    started: isoTime(workflow.started),
    finished: isoTime(workflow.finished),
    steps: (workflow.children ?? []).map(stepSummary),
  };
}

function failedStepIds(pipeline: Pipeline): number[] {
  return (pipeline.workflows ?? []).flatMap((workflow) =>
    (workflow.children ?? [])
      .filter((step) => step.state !== undefined && FAILED_STATES.has(step.state))
      .map((step) => step.id),
  );
}

/**
 * A ZodObject whose validation treats a missing `arguments` object as `{}`.
 * Some MCP clients omit `arguments` entirely when every field is optional,
 * and the SDK would otherwise reject the call with a zod "Required" error.
 * It must stay a real ZodObject (not `.default({})` or `z.preprocess`):
 * the SDK only includes plain object schemas in the advertised tools/list
 * JSON schema, and it validates via `schema.safeParseAsync`.
 */
function toleratesMissingArgs<Shape extends z.ZodRawShape>(shape: Shape): z.ZodObject<Shape> {
  const schema = z.object(shape);
  const original = schema.safeParseAsync.bind(schema);
  schema.safeParseAsync = ((data: unknown, params?: Parameters<typeof original>[1]) =>
    original(data ?? {}, params)) as typeof schema.safeParseAsync;
  return schema;
}

const CONFIG_HELP =
  "Configure instances via environment variables: WOODPECKER_URL + WOODPECKER_TOKEN for a " +
  'single instance (named "default"), or WOODPECKER_<NAME>_URL + WOODPECKER_<NAME>_TOKEN ' +
  "per instance. Tokens come from <server>/user/cli-and-api on each Woodpecker instance. " +
  "Variables can also live in a .env.woodpecker file in the working directory.";

export function registerTools(server: McpServer, context: ToolContext): void {
  const clients = new Map<string, WoodpeckerClient>();
  const clientFor = (instanceName: string): WoodpeckerClient => {
    const instance = findInstance(context.instances, instanceName);
    let client = clients.get(instance.name);
    if (!client) {
      client = new WoodpeckerClient(instance, context.fetchImpl);
      clients.set(instance.name, client);
    }
    return client;
  };

  const configuredNames = context.instances.map((i) => i.name).join(", ") || "none configured";
  const instanceParam = z
    .string()
    .describe(`Woodpecker instance name. Configured instances: ${configuredNames}.`);
  const repoParam = z
    .string()
    .describe('Repository as "owner/name" (e.g. "acme/webapp") or a numeric Woodpecker repo id.');
  const pipelineNumberParam = z
    .union([z.number().int().positive(), z.string()])
    .describe('Per-repo pipeline number, or "latest" for the newest pipeline on the default branch.');

  const parsePipelineNumber = (value: number | string): number | "latest" => {
    if (typeof value === "number" && value >= 1) return value;
    if (typeof value === "string") {
      const trimmed = value.trim().toLowerCase();
      if (trimmed === "latest") return "latest";
      // Reject "0"/"00" too — pipeline numbers start at 1.
      if (/^\d+$/.test(trimmed) && Number(trimmed) >= 1) return Number(trimmed);
    }
    throw new Error(`Invalid pipeline number "${value}": pass a positive integer or "latest".`);
  };

  server.registerTool(
    "list_instances",
    {
      title: "List Woodpecker instances",
      description:
        "Lists the configured Woodpecker CI instances. Use `check: true` to verify each instance is reachable and the token is valid.",
      inputSchema: toleratesMissingArgs({
        check: z
          .boolean()
          .optional()
          .describe("Also call /api/user on each instance to verify connectivity and the token."),
      }),
    },
    async ({ check }) =>
      run(async () => {
        if (context.instances.length === 0) {
          return ok(`No Woodpecker instances are configured. ${CONFIG_HELP}`);
        }
        const rows = await Promise.all(
          context.instances.map(async (instance) => {
            const row: Record<string, unknown> = { name: instance.name, url: instance.url };
            if (check) {
              try {
                const user = await clientFor(instance.name).currentUser();
                row.connection = `ok (logged in as ${user.login ?? "unknown"})`;
              } catch (error) {
                row.connection = error instanceof Error ? error.message : String(error);
              }
            }
            return row;
          }),
        );
        return ok(rows);
      }),
  );

  server.registerTool(
    "list_repos",
    {
      title: "List repositories",
      description:
        "Lists repositories the token has access to on a Woodpecker instance. Returns repo ids usable with the other tools.",
      inputSchema: {
        instance: instanceParam,
        all: z.boolean().optional().describe("Include inactive repositories (default: active only)."),
      },
    },
    async ({ instance, all }) =>
      run(async () => {
        const repos = await clientFor(instance).listRepos(all ?? false);
        return ok(
          repos.map((repo) => ({
            id: repo.id,
            full_name: repo.full_name,
            default_branch: repo.default_branch,
            active: repo.active,
            forge_url: repo.forge_url,
          })),
        );
      }),
  );

  server.registerTool(
    "list_pipelines",
    {
      title: "List pipelines",
      description:
        "Lists recent pipelines for a repository, newest first. Filter by branch, event or status to find e.g. the CI runs for a pull request branch.",
      inputSchema: {
        instance: instanceParam,
        repo: repoParam,
        branch: z.string().optional().describe("Exact branch filter."),
        event: z
          .string()
          .optional()
          .describe("Event filter: push, pull_request, tag, release, deployment, cron, manual."),
        status: z
          .string()
          .optional()
          .describe(
            "Status filter: pending, running, success, failure, error, killed, canceled, blocked, declined, skipped.",
          ),
        page: z.number().int().positive().optional().describe("Page number (default 1)."),
        per_page: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe("Results per page (default 10, max 50)."),
      },
    },
    async ({ instance, repo, branch, event, status, page, per_page }) =>
      run(async () => {
        const client = clientFor(instance);
        const repoId = await client.resolveRepoId(repo);
        const pipelines = await client.listPipelines(repoId, {
          branch,
          event,
          status,
          page,
          perPage: per_page ?? 10,
        });
        return ok({
          instance: client.instance.name,
          repo,
          repo_id: repoId,
          pipelines: pipelines.map((pipeline) => ({
            ...pipelineSummary(pipeline),
            url: client.pipelineUrl(repoId, pipeline.number),
          })),
        });
      }),
  );

  server.registerTool(
    "get_pipeline",
    {
      title: "Get pipeline details",
      description:
        "Gets one pipeline with its workflows and steps (names, states, exit codes). " +
        "Failed step ids are listed in `failed_step_ids` — fetch their output with get_step_logs.",
      inputSchema: {
        instance: instanceParam,
        repo: repoParam,
        number: pipelineNumberParam,
        branch: z
          .string()
          .optional()
          .describe('With number="latest": pick the latest pipeline of this branch instead of the default branch.'),
      },
    },
    async ({ instance, repo, number, branch }) =>
      run(async () => {
        const client = clientFor(instance);
        const repoId = await client.resolveRepoId(repo);
        const pipeline = await client.getPipeline(repoId, parsePipelineNumber(number), branch);
        return ok({
          instance: client.instance.name,
          repo,
          repo_id: repoId,
          url: client.pipelineUrl(repoId, pipeline.number),
          ...pipelineSummary(pipeline),
          failed_step_ids: failedStepIds(pipeline),
          workflows: (pipeline.workflows ?? []).map(workflowSummary),
        });
      }),
  );

  server.registerTool(
    "get_step_logs",
    {
      title: "Get step logs",
      description:
        "Fetches the log output of one pipeline step (use the step ids from get_pipeline). Returns the last `tail` lines.",
      inputSchema: {
        instance: instanceParam,
        repo: repoParam,
        number: pipelineNumberParam.describe("Per-repo pipeline number the step belongs to."),
        step_id: z.number().int().positive().describe("Step id from get_pipeline (not the step name)."),
        tail: z
          .number()
          .int()
          .positive()
          .max(2000)
          .optional()
          .describe("Number of trailing log lines to return (default 100, max 2000)."),
      },
    },
    async ({ instance, repo, number, step_id, tail }) =>
      run(async () => {
        const client = clientFor(instance);
        const repoId = await client.resolveRepoId(repo);
        const pipelineNumber = parsePipelineNumber(number);
        if (pipelineNumber === "latest") {
          throw new Error('get_step_logs needs a concrete pipeline number, not "latest".');
        }
        const entries = await client.getStepLogs(repoId, pipelineNumber, step_id);
        const rendered = renderStepLogs(entries, tail ?? 100);
        const prefix = `# ${client.instance.name} ${repo} pipeline #${pipelineNumber} step ${step_id} — `;
        if (rendered.total === 0) {
          return ok(`${prefix}no log output (step was skipped or produced no logs).`);
        }
        const header =
          prefix +
          `showing ${rendered.shown} of ${rendered.total} lines` +
          (rendered.shown < rendered.total ? " (tail — increase `tail` for more)" : "");
        return ok(`${header}\n${rendered.text}`);
      }),
  );
}
