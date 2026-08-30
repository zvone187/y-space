import { spawn } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";

async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  server.close();
  await once(server, "close");
  return address.port;
}

function get(port, path, cookie) {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        headers: cookie ? { cookie } : undefined,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode, headers: response.headers, body }),
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

function waitUntilReady(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("fixture start timed out")), 5_000);
    child.once("exit", (code) => reject(new Error(`fixture exited early (${code ?? "signal"})`)));
    child.stdout.on("data", (chunk) => {
      if (!String(chunk).includes("Y Space QA fixture ready")) return;
      clearTimeout(timeout);
      resolve();
    });
  });
}

void test("fixture exposes value-free cookie status and the full secure cookie matrix", async (t) => {
  const port = await unusedPort();
  const sentinel = "qa-fixture-test-only-sentinel";
  const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
    env: {
      ...process.env,
      YSPACE_QA_HOST: "127.0.0.1",
      YSPACE_QA_PORT: String(port),
      YSPACE_QA_COOKIE_SENTINEL: sentinel,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    if (child.exitCode === null) await once(child, "exit");
  });
  await waitUntilReady(child);

  const login = await get(port, "/source-login");
  assert.equal(login.status, 302);
  assert.equal(login.headers["set-cookie"]?.length, 8);
  assert(
    login.headers["set-cookie"]?.some(
      (header) => header.startsWith("ys_auth=") && header.includes("Secure"),
    ),
  );
  assert(
    login.headers["set-cookie"]?.some(
      (header) => header.startsWith("ys_partitioned=") && header.includes("Partitioned"),
    ),
  );
  assert(!login.body.includes(sentinel));

  const accountCookie = [
    `ys_auth=${sentinel}`,
    `ys_session=${sentinel}`,
    "ys_preference=violet",
    `ys_deep=${sentinel}`,
    `__Host-ys_prefix=${sentinel}`,
    `__Secure-ys_secure=${sentinel}`,
    `ys_partitioned=${sentinel}`,
  ].join("; ");
  const accountStatus = await get(port, "/account/api/cookie-status", accountCookie);
  assert.equal(accountStatus.status, 200);
  assert(!accountStatus.body.includes(sentinel));
  const parsed = JSON.parse(accountStatus.body);
  assert.deepEqual(
    Object.fromEntries(parsed.cookies.map((cookie) => [cookie.id, cookie.present])),
    {
      auth: true,
      session: true,
      preference: true,
      deep: true,
      "host-prefix": true,
      "secure-prefix": true,
      partitioned: true,
      expired: false,
    },
  );

  const statusPage = await get(port, "/account/cookie-status", accountCookie);
  assert(!statusPage.body.includes(sentinel));
  assert(statusPage.body.includes('id="cookie-status-session" data-present="true"'));
  assert(statusPage.body.includes("Secure · HttpOnly · SameSite=Lax · persistent"));
});

void test("fixture exposes deterministic cursor controls and a value-free event ledger", async (t) => {
  const port = await unusedPort();
  const sentinel = "cursor-route-must-never-render-this-sentinel";
  const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
    env: {
      ...process.env,
      YSPACE_QA_HOST: "127.0.0.1",
      YSPACE_QA_PORT: String(port),
      YSPACE_QA_COOKIE_SENTINEL: sentinel,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    if (child.exitCode === null) await once(child, "exit");
  });
  await waitUntilReady(child);

  const cursor = await get(port, "/cursor");
  const cursorQueryB = await get(port, "/cursor?fixture=B");
  const cursorA = await get(port, "/cursor-a?fixture=B");
  const cursorB = await get(port, "/cursor-b?fixture=A");
  assert.equal(cursor.status, 200);
  assert.equal(cursorQueryB.status, 200);
  assert.equal(cursorA.status, 200);
  assert.equal(cursorB.status, 200);
  assert(cursor.body.includes("Y Space QA — Cursor A Controls"));
  assert(cursorQueryB.body.includes("Y Space QA — Cursor B Controls"));
  assert(cursorQueryB.body.includes('data-fixture-id="cursor-b"'));
  assert(cursorA.body.includes("Y Space QA — Cursor A Controls"));
  assert(cursorA.body.includes('data-fixture-id="cursor-a"'));
  assert(!cursorA.body.includes('data-fixture-id="cursor-b"'));
  assert(cursorB.body.includes("Y Space QA — Cursor B Controls"));
  assert(cursorB.body.includes('data-fixture-id="cursor-b"'));
  assert(!cursorB.body.includes('data-fixture-id="cursor-a"'));
  assert(cursor.body.includes('class="cursor-page"'));
  assert(cursor.body.includes('data-cursor-spacing="wide"'));
  assert(cursor.body.includes('data-value-policy="never-read-control-values"'));
  assert(cursor.body.includes('data-missing-selector="#cursor-never-present"'));
  assert(!cursor.body.includes('id="cursor-never-present"'));
  for (const id of [
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
    "cursor-occluded-stage",
    "cursor-occluded-target",
    "cursor-occluder",
    "cursor-disabled-target",
    "cursor-noneditable-target",
    "cursor-radio-target",
    "cursor-invisible-ancestor",
    "cursor-invisible-target",
    "cursor-interactive-parent",
    "cursor-interactive-child",
    "cursor-reordering-select",
    "cursor-reordering-state",
    "cursor-removed-target",
    "cursor-removed-state",
    "cursor-event-count",
    "cursor-event-ledger",
  ]) {
    assert(cursor.body.includes(`id="${id}"`), `missing cursor fixture marker ${id}`);
  }
  assert(
    cursor.body.includes(
      'data-ledger-format="sequence-event-target-trusted-coordinates-details-result"',
    ),
  );
  assert(cursor.body.includes('data-ledger-cap="48"'));
  assert(cursor.body.includes('data-adversarial-behavior="moves-on-trusted-pointerenter"'));
  assert(cursor.body.includes('data-adversarial-behavior="removed-on-trusted-pointerenter"'));
  assert(cursor.body.includes('data-adversarial-behavior="occluded"'));
  assert(cursor.body.includes('data-adversarial-behavior="disabled"'));
  assert(cursor.body.includes('data-adversarial-behavior="non-editable-text-target"'));
  assert(cursor.body.includes('data-adversarial-behavior="radio-cannot-uncheck"'));
  assert(cursor.body.includes('data-adversarial-behavior="invisible-ancestor"'));
  assert(cursor.body.includes('data-adversarial-behavior="interactive-descendant"'));
  assert(cursor.body.includes('data-adversarial-behavior="select-reorders-on-focus"'));
  assert(cursor.body.includes('spoofedScreenshotStyle.id = "__y_space_screenshot_cursor_hide__"'));
  assert(cursor.body.includes("Sequence"));
  assert(cursor.body.includes("Event type"));
  assert(cursor.body.includes("Target"));
  assert(cursor.body.includes("Trusted"));
  assert(cursor.body.includes("Coordinates"));
  assert(cursor.body.includes("Details"));
  assert(cursor.body.includes("Result"));
  assert(cursor.body.includes("event.isTrusted"));
  for (const eventType of [
    "pointermove",
    "pointerdown",
    "pointerup",
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
  ]) {
    assert(cursor.body.includes(`"${eventType}"`), `missing observed event ${eventType}`);
  }
  const embeddedScript = cursor.body.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert(embeddedScript, "cursor fixture script missing");
  assert.doesNotThrow(() => new Script(embeddedScript));
  assert(!cursor.body.includes(sentinel));
  assert(!cursor.body.includes("event.target.value"));
  assert(!cursor.body.includes("event.currentTarget.value"));
  assert(!cursor.body.includes(".checked"));
  assert(!cursor.body.includes("selectedIndex"));
  assert(!cursor.body.includes("event.data"));
  assert(!cursor.body.includes("FormData"));
  assert(!cursor.body.includes("localStorage"));
  assert(!cursor.body.includes("sessionStorage"));
  assert(!cursor.body.includes("fetch("));
  assert(!cursor.body.includes("<script src="));
});
