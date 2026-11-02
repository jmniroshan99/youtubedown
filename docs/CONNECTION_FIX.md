# youtubedown — Connection, gateway and video DNS setup

The latest report confirms that the earlier gateway repair worked: the gateway stays running, port 8000 is published, and /health returns ready. Video analysis now fails with “Host could not be resolved.” The localhost CORS test passes, while 127.0.0.1 receives HTTP 400.

## Cause and correction

The API called socket.getaddrinfo on the video's hostname before queueing analysis. API and worker containers intentionally have only internal Docker networks. HTTP_PROXY does not affect direct DNS lookups, so a healthy API can still fail this local lookup. Docker documents that internal-only containers cannot resolve external names through an upstream resolver. The same incorrect lookup occurred in worker analysis/downloads, thumbnails and administrator provider tests.

Version 1.2.4 validates URL syntax and literal addresses inside the application, then lets the mandatory guarded proxy resolve the destination when opening the connection. The proxy still checks every DNS answer and connects to a validated numeric address. Every new destination, including redirects and media segment hosts, must pass that gate. API/workers do not gain public networking, a custom public DNS server or an unguarded fallback.

A saved backend environment can also contain only localhost in ALLOWED_ORIGINS. The local Compose override now explicitly configures both http://localhost:5173 and http://127.0.0.1:5173 on the API. Production keeps its existing exact-origin configuration. Diagnostics no longer say READY if either CORS probe fails.

## Apply this update on Windows

1. Close the old frontend terminal and keep Docker Desktop running. Finish or cancel active jobs before updating worker containers.
2. Back up your environment files. Copy all files from the extracted project folder into the existing project, replacing source files. Preserve backend/.env, frontend environment files and node_modules.
3. Run **repair-downloads.bat** from File Explorer or Command Prompt. The launcher should identify **youtubedown**.
4. This update changes backend and egress code, so the repair rebuilds those images and recreates affected containers. Existing Docker layers are reused where possible. It does not delete accounts, database records or volumes, and it does not run SQL.
5. Review the worker-to-egress checks, then confirm API readiness and both CORS checks pass. The temporary Caddy image validator remains enabled.
6. Continue using your usual frontend address: http://localhost:5173 or http://127.0.0.1:5173. Browser sessions are scoped to an origin, so using the same hostname preserves access to that origin's guest session/current jobs.
7. Re-analyze the video URL. Previously failed analysis results are not converted to successful results.

No Supabase key change, database migration or frontend dependency reinstall is required. This source update does require the backend rebuild above; the earlier gateway-only repair-connection.bat cannot replace it.

## Manual commands

Run from the project folder:

```bat
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.local.yml exec -T worker python -m app.egress_check
node scripts\diagnose.mjs --local --wait 120
start.bat --no-build
```

The worker check opens a CONNECT tunnel through the configured egress proxy to the fixed target www.youtube.com:443, then closes it without downloading a page or video. It also verifies that a private metadata address is rejected. It prints only fixed result categories. A successful tunnel checks proxy routing, source-host DNS and TCP connectivity; it does not prove TLS, extractor support, source authorization or a complete video download.

| Egress result | Meaning and next step |
|---|---|
| CONNECTED | The proxy resolved and reached the source host. Re-analyze the URL in the application. |
| TARGET_REJECTED for the metadata test | Expected: the private target is blocked. |
| DNS_RESOLUTION_FAILED | External DNS failed in egress itself. Check Docker Desktop's DNS/network and any VPN or network policy; do not add public networks to workers. |
| PROXY_UNREACHABLE | The worker cannot reach its configured proxy. Check egress is running and both services share the private network. |
| CONNECTION_TIMEOUT | A proxy/source connection timed out. Check outbound network and source availability; this alone does not prove the proxy is offline. |
| UPSTREAM_UNAVAILABLE | The proxy or source connection returned another error. Check the outbound network/source availability. |
| PROXY_CONFIGURATION | The diagnostic requires the bundled plain HTTP guarded proxy configuration. Restore MEDIA_PROXY for this local stack. |

If private metadata is reported CONNECTED, stop using the download service and restore the supplied guarded proxy configuration. Do not bypass that check by making Storage public or loosening URL restrictions.

## If a failure remains

Run diagnose.bat and share diagnostics.txt. That report checks API health, published ports, gateway startup and both local origins without exposing keys or raw logs. Also share the fixed PASS/FAIL lines from the worker egress check. No environment files, tokens, raw extractor output or source URL query tokens are needed.

A real website may impose its own login, age, geographic, DRM or bot restrictions. This update fixes application DNS routing and local CORS; it does not promise every video URL will be downloadable. The interface must continue to show real errors instead of invented formats or completed downloads.

The existing 1.2.3 gateway capability fix, private Storage, owner checks, guest quotas, guarded egress and Netlify architecture remain. Production continues to use only its production override and real HTTPS API URL; never combine local and production overrides.

## References

- Docker's explanation of external DNS on internal-only networks: https://github.com/moby/moby/security/advisories/GHSA-mq39-4gv4-mvpx
- yt-dlp proxy configuration: https://github.com/yt-dlp/yt-dlp#network-options
- Previous Caddy image capability conflict: https://github.com/caddyserver/caddy-docker/issues/396
