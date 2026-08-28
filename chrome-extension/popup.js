const pill = document.getElementById("pill");
const statusText = document.getElementById("statusText");
const description = document.getElementById("description");
const version = document.getElementById("version");
const profileForm = document.getElementById("profileForm");
const profileLabel = document.getElementById("profileLabel");
const pairingForm = document.getElementById("pairingForm");
const pairingCode = document.getElementById("pairingCode");
const grantPanel = document.getElementById("grantPanel");
const origins = document.getElementById("origins");
const grantButton = document.getElementById("grantButton");
const forgetButton = document.getElementById("forgetButton");
const error = document.getElementById("error");

let latestStatus = null;

function setError(message) {
  error.textContent = message || "";
  error.hidden = !message;
}

function render(status) {
  if (!status) return;
  latestStatus = status;
  pill.className = "pill";
  pairingForm.hidden = !status.pairingAvailable || status.paired;
  grantPanel.hidden = !status.pendingOrigins?.length;
  forgetButton.hidden = !status.paired;
  if (status.pendingOrigins?.length) origins.textContent = status.pendingOrigins.join("\n");
  if (document.activeElement !== profileLabel) profileLabel.value = status.profileLabel || "";

  if (status.connected) {
    pill.classList.add("on");
    statusText.textContent = "Connected";
    description.textContent =
      "Ready to import cookies into Y Space when you approve a requested site.";
  } else if (status.pairingAvailable && !status.paired) {
    pill.classList.add("idle");
    statusText.textContent = "Pairing requested";
    description.textContent = "Enter the eight-digit code shown in Y Space.";
  } else if (status.connecting) {
    pill.classList.add("idle");
    statusText.textContent = "Connecting…";
    description.textContent = "Looking for Y Space on this computer.";
  } else if (status.paired) {
    pill.classList.add("idle");
    statusText.textContent = "Waiting for Y Space";
    description.textContent = "Your pairing is saved. Open Y Space to reconnect.";
  } else {
    pill.classList.add("off");
    statusText.textContent = "Not paired";
    description.textContent = "Start cookie import in Y Space to receive a pairing request.";
  }
  version.textContent = status.version ? `Version ${status.version}` : "";
  if (status.lastError) setError(status.lastError);
}

async function refresh() {
  try {
    render(await chrome.runtime.sendMessage({ cmd: "getStatus" }));
  } catch {
    setError("The extension worker is unavailable. Reopen this popup to retry.");
  }
}

async function submitPairing() {
  setError("");
  const code = pairingCode.value.trim();
  if (!/^\d{8}$/u.test(code)) {
    setError("Enter all eight digits from Y Space.");
    return;
  }
  const result = await chrome.runtime.sendMessage({ cmd: "pair", code });
  if (!result?.ok) setError(result?.error || "Pairing failed.");
  pairingCode.value = "";
  await refresh();
}

async function saveProfileLabel() {
  setError("");
  const label = profileLabel.value.trim();
  if (!label) {
    setError("Enter a name for this browser profile.");
    return;
  }
  const result = await chrome.runtime.sendMessage({ cmd: "setProfileLabel", label });
  if (!result?.ok) setError(result?.error || "Unable to save the profile name.");
  await refresh();
}

async function grantPendingOrigins() {
  setError("");
  const requestedOrigins = latestStatus?.pendingOrigins || [];
  if (!requestedOrigins.length) return;
  let granted = false;
  try {
    // Keep this API call in the click handler so Chrome can verify a real user gesture.
    granted = await chrome.permissions.request({ origins: requestedOrigins });
  } catch {
    granted = false;
  }
  await chrome.runtime.sendMessage({
    cmd: "permissionResult",
    requestId: latestStatus?.pendingRequestId,
    granted,
    origins: requestedOrigins,
  });
  if (!granted) setError("Site access was not granted; no cookies were imported.");
  await refresh();
}

async function forgetPairing() {
  setError("");
  await chrome.runtime.sendMessage({ cmd: "forgetPairing" });
  await refresh();
}

pairingForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitPairing();
});

profileForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveProfileLabel();
});

grantButton.addEventListener("click", () => {
  void grantPendingOrigins();
});

forgetButton.addEventListener("click", () => {
  void forgetPairing();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.event === "status") render(message.status);
});

void refresh();
