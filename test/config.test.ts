import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findInstance, loadEnvFileIfPresent, loadInstances, repoAllowed } from "../src/config.ts";

describe("loadInstances", () => {
  it("returns an empty list when no woodpecker vars are set", () => {
    expect(loadInstances({ PATH: "/usr/bin", HOME: "/root" })).toEqual([]);
  });

  it("builds the default instance from WOODPECKER_URL + WOODPECKER_TOKEN", () => {
    const instances = loadInstances({
      WOODPECKER_URL: "https://ci.example.com/",
      WOODPECKER_TOKEN: "tok",
    });
    expect(instances).toEqual([
      { name: "default", url: "https://ci.example.com", token: "tok", writes: ["restart", "cancel"] },
    ]);
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
      WOODPECKER_SIDE_PROJECT_URL: "https://ci.side.example",
      WOODPECKER_SIDE_PROJECT_TOKEN: "b",
    });
    expect(instances.map((i) => i.name)).toEqual(["acme", "side_project"]);
  });

  it("mixes the default instance with named ones", () => {
    const instances = loadInstances({
      WOODPECKER_URL: "https://ci.main.example",
      WOODPECKER_TOKEN: "a",
      WOODPECKER_OTHER_URL: "https://ci.other.example",
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
      // WOODPECKER_GITHUB_URL is a real Woodpecker *server* deployment variable;
      // it must not kill an MCP server that happens to share the environment.
      const instances = loadInstances({
        WOODPECKER_GITHUB_URL: "https://github.com",
        WOODPECKER_EXPERT_FORGE_OAUTH_URL: "https://forge.example.com",
        WOODPECKER_ACME_URL: "https://ci.example.com",
        WOODPECKER_ACME_TOKEN: "a",
      });
      expect(instances).toMatchObject([{ name: "acme", url: "https://ci.example.com", token: "a" }]);
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
    ).toThrow(/Invalid URL.*WOODPECKER_URL/);
    expect(() =>
      loadInstances({ WOODPECKER_URL: "https://bob:hunter2@bad host", WOODPECKER_TOKEN: "tok" }),
    ).not.toThrow(/hunter2/);
    expect(() =>
      loadInstances({ WOODPECKER_ACME_URL: "ci.example.com", WOODPECKER_ACME_TOKEN: "a" }),
    ).toThrow(/WOODPECKER_ACME_URL/);
    for (const url of ["ftp://ci.example.com", "file:///etc/passwd", "ci.example.com:8000"]) {
      expect(() => loadInstances({ WOODPECKER_URL: url, WOODPECKER_TOKEN: "tok" })).toThrow(/http\(s\) base URL/);
    }
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

  it("ignores keys that do not start with WOODPECKER_", () => {
    const file = join(tempDir(), ".env.woodpecker");
    writeFileSync(file, "NODE_TLS_REJECT_UNAUTHORIZED=0\nHTTPS_PROXY=http://evil.example.com\nWOODPECKER_TEST_ONLY_URL=https://ci.example.com\n");
    const tls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    const proxy = process.env.HTTPS_PROXY;
    try {
      expect([...loadEnvFileIfPresent(file)]).toEqual(["WOODPECKER_TEST_ONLY_URL"]);
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(tls);
      expect(process.env.HTTPS_PROXY).toBe(proxy);
    } finally {
      delete process.env.WOODPECKER_TEST_ONLY_URL;
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

describe("loadInstances with .env.woodpecker keys", () => {
  afterEach(() => vi.restoreAllMocks());

  it("refuses a default URL from the file paired with a token from the environment", () => {
    expect(() =>
      loadInstances(
        { WOODPECKER_URL: "https://evil.example.com", WOODPECKER_TOKEN: "real" },
        new Set(["WOODPECKER_URL"]),
      ),
    ).toThrow(/WOODPECKER_URL comes from \.env\.woodpecker/);
  });

  it("skips a named instance whose URL comes from the file but token from the environment", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const instances = loadInstances(
      {
        WOODPECKER_ACME_URL: "https://evil.example.com",
        WOODPECKER_ACME_TOKEN: "real",
        WOODPECKER_OTHER_URL: "https://ci.example.com",
        WOODPECKER_OTHER_TOKEN: "b",
      },
      new Set(["WOODPECKER_ACME_URL"]),
    );
    expect(instances.map((i) => i.name)).toEqual(["other"]);
    expect(String(warn.mock.calls[0]?.[0])).toContain('ignoring instance "acme"');
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("real");
  });

  it("accepts pairs that come entirely from the file or entirely from the environment", () => {
    const fromFile = loadInstances(
      { WOODPECKER_URL: "https://ci.example.com", WOODPECKER_TOKEN: "t" },
      new Set(["WOODPECKER_URL", "WOODPECKER_TOKEN"]),
    );
    expect(fromFile).toHaveLength(1);
    expect(loadInstances({ WOODPECKER_URL: "https://ci.example.com", WOODPECKER_TOKEN: "t" })).toHaveLength(1);
  });

  it("accepts a token from the file with a URL from the environment", () => {
    const instances = loadInstances(
      { WOODPECKER_URL: "https://ci.example.com", WOODPECKER_TOKEN: "t" },
      new Set(["WOODPECKER_TOKEN"]),
    );
    expect(instances).toHaveLength(1);
  });

  it("refuses WOODPECKER_DEFAULT_URL from the file with WOODPECKER_TOKEN from the environment", () => {
    expect(() =>
      loadInstances(
        { WOODPECKER_DEFAULT_URL: "https://evil.example.com", WOODPECKER_TOKEN: "real" },
        new Set(["WOODPECKER_DEFAULT_URL"]),
      ),
    ).toThrow(/WOODPECKER_DEFAULT_URL comes from/);
  });

  it("does not let the file replace an instance the environment defines", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const instances = loadInstances(
      {
        WOODPECKER_URL: "https://ci.example.com",
        WOODPECKER_TOKEN: "real",
        WOODPECKER_DEFAULT_URL: "https://evil.example.com",
        WOODPECKER_DEFAULT_TOKEN: "planted",
      },
      new Set(["WOODPECKER_DEFAULT_URL", "WOODPECKER_DEFAULT_TOKEN"]),
    );
    expect(instances).toMatchObject([{ name: "default", url: "https://ci.example.com", token: "real" }]);
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("ignoring WOODPECKER_DEFAULT_URL");
  });

  it("rejects instance URLs that carry credentials without echoing them", () => {
    let message = "";
    try {
      loadInstances({ WOODPECKER_URL: "https://bob:hunter2@ci.example.com", WOODPECKER_TOKEN: "t" });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("credentials in its URL");
    expect(message).not.toContain("hunter2");
  });

  it("prefers WOODPECKER_SERVER from the environment over WOODPECKER_URL from the file", () => {
    const instances = loadInstances(
      { WOODPECKER_URL: "https://evil.example.com", WOODPECKER_SERVER: "https://ci.example.com", WOODPECKER_TOKEN: "t" },
      new Set(["WOODPECKER_URL"]),
    );
    expect(instances).toMatchObject([{ name: "default", url: "https://ci.example.com", token: "t" }]);
  });

  it("checks WOODPECKER_SERVER the same way as WOODPECKER_URL", () => {
    expect(() =>
      loadInstances(
        { WOODPECKER_SERVER: "https://evil.example.com", WOODPECKER_TOKEN: "real" },
        new Set(["WOODPECKER_SERVER"]),
      ),
    ).toThrow(/WOODPECKER_SERVER comes from/);
  });
});

describe("plain http instance URLs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("warns when a remote instance uses http", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    loadInstances({ WOODPECKER_URL: "http://ci.example.com", WOODPECKER_TOKEN: "t" });
    expect(String(warn.mock.calls[0]?.[0])).toContain("plain http");
  });

  it("does not warn for loopback instances", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    loadInstances({
      WOODPECKER_URL: "http://localhost:8000",
      WOODPECKER_TOKEN: "t",
      WOODPECKER_LOOP_URL: "http://127.0.0.1:8000",
      WOODPECKER_LOOP_TOKEN: "t",
      WOODPECKER_LOOP2_URL: "http://127.5.0.1:8000",
      WOODPECKER_LOOP2_TOKEN: "t",
      WOODPECKER_V6_URL: "http://[::1]:8000",
      WOODPECKER_V6_TOKEN: "t",
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("loadEnvFileIfPresent return value", () => {
  it("returns only the keys the file added, not ones already set", () => {
    const dir = mkdtempSync(join(tmpdir(), "woodpecker-mcp-test-"));
    const file = join(dir, ".env.woodpecker");
    writeFileSync(file, "WOODPECKER_TEST_ADDED_URL=https://ci.example.com\nWOODPECKER_TEST_PRESET=file\n");
    process.env.WOODPECKER_TEST_PRESET = "env";
    try {
      const added = loadEnvFileIfPresent(file);
      expect([...added]).toEqual(["WOODPECKER_TEST_ADDED_URL"]);
      expect(process.env.WOODPECKER_TEST_PRESET).toBe("env");
    } finally {
      delete process.env.WOODPECKER_TEST_ADDED_URL;
      delete process.env.WOODPECKER_TEST_PRESET;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("write settings", () => {
  const pair = { WOODPECKER_ACME_URL: "https://ci.example.com", WOODPECKER_ACME_TOKEN: "a" };

  it("enables every write tool when ALLOW_WRITE is unset", () => {
    expect(loadInstances(pair)[0]?.writes).toEqual(["restart", "cancel"]);
  });

  it("reads ALLOW_WRITE per instance, including all, none and an empty value", () => {
    const writes = (value: string) => loadInstances({ ...pair, WOODPECKER_ACME_ALLOW_WRITE: value })[0]?.writes;
    expect(writes("cancel")).toEqual(["cancel"]);
    expect(writes(" Restart , CANCEL ")).toEqual(["restart", "cancel"]);
    expect(writes("all")).toEqual(["restart", "cancel"]);
    expect(writes("none")).toEqual([]);
    expect(writes("")).toEqual([]);
  });

  it("reads WOODPECKER_ALLOW_WRITE for the default instance", () => {
    const [instance] = loadInstances({
      WOODPECKER_URL: "https://ci.example.com",
      WOODPECKER_TOKEN: "t",
      WOODPECKER_ALLOW_WRITE: "none",
      WOODPECKER_WRITE_REPOS: "acme/*",
    });
    expect(instance).toMatchObject({ writes: [], writeRepos: ["acme/*"] });
  });

  it("drops unknown ALLOW_WRITE values with a warning, which only narrows", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(loadInstances({ ...pair, WOODPECKER_ACME_ALLOW_WRITE: "restrat,cancel" })[0]?.writes).toEqual(["cancel"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("WOODPECKER_ACME_ALLOW_WRITE has unknown value(s) restrat"));
    } finally {
      warn.mockRestore();
    }
  });

  it("parses WRITE_REPOS and matches exact names, owner wildcards and *", () => {
    const [instance] = loadInstances({ ...pair, WOODPECKER_ACME_WRITE_REPOS: " Acme/WebApp, tools/* ,," });
    expect(instance?.writeRepos).toEqual(["acme/webapp", "tools/*"]);
    expect(repoAllowed(instance?.writeRepos, "acme/webapp")).toBe(true);
    expect(repoAllowed(instance?.writeRepos, "acme/webapp2")).toBe(false);
    expect(repoAllowed(instance?.writeRepos, "tools/cli")).toBe(true);
    expect(repoAllowed(instance?.writeRepos, "tools/group/cli")).toBe(true);
    expect(repoAllowed(instance?.writeRepos, "toolsx/cli")).toBe(false);
    expect(repoAllowed(["*"], "anything/at-all")).toBe(true);
    expect(repoAllowed(undefined, "anything/at-all")).toBe(true);
    expect(repoAllowed([], "acme/webapp")).toBe(false);
  });
});
