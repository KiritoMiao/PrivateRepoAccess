import type { Env } from "../types";
import {
  getTokenByEmail,
  getVerification,
  updateVerificationStatus,
  deleteEmailIndex,
} from "../services/kv";
import {
  resolveTeamId,
  ensureRepoPermission,
  sendOrgInvitation,
} from "../services/github";

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env
): Promise<void> {
  const senderEmail = message.from.toLowerCase().trim();

  const token = await getTokenByEmail(env.PENDING_VERIFICATIONS, senderEmail);
  if (!token) return;

  const record = await getVerification(env.PENDING_VERIFICATIONS, token);
  if (!record || record.status !== "pending_email") return;

  try {
    const cacheKey = `team_id:${env.GITHUB_TEAM_SLUG}`;
    let teamId: number;
    const cached = await env.PENDING_VERIFICATIONS.get(cacheKey);
    if (cached) {
      teamId = Number(cached);
    } else {
      teamId = await resolveTeamId(
        env.GITHUB_ORG,
        env.GITHUB_TEAM_SLUG,
        env.GITHUB_PAT
      );
      await env.PENDING_VERIFICATIONS.put(cacheKey, String(teamId), {
        expirationTtl: 3600,
      });
    }

    await ensureRepoPermission(
      env.GITHUB_ORG,
      env.GITHUB_TEAM_SLUG,
      env.GITHUB_REPO,
      env.GITHUB_PERMISSION || "pull",
      env.GITHUB_PAT
    );

    await sendOrgInvitation(
      env.GITHUB_ORG,
      record.email,
      env.GITHUB_ROLE || "direct_member",
      [teamId],
      env.GITHUB_PAT
    );

    await updateVerificationStatus(env.PENDING_VERIFICATIONS, token, "completed");
  } catch {
    await updateVerificationStatus(
      env.PENDING_VERIFICATIONS,
      token,
      "failed_github_api"
    );
  }

  await deleteEmailIndex(env.PENDING_VERIFICATIONS, senderEmail);
}
