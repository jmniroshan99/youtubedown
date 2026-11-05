# Host could not be resolved while Service online (1.2.4)

For source-specific certificate failures, run `diagnose-source-tls.bat` and read [SOURCE_TLS_DIAGNOSIS.md](SOURCE_TLS_DIAGNOSIS.md). A healthy backend and successful TCP connection do not imply that source TLS certificates can be verified.

Run repair-downloads.bat after applying the complete source update. This rebuilds backend/egress code so destination DNS is checked at the guarded proxy instead of the internal-only API/worker. The API health endpoint tests core services, not every video website. See [CONNECTION_FIX.md](CONNECTION_FIX.md) for exact steps and source-connectivity checks.

If localhost CORS passes but 127.0.0.1 fails, recreate the API with both base and local Compose files; the local override now supplies both origins without changing your saved environment. The updated diagnostic will not declare READY while either origin is rejected.

# Gateway restarting while API is healthy (1.2.3)

If `local-gateway: restarting` appears with `ECONNREFUSED`, the host gateway has not stayed running. Version 1.2.2 dropped every capability, conflicting with the official Caddy executable's file capability. Apply the 1.2.3 local override and run `repair-connection.bat`; this keeps only NET_BIND_SERVICE for Caddy and preserves its other restrictions. The gateway's exact crash reason was not included in the original report, so the updated diagnostic now classifies startup failures without exposing raw logs. See [CONNECTION_FIX.md](CONNECTION_FIX.md). Do not change Supabase keys or CORS to repair a gateway process crash.

# Healthy in Docker, unreachable from Windows (1.2.2)

If `api: running / healthy` appears with `Health: unreachable`, the internal API readiness check has passed but the host path has not. The earlier internal-only API port mapping could be silently unpublished. Apply the complete 1.2.2 update and run `repair-connection.bat`. See [CONNECTION_FIX.md](CONNECTION_FIX.md). A running worker without its own Docker healthcheck is not automatically broken; API readiness already checks its Celery response.

# Connection quick start (1.2.1)

For the local screenshot error, start with [CONNECTION_FIX.md](CONNECTION_FIX.md) and run `diagnose.bat`. It checks configuration, Docker, API health and both local CORS origins without printing secrets. `start.bat` now waits for the processing backend before opening the frontend.

# Troubleshooting

| Symptom | Check |
|---|---|
| Service unavailable | Open backend `/health`; confirm API, worker, Redis, scheduler and proxy are running. |
| `not_configured` | Set a real `sb_secret_...` key in `backend/.env`, then recreate containers. |
| `redis_unavailable` | Check Redis container health, credentials/network. New Redis state is memory-only; restarting it loses current jobs and counters. |
| `database_unavailable` | Check Supabase URL/server key, applied schema, project availability and backend egress. |
| `worker_unavailable` | Check worker startup, Redis connectivity and Docker memory. |
| Guest access is not enabled | Enable Anonymous Sign-Ins in Supabase Auth. Rebuild/recreate the backend with GUEST_ACCESS_ENABLED=true. |
| Verification fails | Match the public Turnstile site key to the secret configured in Supabase Auth and allow the exact frontend hostnames. |
| Login works but downloads do not | Login uses Supabase directly. The separate download backend still needs configuration. |
| Auth email link fails | Add the exact `/auth/callback` and `/reset-password` URLs to Supabase Auth; open a PKCE link in the same browser used to request it. |
| Netlify page refresh returns 404 | Keep the root `netlify.toml` SPA rewrite. Publish `frontend/dist`, not the repository root. |
| API CORS error | `ALLOWED_ORIGINS` must exactly match the frontend scheme/host/port, without a trailing slash. Recreate API container after editing env. |
| Frontend still uses old API URL | `VITE_*` variables are build-time inputs. Trigger a new Netlify build. |
| Database permission or missing relation | Apply the migration once and review grants/RLS. Do not disable RLS to fix it. |
| `EXTRACTION_FAILED` | The URL may be unsupported, blocked, unavailable or changed. Try a permitted direct sample, then review and upgrade the pinned extractor in a test environment. |
| No MP3 for a direct URL | Audio was not confirmed by metadata/probing. Some sources do not allow probing; do not claim an unverified audio track exists. |
| Upload fails near 50 MB | Check Supabase global and bucket limits for your plan; lower `MAX_FILE_SIZE_MB` as needed. |
| Quota remains after deleting a job | Expected: deleting a current job does not refund the daily quota. It resets at UTC midnight. |
| Cancelled job cannot be deleted yet | Wait until its worker lock clears; the worker may be finishing cancellation/upload cleanup. |
| File says expired | Re-analyze the source or retry while its temporary job is still available. Files are not kept permanently. |
| Video ready but no local file | Use Save file. Browser settings may block automatic downloads or ask for a destination; the app cannot confirm ordinary local-download completion. |
| Current download disappeared | Temporary job metadata expires and Redis restarts lose its memory-only job state. Re-analyze the source; existing device files remain on your device. |
| Worker ran out of memory/disk | Reduce file limit and concurrency, or increase Docker/server resources. Temp media uses a bounded tmpfs. |

Useful commands (run in the project directory; do not post secrets or full source URLs when sharing logs):

```bash
docker compose ps
docker compose logs --tail=80 api worker scheduler
docker compose restart worker
docker compose up -d --force-recreate api worker scheduler
```

For production, add the same `--env-file .env.production -f docker-compose.yml -f docker-compose.production.yml` flags used to start the stack.

## Diagnose Failed to fetch on Windows

The earlier screenshot used `http://127.0.0.1:5173`, while the old environment template allowed only `http://localhost:5173`. That mismatch can cause a CORS failure. It is a plausible cause, not proof that the user's local backend is running. The build-log `Get:` lines only show package downloads, not readiness.

1. Keep Docker Desktop running. From the extracted project folder, run `docker compose up -d --build` and `docker compose ps`.
2. Open `http://127.0.0.1:8000/health`. If it is unreachable, fix the API container/port before changing the frontend. If it returns 503, read its component status and inspect the corresponding logs.
3. Set local `backend/.env` to `ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173` if both are used. Run `docker compose up -d --force-recreate api worker scheduler` after environment changes. The matching scheme, host and port must be exact.
4. Set `frontend/.env.local` to the actual local API URL, normally `VITE_API_BASE_URL=http://localhost:8000`. Restart Vite after changes. Do not accidentally include the frontend URL or `/api` suffix; application routes already include `/api`.
5. In the browser Network panel, inspect the failing request and its OPTIONS preflight. A refused connection, TLS failure, mixed-content block and CORS rejection have different fixes. Browser JavaScript cannot reliably distinguish every network/CORS cause from a TypeError.
6. On Netlify, use the public HTTPS API origin and rebuild. Localhost there points to the visitor's machine. The updated frontend rejects an insecure API on an HTTPS page and rejects loopback APIs on a remote site.

Optional Windows preflight diagnostic (use your actual local frontend origin):

```bat
curl.exe -i http://127.0.0.1:8000/health
curl.exe -i -X OPTIONS http://127.0.0.1:8000/api/analyze -H "Origin: http://127.0.0.1:5173" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: authorization,content-type"
```

A successful preflight should return the same Access-Control-Allow-Origin value, not a wildcard. For production diagnostics, substitute the HTTPS API URL and exact Netlify origin. The app preserves Service unavailable and actionable errors until services work; enabling guest authentication cannot start a missing API or worker.
