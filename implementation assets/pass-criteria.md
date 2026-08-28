# Y Space implementation pass criteria

The implementation is complete only when every criterion below is satisfied. A criterion may not be waived by a green unit test if the corresponding desktop workflow has not also been click-tested.

## Product identity and compatibility

- PC-01: Every user-visible product name, window title, primary heading, first-run surface, settings label, built-in skill description, and owned plugin description says **Y Space**. Legacy domains and support addresses may remain only where they are compatibility-sensitive service endpoints, never as the displayed product name.
- PC-02: Compatibility-sensitive internal identifiers remain stable, including existing data directories, database names, migrations, protocols, environment names, MCP IDs, and the `persist:lightcode-browser` Electron partition.
- PC-03: Existing local threads, projects, settings, browser cookies, and MCP configuration open without data loss after migration.
- PC-04: The desktop layout is visually close to the current Codex desktop experience while preserving project-specific workflows and accessibility.

## Embedded browser and agent access

- PC-05: The right-side embedded browser supports creating, automatically naming from page titles, selecting, reordering, refreshing, navigating, and closing multiple tabs without one tab replacing another.
- PC-06: Every supported Codex, Claude Code, and OpenCode launch receives the embedded Browser MCP and app-controls capability by default; a global Browser hard-disable still removes Browser everywhere.
- PC-07: No agent launch, composer, settings page, plugin listing, built-in MCP catalog, or skill exposes external Chrome/browser control. A user-created custom MCP named `chrome` remains valid.
- PC-08: Every agent can list all embedded tabs, find a tab by title or URL, activate it, open-or-focus it, navigate it, interact with it, inspect it, capture evidence, and close it.
- PC-09: Browser tab ownership and current-task identity are exact for Codex, Claude Code, OpenCode terminal, and concurrent OpenCode GUI tasks in the same project. Unknown, forged, or stale provider sessions fail closed.
- PC-10: Existing Browser safety defaults remain enforced: evaluation and raw data access are disabled unless the user explicitly enables them.
- PC-11: Y Space Browser and app-control core skills are available to all three providers without a separate installation and do not overwrite a colliding user-owned skill.

## Cookie import

- PC-12: The companion extension is named **Y Space Cookie Import** and has no debugger, tabs, tabGroups, navigation, DOM, screenshot, CDP, or agent-control permission/API.
- PC-13: Pairing uses an expiring code, rate limits attempts, stores only a token hash in Y Space, supports multiple browser profiles, and lets the user revoke a source immediately.
- PC-14: Imports require an explicit list of HTTP(S) target origins, extension-side permission confirmation, a metadata-only preview, and a second Y Space confirmation before values cross into the main process.
- PC-15: Raw cookie values never enter renderer IPC, application events, logs, telemetry, SQLite, settings, clipboard, crash context, or temporary files.
- PC-16: Cookie mapping correctly handles host-only/domain scope, Secure, HttpOnly, SameSite, paths, session/persistent expiry, prefixes, deduplication, malformed/out-of-scope/expired cookies, and unsupported partitioned cookies.
- PC-17: Imports merge into `persist:lightcode-browser`, flush the cookie store, report partial failures without retaining secrets, persist supported persistent cookies across restart, and do not persist session cookies across restart.
- PC-18: Old extension messages for listing, attaching, navigating, or driving external tabs are rejected and close the connection.

## Pipedream

- PC-19: Connections clearly separates Personal Pipedream MCP from BYO Pipedream Connect and never displays credentials, tokens, the external user ID, raw account credentials, or unsanitized upstream errors.
- PC-20: Environment bootstrap is all-or-nothing; complete environment credentials win, partial credentials produce a safe error, and all four variables are removed before any agent child can inherit them.
- PC-21: Personal MCP completes OAuth, appears as managed server `pd`, works in Codex, Claude Code, and OpenCode, and signing out removes only Y Space's OAuth authorization.
- PC-22: BYO Connect can probe the configured project, search apps, connect an account, enable agent access, expose a stable app-specific managed MCP, disable access, and disconnect with confirmation.
- PC-23: BYO agents receive only a loopback relay URL and memory-only local bearer. Pipedream client secrets, developer tokens, project IDs, external user IDs, account IDs, and upstream headers never reach provider configuration.
- PC-24: The relay pins the trusted project/environment/user/app/account, strips spoofed headers, isolates MCP sessions by binding, streams supported MCP methods, and never automatically retries a consequential `tools/call` after a 401.
- PC-25: Disabling or disconnecting an account immediately removes access and makes the old relay route unusable; restart reconciles persisted metadata with Pipedream's real account state.

## Providers, tests, and desktop verification

- PC-26: Codex works in terminal and GUI modes with at least one live model, can resume/switch models, and controls only the embedded browser.
- PC-27: Claude Code works in terminal and GUI modes after interactive login, receives launch-scoped MCP configuration, and controls only the embedded browser.
- PC-28: OpenCode works in terminal and GUI modes with both `opencode/gpt-5.6-luna` and `zai/glm-4.5-flash`; two concurrent same-directory GUI tasks remain isolated.
- PC-29: The full Node 24 unit/integration suite, typecheck, lint, build/package checks, and extension tests pass with no new skipped test covering an implemented requirement.
- PC-30: Every test in `implementation assets/qa-e2e-tests.json` is manually click-executed in the packaged macOS desktop app, has captured proof, and is marked passed.
- PC-31: A known sentinel placed in cookie and Pipedream test secrets is absent from logs, renderer DevTools, provider configs, persisted files, telemetry payloads, and crash data.
- PC-32: The app survives quit/relaunch with threads, tabs, persistent cookies, pairings, enabled integrations, and provider settings intact, and no obsolete external-browser service starts.

## Global right-workspace tabs

- PC-33: The right workspace has one visible, ordered, keyboard-accessible outer tab strip containing every available right-side tool—Files, Git, Usage, Notes, Browser, Terminal when applicable, plan/subagent surfaces when present—and every open document.
- PC-34: Opening an already-open singleton tool focuses its existing outer tab without duplicating or remounting it; switching Browser → document → Git/Notes/Usage → Browser preserves the exact embedded Browser pages, Notes draft, Git state, and Usage lifecycle.
- PC-35: Ordinary file opens from the project tree, chat/file links, Git surfaces, and the file-open command create or focus a document tab in the right workspace instead of launching a modal or external app. Reopening the same file focuses it, preview replacement and pin/edit semantics remain deterministic, and dirty close can be cancelled.
- PC-36: PDF, CSV, TSV, XLS, and XLSX files render entirely inside Y Space document tabs. PDF Blob URLs are revoked, spreadsheets are parsed locally without macro/formula execution or network viewers, and malformed, encrypted, remote-unavailable, or oversized inputs show bounded safe errors.
- PC-37: Mixed tool/document tabs can be selected, reordered, and closed with mouse and keyboard; exactly one tab is selected and tabbable, Home/End/arrow navigation works, overflow remains reachable, and closing the active tab focuses the deterministic adjacent tab.
- PC-38: Hidden/inactive workspace surfaces cannot intercept close/save/find/reload shortcuts, one surface cannot be duplicated between the outer strip/split/bottom dock, and closing the final visible outer tab hides the workspace without destroying independent Browser persistence.
- PC-39: The packaged macOS build is click-tested by opening Files, Git, Notes, Usage, Browser, two source files, a PDF, an XLS, and an XLSX; captured proof shows mixed-tab switching, reorder, close, dirty protection, in-app rendering, and Browser agent control after returning to Browser.
- PC-40: Chrome/Brave extension installation is excluded from the current manual QA by explicit user direction. Related cases remain visibly deferred rather than being reported as passed; their automated security/contract coverage must still pass.
