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
      env.FAASGAUGE_REPO_PENDING_VERIFICATIONS,
      "User@Example.com"
    );

    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );

    const record = await getVerification(env.FAASGAUGE_REPO_PENDING_VERIFICATIONS, token);
    expect(record).not.toBeNull();
    expect(record!.email).toBe("user@example.com");
    expect(record!.status).toBe("pending_email");
    expect(record!.createdAt).toBeTypeOf("number");

    const lookedUpToken = await getTokenByEmail(
      env.FAASGAUGE_REPO_PENDING_VERIFICATIONS,
      "User@Example.com"
    );
    expect(lookedUpToken).toBe(token);
  });

  it("returns null for nonexistent token", async () => {
    const record = await getVerification(
      env.FAASGAUGE_REPO_PENDING_VERIFICATIONS,
      "nonexistent"
    );
    expect(record).toBeNull();
  });

  it("returns null for nonexistent email", async () => {
    const token = await getTokenByEmail(
      env.FAASGAUGE_REPO_PENDING_VERIFICATIONS,
      "nobody@example.com"
    );
    expect(token).toBeNull();
  });

  it("returns existing token for duplicate email", async () => {
    const token1 = await createVerification(
      env.FAASGAUGE_REPO_PENDING_VERIFICATIONS,
      "dupe@example.com"
    );
    const token2 = await createVerification(
      env.FAASGAUGE_REPO_PENDING_VERIFICATIONS,
      "dupe@example.com"
    );
    expect(token2).toBe(token1);
  });

  it("updates verification status", async () => {
    const token = await createVerification(
      env.FAASGAUGE_REPO_PENDING_VERIFICATIONS,
      "update@example.com"
    );
    await updateVerificationStatus(
      env.FAASGAUGE_REPO_PENDING_VERIFICATIONS,
      token,
      "approved"
    );
    const record = await getVerification(env.FAASGAUGE_REPO_PENDING_VERIFICATIONS, token);
    expect(record!.status).toBe("approved");
  });

  it("deletes email index", async () => {
    const token = await createVerification(
      env.FAASGAUGE_REPO_PENDING_VERIFICATIONS,
      "delete@example.com"
    );
    await deleteEmailIndex(env.FAASGAUGE_REPO_PENDING_VERIFICATIONS, "delete@example.com");
    const result = await getTokenByEmail(
      env.FAASGAUGE_REPO_PENDING_VERIFICATIONS,
      "delete@example.com"
    );
    expect(result).toBeNull();
  });
});
