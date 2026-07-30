import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findInstance, loadEnvFileIfPresent, loadInstances } from "../src/config.ts";

describe("loadInstances", () => {
  it("returns an empty list when no woodpecker vars are set", () => {
    expect(loadInstances({ PATH: "/usr/bin", HOME: "/root" })).toEqual([]);
  });

  it("builds the default instance from WOODPECKER_URL + WOODPECKER_TOKEN", () => {
    const instances = loadInstances({
      WOODPECKER_URL: "https://ci.example.com/",
      WOODPECKER_TOKEN: "tok",
    });
    expect(instances).toEqual([{ name: "default", url: "https://ci.example.com", token: "tok" }]);
  });

  it("accepts WOODPECKER_SERVER (the official CLI variable) as the default URL", () => {
    const instances = loadInstances({
      WOODPECKER_SERVER: "https://ci.example.com",
      WOODPECKER_TOKEN: "tok",
    });
    expect(instances[0]?.url).toBe("https://ci.example.com");
  });

  it("builds named instances from WOODPECKER_<NAME>_URL/_TOKEN pairs", () => {
    const instances = loadInstances({
      WOODPECKER_ACME_URL: "https://ci.example.com",
      WOODPECKER_ACME_TOKEN: "a",
      WOODPECKER_SIDE_PROJECT_URL: "https://ci.side.dev",
      WOODPECKER_SIDE_PROJECT_TOKEN: "b",
    });
    expect(instances.map((i) => i.name)).toEqual(["acme", "side_project"]);
  });

  it("mixes the default instance with named ones", () => {
    const instances = loadInstances({
      WOODPECKER_URL: "https://ci.main.dev",
      WOODPECKER_TOKEN: "a",
      WOODPECKER_OTHER_URL: "https://ci.other.dev",
      WOODPECKER_OTHER_TOKEN: "b",
    });
    expect(instances.map((i) => i.name)).toEqual(["default", "other"]);
  });

  it("throws a clear error when the default pair is incomplete", () => {
    expect(() => loadInstances({ WOODPECKER_TOKEN: "tok" })).toThrow(/WOODPECKER_URL/);
    expect(() => loadInstances({ WOODPECKER_URL: "https://ci.example.com" })).toThrow(
      /WOODPECKER_TOKEN/,
    );
  });

  it("skips incomplete named pairs with a stderr warning instead of throwing", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // WOODPECKER_GITHUB_URL is a real Woodpecker *server* deployment variable —
      // it must not kill an MCP server that happens to share the environment.
      const instances = loadInstances({
        WOODPECKER_GITHUB_URL: "https://github.com",
        WOODPECKER_EXPERT_FORGE_OAUTH_URL: "https://forge.example.com",
        WOODPECKER_ACME_URL: "https://ci.example.com",
        WOODPECKER_ACME_TOKEN: "a",
      });
      expect(instances).toEqual([{ name: "acme", url: "https://ci.example.com", token: "a" }]);
      const warnings = warn.mock.calls.map((call) => String(call[0])).join("\n");
      expect(warnings).toContain("WOODPECKER_GITHUB_TOKEN");
      expect(warnings).toContain("WOODPECKER_EXPERT_FORGE_OAUTH_TOKEN");
    } finally {
      warn.mockRestore();
    }
  });

  it("prefers WOODPECKER_URL over WOODPECKER_SERVER regardless of env order", () => {
    const both = {
      WOODPECKER_SERVER: "https://server.example.com",
      WOODPECKER_URL: "https://url.example.com",
      WOODPECKER_TOKEN: "tok",
    };
    expect(loadInstances(both)[0]?.url).toBe("https://url.example.com");
    // Reversed insertion order must not change the winner.
    const reversed = {
      WOODPECKER_URL: "https://url.example.com",
      WOODPECKER_SERVER: "https://server.example.com",
      WOODPECKER_TOKEN: "tok",
    };
    expect(loadInstances(reversed)[0]?.url).toBe("https://url.example.com");
  });

  it("rejects malformed instance URLs at load time", () => {
    expect(() =>
      loadInstances({ WOODPECKER_URL: "not a url", WOODPECKER_TOKEN: "tok" }),
    ).toThrow(/Invalid URL.*not a url/);
    expect(() =>
      loadInstances({ WOODPECKER_ACME_URL: "ci.example.com", WOODPECKER_ACME_TOKEN: "a" }),
    ).toThrow(/WOODPECKER_ACME_URL/);
  });

  it("ignores unrelated WOODPECKER_* variables", () => {
    expect(loadInstances({ WOODPECKER_AGENT_SECRET: "x", WOODPECKER_LOG_LEVEL: "debug" })).toEqual(
      [],
    );
  });
});

describe("loadEnvFileIfPresent", () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "woodpecker-mcp-test-"));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("does nothing when the file does not exist", () => {
    const loader = vi.fn();
    loadEnvFileIfPresent(join(tempDir(), ".env.woodpecker"), loader);
    expect(loader).not.toHaveBeenCalled();
  });

  it("loads an existing env file", () => {
    const file = join(tempDir(), ".env.woodpecker");
    writeFileSync(file, "WOODPECKER_TEST_LOADENV_URL=https://ci.example.com\n");
    loadEnvFileIfPresent(file);
    try {
      expect(process.env.WOODPECKER_TEST_LOADENV_URL).toBe("https://ci.example.com");
    } finally {
      delete process.env.WOODPECKER_TEST_LOADENV_URL;
    }
  });

  it("warns instead of crashing when the loader throws", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const file = join(tempDir(), ".env.woodpecker");
    writeFileSync(file, "whatever");
    const loader = vi.fn(() => {
      throw new Error("malformed env file");
    });
    expect(() => loadEnvFileIfPresent(file, loader)).not.toThrow();
    expect(String(warn.mock.calls[0]?.[0])).toContain("malformed env file");
  });

  it("warns and skips when process.loadEnvFile is unavailable (Node < 20.12)", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const file = join(tempDir(), ".env.woodpecker");
    writeFileSync(file, "X=1");
    const proc = process as unknown as { loadEnvFile?: (path?: string) => void };
    const original = proc.loadEnvFile;
    proc.loadEnvFile = undefined;
    try {
      expect(() => loadEnvFileIfPresent(file)).not.toThrow();
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/20\.12/);
    } finally {
      proc.loadEnvFile = original;
    }
  });
});

describe("findInstance", () => {
  const instances = loadInstances({
    WOODPECKER_ACME_URL: "https://ci.example.com",
    WOODPECKER_ACME_TOKEN: "a",
  });

  it("finds instances case-insensitively", () => {
    expect(findInstance(instances, "ACME").url).toBe("https://ci.example.com");
  });

  it("lists configured instances when the name is unknown", () => {
    expect(() => findInstance(instances, "nope")).toThrow(/Configured instances: acme/);
  });

  it("explains configuration when nothing is configured", () => {
    expect(() => findInstance([], "any")).toThrow(/No Woodpecker instances are configured/);
  });
});
