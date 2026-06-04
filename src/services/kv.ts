import type {
  VerificationRecord,
  VerificationStatus,
  ReviewRecord,
  ReviewMetadata,
} from "../types";

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

export async function createReview(
  kv: KVNamespace,
  rawEmail: string
): Promise<string> {
  const email = normalizeEmail(rawEmail);
  const reviewId = crypto.randomUUID();
  const createdAt = Date.now();
  const record: ReviewRecord = {
    email,
    status: "pending_review",
    createdAt,
    reviewedAt: null,
  };
  const metadata: ReviewMetadata = {
    email,
    status: "pending_review",
    createdAt,
  };
  await kv.put(`review:${reviewId}`, JSON.stringify(record), { metadata });
  return reviewId;
}

export async function getReview(
  kv: KVNamespace,
  reviewId: string
): Promise<ReviewRecord | null> {
  const raw = await kv.get(`review:${reviewId}`);
  if (!raw) return null;
  return JSON.parse(raw);
}

export async function listReviews(
  kv: KVNamespace
): Promise<Array<{ reviewId: string; metadata: ReviewMetadata }>> {
  const result = await kv.list<ReviewMetadata>({ prefix: "review:" });
  return result.keys
    .filter((k) => k.metadata !== undefined)
    .map((k) => ({
      reviewId: k.name.slice("review:".length),
      metadata: k.metadata as ReviewMetadata,
    }));
}

export async function updateReviewStatus(
  kv: KVNamespace,
  reviewId: string,
  status: VerificationStatus
): Promise<void> {
  const record = await getReview(kv, reviewId);
  if (!record) return;
  record.status = status;
  record.reviewedAt = Date.now();
  const metadata: ReviewMetadata = {
    email: record.email,
    status,
    createdAt: record.createdAt,
  };
  await kv.put(`review:${reviewId}`, JSON.stringify(record), { metadata });
}
