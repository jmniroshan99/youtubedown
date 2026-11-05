import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { localProxyTarget, resolveApiBase } from "../src/apiConfig";
import { serviceMessage } from "../src/serviceHealth";
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_API_BASE_URL", "https://api.example.test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("development connection routing", () => {
  const deployment = { hostname: "site.netlify.app", apiBaseUrl: "https://public-api.example.test/" };
  it("uses the public deployment fallback for an unset production variable on its exact frontend host", () => {
    for (const empty of ["", "   "])
      expect(resolveApiBase(empty, false, "site.netlify.app", deployment)).toBe("https://public-api.example.test");
  });
  it("keeps explicit environment configuration ahead of public deployment metadata", () => {
    expect(resolveApiBase("https://configured.example.test/", false, "site.netlify.app", deployment)).toBe("https://configured.example.test");
  });
  it("does not send local-development or another site's sessions to the deployment fallback", () => {
    expect(resolveApiBase("", true, "site.netlify.app", deployment)).toBe("");
    expect(resolveApiBase("", false, "another.netlify.app", deployment)).toBe("");
    expect(resolveApiBase("http://localhost:8000", true, "localhost", deployment)).toBe("/backend");
  });
  it("uses one origin and IPv4 for either local frontend hostname", () => {
    expect(localProxyTarget("http://localhost:8000")).toBe(
      "http://127.0.0.1:8000",
    );
    for (const host of ["localhost", "127.0.0.1"]) {
      expect(resolveApiBase("http://localhost:8000", true, host)).toBe(
        "/backend",
      );
    }
  });
  it("never switches production or remote development to the local proxy", () => {
    expect(
      resolveApiBase("https://api.example.test", false, "site.netlify.app"),
    ).toBe("https://api.example.test");
    expect(resolveApiBase("http://localhost:8000", false, "localhost")).toBe(
      "http://localhost:8000",
    );
    expect(
      resolveApiBase("http://localhost:8000", true, "terminal.local"),
    ).toBe("http://localhost:8000");
    expect(
      localProxyTarget("http://user:secret@localhost:8000"),
    ).toBeUndefined();
    expect(localProxyTarget("https://api.example.test")).toBeUndefined();
  });
});
describe("health responses", () => {
  it.each([
    [200, { status: "ready" }, "ready"],
    [503, { status: "ready" }, "invalid_response"],
    [503, { status: "worker_unavailable" }, "worker_unavailable"],
    [200, { unrelated: true }, "invalid_response"],
  ])("handles HTTP %s with %j honestly", async (status, body, expected) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
        ),
    );
    const { healthOptions } = await import("../src/queries");
    const client = new QueryClient();
    expect(await client.fetchQuery(healthOptions)).toEqual({
      status: expected,
    });
    client.clear();
  });
  it("does not interpret a frontend HTML fallback as an online API", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("<html>app</html>", {
            headers: { "Content-Type": "text/html" },
          }),
        ),
    );
    const { healthOptions } = await import("../src/queries");
    const client = new QueryClient();
    expect(await client.fetchQuery(healthOptions)).toEqual({
      status: "invalid_response",
    });
    client.clear();
  });
  it("provides local repair steps and does not tell production visitors to start Docker", () => {
    expect(serviceMessage("backend_unreachable", true)).toContain("start.bat");
    expect(serviceMessage("backend_unreachable", false)).not.toContain(
      "start.bat",
    );
    expect(serviceMessage("worker_unavailable", true)).toContain("worker");
    expect(serviceMessage("database_auth_failed", true)).toContain(
      "server secret",
    );
  });
});
