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
forms, dynamic titles, and network inspection.
