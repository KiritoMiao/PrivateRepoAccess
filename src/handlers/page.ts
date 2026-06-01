// src/handlers/page.ts
import type { Env } from "../types";
import { renderPage } from "../html/page";

export function handlePage(env: Env): Response {
  const html = renderPage(env.TURNSTILE_SITE_KEY, env.VERIFICATION_EMAIL);
  return new Response(html, {
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  });
}
