export interface Env {
  KV_BINDING_NAME: string;
  LOG_LEVEL: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  GITHUB_PAT: string;
  GITHUB_ORG: string;
  GITHUB_REPO: string;
  GITHUB_ROLE: string;
  GITHUB_TEAM_SLUG: string;
  GITHUB_PERMISSION: string;
  VERIFICATION_EMAIL: string;
  WEBHOOK_URL: string;
  WEBHOOK_TEMPLATE: string;
  PUBLIC_URL: string;
  ADMIN_TOKEN: string;
}

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

export function createLogger(env: Env) {
  const level = LOG_LEVELS[(env.LOG_LEVEL || "error") as LogLevel] ?? 0;
  return {
    debug: (...args: unknown[]) => { if (level >= 3) console.log(...args); },
    info: (...args: unknown[]) => { if (level >= 2) console.log(...args); },
    warn: (...args: unknown[]) => { if (level >= 1) console.warn(...args); },
    error: (...args: unknown[]) => { console.error(...args); },
  };
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
  | "pending_review"
  | "approved"
  | "declined"
  | "failed_github_api";

export interface VerificationRecord {
  email: string;
  status: VerificationStatus;
  createdAt: number;
}

export interface ReviewRecord {
  email: string;
  status: VerificationStatus;
  createdAt: number;
  reviewedAt: number | null;
}

export interface ReviewMetadata {
  email: string;
  status: VerificationStatus;
  createdAt: number;
}
