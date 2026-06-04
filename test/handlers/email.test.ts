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
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("creates a pending review and fires webhook, does NOT call GitHub", async () => {
    const token = await createVerification(kv, "reviewme@example.com");

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("api.github.com")) {
        throw new Error("GitHub must not be called before approval");
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    });
    globalThis.fetch = fetchMock;

    await handleEmail(makeEmailMessage("reviewme@example.com"), testEnv());

    const record = await getVerification(kv, token);
    expect(record!.status).toBe("pending_review");

    const reviews = await listReviews(kv);
    expect(reviews.some((r) => r.metadata.email === "reviewme@example.com")).toBe(true);

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
