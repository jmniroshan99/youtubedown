# Easy accounts and Google/Facebook sign-in

The registration form has four rows: **Full name**, **Email address**, **Password**, and **Confirm password**. Users can also choose **Continue with Google**, **Continue with Facebook**, or **Continue as guest**.

The application code does not create the provider applications or change your hosted Supabase settings. Complete the provider settings below before testing public social sign-in. A completed Google/Facebook account login still requires an interactive check with an allowed account.

## Observed project state

A fresh public-settings check on 5 November 2026 returned Google, Facebook, Email and Anonymous sign-ins enabled, sign-ups allowed and email confirmation required. Earlier disabled-provider findings no longer describe the current configuration.

A clean Chrome session reached Google's account sign-in page through the production Google button. The provider callback correctly targeted this project's Supabase `/auth/v1/callback`. However, cancelling a fresh diagnostic flow returned to `http://localhost:3000/` instead of the requested Netlify callback. This reproduces a hosted redirect-configuration problem. No credentials, consent, account creation or successful account login were used in this check, and private provider settings were not read or changed.

The owner must save the production Site URL and exact Redirect URLs below in Supabase. Local source changes cannot update that dashboard configuration. Keep existing local entries. Run `diagnose-auth.bat` afterward: it checks public provider flags, its own temporary OAuth cancellation return and public backend health, without printing tokens, OAuth state or raw provider responses. It reads the existing public key from `frontend/.env.local`; no new secret is required.

## 1. Keep these URLs separate

| Setting | Value for this project |
|---|---|
| Google authorized redirect URI | `https://dxtucfijilmytkwrzsox.supabase.co/auth/v1/callback` |
| Meta valid OAuth redirect URI | `https://dxtucfijilmytkwrzsox.supabase.co/auth/v1/callback` |
| Supabase allowed frontend callback, local IP | `http://127.0.0.1:5173/auth/callback` |
| Supabase allowed frontend callback, localhost | `http://localhost:5173/auth/callback` |
| Local password-reset destinations | `http://127.0.0.1:5173/reset-password` and `http://localhost:5173/reset-password` |
| Supabase production Site URL | `https://youtubedownl.netlify.app` |
| Supabase production allowed frontend callback | `https://youtubedownl.netlify.app/auth/callback` |
| Supabase production allowed password-reset destination | `https://youtubedownl.netlify.app/reset-password` |

In Supabase **Authentication → URL Configuration**, set **Site URL** to the real production frontend URL and add the exact frontend callback/reset URLs you use. During local-only testing, use your chosen local frontend origin as Site URL.

The provider sends the user to Supabase's callback; Supabase then returns the user to the frontend callback. Local Vite with this hosted project still uses the hosted Supabase callback in Google/Meta. Do not substitute a local Supabase CLI callback unless you actually run that separate Auth server.

`localhost` and `127.0.0.1` are different browser origins. Start and finish a PKCE sign-in in the same browser and origin so its verifier remains available. Preserve the Netlify SPA fallback for direct callback-route refreshes.

## 2. Google

1. In Google Auth Platform, create or select your project and configure its audience, branding and required consent-screen information.
2. Create a **Web application** OAuth client.
3. Add each actual frontend origin under **Authorized JavaScript origins**; include the local address you test.
4. Add the Google redirect URI from the table under **Authorized redirect URIs**.
5. In Supabase **Authentication → Sign In / Providers → Google**, enable Google, enter the client ID and client secret, then save.
6. Use only the basic sign-in scopes: `openid`, email and profile. Add test users if Google's audience/testing settings require them. Complete the provider's publishing/verification requirements before general availability.

Do not request Drive, Gmail or other unrelated access.

## 3. Facebook / Meta

1. Create or select a Meta app suitable for Facebook Login and account authentication.
2. Configure the Facebook Login use case/product and add the Meta redirect URI from the table under **Valid OAuth Redirect URIs**.
3. In the authentication/account-creation use case, configure **public_profile** and **email**. Supabase's Facebook integration requires email permission; verify both permissions are available for testing.
4. In Supabase **Authentication → Sign In / Providers → Facebook**, enable Facebook and enter the Meta App ID and App Secret. Save.
5. While the Meta app is in Development mode, test with an administrator, developer or tester who has accepted the app-role invitation.
6. Before public use, complete the requirements shown in Meta's dashboard and publish the app in the appropriate live mode. Required review/access and verification depend on the app/use case.

Do not promise access to all Facebook users while the app remains restricted. A user can decline permissions or fail to provide a usable email; the app must show a sign-in error and offer email or guest access rather than inventing an account.

## 4. Email registration and delivery

Keep Email sign-in enabled. The full name is display metadata, not a role or permission. Confirm password is checked in the browser and is not stored or sent as a separate account field.

Retain the project's email-confirmation and server password policies. A successful sign-up may require the user to open a confirmation email; an immediately returned authenticated session is handled separately. Do not disable confirmation or rate limits merely to make registration appear successful.

For public email registration and password recovery, configure **custom SMTP** in Supabase Auth with a verified sending identity. Supabase's default sender is restricted to authorized project-team recipients and is not a production mail service. SMTP credentials belong in Supabase's private configuration, not the frontend. Check spam folders, sender-domain setup and Auth mail limits when delivery fails.

## 5. Secrets and identity

- Google client secrets and Meta App Secrets belong in their provider consoles and the private Supabase provider settings.
- Never add them to `VITE_*`, source files, a public ZIP, browser storage, or chat.
- The frontend continues to use only its existing public Supabase URL and publishable key. No extra public OAuth secret is required.
- Signing in to a separate account does not transfer the current guest's temporary downloads. Save needed files before switching.
- Existing accounts, owner checks, RLS, private staging and guest access remain in place. Display-name metadata must never grant administrator access.

## 6. Test after configuration

Test four-field registration, a mismatched confirmation password, confirmation-email delivery, ordinary email login and password reset. Then test each provider with an allowed test account, provider cancellation, refresh at `/auth/callback`, logout and returning guest access. Confirm the correct account owns only its own current jobs.

If a provider is disabled, its button cannot make that provider available by itself. Fix the provider configuration; do not change database RLS or make file storage public. For consent cancellation, retry from the sign-in page or use another available method.

Provider console setup, public app access, SMTP delivery and a real Google/Facebook session require live testing with the owner's configured services. No credentials or provider settings were changed while preparing this source update.

## Callback and password-reset behavior

The existing Supabase SDK performs the PKCE exchange once. Missing verifiers, expired codes, guest-only returns and missing sessions now produce a terminal sign-in error with retry/guest links. An older saved account cannot make an unexchanged code appear successful. Callback query/fragment data is removed after SDK initialization. Unknown provider errors use fixed safe messages.

Password changes from the reset screen require an actual SDK password-recovery event tied to that browser session. URL flags and an older saved login do not grant reset authority. The password update uses the captured recovery token, so a concurrent account switch cannot redirect the change to a different account or overwrite its saved session. Account changes revoke the grant; same-session focus and token refresh preserve it. The recovery grant stays in memory, so reloading a consumed reset link requires requesting a fresh link. Existing authentication storage keys are unchanged.

## Official references

Google, redirect and PKCE references rechecked on 5 November 2026. Other setup references were checked on 2 November 2026.

- [Supabase Google sign-in](https://supabase.com/docs/guides/auth/social-sign-in/auth-google)
- [Supabase Facebook sign-in](https://supabase.com/docs/guides/auth/social-sign-in/auth-facebook)
- [Supabase redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)
- [Supabase PKCE flow](https://supabase.com/docs/guides/auth/sessions/pkce-flow)
- [Supabase custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
- [Supabase sign-up reference](https://supabase.com/docs/reference/javascript/auth-signup)

