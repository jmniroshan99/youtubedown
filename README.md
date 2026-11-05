# youtubedown 1.3.0

To publish the frontend from GitHub, follow [Netlify + GitHub deployment](docs/NETLIFY_GITHUB_DEPLOY.md). The repository already includes the required root `netlify.toml`; downloads also require the separately hosted public HTTPS backend.

For the selected free/no-card setup using this PC, run `start-netlify-backend.bat` and follow [PC backend tunnel setup](docs/PC_BACKEND_TUNNEL.md). Keep the PC and Docker running; the temporary URL printed by the script belongs in Netlify's existing `VITE_API_BASE_URL` variable. `stop-netlify-backend.bat` closes public tunnel access.

The tunnel start script also updates public endpoint metadata in `frontend/src/publicDeployment.json` after verification. Publishing that file through GitHub supplies a fallback when the API variable is empty on the exact production hostname. Explicit environment configuration remains primary; local development and other sites retain their own configuration.

Website support update (5 November 2026): see [English setup](docs/WEBSITE_SUPPORT_SETUP.md) and the [current verification report](docs/WEBSITE_SUPPORT_VERIFICATION.md). The tested yt-dlp pin remains 2026.10.26. Run `verify-website-support.bat` for the isolated Linux backend checks and locked frontend build/tests. Earlier release notes below are retained for context.

Paste a supported video link, choose **Video** or **Audio** and its quality, then select **Download**. Save the result as **youtubedown - Video Title.mp4** or the chosen audio extension. Guest access does not require an email or password. The modern red play/download icon, crimson accents, warm-white light theme and charcoal dark theme share one visual system. Inter, optional accounts and private ownership checks are retained.

Start with [START_HERE.md](START_HERE.md). This is a complete source distribution, not a running hosted service. The frontend requires a separately configured backend and Supabase project. An unavailable backend produces an actionable service error, never fabricated media.

## What changed

- Application branding, metadata, manifest and the new red play/download favicons use **youtubedown**.
- Pasting a complete supported URL starts analysis only. No media job or file download starts until the user chooses Video/Audio, selects an available format and clicks Download. A smaller 720p MP4 is suggested when available; the user can choose other actual qualities without upscaling.
- The app initiates one normal browser download when ready. **Save file** remains available because browser settings can require user interaction.
- New jobs and job events use expiring Redis state rather than permanent Supabase download-history rows. **Current downloads** shows available temporary jobs.
- Video files use isolated worker temporary directories and, where needed, temporary private Supabase Storage staging. The scheduler removes expired staged objects. No video bytes are stored in database tables or browser localStorage.
- Existing accounts, settings, historical rows, Auth storage keys, Docker project identifiers, Redis volume and deployment architecture are preserved.

## Architecture

The React/Vite frontend runs on Netlify. Auth and provider settings remain in Supabase. FastAPI verifies Supabase identities and job ownership. Redis holds the queue, short-lived job state, idempotency and expiring quotas. Celery runs yt-dlp and FFmpeg through the existing guarded egress proxy. Prepared files are delivered directly through private short-lived Storage URLs; Netlify never proxies large videos.

Media processing remains server-side. The browser's standard download mechanism writes the file to its configured Downloads location or shows its Save dialog. The app cannot silently choose arbitrary folders or confirm ordinary browser-download completion. **Download started** means a browser download was requested, not that a local write was verified.

## Easy accounts and social sign-in

Create an account with four fields: Full name, Email address, Password and Confirm password. Continue with Google and Continue with Facebook use real Supabase OAuth; email and guest access remain available. Name is display metadata only. No provider secret belongs in the frontend.

The public Auth settings checked for this project on 2 November 2026 showed Email enabled, signups allowed and email confirmation required; Google and Facebook were disabled. The code cannot enable provider applications by itself. Follow [docs/SOCIAL_SIGN_IN.md](docs/SOCIAL_SIGN_IN.md) to configure the provider credentials and exact callbacks. Public email delivery also needs appropriate SMTP setup. No real account creation or social login was performed during verification.

## Website compatibility

The app checks public video pages through supported extractors and generic embedded-media detection; the source list is not an exhaustive whitelist. Generic embedded media now uses its extracted media URL when codec/duration probing is needed, and actual native containers are offered without pretending they are MP4. Errors distinguish unsupported links, source login/restrictions, region/network failures and disabled sources.

No downloader can guarantee every website. Some sources hide media, change their players, restrict server access or protect streams. App sign-in does not sign into a source website. See [docs/SOURCE_SUPPORT.md](docs/SOURCE_SUPPORT.md). Existing SSRF protections, private staging and quotas remain enforced.

## Download selection and speed

Pasting a link analyzes available formats only. Choose Video or Audio and the desired quality, then click Download. The suggested smaller MP4 reduces transferred data when selected; larger available resolutions remain selectable. No processing job starts from merely changing a selection.

Native segmented DASH/HLS downloads use up to four fragment requests at once. The server setting `MEDIA_FRAGMENT_CONCURRENCY` accepts 1–8 and defaults to 4; use a smaller value on constrained networks or hardware. Client format data cannot override this limit. Progress IPC is bounded while every event still receives its size check. Video/audio stream-copy merges are retained; MP3 extraction still needs encoding.

These changes reduce avoidable work and allow parallel fragment retrieval. They do not guarantee a fixed speed increase: source throttling, protocol, API-to-Storage upload, CPU and network bandwidth still matter. Run `repair-downloads.bat` after copying this update to rebuild changed backend code. No database reset is needed.

## Project layout

| Path | Purpose |
|---|---|
| `frontend/src` | React interface, verified guest/account sessions, API client and owner-scoped queries |
| `frontend/public` | Favicons, manifest and self-hosted Inter |
| `backend/app` | Verified HTTP API, Redis job lifecycle, media processing and cleanup |
| `egress` | Public-address-only guarded proxy |
| `supabase/migrations` | Retained original setup, RLS, provider registry and private bucket |
| `scripts` | Safe backend, gateway and CORS diagnostics |
| `verification` | Deployment and schema checks |
| `docs` | Setup, security, operation and verification status |

## Build and check

```bash
npm --prefix frontend ci
npm --prefix frontend run build
npm --prefix frontend run lint
npm --prefix frontend test
cd backend
python -m pip install -r requirements-dev.txt
python -m pytest -q
ruff check app tests ../egress/proxy.py
```

Requirements: Node.js 24, Docker Desktop/Compose for the full stack, and Python 3.12 plus FFmpeg when running backend/media tests outside containers. Dependencies are pinned in the included npm and Python lockfiles.

Run `setup.bat`, configure the server secret and Supabase Auth, then run `start.bat` on Windows. Existing installations should use `repair-downloads.bat` for the backend/worker update. Keep environment files and installed dependencies when replacing source files. See [docs/VERIFICATION.md](docs/VERIFICATION.md) for checks actually performed and remaining live-deployment tests.

## Data and retention

New downloads do not create permanent video-history records. Temporary job metadata has a bounded TTL, and short-lived quota counters are separate from jobs. The supplied Redis configuration disables AOF and snapshot writes for new operational state. Restarting Redis loses current jobs, queue messages, idempotency and quota counters. Existing volume identifiers and older files are preserved; this update does not scrub historical volume contents or infrastructure backups. An independent Storage sweep finds expired objects in the dedicated temporary namespace even after Redis state is lost. No new download history is written to Postgres.

Existing legacy download rows and files are deliberately not deleted by this update. Review older retained data separately before applying an explicit cleanup policy. Do not disable RLS or make the `downloads` bucket public.

Temporary objects must remain available long enough for issued signed links and transfers. Keep the scheduler running. Do not delete a file immediately after issuing a URL or assume the browser can confirm a normal download completed. See [docs/TEMPORARY_DOWNLOADS.md](docs/TEMPORARY_DOWNLOADS.md).

## Deployment

Retain the root `netlify.toml`, frontend base directory, SPA fallback, `VITE_API_BASE_URL` and Supabase environment variables. Production uses the real HTTPS API origin and exact frontend CORS origins. Keep the separate Docker HTTPS gateway; local Windows uses the existing loopback gateway and local override. Do not combine local and production overrides.

Rebranding changes display metadata only. The internal Compose project name remains `videoflow` so existing resources are reused. Auth/theme storage keys also remain stable so sessions and preferences survive the update.
