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
