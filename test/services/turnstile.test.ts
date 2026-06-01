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
