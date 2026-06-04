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

    it("does not throw on 422 when already a member/invited", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            errors: [
              {
                message:
                  "A user with this email is already a part of your organization, or has already been invited.",
              },
            ],
          }),
          { status: 422 }
        )
      );

      await expect(
        sendOrgInvitation(
          "my-org", "member@example.com", "direct_member", [12345], "ghp_token"
        )
      ).resolves.not.toThrow();
    });

    it("throws on 422 that is not an already-member case (e.g. bad team_ids)", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ message: "Validation Failed", errors: [{ field: "team_ids" }] }),
          { status: 422 }
        )
      );

      await expect(
        sendOrgInvitation(
          "my-org", "user@example.com", "direct_member", [999999], "ghp_token"
        )
      ).rejects.toThrow("Failed to send org invitation: 422");
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
