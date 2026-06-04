import type { ReviewMetadata } from "../types";

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderAdminPage(
  reviews: Array<{ reviewId: string; metadata: ReviewMetadata }>,
  token: string
): string {
  const rows = reviews
    .map((r) => {
      const email = escapeHtml(r.metadata.email);
      const when = new Date(r.metadata.createdAt).toISOString().replace("T", " ").slice(0, 19);
      const status = escapeHtml(r.metadata.status);
      const id = escapeHtml(r.reviewId);
      const actions =
        r.metadata.status === "pending_review"
          ? `<button class="approve" data-id="${id}">Approve</button> <button class="decline" data-id="${id}">Decline</button>`
          : "—";
      return `<tr data-row="${id}"><td>${email}</td><td>${when} UTC</td><td class="status">${status}</td><td>${actions}</td></tr>`;
    })
    .join("");

  const emptyRow = `<tr><td colspan="4" style="text-align:center;color:#888;">No requests yet.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Access Request Review</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #111; color: #e5e5e5; padding: 2rem 1rem; line-height: 1.5; }
    .wrap { max-width: 900px; margin: 0 auto; }
    h1 { font-size: 1.25rem; margin-bottom: 1rem; }
    table { width: 100%; border-collapse: collapse; background: #1a1a1a; border: 1px solid #333; border-radius: 8px; overflow: hidden; }
    th, td { text-align: left; padding: 0.625rem 0.875rem; border-bottom: 1px solid #2a2a2a; font-size: 0.9rem; }
    th { background: #222; font-weight: 600; }
    tr:last-child td { border-bottom: none; }
    button { padding: 0.35rem 0.7rem; border: none; border-radius: 5px; font-size: 0.85rem; cursor: pointer; color: #fff; }
    .approve { background: #16a34a; }
    .approve:hover { background: #15803d; }
    .decline { background: #dc2626; }
    .decline:hover { background: #b91c1c; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .status { text-transform: capitalize; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Access Request Review</h1>
    <table>
      <thead><tr><th>Email</th><th>Requested</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${rows || emptyRow}</tbody>
    </table>
  </div>
  <script>
    const TOKEN = ${JSON.stringify(token)};
    async function act(endpoint, reviewId, btn) {
      const row = document.querySelector('[data-row="' + reviewId + '"]');
      row.querySelectorAll("button").forEach((b) => (b.disabled = true));
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reviewId, token: TOKEN }),
        });
        const data = await res.json();
        if (!res.ok) {
          alert(data.error || "Action failed");
          row.querySelectorAll("button").forEach((b) => (b.disabled = false));
          return;
        }
        row.querySelector(".status").textContent = data.status;
        row.querySelector("td:last-child").textContent = "—";
      } catch {
        alert("Network error");
        row.querySelectorAll("button").forEach((b) => (b.disabled = false));
      }
    }
    document.querySelectorAll(".approve").forEach((b) =>
      b.addEventListener("click", () => act("/api/admin/approve", b.dataset.id, b))
    );
    document.querySelectorAll(".decline").forEach((b) =>
      b.addEventListener("click", () => act("/api/admin/decline", b.dataset.id, b))
    );
  </script>
</body>
</html>`;
}
