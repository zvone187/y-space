# Y Space desktop QA fixture

This local fixture provides three distinct browser-tab workflows and an importable authenticated
cookie session without using a real account.

Run it with the same Node 24 toolchain used by the desktop build:

```sh
YSPACE_QA_COOKIE_SENTINEL='<unique test-only value>' node 'implementation assets/qa-fixture/server.mjs'
```

The server prints only its loopback URL. It never prints or renders the sentinel. In the source
browser, open `/source-login`; in Y Space, open `/account` before and after importing cookies for the
exact fixture origin. The `/alpha`, `/beta`, and `/gamma` routes exercise independent tab state,
forms, dynamic titles, and network inspection. The localhost cookie set covers persistent, session,
HttpOnly, Secure, host-prefix, secure-prefix, path-scoped, expired, and partitioned cases; Y Space
must reject the unsupported partitioned cookie without exposing its value.

Use `/cookie-status` for the root-path view and `/account/cookie-status` for the path-scoped view.
Both pages show only presence/absence plus the expected cookie flags; they never render values. The
same value-free data is available from `/api/cookie-status` and `/account/api/cookie-status` for
test capture. Before import, capture the source-browser status. After import, confirm the persistent,
session, prefix, and path-scoped rows are present in Y Space while partitioned and expired remain
absent. After quitting and relaunching Y Space, confirm persistent rows remain and `ys_session` is
absent.

Open `/cursor-a` and `/cursor-b` for two immutable, visibly labeled browser peers during Codex and
OpenCode isolation tests. `/cursor` remains the Cursor A default, while `/cursor?fixture=B` provides
the query-selected Cursor B variant. A query cannot override the identity of `/cursor-a` or
`/cursor-b`.

Each light, self-contained page has widely separated hover, focus, fill/type, targeted-key,
check/uncheck, select, click, double-click, and nested-wheel targets. Adversarial cases move or remove
themselves only after trusted pointer entry, cover a target with a real hit-testable occluder, expose
a disabled control, and name one selector that never exists. The sticky ledger keeps a bounded
48-event sequence with event type, fixed target ID, `isTrusted` provenance, pointer coordinates,
safe input categories, wheel/scroll geometry, and a generic result. It never reads or renders text,
checkbox, or selected-option values, cookies, storage, or secrets, and it makes no network requests.

Run the fixture contract tests with:

```sh
node --test 'implementation assets/qa-fixture/server.test.mjs'
```

To verify the exact Electron runtime independently of Y Space UI, run:

```sh
node_modules/.bin/electron 'implementation assets/qa-fixture/electron-loopback-cookie-probe.cjs'
```

The probe uses a disposable Electron profile and prints booleans plus the Electron version only. It
never prints the cookie value; success requires setting, reading, and sending the Secure+HttpOnly
cookie on the original HTTP localhost URL.
