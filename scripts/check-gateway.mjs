// Execute the actual image with the exact Compose security policy and mount.
// No service ports are published; dependencies and backend images are untouched.
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { docker, gatewayFailure, localCompose } from "./diagnose.mjs";

export function validateGateway(runner = docker) {
  const result = runner([
    ...localCompose, "run", "--rm", "--no-deps", "-T", "local-gateway",
    "caddy", "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile",
  ], 60000);
  if (result.status === 0) return { ok: true, message: "PASS: Caddy executes and validates the mounted configuration under the local gateway security settings." };
  if (result.error?.code === "ETIMEDOUT") return { ok: false, message: "FAIL: Gateway image check timed out after 60 seconds. Confirm the Caddy image is available and Docker Desktop is responsive, then run node scripts/check-gateway.mjs again." };
  const failure = gatewayFailure({}, `${result.stdout || ""}\n${result.stderr || ""}`);
  return { ok: false, message: `FAIL: Gateway image startup check (${failure.code}). ${failure.hint}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const result = validateGateway();
  console.log(result.message);
  process.exitCode = result.ok ? 0 : 1;
}
