import { type Env, getKV, createLogger } from "../types";
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
  const log = createLogger(env);
  const senderEmail = message.from.toLowerCase().trim();
  log.debug(`[email] received from ${senderEmail}`);

  const token = await getTokenByEmail(getKV(env), senderEmail);
  if (!token) {
    log.debug(`[email] no pending verification for ${senderEmail} — dropping`);
    return;
  }

  const record = await getVerification(getKV(env), token);
  if (!record || record.status !== "pending_email") {
    log.debug(`[email] ${senderEmail} — record missing or already processed (${record?.status})`);
    return;
  }

  try {
    const cacheKey = `team_id:${env.GITHUB_TEAM_SLUG}`;
    let teamId: number;
    const cached = await getKV(env).get(cacheKey);
    if (cached) {
      teamId = Number(cached);
    } else {
      teamId = await resolveTeamId(
        env.GITHUB_ORG,
        env.GITHUB_TEAM_SLUG,
        env.GITHUB_PAT
      );
      await getKV(env).put(cacheKey, String(teamId), {
        expirationTtl: 3600,
      });
      log.debug(`[email] resolved team ${env.GITHUB_TEAM_SLUG} → id ${teamId}`);
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

    await updateVerificationStatus(getKV(env), token, "completed");
    log.info(`[email] SUCCESS: invited ${record.email} to ${env.GITHUB_ORG}/${env.GITHUB_REPO} (team: ${env.GITHUB_TEAM_SLUG}, permission: ${env.GITHUB_PERMISSION || "pull"})`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error(`[email] FAILED: ${record.email} — ${errMsg}`);
    await updateVerificationStatus(
      getKV(env),
      token,
      "failed_github_api"
    );
  }

  await deleteEmailIndex(getKV(env), senderEmail);
}
