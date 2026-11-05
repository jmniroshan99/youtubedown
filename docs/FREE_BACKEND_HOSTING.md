# Free backend hosting for the Netlify frontend

The frontend is deployed at `https://youtubedownl.netlify.app`. Analysis and downloads need a separate host for the existing API, Celery worker, scheduler, Redis and guarded egress. No server has been provisioned by this guide.

The user selected **free, no card, and use the existing PC for now**. Use [PC_BACKEND_TUNNEL.md](PC_BACKEND_TUNNEL.md) for that setup. The optional Oracle route below requires card verification and is not the selected deployment path.

## Free option and eligibility

Oracle's current [Always Free compute documentation](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) lists a total Ampere A1 allowance equivalent to **2 OCPUs and 12 GB RAM** in the account's home region, plus 200 GB of block storage across eligible volumes. Use the current Console's Always Free eligibility labels and account totals when creating resources. Do not rely on older guides advertising 4 OCPUs / 24 GB. A 50 GB boot volume is sufficient for an initial installation; media still uses isolated temporary processing and private Storage.

Free capacity can be unavailable and idle instances can be reclaimed. Oracle's [Free Tier FAQ](https://www.oracle.com/cloud/free/faq/) requires card-based identity verification. Stay on Always Free resources within the displayed limits; trial credits do not establish that a resource remains free after the trial. No paid upgrade is part of this deployment plan.

The 1 GB micro shape does not fit the existing media-worker configuration. This guide uses A1/ARM64. The Docker base images have ARM variants, but this project has not yet been built or exercised on a real Oracle ARM server; that verification is required after server creation.

If signup/card verification or free capacity is unavailable, this route is not ready to deploy. A free static frontend or a single sleeping web service does not replace the running worker and isolated networking. We will need another suitable free Docker host or a user-controlled server. No free-host availability guarantee is made.

## 1. Create the server in your own account

1. Sign up at [Oracle Cloud Free Tier](https://signup.cloud.oracle.com/).
2. In the selected home region, create an Always Free-eligible Ubuntu 24.04 ARM64 VM using `VM.Standard.A1.Flex`, within the current account allowance. Use a public subnet and assign a public IPv4 address.
3. Save your SSH key securely. Keep private keys and cloud/card credentials out of this repository and chat.
4. In the VM's security list/network security group, permit TCP 80 and 443 for the HTTPS gateway. Limit SSH/TCP 22 to your administrator connection. The existing gateway also supports optional UDP 443 for HTTP/3. Keep the API's internal port, Redis and egress ports private. Preserve host firewall protections.
5. Record the public IPv4 address. Server creation and a running instance must be confirmed before filling in Netlify's API URL.

## 2. Use a free API hostname

[sslip.io / nip.io](https://sslip.io/) resolves hostnames containing a public IP to that address and documents obtaining public TLS certificates with an HTTP-01 server such as Caddy. No purchased domain is required. For your actual server IP, use:

```text
api-PUBLIC-IP-WITH-DASHES.sslip.io
```

For example, the hostname pattern is `api-203-0-113-10.sslip.io`; that example IP is reserved documentation space and must not be used for a real deployment. Replace it with your server's actual public IP. This third-party hostname depends on that DNS service and certificate issuance/rate limits. If the server IP changes, the hostname and frontend configuration need updating. [DuckDNS](https://www.duckdns.org/about.jsp) is another free subdomain option if you prefer to register a stable name and update its IP.

## 3. Install and configure on the server

Connect to the Ubuntu VM using your own SSH client. Install Git and Docker Engine/Compose using [Docker's official Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/). Compose must support `!reset` (2.24.4 or later). Then:

```bash
git clone https://github.com/jmniroshan99/youtubedown.git
cd youtubedown
umask 077
cp backend/.env.example backend/.env
cp .env.production.example .env.production
chmod 600 backend/.env .env.production
```

Run those copy commands only for a new checkout with no existing environment files; retain existing files during updates. If the repository is private, use an appropriately scoped GitHub authentication method without embedding tokens in the clone URL.

Edit `backend/.env` privately on the server. Retain the existing environment names and the remaining limits, changing only the necessary deployment values:

```dotenv
SUPABASE_SECRET_KEY=YOUR_EXISTING_SERVER_ONLY_SECRET
ALLOWED_ORIGINS=https://youtubedownl.netlify.app
```

Keep the existing `SUPABASE_URL`, `MEDIA_PROXY`, `REDIS_URL`, guest policies and cleanup configuration. Get the server secret from your existing backend configuration or Supabase's private project settings; it must never become a Netlify `VITE_*` variable.

Edit the server's `.env.production`:

```dotenv
API_DOMAIN=api-YOUR-PUBLIC-IP-WITH-DASHES.sslip.io
API_EMAIL=YOUR_CERTIFICATE_CONTACT_EMAIL
```

`API_DOMAIN` is a hostname without `https://` or a path. These are placeholders, not deployable values. The existing Caddy configuration obtains and renews the public certificate once the hostname resolves correctly and challenges can reach ports 80/443.

## 4. Start and verify the existing stack

```bash
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.production.yml up -d --build
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.production.yml ps
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.production.yml exec -T worker python -m app.egress_check
```

Use the production override, which preserves guarded internal networking and the HTTPS gateway. Do not add the local override. Preserve the `videoflow` project name and existing volume identifiers. Never expose Redis or make the Storage bucket public.

Verify `https://YOUR-ACTUAL-API-HOST/health` returns HTTP 200 with `status: ready` and its CORS behavior allows `https://youtubedownl.netlify.app`. Test actual permitted media analysis, preparation, private attachment delivery and cleanup on the ARM host before claiming it works. A source TLS/access restriction remains a real failure; do not disable certificate verification or bypass source restrictions.

## 5. Connect Netlify and authentication

In the Netlify project, set:

```dotenv
VITE_API_BASE_URL=https://YOUR-ACTUAL-API-HOST
```

Rebuild/redeploy the frontend. The URL has no `/api` suffix. Existing Supabase public frontend values remain unchanged. Configure the production Supabase Site URL and exact frontend callback/reset destinations using [SOCIAL_SIGN_IN.md](SOCIAL_SIGN_IN.md); do not replace the provider's Supabase callback with the API hostname.

The production backend, Netlify configuration and authentication redirects are still pending until the cloud account, server, real HTTPS API hostname and account access exist. Nothing in this document creates paid resources or makes an unverified deployment claim.
