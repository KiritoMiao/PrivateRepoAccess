# PrivateRepoAccess

A Cloudflare Worker that gates GitHub organization repository access behind a two-step email verification: Turnstile captcha + inbound email proof of ownership.

## How It Works

1. User visits the Worker URL and enters their email address
2. User completes a Cloudflare Turnstile captcha
3. User is instructed to send an email from that address to a verification address
4. Cloudflare Email Routing delivers the email to the Worker
5. The Worker verifies the sender matches a pending request, then sends a GitHub org invitation with team-scoped repo access

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/) with Workers and Email Routing enabled
- A domain with [Email Routing](https://developers.cloudflare.com/email-routing/) configured
- [Cloudflare Turnstile](https://dash.cloudflare.com/?to=/:account/turnstile) site key and secret key
- A GitHub organization with:
  - A bot account that has **Owner** access to the org
  - A [Personal Access Token](https://github.com/settings/tokens) from the bot account with `admin:org` scope
  - A team created in the org, with the target repo added at the desired permission level (e.g., `pull` for read-only)
- [Node.js](https://nodejs.org/) >= 18 and [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

## Setup

### 1. Clone and install

```bash
git clone git@github.com:KiritoMiao/PrivateRepoAccess.git
cd PrivateRepoAccess
npm install
```

### 2. Create KV namespace

```bash
npx wrangler kv namespace create PENDING_VERIFICATIONS
```

Copy the returned `id` value.

For local development, also create a preview namespace:

```bash
npx wrangler kv namespace create PENDING_VERIFICATIONS --preview
```

### 3. Configure `wrangler.toml`

Update the following values in `wrangler.toml`:

```toml
[vars]
TURNSTILE_SITE_KEY = "0x4AAAAAAA..."          # From Cloudflare Turnstile dashboard
GITHUB_ORG = "YourOrgName"                     # GitHub organization name
GITHUB_REPO = "your-repo"                      # Repository to grant access to
GITHUB_ROLE = "direct_member"                  # Org role (direct_member or admin)
GITHUB_TEAM_SLUG = "your-team-slug"            # Team slug (from the team URL)
GITHUB_PERMISSION = "pull"                     # Repo permission: pull, push, admin, maintain, triage
VERIFICATION_EMAIL = "verify@yourdomain.com"   # Address users send verification email to

[[kv_namespaces]]
binding = "PENDING_VERIFICATIONS"
id = "<your-kv-namespace-id>"                  # From step 2
preview_id = "<your-preview-kv-namespace-id>"  # From step 2
```

### 4. Set secrets

```bash
npx wrangler secret put TURNSTILE_SECRET_KEY
# Paste your Turnstile secret key

npx wrangler secret put GITHUB_PAT
# Paste your GitHub bot account PAT
```

### 5. Configure Email Routing

In the [Cloudflare dashboard](https://dash.cloudflare.com/):

1. Go to your domain > **Email Routing** > **Email Workers**
2. Create a new route:
   - **Custom address**: the address from `VERIFICATION_EMAIL` (e.g., `verify@yourdomain.com`)
   - **Destination**: select your deployed Worker (`worker-access-interface`)

> **Note**: Deploy the Worker first (step 6), then configure the email route.

### 6. Deploy

```bash
npx wrangler deploy
```

The Worker will be available at `https://worker-access-interface.<your-subdomain>.workers.dev`.

## Local Development

```bash
npx wrangler dev
```

Visit `http://localhost:8787` to test the web UI. Note that Email Routing is not available locally — only the HTTP endpoints can be tested in dev mode.

For Turnstile testing, use the [test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/) provided by Cloudflare.

## Testing

```bash
npm test              # Run all tests
npm run test:watch    # Run in watch mode
```

## GitHub Team Setup

The Worker uses a team-based permission model. Before deploying:

1. Go to your GitHub org > **Teams** > **New team**
2. Create a team (e.g., `repo-readers`)
3. Go to the team > **Repositories** > **Add repository**
4. Add your target repo and set the permission level (e.g., `Read`)
5. Use the team's URL slug as `GITHUB_TEAM_SLUG` in `wrangler.toml`

When a user completes verification, they receive an org invitation that automatically adds them to this team, granting the configured repo permission.

## Environment Variables Reference

| Variable | Type | Description |
|----------|------|-------------|
| `TURNSTILE_SITE_KEY` | Env var | Turnstile widget key (public, embedded in HTML) |
| `TURNSTILE_SECRET_KEY` | Secret | Turnstile server-side validation key |
| `GITHUB_PAT` | Secret | Bot account PAT with `admin:org` scope |
| `GITHUB_ORG` | Env var | GitHub organization name |
| `GITHUB_REPO` | Env var | Target repository name |
| `GITHUB_ROLE` | Env var | Org invitation role (default: `direct_member`) |
| `GITHUB_TEAM_SLUG` | Env var | Team slug for repo-scoped access |
| `GITHUB_PERMISSION` | Env var | Repo permission level (default: `pull`) |
| `VERIFICATION_EMAIL` | Env var | Email address users send verification to |

## Architecture

```
User Browser                Cloudflare Worker              GitHub API
     │                            │                            │
     │── GET / ──────────────────>│                            │
     │<──── HTML page ────────────│                            │
     │                            │                            │
     │── POST /api/verify ───────>│                            │
     │   (email + turnstile)      │── verify token ──> Turnstile API
     │<──── { token } ────────────│<── success ────────────────│
     │                            │── store in KV              │
     │                            │                            │
     │── poll /api/status ───────>│                            │
     │<──── { pending } ──────────│                            │
     │                            │                            │
     │  User sends email ────────>│ (via Email Routing)        │
     │                            │── match sender to KV       │
     │                            │── resolve team ───────────>│
     │                            │── set repo permission ────>│
     │                            │── send org invitation ────>│
     │                            │<── 201 Created ────────────│
     │                            │── update KV status         │
     │                            │                            │
     │── poll /api/status ───────>│                            │
     │<──── { completed } ────────│                            │
```
