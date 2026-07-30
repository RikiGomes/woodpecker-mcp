#!/usr/bin/env node
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadEnvFileIfPresent, loadInstances } from "./config.ts";
import { registerTools } from "./tools.ts";

const SERVER_VERSION = "0.1.0";

// Optional dotenv support: MCP clients launch stdio servers with the project
// as working directory, so a gitignored .env.woodpecker there is a convenient
// place for instance credentials. Real environment variables take precedence
// over file values (Node --env-file semantics). A missing/unreadable file or
// an old Node without process.loadEnvFile degrades to a stderr warning.
loadEnvFileIfPresent(join(process.cwd(), ".env.woodpecker"));

let instances;
try {
  instances = loadInstances(process.env);
} catch (error) {
  console.error(`woodpecker-mcp: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const server = new McpServer({ name: "woodpecker", version: SERVER_VERSION });
registerTools(server, { instances });

await server.connect(new StdioServerTransport());
// stdout is the MCP protocol channel — status goes to stderr.
console.error(
  `woodpecker-mcp ${SERVER_VERSION} ready — instances: ${
    instances.map((i) => i.name).join(", ") || "(none configured)"
  }`,
);
