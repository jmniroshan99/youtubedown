export const isLoopback = (host: string) =>
  ["localhost", "127.0.0.1", "[::1]"].includes(host);

// Only the bundled local HTTP backend uses the development proxy.
export function localProxyTarget(base: string): string | undefined {
  try {
    const url = new URL(base);
    if (
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return undefined;
    url.hostname = "127.0.0.1";
    return url.origin;
  } catch {
    return undefined;
  }
}

export function resolveApiBase(
  base: string,
  development: boolean,
  hostname: string,
  publicDeployment?: { hostname: string; apiBaseUrl: string; retiredApiBaseUrls?: string[] },
) {
  // Public deployment metadata is a fallback only for its exact frontend host.
  // Explicit current configuration and local development retain precedence.
  const fallback = !development && hostname === publicDeployment?.hostname
    ? publicDeployment.apiBaseUrl.trim()
    : "";
  const configured = base.trim().replace(/\/$/, "");
  const retired = fallback && publicDeployment?.retiredApiBaseUrls?.includes(configured);
  // A known retired tunnel is deployment migration data, not general network
  // failover. All other explicit environment values continue taking precedence.
  const clean = (retired ? fallback : configured || fallback).replace(/\/$/, "");
  return development && isLoopback(hostname) && localProxyTarget(clean)
    ? "/backend"
    : clean;
}
