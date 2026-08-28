# Y Space Cookie Import extension release

The Chrome Web Store extension has one purpose: import cookies from a Chromium
browser profile into the Y Space embedded browser after the user explicitly
pairs the extension and approves access to the requested site origins.

The extension is **import-only**. It must not navigate, inspect, debug, or manage
the external browser or its tabs. Agents control only Y Space's embedded browser
through the app's built-in browser tools.

## Release sources of truth

- `chrome-extension/manifest.json` defines the store name, permissions, and
  version.
- `chrome-extension/CHANGELOG.md` contains extension-specific release notes.
- `chrome-extension/importOnly.test.js` enforces the import-only permission and
  messaging boundary.
- `.github/workflows/release-chrome-extension.yml` handles versioning, tagging,
  packaging, GitHub Releases, and Chrome Web Store submission.

The workflow publishes the artifact as `y-space-cookie-import-vX.Y.Z`. The
Chrome Web Store listing and extension UI use **Y Space Cookie Import** too.

## Security and privacy release gate

Before every release, confirm all of these invariants:

- Required permissions are limited to `cookies`, `storage`, and `alarms`.
- HTTP(S) origin access remains optional and is requested only from a user click
  for the exact origins in the pending import.
- Only origin permissions newly granted for a request are removed after commit,
  cancellation, timeout, disconnect, or worker restart. Pre-existing grants are
  preserved, and failed cleanup remains durably queued.
- Pairing uses the eight-digit, five-minute code as proof-key input. The code and
  long-lived token never cross loopback in plaintext, the server proves itself,
  and Y Space stores only the token's SHA-256 hash.
- Preview data contains domain and count metadata only. Cookie values are read
  and sent in an authenticated AES-GCM envelope only after the user confirms a
  preview-bound import.
- The extension declares no `tabs`, `tabGroups`, `debugger`, browsing,
  navigation, page-inspection, or scripting capability.
- Protocol messages remain versioned and schema-restricted, with the cookie and
  payload limits enforced over loopback only.
- Chrome 120 remains the minimum so the 30-second MV3 alarm fallback and
  20-second WebSocket heartbeat are supported.

Run the automated boundary test:

```bash
node --test chrome-extension/importOnly.test.js
```

Then load the extension unpacked and complete this manual flow:

1. Open `chrome://extensions`, enable **Developer mode**, choose **Load
   unpacked**, and select `chrome-extension/`.
2. Confirm the card and popup are named **Y Space Cookie Import** and contain no
   browser-control or tab-management controls.
3. In Y Space, start cookie import and enter its eight-digit code in the
   extension. Reject an incorrect or expired code once, then pair with a fresh
   code.
4. Request cookies for a test site. Confirm Chrome asks only for that site's
   exact HTTP(S) origin and that denying the prompt imports nothing.
5. Retry, grant the origin, review the cookie-domain/count preview in Y Space,
   and confirm the import. Verify the cookie is available in the Y Space
   embedded browser.
6. Confirm the temporary site permission is removed after commit. Repeat with a
   cancelled import and confirm removal again.
7. Use **Forget pairing**, reopen the popup, and confirm a new pairing code is
   required.

Do not release if the extension can list tabs, open a page, inspect page
contents, attach DevTools, or otherwise control the external browser.

## First Chrome Web Store submission

The first submission is manual because a Chrome Web Store item must exist
before automation has an extension ID to update.

1. Set the release version in `chrome-extension/manifest.json` and add a matching
   `## X.Y.Z - YYYY-MM-DD` entry to `chrome-extension/CHANGELOG.md`.
2. Run **Actions → Release Chrome Extension** with `dry_run` enabled.
3. Download the `y-space-cookie-import-vX.Y.Z` artifact and
   rerun the automated and manual gates against its unpacked contents.
4. Upload the ZIP in the Chrome Web Store Developer Dashboard.
5. Complete the listing, privacy, distribution, and test-instructions tabs using
   the import-only behavior described above.
6. Submit the item for review.
7. Add the resulting Chrome Web Store item ID to the `chrome-extension` GitHub
   environment.

Recommended listing copy:

- **Name:** Y Space Cookie Import
- **Summary:** Import cookies from this browser into the Y Space embedded
  browser after an explicit exact-origin permission grant.
- **Single purpose:** Transfer user-approved cookies into Y Space so its
  embedded browser can use an existing signed-in session.

Permission justifications:

| Permission               | Justification                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `cookies`                | Reads cookies only for origins the user approves for an active import.                                   |
| `storage`                | Stores the local pairing identity and token.                                                             |
| `alarms`                 | Keeps the Manifest V3 worker available for the local import handshake.                                   |
| Optional HTTP(S) origins | Requested per import for the exact sites selected in Y Space, then removed after commit or cancellation. |

## Automated updates

After the first item exists, configure the `chrome-extension` GitHub environment
with these secrets:

| Secret                          | Meaning                                                   |
| ------------------------------- | --------------------------------------------------------- |
| `CHROME_WEBSTORE_CLIENT_ID`     | OAuth client ID with Chrome Web Store API access.         |
| `CHROME_WEBSTORE_CLIENT_SECRET` | OAuth client secret.                                      |
| `CHROME_WEBSTORE_REFRESH_TOKEN` | Refresh token for the owning Web Store developer account. |
| `CHROME_WEBSTORE_PUBLISHER_ID`  | Publisher ID from the Developer Dashboard.                |
| `CHROME_EXTENSION_ID`           | Existing Chrome Web Store item ID.                        |

Run **Actions → Release Chrome Extension**. The workflow validates the
manifest and changelog, optionally bumps the manifest version, creates and
pushes `chrome-extension-vX.Y.Z`, packages the tagged extension, creates a
GitHub Release, uploads the same ZIP through the Chrome Web Store API, and
submits it for review.

## Release checklist

1. Review the diff for any new permission, API, message type, or host access.
2. Bump `chrome-extension/manifest.json` and update
   `chrome-extension/CHANGELOG.md`.
3. Run the import-only automated test and the complete manual flow above.
4. Run the workflow with `dry_run` enabled and test the packaged artifact.
5. Run the workflow without `dry_run` to tag, create the GitHub Release, and
   submit to the Chrome Web Store.
6. Check the Web Store review status and verify the published listing describes
   cookie import only.
