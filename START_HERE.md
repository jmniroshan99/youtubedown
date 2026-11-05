# youtubedown 1.5.0 — Start here

The frontend runs on Netlify or local Vite. Video analysis and processing require the separate FastAPI/Celery/Redis backend. Supabase provides verified identities, provider settings and temporary private file staging. Uploading the frontend alone does not start processing services.

## Upgrade an existing installation

1. Finish or cancel current jobs. Back up your real environment files.
2. Copy the updated source files into your existing project directory and choose **Replace files**. Keep `backend/.env`, frontend environment files and installed `node_modules`. The distribution excludes real secrets.
3. Run `setup.bat` if dependencies have not been installed or a clean install is needed.
4. Merge the retention/job-state options from `backend/.env.example` into your server environment as needed. `MEDIA_FRAGMENT_CONCURRENCY` defaults to 4 and is bounded to 1–8; reduce it for constrained hardware or networks. Keep your real Supabase server secret and existing project URL.
5. Keep Docker Desktop running, close the old frontend terminal, and run **repair-downloads.bat**. This rebuilds the changed API/worker/scheduler code and preserves the Compose project, accounts and volumes.
6. Require `/health` readiness and both local exact-origin CORS probes to pass. Open `http://127.0.0.1:5173` when Vite is ready. Keep using the same hostname to reuse that origin's guest session.
7. Paste a supported video URL. Only analysis starts. Select **Video** or **Audio**, choose an available format/quality and click **Download**. Processing starts only after that click. When ready, the requested browser download starts, with **Save file** available if browser settings require interaction.

No database reset is required. Do not rerun the original migration over an existing schema or delete historical rows. New jobs no longer use permanent download history, and the UI shows **Current downloads**.

## First-time local setup on Windows 11

Install Node.js 24 and Docker Desktop with WSL 2. Keep Docker Desktop running.

1. Extract the project and double-click `setup.bat`. It installs frontend dependencies and copies environment templates without overwriting existing environment files.
2. In Supabase, review and apply the retained original migration in `supabase/migrations` once to a new project. It creates provider/profile tables, RLS and the private `downloads` bucket. Legacy download tables may exist from that migration but the new runtime does not use them for new jobs.
3. Put a valid `SUPABASE_SECRET_KEY` only in `backend/.env`. Never put server secrets in `VITE_*` variables.
4. Enable **Anonymous Sign-Ins** in Supabase Auth for guest access; keep optional Email sign-in enabled. For public deployment, configure supported bot protection as described in [docs/GUEST_ACCESS.md](docs/GUEST_ACCESS.md).
5. Configure Supabase Auth Site URL and exact callback/reset redirect URLs for the frontend origin used. If using both local hostnames, allow `http://localhost:5173/auth/callback`, `http://127.0.0.1:5173/auth/callback` and each origin's `/reset-password` route.
6. Run `start.bat`. Initial image/dependency downloads can take several minutes. Wait for backend readiness before using the app.
7. Paste a video URL you can download. A guest session is created or reused as needed. Complete visible bot verification if configured.

`stop.bat` stops services without removing the Redis volume. Close the frontend terminal to stop Vite. On an 8 GB RAM PC, reduce worker concurrency from two to one if Docker is short of memory.

## Create accounts

Use Create account for the four-field email form, or Continue with Google/Facebook after configuring those providers. Follow [docs/SOCIAL_SIGN_IN.md](docs/SOCIAL_SIGN_IN.md) for provider console settings and exact production callback URLs. Google/Facebook are enabled in the 5 November check, but a diagnostic cancellation returned to localhost, so the owner must correct Supabase URL Configuration. Run `diagnose-auth.bat` to check the return path and backend health. No new VITE secret is required. Preserve email confirmation and configure production email delivery.

## Download behavior

Pasting analyzes only; it never automatically chooses and starts a media job. Choose **Video** or **Audio**, select a format/quality, then click **Download**. A 720p MP4 with audio is suggested when available to reduce transfer size; higher and lower available qualities remain selectable. Audio offers the actual available formats, such as MP3. There is no upscaling. Server duration and size limits still apply.

The suggested filename is `youtubedown - Video Title.mp4`, or the actual selected output extension. Valid Unicode titles are preserved; unsafe filename characters are sanitized. Your browser may add a duplicate-number suffix or ask for a destination. **Save file** reuses the prepared file rather than creating another job.

The web app does not store video bytes in localStorage, IndexedDB or an application cache. Files save through the ordinary browser download manager. **Video ready** means preparation finished; **Download started** means the browser transfer was requested. Neither claims the app confirmed a local disk write.

## Backend hosting

Use a Linux host that supports Docker Compose 2.24.4 or later, a public API domain, and HTTPS.

1. Set `backend/.env` with your Supabase server settings and operating limits.
2. Set exact production frontend origins in `ALLOWED_ORIGINS`. Do not use wildcard origins or trailing slashes.
3. Copy `.env.production.example` to `.env.production`, set `API_DOMAIN` and `API_EMAIL`, point DNS to the server and allow ports 80/443.
4. Run the existing production command:

```bash
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.production.yml up -d --build
```

Keep Redis, API, workers and scheduler on their existing private networks. Retain the guarded egress proxy, `--no-proxy-headers` and the explicitly trusted gateway address. Do not expose Redis/proxy ports or attach processing workers directly to a public network. Keep the scheduler running for recovery and cleanup.

## Netlify hosting

1. Import the repository into Netlify. Keep root `netlify.toml`: base `frontend`, build `npm run build`, publish `dist`, Node 24.
2. Configure `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, and **the real HTTPS backend origin** in `VITE_API_BASE_URL`.
3. Configure `VITE_TURNSTILE_SITE_KEY` if Supabase Auth bot protection uses Turnstile. Its secret belongs in Supabase Auth, never in the frontend.
4. Rebuild after changing `VITE_*` variables. Add the exact Netlify origin and `/auth/callback` and `/reset-password` URLs to Supabase Auth settings, and the exact origin to backend CORS.
5. Verify direct refreshes of `/downloads`, `/settings`, `/auth/callback` and `/reset-password` use the SPA fallback. Verify favicon assets resolve on those routes.

Netlify serves the frontend only. Large files use temporary private Storage signed links and never pass through Netlify Functions. Backend URL changes require a frontend rebuild; server environment changes require container recreation.

## Temporary jobs, privacy and limits

- New job metadata is short-lived in Redis. New video URLs/titles/file references are not retained as permanent database history.
- Existing accounts, settings and legacy records remain intact. Redis AOF/snapshot writes are disabled for new state; restarting Redis loses current jobs, queue messages and limiter counters. Existing volume identifiers and any older files are preserved, not scrubbed.
- Worker temporary files and private staging objects are cleaned after bounded retention. An independent Storage sweep removes expired objects in the dedicated temporary namespace after Redis state loss. Signed-link lifetime and transfer grace are included in cleanup decisions. Do not delete staged objects immediately after issuing a URL.
- Limits and retention are configured in `backend/.env.example`. Guest limits remain stricter than account limits. Creating a fresh guest identity does not reset shared-network abuse limits.
- Clearing browser data or ending a guest session can remove access to its current jobs. Files already saved through your browser remain on your device.

See [docs/TEMPORARY_DOWNLOADS.md](docs/TEMPORARY_DOWNLOADS.md), [docs/SECURITY.md](docs/SECURITY.md), [docs/CONNECTION_FIX.md](docs/CONNECTION_FIX.md) and [docs/VERIFICATION.md](docs/VERIFICATION.md).
