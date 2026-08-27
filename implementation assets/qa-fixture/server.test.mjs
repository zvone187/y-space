import { spawn } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
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
