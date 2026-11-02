// No dependencies and no credentials in output. Run with the same Node used by Vite.
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function parseEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([\w]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const end = value.indexOf(value[0], 1);
      value = end < 0 ? "" : value.slice(1, end);
    } else value = value.split("#")[0].trim();
    result[match[1]] = value;
  }
  return result;
}
async function envFile(path) {
  try {
    return parseEnv(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}
export function backendUrl(raw) {
  try {
    const url = new URL(raw);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    if (url.hostname === "localhost" && url.protocol === "http:")
      url.hostname = "127.0.0.1";
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}
export const localOrigins = ["http://localhost:5173", "http://127.0.0.1:5173"];
const hints = {
  ready: "API, database, Redis and worker are ready.",
  gateway_unavailable:
    "The local gateway is reachable but cannot reach the API. Check api health and the local_api network.",
  not_configured:
    "Set a server sb_secret_ key in backend/.env, then rebuild/recreate the backend.",
  redis_unavailable: "Redis is not reachable. Check the redis container.",
  database_auth_failed:
    "The server key was rejected or database access was denied. Check the key and permissions in Supabase.",
  database_schema_missing:
    "Complete the first-time youtubedown SQL setup. Do not rerun it over an existing schema.",
  database_unavailable:
    "Check the Supabase project, migration, backend key and egress connection.",
  worker_unavailable:
    "The worker is offline or still starting. Check the worker and Redis containers.",
  unreachable:
    "No API response reached this PC. Check local-gateway startup and its published port 8000; see the container diagnostics above.",
  invalid_response:
    "The API URL returned an unexpected response. It may point to the frontend or another service.",
};
export function transportCode(error) {
  const code = error?.cause?.code || error?.code;
  const allowed = [
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
    "CERT_HAS_EXPIRED",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  ];
  return allowed.includes(code)
    ? code
    : error?.name === "TimeoutError"
      ? "TIMEOUT"
      : "NETWORK_ERROR";
}
export async function probeHealth(base, fetcher = fetch) {
  let response;
  try {
    response = await fetcher(`${base}/health`, {
      signal: AbortSignal.timeout(12000),
      redirect: "error",
    });
  } catch (error) {
    return {
      ok: false,
      status: "unreachable",
      message: hints.unreachable,
      transport: transportCode(error),
    };
  }
  const body = await response.json().catch(() => null);
  const valid =
    response.headers.get("content-type")?.includes("application/json") &&
    body &&
    Object.hasOwn(hints, body.status);
  const status =
    valid && !(body.status === "ready" && !response.ok)
      ? body.status
      : "invalid_response";
  return {
    ok: response.ok && status === "ready",
    status,
    message: hints[status],
    httpStatus: response.status,
  };
}
export async function probeCorsDetailed(base, origin, fetcher = fetch) {
  try {
    const response = await fetcher(`${base}/api/analyze`, {
      method: "OPTIONS",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    const headers = (response.headers.get("access-control-allow-headers") || "")
      .toLowerCase()
      .split(",")
      .map((s) => s.trim());
    const ok =
      response.ok &&
      response.headers.get("access-control-allow-origin") === origin &&
      (response.headers.get("access-control-allow-methods") || "")
        .split(",")
        .map((s) => s.trim())
        .includes("POST") &&
      headers.includes("authorization") &&
      headers.includes("content-type");
    return { reachable: true, ok, httpStatus: response.status };
  } catch (error) {
    return { reachable: false, ok: false, transport: transportCode(error) };
  }
}
export async function probeCors(base, origin, fetcher = fetch) {
  return (await probeCorsDetailed(base, origin, fetcher)).ok;
}
export function portBindingsSummary(raw) {
  try {
    const data = JSON.parse(raw);
    const entries = [];
    for (const [port, bindings] of Object.entries(data || {})) {
      if (!/^\d+\/(tcp|udp)$/.test(port) || !Array.isArray(bindings)) continue;
      for (const item of bindings) {
        if (
          /^[0-9a-f:.]+$/i.test(item?.HostIp || "") &&
          /^\d+$/.test(item?.HostPort || "")
        ) {
          entries.push(`${item.HostIp}:${item.HostPort} -> ${port}`);
        }
      }
    }
    return entries.join(", ") || "none";
  } catch {
    return "unknown";
  }
}
export const localCompose = [
  "compose",
  "-f",
  "docker-compose.yml",
  "-f",
  "docker-compose.local.yml",
];
export function docker(args, timeout = 10000) {
  return spawnSync("docker", args, {
    encoding: "utf8",
    timeout,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
}

// Never return raw runtime errors or logs: they may contain request data.
export function gatewayFailure(state = {}, evidence = "") {
  const text = `${typeof state.error === "string" ? state.error : ""}\n${evidence}`.slice(0, 131072);
  if (state.oomKilled === true)
    return { code: "MEMORY_LIMIT", hint: "Docker killed the gateway for exceeding its memory limit. Check Docker Desktop memory availability and the gateway limit." };
  if (/(?:exec[^\n]{0,120}\bcaddy\b[^\n]{0,60}|\/usr\/bin\/caddy:\s*)(operation not permitted|permission denied)/i.test(text))
    return { code: "EXECUTION_DENIED", hint: "Docker could not execute Caddy. Apply the supplied local Compose file with cap_add: [NET_BIND_SERVICE], then run repair-connection.bat." };
  if (/Caddyfile[^\n]{0,160}(no such file|is a directory)/i.test(text))
    return { code: "CONFIG_MOUNT", hint: "Caddyfile.local is missing or mounted as a directory. Extract the complete update and recreate only local-gateway." };
  if (/address already in use|port is already allocated/i.test(text))
    return { code: "PORT_IN_USE", hint: "A required port is already in use. Check for another local gateway or API listener; do not delete application data." };
  if (/read-only file system/i.test(text))
    return { code: "READ_ONLY_PATH", hint: "The gateway tried to write outside its temporary directory. Restore the supplied XDG paths and /tmp mount; keep the root filesystem read-only." };
  if (/permission denied/i.test(text))
    return { code: "FILE_PERMISSION", hint: "The gateway cannot access a required file. Check that Caddyfile.local is readable and the /tmp mount is writable." };
  if (/adapting config|unrecognized directive|parsing caddyfile|loading initial config/i.test(text))
    return { code: "INVALID_CONFIG", hint: "Caddy rejected its configuration. Restore Caddyfile.local and run node scripts/check-gateway.mjs." };
  return { code: "UNKNOWN", hint: "The gateway startup error was not recognized. Run node scripts/check-gateway.mjs; inspect gateway logs locally if needed, and redact private data before sharing." };
}

export function inspectGateway(row, runner = docker) {
  if (!/^[0-9a-f]{12,64}$/i.test(row?.ID || "")) return null;
  // Select fields explicitly. In particular, never inspect environment or health log output.
  const format = '{"status":{{json .State.Status}},"exitCode":{{json .State.ExitCode}},"oomKilled":{{json .State.OOMKilled}},"restartCount":{{json .RestartCount}},"error":{{json .State.Error}},"healthConfigured":{{if .Config.Healthcheck}}true{{else}}false{{end}}}';
  const result = runner(["inspect", "--format", format, row.ID]);
  if (result.status !== 0) return null;
  let state;
  try { state = JSON.parse(result.stdout); } catch { return null; }
  const stopped = ["restarting", "exited", "dead"].includes(state?.status);
  const number = value => Number.isSafeInteger(value) && value >= 0 ? value : "unknown";
  const summary = `Gateway runtime: exit=${number(state.exitCode)}; restarts=${number(state.restartCount)}; OOM=${state.oomKilled === true ? "yes" : "no"}; healthcheck=${state.healthConfigured === true ? "configured" : "not configured"}`;
  let failure = null;
  if (stopped) {
    // Bounded gateway-only evidence is classified in memory, never printed or saved.
    const logs = runner(["logs", "--tail", "30", "--since", "10m", row.ID]);
    failure = gatewayFailure(state, logs.status === 0 ? `${logs.stdout || ""}\n${logs.stderr || ""}` : "");
  }
  return { stopped, summary, failure };
}
export async function main(args = process.argv.slice(2)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  process.chdir(root);
  const lines = [
    "youtubedown connection diagnostic",
    `Time: ${new Date().toISOString()}`,
  ];
  console.log(lines.join("\n"));
  const output = (text) => {
    lines.push(text);
    console.log(text);
  };
  let frontend = {};
  for (const name of [
    ".env",
    ".env.local",
    ".env.development",
    ".env.development.local",
  ]) {
    frontend = {
      ...frontend,
      ...(await envFile(resolve(root, "frontend", name))),
    };
  }
  if (process.env.VITE_API_BASE_URL !== undefined)
    frontend.VITE_API_BASE_URL = process.env.VITE_API_BASE_URL;
  const backend = await envFile(resolve(root, "backend/.env"));
  const base = backendUrl(frontend.VITE_API_BASE_URL);
  let preflight = true;
  for (const name of ['docker-compose.local.yml', 'Caddyfile.local', 'scripts/check-gateway.mjs']) {
    try { await readFile(resolve(root, name), 'utf8'); }
    catch { output(`FAIL: ${name} is missing. Extract the complete youtubedown update.`); preflight = false; }
  }
  if (!base) {
    output(
      "FAIL: VITE_API_BASE_URL is missing or invalid. Use http://127.0.0.1:8000 for this local stack.",
    );
    preflight = false;
  } else if (args.includes("--local") && base !== "http://127.0.0.1:8000") {
    output(
      "FAIL: start.bat runs the bundled local backend. Set VITE_API_BASE_URL=http://127.0.0.1:8000, or run Vite separately for a remote backend.",
    );
    preflight = false;
  } else output("PASS: Backend URL has a valid format.");
  if (
    !backend.SUPABASE_SECRET_KEY?.startsWith("sb_secret_") ||
    /placeholder|replace|test_only|your_secret/i.test(
      backend.SUPABASE_SECRET_KEY,
    )
  ) {
    output(
      "FAIL: backend/.env needs the real server sb_secret_ key from Supabase API Keys. A publishable key cannot run the backend. Do not send the secret in chat.",
    );
    preflight = false;
  } else
    output(
      "PASS: A server secret is configured. Its validity will be checked by /health.",
    );
  if (!backendUrl(backend.SUPABASE_URL)?.startsWith("https://")) {
    output("FAIL: backend/.env needs a valid HTTPS SUPABASE_URL.");
    preflight = false;
  }
  if (args.includes("--local")) {
    // The local Compose environment overrides env_file. Do not reject an old
    // saved ALLOWED_ORIGINS value that the local override no longer uses.
    output("INFO: The local Compose override supplies both exact development origins. Runtime CORS checks verify the running API after recreation.");
  }
  const dockerReady =
    docker(["info", "--format", "{{.ServerVersion}}"]).status === 0;
  if (!dockerReady) {
    output(
      "FAIL: Docker engine is not available. Start Docker Desktop in Linux-container mode.",
    );
    preflight = false;
  } else output("PASS: Docker engine is running.");
  if (args.includes("--preflight")) return preflight ? 0 : 1;
  let gatewayStopped = false;
  if (dockerReady) {
    const ps = docker([...localCompose, "ps", "--all", "--format", "json"]);
    try {
      const raw = ps.stdout.trim();
      const services = raw.startsWith("[")
        ? JSON.parse(raw)
        : raw
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
      for (const name of [
        "api",
        "local-gateway",
        "worker",
        "scheduler",
        "redis",
        "egress",
      ]) {
        const row = services.find((s) => s.Service === name);
        const safe = (value) =>
          String(value || "not configured")
            .replace(/[^a-zA-Z0-9 _.-]/g, "")
            .slice(0, 40);
        output(
          `Container ${name}: ${row ? `${safe(row.State)} / ${row.Health ? safe(row.Health) : ["api", "redis", "local-gateway"].includes(name) ? "health status not reported" : "no health check"}` : "missing"}`,
        );
      }
      for (const name of ["api", "local-gateway"]) {
        const row = services.find((s) => s.Service === name);
        if (!/^[0-9a-f]{12,64}$/i.test(row?.ID || "")) continue;
        const requested = docker([
          "inspect",
          "--format",
          "{{json .HostConfig.PortBindings}}",
          row.ID,
        ]);
        const actual = docker([
          "inspect",
          "--format",
          "{{json .NetworkSettings.Ports}}",
          row.ID,
        ]);
        output(
          `Ports ${name}: requested ${portBindingsSummary(requested.stdout)}; actually published ${portBindingsSummary(actual.stdout)}`,
        );
      }
      const api = services.find((s) => s.Service === "api");
      const gateway = inspectGateway(services.find((s) => s.Service === "local-gateway"));
      if (gateway) {
        output(gateway.summary);
        gatewayStopped = gateway.stopped;
        if (gateway.failure) output(`Gateway startup: ${gateway.failure.code} — ${gateway.failure.hint}`);
      }
      if (
        api?.Health === "healthy" &&
        !services.some((s) => s.Service === "local-gateway")
      ) {
        output(
          "API is healthy inside Docker but the local gateway is missing. Run repair-connection.bat from the complete youtubedown folder.",
        );
      }
    } catch {
      output(
        "Container status could not be read. Use the two-file local Compose command from CONNECTION_FIX.md.",
      );
    }
  }
  let health = { ok: false, status: "unreachable", message: hints.unreachable };
  let corsReady = false;
  if (base) {
    const index = args.indexOf("--wait");
    const seconds =
      index >= 0 ? Math.min(180, Math.max(0, Number(args[index + 1]) || 0)) : 0;
    const deadline = Date.now() + seconds * 1000;
    if (gatewayStopped)
      output("The gateway is stopped or restarting. Checking health once; waiting cannot repair a startup failure.");
    else if (seconds)
      output(`Waiting up to ${seconds} seconds for the backend to be ready…`);
    let previous;
    do {
      health = await probeHealth(base);
      if (health.status !== previous)
        output(
          `Health: ${health.status}${health.httpStatus ? ` (HTTP ${health.httpStatus})` : ""}${health.transport ? ` (${health.transport})` : ""} — ${health.message}`,
        );
      previous = health.status;
      if (
        health.ok ||
        gatewayStopped ||
        Date.now() >= deadline ||
        [
          "not_configured",
          "database_auth_failed",
          "database_schema_missing",
        ].includes(health.status)
      )
        break;
      await delay(2000);
    } while (Date.now() < deadline);
    if (["unreachable", "gateway_unavailable"].includes(health.status)) {
      output(
        "CORS: NOT EVALUATED because the API is not reachable. Repair the connection before changing CORS settings.",
      );
    } else {
      const results = await Promise.all(localOrigins.map(origin => probeCorsDetailed(base, origin)));
      corsReady = results.every(cors => cors.ok);
      for (const [index, origin] of localOrigins.entries()) {
        const cors = results[index];
        output(
          `Direct API CORS ${origin}: ${cors.ok ? "PASS" : cors.reachable ? `FAIL (HTTP ${cors.httpStatus}; check exact ALLOWED_ORIGINS)` : `NOT EVALUATED (${cors.transport})`}`,
        );
      }
      if (!corsReady) output(args.includes("--local")
        ? "Browser access is not ready. Recreate the api container using docker-compose.yml and docker-compose.local.yml together. The local override supplies both exact origins; restarting an old container does not apply its environment changes."
        : "Browser access is not ready. Include both exact local origins in the backend ALLOWED_ORIGINS setting and recreate the api container. Local Compose supplies these origins automatically when both local files are selected.");
    }
  }
  output(
    health.ok && preflight && corsReady
      ? "READY: You can start the frontend."
      : health.ok && !corsReady
        ? "NOT READY: The API is healthy, but browser access failed. Resolve the CORS errors above."
        : "NOT READY: Resolve the configuration or health failures above. Do not change RLS or make Storage public.",
  );
  output(
    "Restart Vite after frontend env changes. Recreate backend containers after backend env changes.",
  );
  output(
    "More details: docs/CONNECTION_FIX.md. Container logs are not included because they can contain private data.",
  );
  await writeFile(resolve(root, "diagnostics.txt"), lines.join("\n") + "\n");
  console.log(
    "Saved diagnostics.txt (no keys, tokens, environment dumps or container logs).",
  );
  return health.ok && preflight && corsReady ? 0 : 1;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error(
        "Diagnostic could not finish. Check file permissions and Node installation. No credentials were printed.",
      );
      process.exitCode = 1;
    });
}
