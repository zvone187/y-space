# Y Space Cookie Import

This Manifest V3 extension imports cookies from a Chromium browser profile into the Y Space embedded browser.

## Security boundary

- Pairing uses an eight-digit, five-minute code to derive a proof key. Neither that code nor the long-lived token is sent in plaintext; both sides prove the pairing, and Y Space persists only the token's SHA-256 hash.
- The extension declares HTTP(S) access as optional. Chrome prompts for the exact origins requested by Y Space from a real popup click. Only origins newly granted for that request are removed after commit, cancellation, timeout, disconnect, or worker restart; permissions that existed before the request are preserved.
- Preview responses contain domain/count metadata only. Raw values are read again and transmitted only after the user commits an import.
- Raw commit payloads use an ephemeral P-256 session key and authenticated AES-GCM encryption, so another loopback process cannot read or alter cookie values.
- The extension has no browsing, navigation, page-inspection, tab-management, or debugging APIs.
- Messages are protocol-versioned, schema-restricted by the desktop app, capped at 750 cookies and 4 MiB, and accepted only after the loopback WebSocket is authenticated.

## Local installation

1. Open `chrome://extensions` in Chrome 120 or newer, Brave, Edge, Arc, or another current Chromium browser.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `chrome-extension` directory.
4. In Y Space, start browser-cookie pairing.
5. Open the extension, optionally name this browser profile, enter the eight-digit code shown by Y Space, and approve only the requested site origins.

The desktop app and extension scan the same loopback port ranges, so no manual port configuration is required.
