# Admin Review & Approval Flow — Design Spec

**Date:** 2026-06-04
**Status:** Draft

## Overview

Add a manual admin approval step between email verification and GitHub org invitation. After a user passes Turnstile + email verification, instead of being added to the GitHub team automatically, they enter a **pending review** list. The admin is notified via a configurable webhook and approves or declines each request from a token-protected admin page.

## Goals

- Replace automatic invitation with admin-gated approval
- Notify admin of new requests via any webhook endpoint (Telegram, Discord, Slack, custom)
- Provide an admin page listing all pending requests with approve/decline actions
- Persist pending requests indefinitely until acted on

## Status Lifecycle

```
pending_email ──(email received)──> pending_review ──(admin approves)──> approved
                                                   ╲─(admin declines)──> declined
                                                   ╲─(invite fails)────> failed_github_api
```

**Status values:**
- `pending_email` — Turnstile passed, awaiting verification email (existing)
- `pending_review` — email verified, awaiting admin decision (new)
- `approved` — admin approved, GitHub invitation sent (new)
- `declined` — admin declined the request (new)
- `failed_github_api` — GitHub invitation failed after approval (existing, repurposed)

## Data Model

### Existing entries (unchanged, 30-min TTL)

- `verify:{token}` → `{ email, status, createdAt }` — captcha→email window
- `email:{normalized_email}` → `token` — secondary index for email handler

### New entry: review request (no TTL — persists until acted on)

**Key:** `review:{reviewId}` where `reviewId` is a UUID v4

**Value:**
```json
{
  "email": "user@example.com",
  "status": "pending_review",
  "createdAt": 1717200000,
  "reviewedAt": null
}
```

**KV metadata** (set on `put`, returned by `list` without needing a `get`):
```json
{ "email": "user@example.com", "status": "pending_review", "createdAt": 1717200000 }
```

The admin list uses `kv.list({ prefix: "review:" })` and reads each key's metadata to render the table — avoiding N separate `get` calls.

### Team ID cache (unchanged)

- `team_id:{slug}` → numeric team id (1-hour TTL)

## Flow Detail

### Email handler (modified)

When a verification email arrives and matches a `pending_email` record:

1. Generate `reviewId` (UUID v4)
2. Create `review:{reviewId}` with status `pending_review`, value + metadata, **no TTL**
3. Update `verify:{token}` status to `pending_review` (so the frontend poll reflects it)
4. Send webhook notification (failures logged, do not abort)
5. Delete the `email:{normalized_email}` index
6. **Do NOT** call GitHub — invitation is deferred to admin approval

### Admin approve

`POST /api/admin/approve` with `{ reviewId, token }`:

1. Validate `token` against `ADMIN_TOKEN` (constant-time compare)
2. Load `review:{reviewId}`; if missing or not `pending_review`, return 404/409
3. Run GitHub invitation via the `invite` service (resolve team → ensure repo permission → send org invitation)
4. On success: update review status to `approved`, set `reviewedAt`
5. On failure: update review status to `failed_github_api`, return 502

### Admin decline

`POST /api/admin/decline` with `{ reviewId, token }`:

1. Validate `token`
2. Load `review:{reviewId}`; if missing, return 404
3. Update status to `declined`, set `reviewedAt`

## Webhook Notification

### Configuration

- `WEBHOOK_URL` — endpoint to POST to
- `WEBHOOK_TEMPLATE` — JSON string body with placeholders `{{title}}`, `{{text_short}}`, `{{text_long}}`

### Behavior

When a review request is created, the Worker:

1. Builds three values:
   - `title` = `"New repo access request"`
   - `text_short` = the requester's email
   - `text_long` = `"Email: {email}\nRequested: {ISO timestamp}\nReview: {PUBLIC_URL}/admin?token={ADMIN_TOKEN}"`
2. JSON-escapes each value (so quotes/newlines in the email can't break the JSON body)
3. Substitutes placeholders in `WEBHOOK_TEMPLATE`
4. POSTs the result with `Content-Type: application/json`

If `WEBHOOK_URL` is empty, the webhook step is skipped. Webhook errors are caught and logged at error level — they never abort review creation.

### Example templates

**Telegram:**
```json
{"chat_id":"123456789","text":"*{{title}}*\n\n{{text_long}}","parse_mode":"Markdown"}
```

**Discord:**
```json
{"content":"**{{title}}**\n{{text_long}}"}
```

**Slack:**
```json
{"text":"{{title}}: {{text_short}}\n{{text_long}}"}
```

## Admin Page

### `GET /admin?token={ADMIN_TOKEN}`

1. Validate `token` query param against `ADMIN_TOKEN` (constant-time compare). On mismatch, return 401 with a minimal "Unauthorized" page.
2. List all `review:*` entries via `kv.list({ prefix: "review:" })`
3. Render a dark-themed HTML table sorted by `createdAt` descending:
   - Columns: Email, Requested At, Status, Actions
   - Pending rows show **Approve** and **Decline** buttons
   - Non-pending rows show the final status (approved/declined/failed) with no buttons
4. The token is read from the page URL by client-side JS and included in approve/decline POST bodies

### Client-side actions

Approve/Decline buttons POST to `/api/admin/approve` or `/api/admin/decline` with `{ reviewId, token }`. On success, the row updates in place (or the page reloads). Errors show an inline message.

## API Endpoints Summary

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/` | none | Web UI (existing) |
| `POST` | `/api/verify-turnstile` | Turnstile | Create verification (existing) |
| `GET` | `/api/status/:token` | none | Poll status (existing) |
| `GET` | `/admin` | `?token=` | Admin review list (new) |
| `POST` | `/api/admin/approve` | token in body | Approve a request (new) |
| `POST` | `/api/admin/decline` | token in body | Decline a request (new) |

## Frontend Changes (`src/html/page.ts`)

Step 3 (result) gains a new state for `pending_review`:

> **Request Submitted!**
> Your access request is pending admin review. You'll receive a GitHub invitation by email once approved.

The poll loop treats `pending_review` as a terminal state (stops polling, shows the message above). `approved` shows the existing success message; `declined` shows a "request was declined" message.

## Status Endpoint Changes (`src/handlers/status.ts`)

Add messages for the new statuses:
- `pending_review` → "Your request is pending admin review."
- `approved` → "Approved! Check your email for the GitHub invitation."
- `declined` → "Your request was declined."

## Environment Variables / Secrets

| Variable | Type | Purpose |
|----------|------|---------|
| `WEBHOOK_URL` | Env var | Endpoint to POST notifications to (empty = disabled) |
| `WEBHOOK_TEMPLATE` | Env var | JSON body template with `{{title}}`/`{{text_short}}`/`{{text_long}}` |
| `PUBLIC_URL` | Env var | Worker base URL, e.g. `https://worker-access-interface.kirito.workers.dev` |
| `ADMIN_TOKEN` | Secret | Protects admin page and approve/decline endpoints |

All existing env vars (KV_BINDING_NAME, LOG_LEVEL, TURNSTILE_*, GITHUB_*, VERIFICATION_EMAIL) are unchanged.

## File Structure

```
src/
├── index.ts              # MODIFIED: add /admin, /api/admin/* routes
├── types.ts              # MODIFIED: new env vars, statuses, ReviewRecord type
├── handlers/
│   ├── email.ts          # MODIFIED: create review + webhook instead of invite
│   ├── status.ts         # MODIFIED: new status messages
│   └── admin.ts          # NEW: handleAdminPage, handleApprove, handleDecline
├── services/
│   ├── kv.ts             # MODIFIED: createReview, listReviews, getReview, updateReviewStatus
│   ├── webhook.ts        # NEW: sendWebhook(env, title, short, long)
│   ├── invite.ts         # NEW: performInvitation(env, email) — extracted from email.ts
│   ├── github.ts         # unchanged
│   └── turnstile.ts      # unchanged
└── html/
    ├── page.ts           # MODIFIED: pending_review / declined result states
    └── admin.ts          # NEW: admin page HTML template
```

## New Types (`src/types.ts`)

```typescript
export type VerificationStatus =
  | "pending_email"
  | "pending_review"
  | "approved"
  | "declined"
  | "failed_github_api";

export interface ReviewRecord {
  email: string;
  status: VerificationStatus;
  createdAt: number;
  reviewedAt: number | null;
}

export interface ReviewMetadata {
  email: string;
  status: VerificationStatus;
  createdAt: number;
}
```

`VerificationRecord` reuses the same status union.

## Invite Service (`src/services/invite.ts`)

Extracts the orchestration currently inline in `email.ts`:

```typescript
export async function performInvitation(env: Env, email: string): Promise<void> {
  // resolve team id (with KV cache)
  // ensure repo permission
  // send org invitation
}
```

Called by the admin approve handler. The team-id KV cache logic moves here too.

## Security Considerations

- **Admin token**: stored as a Worker secret, compared in constant time to mitigate timing attacks. Transmitted in the URL (accepted tradeoff per design) and webhook body.
- **Webhook injection**: all placeholder values are JSON-escaped before substitution, preventing email content from breaking out of the JSON body or injecting fields.
- **Approve/decline auth**: every admin API call re-validates the token; no session state.
- **No GitHub call before approval**: the PAT is only exercised on explicit admin approval, reducing blast radius of automated abuse.
- **Idempotency**: approving an already-approved request is a no-op (status check returns 409).

## Testing Strategy

Unit tests (Vitest + Miniflare):
- **kv.ts**: createReview writes value + metadata; listReviews returns all with metadata; updateReviewStatus mutates status + reviewedAt
- **webhook.ts**: placeholder substitution; JSON-escaping of special chars; empty URL skips POST; fetch failure is swallowed
- **invite.ts**: orchestration calls team resolve → permission → invite in order; team-id cache hit skips resolve
- **admin.ts**: approve with valid token invites + sets approved; approve with bad token → 401; approve missing review → 404; decline sets declined; approve already-processed → 409
- **email.ts**: now creates review + calls webhook, does NOT call GitHub
- **status.ts**: returns correct messages for new statuses

## Out of Scope

- Email notification to the requester on approval (GitHub already emails the invite)
- Multiple admin accounts / roles
- Audit log beyond Worker logs
- Pagination of the admin list (acceptable for expected volume)
