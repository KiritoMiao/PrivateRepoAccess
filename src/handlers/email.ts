import { type Env, getKV, createLogger } from "../types";
import {
  getTokenByEmail,
  getVerification,
  updateVerificationStatus,
  deleteEmailIndex,
  createReview,
} from "../services/kv";
import { sendWebhook } from "../services/webhook";

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

  // Create a persistent review request instead of inviting directly.
  const reviewId = await createReview(getKV(env), record.email);
  await updateVerificationStatus(getKV(env), token, "pending_review");
  await deleteEmailIndex(getKV(env), senderEmail);
  log.info(`[email] pending review created for ${record.email} (review ${reviewId})`);

  // Notify the admin (failures are logged inside sendWebhook, never thrown).
  const adminUrl = `${env.PUBLIC_URL}/admin?token=${env.ADMIN_TOKEN}`;
  const requestedAt = new Date(record.createdAt).toISOString();
  const textLong = `Email: ${record.email}\nRequested: ${requestedAt}\nReview: ${adminUrl}`;
  await sendWebhook(env, "New repo access request", record.email, textLong);
}
