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
