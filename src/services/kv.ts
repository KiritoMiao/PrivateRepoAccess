import type { VerificationRecord, VerificationStatus } from "../types";

const TTL = 1800; // 30 minutes

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

export async function createVerification(
  kv: KVNamespace,
  rawEmail: string
): Promise<string> {
  const email = normalizeEmail(rawEmail);

  const existing = await kv.get(`email:${email}`);
  if (existing) return existing;

  const token = crypto.randomUUID();
  const record: VerificationRecord = {
    email,
    status: "pending_email",
    createdAt: Date.now(),
  };

  await kv.put(`verify:${token}`, JSON.stringify(record), {
    expirationTtl: TTL,
  });
  await kv.put(`email:${email}`, token, { expirationTtl: TTL });

  return token;
}

export async function getVerification(
  kv: KVNamespace,
  token: string
): Promise<VerificationRecord | null> {
  const raw = await kv.get(`verify:${token}`);
  if (!raw) return null;
  return JSON.parse(raw);
}

export async function getTokenByEmail(
  kv: KVNamespace,
  rawEmail: string
): Promise<string | null> {
  return kv.get(`email:${normalizeEmail(rawEmail)}`);
}

export async function updateVerificationStatus(
  kv: KVNamespace,
  token: string,
  status: VerificationStatus
): Promise<void> {
  const record = await getVerification(kv, token);
  if (!record) return;
  record.status = status;
  await kv.put(`verify:${token}`, JSON.stringify(record), {
    expirationTtl: TTL,
  });
}

export async function deleteEmailIndex(
  kv: KVNamespace,
  rawEmail: string
): Promise<void> {
  await kv.delete(`email:${normalizeEmail(rawEmail)}`);
}
