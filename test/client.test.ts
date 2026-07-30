import { describe, expect, it, vi } from "vitest";
import { WoodpeckerApiError, WoodpeckerClient } from "../src/client.ts";

const INSTANCE = { name: "acme", url: "https://ci.example.com", token: "secret-token" };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(handler: (url: URL) => Response | Promise<Response>) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    return handler(url);
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("WoodpeckerClient", () => {
  it("sends the bearer token on every request", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ login: "ci-bot" })) as unknown as
      typeof fetch & ReturnType<typeof vi.fn>;
    const client = new WoodpeckerClient(INSTANCE, fetchImpl);

    const user = await client.currentUser();

    expect(user.login).toBe("ci-bot");
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://ci.example.com/api/user");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
  });

  it("preserves a sub-path in the instance base URL", async () => {
    const fetchImpl = mockFetch(() => jsonResponse([]));
    const client = new WoodpeckerClient({ ...INSTANCE, url: "https://host.example/ci" }, fetchImpl);

    await client.listRepos();

    const url = (fetchImpl.mock.calls[0] as [URL])[0];
    expect(url.toString()).toBe("https://host.example/ci/api/user/repos");
  });

  it("builds pipeline list queries and omits unset filters", async () => {
    const fetchImpl = mockFetch(() => jsonResponse([]));
    const client = new WoodpeckerClient(INSTANCE, fetchImpl);

    await client.listPipelines(7, { branch: "main", perPage: 10 });

    const url = (fetchImpl.mock.calls[0] as [URL])[0];
    expect(url.pathname).toBe("/api/repos/7/pipelines");
    expect(url.searchParams.get("branch")).toBe("main");
    expect(url.searchParams.get("perPage")).toBe("10");
    expect(url.searchParams.has("event")).toBe(false);
    expect(url.searchParams.has("status")).toBe(false);
  });

  it("resolves owner/name slugs via the lookup endpoint and caches the id", async () => {
    const fetchImpl = mockFetch((url) => {
      expect(url.pathname).toBe("/api/repos/lookup/acme/webapp");
      return jsonResponse({ id: 42, full_name: "acme/webapp" });
    });
    const client = new WoodpeckerClient(INSTANCE, fetchImpl);

    expect(await client.resolveRepoId("acme/webapp")).toBe(42);
    expect(await client.resolveRepoId("acme/webapp")).toBe(42);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("passes numeric repo ids through without a lookup", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({}));
    const client = new WoodpeckerClient(INSTANCE, fetchImpl);

    expect(await client.resolveRepoId("42")).toBe(42);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects repo strings that are neither ids nor slugs", async () => {
    const client = new WoodpeckerClient(INSTANCE, mockFetch(() => jsonResponse({})));
    await expect(client.resolveRepoId("just-a-name")).rejects.toThrow(/owner\/name/);
  });

  it("rejects path-traversal segments in the repo slug", async () => {
    // encodeURIComponent leaves "." untouched and new URL() collapses "../",
    // so an unchecked slug like "../../admin/secrets" would redirect the
    // authenticated GET away from /api/repos/lookup/ to an arbitrary path.
    const fetchImpl = mockFetch(() => jsonResponse({ id: 1 }));
    const client = new WoodpeckerClient(INSTANCE, fetchImpl);
    for (const evil of ["../../admin/secrets", "owner/../secrets", "a/./b", "owner//name"]) {
      await expect(client.resolveRepoId(evil)).rejects.toThrow(/Invalid repo/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still accepts legitimate nested repo names (e.g. GitLab subgroups)", async () => {
    const fetchImpl = mockFetch((url) => {
      expect(url.pathname).toBe("/api/repos/lookup/group/subgroup/name");
      return jsonResponse({ id: 55 });
    });
    const client = new WoodpeckerClient(INSTANCE, fetchImpl);
    expect(await client.resolveRepoId("group/subgroup/name")).toBe(55);
  });

  it("queries the branch only for latest pipelines", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ id: 1, number: 5 }));
    const client = new WoodpeckerClient(INSTANCE, fetchImpl);

    await client.getPipeline(7, "latest", "main");
    await client.getPipeline(7, 5, "ignored-for-concrete-numbers");

    const [first, second] = fetchImpl.mock.calls as unknown as [URL][];
    expect(first![0].pathname).toBe("/api/repos/7/pipelines/latest");
    expect(first![0].searchParams.get("branch")).toBe("main");
    expect(second![0].pathname).toBe("/api/repos/7/pipelines/5");
    expect(second![0].searchParams.has("branch")).toBe(false);
  });

  it("surfaces HTTP errors with status and response body", async () => {
    const fetchImpl = mockFetch(() => new Response("invalid session", { status: 401 }));
    const client = new WoodpeckerClient(INSTANCE, fetchImpl);

    const error = await client.currentUser().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WoodpeckerApiError);
    expect((error as WoodpeckerApiError).status).toBe(401);
    expect((error as WoodpeckerApiError).message).toContain("HTTP 401");
    expect((error as WoodpeckerApiError).message).toContain("invalid session");
  });

  it("redacts the token if an upstream error body reflects it", async () => {
    // Defence in depth: a misconfigured proxy/server that echoes the
    // Authorization header in its error body must not relay the token to the
    // MCP client (the LLM) verbatim.
    const fetchImpl = mockFetch(
      () => new Response(`unauthorized: Bearer ${INSTANCE.token}`, { status: 401 }),
    );
    const client = new WoodpeckerClient(INSTANCE, fetchImpl);

    const error = (await client.currentUser().catch((e: unknown) => e)) as WoodpeckerApiError;
    expect(error.message).not.toContain(INSTANCE.token);
    expect(error.message).toContain("[redacted]");
    expect(error.message).toContain("HTTP 401");
  });

  it("wraps a 200 response with a non-JSON body as WoodpeckerApiError", async () => {
    // e.g. a reverse proxy answering with an HTML error/login page.
    const fetchImpl = mockFetch(
      () => new Response("<html><body>login</body></html>", { status: 200 }),
    );
    const client = new WoodpeckerClient(INSTANCE, fetchImpl);

    const error = await client.currentUser().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WoodpeckerApiError);
    expect((error as WoodpeckerApiError).message).toContain("acme");
    expect((error as WoodpeckerApiError).message).toContain("/api/user");
    expect((error as WoodpeckerApiError).message).toMatch(/non-JSON|not valid JSON/i);
  });

  it("wraps network failures with the instance name", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED 127.0.0.1:8000") });
    }) as unknown as typeof fetch;
    const client = new WoodpeckerClient(INSTANCE, fetchImpl);

    await expect(client.currentUser()).rejects.toThrow(/instance "acme".*ECONNREFUSED/);
  });
});
