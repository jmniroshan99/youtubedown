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
| Frontend Vitest | 119 tests across 14 files passed, including TLS messages, missing-backend preflight, production hostname isolation, retired-tunnel/authentication URL migration, safe guest-session failures and server-provided duration-limit guidance. |
| Backend pytest | 325 tests passed under Linux/Python 3.12 with pinned dependencies and FFmpeg, including verified TLS probing, manifest sampling, safe diagnostics and two-hour duration boundaries. |
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

**Limits of the earlier harness:** It overrides identity with generated owner IDs, uses isolated fakeredis, and invokes the real Celery task bodies synchronously. That harness does not verify a live Celery broker transaction, new Supabase login/OAuth, Netlify deployment, physical-device/browser save completion or Safari behavior. Later browser and HLS analysis checks are described below. Complete internet HLS/DASH transfers remain unverified; real local synthetic stream transfers were tested. Availability can change independently of this application.

## Netlify authentication follow-up

A clean Chrome session reproduced the deployed "Failed to fetch" error before API analysis started. The backend health request succeeded; the guest signup request targeted `dxtucfijilmytkwrzsox.supabase.c` and failed with `ERR_NAME_NOT_RESOLVED`. The deployed public key matched the existing project. This identifies a misspelled `VITE_SUPABASE_URL`, rather than a video extractor failure, for that screenshot.

The exact known typo now resolves to the existing `.supabase.co` project only on the owned production hostname. Both the SDK and OAuth checks share that resolution; other projects, local development, auth storage and public-key settings remain explicit. Guest-session network, service, rate-limit and verification failures now show safe messages and a `session` stage reference, without exposing SDK/provider responses. A failed signup can be retried without starting an analysis or download job.

**Live Netlify browser verification passed after publication.** A fresh headless Chrome profile, with normal TLS verification, signed in as a new anonymous test guest (HTTP 200), submitted the permitted MediaElement sample for analysis (202), and displayed available formats. There were zero preparation requests before the explicit Download click. The deployed frontend reached the actual PC API, Redis/Celery worker, guarded source transfer, FFmpeg and private Storage; no identity override, fake broker or mocked media was used for this check.

Chrome's download manager completed the MP4 (5,510,872 bytes) and explicit MP3 (1,204,905 bytes). Both suggested filenames started with `youtubedown - ` and used their actual extensions. Save file completed a second MP4 transfer with the same SHA-256 and did not create another job. Exactly two preparation jobs were created. The two test Storage objects were deleted and absence verified, their job records were forgotten, the synthetic anonymous Auth user was deleted, and local test media was removed. No existing user session or account was changed. This verifies the public sample flow on Chrome; it does not establish live YouTube/Pornhub/xHamster compatibility, OAuth-provider completion, Safari or physical-device saving. The earlier Unicode, ownership and expiry checks are described separately above.

## Duration-limit follow-up

The requested maximum video duration is now 7,200 seconds (two hours) for guests and signed-in accounts. Both configuration defaults and `backend/.env.example` use that value, and the private PC backend environment was updated explicitly. The previous screenshot used the then-configured 900-second guest ceiling; no duration-unit defect was found. API, worker and scheduler use the same policy. Existing analysis/job snapshots retain any stricter original limits, so previously rejected links require fresh analysis.

The frontend displays the exact duration ceiling from the existing failed-analysis response (`download_limits.max_duration`), rather than hiding it behind "allowed duration." The code and analysis stage remain visible. Missing, fractional, nonpositive, nonfinite, unsafe or nonnumeric limits retain safe generic guidance. Only the duration allowance changed: file-size, active/daily-job, rate, retention, execution-time and source restrictions remain enforced. A two-hour source may still exceed the 100 MB guest or 500 MB account size ceiling. Help and setup instructions describe the updated defaults.

Offline regression coverage accepts exactly 7,200 seconds and rejects 7,201 seconds at the API and final FFprobe-validation stages; oversized output is not uploaded and temporary files are cleaned. Stored stricter policies and existing byte/job controls remain covered. Production Docker images built, backend 282 tests/Ruff passed, and frontend production build/lint/all 119 tests passed.

The complete YouTube URL subsequently supplied by the user was analyzed through a one-off worker using the updated policy, real provider-registry rules and normal guarded yt-dlp extraction. Analysis succeeded: reported duration 5,305 seconds (1 hour 28 minutes 25 seconds), 12 video choices and 2 audio choices. This confirms metadata extraction and duration eligibility for that link; its full media was not downloaded and an entire two-hour transfer is not claimed tested.

The live API ingress was paused while existing work drained, then the API, worker and scheduler were recreated with the matching built images and private environment. All three services confirmed a 7,200-second guest/account policy, the original byte/job/runtime controls, and public HTTPS health/CORS through the same tunnel. A fresh Chrome guest session then reached the supplied link's format-selection screen on Netlify; the screenshot showed its 88:25 duration and 12 selection options. There were zero preparation requests. The synthetic guest was deleted after this analysis-only check. No live access restriction or certificate check was bypassed.

## Streaming certificate follow-up

The user confirmed that xHamster/Pornhub still fail with `SOURCE_TLS_ERROR` during analysis. A fresh check from the running worker reproduced that failure for both fixed source hosts while YouTube verified HTTPS, guarded CONNECT and private-target rejection passed. The official release API showed the existing `2026.10.26` pin as the latest stable yt-dlp release at the 5 November 2026 check. No new live video URL was supplied in this follow-up; no adult video page or media was downloaded.

A separate proven defect was corrected: network FFprobe defaulted to unverified TLS. Progressive media probes now require the pinned CA bundle and destination verification across redirects. They inspect the selected progressive rendition rather than its parent manifest. Network probing excludes manifest demuxers, so a disguised playlist cannot open child requests with unsafe defaults.

For segmented formats, manifests and selected initialization/media samples are fetched through verified yt-dlp transport and existing guarded egress/source rules. Manifests are bounded to 1 MiB, samples to 4 MiB and master traversal to two hops. FFprobe inspects temporary sample bytes with file-only protocols; temporary files are removed. Full VOD duration comes from complete manifest metadata, never a short sample. Unambiguous selected variants, static DASH/default static and a single Period duration are supported. Encrypted/byte-range/oversized or ambiguous samples can remain unprobed; no codec/audio/duration is fabricated. Live/DRM restrictions remain enforced.

The final offline suite passed all 325 backend tests and Ruff. New checks include trusted/untrusted/wrong-host HTTPS, verified redirects, rejection of a disguised manifest before its child is requested, self-signed HTTPS segment rejection, bounded HLS/DASH sampling, disabled sources, XML entity rejection, sample cleanup and preservation of full duration. Real local synthetic direct/embedded MP4, MP3, original audio, native containers, non-live HLS and DASH remain passing. No frontend code changed in this follow-up; the earlier 119-test/build/lint frontend baseline remains applicable. See [SOURCE_TLS_DIAGNOSIS.md](SOURCE_TLS_DIAGNOSIS.md) for the external trust-chain correction still required; the security fix does not claim xHamster/Pornhub access is restored.

The matching API/worker/scheduler images were deployed after draining existing work. Public readiness/CORS and the two-hour/byte/job controls passed. Live analysis through the deployed worker then succeeded for the public MediaElement MP4 (60.095 seconds; 1 video/2 audio options) and the [Video-Dev/Mux HLS VOD demo](https://github.com/video-dev/streams/blob/master/ui/index.html) (634 seconds; 5 video/2 audio options), using normal registry rules, guarded egress and verified TLS. Only metadata and bounded probing samples were retrieved, without Auth test accounts, new jobs or full-video downloads in this follow-up. This verifies live HLS analysis on that public demo; it does not claim a complete HLS browser download or live xHamster/Pornhub access.

## Distribution contents

`youtubedown_Website_Support_Updated.zip` contains complete source, existing npm/Python lockfiles, Windows scripts and English setup instructions. Packaging rejects actual local secret values and excludes `.env` files except examples, Git metadata, node_modules, virtual environments, caches, build output, diagnostic logs and downloaded media. Existing root Netlify configuration, styles/assets/fonts, Supabase migrations, environment names, auth keys, Docker identities and volumes are preserved. The user's pre-existing `.gitignore` edits were left intact.
