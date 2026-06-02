const GITHUB_API = "https://api.github.com";

function headers(pat: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "worker-access-interface",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function resolveTeamId(
  org: string,
  teamSlug: string,
  pat: string
): Promise<number> {
  const res = await fetch(`${GITHUB_API}/orgs/${org}/teams/${teamSlug}`, {
    headers: headers(pat),
  });
  if (!res.ok) {
    throw new Error(`Failed to resolve team '${teamSlug}': ${res.status}`);
  }
  const data = (await res.json()) as { id: number };
  return data.id;
}

export async function ensureRepoPermission(
  org: string,
  teamSlug: string,
  repo: string,
  permission: string,
  pat: string
): Promise<void> {
  const res = await fetch(
    `${GITHUB_API}/orgs/${org}/teams/${teamSlug}/repos/${org}/${repo}`,
    {
      method: "PUT",
      headers: headers(pat),
      body: JSON.stringify({ permission }),
    }
  );
  if (!res.ok) {
    throw new Error(`Failed to set repo permission: ${res.status}`);
  }
}

export async function sendOrgInvitation(
  org: string,
  email: string,
  role: string,
  teamIds: number[],
  pat: string
): Promise<void> {
  const res = await fetch(`${GITHUB_API}/orgs/${org}/invitations`, {
    method: "POST",
    headers: headers(pat),
    body: JSON.stringify({ email, role, team_ids: teamIds }),
  });
  if (res.status === 422) return;
  if (!res.ok) {
    throw new Error(`Failed to send org invitation: ${res.status}`);
  }
}
