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
