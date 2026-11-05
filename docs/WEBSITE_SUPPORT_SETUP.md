# Website support update — setup

This update keeps the existing Netlify frontend, root netlify.toml, separate FastAPI/Celery/Redis backend, Supabase connections, environment names, authentication storage keys, Docker project/service names and volumes. There is no new migration and no database reset.

## Existing Windows installation

1. Finish or cancel active jobs. Back up your existing source and environment files.
2. Extract this distribution and replace the source files. Retain your existing `backend/.env` and `frontend/.env.local`; the ZIP contains examples only.
3. Open Docker Desktop. Run `repair-downloads.bat` to rebuild/recreate the API, worker, scheduler and guarded egress. It preserves the existing `videoflow` project and Redis volume.
4. In `frontend`, run `npm ci`, `npm run build` and `npm run lint`. Deploy the frontend using the existing root Netlify configuration. Local development still uses `start.bat`.
5. Paste a complete public link. Wait for analysis, select Video or Audio and an available format, then click Download. Pasting alone never creates a download job. Save prepared file and Save file reuse the existing output.

For a fresh installation, follow [START_HERE.md](../START_HERE.md). Supply your own server secret; never put it in frontend variables. Existing guest, email, Google and Facebook authentication integrations are retained. Hosted social providers still require their existing provider configuration.

## Extractor version

If analysis reports `SOURCE_TLS_ERROR`, run `diagnose-source-tls.bat`. The screenshot follow-up identified Fortinet-issued certificates that the worker cannot verify on the source connections. See [SOURCE_TLS_DIAGNOSIS.md](SOURCE_TLS_DIAGNOSIS.md). This requires an administrator-approved network/trust correction; do not disable certificate verification.

Both API and worker use `backend/Dockerfile` and `backend/requirements.txt`. The tested version remains **yt-dlp 2026.10.26**, pinned in production and development lockfiles and checked by the media runtime. Do not run an unpinned `pip install -U yt-dlp` inside only one service. Rebuild API, worker and scheduler together. `EXTRACTOR_VERSION_MISMATCH` means those components need a coordinated rebuild.

The registry is an administration policy and source catalogue. Its `yt_dlp`, `generic` and `direct` values all retain yt-dlp's standard dedicated-extractor routing followed by generic detection where appropriate. Unknown public hosts can be analyzed. Existing disabled-source rules still apply and are rechecked when preparing a job; no source is automatically enabled.

## Verification on Windows

Run `verify-website-support.bat` with Docker Desktop and Node.js 24 available. This builds the production images and a separate verification image, runs backend tests without external networking, then installs the locked frontend dependencies and runs its production build, lint and tests. Existing running services are not restarted by this verification script. Backend media tests run on Linux/Python 3.12 with FFmpeg, matching deployment rather than attempting POSIX worker process control on native Windows.

For an **optional live test**, first run the offline verification above and start the existing guarded egress service. Then run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-live-public-flow.ps1
```

This retrieves MediaElement's public Big Buck Bunny sample, prepares MP4 and MP3, uploads private temporary objects to your configured Storage, streams the complete attachment responses, and deletes/lists the objects to confirm cleanup. It uses generated test ownership IDs and isolated in-memory Redis, invokes the actual Celery task bodies synchronously, and does not create Auth accounts or permanent download-history rows. It does not exercise the Celery broker or a physical browser. It briefly uses network bandwidth and private Storage. Do not interrupt it during cleanup; the normal hard-expiry Storage sweep remains the recovery mechanism.

An alternative permitted public URL can be supplied through `-MediaUrl`. Source 403, login, age verification, regional, paywall and bot restrictions are terminal access failures, with safe error categories; the test does not bypass them. Never supply private/login-only media for this check.

See [WEBSITE_SUPPORT_VERIFICATION.md](WEBSITE_SUPPORT_VERIFICATION.md) for results and limitations. The older verification document records earlier releases.
