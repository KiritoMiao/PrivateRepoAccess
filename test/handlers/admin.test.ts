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
    await kv.delete("team_id:my-org:my-team");
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

    it("does not clobber a status changed during the GitHub call (atomicity re-read)", async () => {
      const id = await createReview(kv, "a-race@example.com");
      // Simulate a concurrent decline landing while the invitation is in flight:
      // the org-invitation fetch flips the review to "declined" before resolving.
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith("/teams/my-team")) {
          return new Response(JSON.stringify({ id: 7 }), { status: 200 });
        }
        if (url.endsWith("/repos/my-org/my-repo")) {
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/invitations")) {
          const rec = await getReview(kv, id);
          rec!.status = "declined";
          await kv.put(`review:${id}`, JSON.stringify(rec));
          return new Response(JSON.stringify({ id: 1 }), { status: 201 });
        }
        return new Response("x", { status: 500 });
      });

      const res = await handleApprove(postReq({ reviewId: id, token: "secret-token" }), testEnv());
      expect(res.status).toBe(409);
      const record = await getReview(kv, id);
      expect(record!.status).toBe("declined");
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

    it("returns 409 and does not rewrite an already-final review", async () => {
      const id = await createReview(kv, "d-final@example.com");
      const rec = await getReview(kv, id);
      rec!.status = "approved";
      await kv.put(`review:${id}`, JSON.stringify(rec));

      const req = new Request("http://localhost/api/admin/decline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewId: id, token: "secret-token" }),
      });
      const res = await handleDecline(req, testEnv());
      expect(res.status).toBe(409);
      const record = await getReview(kv, id);
      expect(record!.status).toBe("approved");
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
