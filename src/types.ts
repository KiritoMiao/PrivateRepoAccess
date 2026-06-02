export interface Env {
  KV_BINDING_NAME: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  GITHUB_PAT: string;
  GITHUB_ORG: string;
  GITHUB_REPO: string;
  GITHUB_ROLE: string;
  GITHUB_TEAM_SLUG: string;
  GITHUB_PERMISSION: string;
  VERIFICATION_EMAIL: string;
}

export function getKV(env: Env): KVNamespace {
  const kv = (env as unknown as Record<string, unknown>)[env.KV_BINDING_NAME];
  if (!kv) {
    throw new Error(`KV binding '${env.KV_BINDING_NAME}' not found in env`);
  }
  return kv as KVNamespace;
}

export type VerificationStatus =
  | "pending_email"
  | "completed"
  | "failed_github_api";

export interface VerificationRecord {
  email: string;
  status: VerificationStatus;
  createdAt: number;
}
