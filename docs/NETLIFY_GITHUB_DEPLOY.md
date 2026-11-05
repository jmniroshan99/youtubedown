# Deploy the frontend to Netlify through GitHub

The Git remote is `https://github.com/jmniroshan99/youtubedown`, branch `main`. The root `netlify.toml` already configures the Vite frontend, Node.js 24, SPA routing and response headers. Keep that file in the repository root.

## 1. Connect the repository

In [Netlify](https://app.netlify.com/start), choose **Import an existing project**, select **GitHub**, authorize the Netlify GitHub App for this repository, and select `jmniroshan99/youtubedown`. Use production branch `main`.

Confirm the settings read from `netlify.toml`:

| Setting | Value |
|---|---|
| Base directory | `frontend` |
| Build command | `npm run build` |
| Publish directory | `dist`, relative to the base directory |
| Node.js version | `24` |

Do not enter `frontend/dist` as the publish directory when the base is already `frontend`. Netlify installs the locked frontend dependencies before building. The root SPA rewrite lets `/downloads`, `/auth/callback` and other frontend routes survive direct navigation.

Netlify's official guides cover [Vite deployment](https://docs.netlify.com/build/frameworks/framework-setup-guides/vite/) and [GitHub repository authorization](https://docs.netlify.com/build/git-workflows/repo-permissions-linking/).

## 2. Set frontend build variables

Add these in Netlify's project environment variables, with the **Builds** scope. Use the existing names exactly:

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | The existing public Supabase project URL from `frontend/.env.example` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | The existing public publishable key from that example or your configured frontend environment |
| `VITE_API_BASE_URL` | The real public HTTPS backend origin, such as `https://api.yourdomain.com` |
| `VITE_TURNSTILE_SITE_KEY` | Optional existing public Turnstile site key, if CAPTCHA is configured |

The API value must be the backend origin, without `/api`, `/health` or a query string. `127.0.0.1`, `localhost` and the local-only Vite `/backend` proxy do not work for a hosted frontend. When the variable is empty, the exact production hostname in `frontend/src/publicDeployment.json` can use that file's public API fallback. Other hostnames and local development do not use the fallback. Explicit nonempty `VITE_API_BASE_URL` configuration takes precedence, except for an exact known retired tunnel listed in that metadata; that older deployment address migrates to the verified current endpoint. To intentionally publish an unconnected interface, leave the variable unset and clear the public fallback too.

Vite embeds these public values during the build. After changing them, trigger a new deploy. Netlify does not obtain your ignored local `.env.local` file from GitHub; set the variables in Netlify. See [Netlify build environment variables](https://docs.netlify.com/build/configure-builds/environment-variables/).

Never add `SUPABASE_SECRET_KEY`, service-role credentials, Redis credentials, OAuth secrets or private server settings to `VITE_*` or the Netlify frontend environment. The public publishable key is intended for browser use; authorization still depends on Supabase policies and server identity/ownership checks.

## 3. Keep the backend separately hosted

For the selected free/no-card setup using the current PC, see [PC_BACKEND_TUNNEL.md](PC_BACKEND_TUNNEL.md). [FREE_BACKEND_HOSTING.md](FREE_BACKEND_HOSTING.md) also records conditional cloud-host alternatives; no paid resources have been provisioned.

This repository's FastAPI API, Celery worker, scheduler, Redis and guarded egress are separate long-running Docker services. The Netlify Vite build does not run that Compose stack. A frontend deployment alone does not make media analysis, preparation or downloads available.

Host the existing backend stack on an appropriate Docker host with persistent service operation, adequate temporary media resources, a domain and HTTPS. Preserve its existing `backend/.env`, secret names, private network, guarded egress and private Storage setup. The existing production deployment command is:

```powershell
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.production.yml up -d --build
```

On that host, configure `.env.production` using `.env.production.example`, with a real `API_DOMAIN` and `API_EMAIL`. Configure the existing backend environment separately, and keep both environment files out of Git. Provisioning a host/domain or selecting a paid service is a separate step; none is created by connecting Netlify to GitHub.

Set `ALLOWED_ORIGINS` on the hosted backend to the exact deployed frontend origin, for example `https://your-site.netlify.app`, plus any other origins you explicitly retain. Use the production Compose override on the public backend; the local override replaces origins with localhost values. Recreate the backend services after environment changes.

Your backend's `/health` endpoint must return HTTP 200 and `status: ready`. The frontend must be able to reach it over HTTPS with the correct CORS origin. Media files continue streaming from private temporary Storage rather than through Netlify.

## 4. Configure the production authentication URLs

Once Netlify gives you the real site URL, follow [SOCIAL_SIGN_IN.md](SOCIAL_SIGN_IN.md): set Supabase's Site URL to the production frontend origin and add its exact `/auth/callback` and `/reset-password` redirect URLs. Retain any local redirect URLs still in use. Provider callbacks continue pointing to Supabase's `/auth/v1/callback`; they do not become the Netlify callback.

This is required configuration work in the existing hosted project. No Supabase settings are changed merely by committing this guide. Guest access, existing accounts and Google/Facebook code remain in place.

## 5. Verify the deployed application

1. Open the Netlify URL and directly reload `/downloads` to verify SPA routing.
2. Use the connection check to confirm the public backend is ready and CORS allows the production frontend.
3. Verify a real guest session and configured account/social flows.
4. Analyze a permitted public sample. Pasting must only analyze; select a format and click Download to prepare a file.
5. Verify the final attachment name and Save file fallback before claiming public download functionality.

The local Fortinet certificate trust failure documented in [SOURCE_TLS_DIAGNOSIS.md](SOURCE_TLS_DIAGNOSIS.md) is specific to the observed backend connection path. Moving the frontend to Netlify does not repair that backend network/trust configuration. Access restrictions must remain enforced.

After linking GitHub, pushes to the configured production branch trigger Netlify builds/deployments. Review each deployment's result in Netlify before sharing its URL as a working service.
