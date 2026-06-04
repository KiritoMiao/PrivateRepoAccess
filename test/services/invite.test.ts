import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { performInvitation } from "../../src/services/invite";

const originalFetch = globalThis.fetch;
const kv = env.FAASGAUGE_REPO_PENDING_VERIFICATIONS;

function baseEnv() {
  return {
    ...env,
    GITHUB_ORG: "my-org",
    GITHUB_REPO: "my-repo",
    GITHUB_TEAM_SLUG: "my-team",
    GITHUB_ROLE: "direct_member",
    GITHUB_PERMISSION: "pull",
    GITHUB_PAT: "ghp_test",
  };
}

describe("performInvitation", () => {
  beforeEach(async () => {
    globalThis.fetch = originalFetch;
    await kv.delete("team_id:my-org:my-team");
  });

  it("resolves team, sets permission, and sends invitation in order", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/teams/my-team")) {
        return Promise.resolve(new Response(JSON.stringify({ id: 555 }), { status: 200 }));
      }
      if (url.endsWith("/repos/my-org/my-repo")) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.endsWith("/invitations")) {
        return Promise.resolve(new Response(JSON.stringify({ id: 1 }), { status: 201 }));
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    });

    await performInvitation(baseEnv(), "invitee@example.com");

    expect(calls[0]).toBe("GET https://api.github.com/orgs/my-org/teams/my-team");
    expect(calls[1]).toBe("PUT https://api.github.com/orgs/my-org/teams/my-team/repos/my-org/my-repo");
    expect(calls[2]).toBe("POST https://api.github.com/orgs/my-org/invitations");
  });

  it("uses cached team id on second call (no resolve fetch)", async () => {
    await kv.put("team_id:my-org:my-team", "999");

    const urls: string[] = [];
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      urls.push(url);
      if (url.endsWith("/repos/my-org/my-repo")) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.endsWith("/invitations")) {
        return Promise.resolve(new Response(JSON.stringify({ id: 1 }), { status: 201 }));
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    });

    await performInvitation(baseEnv(), "cached@example.com");

    expect(urls.some((u) => u.endsWith("/teams/my-team"))).toBe(false);
  });

  it("throws when a GitHub call fails", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/teams/my-team")) {
        return Promise.resolve(new Response(JSON.stringify({ id: 1 }), { status: 200 }));
      }
      if (url.endsWith("/repos/my-org/my-repo")) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(new Response("err", { status: 500 }));
    });

    await expect(
      performInvitation(baseEnv(), "fail@example.com")
    ).rejects.toThrow();
  });
});
