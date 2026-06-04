import { type Env, createLogger } from "../types";

// Escapes a string for safe embedding inside a JSON string literal.
// JSON.stringify wraps in quotes and escapes quotes/newlines/backslashes;
// slicing removes the surrounding quotes.
function jsonEscape(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

export async function sendWebhook(
  env: Env,
  title: string,
  textShort: string,
  textLong: string
): Promise<void> {
  const log = createLogger(env);
  if (!env.WEBHOOK_URL) return;

  const body = env.WEBHOOK_TEMPLATE
    .replaceAll("{{title}}", jsonEscape(title))
    .replaceAll("{{text_short}}", jsonEscape(textShort))
    .replaceAll("{{text_long}}", jsonEscape(textLong));

  try {
    const res = await fetch(env.WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) {
      log.error(`[webhook] POST failed: ${res.status}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[webhook] POST threw: ${msg}`);
  }
}
