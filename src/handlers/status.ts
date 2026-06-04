import { type Env, type VerificationStatus, getKV } from "../types";
import { getVerification } from "../services/kv";

const STATUS_MESSAGES: Record<VerificationStatus, string> = {
  pending_email: "Waiting for your verification email...",
  pending_review: "Your request is pending admin review.",
  approved: "Approved! Check your email for the GitHub invitation.",
  declined: "Your request was declined.",
  failed_github_api: "Something went wrong with GitHub. Please try again later.",
};

export async function handleStatus(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.pathname.split("/").pop() || "";

  const record = await getVerification(getKV(env), token);
  if (!record) {
    return Response.json(
      { error: "Verification not found or expired" },
      { status: 404 }
    );
  }

  return Response.json({
    status: record.status,
    message: STATUS_MESSAGES[record.status],
  });
}
