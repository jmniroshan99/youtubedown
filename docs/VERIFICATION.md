# youtubedown 1.5.0 — Verification

Historical release report. For the 5 November 2026 website-support update, use [WEBSITE_SUPPORT_VERIFICATION.md](WEBSITE_SUPPORT_VERIFICATION.md).

Prepared on 2 November 2026. This report separates completed checks from live-service limits.

## Latest completed checks

The final integrated checks below include the branded processing indicator.

| Check | Latest recorded result |
|---|---|
| Frontend production build and lint | Passed after the final processing-mark integration. |
| Frontend tests | 87 passed across 13 files after the final mark rebuild. |
| Backend tests and Ruff | 205 tests passed; Ruff passed. |
| Diagnostic verification | 10 checks passed, including actual Vite proxy forwarding to a disposable upstream; diagnose.mjs and check-gateway.mjs passed syntax checks. |
| Real local media engine | yt-dlp/FFmpeg fixtures passed for embedded MP4, native MKV, HLS, DASH and MP3. |
| Browser | Chrome at 1363px desktop and 390px/320px iframe widths; four-field registration, light/dark themes and keyboard access to the form/footer were checked. |
| Existing protection/configuration | Security, deployment, Inter font, existing public assets and session files were checked against the prior source; existing identifiers remain stable. Dependency changes are limited to release metadata. |
| Processing mark | Actual component checked at light 390px and dark 320px: logo loaded, active orbit and inactive static states matched, decorative markup was aria-hidden. Reduced-motion CSS disables animation. Integrated build passed. |

The iframe widths are real browser layout checks, not physical-device or Safari emulation. Existing public favicons are reused.

Frontend release metadata is 1.5.0. Existing backend API metadata remains 2.0.0; the source update does not change that API identity.

## Account and OAuth coverage

Automated checks cover four-field registration and mode-specific validation, password confirmation, display-only name metadata, account-confirmation and immediate-session outcomes, Google/Facebook OAuth requests, duplicate-action guards, provider-unavailable feedback, cancellation/error callbacks, safe redirects and guest-session boundaries.

The app must not treat an anonymous guest as a completed OAuth account or claim successful registration solely because a button was clicked. Existing backend identity verification and ownership checks remain.

A read-only request to this project's public Auth settings returned HTTP 200 with:

| Setting | Observed state |
|---|---|
| Google | Disabled |
| Facebook | Disabled |
| Email sign-in | Enabled |
| New registrations | Allowed |
| Email confirmation | Required |

No secrets, user records or sessions were read for this check. No hosted settings or accounts were changed. Provider configuration and real sign-in are separate from the local code tests. [SOCIAL_SIGN_IN.md](SOCIAL_SIGN_IN.md) documents the exact Google/Meta callback, allowed frontend callbacks, minimal permissions, email confirmation and custom SMTP.

## Download and media coverage

Pasting continues to analyze only. A user chooses Video or Audio, an actual format/quality and an explicit Download action before a processing job is created. Existing deduplication, cancellation, retry, expiry, filename, Save file and owner-isolation behavior is retained.

Automatic supported-source detection is available for unregistered public hosts while explicit disabled-source rules remain effective. Tests cover unsupported/blocked/restricted/unavailable sources and safe error mapping. No claim is made that every website works.

The embedded-media probe uses the extracted media URL where available. Local fixtures verify playable media and preserved streams, including native MKV output, instead of assuming all sources are MP4. Existing SSRF controls, guarded egress and media limits remain.

Redis behavior is exercised with fakeredis/Lua. The source update retains bounded fragment concurrency and progress output, temporary job state, private staging, transfer grace and scheduler cleanup.

## Build and performance

Final production output: entry JavaScript 345.79 kB (109.86 kB gzip), Supabase chunk 214.38 kB (55.16 kB gzip), authentication chunk 129.92 kB (40.18 kB gzip), CSS 38.06 kB (8.74 kB gzip). Authentication and secondary pages remain lazy-loaded. No dependency was added. Previous PERFORMANCE_METRICS.json is historical data, not a benchmark for this release.

No Lighthouse score, public-internet speed percentage or universal extractor-success result is claimed. Source throttling, protocol, CPU, Storage upload and network bandwidth still affect completion time.

## Live verification still required

Real Google/Facebook authentication, confirmation-email and password-reset delivery, public external-source downloads, the user's screenshot URL, final hosted attachment headers, actual device save prompts, Windows BAT/Docker operation, deployed cleanup and Netlify route refreshes remain unverified.

No Docker engine or actual Redis server was available for these checks. Browser review used public frontend example settings and the honest backend-unavailable state. Registration fields and the actual processing component were checked visually; successful account and media flows were exercised through explicitly mocked frontend integrations and disposable local media fixtures. No real accounts were created.

The separate 12ui capture runtime lacked its Chromium executable; the available cloud browser was used for visual review. Lighthouse was not run.

## Apply and reproduce

Keep real .env files and installed node_modules when copying the extracted project over the existing folder. Run **repair-downloads.bat** to rebuild changed media services, then reload the frontend. Provider enablement must be completed separately using SOCIAL_SIGN_IN.md; do not put OAuth/SMTP secrets into VITE variables.

Inside frontend: npm ci; npm run build; npm run lint; npm test.
Inside backend: install requirements-dev.txt; python -m pytest -q; ruff check app tests ../egress/proxy.py.

The delivered ZIP is checked for archive integrity, both dependency lockfiles, expected favicon/font assets, and exclusion of dependencies, real environment files, caches, build output, temporary QA pages and downloaded media. Production HTML and manifest use absolute favicon paths, including on nested routes; a hosted Netlify refresh still requires deployment verification.

