import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const host = process.env.YSPACE_QA_HOST?.trim() || "localhost";
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
      .status-list { display: grid; gap: 10px; list-style: none; margin: 16px 0 0; padding: 0; }
      .status-list li { border: 1px solid #27272a; border-radius: 8px; padding: 10px 12px; }
      .status-list strong { display: inline-block; min-width: 72px; }
      .status-list small { color: #a1a1aa; display: block; margin-top: 4px; }
      .ok { color: #67e8a5; }
      .bad { color: #fb7185; }
      .absent { color: #fbbf24; }
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
      <a href="/cookie-status">Cookie status</a>
      <a href="/account/cookie-status">Path cookie status</a>
      <a href="/source-login">Create source cookies</a>
      <a href="/logout">Clear fixture cookies</a>
    </nav>
    ${body}
    <script>${script}</script>
  </body>
</html>`;

const cookieDefinitions = [
  {
    id: "auth",
    name: "ys_auth",
    label: "Persistent authentication",
    expectedValue: sentinel,
    expectedFlags: "Secure · HttpOnly · SameSite=Lax · persistent",
    lifecycle: "Must remain present after Y Space relaunch.",
  },
  {
    id: "session",
    name: "ys_session",
    label: "Session authentication",
    expectedValue: sentinel,
    expectedFlags: "HttpOnly · SameSite=Strict · session-only",
    lifecycle: "Must be present before relaunch and absent afterward.",
  },
  {
    id: "preference",
    name: "ys_preference",
    label: "Persistent preference",
    expectedValue: "violet",
    expectedFlags: "SameSite=Lax · persistent",
    lifecycle: "Must remain present after Y Space relaunch.",
  },
  {
    id: "deep",
    name: "ys_deep",
    label: "Path-scoped authentication",
    expectedValue: sentinel,
    expectedFlags: "HttpOnly · Path=/account · persistent",
    lifecycle: "Must be absent here unless this page is under /account.",
  },
  {
    id: "host-prefix",
    name: "__Host-ys_prefix",
    label: "Host-prefix cookie",
    expectedValue: sentinel,
    expectedFlags: "Secure · HttpOnly · host-only · Path=/",
    lifecycle: "Must import without a Domain attribute.",
  },
  {
    id: "secure-prefix",
    name: "__Secure-ys_secure",
    label: "Secure-prefix cookie",
    expectedValue: sentinel,
    expectedFlags: "Secure · HttpOnly · SameSite=Lax",
    lifecycle: "Must retain the Secure prefix invariant.",
  },
  {
    id: "partitioned",
    name: "ys_partitioned",
    label: "Partitioned cookie",
    expectedValue: sentinel,
    expectedFlags: "Secure · SameSite=None · Partitioned",
    lifecycle: "Expected in the source browser and absent from Y Space after import.",
  },
  {
    id: "expired",
    name: "ys_expired",
    label: "Expired cookie",
    expectedValue: "gone",
    expectedFlags: "Max-Age=0",
    lifecycle: "Must always be absent.",
  },
];

function cookieSnapshot(request) {
  return cookieDefinitions.map(({ expectedValue, ...definition }) => ({
    ...definition,
    present: cookieValue(request.headers.cookie, definition.name) === expectedValue,
  }));
}

function cookieStatusMarkup(request) {
  const rows = cookieSnapshot(request)
    .map(
      (cookie) => `<li id="cookie-status-${cookie.id}" data-present="${cookie.present}">
        <strong class="${cookie.present ? "ok" : "absent"}">${cookie.present ? "Present" : "Absent"}</strong>
        ${escapeHtml(cookie.label)}
        <small>${escapeHtml(cookie.expectedFlags)} — ${escapeHtml(cookie.lifecycle)}</small>
      </li>`,
    )
    .join("");
  return `<section class="card">
    <p>Only value-free presence and expected flag metadata are shown. Cookie values are never rendered.</p>
    <ul class="status-list">${rows}</ul>
  </section>`;
}

function cookieStatusResponse(request, title) {
  return {
    status: 200,
    headers: { "cache-control": "no-store" },
    body: page({ title, body: cookieStatusMarkup(request) }),
  };
}

function cookieStatusJson(request) {
  return {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: JSON.stringify({ cookies: cookieSnapshot(request) }),
  };
}

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
  "/cookie-status": ({ request }) =>
    cookieStatusResponse(request, "Y Space QA — Root Cookie Status"),
  "/account/cookie-status": ({ request }) =>
    cookieStatusResponse(request, "Y Space QA — Account Path Cookie Status"),
  "/api/cookie-status": ({ request }) => cookieStatusJson(request),
  "/account/api/cookie-status": ({ request }) => cookieStatusJson(request),
  "/source-login": () => ({
    status: 302,
    headers: {
      location: "/account",
      "set-cookie": [
        `ys_auth=${sentinel}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
        `ys_session=${sentinel}; Path=/; HttpOnly; SameSite=Strict`,
        "ys_preference=violet; Path=/; SameSite=Lax; Max-Age=86400",
        `ys_deep=${sentinel}; Path=/account; HttpOnly; SameSite=Lax; Max-Age=86400`,
        `__Host-ys_prefix=${sentinel}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`,
        `__Secure-ys_secure=${sentinel}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
        `ys_partitioned=${sentinel}; Path=/; Secure; SameSite=None; Partitioned; Max-Age=86400`,
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
          ? `<section class="card"><p class="ok" id="auth-state">Authenticated session</p><p>Cookie values are intentionally never rendered.</p><p><a href="/account/cookie-status">Inspect value-free cookie status for this path.</a></p></section>`
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
        "ys_deep=; Path=/account; HttpOnly; Max-Age=0",
        "__Host-ys_prefix=; Path=/; HttpOnly; Secure; Max-Age=0",
        "__Secure-ys_secure=; Path=/; HttpOnly; Secure; Max-Age=0",
        "ys_partitioned=; Path=/; Secure; SameSite=None; Partitioned; Max-Age=0",
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
