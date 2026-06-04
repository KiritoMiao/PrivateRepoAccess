import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  createReview,
  getReview,
  listReviews,
  updateReviewStatus,
} from "../../src/services/kv";

const kv = env.FAASGAUGE_REPO_PENDING_VERIFICATIONS;

describe("KV review CRUD", () => {
  it("creates a review with value and metadata", async () => {
    const reviewId = await createReview(kv, "Review@Example.com");
    expect(reviewId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );

    const record = await getReview(kv, reviewId);
    expect(record).not.toBeNull();
    expect(record!.email).toBe("review@example.com");
    expect(record!.status).toBe("pending_review");
    expect(record!.reviewedAt).toBeNull();
    expect(record!.createdAt).toBeTypeOf("number");
  });

  it("returns null for nonexistent review", async () => {
    const record = await getReview(kv, "nope");
    expect(record).toBeNull();
  });

  it("lists reviews with metadata", async () => {
    const id = await createReview(kv, "listed@example.com");
    const reviews = await listReviews(kv);
    const found = reviews.find((r) => r.reviewId === id);
    expect(found).toBeDefined();
    expect(found!.metadata.email).toBe("listed@example.com");
    expect(found!.metadata.status).toBe("pending_review");
    expect(found!.metadata.createdAt).toBeTypeOf("number");
  });

  it("updates review status and reviewedAt", async () => {
    const id = await createReview(kv, "approve@example.com");
    await updateReviewStatus(kv, id, "approved");

    const record = await getReview(kv, id);
    expect(record!.status).toBe("approved");
    expect(record!.reviewedAt).toBeTypeOf("number");

    const reviews = await listReviews(kv);
    const found = reviews.find((r) => r.reviewId === id);
    expect(found!.metadata.status).toBe("approved");
  });

  it("update on missing review is a no-op", async () => {
    await updateReviewStatus(kv, "missing", "declined");
    const record = await getReview(kv, "missing");
    expect(record).toBeNull();
  });
});
