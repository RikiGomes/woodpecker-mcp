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

const apiRun = (number: number, status: string, testState: string, commit: string, message: string) => ({
  id: 1000 + number,
  number,
  status,
  branch: "main",
  message,
  commit,
  author: "bob",
  created: 1_750_000_000 + number,
  started: 1_750_000_010 + number,
  finished: 1_750_000_070 + number,
  workflows: [
    {
      id: number,
      name: "build",
      state: status,
      children: [
        { id: number * 10 + 1, name: "lint", state: "success", exit_code: 0 },
        { id: number * 10 + 2, name: "test", state: testState, exit_code: testState === "success" ? 0 : 1 },
      ],
    },
  ],
});
const API_RUNS = [
  apiRun(22, "failure", "failure", "2222222222abc", "Bump parser"),
  apiRun(21, "failure", "failure", "1111111111abc", "Refactor\n\nbody"),
  apiRun(20, "success", "success", "0000000000abc", "Green"),
];

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
    case url.pathname === "/api/repos/7":
      return json({ id: 7, full_name: "acme/webapp", org_id: 3 });
    case url.pathname === "/api/repos/8":
      return json({ id: 8, full_name: "acme/docs" });
    case url.pathname === "/api/orgs/3/secrets":
      return json([{ name: "registry_token", value: "org-hunter2", events: ["push", "tag"], images: ["woodpeckerci/plugin-docker-buildx"], note: "shared" }]);
    case url.pathname === "/api/secrets":
      return json([{ name: "sonar_token", value: "global-hunter2", events: ["push"] }]);
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
    case url.pathname === "/api/repos/lookup/acme/api":
      return json({ id: 10, full_name: "acme/api" });
    case url.pathname === "/api/repos/10":
      return json({ id: 10, full_name: "acme/api", default_branch: "main" });
    case url.pathname === "/api/repos/10/pipelines":
      return json(API_RUNS.map(({ workflows: _workflows, ...summary }) => summary));
    case /^\/api\/repos\/10\/pipelines\/\d+$/.test(url.pathname):
      return json(API_RUNS.find((run) => url.pathname.endsWith(`/${run.number}`)));
    case /^\/api\/repos\/10\/pipelines\/\d+\/config$/.test(url.pathname):
      return json([
        { name: ".woodpecker/build.yaml", hash: url.pathname.includes("/22/") ? "new" : "old", data: b64("steps: {}\n") },
      ]);
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
    case url.pathname === "/api/repos/7/pipelines/14/config":
      return json([{ name: ".woodpecker/big.yaml", hash: "h", data: b64(`# ${"y".repeat(150_000)}\n`) }]);
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
      "compare_pipelines",
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
      arguments: { instance: "acme", repo: "acme/webapp", number: 12, step_id: 102, tail: 100 },
    });
    const text = textOf(result);
    expect(text.length).toBeLessThan(101_000);
    expect(text.split("\n", 1)[0]).toContain("tail capped by size");
    expect(text).toContain("100 " + "y".repeat(10));
  });

  it("get_pipeline_config caps a huge config", async () => {
    const result = await client.callTool({
      name: "get_pipeline_config",
      arguments: { instance: "acme", repo: "acme/webapp", number: 14 },
    });
    const text = textOf(result);
    expect(text.length).toBeLessThan(101_000);
    expect(text).toContain("chars of config clipped");
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
      created: "2025-06-15T15:06:40Z",
      duration_s: 90,
    });
    expect(payload.pipelines[0]).not.toHaveProperty("url");
    expect(payload).not.toHaveProperty("instance");
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

  it("get_pipeline only counts passing steps unless all_steps is set", async () => {
    const lean = JSON.parse(
      textOf(await client.callTool({ name: "get_pipeline", arguments: { instance: "acme", repo: "acme/webapp", number: 12 } })),
    ) as { workflows: Array<{ name: string; passed?: number; skipped?: number; steps: Array<{ id: number }> }> };
    expect(lean.workflows[0]).toMatchObject({ name: "api", skipped: 1, steps: [{ id: 101 }] });
    expect(lean.workflows[1]).toMatchObject({ name: "portal", passed: 1, steps: [] });

    const full = JSON.parse(
      textOf(
        await client.callTool({
          name: "get_pipeline",
          arguments: { instance: "acme", repo: "acme/webapp", number: 12, all_steps: true },
        }),
      ),
    ) as { workflows: Array<{ passed?: number; steps: Array<{ id: number }> }> };
    expect(full.workflows.flatMap((w) => w.steps.map((step) => step.id))).toEqual([101, 102, 201]);
    expect(full.workflows[1]).not.toHaveProperty("passed");
  });

  it("returns compact JSON and only echoes repo_id for slugs", async () => {
    const bySlug = textOf(
      await client.callTool({ name: "get_pipeline", arguments: { instance: "acme", repo: "acme/webapp", number: 12 } }),
    );
    expect(bySlug).not.toContain("\n");
    expect(JSON.parse(bySlug)).toMatchObject({ repo_id: 7 });
    expect(JSON.parse(bySlug)).not.toHaveProperty("instance");
    const byId = JSON.parse(
      textOf(await client.callTool({ name: "get_pipeline", arguments: { instance: "acme", repo: "7", number: 12 } })),
    );
    expect(byId).not.toHaveProperty("repo_id");
    expect(byId).not.toHaveProperty("repo");
  });

  it("keeps every tool response within its size budget on the fixtures", async () => {
    const budgets: Array<[string, Record<string, unknown>, number]> = [
      ["list_pipelines", { repo: "acme/webapp" }, 260],
      ["get_pipeline", { repo: "acme/webapp", number: 12 }, 550],
      ["diagnose_pipeline", { repo: "acme/webapp", number: 12 }, 550],
      ["get_step_logs", { repo: "acme/webapp", number: 12, step_id: 101 }, 150],
      ["recent_activity", {}, 280],
      ["list_crons", { repo: "acme/webapp" }, 200],
      ["list_agents", {}, 170],
      ["get_queue_info", {}, 280],
      ["compare_pipelines", { repo: "acme/api" }, 600],
    ];
    for (const [name, args, budget] of budgets) {
      const text = textOf(await client.callTool({ name, arguments: { instance: "acme", ...args } }));
      expect(text.length, `${name}: ${text}`).toBeLessThanOrEqual(budget);
    }
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

  it("recent_activity filters by status", async () => {
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

  it("compare_pipelines diffs the newest failure against the last green run", async () => {
    const payload = JSON.parse(
      textOf(await client.callTool({ name: "compare_pipelines", arguments: { instance: "acme", repo: "acme/api" } })),
    );
    expect(payload).toMatchObject({
      repo_id: 10,
      branch: "main",
      good: { number: 20, status: "success", commit: "0000000000" },
      bad: { number: 22, status: "failure", message: "Bump parser" },
      between: ["#21 failure 1111111111 Refactor"],
      steps: [{ workflow: "build", step: "test", good: "success", bad: "failure", exit_code: 1 }],
      config_changed: [".woodpecker/build.yaml"],
      failed_step_ids: [222],
    });
    expect(JSON.stringify(payload)).not.toContain("steps: {}");
  });

  it("compare_pipelines refuses a green run as `bad`, a missing baseline and a reversed pair", async () => {
    const green = await client.callTool({ name: "compare_pipelines", arguments: { instance: "acme", repo: "acme/api", bad: 20 } });
    expect(green.isError).toBe(true);
    expect(textOf(green)).toContain("#20 is success");
    const noBaseline = await client.callTool({ name: "compare_pipelines", arguments: { instance: "acme", repo: "acme/webapp", branch: "feature/x" } });
    expect(noBaseline.isError).toBe(true);
    expect(textOf(noBaseline)).toContain("No successful pipeline before #12");
    const reversed = await client.callTool({ name: "compare_pipelines", arguments: { instance: "acme", repo: "acme/api", bad: 21, good: 22 } });
    expect(textOf(reversed)).toContain("must be older");
    const explicit = JSON.parse(
      textOf(await client.callTool({ name: "compare_pipelines", arguments: { instance: "acme", repo: "acme/api", bad: 22, good: 20 } })),
    );
    expect(explicit.between).toEqual(["#21 failure 1111111111 Refactor"]);
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
    expect(JSON.parse(text).scope).toBe("repo");
    expect(text).not.toContain("hunter2");
  });

  it("list_secrets lists organization secrets via the repository's org", async () => {
    const text = textOf(
      await client.callTool({ name: "list_secrets", arguments: { instance: "acme", repo: "acme/webapp", scope: "org" } }),
    );
    expect(JSON.parse(text).secrets).toEqual([
      { name: "registry_token", events: ["push", "tag"], images: ["woodpeckerci/plugin-docker-buildx"], note: "shared" },
    ]);
    expect(text).not.toContain("org-hunter2");
  });

  it("list_secrets lists global secrets without a repo", async () => {
    const text = textOf(await client.callTool({ name: "list_secrets", arguments: { instance: "acme", scope: "global" } }));
    expect(JSON.parse(text)).toEqual({ scope: "global", secrets: [{ name: "sonar_token", events: ["push"] }] });
    expect(text).not.toContain("global-hunter2");
  });

  it("list_secrets needs a repo outside the global scope", async () => {
    const result = await client.callTool({ name: "list_secrets", arguments: { instance: "acme", scope: "org" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("needs `repo`");
  });

  it("list_secrets explains a repository without an organization", async () => {
    const result = await client.callTool({ name: "list_secrets", arguments: { instance: "acme", repo: "8", scope: "org" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('use scope "repo" or "global"');
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
