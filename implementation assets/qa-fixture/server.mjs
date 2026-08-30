import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const host = process.env.YSPACE_QA_HOST?.trim() || "localhost";
const requestedPort = Number.parseInt(process.env.YSPACE_QA_PORT || "41739", 10);
const port = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 41739;
const sentinel =
  process.env.YSPACE_QA_COOKIE_SENTINEL?.trim() || `ys_${randomBytes(24).toString("hex")}`;

const page = ({ title, body, script = "", style = "", bodyClass = "" }) => `<!doctype html>
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
      button, input, select { border: 1px solid #3f3f46; border-radius: 8px; background: #18181b; color: inherit; padding: 10px 12px; }
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
      ${style}
    </style>
  </head>
  <body class="${escapeHtml(bodyClass)}">
    <h1>${escapeHtml(title)}</h1>
    <nav>
      <a href="/alpha">Alpha</a>
      <a href="/beta">Beta</a>
      <a href="/gamma">Gamma</a>
      <a href="/cursor-a">Cursor A</a>
      <a href="/cursor-b">Cursor B</a>
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
  "/cursor": ({ url, cursorFixture }) => {
    const requestedFixture = url.searchParams.get("fixture")?.trim().toUpperCase();
    const fixtureLetter =
      cursorFixture === "A" || cursorFixture === "B"
        ? cursorFixture
        : requestedFixture === "B"
          ? "B"
          : "A";
    const fixtureId = `cursor-${fixtureLetter.toLowerCase()}`;
    const fixtureTitle = `Y Space QA — Cursor ${fixtureLetter} Controls`;
    return {
      status: 200,
      headers: { "cache-control": "no-store" },
      body: page({
        title: fixtureTitle,
        bodyClass: "cursor-page",
        style: `
        :root { color-scheme: light; }
        body.cursor-page {
          max-width: none;
          margin: 0;
          padding: 24px clamp(20px, 5vw, 72px) 80px;
          background: #f8fafc;
          color: #172033;
        }
        .cursor-page nav {
          margin: 18px 0 28px;
          padding-bottom: 18px;
          border-bottom: 1px solid #d7deea;
        }
        .cursor-page a { color: #174ea6; }
        .cursor-page button,
        .cursor-page input,
        .cursor-page select {
          border-color: #94a3b8;
          background: #ffffff;
          color: #172033;
          font: inherit;
        }
        .cursor-page button:focus-visible,
        .cursor-page input:focus-visible,
        .cursor-page select:focus-visible,
        .cursor-page a:focus-visible,
        .cursor-page [tabindex]:focus-visible {
          outline: 3px solid #2563eb;
          outline-offset: 4px;
        }
        .cursor-intro { max-width: 820px; color: #475569; }
        .cursor-fixture-badge {
          display: inline-flex;
          margin: 4px 0 0;
          padding: 7px 11px;
          border: 1px solid #fdba74;
          border-radius: 999px;
          background: #fff7ed;
          color: #9a3412;
          font-weight: 800;
        }
        .cursor-layout {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(300px, 390px);
          gap: clamp(32px, 6vw, 88px);
          align-items: start;
          margin-top: 36px;
        }
        .cursor-controls { min-width: 0; }
        .cursor-control {
          min-height: 180px;
          padding: 28px;
          border: 1px solid #cbd5e1;
          border-radius: 16px;
          background: #ffffff;
          box-shadow: 0 10px 28px rgba(30, 41, 59, 0.08);
        }
        .cursor-control + .cursor-control { margin-top: 112px; }
        .cursor-control h2 { margin: 0 0 12px; font-size: 1.15rem; }
        .cursor-control p { color: #64748b; }
        .cursor-control label { max-width: 520px; font-weight: 650; }
        .cursor-control input[type="text"],
        .cursor-control select { min-height: 46px; width: min(100%, 520px); }
        .cursor-checkbox-row {
          display: flex;
          grid-template-columns: none;
          align-items: center;
          gap: 12px;
        }
        .cursor-checkbox-row input { width: 22px; height: 22px; }
        .cursor-hover-target {
          display: grid;
          place-items: center;
          min-height: 112px;
          border: 2px dashed #2563eb;
          border-radius: 12px;
          background: #eff6ff;
          color: #1e40af;
          font-weight: 750;
        }
        .cursor-hover-target:hover,
        .cursor-hover-target:focus { background: #dbeafe; }
        .cursor-button-row { display: flex; flex-wrap: wrap; gap: 18px; align-items: center; }
        .cursor-wheel-region {
          height: 280px;
          overflow: auto;
          overscroll-behavior: contain;
          border: 2px solid #2563eb;
          border-radius: 12px;
          background: #eff6ff;
          scroll-behavior: auto;
        }
        .cursor-wheel-content {
          display: flex;
          min-height: 1120px;
          flex-direction: column;
          justify-content: space-between;
          padding: 24px;
          background: linear-gradient(#eff6ff, #ffffff, #dbeafe);
        }
        .cursor-wheel-marker {
          display: block;
          padding: 12px;
          border: 1px solid #93c5fd;
          border-radius: 10px;
          background: #ffffff;
          color: #1e40af;
          font-weight: 750;
        }
        .cursor-adversarial-grid { display: grid; gap: 24px; }
        .cursor-adversarial-case {
          padding: 18px;
          border: 1px solid #cbd5e1;
          border-radius: 12px;
          background: #f8fafc;
        }
        .cursor-adversarial-case h3 { margin: 0 0 8px; font-size: 1rem; }
        .cursor-stage {
          position: relative;
          min-height: 170px;
          margin-top: 14px;
          overflow: hidden;
          border: 1px dashed #94a3b8;
          border-radius: 10px;
          background: #ffffff;
        }
        .cursor-stage button { position: absolute; left: 18px; top: 18px; }
        #cursor-moving-target.is-moved { left: calc(100% - 190px); top: 96px; }
        #cursor-occluded-target { left: 50%; top: 50%; transform: translate(-50%, -50%); }
        #cursor-occluder {
          position: absolute;
          z-index: 2;
          left: 50%;
          top: 50%;
          display: grid;
          width: 230px;
          height: 88px;
          place-items: center;
          transform: translate(-50%, -50%);
          border: 2px solid #dc2626;
          border-radius: 12px;
          background: rgba(254, 226, 226, 0.96);
          color: #991b1b;
          font-weight: 800;
          pointer-events: auto;
        }
        #cursor-disabled-target { opacity: 0.58; }
        #cursor-invisible-ancestor { opacity: 0; }
        #cursor-interactive-parent {
          position: relative;
          display: grid;
          min-height: 70px;
          place-items: center;
          border: 1px solid #94a3b8;
          border-radius: 10px;
          background: #ffffff;
        }
        #cursor-interactive-child {
          position: absolute;
          inset: 0;
          display: grid;
          place-items: center;
        }
        #cursor-multiline-input {
          min-height: 120px;
          width: min(100%, 520px);
          resize: vertical;
        }
        .cursor-case-state { margin: 12px 0 0; color: #475569; font-weight: 700; }
        .cursor-ledger-panel {
          position: sticky;
          top: 24px;
          padding: 22px;
          border: 1px solid #a7b4c8;
          border-radius: 16px;
          background: #ffffff;
          box-shadow: 0 12px 32px rgba(30, 41, 59, 0.12);
        }
        .cursor-ledger-panel h2 { margin: 0 0 8px; }
        .cursor-ledger-panel p { color: #64748b; font-size: 0.9rem; }
        .cursor-ledger-fields {
          display: grid;
          grid-template-columns: repeat(7, minmax(0, 1fr));
          gap: 4px;
          margin: 18px 0 8px;
          font-size: 0.68rem;
          font-weight: 800;
          color: #475569;
          text-transform: uppercase;
        }
        .cursor-event-ledger {
          display: grid;
          gap: 8px;
          max-height: 520px;
          margin: 0;
          padding: 0;
          overflow: auto;
          list-style: none;
        }
        .cursor-event-ledger li {
          padding: 10px;
          border: 1px solid #e2e8f0;
          border-radius: 10px;
          background: #f8fafc;
          color: #334155;
          font: 0.75rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
          overflow-wrap: anywhere;
        }
        @media (max-width: 880px) {
          .cursor-layout { grid-template-columns: 1fr; }
          .cursor-ledger-panel { position: static; grid-row: 1; }
          .cursor-control + .cursor-control { margin-top: 72px; }
          .cursor-stage { min-height: 210px; }
          #cursor-moving-target.is-moved { left: 18px; top: 130px; }
        }
      `,
        body: `<main
          id="cursor-fixture"
          data-fixture-id="${fixtureId}"
          data-cursor-spacing="wide"
          data-value-policy="never-read-control-values"
          data-missing-selector="#cursor-never-present"
        >
          <p id="cursor-fixture-identity" class="cursor-fixture-badge">
            Immutable fixture identity: Cursor ${fixtureLetter}
          </p>
          <p class="cursor-intro">
            Deterministic, widely separated controls for trusted visible-cursor QA. The ledger
            records event provenance and geometry, but never reads or displays text, checkbox, or
            selected-option values.
          </p>
          <div class="cursor-layout">
            <section class="cursor-controls" aria-label="Cursor interaction controls">
              <section class="cursor-control" aria-labelledby="cursor-hover-heading">
                <h2 id="cursor-hover-heading">1. Hover</h2>
                <p>Trusted movement should reach this target without a click.</p>
                <div id="cursor-hover-target" class="cursor-hover-target" tabindex="0">
                  Hover this target
                </div>
              </section>

              <section class="cursor-control" aria-labelledby="cursor-focus-heading">
                <h2 id="cursor-focus-heading">2. Focus</h2>
                <p>Focus this dedicated target without activating another control.</p>
                <button id="cursor-focus-target" type="button">Focus-only target</button>
              </section>

              <section class="cursor-control" aria-labelledby="cursor-input-heading">
                <h2 id="cursor-input-heading">3. Fill and type</h2>
                <label for="cursor-text-input">
                  Fixture text (content is never recorded)
                  <input id="cursor-text-input" type="text" autocomplete="off" spellcheck="false" />
                </label>
                <label for="cursor-multiline-input">
                  Multiline append target (content is never recorded)
                  <textarea id="cursor-multiline-input" autocomplete="off" spellcheck="false">first line\nsecond line</textarea>
                </label>
              </section>

              <section class="cursor-control" aria-labelledby="cursor-press-heading">
                <h2 id="cursor-press-heading">4. Targeted key press</h2>
                <p>Press Enter, Space, or an arrow key while this button is focused.</p>
                <button id="cursor-press-target" type="button">Keyboard target</button>
              </section>

              <section class="cursor-control" aria-labelledby="cursor-checkbox-heading">
                <h2 id="cursor-checkbox-heading">5. Check and uncheck</h2>
                <label class="cursor-checkbox-row" for="cursor-checkbox">
                  <input id="cursor-checkbox" type="checkbox" />
                  Toggle the deterministic checkbox in both directions
                </label>
              </section>

              <section class="cursor-control" aria-labelledby="cursor-select-heading">
                <h2 id="cursor-select-heading">6. Select</h2>
                <label for="cursor-select">
                  Choose a fixture option (the choice is never recorded)
                  <select id="cursor-select">
                    <option>First option</option>
                    <option>Second option</option>
                    <option>Third option</option>
                  </select>
                </label>
              </section>

              <section class="cursor-control" aria-labelledby="cursor-click-heading">
                <h2 id="cursor-click-heading">7. Click and double-click</h2>
                <p>These separate targets expose trusted click sequences without form state.</p>
                <div class="cursor-button-row">
                  <button id="cursor-click-button" type="button">Single-click target</button>
                  <button id="cursor-double-click-button" type="button">Double-click target</button>
                </div>
              </section>

              <section class="cursor-control" aria-labelledby="cursor-wheel-heading">
                <h2 id="cursor-wheel-heading">8. Nested wheel region</h2>
                <p>Move into this bounded scroller, then use a trusted wheel in either direction.</p>
                <div id="cursor-wheel-region" class="cursor-wheel-region" tabindex="0">
                  <div class="cursor-wheel-content">
                    <span id="cursor-wheel-start" class="cursor-wheel-marker">Nested scroll start</span>
                    <span id="cursor-wheel-end" class="cursor-wheel-marker">Nested scroll end</span>
                  </div>
                </div>
              </section>

              <section class="cursor-control" aria-labelledby="cursor-adversarial-heading">
                <h2 id="cursor-adversarial-heading">9. Adversarial targets</h2>
                <p>These controls distinguish a real pointer path from decorative or stale input.</p>
                <div class="cursor-adversarial-grid">
                  <article
                    class="cursor-adversarial-case"
                    data-adversarial-behavior="moves-on-trusted-pointerenter"
                  >
                    <h3>Moves on trusted pointer entry</h3>
                    <div id="cursor-moving-stage" class="cursor-stage">
                      <button id="cursor-moving-target" type="button">Moving target</button>
                    </div>
                    <p id="cursor-moving-state" class="cursor-case-state">Moved: no</p>
                  </article>

                  <article
                    class="cursor-adversarial-case"
                    data-adversarial-behavior="occluded"
                  >
                    <h3>Occluded target</h3>
                    <div id="cursor-occluded-stage" class="cursor-stage">
                      <button id="cursor-occluded-target" type="button">Covered target</button>
                      <div id="cursor-occluder" tabindex="0">Occluder receives real input</div>
                    </div>
                  </article>

                  <article
                    class="cursor-adversarial-case"
                    data-adversarial-behavior="disabled"
                  >
                    <h3>Disabled target</h3>
                    <button id="cursor-disabled-target" type="button" disabled>Disabled target</button>
                  </article>

                  <article
                    class="cursor-adversarial-case"
                    data-adversarial-behavior="non-editable-text-target"
                  >
                    <h3>Non-editable text target</h3>
                    <button id="cursor-noneditable-target" type="button">Must not be clicked by fill</button>
                  </article>

                  <article
                    class="cursor-adversarial-case"
                    data-adversarial-behavior="radio-cannot-uncheck"
                  >
                    <h3>Checked radio</h3>
                    <label class="cursor-checkbox-row" for="cursor-radio-target">
                      <input id="cursor-radio-target" type="radio" name="cursor-radio" checked />
                      Uncheck must fail without clicking
                    </label>
                  </article>

                  <article
                    class="cursor-adversarial-case"
                    data-adversarial-behavior="invisible-ancestor"
                  >
                    <h3>Invisible ancestor</h3>
                    <div id="cursor-invisible-ancestor">
                      <button id="cursor-invisible-target" type="button">Invisible target</button>
                    </div>
                  </article>

                  <article
                    class="cursor-adversarial-case"
                    data-adversarial-behavior="interactive-descendant"
                  >
                    <h3>Interactive descendant</h3>
                    <div id="cursor-interactive-parent" tabindex="0">
                      Parent target
                      <a id="cursor-interactive-child" href="#interactive-child-activated">
                        Interactive child covers parent center
                      </a>
                    </div>
                  </article>

                  <article
                    class="cursor-adversarial-case"
                    data-adversarial-behavior="select-reorders-on-focus"
                  >
                    <h3>Select reorders on focus</h3>
                    <select id="cursor-reordering-select">
                      <option value="alpha">Alpha</option>
                      <option value="beta">Beta</option>
                      <option value="gamma">Gamma</option>
                    </select>
                    <p id="cursor-reordering-state" class="cursor-case-state">Reordered: no</p>
                  </article>

                  <article
                    class="cursor-adversarial-case"
                    data-adversarial-behavior="removed-on-trusted-pointerenter"
                  >
                    <h3>Removed on trusted pointer entry</h3>
                    <div id="cursor-removed-stage" class="cursor-stage">
                      <button id="cursor-removed-target" type="button">Removed target</button>
                    </div>
                    <p id="cursor-removed-state" class="cursor-case-state">Removed: no</p>
                  </article>

                  <article class="cursor-adversarial-case">
                    <h3>Missing selector</h3>
                    <p>The selector <code>#cursor-never-present</code> intentionally has no element.</p>
                  </article>
                </div>
              </section>
            </section>

            <aside class="cursor-ledger-panel" aria-labelledby="cursor-ledger-heading">
              <h2 id="cursor-ledger-heading">Value-free trusted-event ledger</h2>
              <p>
                Latest first, capped at 48 entries. Sequence, provenance, geometry, and safe event
                categories are recorded; control contents and choices are never read.
              </p>
              <p id="cursor-event-count" role="status">Observed events: 0</p>
              <div class="cursor-ledger-fields" aria-hidden="true">
                <span>Sequence</span><span>Event type</span><span>Target</span><span>Trusted</span>
                <span>Coordinates</span><span>Details</span><span>Result</span>
              </div>
              <ol
                id="cursor-event-ledger"
                class="cursor-event-ledger"
                data-ledger-format="sequence-event-target-trusted-coordinates-details-result"
                data-ledger-cap="48"
                aria-live="polite"
                aria-relevant="additions"
              >
                <li id="cursor-ledger-empty">No events recorded · Sequence: 0</li>
              </ol>
            </aside>
          </div>
        </main>`,
        script: `
          (() => {
            const ledger = document.querySelector("#cursor-event-ledger");
            const eventCount = document.querySelector("#cursor-event-count");
            const spoofedScreenshotStyle = document.createElement("div");
            spoofedScreenshotStyle.id = "__y_space_screenshot_cursor_hide__";
            spoofedScreenshotStyle.dataset.fixtureOwned = "true";
            document.body.appendChild(spoofedScreenshotStyle);
            const observedTargetIds = new Set([
              "cursor-hover-target",
              "cursor-focus-target",
              "cursor-text-input",
              "cursor-multiline-input",
              "cursor-press-target",
              "cursor-checkbox",
              "cursor-select",
              "cursor-click-button",
              "cursor-double-click-button",
              "cursor-wheel-region",
              "cursor-wheel-start",
              "cursor-wheel-end",
              "cursor-moving-target",
              "cursor-occluded-target",
              "cursor-occluder",
              "cursor-disabled-target",
              "cursor-noneditable-target",
              "cursor-radio-target",
              "cursor-invisible-target",
              "cursor-interactive-parent",
              "cursor-interactive-child",
              "cursor-reordering-select",
              "cursor-removed-target",
            ]);
            const observedEventTypes = [
              "pointerover",
              "pointerenter",
              "pointermove",
              "pointerdown",
              "pointerup",
              "mousedown",
              "mouseup",
              "click",
              "dblclick",
              "wheel",
              "focusin",
              "keydown",
              "keyup",
              "beforeinput",
              "input",
              "change",
              "scroll",
            ];
            const namedKeys = new Set([
              "Enter",
              "Tab",
              "Escape",
              "Backspace",
              "Delete",
              "ArrowUp",
              "ArrowDown",
              "ArrowLeft",
              "ArrowRight",
              "Home",
              "End",
              "PageUp",
              "PageDown",
              " ",
            ]);
            let sequence = 0;

            const eventTarget = (event) => {
              const node = event.target;
              if (!(node instanceof Element)) return null;
              const target = node.closest("[id]");
              return target instanceof HTMLElement && observedTargetIds.has(target.id) ? target : null;
            };

            const safeKeyCategory = (event) => {
              if (!(event instanceof KeyboardEvent)) return "none";
              if (namedKeys.has(event.key)) return event.key === " " ? "Space" : event.key;
              return event.key.length === 1 ? "printable" : "other";
            };

            const safeDetails = (event, target) => {
              const time = Math.max(0, Math.round(event.timeStamp));
              if (event instanceof WheelEvent) {
                return "wheel=" + Math.round(event.deltaX) + "," + Math.round(event.deltaY) + " · t=" + time + "ms";
              }
              if (event instanceof PointerEvent) {
                return "pointer=" + event.pointerType + " · button=" + event.button + " · buttons=" + event.buttons + " · t=" + time + "ms";
              }
              if (event instanceof MouseEvent) {
                return "button=" + event.button + " · buttons=" + event.buttons + " · detail=" + event.detail + " · t=" + time + "ms";
              }
              if (event instanceof KeyboardEvent) {
                return "key=" + safeKeyCategory(event) + " · repeat=" + (event.repeat ? "yes" : "no") + " · t=" + time + "ms";
              }
              if (event instanceof InputEvent) {
                return "inputType=" + (event.inputType || "unspecified") + " · t=" + time + "ms";
              }
              if (event.type === "scroll") {
                return "scrollTop=" + Math.max(0, Math.round(target.scrollTop)) + " · t=" + time + "ms";
              }
              return "t=" + time + "ms";
            };

            const record = (event) => {
              const target = eventTarget(event);
              if (!target) return;
              sequence += 1;
              document.querySelector("#cursor-ledger-empty")?.remove();
              const hasCoordinates = Number.isFinite(event.clientX) && Number.isFinite(event.clientY);
              const coordinates = hasCoordinates
                ? Math.round(event.clientX) + "," + Math.round(event.clientY)
                : "n/a";
              const trusted = event.isTrusted === true;
              const entry = document.createElement("li");
              entry.dataset.sequence = String(sequence);
              entry.dataset.eventType = event.type;
              entry.dataset.targetId = target.id;
              entry.dataset.trusted = trusted ? "true" : "false";
              entry.textContent =
                "Sequence: " + sequence +
                " · Event type: " + event.type +
                " · Target: " + target.id +
                " · Trusted: " + (trusted ? "yes" : "no") +
                " · Coordinates: " + coordinates +
                " · Details: " + safeDetails(event, target) +
                " · Result: observed";
              ledger.prepend(entry);
              while (ledger.children.length > 48) ledger.lastElementChild?.remove();
              eventCount.textContent = "Observed events: " + sequence;
            };

            for (const eventType of observedEventTypes) {
              document.addEventListener(eventType, record, true);
            }

            const movingTarget = document.querySelector("#cursor-moving-target");
            movingTarget.addEventListener("pointerenter", (event) => {
              if (!event.isTrusted || movingTarget.dataset.moved === "true") return;
              movingTarget.dataset.moved = "true";
              movingTarget.classList.add("is-moved");
              document.querySelector("#cursor-moving-state").textContent = "Moved: yes";
            });

            const removedTarget = document.querySelector("#cursor-removed-target");
            removedTarget.addEventListener("pointerenter", (event) => {
              if (!event.isTrusted || !removedTarget.isConnected) return;
              document.querySelector("#cursor-removed-state").textContent = "Removed: yes";
              removedTarget.remove();
            });

            const reorderingSelect = document.querySelector("#cursor-reordering-select");
            reorderingSelect.addEventListener("focus", () => {
              if (reorderingSelect.dataset.reordered === "true") return;
              reorderingSelect.dataset.reordered = "true";
              reorderingSelect.prepend(reorderingSelect.options[2]);
              document.querySelector("#cursor-reordering-state").textContent = "Reordered: yes";
            });
          })();
        `,
      }),
    };
  },
  "/cursor-a": (context) => routes["/cursor"]({ ...context, cursorFixture: "A" }),
  "/cursor-b": (context) => routes["/cursor"]({ ...context, cursorFixture: "B" }),
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
