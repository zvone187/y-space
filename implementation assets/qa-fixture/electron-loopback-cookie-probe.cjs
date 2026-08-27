const { createServer } = require("node:http");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { app, BrowserWindow, session } = require("electron");

const probeDir = mkdtempSync(join(tmpdir(), "y-space-electron-cookie-probe-"));
app.commandLine.appendSwitch("use-mock-keychain");
app.setPath("userData", join(probeDir, "userData"));

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "localhost", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Probe server did not bind.");
  return address.port;
}

app
  .whenReady()
  .then(async () => {
    let requestCarriedCookie = false;
    const server = createServer((request, response) => {
      requestCarriedCookie = /(?:^|;\s*)ys_probe=/u.test(request.headers.cookie || "");
      response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      response.end("ok");
    });
    const port = await listen(server);
    const targetUrl = `http://localhost:${port}/`;
    const probeSession = session.fromPartition("persist:y-space-cookie-probe");
    let setSucceeded = false;
    let storedForHttpUrl = false;
    try {
      await probeSession.cookies.set({
        url: targetUrl,
        name: "ys_probe",
        value: "probe-value-never-printed",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
      });
      setSucceeded = true;
      const stored = await probeSession.cookies.get({ url: targetUrl, name: "ys_probe" });
      storedForHttpUrl = stored.some(
        (cookie) => cookie.secure === true && cookie.httpOnly === true,
      );
      const window = new BrowserWindow({ show: false, webPreferences: { session: probeSession } });
      await window.loadURL(targetUrl);
      window.destroy();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    process.stdout.write(
      `${JSON.stringify({
        electron: process.versions.electron,
        setSucceeded,
        storedForHttpUrl,
        requestCarriedCookie,
      })}\n`,
    );
    rmSync(probeDir, { recursive: true, force: true });
    app.quit();
  })
  .catch((error) => {
    process.stderr.write(
      `probe_failed:${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    try {
      rmSync(probeDir, { recursive: true, force: true });
    } catch {}
    app.exit(1);
  });
