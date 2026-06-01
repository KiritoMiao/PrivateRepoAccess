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
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ success: false }), { status: 200 })
      )
    );

    const res = await handleVerifyTurnstile(
      makeRequest({ email: "user@example.com", turnstileToken: "bad" }),
      env
    );
    expect(res.status).toBe(403);
  });

  it("returns 200 with token on success", async () => {
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      )
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
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      )
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
