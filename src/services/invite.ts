import { type Env, getKV, createLogger } from "../types";
import {
  resolveTeamId,
  ensureRepoPermission,
  sendOrgInvitation,
} from "./github";

export async function performInvitation(
  env: Env,
  email: string
): Promise<void> {
  const log = createLogger(env);
  const kv = getKV(env);

  const cacheKey = `team_id:${env.GITHUB_ORG}:${env.GITHUB_TEAM_SLUG}`;
  const cached = await kv.get(cacheKey);
  const cachedId = cached !== null ? Number(cached) : NaN;
  let teamId: number;
  if (Number.isSafeInteger(cachedId) && cachedId > 0) {
    teamId = cachedId;
  } else {
    teamId = await resolveTeamId(
      env.GITHUB_ORG,
      env.GITHUB_TEAM_SLUG,
      env.GITHUB_PAT
    );
    await kv.put(cacheKey, String(teamId), { expirationTtl: 3600 });
    log.debug(`[invite] resolved team ${env.GITHUB_TEAM_SLUG} → id ${teamId}`);
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
    email,
    env.GITHUB_ROLE || "direct_member",
    [teamId],
    env.GITHUB_PAT
  );

  log.info(`[invite] invited ${email} to ${env.GITHUB_ORG}/${env.GITHUB_REPO} (team: ${env.GITHUB_TEAM_SLUG}, permission: ${env.GITHUB_PERMISSION || "pull"})`);
}
