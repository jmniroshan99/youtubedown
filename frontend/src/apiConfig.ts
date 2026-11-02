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
) {
  const clean = base.trim().replace(/\/$/, "");
  return development && isLoopback(hostname) && localProxyTarget(clean)
    ? "/backend"
    : clean;
}
