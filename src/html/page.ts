// src/html/page.ts
export function renderPage(siteKey: string, verificationEmail: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Request Repository Access</title>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      line-height: 1.6;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1rem;
      background: #f5f5f5;
      color: #1a1a1a;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #111; color: #e5e5e5; }
      .card { background: #1a1a1a; border-color: #333; }
      input[type="email"] { background: #222; color: #e5e5e5; border-color: #444; }
      code { background: #222; color: #7dd3fc; }
    }
    .card {
      background: #fff;
      border: 1px solid #ddd;
      border-radius: 12px;
      padding: 2rem;
      max-width: 480px;
      width: 100%;
    }
    h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
    .subtitle { color: #666; font-size: 0.875rem; margin-bottom: 1.5rem; }
    label { display: block; font-size: 0.875rem; font-weight: 500; margin-bottom: 0.25rem; }
    input[type="email"] {
      width: 100%;
      padding: 0.5rem 0.75rem;
      border: 1px solid #ccc;
      border-radius: 6px;
      font-size: 1rem;
      margin-bottom: 1rem;
    }
    .cf-turnstile { margin-bottom: 1rem; }
    button {
      width: 100%;
      padding: 0.625rem;
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 6px;
      font-size: 1rem;
      cursor: pointer;
    }
    button:hover { background: #1d4ed8; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .step { display: none; }
    .step.active { display: block; }
    .status { text-align: center; padding: 1rem 0; }
    .spinner { display: inline-block; width: 20px; height: 20px; border: 2px solid #ccc; border-top-color: #2563eb; border-radius: 50%; animation: spin 0.8s linear infinite; margin-right: 0.5rem; vertical-align: middle; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .success { color: #16a34a; font-weight: 600; }
    .error { color: #dc2626; font-size: 0.875rem; margin-top: 0.5rem; }
    .fail { color: #dc2626; font-weight: 600; }
    code { background: #f0f0f0; padding: 0.125rem 0.375rem; border-radius: 4px; font-size: 0.9em; }
    .instructions { margin: 1rem 0; padding: 1rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0; }
    @media (prefers-color-scheme: dark) {
      .instructions { background: #1e293b; border-color: #334155; }
      .subtitle { color: #999; }
    }
  </style>
</head>
<body>
  <div class="card">
    <div id="step1" class="step active">
      <h1>Request Repository Access</h1>
      <p class="subtitle">Verify your email to receive a GitHub invitation.</p>
      <form id="verifyForm">
        <label for="email">Email address</label>
        <input type="email" id="email" name="email" required placeholder="you@example.com" />
        <div class="cf-turnstile" data-sitekey="${siteKey}"></div>
        <button type="submit" id="submitBtn">Verify</button>
        <div id="step1Error" class="error"></div>
      </form>
    </div>

    <div id="step2" class="step">
      <h1>Send Verification Email</h1>
      <div class="instructions">
        <p>Send any email from <code id="userEmail"></code> to:</p>
        <p style="margin-top:0.5rem;"><code>${verificationEmail}</code></p>
      </div>
      <div class="status">
        <span class="spinner"></span> Waiting for your email...
      </div>
    </div>

    <div id="step3" class="step">
      <div id="resultSuccess" style="display:none;">
        <h1 class="success">Invitation Sent!</h1>
        <p style="margin-top:0.5rem;">Check your email for the GitHub organization invite.</p>
      </div>
      <div id="resultFail" style="display:none;">
        <h1 class="fail">Something Went Wrong</h1>
        <p style="margin-top:0.5rem;">GitHub API returned an error. Please try again later.</p>
        <button onclick="location.reload()" style="margin-top:1rem;">Try Again</button>
      </div>
      <div id="resultExpired" style="display:none;">
        <h1 class="fail">Verification Expired</h1>
        <p style="margin-top:0.5rem;">The verification window has passed. Please start over.</p>
        <button onclick="location.reload()" style="margin-top:1rem;">Start Over</button>
      </div>
    </div>
  </div>

  <script>
    const form = document.getElementById("verifyForm");
    const emailInput = document.getElementById("email");
    const step1Error = document.getElementById("step1Error");
    let verificationToken = null;

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      step1Error.textContent = "";
      const btn = document.getElementById("submitBtn");
      btn.disabled = true;

      const turnstileInput = form.querySelector("[name='cf-turnstile-response']");
      if (!turnstileInput || !turnstileInput.value) {
        step1Error.textContent = "Please complete the captcha.";
        btn.disabled = false;
        return;
      }

      try {
        const res = await fetch("/api/verify-turnstile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: emailInput.value,
            turnstileToken: turnstileInput.value,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          step1Error.textContent = data.error || "Verification failed.";
          btn.disabled = false;
          if (typeof turnstile !== "undefined") turnstile.reset();
          return;
        }
        verificationToken = data.token;
        document.getElementById("userEmail").textContent = emailInput.value;
        showStep(2);
        pollStatus();
      } catch {
        step1Error.textContent = "Network error. Please try again.";
        btn.disabled = false;
      }
    });

    function showStep(n) {
      document.querySelectorAll(".step").forEach((s) => s.classList.remove("active"));
      document.getElementById("step" + n).classList.add("active");
    }

    async function pollStatus() {
      const maxAttempts = 600;
      let attempts = 0;
      const interval = setInterval(async () => {
        attempts++;
        if (attempts > maxAttempts) {
          clearInterval(interval);
          showStep(3);
          document.getElementById("resultExpired").style.display = "block";
          return;
        }
        try {
          const res = await fetch("/api/status/" + verificationToken);
          if (res.status === 404) {
            clearInterval(interval);
            showStep(3);
            document.getElementById("resultExpired").style.display = "block";
            return;
          }
          const data = await res.json();
          if (data.status === "completed") {
            clearInterval(interval);
            showStep(3);
            document.getElementById("resultSuccess").style.display = "block";
          } else if (data.status.startsWith("failed")) {
            clearInterval(interval);
            showStep(3);
            document.getElementById("resultFail").style.display = "block";
          }
        } catch { /* retry on next tick */ }
      }, 3000);
    }
  </script>
</body>
</html>`;
}
