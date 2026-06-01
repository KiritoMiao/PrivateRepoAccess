import type { Env } from "./types";

export default {
  async fetch(_request: Request, _env: Env): Promise<Response> {
    return new Response("Not implemented", { status: 501 });
  },
};
