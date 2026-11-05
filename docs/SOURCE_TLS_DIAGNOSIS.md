# Source TLS diagnosis — 5 November 2026

The supplied screenshot showed `SOURCE_NETWORK_ERROR` during xHamster analysis. Checks from the running worker identified a more specific failure before any video extraction: **certificate verification fails for the HTTPS connection**.

| Check through the existing guarded egress | Observed result |
|---|---|
| DNS/TCP CONNECT | Succeeded for the tested source hosts |
| Private metadata target | Rejected, as expected |
| YouTube verified HTTPS HEAD | HTTP 200; certificate chain verified |
| xHamster verified HTTPS HEAD | Certificate verification error, OpenSSL verify code 20 |
| Pornhub verified HTTPS HEAD | Certificate verification error, OpenSSL verify code 20 |
| System CA store versus pinned certifi bundle | Both failed on these two source connections |
| Presented issuer for the failing source connections | Fortinet Certificate Authority |

The observed connections present Fortinet-issued certificates, consistent with HTTPS inspection by a security intermediary. The worker cannot validate the supplied chain. This does **not** prove the original websites have invalid certificates or establish which device/network controls the inspection. A missing approved root and an incomplete inspection chain both require administrator investigation. These checks used verified handshakes and fixed-host HEAD requests; the screenshot's video page and media were not requested.

## Code changes

- yt-dlp `CertificateVerifyError` and nested Python certificate-verification exceptions now map to `SOURCE_TLS_ERROR` before the broader network-error fallback.
- The English interface explains that the administrator must check HTTPS inspection and certificate trust. It retains a safe code and processing stage without displaying certificate payloads, source responses or tokens.
- `diagnose-source-tls.bat` runs the optional `python -m app.egress_check --tls` check inside the worker. The original DNS/TCP and SSRF checks remain, and optional verified HEAD checks distinguish the control connection from the two source connections. No video/page body is fetched.
- Regression tests assert hostname verification, `CERT_REQUIRED`, bounded timeouts, safe error messages, and no insecure retry after certificate failure.

## Required network action

Have the network/security administrator identify the Fortinet inspection policy and confirm that the intended public source is permitted. If this inspection is authorized, the administrator needs to repair its complete certificate chain and supply an independently verified, approved trust configuration for the backend/media runtime. The application cannot establish the legitimacy of an intercepted certificate by itself.

No certificate was imported, no trust store was modified, and no certificate checks were disabled. Browser cookies, alternate DNS, regional workarounds and access-control bypasses were not used. Merely retrying the same link or changing yt-dlp URL matching cannot correct this observed TLS failure. After the approved network correction, rerun `diagnose-source-tls.bat` and then analyze a permitted public source again; a successful HEAD check alone does not guarantee extraction or downloads.

The updated ZIP includes these diagnostic/error improvements. Source connections remain unavailable under the currently observed certificate trust configuration. The earlier successful public MP4/MP3 flow and its verification limits remain documented in [WEBSITE_SUPPORT_VERIFICATION.md](WEBSITE_SUPPORT_VERIFICATION.md).
