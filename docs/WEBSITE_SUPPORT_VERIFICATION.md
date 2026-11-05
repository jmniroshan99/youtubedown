# Website support verification — 5 November 2026

The source project is updated directly. This report distinguishes reproduced code defects, offline fixtures and live transfers. No specific failing Pornhub/xHamster video URLs were supplied, so the original live failures cannot be assigned a definitive site/network cause.

Screenshot follow-up: fixed-host checks now reproduce a certificate verification failure with a Fortinet issuer on xHamster/Pornhub connections. See [SOURCE_TLS_DIAGNOSIS.md](SOURCE_TLS_DIAGNOSIS.md). These hosts are reachable over TCP but currently fail verified TLS; no video page was retrieved.

## Evidence and fixes

| Path inspected | Finding and resulting behavior |
|---|---|
| Frontend validation | Already accepts general HTTP(S) links without a provider whitelist. Preserved. Paste performs analysis only; Download remains explicit. |
| URL matching | Pinned dedicated extractor regexes miss uppercase/default-port forms and Pornhub/xHamster embed identifiers appearing after other query parameters. Reproduced with offline share-link fixtures. Canonicalization preserves the source host and query values while enabling normal dedicated routing. Deceptive suffix domains remain outside those extractors. |
| Provider registry | Unknown public hosts already fall back to automatic detection. Preserved. Most-specific disabled-domain rules are retained, passed into the credential-free child, checked on extraction/request/final-response hosts and before direct probing, and refreshed before preparation. Disabled administrator test sources now fail closed too. |
| Extractor dispatch | Legacy `force_generic_extractor` was placed in an options dictionary; the pinned library reads its deprecated function argument instead. It was ineffective, so it is **not an established cause** of the reported failures. The obsolete flag is removed and all three registry adapter values have explicit dedicated-routing regression coverage. |
| yt-dlp version | Existing production/development pins were already 2026.10.26; the worker image confirmed that version. No evidence justified blaming an outdated version. The tested pin is retained with a runtime drift check. API and workers continue using the same Dockerfile/lockfile. |
| Progressive formats | Only the first stream was probed, leaving other progressive variants without verified audio metadata. Up to eight candidates now receive bounded guarded probing, including public Referer/Origin/User-Agent headers where required. Failed probes keep audio unverified. Credentials and injected header newlines are excluded. |
| Format selection | Available compatible audio is selected by its exact analyzed ID instead of a broader bestaudio selector. Protected/unsupported-protocol candidates are filtered. Original audio advertises its actual extraction container; explicit MP3 remains MP3. No video scaling/transcoding was introduced. |
| Embedded pages | A single generic/multi-video entry can be processed; collections are rejected before any media download. Dedicated extractor access failures are never retried through a generic bypass. |
| Errors and progress | Source unavailable, unsupported, login, age, paywall, access, regional, rate, extraction and backend-outage categories remain separate. Public diagnostics include an allowlisted code/stage, with source URLs, private selectors and thumbnail tokens removed from analysis responses. Progress follows actual worker events; ready output does not claim verified browser saving. |
| Duplicate actions | Repeated Download with the same prepared selection reuses that file. Rapid Save clicks and Current downloads actions are guarded. Existing server idempotency, cancellation and retries are preserved. |

Pornhub's pinned upstream extractor manufactures age-verification cookies and can invoke a PhantomJS challenge fallback. This update suppresses those behaviors while retaining upstream URL/format extraction. Age/challenge responses produce safe restrictions rather than access circumvention. No login cookies, credentials, regional spoofing, browser-cookie import or DRM recovery was added. See the pinned upstream [Pornhub implementation](https://github.com/yt-dlp/yt-dlp/blob/2026.10.26/yt_dlp/extractor/pornhub.py) and [xHamster implementation](https://github.com/yt-dlp/yt-dlp/blob/2026.10.26/yt_dlp/extractor/xhamster.py).

## Completed checks

| Check | Result |
|---|---|
| Locked frontend dependencies | `npm ci` completed. Existing package-lock preserved. |
| Frontend production build / ESLint | Passed. |
| Frontend Vitest | 110 tests across 14 files passed, including TLS messages, missing-backend preflight, production hostname isolation, retired-tunnel/authentication URL migration and safe guest-session failures. |
| Backend pytest | 275 tests passed under Linux/Python 3.12 with pinned dependencies and FFmpeg, including verified TLS diagnostic/error coverage. |
| Backend Ruff | Passed, including new runtime and fixture coverage. |
| Production Docker builds | API, worker, scheduler and guarded egress built successfully. Existing running services were not restarted by verification. |
| Windows verification | Included PowerShell workflow exercised builds, isolated backend suite/lint, npm ci, frontend build/lint/tests. |
| Local actual media | Synthetic direct and embedded MP4, original audio, MP3 conversion, native MKV, non-live HLS and DASH (including separate audio/video merge) passed. Production loopback/private-address rejection remains separately covered. |
| Lifecycle/security | Cancellation/process termination, retries, request idempotency, cross-user ownership, quotas, Unicode/unsafe filenames, job/file expiry, cleanup leases/orphans, credential-stripped child environments, SSRF/DNS pinning/redirect proxy behavior and browser-byte-storage guards passed. |

The pinned stack emits existing Redis `setex` and Starlette/httpx test-client deprecation notices. These did not fail the checks. Dependencies were not changed solely to silence those notices.

## Live sources and delivery

**Succeeded:** [MediaElement's public Big Buck Bunny sample](https://github.com/mediaelement/mediaelement-files/blob/master/big_buck_bunny.mp4), retrieved from its raw GitHub URL through the existing guarded proxy. The live harness performed actual API analysis, real Celery task-body preparation with yt-dlp/FFmpeg, temporary private Supabase Storage upload, signed attachment delivery and complete MP4/MP3 HTTP response streaming. Received byte counts matched the prepared sizes; repeated Save responses had identical SHA-256 hashes. Both final responses included `Content-Disposition: attachment` and the expected sanitized Sinhala/Unicode title with the actual extension. The supported Storage download-filename mechanism is documented by [Supabase](https://supabase.com/docs/reference/javascript/storage-from-createsignedurl).

Cross-owner file access returned 404; expired prepared-file access returned 410. Repeated creates reused the same job. Save issued another link to the same object without preparing again. Temporary test objects were deleted and their absence was verified by listing Storage. Isolated in-memory job state was cleared. No Auth accounts or permanent download-history records were created.

**Restricted/unsuccessful:** W3C's public Sintel trailer had successful analysis in one live run but returned HTTP 403 during preparation; a separate extractor request also returned 403. This was reported as `SOURCE_BLOCKED`. Ordinary requests to that host sometimes returned 200, which does not establish the reason for the difference. No workaround/bypass was applied. A candidate Blender movie path returned unavailable and was not counted as a successful source. W3Schools sample access returned 403 and was not used for the final flow.

**Offline only:** Pornhub and xHamster URL matching, mobile/regional aliases, embeds, share-link normalization, actual pinned extractor dispatch, mocked dedicated-extractor result processing, missing-codec probing, disabled-source behavior and restriction handling. No live Pornhub/xHamster video was downloaded or claimed compatible. No restricted/login-only source was tested through circumvention.

**Limits:** The live harness overrides identity with generated owner IDs, uses isolated fakeredis, and invokes the real Celery task bodies synchronously. It does not verify a live Celery broker transaction, new Supabase login/OAuth, Netlify deployment, physical-device/browser save completion or Safari behavior. Browser workflow and download-anchor initiation are covered by frontend tests. HLS/DASH live internet sources were not tested; real local synthetic streams were. Availability can change independently of this application.

## Netlify authentication follow-up

A clean Chrome session reproduced the deployed "Failed to fetch" error before API analysis started. The backend health request succeeded; the guest signup request targeted `dxtucfijilmytkwrzsox.supabase.c` and failed with `ERR_NAME_NOT_RESOLVED`. The deployed public key matched the existing project. This identifies a misspelled `VITE_SUPABASE_URL`, rather than a video extractor failure, for that screenshot.

The exact known typo now resolves to the existing `.supabase.co` project only on the owned production hostname. Both the SDK and OAuth checks share that resolution; other projects, local development, auth storage and public-key settings remain explicit. Guest-session network, service, rate-limit and verification failures now show safe messages and a `session` stage reference, without exposing SDK/provider responses. A failed signup can be retried without starting an analysis or download job. Publication and a fresh live-browser check are the remaining verification steps for this follow-up.

## Distribution contents

`youtubedown_Website_Support_Updated.zip` contains complete source, existing npm/Python lockfiles, Windows scripts and English setup instructions. Packaging rejects actual local secret values and excludes `.env` files except examples, Git metadata, node_modules, virtual environments, caches, build output, diagnostic logs and downloaded media. Existing root Netlify configuration, styles/assets/fonts, Supabase migrations, environment names, auth keys, Docker identities and volumes are preserved. The user's pre-existing `.gitignore` edits were left intact.
