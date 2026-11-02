import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseEnv,
  backendUrl,
  probeHealth,
  probeCors,
} from "../scripts/diagnose.mjs";

test("environment parser preserves quoted keys without executing input", () => {
  assert.deepEqual(
    parseEnv(
      'KEY="value # literal"\r\nSECOND=word # comment\nEMPTY=\nOTHER=$(command)',
    ),
    { KEY: "value # literal", SECOND: "word", EMPTY: "", OTHER: "$(command)" },
  );
  assert.equal(backendUrl("http://localhost:8000/"), "http://127.0.0.1:8000");
  assert.equal(backendUrl("https://secret@api.example"), null);
});

test("diagnostics reject misleading health responses and wildcard CORS", async () => {
  assert.equal(
    (
      await probeHealth(
        "http://test",
        async () =>
          new Response('{"status":"ready"}', {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }),
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await probeHealth(
        "http://test",
        async () => new Response("<html>app</html>"),
      )
    ).ok,
    false,
  );
  assert.equal(
    await probeCors(
      "http://test",
      "http://127.0.0.1:5173",
      async () =>
        new Response("", { headers: { "Access-Control-Allow-Origin": "*" } }),
    ),
    false,
  );
});

test("actual Vite proxy forwards health and authenticated metadata, then reports an offline backend", async () => {
  const received = [];
  const backend = http.createServer((request, response) => {
    received.push({
      path: request.url,
      token: request.headers.authorization,
      origin: request.headers.origin,
    });
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify(
        request.url === "/health" ? { status: "ready" } : { jobs: [] },
      ),
    );
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const old = process.env.VITE_API_BASE_URL;
  process.env.VITE_API_BASE_URL = `http://localhost:${backend.address().port}`;
  let vite;
  try {
    const require = createRequire(
      new URL("../frontend/package.json", import.meta.url),
    );
    const { createServer } = await import(
      pathToFileURL(require.resolve("vite"))
    );
    vite = await createServer({
      root: fileURLToPath(new URL("../frontend", import.meta.url)),
      server: { host: "127.0.0.1", port: 0 },
      logLevel: "silent",
    });
    await vite.listen();
    const base = `http://127.0.0.1:${vite.httpServer.address().port}/backend`;
    assert.equal((await probeHealth(base)).ok, true);
    const response = await fetch(`${base}/api/downloads`, {
      headers: {
        Authorization: "Bearer test-only",
        Origin: "http://127.0.0.1:5173",
      },
    });
    assert.deepEqual(await response.json(), { jobs: [] });
    assert.deepEqual(received[1], {
      path: "/api/downloads",
      token: "Bearer test-only",
      origin: "http://127.0.0.1:5173",
    });
    backend.closeAllConnections();
    await new Promise((resolve) => backend.close(resolve));
    const offline = await fetch(`${base}/health`);
    assert.equal(offline.status, 503);
    assert.equal(offline.headers.get("Cache-Control"), "no-store");
    assert.equal((await offline.json()).status, "backend_unreachable");
  } finally {
    await vite?.close();
    backend.closeAllConnections();
    backend.close();
    if (old === undefined) delete process.env.VITE_API_BASE_URL;
    else process.env.VITE_API_BASE_URL = old;
  }
});

test("diagnostics distinguish socket failures from HTTP errors and missing host bindings", async () => {
  const { transportCode, portBindingsSummary, probeCorsDetailed } =
    await import("../scripts/diagnose.mjs");
  const failure = new TypeError("private error information", {
    cause: { code: "ECONNREFUSED" },
  });
  assert.equal(transportCode(failure), "ECONNREFUSED");
  const health = await probeHealth("http://test", async () => {
    throw failure;
  });
  assert.equal(health.status, "unreachable");
  assert.equal(health.transport, "ECONNREFUSED");
  assert.ok(!JSON.stringify(health).includes("private"));
  const invalid = await probeHealth(
    "http://test",
    async () => new Response("wrong service", { status: 404 }),
  );
  assert.equal(invalid.status, "invalid_response");
  assert.equal(invalid.httpStatus, 404);
  const cors = await probeCorsDetailed(
    "http://test",
    "http://localhost:5173",
    async () => {
      throw failure;
    },
  );
  assert.equal(cors.reachable, false);
  assert.equal(portBindingsSummary('{"8000/tcp":null}'), "none");
  assert.equal(
    portBindingsSummary(
      '{"8080/tcp":[{"HostIp":"127.0.0.1","HostPort":"8000"}]}',
    ),
    "127.0.0.1:8000 -> 8080/tcp",
  );
});
