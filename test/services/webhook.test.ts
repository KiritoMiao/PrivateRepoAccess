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

    await sendWebhook(testEnv, "t", 'evil"@x.com', "long");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toBe('evil"@x.com');
  });

  it("does not re-expand a placeholder contained in user input", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response("ok", { status: 200 }))
    );
    globalThis.fetch = fetchMock;

    const testEnv = {
      ...env,
      WEBHOOK_URL: "https://hook.example.com/post",
      WEBHOOK_TEMPLATE: '{"text":"{{text_short}} | {{text_long}}"}',
    };

    // The email (text_short) literally contains the {{text_long}} token.
    // Single-pass substitution must leave it as a literal, not expand it.
    await sendWebhook(testEnv, "t", "a{{text_long}}@x.com", "SECRET_LONG");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toBe("a{{text_long}}@x.com | SECRET_LONG");
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
