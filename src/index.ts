// src/index.ts
import type { Env } from "./types";
import { handlePage } from "./handlers/page";
import { handleVerifyTurnstile } from "./handlers/turnstile";
import { handleStatus } from "./handlers/status";
import { handleEmail } from "./handlers/email";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return handlePage(env);
    }

    if (request.method === "POST" && url.pathname === "/api/verify-turnstile") {
      return handleVerifyTurnstile(request, env);
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/status/")) {
      return handleStatus(request, env);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleEmail(message, env);
  },
} satisfies ExportedHandler<Env>;
