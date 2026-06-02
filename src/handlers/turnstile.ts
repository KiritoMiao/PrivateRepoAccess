import { type Env, getKV, createLogger } from "../types";
import { verifyTurnstile } from "../services/turnstile";
import { createVerification } from "../services/kv";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function handleVerifyTurnstile(
  request: Request,
  env: Env
): Promise<Response> {
  const log = createLogger(env);
  const body = (await request.json().catch(() => null)) as {
    email?: string;
    turnstileToken?: string;
  } | null;

  if (!body?.email || !body?.turnstileToken) {
    log.warn("[turnstile] rejected: missing fields");
    return Response.json({ error: "Missing email or turnstileToken" }, { status: 400 });
  }

  if (!EMAIL_RE.test(body.email)) {
    log.warn(`[turnstile] rejected: invalid email format — ${body.email}`);
    return Response.json({ error: "Invalid email format" }, { status: 400 });
  }

  const valid = await verifyTurnstile(body.turnstileToken, env.TURNSTILE_SECRET_KEY);
  if (!valid) {
    log.warn(`[turnstile] rejected: captcha failed — ${body.email}`);
    return Response.json({ error: "Turnstile verification failed" }, { status: 403 });
  }

  const token = await createVerification(getKV(env), body.email);
  log.info(`[turnstile] verified: ${body.email} — token ${token}`);
  return Response.json({ token });
}
