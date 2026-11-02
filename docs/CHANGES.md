# youtubedown 1.5.0 — Easy accounts and clearer processing

Registration now has four fields: **Full name**, **Email address**, **Password**, and **Confirm password**. Validation checks the name, email, password and matching confirmation. Only the password required by Supabase is submitted; the confirmation is not retained. The name is display metadata and never grants a role.

Login and registration include **Continue with Google** and **Continue with Facebook** using Supabase OAuth/PKCE. Account confirmation, provider cancellation, disabled providers, sign-in errors and safe local return paths are handled explicitly. Guest access remains available; switching to a separate account does not transfer guest jobs.

A read-only check of the project's public Auth settings found Google and Facebook disabled, email sign-in enabled, registration allowed and email confirmation required. No hosted setting, account or credential was changed. Social sign-in becomes usable after the owner configures and enables those providers. Follow [SOCIAL_SIGN_IN.md](SOCIAL_SIGN_IN.md) for the exact provider/frontend callbacks and email-delivery setup.

Public source URLs not present in the registry can use yt-dlp's supported-source detection. Explicit disabled-source rules still take priority. This broadens supported public sources; it does not support every website, private content, login-only sources or DRM. Unknown, blocked, restricted, unavailable and rate-limited sources receive safe errors rather than raw extractor diagnostics.

Embedded/direct-media analysis probes the extracted media URL rather than treating the containing HTML page as media. Native container choices retain their real output extension instead of inventing an MP4 result. The media pipeline still uses the guarded egress proxy and existing duration/size checks.

The existing red play/download icon now accompanies real loading and processing states with a small decorative orbit. Adjacent status text remains the source of information; the animation does not invent progress or success and respects reduced-motion settings.

The crimson light/charcoal themes, Inter typography and explicit **Video/Audio → quality → Download** flow are preserved. Pasting analyzes only. Bounded fragment retrieval, safe filenames, account/guest ownership, expiring Redis state, private temporary staging and cleanup remain.

Apply the complete update while keeping real environment files and installed dependencies. Run **repair-downloads.bat** because backend media handling changed. See [VERIFICATION.md](VERIFICATION.md) for executed checks and outstanding live-service testing. No universal source support, internet speed multiplier or live OAuth success is claimed.

