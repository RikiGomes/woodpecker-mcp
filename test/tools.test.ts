import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerTools } from "../src/tools.ts";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

const PIPELINE = {
  id: 900,
  number: 12,
  status: "failure",
  event: "pull_request",
  branch: "feature/x",
  message: "Add feature X\n\nlong body",
  commit: "abcdef0123456789",
  author: "alice",
  created: 1_750_000_000,
  started: 1_750_000_010,
  finished: 1_750_000_100,
  workflows: [
    {
      id: 1,
      name: "api",
      state: "failure",
      children: [
        { id: 101, name: "ci", state: "failure", exit_code: 1, type: "commands" },
        { id: 102, name: "docker-build", state: "skipped", type: "plugin" },
      ],
    },
    {
      id: 2,
      name: "portal",
      state: "success",
      children: [{ id: 201, name: "ci", state: "success", exit_code: 0, type: "commands" }],
    },
  ],
};

const requested: URL[] = [];

function fakeWoodpecker(url: URL): Response {
  requested.push(url);
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  switch (true) {
    case url.pathname === "/api/user":
      return json({ login: "reviewer-bot" });
    case url.pathname === "/api/user/repos":
      return json([
        { id: 7, full_name: "acme/webapp", default_branch: "main", active: true },
        { id: 8, full_name: "acme/docs", default_branch: "main", active: true },
      ]);
    case url.pathname === "/api/user/feed":
      return json([
        { repo_id: 8, full_name: "acme/docs", number: 3, status: "success", created: 1_750_000_500 },
        { repo_id: 7, full_name: "acme/webapp", number: 12, status: "failure", title: "Add feature X", created: 1_750_000_000 },
      ]);
    case url.pathname === "/api/repos/7/branches":
      return json(["main", "feature/x"]);
    case url.pathname === "/api/repos/7/pull_requests":
      return json([{ index: 42, title: "Add feature X" }]);
    case url.pathname === "/api/repos/7/pipelines/12/config":
      return json([{ name: ".woodpecker/ci.yaml", hash: "h", data: b64("steps:\n  - name: ci\n") }]);
    case url.pathname === "/api/repos/7/cron":
      return json([
        { id: 1, name: "nightly", schedule: "@daily", branch: "main", enabled: true, next_exec: 1_750_086_400, variables: { DEPLOY_ENV: "staging" } },
      ]);
    case url.pathname === "/api/repos/7/secrets":
      return json([{ name: "docker_password", value: "hunter2", events: ["push"], images: [], note: "" }]);
    case url.pathname === "/api/repos/7/pipelines/13":
      return json({ id: 901, number: 13, status: "error", errors: [{ type: "linter", message: "bad yaml" }] });
    case url.pathname === "/api/repos/9/cron":
      return new Response("access denied", { status: 403 });
    case url.pathname === "/api/agents":
      return json([{ id: 1, name: "agent-1", platform: "linux/amd64", backend: "docker", capacity: 2, token: "agent-secret-token", last_contact: 1_750_000_000 }]);
    case url.pathname === "/api/queue/info":
      return json({
        pending: [{ id: "9", name: "api", repo_id: 7, pipeline_number: 13, labels: { platform: "linux/arm64" } }],
        waiting_on_deps: null,
        running: [],
        stats: { worker_count: 2, pending_count: 1, waiting_on_deps_count: 0, running_count: 0 },
        paused: false,
      });
    case url.pathname === "/api/repos/lookup/acme/webapp":
      return json({ id: 7, full_name: "acme/webapp" });
    case url.pathname === "/api/repos/7/pipelines":
      return json([PIPELINE]);
    case url.pathname === "/api/repos/7/pipelines/12":
    case url.pathname === "/api/repos/7/pipelines/latest":
      return json(PIPELINE);
    case url.pathname === "/api/repos/7/logs/12/101": {
      const entries = Array.from({ length: 5 }, (_, i) => ({
        line: i + 1,
        type: 0,
        data: b64(`log line ${i + 1}\n`),
      }));
      return json([...entries, { line: 6, type: 2, data: b64("1\n") }]);
    }
    case url.pathname === "/api/repos/7/pipelines/14":
      return json({
        id: 902,
        number: 14,
        status: "failure",
        workflows: [{ id: 3, name: "big", state: "failure", children: [{ id: 102, name: "chatty", state: "failure", exit_code: 1 }] }],
      });
    case url.pathname === "/api/repos/7/logs/12/102":
    case url.pathname === "/api/repos/7/logs/14/102":
      return json(Array.from({ length: 100 }, (_, i) => ({ line: i + 1, type: 0, data: b64(`${i + 1} ${"y".repeat(1500)}\n`) })));
    default:
      return new Response("not found", { status: 404 });
  }
}

async function connectedClient(instances: Array<{ name: string; url: string; token: string }>) {
  const fetchImpl = vi.fn(async (input: string | URL | Request) =>
    fakeWoodpecker(input instanceof URL ? input : new URL(String(input))),
  ) as unknown as typeof fetch;

  const server = new McpServer({ name: "woodpecker", version: "0.0.0-test" });
  registerTools(server, { instances, fetchImpl });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const INSTANCES = [{ name: "acme", url: "https://ci.example.com", token: "tok" }];

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0]?.text ?? "";
}

describe("woodpecker MCP tools", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connectedClient(INSTANCES);
  });

  it("exposes the read-only tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "diagnose_pipeline",
      "get_pipeline",
      "get_pipeline_config",
      "get_queue_info",
      "get_step_logs",
      "list_agents",
      "list_branches",
      "list_crons",
      "list_instances",
      "list_pipelines",
      "list_pull_requests",
      "list_repos",
      "list_secrets",
      "recent_activity",
    ]);
  });

  it("marks every tool read-only for clients", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    }
  });

  it("get_step_logs caps a huge tail by size and says so", async () => {
    const result = await client.callTool({
      name: "get_step_logs",
      arguments: { instance: "acme", repo: "acme/webapp", number: 12, step_id: 102 },
    });
    const text = textOf(result);
    expect(text.length).toBeLessThan(101_000);
    expect(text.split("\n", 1)[0]).toContain("tail capped by size");
    expect(text).toContain("100 " + "y".repeat(10));
  });

  it("diagnose_pipeline caps each failed step's log tail", async () => {
    const result = await client.callTool({
      name: "diagnose_pipeline",
      arguments: { instance: "acme", repo: "acme/webapp", number: 14, tail: 200 },
    });
    const payload = JSON.parse(textOf(result)) as { failed_steps: Array<{ logs: string }> };
    expect(payload.failed_steps[0]!.logs.length).toBeLessThan(21_000);
    expect(payload.failed_steps[0]!.logs).toContain("100 " + "y".repeat(10));
  });

  it("list_instances still advertises its parameters in tools/list", async () => {
    // Guards toleratesMissingArgs: the SDK only converts plain object
    // schemas to JSON schema and advertises `{}` for anything else, which
    // would silently hide the `check` parameter from clients.
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "list_instances");
    expect(tool?.inputSchema.properties).toHaveProperty("check");
  });

  it("list_instances works when the arguments object is omitted entirely", async () => {
    // Some MCP clients skip `arguments` when every field is optional.
    const result = await client.callTool({ name: "list_instances" });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("ci.example.com");
  });

  it("get_pipeline rejects the pipeline number \"0\"", async () => {
    const result = await client.callTool({
      name: "get_pipeline",
      arguments: { instance: "acme", repo: "7", number: "0" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("positive integer");
  });

  it("list_instances verifies connectivity with check=true", async () => {
    const result = await client.callTool({ name: "list_instances", arguments: { check: true } });
    expect(textOf(result)).toContain("reviewer-bot");
  });

  it("list_repos returns trimmed repo rows", async () => {
    const result = await client.callTool({ name: "list_repos", arguments: { instance: "acme" } });
    const rows = JSON.parse(textOf(result)) as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      { id: 7, full_name: "acme/webapp", default_branch: "main", active: true },
      { id: 8, full_name: "acme/docs", default_branch: "main", active: true },
    ]);
  });

  it("list_pipelines resolves owner/name slugs and summarizes", async () => {
    const result = await client.callTool({
      name: "list_pipelines",
      arguments: { instance: "acme", repo: "acme/webapp", branch: "feature/x" },
    });
    const payload = JSON.parse(textOf(result)) as {
      repo_id: number;
      pipelines: Array<Record<string, unknown>>;
    };
    expect(payload.repo_id).toBe(7);
    expect(payload.pipelines[0]).toMatchObject({
      number: 12,
      status: "failure",
      message: "Add feature X",
      commit: "abcdef0123",
      url: "https://ci.example.com/repos/7/pipeline/12",
    });
  });

  it("get_pipeline lists workflows, steps and failed step ids", async () => {
    const result = await client.callTool({
      name: "get_pipeline",
      arguments: { instance: "acme", repo: "acme/webapp", number: 12 },
    });
    const payload = JSON.parse(textOf(result)) as {
      failed_step_ids: number[];
      workflows: Array<{ name: string; steps: Array<{ id: number; state: string }> }>;
    };
    expect(payload.failed_step_ids).toEqual([101]);
    expect(payload.workflows.map((w) => w.name)).toEqual(["api", "portal"]);
    expect(payload.workflows[0]?.steps[0]).toMatchObject({ id: 101, state: "failure" });
  });

  it("get_pipeline accepts the pipeline number as a string", async () => {
    const result = await client.callTool({
      name: "get_pipeline",
      arguments: { instance: "acme", repo: "7", number: "12" },
    });
    expect(result.isError).toBeFalsy();
  });

  it("get_step_logs tails decoded log lines", async () => {
    const result = await client.callTool({
      name: "get_step_logs",
      arguments: { instance: "acme", repo: "acme/webapp", number: 12, step_id: 101, tail: 3 },
    });
    const text = textOf(result);
    expect(text).toContain("showing 3 of 6 lines");
    expect(text).toContain("log line 5");
    expect(text).toContain("[exit code] 1");
    expect(text).not.toContain("log line 1");
  });

  it("get_step_logs with match greps the whole log with line numbers and context", async () => {
    const result = await client.callTool({
      name: "get_step_logs",
      arguments: { instance: "acme", repo: "acme/webapp", number: 12, step_id: 101, match: "LINE 2", context: 1 },
    });
    const text = textOf(result);
    expect(text).toContain(`1 match for "LINE 2" in 6 lines`);
    expect(text).toContain("1- log line 1\n2: log line 2\n3- log line 3");
    expect(text).not.toContain("log line 5");
  });

  it("get_step_logs match is plain text with | alternatives, so regex syntax cannot fail", async () => {
    const result = await client.callTool({
      name: "get_step_logs",
      arguments: { instance: "acme", repo: "acme/webapp", number: 12, step_id: 101, match: "(a+)+$|LINE 4", context: 0 },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('1 match for "(a+)+$" or "LINE 4" in 6 lines\n4: log line 4');
  });

  it("get_step_logs rejects a match with no terms", async () => {
    const result = await client.callTool({
      name: "get_step_logs",
      arguments: { instance: "acme", repo: "acme/webapp", number: 12, step_id: 101, match: " | " },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("at least one non-empty search term");
  });

  it("list_repos filters by owner/name substring itself instead of Woodpecker's exact name filter", async () => {
    requested.length = 0;
    const result = await client.callTool({ name: "list_repos", arguments: { instance: "acme", name: "ACME/WEB" } });
    const rows = JSON.parse(textOf(result)) as Array<{ full_name: string }>;
    expect(rows.map((row) => row.full_name)).toEqual(["acme/webapp"]);
    expect(requested.at(-1)?.searchParams.has("name")).toBe(false);
  });

  it("recent_activity filters by status and links each pipeline", async () => {
    const result = await client.callTool({
      name: "recent_activity",
      arguments: { instance: "acme", status: "failure" },
    });
    const payload = JSON.parse(textOf(result));
    expect(payload.pipelines).toHaveLength(1);
    expect(payload.pipelines[0]).toMatchObject({
      repo: "acme/webapp",
      number: 12,
      title: "Add feature X",
      url: "https://ci.example.com/repos/7/pipeline/12",
    });
  });

  it("list_branches and list_pull_requests relay the forge lists", async () => {
    const branches = JSON.parse(
      textOf(await client.callTool({ name: "list_branches", arguments: { instance: "acme", repo: "acme/webapp" } })),
    );
    expect(branches.branches).toEqual(["main", "feature/x"]);
    const prs = JSON.parse(
      textOf(await client.callTool({ name: "list_pull_requests", arguments: { instance: "acme", repo: "acme/webapp" } })),
    );
    expect(prs.pull_requests).toEqual([{ index: 42, title: "Add feature X" }]);
  });

  it("get_pipeline_config decodes the stored YAML and resolves latest on a branch", async () => {
    requested.length = 0;
    const result = await client.callTool({
      name: "get_pipeline_config",
      arguments: { instance: "acme", repo: "acme/webapp", number: "latest", branch: "feature/x" },
    });
    const latest = requested.find((url) => url.pathname.endsWith("/pipelines/latest"));
    expect(latest?.searchParams.get("branch")).toBe("feature/x");
    const text = textOf(result);
    expect(text).toContain("pipeline #12 config");
    expect(text).toContain("## .woodpecker/ci.yaml\nsteps:\n  - name: ci");
  });

  it("diagnose_pipeline returns failed steps with their log tails", async () => {
    const result = await client.callTool({
      name: "diagnose_pipeline",
      arguments: { instance: "acme", repo: "acme/webapp", number: 12, tail: 2 },
    });
    const payload = JSON.parse(textOf(result));
    expect(payload.verdict).toBe("1 failed step.");
    expect(payload.failed_steps).toHaveLength(1);
    expect(payload.failed_steps[0]).toMatchObject({ workflow: "api", step: "ci", step_id: 101, exit_code: 1 });
    expect(payload.failed_steps[0].logs).toContain("(last 2 of 6 lines)\nlog line 5\n[exit code] 1");
  });

  it("diagnose_pipeline flags a pipeline that failed before any step ran", async () => {
    const payload = JSON.parse(
      textOf(
        await client.callTool({
          name: "diagnose_pipeline",
          arguments: { instance: "acme", repo: "acme/webapp", number: 13 },
        }),
      ),
    );
    expect(payload.failed_steps).toEqual([]);
    expect(payload.verdict).toContain("without a failed step");
    expect(payload.verdict).toContain("get_pipeline_config");
    expect(payload.errors).toEqual([{ type: "linter", message: "bad yaml" }]);
  });

  it("permission-gated tools surface Woodpecker's 403 as a tool error", async () => {
    const result = await client.callTool({ name: "list_crons", arguments: { instance: "acme", repo: "9" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("HTTP 403");
  });

  it("list_crons returns variable names but not their values", async () => {
    const text = textOf(
      await client.callTool({ name: "list_crons", arguments: { instance: "acme", repo: "acme/webapp" } }),
    );
    expect(JSON.parse(text).crons[0]).toMatchObject({ name: "nightly", schedule: "@daily", variables: ["DEPLOY_ENV"] });
    expect(text).not.toContain("staging");
  });

  it("list_secrets never relays a secret value", async () => {
    const text = textOf(
      await client.callTool({ name: "list_secrets", arguments: { instance: "acme", repo: "acme/webapp" } }),
    );
    expect(JSON.parse(text).secrets).toEqual([{ name: "docker_password", events: ["push"] }]);
    expect(text).not.toContain("hunter2");
  });

  it("list_agents never relays the agent token", async () => {
    const text = textOf(await client.callTool({ name: "list_agents", arguments: { instance: "acme" } }));
    expect(JSON.parse(text).agents[0]).toMatchObject({ id: 1, name: "agent-1", backend: "docker", capacity: 2 });
    expect(text).not.toContain("agent-secret-token");
  });

  it("get_queue_info summarises tasks and tolerates null lists", async () => {
    const payload = JSON.parse(
      textOf(await client.callTool({ name: "get_queue_info", arguments: { instance: "acme" } })),
    );
    expect(payload.paused).toBe(false);
    expect(payload.stats.worker_count).toBe(2);
    expect(payload.pending).toEqual([
      { name: "api", repo_id: 7, pipeline_number: 13, labels: { platform: "linux/arm64" } },
    ]);
    expect(payload.waiting_on_deps).toEqual([]);
  });

  it("returns isError with a helpful message for unknown instances", async () => {
    const result = await client.callTool({
      name: "list_repos",
      arguments: { instance: "typo" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Configured instances: acme");
  });

  it("propagates HTTP errors as tool errors instead of protocol failures", async () => {
    const result = await client.callTool({
      name: "get_step_logs",
      arguments: { instance: "acme", repo: "7", number: 12, step_id: 999 },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("HTTP 404");
  });

  it("explains configuration when no instances exist", async () => {
    const empty = await connectedClient([]);
    const result = await empty.callTool({ name: "list_instances", arguments: {} });
    expect(textOf(result)).toContain("WOODPECKER_URL");
  });
});
