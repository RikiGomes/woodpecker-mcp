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

function fakeWoodpecker(url: URL): Response {
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  switch (true) {
    case url.pathname === "/api/user":
      return json({ login: "reviewer-bot" });
    case url.pathname === "/api/user/repos":
      return json([{ id: 7, full_name: "acme/webapp", default_branch: "main", active: true }]);
    case url.pathname === "/api/repos/lookup/acme/webapp":
      return json({ id: 7, full_name: "acme/webapp" });
    case url.pathname === "/api/repos/7/pipelines":
      return json([PIPELINE]);
    case url.pathname === "/api/repos/7/pipelines/12":
      return json(PIPELINE);
    case url.pathname === "/api/repos/7/logs/12/101": {
      const entries = Array.from({ length: 5 }, (_, i) => ({
        line: i + 1,
        type: 0,
        data: b64(`log line ${i + 1}\n`),
      }));
      return json([...entries, { line: 6, type: 2, data: b64("1\n") }]);
    }
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

  it("exposes the five read-only tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_pipeline",
      "get_step_logs",
      "list_instances",
      "list_pipelines",
      "list_repos",
    ]);
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
