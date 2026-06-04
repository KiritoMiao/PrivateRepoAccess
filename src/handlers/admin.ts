import { type Env, createLogger, getKV } from "../types";
import { listReviews, getReview, updateReviewStatus } from "../services/kv";
import { performInvitation } from "../services/invite";
import { renderAdminPage } from "../html/admin";

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function authorized(env: Env, token: string | null): boolean {
  if (!env.ADMIN_TOKEN || !token) return false;
  return constantTimeEqual(token, env.ADMIN_TOKEN);
}

export async function handleAdminPage(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!authorized(env, token)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "Content-Type": "text/html;charset=UTF-8" },
    });
  }

  const reviews = await listReviews(getKV(env));
  reviews.sort((a, b) => b.metadata.createdAt - a.metadata.createdAt);
  const html = renderAdminPage(reviews, token!);
  return new Response(html, {
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  });
}

async function readBody(
  request: Request
): Promise<{ reviewId?: string; token?: string } | null> {
  return (await request.json().catch(() => null)) as {
    reviewId?: string;
    token?: string;
  } | null;
}

export async function handleApprove(
  request: Request,
  env: Env
): Promise<Response> {
  const log = createLogger(env);
  const body = await readBody(request);
  if (!authorized(env, body?.token ?? null)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!body?.reviewId) {
    return Response.json({ error: "Missing reviewId" }, { status: 400 });
  }

  const review = await getReview(getKV(env), body.reviewId);
  if (!review) {
    return Response.json({ error: "Review not found" }, { status: 404 });
  }
  if (review.status !== "pending_review") {
    return Response.json(
      { error: `Already ${review.status}` },
      { status: 409 }
    );
  }

  try {
    await performInvitation(env, review.email);
    await updateReviewStatus(getKV(env), body.reviewId, "approved");
    log.info(`[admin] approved ${review.email} (review ${body.reviewId})`);
    return Response.json({ status: "approved" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[admin] approve failed for ${review.email}: ${msg}`);
    await updateReviewStatus(getKV(env), body.reviewId, "failed_github_api");
    return Response.json({ error: "GitHub invitation failed" }, { status: 502 });
  }
}

export async function handleDecline(
  request: Request,
  env: Env
): Promise<Response> {
  const log = createLogger(env);
  const body = await readBody(request);
  if (!authorized(env, body?.token ?? null)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!body?.reviewId) {
    return Response.json({ error: "Missing reviewId" }, { status: 400 });
  }

  const review = await getReview(getKV(env), body.reviewId);
  if (!review) {
    return Response.json({ error: "Review not found" }, { status: 404 });
  }

  await updateReviewStatus(getKV(env), body.reviewId, "declined");
  log.info(`[admin] declined ${review.email} (review ${body.reviewId})`);
  return Response.json({ status: "declined" });
}
