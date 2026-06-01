# Worker Access Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Cloudflare Worker that gates GitHub org repo access behind Turnstile captcha + email ownership verification.

**Architecture:** Single Worker with dual handlers (`fetch` for web UI/API, `email` for inbound verification emails). KV stores short-lived verification state. GitHub org invitations are sent via team-based flow using PAT from a bot account.

**Tech Stack:** Cloudflare Workers (TypeScript, ES modules), Workers KV, Cloudflare Email Routing, Cloudflare Turnstile, GitHub REST API, Vitest + Miniflare for testing.

**Spec:** `docs/superpowers/specs/2026-06-01-worker-access-interface-design.md`

---

## File Structure

```
/
├── src/
│   ├── index.ts          # Worker entry — exports fetch and email handlers, routes requests
│   ├── types.ts          # Env interface, KV record types, status enum
│   ├── handlers/
│   │   ├── page.ts       # GET / — returns HTML response
│   │   ├── turnstile.ts  # POST /api/verify-turnstile — validates captcha, creates KV record
│   │   ├── status.ts     # GET /api/status/:token — returns verification status
│   │   └── email.ts      # Email handler — matches sender, invites via GitHub
│   ├── services/
│   │   ├── kv.ts         # KV read/write/delete helpers
│   │   ├── turnstile.ts  # Turnstile siteverify API call
│   │   └── github.ts     # GitHub API: resolve team, set repo permission, send invitation
│   └── html/
│       └── page.ts       # HTML template function (returns string)
├── test/
│   ├── services/
│   │   ├── kv.test.ts
│   │   ├── turnstile.test.ts
│   │   └── github.test.ts
│   ├── handlers/
│   │   ├── turnstile.test.ts
│   │   ├── status.test.ts
│   │   └── email.test.ts
│   └── integration.test.ts
├── wrangler.toml
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `wrangler.toml`
- Create: `vitest.config.ts`
- Create: `src/types.ts`

- [ ] **Step 1: Initialize package.json**

```json
{
  "name": "worker-access-interface",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.8.0",
    "@cloudflare/workers-types": "^4.20250525.0",
    "typescript": "^5.8.0",
    "vitest": "^3.2.0",
    "wrangler": "^4.14.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ESNext"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src/**/*", "test/**/*"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create wrangler.toml**

```toml
name = "worker-access-interface"
main = "src/index.ts"
compatibility_date = "2026-05-29"
compatibility_flags = ["nodejs_compat"]

[vars]
TURNSTILE_SITE_KEY = ""
GITHUB_ORG = ""
GITHUB_REPO = ""
GITHUB_ROLE = "direct_member"
GITHUB_TEAM_SLUG = ""
GITHUB_PERMISSION = "pull"
VERIFICATION_EMAIL = ""

[[kv_namespaces]]
binding = "PENDING_VERIFICATIONS"
id = ""
preview_id = ""

# Secrets (set via `wrangler secret put`):
# TURNSTILE_SECRET_KEY
# GITHUB_PAT
```

- [ ] **Step 4: Create vitest.config.ts**

```typescript
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
  },
});
```

- [ ] **Step 5: Create src/types.ts**

```typescript
export interface Env {
  PENDING_VERIFICATIONS: KVNamespace;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  GITHUB_PAT: string;
  GITHUB_ORG: string;
  GITHUB_REPO: string;
  GITHUB_ROLE: string;
  GITHUB_TEAM_SLUG: string;
  GITHUB_PERMISSION: string;
  VERIFICATION_EMAIL: string;
}

export type VerificationStatus =
  | "pending_email"
  | "completed"
  | "failed_github_api";

export interface VerificationRecord {
  email: string;
  status: VerificationStatus;
  createdAt: number;
}
```

- [ ] **Step 6: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, lock file generated.

- [ ] **Step 7: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors (only `types.ts` exists so far, should compile clean).

- [ ] **Step 8: Commit**

```bash
git init
git add package.json package-lock.json tsconfig.json wrangler.toml vitest.config.ts src/types.ts
git commit -m "chore: scaffold project with wrangler, vitest, and types"
```

---

### Task 2: KV Service

**Files:**
- Create: `src/services/kv.ts`
- Create: `test/services/kv.test.ts`

- [ ] **Step 1: Write failing tests for KV service**

```typescript
// test/services/kv.test.ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  createVerification,
  getVerification,
  getTokenByEmail,
  updateVerificationStatus,
  deleteEmailIndex,
} from "../../src/services/kv";

describe("KV service", () => {
  it("creates a verification record and email index", async () => {
    const token = await createVerification(
      env.PENDING_VERIFICATIONS,
      "User@Example.com"
    );

    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );

    const record = await getVerification(env.PENDING_VERIFICATIONS, token);
    expect(record).not.toBeNull();
    expect(record!.email).toBe("user@example.com");
    expect(record!.status).toBe("pending_email");
    expect(record!.createdAt).toBeTypeOf("number");

    const lookedUpToken = await getTokenByEmail(
      env.PENDING_VERIFICATIONS,
      "User@Example.com"
    );
    expect(lookedUpToken).toBe(token);
  });

  it("returns null for nonexistent token", async () => {
    const record = await getVerification(
      env.PENDING_VERIFICATIONS,
      "nonexistent"
    );
    expect(record).toBeNull();
  });

  it("returns null for nonexistent email", async () => {
    const token = await getTokenByEmail(
      env.PENDING_VERIFICATIONS,
      "nobody@example.com"
    );
    expect(token).toBeNull();
  });

  it("returns existing token for duplicate email", async () => {
    const token1 = await createVerification(
      env.PENDING_VERIFICATIONS,
      "dupe@example.com"
    );
    const token2 = await createVerification(
      env.PENDING_VERIFICATIONS,
      "dupe@example.com"
    );
    expect(token2).toBe(token1);
  });

  it("updates verification status", async () => {
    const token = await createVerification(
      env.PENDING_VERIFICATIONS,
      "update@example.com"
    );
    await updateVerificationStatus(
      env.PENDING_VERIFICATIONS,
      token,
      "completed"
    );
    const record = await getVerification(env.PENDING_VERIFICATIONS, token);
    expect(record!.status).toBe("completed");
  });

  it("deletes email index", async () => {
    const token = await createVerification(
      env.PENDING_VERIFICATIONS,
      "delete@example.com"
    );
    await deleteEmailIndex(env.PENDING_VERIFICATIONS, "delete@example.com");
    const result = await getTokenByEmail(
      env.PENDING_VERIFICATIONS,
      "delete@example.com"
    );
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/services/kv.test.ts`
Expected: FAIL — module `../../src/services/kv` not found.

- [ ] **Step 3: Implement KV service**

```typescript
// src/services/kv.ts
import type { VerificationRecord, VerificationStatus } from "../types";

const TTL = 1800; // 30 minutes

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

export async function createVerification(
  kv: KVNamespace,
  rawEmail: string
): Promise<string> {
  const email = normalizeEmail(rawEmail);

  const existing = await kv.get(`email:${email}`);
  if (existing) return existing;

  const token = crypto.randomUUID();
  const record: VerificationRecord = {
    email,
    status: "pending_email",
    createdAt: Date.now(),
  };

  await kv.put(`verify:${token}`, JSON.stringify(record), {
    expirationTtl: TTL,
  });
  await kv.put(`email:${email}`, token, { expirationTtl: TTL });

  return token;
}

export async function getVerification(
  kv: KVNamespace,
  token: string
): Promise<VerificationRecord | null> {
  const raw = await kv.get(`verify:${token}`);
  if (!raw) return null;
  return JSON.parse(raw);
}

export async function getTokenByEmail(
  kv: KVNamespace,
  rawEmail: string
): Promise<string | null> {
  return kv.get(`email:${normalizeEmail(rawEmail)}`);
}

export async function updateVerificationStatus(
  kv: KVNamespace,
  token: string,
  status: VerificationStatus
): Promise<void> {
  const record = await getVerification(kv, token);
  if (!record) return;
  record.status = status;
  await kv.put(`verify:${token}`, JSON.stringify(record), {
    expirationTtl: TTL,
  });
}

export async function deleteEmailIndex(
  kv: KVNamespace,
  rawEmail: string
): Promise<void> {
  await kv.delete(`email:${normalizeEmail(rawEmail)}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/services/kv.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/kv.ts test/services/kv.test.ts
git commit -m "feat: add KV service for verification record storage"
```

---

### Task 3: Turnstile Service

**Files:**
- Create: `src/services/turnstile.ts`
- Create: `test/services/turnstile.test.ts`

- [ ] **Step 1: Write failing tests for Turnstile verification**

```typescript
// test/services/turnstile.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { verifyTurnstile } from "../../src/services/turnstile";

const originalFetch = globalThis.fetch;

describe("Turnstile service", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns true when Turnstile verification succeeds", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );

    const result = await verifyTurnstile("valid-token", "test-secret");
    expect(result).toBe(true);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("returns false when Turnstile verification fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false }), { status: 200 })
    );

    const result = await verifyTurnstile("bad-token", "test-secret");
    expect(result).toBe(false);
  });

  it("returns false when fetch throws", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    const result = await verifyTurnstile("any-token", "test-secret");
    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/services/turnstile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement Turnstile service**

```typescript
// src/services/turnstile.ts
const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(
  token: string,
  secretKey: string
): Promise<boolean> {
  try {
    const body = new URLSearchParams({ secret: secretKey, response: token });
    const res = await fetch(SITEVERIFY_URL, { method: "POST", body });
    const data = (await res.json()) as { success: boolean };
    return data.success;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/services/turnstile.test.ts`
Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/turnstile.ts test/services/turnstile.test.ts
git commit -m "feat: add Turnstile verification service"
```

---

### Task 4: GitHub Service

**Files:**
- Create: `src/services/github.ts`
- Create: `test/services/github.test.ts`

- [ ] **Step 1: Write failing tests for GitHub service**

```typescript
// test/services/github.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolveTeamId,
  ensureRepoPermission,
  sendOrgInvitation,
} from "../../src/services/github";

const originalFetch = globalThis.fetch;

describe("GitHub service", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("resolveTeamId", () => {
    it("returns team id from API", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: 12345 }), { status: 200 })
      );

      const id = await resolveTeamId("my-org", "my-team", "ghp_token");
      expect(id).toBe(12345);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.github.com/orgs/my-org/teams/my-team",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer ghp_token",
          }),
        })
      );
    });

    it("throws on non-200 response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response("Not Found", { status: 404 })
      );

      await expect(
        resolveTeamId("my-org", "bad-team", "ghp_token")
      ).rejects.toThrow("Failed to resolve team");
    });
  });

  describe("ensureRepoPermission", () => {
    it("calls PUT with correct permission", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(null, { status: 204 })
      );

      await ensureRepoPermission(
        "my-org", "my-team", "my-repo", "pull", "ghp_token"
      );

      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(
        "https://api.github.com/orgs/my-org/teams/my-team/repos/my-org/my-repo"
      );
      expect(call[1].method).toBe("PUT");
      expect(JSON.parse(call[1].body)).toEqual({ permission: "pull" });
    });
  });

  describe("sendOrgInvitation", () => {
    it("sends invitation with email and team_ids", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: 1 }), { status: 201 })
      );

      await sendOrgInvitation(
        "my-org", "user@example.com", "direct_member", [12345], "ghp_token"
      );

      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(
        "https://api.github.com/orgs/my-org/invitations"
      );
      expect(JSON.parse(call[1].body)).toEqual({
        email: "user@example.com",
        role: "direct_member",
        team_ids: [12345],
      });
    });

    it("does not throw on 422 (already a member)", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ message: "Validation Failed" }),
          { status: 422 }
        )
      );

      await expect(
        sendOrgInvitation(
          "my-org", "member@example.com", "direct_member", [12345], "ghp_token"
        )
      ).resolves.not.toThrow();
    });

    it("throws on other error status codes", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response("Server Error", { status: 500 })
      );

      await expect(
        sendOrgInvitation(
          "my-org", "user@example.com", "direct_member", [12345], "ghp_token"
        )
      ).rejects.toThrow("Failed to send org invitation");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/services/github.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement GitHub service**

```typescript
// src/services/github.ts
const GITHUB_API = "https://api.github.com";

function headers(pat: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function resolveTeamId(
  org: string,
  teamSlug: string,
  pat: string
): Promise<number> {
  const res = await fetch(`${GITHUB_API}/orgs/${org}/teams/${teamSlug}`, {
    headers: headers(pat),
  });
  if (!res.ok) {
    throw new Error(`Failed to resolve team '${teamSlug}': ${res.status}`);
  }
  const data = (await res.json()) as { id: number };
  return data.id;
}

export async function ensureRepoPermission(
  org: string,
  teamSlug: string,
  repo: string,
  permission: string,
  pat: string
): Promise<void> {
  const res = await fetch(
    `${GITHUB_API}/orgs/${org}/teams/${teamSlug}/repos/${org}/${repo}`,
    {
      method: "PUT",
      headers: headers(pat),
      body: JSON.stringify({ permission }),
    }
  );
  if (!res.ok) {
    throw new Error(`Failed to set repo permission: ${res.status}`);
  }
}

export async function sendOrgInvitation(
  org: string,
  email: string,
  role: string,
  teamIds: number[],
  pat: string
): Promise<void> {
  const res = await fetch(`${GITHUB_API}/orgs/${org}/invitations`, {
    method: "POST",
    headers: headers(pat),
    body: JSON.stringify({ email, role, team_ids: teamIds }),
  });
  if (res.status === 422) return;
  if (!res.ok) {
    throw new Error(`Failed to send org invitation: ${res.status}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/services/github.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/github.ts test/services/github.test.ts
git commit -m "feat: add GitHub service for org invitations"
```

---

### Task 5: Turnstile Handler

**Files:**
- Create: `src/handlers/turnstile.ts`
- Create: `test/handlers/turnstile.test.ts`

- [ ] **Step 1: Write failing tests for Turnstile handler**

```typescript
// test/handlers/turnstile.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { handleVerifyTurnstile } from "../../src/handlers/turnstile";

const originalFetch = globalThis.fetch;

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/verify-turnstile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleVerifyTurnstile", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns 400 for missing email", async () => {
    const res = await handleVerifyTurnstile(
      makeRequest({ turnstileToken: "tok" }),
      env
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid email format", async () => {
    const res = await handleVerifyTurnstile(
      makeRequest({ email: "not-an-email", turnstileToken: "tok" }),
      env
    );
    expect(res.status).toBe(400);
  });

  it("returns 403 when Turnstile verification fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false }), { status: 200 })
    );

    const res = await handleVerifyTurnstile(
      makeRequest({ email: "user@example.com", turnstileToken: "bad" }),
      env
    );
    expect(res.status).toBe(403);
  });

  it("returns 200 with token on success", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );

    const res = await handleVerifyTurnstile(
      makeRequest({ email: "new@example.com", turnstileToken: "good" }),
      env
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { token: string };
    expect(data.token).toBeDefined();
    expect(data.token).toMatch(/^[0-9a-f-]+$/);
  });

  it("returns same token for duplicate email", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );

    const res1 = await handleVerifyTurnstile(
      makeRequest({ email: "dupe@example.com", turnstileToken: "good" }),
      env
    );
    const res2 = await handleVerifyTurnstile(
      makeRequest({ email: "dupe@example.com", turnstileToken: "good" }),
      env
    );
    const data1 = (await res1.json()) as { token: string };
    const data2 = (await res2.json()) as { token: string };
    expect(data1.token).toBe(data2.token);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/handlers/turnstile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement Turnstile handler**

```typescript
// src/handlers/turnstile.ts
import type { Env } from "../types";
import { verifyTurnstile } from "../services/turnstile";
import { createVerification } from "../services/kv";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function handleVerifyTurnstile(
  request: Request,
  env: Env
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    email?: string;
    turnstileToken?: string;
  } | null;

  if (!body?.email || !body?.turnstileToken) {
    return Response.json({ error: "Missing email or turnstileToken" }, { status: 400 });
  }

  if (!EMAIL_RE.test(body.email)) {
    return Response.json({ error: "Invalid email format" }, { status: 400 });
  }

  const valid = await verifyTurnstile(body.turnstileToken, env.TURNSTILE_SECRET_KEY);
  if (!valid) {
    return Response.json({ error: "Turnstile verification failed" }, { status: 403 });
  }

  const token = await createVerification(env.PENDING_VERIFICATIONS, body.email);
  return Response.json({ token });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/handlers/turnstile.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/turnstile.ts test/handlers/turnstile.test.ts
git commit -m "feat: add Turnstile verification handler"
```

---

### Task 6: Status Handler

**Files:**
- Create: `src/handlers/status.ts`
- Create: `test/handlers/status.test.ts`

- [ ] **Step 1: Write failing tests for status handler**

```typescript
// test/handlers/status.test.ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { handleStatus } from "../../src/handlers/status";
import { createVerification, updateVerificationStatus } from "../../src/services/kv";

function makeRequest(token: string): Request {
  return new Request(`http://localhost/api/status/${token}`);
}

describe("handleStatus", () => {
  it("returns 404 for unknown token", async () => {
    const res = await handleStatus(makeRequest("nonexistent"), env);
    expect(res.status).toBe(404);
  });

  it("returns pending_email status", async () => {
    const token = await createVerification(
      env.PENDING_VERIFICATIONS,
      "status1@example.com"
    );
    const res = await handleStatus(makeRequest(token), env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string; message: string };
    expect(data.status).toBe("pending_email");
    expect(data.message).toBeDefined();
  });

  it("returns completed status", async () => {
    const token = await createVerification(
      env.PENDING_VERIFICATIONS,
      "status2@example.com"
    );
    await updateVerificationStatus(
      env.PENDING_VERIFICATIONS,
      token,
      "completed"
    );
    const res = await handleStatus(makeRequest(token), env);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe("completed");
  });

  it("returns failed_github_api status", async () => {
    const token = await createVerification(
      env.PENDING_VERIFICATIONS,
      "status3@example.com"
    );
    await updateVerificationStatus(
      env.PENDING_VERIFICATIONS,
      token,
      "failed_github_api"
    );
    const res = await handleStatus(makeRequest(token), env);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe("failed_github_api");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/handlers/status.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement status handler**

```typescript
// src/handlers/status.ts
import type { Env, VerificationStatus } from "../types";
import { getVerification } from "../services/kv";

const STATUS_MESSAGES: Record<VerificationStatus, string> = {
  pending_email: "Waiting for your verification email...",
  completed: "Invitation sent! Check your email for the GitHub invite.",
  failed_github_api: "Something went wrong with GitHub. Please try again later.",
};

export async function handleStatus(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.pathname.split("/").pop() || "";

  const record = await getVerification(env.PENDING_VERIFICATIONS, token);
  if (!record) {
    return Response.json(
      { error: "Verification not found or expired" },
      { status: 404 }
    );
  }

  return Response.json({
    status: record.status,
    message: STATUS_MESSAGES[record.status],
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/handlers/status.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/status.ts test/handlers/status.test.ts
git commit -m "feat: add status polling handler"
```

---

### Task 7: Email Handler

**Files:**
- Create: `src/handlers/email.ts`
- Create: `test/handlers/email.test.ts`

- [ ] **Step 1: Write failing tests for email handler**

```typescript
// test/handlers/email.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { handleEmail } from "../../src/handlers/email";
import {
  createVerification,
  getVerification,
} from "../../src/services/kv";

const originalFetch = globalThis.fetch;

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

describe("handleEmail", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("silently drops email with no matching KV record", async () => {
    await handleEmail(makeEmailMessage("unknown@example.com"), env);
    // No error thrown — silent drop
  });

  it("invites user and sets status to completed on success", async () => {
    const token = await createVerification(
      env.PENDING_VERIFICATIONS,
      "invitee@example.com"
    );

    // Mock: resolveTeamId, ensureRepoPermission, sendOrgInvitation
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 99 }), { status: 200 })
      ) // resolveTeamId
      .mockResolvedValueOnce(
        new Response(null, { status: 204 })
      ) // ensureRepoPermission
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 1 }), { status: 201 })
      ); // sendOrgInvitation

    await handleEmail(makeEmailMessage("invitee@example.com"), env);

    const record = await getVerification(env.PENDING_VERIFICATIONS, token);
    expect(record!.status).toBe("completed");
  });

  it("sets status to failed_github_api on GitHub error", async () => {
    const token = await createVerification(
      env.PENDING_VERIFICATIONS,
      "fail@example.com"
    );

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 99 }), { status: 200 })
      ) // resolveTeamId
      .mockResolvedValueOnce(
        new Response(null, { status: 204 })
      ) // ensureRepoPermission
      .mockResolvedValueOnce(
        new Response("Server Error", { status: 500 })
      ); // sendOrgInvitation fails

    await handleEmail(makeEmailMessage("fail@example.com"), env);

    const record = await getVerification(env.PENDING_VERIFICATIONS, token);
    expect(record!.status).toBe("failed_github_api");
  });

  it("skips already-processed records", async () => {
    const token = await createVerification(
      env.PENDING_VERIFICATIONS,
      "done@example.com"
    );
    // Manually complete it
    const rec = await getVerification(env.PENDING_VERIFICATIONS, token);
    rec!.status = "completed";
    await env.PENDING_VERIFICATIONS.put(
      `verify:${token}`,
      JSON.stringify(rec)
    );

    // Should not call GitHub at all
    globalThis.fetch = vi.fn();
    await handleEmail(makeEmailMessage("done@example.com"), env);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/handlers/email.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement email handler**

```typescript
// src/handlers/email.ts
import type { Env } from "../types";
import {
  getTokenByEmail,
  getVerification,
  updateVerificationStatus,
  deleteEmailIndex,
} from "../services/kv";
import {
  resolveTeamId,
  ensureRepoPermission,
  sendOrgInvitation,
} from "../services/github";

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env
): Promise<void> {
  const senderEmail = message.from.toLowerCase().trim();

  const token = await getTokenByEmail(env.PENDING_VERIFICATIONS, senderEmail);
  if (!token) return;

  const record = await getVerification(env.PENDING_VERIFICATIONS, token);
  if (!record || record.status !== "pending_email") return;

  try {
    const cacheKey = `team_id:${env.GITHUB_TEAM_SLUG}`;
    let teamId: number;
    const cached = await env.PENDING_VERIFICATIONS.get(cacheKey);
    if (cached) {
      teamId = Number(cached);
    } else {
      teamId = await resolveTeamId(
        env.GITHUB_ORG,
        env.GITHUB_TEAM_SLUG,
        env.GITHUB_PAT
      );
      await env.PENDING_VERIFICATIONS.put(cacheKey, String(teamId), {
        expirationTtl: 3600,
      });
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
      record.email,
      env.GITHUB_ROLE || "direct_member",
      [teamId],
      env.GITHUB_PAT
    );

    await updateVerificationStatus(env.PENDING_VERIFICATIONS, token, "completed");
  } catch {
    await updateVerificationStatus(
      env.PENDING_VERIFICATIONS,
      token,
      "failed_github_api"
    );
  }

  await deleteEmailIndex(env.PENDING_VERIFICATIONS, senderEmail);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/handlers/email.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/email.ts test/handlers/email.test.ts
git commit -m "feat: add email handler for verification and GitHub invitation"
```

---

### Task 8: HTML Template + Page Handler

**Files:**
- Create: `src/html/page.ts`
- Create: `src/handlers/page.ts`

- [ ] **Step 1: Create the HTML template**

```typescript
// src/html/page.ts
export function renderPage(siteKey: string, verificationEmail: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Request Repository Access</title>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      line-height: 1.6;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1rem;
      background: #f5f5f5;
      color: #1a1a1a;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #111; color: #e5e5e5; }
      .card { background: #1a1a1a; border-color: #333; }
      input[type="email"] { background: #222; color: #e5e5e5; border-color: #444; }
      code { background: #222; color: #7dd3fc; }
    }
    .card {
      background: #fff;
      border: 1px solid #ddd;
      border-radius: 12px;
      padding: 2rem;
      max-width: 480px;
      width: 100%;
    }
    h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
    .subtitle { color: #666; font-size: 0.875rem; margin-bottom: 1.5rem; }
    label { display: block; font-size: 0.875rem; font-weight: 500; margin-bottom: 0.25rem; }
    input[type="email"] {
      width: 100%;
      padding: 0.5rem 0.75rem;
      border: 1px solid #ccc;
      border-radius: 6px;
      font-size: 1rem;
      margin-bottom: 1rem;
    }
    .cf-turnstile { margin-bottom: 1rem; }
    button {
      width: 100%;
      padding: 0.625rem;
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 6px;
      font-size: 1rem;
      cursor: pointer;
    }
    button:hover { background: #1d4ed8; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .step { display: none; }
    .step.active { display: block; }
    .status { text-align: center; padding: 1rem 0; }
    .spinner { display: inline-block; width: 20px; height: 20px; border: 2px solid #ccc; border-top-color: #2563eb; border-radius: 50%; animation: spin 0.8s linear infinite; margin-right: 0.5rem; vertical-align: middle; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .success { color: #16a34a; font-weight: 600; }
    .error { color: #dc2626; font-size: 0.875rem; margin-top: 0.5rem; }
    .fail { color: #dc2626; font-weight: 600; }
    code { background: #f0f0f0; padding: 0.125rem 0.375rem; border-radius: 4px; font-size: 0.9em; }
    .instructions { margin: 1rem 0; padding: 1rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0; }
    @media (prefers-color-scheme: dark) {
      .instructions { background: #1e293b; border-color: #334155; }
      .subtitle { color: #999; }
    }
  </style>
</head>
<body>
  <div class="card">
    <!-- Step 1: Email + Turnstile -->
    <div id="step1" class="step active">
      <h1>Request Repository Access</h1>
      <p class="subtitle">Verify your email to receive a GitHub invitation.</p>
      <form id="verifyForm">
        <label for="email">Email address</label>
        <input type="email" id="email" name="email" required placeholder="you@example.com" />
        <div class="cf-turnstile" data-sitekey="${siteKey}"></div>
        <button type="submit" id="submitBtn">Verify</button>
        <div id="step1Error" class="error"></div>
      </form>
    </div>

    <!-- Step 2: Awaiting email -->
    <div id="step2" class="step">
      <h1>Send Verification Email</h1>
      <div class="instructions">
        <p>Send any email from <code id="userEmail"></code> to:</p>
        <p style="margin-top:0.5rem;"><code>${verificationEmail}</code></p>
      </div>
      <div class="status">
        <span class="spinner"></span> Waiting for your email...
      </div>
    </div>

    <!-- Step 3: Result -->
    <div id="step3" class="step">
      <div id="resultSuccess" style="display:none;">
        <h1 class="success">Invitation Sent!</h1>
        <p style="margin-top:0.5rem;">Check your email for the GitHub organization invite.</p>
      </div>
      <div id="resultFail" style="display:none;">
        <h1 class="fail">Something Went Wrong</h1>
        <p style="margin-top:0.5rem;">GitHub API returned an error. Please try again later.</p>
        <button onclick="location.reload()" style="margin-top:1rem;">Try Again</button>
      </div>
      <div id="resultExpired" style="display:none;">
        <h1 class="fail">Verification Expired</h1>
        <p style="margin-top:0.5rem;">The verification window has passed. Please start over.</p>
        <button onclick="location.reload()" style="margin-top:1rem;">Start Over</button>
      </div>
    </div>
  </div>

  <script>
    const form = document.getElementById("verifyForm");
    const emailInput = document.getElementById("email");
    const step1Error = document.getElementById("step1Error");
    let verificationToken = null;

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      step1Error.textContent = "";
      const btn = document.getElementById("submitBtn");
      btn.disabled = true;

      const turnstileInput = form.querySelector("[name='cf-turnstile-response']");
      if (!turnstileInput || !turnstileInput.value) {
        step1Error.textContent = "Please complete the captcha.";
        btn.disabled = false;
        return;
      }

      try {
        const res = await fetch("/api/verify-turnstile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: emailInput.value,
            turnstileToken: turnstileInput.value,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          step1Error.textContent = data.error || "Verification failed.";
          btn.disabled = false;
          if (typeof turnstile !== "undefined") turnstile.reset();
          return;
        }
        verificationToken = data.token;
        document.getElementById("userEmail").textContent = emailInput.value;
        showStep(2);
        pollStatus();
      } catch {
        step1Error.textContent = "Network error. Please try again.";
        btn.disabled = false;
      }
    });

    function showStep(n) {
      document.querySelectorAll(".step").forEach((s) => s.classList.remove("active"));
      document.getElementById("step" + n).classList.add("active");
    }

    async function pollStatus() {
      const maxAttempts = 600; // 30 minutes at 3s intervals
      let attempts = 0;
      const interval = setInterval(async () => {
        attempts++;
        if (attempts > maxAttempts) {
          clearInterval(interval);
          showStep(3);
          document.getElementById("resultExpired").style.display = "block";
          return;
        }
        try {
          const res = await fetch("/api/status/" + verificationToken);
          if (res.status === 404) {
            clearInterval(interval);
            showStep(3);
            document.getElementById("resultExpired").style.display = "block";
            return;
          }
          const data = await res.json();
          if (data.status === "completed") {
            clearInterval(interval);
            showStep(3);
            document.getElementById("resultSuccess").style.display = "block";
          } else if (data.status.startsWith("failed")) {
            clearInterval(interval);
            showStep(3);
            document.getElementById("resultFail").style.display = "block";
          }
        } catch { /* retry on next tick */ }
      }, 3000);
    }
  </script>
</body>
</html>`;
}
```

- [ ] **Step 2: Create the page handler**

```typescript
// src/handlers/page.ts
import type { Env } from "../types";
import { renderPage } from "../html/page";

export function handlePage(env: Env): Response {
  const html = renderPage(env.TURNSTILE_SITE_KEY, env.VERIFICATION_EMAIL);
  return new Response(html, {
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add src/html/page.ts src/handlers/page.ts
git commit -m "feat: add HTML template and page handler"
```

---

### Task 9: Worker Entry Point

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Create the worker entry point with fetch and email exports**

```typescript
// src/index.ts
import type { Env } from "./types";
import { handlePage } from "./handlers/page";
import { handleVerifyTurnstile } from "./handlers/turnstile";
import { handleStatus } from "./handlers/status";
import { handleEmail } from "./handlers/email";

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

    return Response.json({ error: "Not found" }, { status: 404 });
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleEmail(message, env);
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add worker entry point with fetch and email handlers"
```

---

### Task 10: Run Full Test Suite and Verify

**Files:** None new — verification step.

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests pass across all test files.

- [ ] **Step 2: Run wrangler dev to verify local startup**

Run: `npx wrangler dev --local`
Expected: Worker starts without errors. Visit `http://localhost:8787/` and confirm the HTML page renders with the email form and Turnstile widget placeholder.

- [ ] **Step 3: Commit any fixes if needed, then final commit**

```bash
git add -A
git commit -m "chore: verify full test suite passes"
```

---

## Deployment Checklist (Post-Implementation)

These are manual steps the deployer performs, not automated tasks:

1. Create KV namespace: `npx wrangler kv namespace create PENDING_VERIFICATIONS`
2. Update `wrangler.toml` with the returned namespace ID
3. Set secrets:
   - `npx wrangler secret put TURNSTILE_SECRET_KEY`
   - `npx wrangler secret put GITHUB_PAT`
4. Set env vars in `wrangler.toml`:
   - `TURNSTILE_SITE_KEY`, `GITHUB_ORG`, `GITHUB_REPO`, `GITHUB_ROLE`, `GITHUB_TEAM_SLUG`, `GITHUB_PERMISSION`, `VERIFICATION_EMAIL`
5. Configure Cloudflare Email Routing to forward the verification email address to this Worker
6. Deploy: `npx wrangler deploy`
7. Test end-to-end with a real email
