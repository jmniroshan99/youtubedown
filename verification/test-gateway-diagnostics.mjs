import { test } from "node:test";
import assert from "node:assert/strict";
import { gatewayFailure, inspectGateway } from "../scripts/diagnose.mjs";
import { validateGateway } from "../scripts/check-gateway.mjs";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";

test("gateway failures distinguish executable permissions, config files, memory and port conflicts without leaking logs", () => {
  const secret = "Bearer private-fixture-value";
  for (const [state, evidence, code] of [
    [{ error: `exec /usr/bin/caddy: operation not permitted ${secret}` }, "", "EXECUTION_DENIED"],
    [{}, `exec container process \`/usr/bin/caddy\`: Operation not permitted ${secret}`, "EXECUTION_DENIED"],
    [{}, `Error: reading config from file: open /etc/caddy/Caddyfile: permission denied ${secret}`, "FILE_PERMISSION"],
    [{}, `open /etc/caddy/Caddyfile: is a directory ${secret}`, "CONFIG_MOUNT"],
    [{}, `Error: adapting config: unrecognized directive ${secret}`, "INVALID_CONFIG"],
    [{}, `mkdir /config/caddy: read-only file system ${secret}`, "READ_ONLY_PATH"],
    [{}, `bind: address already in use ${secret}`, "PORT_IN_USE"],
    [{ oomKilled: true }, secret, "MEMORY_LIMIT"],
    [{}, secret, "UNKNOWN"],
  ]) {
    const failure = gatewayFailure(state, evidence);
    assert.equal(failure.code, code);
    assert.ok(!JSON.stringify(failure).includes(secret));
  }
});

test("restarting gateway inspection reports selected state and a fixed diagnosis, not private log content", () => {
  const calls = [];
  const summary = inspectGateway({ ID: "a".repeat(64) }, args => {
    calls.push(args);
    return args[0] === "inspect"
      ? { status: 0, stdout: JSON.stringify({ status: "restarting", exitCode: 1, restartCount: 4, oomKilled: false, healthConfigured: true, error: "" }) }
      : { status: 0, stdout: "", stderr: "exec /usr/bin/caddy: operation not permitted\nBearer private-fixture-value" };
  });
  assert.equal(summary.stopped, true);
  assert.equal(summary.failure.code, "EXECUTION_DENIED");
  assert.match(summary.summary, /exit=1; restarts=4; OOM=no; healthcheck=configured/);
  assert.ok(!JSON.stringify(summary).includes("private-fixture-value"));
  assert.ok(!calls[0][2].includes(".Config.Env"));
  assert.ok(!calls[0][2].includes(".State.Health"));
  assert.deepEqual(calls[1].slice(0, 5), ["logs", "--tail", "30", "--since", "10m"]);
  assert.equal(inspectGateway({ ID: "not-an-id" }, () => assert.fail("invalid IDs must not reach Docker")), null);
});

test("healthy gateway inspection does not read logs and does not label a blank health status as a missing healthcheck", () => {
  let calls = 0;
  const summary = inspectGateway({ ID: "b".repeat(12) }, () => {
    calls++;
    return { status: 0, stdout: JSON.stringify({ status: "running", exitCode: 0, restartCount: 0, oomKilled: false, healthConfigured: true }) };
  });
  assert.equal(calls, 1);
  assert.equal(summary.stopped, false);
  assert.equal(summary.failure, null);
  assert.match(summary.summary, /healthcheck=configured/);
});

test("startup validator preserves Compose service settings and fails closed (mocked Docker runner)", () => {
  const pass = validateGateway((args, timeout) => {
    assert.deepEqual(args.slice(0, 5), ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.local.yml"]);
    assert.ok(args.includes("--no-deps"));
    assert.ok(args.includes("--rm"));
    assert.ok(!args.includes("--service-ports"));
    assert.ok(!args.includes("--privileged"));
    assert.ok(!args.includes("--build"));
    assert.deepEqual(args.slice(-6), ["caddy", "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]);
    assert.equal(timeout, 60000);
    return { status: 0 };
  });
  assert.equal(pass.ok, true);
  const fail = validateGateway(() => ({ status: 1, stderr: "exec /usr/bin/caddy: operation not permitted\nprivate-fixture-value" }));
  assert.equal(fail.ok, false);
  assert.match(fail.message, /EXECUTION_DENIED/);
  assert.ok(!fail.message.includes("private-fixture-value"));
  assert.equal(validateGateway(() => ({ status: null, error: { code: "ETIMEDOUT" } })).ok, false);
});

test("diagnostic CLI stops its readiness wait for a restarting gateway and writes only safe evidence", { skip: process.platform === "win32" }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "videoflow-diagnostic-"));
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests++;
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end('{"status":"gateway_unavailable"}');
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    for (const name of ["scripts", "frontend", "backend", "bin"]) await mkdir(join(folder, name));
    await copyFile(new URL("../scripts/diagnose.mjs", import.meta.url), join(folder, "scripts/diagnose.mjs"));
    for (const name of ["docker-compose.local.yml", "Caddyfile.local", "scripts/check-gateway.mjs"]) await writeFile(join(folder, name), "fixture");
    await writeFile(join(folder, "frontend/.env"), `VITE_API_BASE_URL=http://127.0.0.1:${server.address().port}\n`);
    await writeFile(join(folder, "backend/.env"), "SUPABASE_URL=https://example.invalid\nSUPABASE_SECRET_KEY=sb_secret_local-fixture-no-real-access\n");
    const fixture = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'info') console.log('fixture');
else if (args.includes('ps')) console.log(JSON.stringify([{Service:'api',ID:'a'.repeat(12),State:'running',Health:'healthy'}, {Service:'local-gateway',ID:'b'.repeat(12),State:'restarting',Health:''}]));
else if (args[0] === 'inspect') {
  if (args[2].includes('PortBindings')) console.log('{"8080/tcp":[{"HostIp":"127.0.0.1","HostPort":"8000"}]}');
  else if (args[2].includes('NetworkSettings.Ports')) console.log('{}');
  else console.log(JSON.stringify({status:'restarting',exitCode:1,restartCount:3,oomKilled:false,healthConfigured:true,error:''}));
} else if (args[0] === 'logs') console.error('exec /usr/bin/caddy: operation not permitted\\nBearer fixture-private-log');
else process.exitCode=2;
`;
    await writeFile(join(folder, "bin/docker"), fixture, { mode: 0o755 });
    const env = { ...process.env, PATH: `${join(folder, "bin")}${delimiter}${process.env.PATH}` };
    delete env.VITE_API_BASE_URL;
    let failure;
    try {
      await promisify(execFile)(process.execPath, [join(folder, "scripts/diagnose.mjs"), "--wait", "120"], { env, timeout: 5000 });
      assert.fail("a restarting gateway cannot be ready");
    } catch (error) { failure = error; }
    assert.equal(failure.code, 1);
    assert.match(failure.stdout, /Gateway startup: EXECUTION_DENIED/);
    assert.match(failure.stdout, /Gateway runtime: exit=1; restarts=3; OOM=no; healthcheck=configured/);
    assert.match(failure.stdout, /Checking health once/);
    assert.match(failure.stdout, /CORS: NOT EVALUATED/);
    assert.equal(requests, 1);
    const saved = await readFile(join(folder, "diagnostics.txt"), "utf8");
    for (const text of [failure.stdout, failure.stderr, saved]) {
      assert.ok(!text.includes("fixture-private-log"));
      assert.ok(!text.includes("sb_secret_local-fixture"));
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(folder, { recursive: true, force: true });
  }
});
