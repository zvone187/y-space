# Y Space tab creation, split workspace, and cookie import — pass criteria

## Product behavior

- The one global tab strip has a clearly visible **Add tab** button beside the tabs.
- **Add tab** opens a compact menu that can create a new independent Browser page and open every eligible singleton workspace surface (Files, Git, Terminal, Usage, Notes, and other visible tools).
- Repeated **New browser tab** actions create separate Browser page IDs in the same global tab strip. They never create a nested browser-tab row.
- Choosing a singleton surface focuses its existing tab instead of duplicating it.
- Cookie import is available from the Add tab menu and from the Browser toolbar, and both routes deep-link to the exact Browser settings section.
- On its first eligible run, after onboarding is complete, Y Space asks whether to import cookies. **Not now** dismisses the prompt permanently for that profile; **Choose browsers** opens the importer.

## Layout and background operation

- A first-time desktop layout gives the right workspace half of the usable app width, bounded between 320 and 1,100 pixels.
- The divider can resize the right workspace through half of a normal desktop window and the chosen size persists.
- Narrow windows retain the existing safe overlay behavior instead of crushing chat or workspace content.
- A clearly visible **Hide workspace** button sits at the top right of the workspace header.
- Hiding the workspace removes it completely from view without closing its global tabs or embedded Browser guests.
- An agent may focus and operate an exact Browser page while the workspace remains explicitly hidden. The operation must not reopen the workspace, must keep exact-tab security checks, and must not expose or interact with a sibling tab.
- Restoring the workspace shows the same live tabs and page state.

## Cookie privacy and safety

- Installed Chrome, Brave, Edge, Chromium, Arc, and Firefox profiles can be discovered on macOS when present.
- Renderer-visible profile metadata contains only an opaque source ID, display label, and browser family—never a filesystem path, keychain name, password, or cookie value.
- Direct import reads only cookies relevant to the user's explicitly approved HTTP(S) origins (maximum 12), returns only domain/count preview metadata, and copies nothing before final confirmation.
- Chromium cookie decryption occurs only in the main process using the fixed browser-specific Safe Storage keychain service. Firefox cookies are read from a temporary copy of its SQLite database.
- Temporary database copies and short-lived preview secrets are deleted or cleared on failure, cancellation, expiry, and commit.
- Existing extension/file import remains available as a compatibility fallback until the user separately authorizes its removal.

## Verification gates

- New tests fail before implementation for every requested behavior.
- Focused component, store, IPC, Browser automation, and local-profile tests pass after implementation.
- Typecheck, lint, formatting, i18n extraction/validation, production build, and the full automated suite pass. Any pre-existing load-sensitive failure must be isolated and documented rather than hidden.
- The unsigned ARM64 app is tested hands-on with one process launched using the literal `--use-mock-keychain` argument and left running for the user.
- Manual QA verifies the Add tab menu, independent Browser tabs, singleton focus, 50/50 initial split, drag resizing, visible hide/restore behavior, first-run prompt, and manual import entry points.
- Automated synthetic profile fixtures verify cookie discovery/decryption/filtering; hands-on QA must not import or expose the user's personal cookie values without an explicit user action.
