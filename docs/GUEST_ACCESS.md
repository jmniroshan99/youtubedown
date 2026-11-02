# Guest access setup and operation

youtubedown implements guest analysis and downloads without an email/password form. Guests still have a verified, private Supabase identity. This document replaces the earlier implementation prompt.

## Enable the service

1. In your Supabase project, open Authentication and the sign-in/provider settings. Enable **Anonymous Sign-Ins**. Keep Email enabled for optional permanent accounts. Do not make tables or the downloads bucket public.
2. Keep the original schema and owner RLS policies. No new database migration is needed for this release. Existing accounts and records are preserved.
3. Merge new settings from `backend/.env.example`, then rebuild API/worker/scheduler containers. `GUEST_ACCESS_ENABLED=true` is the default. All API instances must use the same Redis database and server policy.
4. Confirm the backend `/health` includes `status: ready`. Configure the real backend URL in `VITE_API_BASE_URL`. A deployed Netlify site cannot use localhost as its backend.
5. Configure bot protection before public production use, as below. Rebuild/redeploy the frontend after any `VITE_*` change.

## Cloudflare Turnstile with Supabase

- Create a Turnstile widget with the frontend hostnames you actually use. Configure local testing according to Cloudflare's testing guidance.
- In Supabase Authentication's bot/CAPTCHA protection settings, select Cloudflare Turnstile and enter the **Turnstile secret key there**.
- Put only the widget's public site key in `VITE_TURNSTILE_SITE_KEY` in `frontend/.env.local` or Netlify's build environment.
- The app loads Turnstile only when a guest creation or account authentication action needs a token. Supabase verifies that token; a frontend check alone is not considered proof.
- Enabling CAPTCHA in Supabase without providing a matching frontend site key will reject requests. A site key by itself does not enable server verification. Do not deploy a test secret or use a permanent bypass.
- The same lazy challenge flow supports optional password sign-in, registration and password recovery. Cancellation, load failure, expiry and rejection are surfaced; they do not produce a guest success state.
- Configure Supabase's anonymous-signup rate limits as well. The backend cannot rate-limit account creation that occurs directly at Supabase Auth.

## Session behavior

Pasting a complete supported URL obtains or reuses a session and analyzes that URL only. The user then chooses Video/Audio and a format, and explicitly clicks Download. All controls reuse the current identity. Concurrent initialization is deduplicated. This app serializes its login/logout/guest actions across tabs using Web Locks where supported, with a same-tab fallback. It rechecks saved sessions before creating a guest and never deliberately replaces an existing permanent session.

Current downloads and Video sources offer Continue as guest when no session exists. Help and device theme preferences do not create a session. A saved guest session is reused after refresh through Supabase session persistence.

A guest workspace shows a clear notice: clearing browser data, ending the session, switching accounts or using another device can make its current jobs inaccessible. Signing in or creating a separate account does not transfer guest jobs. Finish downloading needed files first. No automatic guest-to-account merge or upgrade is offered; implementing one later requires supported identity linking and explicit ownership rules.

## Default limits

| Limit | Guest default | Permanent-account default |
|---|---:|---:|
| Active jobs | 1 | 2 |
| Jobs per UTC day | 5 | 20 |
| File size | 100 MB | 500 MB |
| Video duration | 900 seconds, verified | 3,600 seconds |
| File retention after upload | 30 minutes | 60 minutes |
| Analysis per identity | 2/minute and 20/day | Existing 8/minute |
| Analysis per shared network | 8/minute and 100/day | Not applied |
| Create/retry attempts per shared network | 6/minute and 20/day | Not applied |

MB limits use 1,048,576 bytes per MB. Guest media/job limits are capped by the general server limits, even if a guest setting is higher. HTTP 429 responses include Retry-After for guest rate budgets. The UI displays a wait estimate and does not automatically retry job creation.

The shared-network create limit counts attempts, including retries and repeated idempotency keys; the Redis per-user job quota counts actual unique reservations. These are different protections. Failed/cancelled jobs and current-job deletion do not refund the daily job quota. Minute/day rate windows use UTC epoch boundaries. NAT users may share an allowance.

`GUEST_*` variables are documented in the backend template. Optional `GUEST_RATE_LIMIT_SECRET` selects a dedicated HMAC secret; otherwise the server Supabase secret is used. Use the same value on all API instances. Do not place it in the browser. Changing it resets network identities. Use the same Redis configuration for all API, worker and scheduler instances. The supplied service disables Redis AOF/snapshot writes; restarting it removes current jobs, queue messages and limiter counters. Existing volume identifiers and older files are preserved, not scrubbed. An independent Storage sweep cleans the dedicated temporary namespace after state loss. Do not treat Redis as a permanent download-history store.

## Trusted proxies

Local development defaults to an empty `TRUSTED_PROXY_CIDRS`; arbitrary forwarded headers are ignored. Docker's observed peer may be a shared bridge address, so local visitors may share one network budget. Production Compose sets trust to the dedicated Caddy gateway address (default 172.31.248.2/32) on an internal 172.31.248.0/29 network.

If the subnet conflicts with your host, set both `GATEWAY_SUBNET` and `GATEWAY_PROXY_IP` in `.env.production` to an unused private subnet and one usable address inside it. Recreate the stack. Keep the API unpublished in production and retain Uvicorn `--no-proxy-headers`. Caddy replaces user-supplied X-Forwarded-For with its actual remote peer. On other hosting, explicitly configure only trusted proxy CIDRs and verify forwarding behavior; do not blindly trust public headers. CDNs require a separate reviewed trust configuration and otherwise conservatively share a budget by their egress address.

## Retention and cleanup

The scheduler expires guest files using their shorter stored retention policy. It leaves active jobs alone and waits for worker locks before removing failed/cancelled artifacts. Existing account and legacy-history rows are not automatically deleted. New downloads do not write permanent history rows. Supabase anonymous identities can accumulate; monitor project usage. Any future stale-account cleanup must separately verify anonymous status, recent activity, sessions and active jobs, and remove associated files safely. No account-deletion job is shipped.

## Official references

- https://supabase.com/docs/guides/auth/auth-anonymous
- https://supabase.com/docs/guides/auth/auth-captcha
- https://supabase.com/docs/reference/javascript/auth-signinanonymously
- https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/
- https://developers.cloudflare.com/turnstile/troubleshooting/testing/

## Local gateway update (1.2.2)

For local startup, use `docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build` or `start.bat`. The separate local gateway owns host port 8000. The API remains internal-only, and local guest requests conservatively share the gateway's network allowance. Production uses only the existing production override, not the local override.
