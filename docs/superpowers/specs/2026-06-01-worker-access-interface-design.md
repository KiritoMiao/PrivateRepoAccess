# Worker Access Interface — Design Spec

**Date:** 2026-06-01
**Status:** Draft

## Overview

A Cloudflare Worker that serves as a self-service access-request portal for a GitHub organization repository. Users prove email ownership through a two-step verification (Turnstile captcha + inbound email), then receive an automatic invitation as a read-only collaborator on the target repo.

## Goals

- Gate repository access behind verified email ownership
- Prevent automated abuse via Turnstile captcha
- Fully configurable via environment variables — portable across orgs/repos
- Minimal infrastructure: single Worker, one KV namespace, Cloudflare Email Routing

## Architecture

Single Cloudflare Worker with two handler exports:

- **`fetch`** — serves the web UI, handles Turnstile verification, exposes status polling endpoint
- **`email`** — receives inbound verification emails via Cloudflare Email Routing, matches sender to pending request, triggers GitHub org invitation

### Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `PENDING_VERIFICATIONS` | KV Namespace | Stores short-lived verification state |

### Environment Variables

| Variable | Type | Purpose |
|----------|------|---------|
| `TURNSTILE_SITE_KEY` | Env var | Turnstile widget key (exposed to client in HTML) |
| `TURNSTILE_SECRET_KEY` | Secret | Server-side Turnstile token validation |
| `GITHUB_PAT` | Secret | Bot account PAT with `admin:org` scope |
| `GITHUB_ORG` | Env var | GitHub organization name |
| `GITHUB_REPO` | Env var | Repository name to grant access to |
| `GITHUB_ROLE` | Env var | Org invitation role (e.g., `direct_member`) |
| `GITHUB_TEAM_SLUG` | Env var | Team slug for repo-scoped access |
| `GITHUB_PERMISSION` | Env var | Repo permission level granted to users (default: `pull` for read-only) |
| `VERIFICATION_EMAIL` | Env var | Address users must send verification email to |

## User Flow

```
User visits Worker URL
        │
        ▼
┌────────────────────────────┐
│  Step 1: Email + Turnstile │
│  [email input]             │
│  [Turnstile widget]        │
│  [Submit]                  │
└────────────┬───────────────┘
             │
             ▼
  Worker validates Turnstile token server-side
  Stores verification record in KV (30min TTL)
  Returns verification token to client
             │
             ▼
┌────────────────────────────────────┐
│  Step 2: Send Verification Email   │
│  "Send any email from              │
│   user@example.com to:             │
│   verify@yourdomain.com"           │
│                                    │
│  Status: Waiting for email... ⏳    │  ← polls GET /api/status/:token
└────────────┬───────────────────────┘
             │
  Email arrives at verification address
  Cloudflare Email Routing → Worker email handler
  Handler matches sender → KV record
  Calls GitHub API: POST /orgs/{org}/invitations
  Updates KV status
             │
             ▼
┌────────────────────────────────────┐
│  Step 3: Result (via polling)      │
│                                    │
│  ✓ Invitation sent! Check GitHub.  │
│  OR                                │
│  ✗ GitHub API error. Try again.    │
└────────────────────────────────────┘
```

## API Endpoints

### `GET /`

Serves the single-page HTML application containing all three steps. The page transitions between steps client-side based on state.

### `POST /api/verify-turnstile`

**Request body:**
```json
{
  "email": "user@example.com",
  "turnstileToken": "xxx"
}
```

**Logic:**
1. Validate email format
2. Verify Turnstile token with `https://challenges.cloudflare.com/turnstile/v0/siteverify`
3. Check if a pending record already exists for this email (idempotent — return existing token)
4. Generate a random verification token (UUID v4)
5. Write two KV entries (both with 30min TTL):
   - `verify:{token}` → `{ email, status, createdAt }`
   - `email:{normalized_email}` → `token` (secondary index for email handler lookup)
6. Return `{ token }` to client

**Responses:**
- `200` — `{ "token": "uuid" }`
- `400` — invalid email or missing fields
- `403` — Turnstile verification failed

### `GET /api/status/:token`

**Logic:**
1. Look up `verify:{token}` in KV
2. Return current status

**Response:**
```json
{
  "status": "pending_email | completed | failed_github_api",
  "message": "Human-readable status message"
}
```

- `200` — record found, status returned
- `404` — token not found or expired

## Email Handler

Triggered by Cloudflare Email Routing when an email arrives at the verification address.

**Logic:**
1. Extract sender address from the `from` header, normalize (lowercase, trim)
2. Look up `email:{normalized_email}` in KV to get the verification token
3. If no match → silently drop (no KV record means no pending request or expired)
4. Look up `verify:{token}` to get full record
5. If status is not `pending_email` → skip (already processed)
6. Resolve team ID: `GET /orgs/{org}/teams/{team_slug}`
   - Cache the team ID in KV (`team_id:{slug}` with 1-hour TTL) to avoid repeated lookups
   - Headers: `Authorization: Bearer {GITHUB_PAT}`, `Accept: application/vnd.github+json`
7. Ensure team has correct repo permission: `PUT /orgs/{org}/teams/{team_slug}/repos/{org}/{repo}`
   - Body: `{ "permission": "{GITHUB_PERMISSION}" }` (defaults to `pull` for read-only)
   - Idempotent — safe to call every time, ensures env var is the source of truth
8. Call GitHub API: `POST /orgs/{org}/invitations`
   - Body: `{ "email": "{email}", "role": "{GITHUB_ROLE}", "team_ids": [{team_id}] }`
   - This invites the user to the org AND adds them to the team in a single call
8. Update KV record status to `completed` (on success) or `failed_github_api` (on failure)
9. Delete the `email:` secondary index key (cleanup)

**GitHub permission model — team-based (chosen approach):**
Since we invite by email (no GitHub username available), we use the team-based flow:
1. A team is pre-created in the GitHub org with the target repo attached at the desired permission level (e.g., `pull` for read-only)
2. The `POST /orgs/{org}/invitations` endpoint accepts `team_ids`, adding the invited user to the team upon acceptance
3. This grants the correct repo permission automatically — no second API call needed after invitation

**Prerequisite:** The org admin must create a team, add the target repo to it with the desired permission, and provide the team slug as `GITHUB_TEAM_SLUG`.

## KV Schema

### Primary record: `verify:{token}`

```json
{
  "email": "user@example.com",
  "status": "pending_email",
  "createdAt": 1717200000
}
```

**Status values:**
- `pending_email` — Turnstile passed, awaiting verification email
- `completed` — GitHub invitation sent successfully
- `failed_github_api` — GitHub API call failed

**TTL:** 1800 seconds (30 minutes)

### Secondary index: `email:{normalized_email}`

**Value:** The verification token string (e.g., `"a1b2c3d4-..."`)

**TTL:** 1800 seconds (30 minutes)

**Email normalization:** lowercase, trim whitespace.

## Frontend

A single HTML page served inline from the Worker (no external assets except the Turnstile script). Three visual states managed client-side:

1. **Email form** — email input, Turnstile widget, submit button
2. **Awaiting email** — instructions to send verification email, polling indicator
3. **Result** — success or failure message

Polling: the client polls `GET /api/status/:token` every 3 seconds after transitioning to step 2. Stops on terminal status (`completed` or `failed_*`) or after 30 minutes (matching KV TTL).

**Styling:** Minimal, clean design. No framework — plain HTML/CSS/JS. Dark/light mode via `prefers-color-scheme`.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Invalid email format | 400 response, show validation error |
| Turnstile fails | 403 response, show error, allow retry |
| Duplicate email submission | Idempotent — return existing token |
| Email not received within 30min | KV expires, client polling gets 404, show "expired" message |
| Unrecognized sender email | Email handler silently drops (no matching KV record) |
| GitHub API returns error | Set status to `failed_github_api`, show retry message |
| User already an org member | GitHub API returns 422 — treat as success, update status to `completed` |

## Security Considerations

- **Turnstile** prevents automated/bot submissions
- **Email verification** proves ownership of the address
- **KV TTL** (30min) ensures stale tokens auto-expire
- **GitHub PAT** stored as a Worker secret, never exposed to client
- **PAT scope** should be minimal: `admin:org` for invitations
- **Status endpoint** returns only status enum and a message — no PII or tokens leaked
- **Email handler** is non-interactive — no response sent to sender, no information leakage
- **Input validation** on email format before any processing

## Tech Stack

- **Runtime:** Cloudflare Workers (ES modules format)
- **Language:** TypeScript
- **State:** Cloudflare Workers KV
- **Email:** Cloudflare Email Routing (Email Workers)
- **Captcha:** Cloudflare Turnstile
- **External API:** GitHub REST API v3
- **Build/Deploy:** Wrangler CLI

## Project Structure

```
/
├── src/
│   ├── index.ts          # Worker entry — exports fetch and email handlers
│   ├── handlers/
│   │   ├── page.ts       # GET / — serves HTML
│   │   ├── turnstile.ts  # POST /api/verify-turnstile
│   │   ├── status.ts     # GET /api/status/:token
│   │   └── email.ts      # Email handler
│   ├── services/
│   │   ├── turnstile.ts  # Turnstile token verification
│   │   ├── github.ts     # GitHub API client (org invite)
│   │   └── kv.ts         # KV read/write helpers
│   ├── html/
│   │   └── page.ts       # HTML template (inline, returns string)
│   └── types.ts          # Shared TypeScript types (Env, KV records)
├── wrangler.toml          # Worker config, KV binding, env vars
├── package.json
└── tsconfig.json
```

## Testing Strategy

- **Unit tests:** Vitest with `miniflare` for KV/email mocking. Cover:
  - Turnstile verification (success, failure, invalid input)
  - KV record creation and lookup
  - Email handler matching logic
  - GitHub API call construction
  - Idempotent duplicate handling
- **Integration test:** Full flow with mocked external APIs (Turnstile siteverify, GitHub)
- **Manual test:** Deploy to a staging Worker, test with real Turnstile + email

## Deployment Prerequisites

1. Cloudflare account with Workers and Email Routing enabled
2. Domain with Email Routing configured to forward to the Worker
3. Turnstile site key and secret key (from Cloudflare dashboard)
4. GitHub bot account with PAT (`admin:org` scope)
5. GitHub org with the target repo
