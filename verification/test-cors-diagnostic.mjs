import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";

test("diagnostic CLI rejects a healthy API with one denied CORS origin and accepts both exact origins", { skip: process.platform === "win32" }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "videoflow-cors-"));
  let denyNumericOrigin = true;
  const origins = [];
  const server = http.createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"status":"ready"}');
      return;
    }
    origins.push(request.headers.origin);
    if (denyNumericOrigin && request.headers.origin === "http://127.0.0.1:5173") {
      response.writeHead(400);
      response.end("Disallowed CORS origin");
    } else {
      response.writeHead(200, {
        "Access-Control-Allow-Origin": request.headers.origin,
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "authorization,content-type",
      });
      response.end("OK");
    }
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    for (const name of ["scripts", "frontend", "backend", "bin"]) await mkdir(join(folder, name));
    await copyFile(new URL("../scripts/diagnose.mjs", import.meta.url), join(folder, "scripts/diagnose.mjs"));
    for (const name of ["docker-compose.local.yml", "Caddyfile.local", "scripts/check-gateway.mjs"]) await writeFile(join(folder, name), "fixture");
    const base = `http://127.0.0.1:${server.address().port}`;
    await writeFile(join(folder, "frontend/.env"), `VITE_API_BASE_URL=${base}\n`);
    const backendConfig = "SUPABASE_URL=https://example.invalid\nSUPABASE_SECRET_KEY=sb_secret_local-fixture-no-real-access\n";
    await writeFile(join(folder, "backend/.env"), `${backendConfig}ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173\n`);
    await writeFile(join(folder, "bin/docker"), `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==='info')console.log('fixture');
else if(args.includes('ps'))console.log('[]');
else process.exitCode=2;
`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${join(folder, "bin")}${delimiter}${process.env.PATH}` };
    delete env.VITE_API_BASE_URL;
    const run = args => promisify(execFile)(process.execPath, [join(folder, "scripts/diagnose.mjs"), ...args], { env, timeout: 5000 });
    let failure;
    try { await run([]); assert.fail("one rejected CORS origin must prevent READY"); }
    catch (error) { failure = error; }
    assert.equal(failure.code, 1);
    assert.match(failure.stdout, /Health: ready/);
    assert.match(failure.stdout, /Direct API CORS http:\/\/localhost:5173: PASS/);
    assert.match(failure.stdout, /Direct API CORS http:\/\/127\.0\.0\.1:5173: FAIL \(HTTP 400/);
    assert.match(failure.stdout, /NOT READY: The API is healthy, but browser access failed/);
    assert.doesNotMatch(failure.stdout, /^READY:/m);
    assert.match(failure.stdout, /recreate the api container/);
    assert.deepEqual([...origins].sort(), ["http://127.0.0.1:5173", "http://localhost:5173"]);
    assert.doesNotMatch(await readFile(join(folder, "diagnostics.txt"), "utf8"), /sb_secret_local-fixture/);
    denyNumericOrigin = false;
    const success = await run([]);
    assert.match(success.stdout, /^READY: You can start the frontend\.$/m);
    // The local Compose environment overrides the saved env file. Preflight
    // must allow that older file so Compose can recreate the API with both
    // origins, while the later runtime checks still reject an actual denial.
    await writeFile(join(folder, "frontend/.env"), "VITE_API_BASE_URL=http://127.0.0.1:8000\n");
    await writeFile(join(folder, "backend/.env"), `${backendConfig}ALLOWED_ORIGINS=http://localhost:5173\n`);
    const preflight = await run(["--local", "--preflight"]);
    assert.match(preflight.stdout, /local Compose override supplies both exact development origins/);
    assert.doesNotMatch(preflight.stdout, /sb_secret_local-fixture/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(folder, { recursive: true, force: true });
  }
});
