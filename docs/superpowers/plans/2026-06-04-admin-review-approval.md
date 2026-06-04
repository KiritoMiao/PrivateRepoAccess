# Admin Review & Approval Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert a manual admin approval step between email verification and GitHub invitation, with webhook notifications and a token-protected admin page.

**Architecture:** Email verification now creates a persistent `pending_review` record and fires a configurable webhook instead of inviting directly. An admin reviews requests on a token-protected page; approval triggers the GitHub invitation (extracted into a reusable `invite` service), decline marks the record `declined`.

**Tech Stack:** Cloudflare Workers (TypeScript), Workers KV (with list + metadata), Cloudflare Email Routing, GitHub REST API, Vitest + Miniflare.

**Spec:** `docs/superpowers/specs/2026-06-04-admin-review-approval-design.md`

---

## Existing Code Reference

- `src/types.ts` — `Env`, `createLogger`, `getKV`, `VerificationStatus` (currently `pending_email | completed | failed_github_api`), `VerificationRecord`
- `src/services/kv.ts` — `createVerification`, `getVerification`, `getTokenByEmail`, `updateVerificationStatus`, `deleteEmailIndex`, internal `normalizeEmail`, `TTL = 1800`
- `src/services/github.ts` — `resolveTeamId`, `ensureRepoPermission`, `sendOrgInvitation`
- `src/handlers/email.ts` — currently does the full GitHub invite inline
- `src/handlers/status.ts` — `STATUS_MESSAGES` map + `handleStatus`
- `src/index.ts` — router with `fetch` + `email` exports
- `src/html/page.ts` — frontend SPA; poll loop checks `data.status === "completed"`
- `test/env.d.ts` — `ProvidedEnv extends Env` + `FAASGAUGE_REPO_PENDING_VERIFICATIONS: KVNamespace`

**Testing note:** Tests get `env` from `cloudflare:test` (reads `wrangler.toml` `[vars]` + the KV binding). Secrets and new vars (`ADMIN_TOKEN`, `WEBHOOK_URL`, etc.) are NOT in `wrangler.toml`, so tests that need them construct a derived env: `const testEnv = { ...env, ADMIN_TOKEN: "test-token" }`. Spreading preserves `KV_BINDING_NAME` and the KV namespace binding so `getKV` still works.

---

### Task 1: Extend Types

**Files:**
- Modify: `src/types.ts`
- Modify: `test/env.d.ts`

- [ ] **Step 1: Update the Env interface and status union in `src/types.ts`**

Replace the `Env` interface (lines 1-13) to add the four new vars:

```typescript
export interface Env {
  KV_BINDING_NAME: string;
  LOG_LEVEL: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  GITHUB_PAT: string;
  GITHUB_ORG: string;
  GITHUB_REPO: string;
  GITHUB_ROLE: string;
  GITHUB_TEAM_SLUG: string;
  GITHUB_PERMISSION: string;
  VERIFICATION_EMAIL: string;
  WEBHOOK_URL: string;
  WEBHOOK_TEMPLATE: string;
  PUBLIC_URL: string;
  ADMIN_TOKEN: string;
}
```

Replace the `VerificationStatus` type and `VerificationRecord` (lines 36-45) with the new statuses plus review types:

```typescript
export type VerificationStatus =
  | "pending_email"
  | "pending_review"
  | "approved"
  | "declined"
  | "failed_github_api";

export interface VerificationRecord {
  email: string;
  status: VerificationStatus;
  createdAt: number;
}

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

Leave `createLogger` and `getKV` unchanged.

- [ ] **Step 2: Run TypeScript to find broken references**

Run: `npx tsc --noEmit`
Expected: Error in `src/handlers/status.ts` — `STATUS_MESSAGES` no longer covers all `VerificationStatus` members (missing `pending_review`, `approved`, `declined`; has removed `completed`). This is expected and fixed in Task 6. Also `src/handlers/email.ts` line 68 uses `"completed"` which is no longer valid — fixed in Task 5.

(No commit yet — types are foundational and leave the build red until dependent tasks land. Proceed to Step 3.)

- [ ] **Step 3: Verify test env declaration still compiles its own file**

`test/env.d.ts` already does `interface ProvidedEnv extends Env`, so the new vars are inherited automatically. No change needed there. Confirm the file still reads:

```typescript
import type { Env } from "../src/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    FAASGAUGE_REPO_PENDING_VERIFICATIONS: KVNamespace;
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "feat: add admin review env vars and status types"
```

---

### Task 2: KV Review CRUD

**Files:**
- Modify: `src/services/kv.ts`
- Create: `test/services/kv-review.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/services/kv-review.test.ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  createReview,
  getReview,
  listReviews,
  updateReviewStatus,
} from "../../src/services/kv";

const kv = env.FAASGAUGE_REPO_PENDING_VERIFICATIONS;

describe("KV review CRUD", () => {
  it("creates a review with value and metadata", async () => {
    const reviewId = await createReview(kv, "Review@Example.com");
    expect(reviewId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );

    const record = await getReview(kv, reviewId);
    expect(record).not.toBeNull();
    expect(record!.email).toBe("review@example.com");
    expect(record!.status).toBe("pending_review");
    expect(record!.reviewedAt).toBeNull();
    expect(record!.createdAt).toBeTypeOf("number");
  });

  it("returns null for nonexistent review", async () => {
    const record = await getReview(kv, "nope");
    expect(record).toBeNull();
  });

  it("lists reviews with metadata", async () => {
    const id = await createReview(kv, "listed@example.com");
    const reviews = await listReviews(kv);
    const found = reviews.find((r) => r.reviewId === id);
    expect(found).toBeDefined();
    expect(found!.metadata.email).toBe("listed@example.com");
    expect(found!.metadata.status).toBe("pending_review");
    expect(found!.metadata.createdAt).toBeTypeOf("number");
  });

  it("updates review status and reviewedAt", async () => {
    const id = await createReview(kv, "approve@example.com");
    await updateReviewStatus(kv, id, "approved");

    const record = await getReview(kv, id);
    expect(record!.status).toBe("approved");
    expect(record!.reviewedAt).toBeTypeOf("number");

    // metadata must also reflect new status (for list rendering)
    const reviews = await listReviews(kv);
    const found = reviews.find((r) => r.reviewId === id);
    expect(found!.metadata.status).toBe("approved");
  });

  it("update on missing review is a no-op", async () => {
    await updateReviewStatus(kv, "missing", "declined");
    const record = await getReview(kv, "missing");
    expect(record).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/services/kv-review.test.ts`
Expected: FAIL — `createReview`/`getReview`/`listReviews`/`updateReviewStatus` not exported.

- [ ] **Step 3: Implement review CRUD in `src/services/kv.ts`**

Add these to the top imports (replace line 1):

```typescript
import type {
  VerificationRecord,
  VerificationStatus,
  ReviewRecord,
  ReviewMetadata,
} from "../types";
```

Append to the end of `src/services/kv.ts`:

```typescript
export async function createReview(
  kv: KVNamespace,
  rawEmail: string
): Promise<string> {
  const email = normalizeEmail(rawEmail);
  const reviewId = crypto.randomUUID();
  const createdAt = Date.now();
  const record: ReviewRecord = {
    email,
    status: "pending_review",
    createdAt,
    reviewedAt: null,
  };
  const metadata: ReviewMetadata = {
    email,
    status: "pending_review",
    createdAt,
  };
  await kv.put(`review:${reviewId}`, JSON.stringify(record), { metadata });
  return reviewId;
}

export async function getReview(
  kv: KVNamespace,
  reviewId: string
): Promise<ReviewRecord | null> {
  const raw = await kv.get(`review:${reviewId}`);
  if (!raw) return null;
  return JSON.parse(raw);
}

export async function listReviews(
  kv: KVNamespace
): Promise<Array<{ reviewId: string; metadata: ReviewMetadata }>> {
  const result = await kv.list<ReviewMetadata>({ prefix: "review:" });
  return result.keys
    .filter((k) => k.metadata !== undefined)
    .map((k) => ({
      reviewId: k.name.slice("review:".length),
      metadata: k.metadata as ReviewMetadata,
    }));
}

export async function updateReviewStatus(
  kv: KVNamespace,
  reviewId: string,
  status: VerificationStatus
): Promise<void> {
  const record = await getReview(kv, reviewId);
  if (!record) return;
  record.status = status;
  record.reviewedAt = Date.now();
  const metadata: ReviewMetadata = {
    email: record.email,
    status,
    createdAt: record.createdAt,
  };
  await kv.put(`review:${reviewId}`, JSON.stringify(record), { metadata });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/services/kv-review.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/kv.ts test/services/kv-review.test.ts
git commit -m "feat: add KV review CRUD with metadata for admin listing"
```

---

### Task 3: Webhook Service

**Files:**
- Create: `src/services/webhook.ts`
- Create: `test/services/webhook.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/services/webhook.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { sendWebhook } from "../../src/services/webhook";

const originalFetch = globalThis.fetch;

describe("sendWebhook", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("substitutes placeholders and POSTs to the webhook URL", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response("ok", { status: 200 }))
    );
    globalThis.fetch = fetchMock;

    const testEnv = {
      ...env,
      WEBHOOK_URL: "https://hook.example.com/post",
      WEBHOOK_TEMPLATE: '{"text":"{{title}}: {{text_short}}\\n{{text_long}}"}',
    };

    await sendWebhook(testEnv, "New request", "a@b.com", "Email: a@b.com");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe("https://hook.example.com/post");
    expect(call[1].method).toBe("POST");
    const body = JSON.parse(call[1].body);
    expect(body.text).toBe("New request: a@b.com\nEmail: a@b.com");
  });

  it("JSON-escapes values containing quotes and newlines", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response("ok", { status: 200 }))
    );
    globalThis.fetch = fetchMock;

    const testEnv = {
      ...env,
      WEBHOOK_URL: "https://hook.example.com/post",
      WEBHOOK_TEMPLATE: '{"text":"{{text_short}}"}',
    };

    // Email with a quote would break JSON if not escaped
    await sendWebhook(testEnv, "t", 'evil"@x.com', "long");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toBe('evil"@x.com');
  });

  it("skips POST when WEBHOOK_URL is empty", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const testEnv = { ...env, WEBHOOK_URL: "", WEBHOOK_TEMPLATE: "{}" };
    await sendWebhook(testEnv, "t", "s", "l");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not throw when fetch rejects", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));

    const testEnv = {
      ...env,
      WEBHOOK_URL: "https://hook.example.com/post",
      WEBHOOK_TEMPLATE: '{"text":"{{title}}"}',
    };

    await expect(
      sendWebhook(testEnv, "t", "s", "l")
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/services/webhook.test.ts`
Expected: FAIL — module `../../src/services/webhook` not found.

- [ ] **Step 3: Implement `src/services/webhook.ts`**

```typescript
import { type Env, createLogger } from "../types";

// Escapes a string for safe embedding inside a JSON string literal.
// JSON.stringify wraps in quotes and escapes quotes/newlines/backslashes;
// slicing removes the surrounding quotes.
function jsonEscape(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

export async function sendWebhook(
  env: Env,
  title: string,
  textShort: string,
  textLong: string
): Promise<void> {
  const log = createLogger(env);
  if (!env.WEBHOOK_URL) return;

  const body = env.WEBHOOK_TEMPLATE
    .replaceAll("{{title}}", jsonEscape(title))
    .replaceAll("{{text_short}}", jsonEscape(textShort))
    .replaceAll("{{text_long}}", jsonEscape(textLong));

  try {
    const res = await fetch(env.WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) {
      log.error(`[webhook] POST failed: ${res.status}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[webhook] POST threw: ${msg}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/services/webhook.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/webhook.ts test/services/webhook.test.ts
git commit -m "feat: add configurable webhook notification service"
```

---

### Task 4: Invite Service

**Files:**
- Create: `src/services/invite.ts`
- Create: `test/services/invite.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/services/invite.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { performInvitation } from "../../src/services/invite";

const originalFetch = globalThis.fetch;
const kv = env.FAASGAUGE_REPO_PENDING_VERIFICATIONS;

function baseEnv() {
  return {
    ...env,
    GITHUB_ORG: "my-org",
    GITHUB_REPO: "my-repo",
    GITHUB_TEAM_SLUG: "my-team",
    GITHUB_ROLE: "direct_member",
    GITHUB_PERMISSION: "pull",
    GITHUB_PAT: "ghp_test",
  };
}

describe("performInvitation", () => {
  beforeEach(async () => {
    globalThis.fetch = originalFetch;
    await kv.delete("team_id:my-team");
  });

  it("resolves team, sets permission, and sends invitation in order", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/teams/my-team")) {
        return Promise.resolve(new Response(JSON.stringify({ id: 555 }), { status: 200 }));
      }
      if (url.endsWith("/repos/my-org/my-repo")) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.endsWith("/invitations")) {
        return Promise.resolve(new Response(JSON.stringify({ id: 1 }), { status: 201 }));
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    });

    await performInvitation(baseEnv(), "invitee@example.com");

    expect(calls[0]).toBe("GET https://api.github.com/orgs/my-org/teams/my-team");
    expect(calls[1]).toBe("PUT https://api.github.com/orgs/my-org/teams/my-team/repos/my-org/my-repo");
    expect(calls[2]).toBe("POST https://api.github.com/orgs/my-org/invitations");
  });

  it("uses cached team id on second call (no resolve fetch)", async () => {
    await kv.put("team_id:my-team", "999");

    const urls: string[] = [];
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      urls.push(url);
      if (url.endsWith("/repos/my-org/my-repo")) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.endsWith("/invitations")) {
        return Promise.resolve(new Response(JSON.stringify({ id: 1 }), { status: 201 }));
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    });

    await performInvitation(baseEnv(), "cached@example.com");

    expect(urls.some((u) => u.endsWith("/teams/my-team"))).toBe(false);
  });

  it("throws when a GitHub call fails", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/teams/my-team")) {
        return Promise.resolve(new Response(JSON.stringify({ id: 1 }), { status: 200 }));
      }
      if (url.endsWith("/repos/my-org/my-repo")) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(new Response("err", { status: 500 }));
    });

    await expect(
      performInvitation(baseEnv(), "fail@example.com")
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/services/invite.test.ts`
Expected: FAIL — module `../../src/services/invite` not found.

- [ ] **Step 3: Implement `src/services/invite.ts`**

```typescript
import { type Env, getKV, createLogger } from "../types";
import {
  resolveTeamId,
  ensureRepoPermission,
  sendOrgInvitation,
} from "./github";

export async function performInvitation(
  env: Env,
  email: string
): Promise<void> {
  const log = createLogger(env);
  const kv = getKV(env);

  const cacheKey = `team_id:${env.GITHUB_TEAM_SLUG}`;
  let teamId: number;
  const cached = await kv.get(cacheKey);
  if (cached) {
    teamId = Number(cached);
  } else {
    teamId = await resolveTeamId(
      env.GITHUB_ORG,
      env.GITHUB_TEAM_SLUG,
      env.GITHUB_PAT
    );
    await kv.put(cacheKey, String(teamId), { expirationTtl: 3600 });
    log.debug(`[invite] resolved team ${env.GITHUB_TEAM_SLUG} → id ${teamId}`);
  }

  await ensureRepoPermission(
    env.GITHUB_ORG,
    env.GITHUB_TEAM_SLUG,
    env.GITHUB_REPO,
    env.GITHUB_PERMISSION || "pull",
    env.GITHUB_PAT
  );

  await sendOrgInvitation(
    env.GITHUB_ORG,
    email,
    env.GITHUB_ROLE || "direct_member",
    [teamId],
    env.GITHUB_PAT
  );

  log.info(`[invite] invited ${email} to ${env.GITHUB_ORG}/${env.GITHUB_REPO} (team: ${env.GITHUB_TEAM_SLUG}, permission: ${env.GITHUB_PERMISSION || "pull"})`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/services/invite.test.ts`
Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/invite.ts test/services/invite.test.ts
git commit -m "feat: extract GitHub invitation orchestration into invite service"
```

---

### Task 5: Refactor Email Handler

**Files:**
- Modify: `src/handlers/email.ts`
- Modify: `test/handlers/email.test.ts`

- [ ] **Step 1: Replace the email handler test**

Replace the entire contents of `test/handlers/email.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { handleEmail } from "../../src/handlers/email";
import { createVerification, getVerification } from "../../src/services/kv";
import { listReviews } from "../../src/services/kv";

const originalFetch = globalThis.fetch;
const kv = env.FAASGAUGE_REPO_PENDING_VERIFICATIONS;

function makeEmailMessage(from: string): ForwardableEmailMessage {
  return {
    from,
    to: "verify@example.com",
    headers: new Headers({ From: from }),
    raw: new ReadableStream(),
    rawSize: 0,
    setReject: vi.fn(),
    forward: vi.fn(),
    reply: vi.fn(),
  } as unknown as ForwardableEmailMessage;
}

function testEnv() {
  return {
    ...env,
    WEBHOOK_URL: "https://hook.example.com/post",
    WEBHOOK_TEMPLATE: '{"text":"{{text_long}}"}',
    PUBLIC_URL: "https://worker.example.com",
    ADMIN_TOKEN: "secret-token",
  };
}

describe("handleEmail (review flow)", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("silently drops email with no matching record", async () => {
    globalThis.fetch = vi.fn();
    await handleEmail(makeEmailMessage("unknown@example.com"), testEnv());
    // No GitHub or webhook calls
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("creates a pending review and fires webhook, does NOT call GitHub", async () => {
    const token = await createVerification(kv, "reviewme@example.com");

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      // Only the webhook should be hit; fail loudly if GitHub is called
      if (url.includes("api.github.com")) {
        throw new Error("GitHub must not be called before approval");
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    });
    globalThis.fetch = fetchMock;

    await handleEmail(makeEmailMessage("reviewme@example.com"), testEnv());

    // verify record flipped to pending_review
    const record = await getVerification(kv, token);
    expect(record!.status).toBe("pending_review");

    // a review entry exists for this email
    const reviews = await listReviews(kv);
    expect(reviews.some((r) => r.metadata.email === "reviewme@example.com")).toBe(true);

    // webhook was POSTed
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hook.example.com/post",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("still creates review when webhook fails", async () => {
    const token = await createVerification(kv, "hookfail@example.com");
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("hook down"));

    await handleEmail(makeEmailMessage("hookfail@example.com"), testEnv());

    const record = await getVerification(kv, token);
    expect(record!.status).toBe("pending_review");
  });

  it("skips already-processed records", async () => {
    const token = await createVerification(kv, "done@example.com");
    const rec = await getVerification(kv, token);
    rec!.status = "pending_review";
    await kv.put(`verify:${token}`, JSON.stringify(rec));

    globalThis.fetch = vi.fn();
    await handleEmail(makeEmailMessage("done@example.com"), testEnv());
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/handlers/email.test.ts`
Expected: FAIL — the current handler still calls GitHub and sets `completed`.

- [ ] **Step 3: Rewrite `src/handlers/email.ts`**

```typescript
import { type Env, getKV, createLogger } from "../types";
import {
  getTokenByEmail,
  getVerification,
  updateVerificationStatus,
  deleteEmailIndex,
  createReview,
} from "../services/kv";
import { sendWebhook } from "../services/webhook";

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env
): Promise<void> {
  const log = createLogger(env);
  const senderEmail = message.from.toLowerCase().trim();
  log.debug(`[email] received from ${senderEmail}`);

  const token = await getTokenByEmail(getKV(env), senderEmail);
  if (!token) {
    log.debug(`[email] no pending verification for ${senderEmail} — dropping`);
    return;
  }

  const record = await getVerification(getKV(env), token);
  if (!record || record.status !== "pending_email") {
    log.debug(`[email] ${senderEmail} — record missing or already processed (${record?.status})`);
    return;
  }

  // Create a persistent review request instead of inviting directly.
  const reviewId = await createReview(getKV(env), record.email);
  await updateVerificationStatus(getKV(env), token, "pending_review");
  await deleteEmailIndex(getKV(env), senderEmail);
  log.info(`[email] pending review created for ${record.email} (review ${reviewId})`);

  // Notify the admin (failures are logged inside sendWebhook, never thrown).
  const adminUrl = `${env.PUBLIC_URL}/admin?token=${env.ADMIN_TOKEN}`;
  const requestedAt = new Date(record.createdAt).toISOString();
  const textLong = `Email: ${record.email}\nRequested: ${requestedAt}\nReview: ${adminUrl}`;
  await sendWebhook(env, "New repo access request", record.email, textLong);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/handlers/email.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/email.ts test/handlers/email.test.ts
git commit -m "feat: email handler creates pending review and webhook instead of inviting"
```

---

### Task 6: Update Status Handler

**Files:**
- Modify: `src/handlers/status.ts`
- Modify: `test/handlers/status.test.ts`

- [ ] **Step 1: Replace the status handler test**

Replace `test/handlers/status.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { handleStatus } from "../../src/handlers/status";
import { createVerification, updateVerificationStatus } from "../../src/services/kv";

const kv = env.FAASGAUGE_REPO_PENDING_VERIFICATIONS;

function makeRequest(token: string): Request {
  return new Request(`http://localhost/api/status/${token}`);
}

describe("handleStatus", () => {
  it("returns 404 for unknown token", async () => {
    const res = await handleStatus(makeRequest("nonexistent"), env);
    expect(res.status).toBe(404);
  });

  it("returns pending_email status", async () => {
    const token = await createVerification(kv, "s-pending@example.com");
    const res = await handleStatus(makeRequest(token), env);
    const data = (await res.json()) as { status: string; message: string };
    expect(data.status).toBe("pending_email");
    expect(data.message).toBeDefined();
  });

  it("returns pending_review status", async () => {
    const token = await createVerification(kv, "s-review@example.com");
    await updateVerificationStatus(kv, token, "pending_review");
    const res = await handleStatus(makeRequest(token), env);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe("pending_review");
  });

  it("returns approved status", async () => {
    const token = await createVerification(kv, "s-approved@example.com");
    await updateVerificationStatus(kv, token, "approved");
    const res = await handleStatus(makeRequest(token), env);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe("approved");
  });

  it("returns declined status", async () => {
    const token = await createVerification(kv, "s-declined@example.com");
    await updateVerificationStatus(kv, token, "declined");
    const res = await handleStatus(makeRequest(token), env);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe("declined");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/handlers/status.test.ts`
Expected: FAIL — `STATUS_MESSAGES` is missing the new keys / TS error.

- [ ] **Step 3: Update `STATUS_MESSAGES` in `src/handlers/status.ts`**

Replace the `STATUS_MESSAGES` map (lines 4-8):

```typescript
const STATUS_MESSAGES: Record<VerificationStatus, string> = {
  pending_email: "Waiting for your verification email...",
  pending_review: "Your request is pending admin review.",
  approved: "Approved! Check your email for the GitHub invitation.",
  declined: "Your request was declined.",
  failed_github_api: "Something went wrong with GitHub. Please try again later.",
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/handlers/status.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/status.ts test/handlers/status.test.ts
git commit -m "feat: add status messages for review lifecycle"
```

---

### Task 7: Admin Handlers

> **DEPENDENCY:** This task imports `renderAdminPage` from `src/html/admin.ts`, which is created in **Task 8**. Implement Task 8 BEFORE this task (create the template file first), then return here. The tests below will not pass until `src/html/admin.ts` exists.

**Files:**
- Create: `src/handlers/admin.ts`
- Create: `test/handlers/admin.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/handlers/admin.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { handleAdminPage, handleApprove, handleDecline } from "../../src/handlers/admin";
import { createReview, getReview } from "../../src/services/kv";

const originalFetch = globalThis.fetch;
const kv = env.FAASGAUGE_REPO_PENDING_VERIFICATIONS;

function testEnv() {
  return {
    ...env,
    ADMIN_TOKEN: "secret-token",
    GITHUB_ORG: "my-org",
    GITHUB_REPO: "my-repo",
    GITHUB_TEAM_SLUG: "my-team",
    GITHUB_ROLE: "direct_member",
    GITHUB_PERMISSION: "pull",
    GITHUB_PAT: "ghp_test",
  };
}

function postReq(body: unknown): Request {
  return new Request("http://localhost/api/admin/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("admin handlers", () => {
  beforeEach(async () => {
    globalThis.fetch = originalFetch;
    await kv.delete("team_id:my-team");
  });

  describe("handleAdminPage", () => {
    it("returns 401 for wrong token", async () => {
      const req = new Request("http://localhost/admin?token=wrong");
      const res = await handleAdminPage(req, testEnv());
      expect(res.status).toBe(401);
    });

    it("returns 200 HTML listing reviews for valid token", async () => {
      await createReview(kv, "listed-admin@example.com");
      const req = new Request("http://localhost/admin?token=secret-token");
      const res = await handleAdminPage(req, testEnv());
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain("listed-admin@example.com");
    });
  });

  describe("handleApprove", () => {
    it("returns 401 for wrong token", async () => {
      const id = await createReview(kv, "a-unauth@example.com");
      const res = await handleApprove(postReq({ reviewId: id, token: "wrong" }), testEnv());
      expect(res.status).toBe(401);
    });

    it("returns 404 for missing review", async () => {
      const res = await handleApprove(postReq({ reviewId: "nope", token: "secret-token" }), testEnv());
      expect(res.status).toBe(404);
    });

    it("invites and marks approved on success", async () => {
      const id = await createReview(kv, "a-ok@example.com");
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("/teams/my-team")) {
          return Promise.resolve(new Response(JSON.stringify({ id: 7 }), { status: 200 }));
        }
        if (url.endsWith("/repos/my-org/my-repo")) {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (url.endsWith("/invitations")) {
          return Promise.resolve(new Response(JSON.stringify({ id: 1 }), { status: 201 }));
        }
        return Promise.resolve(new Response("x", { status: 500 }));
      });

      const res = await handleApprove(postReq({ reviewId: id, token: "secret-token" }), testEnv());
      expect(res.status).toBe(200);
      const record = await getReview(kv, id);
      expect(record!.status).toBe("approved");
    });

    it("returns 409 for already-processed review", async () => {
      const id = await createReview(kv, "a-twice@example.com");
      // mark approved first
      const rec = await getReview(kv, id);
      rec!.status = "approved";
      await kv.put(`review:${id}`, JSON.stringify(rec));

      globalThis.fetch = vi.fn();
      const res = await handleApprove(postReq({ reviewId: id, token: "secret-token" }), testEnv());
      expect(res.status).toBe(409);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("marks failed_github_api and returns 502 when invite fails", async () => {
      const id = await createReview(kv, "a-fail@example.com");
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("/teams/my-team")) {
          return Promise.resolve(new Response("nope", { status: 500 }));
        }
        return Promise.resolve(new Response("x", { status: 500 }));
      });

      const res = await handleApprove(postReq({ reviewId: id, token: "secret-token" }), testEnv());
      expect(res.status).toBe(502);
      const record = await getReview(kv, id);
      expect(record!.status).toBe("failed_github_api");
    });
  });

  describe("handleDecline", () => {
    it("marks declined", async () => {
      const id = await createReview(kv, "d-ok@example.com");
      const req = new Request("http://localhost/api/admin/decline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewId: id, token: "secret-token" }),
      });
      const res = await handleDecline(req, testEnv());
      expect(res.status).toBe(200);
      const record = await getReview(kv, id);
      expect(record!.status).toBe("declined");
    });

    it("returns 401 for wrong token", async () => {
      const id = await createReview(kv, "d-unauth@example.com");
      const req = new Request("http://localhost/api/admin/decline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewId: id, token: "wrong" }),
      });
      const res = await handleDecline(req, testEnv());
      expect(res.status).toBe(401);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/handlers/admin.test.ts`
Expected: FAIL — module `../../src/handlers/admin` not found.

- [ ] **Step 3: Implement `src/handlers/admin.ts`**

```typescript
import { type Env, createLogger, getKV } from "../types";
import { listReviews, getReview, updateReviewStatus } from "../services/kv";
import { performInvitation } from "../services/invite";
import { renderAdminPage } from "../html/admin";

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function authorized(env: Env, token: string | null): boolean {
  if (!env.ADMIN_TOKEN || !token) return false;
  return constantTimeEqual(token, env.ADMIN_TOKEN);
}

export async function handleAdminPage(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!authorized(env, token)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "Content-Type": "text/html;charset=UTF-8" },
    });
  }

  const reviews = await listReviews(getKV(env));
  reviews.sort((a, b) => b.metadata.createdAt - a.metadata.createdAt);
  const html = renderAdminPage(reviews, token!);
  return new Response(html, {
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  });
}

async function readBody(
  request: Request
): Promise<{ reviewId?: string; token?: string } | null> {
  return (await request.json().catch(() => null)) as {
    reviewId?: string;
    token?: string;
  } | null;
}

export async function handleApprove(
  request: Request,
  env: Env
): Promise<Response> {
  const log = createLogger(env);
  const body = await readBody(request);
  if (!authorized(env, body?.token ?? null)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!body?.reviewId) {
    return Response.json({ error: "Missing reviewId" }, { status: 400 });
  }

  const review = await getReview(getKV(env), body.reviewId);
  if (!review) {
    return Response.json({ error: "Review not found" }, { status: 404 });
  }
  if (review.status !== "pending_review") {
    return Response.json(
      { error: `Already ${review.status}` },
      { status: 409 }
    );
  }

  try {
    await performInvitation(env, review.email);
    await updateReviewStatus(getKV(env), body.reviewId, "approved");
    log.info(`[admin] approved ${review.email} (review ${body.reviewId})`);
    return Response.json({ status: "approved" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[admin] approve failed for ${review.email}: ${msg}`);
    await updateReviewStatus(getKV(env), body.reviewId, "failed_github_api");
    return Response.json({ error: "GitHub invitation failed" }, { status: 502 });
  }
}

export async function handleDecline(
  request: Request,
  env: Env
): Promise<Response> {
  const log = createLogger(env);
  const body = await readBody(request);
  if (!authorized(env, body?.token ?? null)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!body?.reviewId) {
    return Response.json({ error: "Missing reviewId" }, { status: 400 });
  }

  const review = await getReview(getKV(env), body.reviewId);
  if (!review) {
    return Response.json({ error: "Review not found" }, { status: 404 });
  }

  await updateReviewStatus(getKV(env), body.reviewId, "declined");
  log.info(`[admin] declined ${review.email} (review ${body.reviewId})`);
  return Response.json({ status: "declined" });
}
```

- [ ] **Step 4: Run tests (Task 8's `src/html/admin.ts` must already exist)**

Run: `npx vitest run test/handlers/admin.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/admin.ts test/handlers/admin.test.ts
git commit -m "feat: add admin approve/decline/list handlers with token auth"
```

---

### Task 8: Admin HTML Template

**Files:**
- Create: `src/html/admin.ts`

> **Order note:** Task 7's handler imports `renderAdminPage` from this file. If executing in order, create this file before running Task 7's tests. It has no separate test (covered by `handleAdminPage` tests in Task 7).

- [ ] **Step 1: Create `src/html/admin.ts`**

```typescript
import type { ReviewMetadata } from "../types";

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderAdminPage(
  reviews: Array<{ reviewId: string; metadata: ReviewMetadata }>,
  token: string
): string {
  const rows = reviews
    .map((r) => {
      const email = escapeHtml(r.metadata.email);
      const when = new Date(r.metadata.createdAt).toISOString().replace("T", " ").slice(0, 19);
      const status = escapeHtml(r.metadata.status);
      const id = escapeHtml(r.reviewId);
      const actions =
        r.metadata.status === "pending_review"
          ? `<button class="approve" data-id="${id}">Approve</button> <button class="decline" data-id="${id}">Decline</button>`
          : "—";
      return `<tr data-row="${id}"><td>${email}</td><td>${when} UTC</td><td class="status">${status}</td><td>${actions}</td></tr>`;
    })
    .join("");

  const emptyRow = `<tr><td colspan="4" style="text-align:center;color:#888;">No requests yet.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Access Request Review</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #111; color: #e5e5e5; padding: 2rem 1rem; line-height: 1.5; }
    .wrap { max-width: 900px; margin: 0 auto; }
    h1 { font-size: 1.25rem; margin-bottom: 1rem; }
    table { width: 100%; border-collapse: collapse; background: #1a1a1a; border: 1px solid #333; border-radius: 8px; overflow: hidden; }
    th, td { text-align: left; padding: 0.625rem 0.875rem; border-bottom: 1px solid #2a2a2a; font-size: 0.9rem; }
    th { background: #222; font-weight: 600; }
    tr:last-child td { border-bottom: none; }
    button { padding: 0.35rem 0.7rem; border: none; border-radius: 5px; font-size: 0.85rem; cursor: pointer; color: #fff; }
    .approve { background: #16a34a; }
    .approve:hover { background: #15803d; }
    .decline { background: #dc2626; }
    .decline:hover { background: #b91c1c; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .status { text-transform: capitalize; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Access Request Review</h1>
    <table>
      <thead><tr><th>Email</th><th>Requested</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${rows || emptyRow}</tbody>
    </table>
  </div>
  <script>
    const TOKEN = ${JSON.stringify(token)};
    async function act(endpoint, reviewId, btn) {
      const row = document.querySelector('[data-row="' + reviewId + '"]');
      row.querySelectorAll("button").forEach((b) => (b.disabled = true));
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reviewId, token: TOKEN }),
        });
        const data = await res.json();
        if (!res.ok) {
          alert(data.error || "Action failed");
          row.querySelectorAll("button").forEach((b) => (b.disabled = false));
          return;
        }
        row.querySelector(".status").textContent = data.status;
        row.querySelector("td:last-child").textContent = "—";
      } catch {
        alert("Network error");
        row.querySelectorAll("button").forEach((b) => (b.disabled = false));
      }
    }
    document.querySelectorAll(".approve").forEach((b) =>
      b.addEventListener("click", () => act("/api/admin/approve", b.dataset.id, b))
    );
    document.querySelectorAll(".decline").forEach((b) =>
      b.addEventListener("click", () => act("/api/admin/decline", b.dataset.id, b))
    );
  </script>
</body>
</html>`;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors (assuming Tasks 1-7 are in place).

- [ ] **Step 3: Commit**

```bash
git add src/html/admin.ts
git commit -m "feat: add dark-themed admin review page template"
```

---

### Task 9: Frontend Pending-Review State

**Files:**
- Modify: `src/html/page.ts`

- [ ] **Step 1: Update the poll loop in `src/html/page.ts`**

Find the `pollStatus` function's status checks (the block handling `data.status === "completed"` and `data.status.startsWith("failed")`). Replace that inner result-handling block with:

```javascript
          const data = await res.json();
          if (data.status === "approved") {
            clearInterval(interval);
            showStep(3);
            document.getElementById("resultSuccess").style.display = "block";
          } else if (data.status === "pending_review") {
            clearInterval(interval);
            showStep(3);
            document.getElementById("resultPending").style.display = "block";
          } else if (data.status === "declined") {
            clearInterval(interval);
            showStep(3);
            document.getElementById("resultDeclined").style.display = "block";
          } else if (data.status.startsWith("failed")) {
            clearInterval(interval);
            showStep(3);
            document.getElementById("resultFail").style.display = "block";
          }
```

- [ ] **Step 2: Add the new result blocks to step 3**

In the `<div id="step3" class="step">` section, add these two blocks alongside the existing `resultSuccess` / `resultFail` / `resultExpired` divs:

```html
      <div id="resultPending" style="display:none;">
        <h1 class="success">Request Submitted!</h1>
        <p style="margin-top:0.5rem;">Your access request is pending admin review. You'll receive a GitHub invitation by email once approved.</p>
      </div>
      <div id="resultDeclined" style="display:none;">
        <h1 class="fail">Request Declined</h1>
        <p style="margin-top:0.5rem;">Your access request was not approved.</p>
      </div>
```

- [ ] **Step 3: Verify TypeScript compiles and the template still builds**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/html/page.ts
git commit -m "feat: show pending-review and declined states in frontend"
```

---

### Task 10: Wire Up Routes

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add admin routes to `src/index.ts`**

Replace the full file:

```typescript
// src/index.ts
import type { Env } from "./types";
import { handlePage } from "./handlers/page";
import { handleVerifyTurnstile } from "./handlers/turnstile";
import { handleStatus } from "./handlers/status";
import { handleEmail } from "./handlers/email";
import { handleAdminPage, handleApprove, handleDecline } from "./handlers/admin";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return handlePage(env);
    }

    if (request.method === "POST" && url.pathname === "/api/verify-turnstile") {
      return handleVerifyTurnstile(request, env);
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/status/")) {
      return handleStatus(request, env);
    }

    if (request.method === "GET" && url.pathname === "/admin") {
      return handleAdminPage(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/admin/approve") {
      return handleApprove(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/admin/decline") {
      return handleDecline(request, env);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleEmail(message, env);
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests across all files PASS.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: route admin page and approve/decline endpoints"
```

---

### Task 11: Config Template + Final Verification

**Files:**
- Modify: `wrangler.toml.example`
- Modify: `README.md`

- [ ] **Step 1: Add new env vars to `wrangler.toml.example`**

In the `[vars]` block, add (after `VERIFICATION_EMAIL`):

```toml
PUBLIC_URL = ""
WEBHOOK_URL = ""
WEBHOOK_TEMPLATE = '{"text":"{{title}}\n{{text_long}}"}'
```

And in the secrets comment block at the bottom, add `ADMIN_TOKEN`:

```toml
# Secrets (set via `wrangler secret put`):
# TURNSTILE_SECRET_KEY
# GITHUB_PAT
# ADMIN_TOKEN
```

- [ ] **Step 2: Document the admin flow in `README.md`**

Add a section after the deployment steps:

```markdown
## Admin Review

After a user verifies their email, the request enters a pending review list instead of being invited automatically. You approve or decline from the admin page.

### Configuration

- `PUBLIC_URL` — your Worker's base URL (e.g. `https://worker-access-interface.<sub>.workers.dev`), used to build the admin link in notifications
- `WEBHOOK_URL` — endpoint to POST notifications to (leave empty to disable)
- `WEBHOOK_TEMPLATE` — JSON body template with `{{title}}`, `{{text_short}}`, `{{text_long}}` placeholders
- `ADMIN_TOKEN` — secret protecting the admin page; set via `npx wrangler secret put ADMIN_TOKEN`

### Webhook template examples

Telegram:
\`\`\`json
{"chat_id":"123456789","text":"*{{title}}*\n\n{{text_long}}","parse_mode":"Markdown"}
\`\`\`

Discord:
\`\`\`json
{"content":"**{{title}}**\n{{text_long}}"}
\`\`\`

### Reviewing requests

The notification contains a link to `/admin?token=ADMIN_TOKEN`. Open it to see all pending requests and click Approve (sends the GitHub invitation) or Decline.
```

- [ ] **Step 3: Run the full suite one more time**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 4: Verify TypeScript and a dry-run build**

Run: `npx tsc --noEmit && npx wrangler deploy --dry-run`
Expected: No type errors; dry-run reports the bundled Worker without uploading.

- [ ] **Step 5: Commit**

```bash
git add wrangler.toml.example README.md
git commit -m "docs: document admin review config and webhook templates"
```

---

## Deployment Notes (manual, post-implementation)

1. Set the new vars in your local `wrangler.toml` `[vars]`: `PUBLIC_URL`, `WEBHOOK_URL`, `WEBHOOK_TEMPLATE`
2. Set the admin secret: `npx wrangler secret put ADMIN_TOKEN`
3. Deploy: `npx wrangler deploy`
4. Trigger a test request; confirm the webhook fires and the admin page lists it
5. Approve from the admin page; confirm the GitHub invitation is sent
