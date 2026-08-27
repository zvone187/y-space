import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const host = process.env.YSPACE_QA_HOST?.trim() || "127.0.0.1";
const requestedPort = Number.parseInt(process.env.YSPACE_QA_PORT || "41739", 10);
const port = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 41739;
const sentinel =
  process.env.YSPACE_QA_COOKIE_SENTINEL?.trim() || `ys_${randomBytes(24).toString("hex")}`;

const page = ({ title, body, script = "" }) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { max-width: 760px; margin: 48px auto; padding: 0 24px; background: #0b0b0f; color: #f4f4f5; }
      nav { display: flex; flex-wrap: wrap; gap: 12px; margin: 20px 0 32px; }
      a { color: #a89cff; }
      button, input { border: 1px solid #3f3f46; border-radius: 8px; background: #18181b; color: inherit; padding: 10px 12px; }
      button { cursor: pointer; }
      label { display: grid; gap: 8px; max-width: 420px; }
      .card { border: 1px solid #27272a; border-radius: 12px; background: #111115; padding: 20px; }
      .ok { color: #67e8a5; }
      .bad { color: #fb7185; }
      #result { min-height: 24px; margin-top: 16px; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(title)}</h1>
    <nav>
      <a href="/alpha">Alpha</a>
      <a href="/beta">Beta</a>
      <a href="/gamma">Gamma</a>
      <a href="/account">Account</a>
      <a href="/source-login">Create source cookies</a>
      <a href="/logout">Clear fixture cookies</a>
    </nav>
    ${body}
    <script>${script}</script>
  </body>
</html>`;

const routes = {
  "/": () => ({
    status: 302,
    headers: { location: "/alpha" },
    body: "",
  }),
  "/alpha": () => ({
    status: 200,
    body: page({
      title: "Y Space QA — Alpha Form",
      body: `<section class="card">
        <p>Independent tab fixture A.</p>
        <form id="alpha-form">
          <label>Message <input id="message" name="message" autocomplete="off" /></label>
          <p><button id="submit" type="submit">Save message</button></p>
        </form>
        <div id="result" role="status"></div>
      </section>`,
      script: `
        const form = document.querySelector("#alpha-form");
        const input = document.querySelector("#message");
        const result = document.querySelector("#result");
        input.value = sessionStorage.getItem("alpha-message") || "";
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          sessionStorage.setItem("alpha-message", input.value);
          result.textContent = "Saved: " + input.value;
          document.title = "Y Space QA — Alpha Saved";
        });
      `,
    }),
  }),
  "/beta": () => ({
    status: 200,
    body: page({
      title: "Y Space QA — Beta Counter",
      body: `<section class="card">
        <p>Independent tab fixture B.</p>
        <button id="increment" type="button">Increment</button>
        <div id="result" role="status">Count: 0</div>
      </section>`,
      script: `
        let count = Number(sessionStorage.getItem("beta-count") || "0");
        const result = document.querySelector("#result");
        const render = () => { result.textContent = "Count: " + count; };
        render();
        document.querySelector("#increment").addEventListener("click", () => {
          count += 1;
          sessionStorage.setItem("beta-count", String(count));
          render();
        });
      `,
    }),
  }),
  "/gamma": () => ({
    status: 200,
    body: page({
      title: "Y Space QA — Gamma Network",
      body: `<section class="card">
        <p>Independent tab fixture C.</p>
        <button id="request" type="button">Run request</button>
        <div id="result" role="status">Request not run</div>
      </section>`,
      script: `
        document.querySelector("#request").addEventListener("click", async () => {
          const response = await fetch("/api/status");
          const data = await response.json();
          document.querySelector("#result").textContent = data.message;
        });
      `,
    }),
  }),
  "/api/status": () => ({
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: JSON.stringify({ ok: true, message: "Network request verified" }),
  }),
  "/source-login": () => ({
    status: 302,
    headers: {
      location: "/account",
      "set-cookie": [
        `ys_auth=${sentinel}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
        `ys_session=${sentinel}; Path=/; HttpOnly; SameSite=Strict`,
        "ys_preference=violet; Path=/; SameSite=Lax; Max-Age=86400",
        "ys_expired=gone; Path=/; Max-Age=0",
      ],
      "cache-control": "no-store",
    },
    body: "",
  }),
  "/account": ({ request }) => {
    const authenticated = cookieValue(request.headers.cookie, "ys_auth") === sentinel;
    return {
      status: authenticated ? 200 : 401,
      headers: { "cache-control": "no-store" },
      body: page({
        title: authenticated
          ? "Y Space QA — Authenticated Account"
          : "Y Space QA — Sign In Required",
        body: authenticated
          ? `<section class="card"><p class="ok" id="auth-state">Authenticated session</p><p>Cookie values are intentionally never rendered.</p></section>`
          : `<section class="card"><p class="bad" id="auth-state">Sign in required</p><p>Create cookies in the source browser, then import this exact origin into Y Space.</p></section>`,
      }),
    };
  },
  "/logout": () => ({
    status: 302,
    headers: {
      location: "/account",
      "set-cookie": [
        "ys_auth=; Path=/; HttpOnly; Max-Age=0",
        "ys_session=; Path=/; HttpOnly; Max-Age=0",
        "ys_preference=; Path=/; Max-Age=0",
      ],
      "cache-control": "no-store",
    },
    body: "",
  }),
};

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", `http://${host}:${port}`);
  const handler = routes[url.pathname];
  const result = handler
    ? handler({ request, url })
    : {
        status: 404,
        body: page({ title: "Y Space QA — Not Found", body: "<p>Unknown fixture route.</p>" }),
      };
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...result.headers,
  };
  response.writeHead(result.status, headers);
  response.end(result.body);
});

server.listen(port, host, () => {
  process.stdout.write(`Y Space QA fixture ready at http://${host}:${port}\n`);
});

function cookieValue(header, name) {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
