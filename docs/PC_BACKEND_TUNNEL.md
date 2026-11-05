# Free temporary PC backend for Netlify

The selected setup is the existing Windows PC/Docker backend with a [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/). It needs no purchased domain or Cloudflare account. It is a testing/development connection with no uptime guarantee; the PC and Docker Desktop must stay running. A new tunnel gets a new hostname.

Run `start-netlify-backend.bat` in the project directory. It combines the existing base/local Compose configuration with the optional `docker-compose.tunnel.yml`, starts the pinned official cloudflared connector, and verifies public HTTPS readiness and exact-origin CORS. The API allows `https://youtubedownl.netlify.app` alongside the retained local origins. Worker, Redis and guarded source egress remain on their existing networks. No source restrictions or TLS verification are bypassed.

The normal start reuses existing images and a running connector; it does not rebuild the backend on every run. For a source update, finish/cancel active preparations first and use `start-netlify-backend.bat -Rebuild`. The first CORS configuration change can recreate the API. A stopped connector receives at most one ordinary bootstrap retry. Only logs from its current start are used to find the address.

The script prints a public URL and saves only non-secret connection information in ignored `.runtime/netlify-tunnel.json`. Set Netlify's **existing** `VITE_API_BASE_URL` build variable to that HTTPS origin, then redeploy. Do not append `/api` or `/health`. Keep the existing Supabase public frontend variables. Netlify account authorization and environment updates remain user actions unless an authorized account connection is available.

Run `stop-netlify-backend.bat` to close public tunnel access. It stops only the connector and retains local backend services and volumes. Closing the script window does not stop a detached connector. If you use the ordinary `start.bat`/`repair-downloads.bat` later, they use the local-only override; rerun the tunnel start script to restore the Netlify CORS origin.

Normal verified Supabase identity, ownership, quotas and private prepared-file staging still apply to public requests. The local gateway replaces forwarded IP headers with its peer, so requests through the connector may share a stricter network quota; arbitrary client forwarding headers do not gain trust. Only the gateway's API routes are forwarded. The tunnel does not expose the source directory, Redis or the worker ports.

Quick Tunnels stop working when their connector stops, support at most 200 in-flight requests and do not support SSE. This app uses HTTP polling and private Storage file delivery. These limits still make the tunnel a temporary testing arrangement, not continuous cloud hosting. Source certificate/access failures, including the observed Fortinet issue, remain subject to the existing restrictions.

After connecting Netlify, verify connection status, a real guest/account session and a permitted public-media preparation/download. Configure the exact production Supabase callback/reset URLs as documented in [SOCIAL_SIGN_IN.md](SOCIAL_SIGN_IN.md). A public health check alone does not prove the complete guest/download flow.

## Verified during setup on 5 November 2026

The first anonymous tunnel-creation request ended with EOF. One ordinary connector restart succeeded, issued a public hostname and registered an edge connection. Public verified HTTPS `/health` returned ready, the exact Netlify CORS preflight passed, an untrusted-origin preflight returned 400 and unauthenticated `/api/downloads` access returned 401. Rerunning the final start script preserved the API/worker/connector container IDs and the current URL. The merged Compose check confirmed that private service ports, worker networks and mandatory source egress stayed intact. No TLS checks were disabled.

The frontend build, lint and 92 tests passed, including the new missing-backend check before guest authentication. Backend application code was unchanged in this hosting step; the earlier 275-test backend result remains the application baseline. Netlify's `VITE_API_BASE_URL` update/redeploy and a complete authenticated browser download through the deployed frontend are still pending user account access. No such end-to-end success is claimed here.
