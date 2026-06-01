export interface Env {
  PENDING_VERIFICATIONS: KVNamespace;
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

export type VerificationStatus =
  | "pending_email"
  | "completed"
  | "failed_github_api";

export interface VerificationRecord {
  email: string;
  status: VerificationStatus;
  createdAt: number;
}
